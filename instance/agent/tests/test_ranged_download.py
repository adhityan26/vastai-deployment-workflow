"""Parallel ranged downloads (DOWNLOAD_CONNECTIONS) against a real local HTTP server."""
import hashlib
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import pytest

from vastcomfy_agent.profile import Downloader, DownloadError, ModelSpec
from vastcomfy_agent.ranged import plan

SIZE = 1_000_003  # not a multiple of anything the segments use
DATA = hashlib.sha256(b"seed").digest() * (SIZE // 32 + 1)
DATA = DATA[:SIZE]
MIN_SEGMENT = 100_000
TOKEN = "hf_secret_token_value"
RANGE = re.compile(r"bytes=(\d+)-(\d+)$")


class FakeHub:
    """A file server with knobs: ranges on/off, redirects to a second origin, failures per range start."""

    def __init__(self):
        self.ranges = True
        self.accept_ranges_header = "bytes"
        self.head_length = SIZE
        self.redirect_to = None  # base URL of another FakeHub (a CDN)
        self.fail_once = set()  # range starts answered with a 500 the first time
        self.short_once = set()  # range starts that stop halfway (connection closed) the first time
        self.overlong = False
        self.overlong_once = set()  # range starts answered once with 5 bytes more than asked
        self.truncate_end = {}  # range end -> how many more answers for it stop halfway
        self.wrong_content_range = False
        self.requests = []  # (method, path, range, authorization, accept-encoding)
        self.lock = threading.Lock()
        self.active = 0
        self.max_active = 0
        self.wait_for = 0  # a ranged GET waits (up to 5 s) until this many requests are in flight at once
        self.cond = threading.Condition(self.lock)
        hub = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def _record(self):
                with hub.lock:
                    hub.requests.append((self.command, self.path, self.headers.get("Range"),
                                         self.headers.get("Authorization"), self.headers.get("Accept-Encoding")))

            def _redirect(self):
                self.send_response(302)
                self.send_header("Location", hub.redirect_to + self.path + "?signed=1")
                self.send_header("Content-Length", "0")
                self.end_headers()

            def do_HEAD(self):
                self._record()
                if hub.redirect_to:
                    return self._redirect()
                self.send_response(200)
                if hub.accept_ranges_header:
                    self.send_header("Accept-Ranges", hub.accept_ranges_header)
                self.send_header("Content-Length", str(hub.head_length))
                self.end_headers()

            def do_GET(self):
                self._record()
                if hub.redirect_to:
                    return self._redirect()
                with hub.cond:
                    hub.active += 1
                    hub.max_active = max(hub.max_active, hub.active)
                    hub.cond.notify_all()
                    if self.headers.get("Range"):
                        hub.cond.wait_for(lambda: hub.max_active >= hub.wait_for, timeout=5)
                try:
                    self._get()
                finally:
                    with hub.lock:
                        hub.active -= 1

            def _get(self):
                match = RANGE.match(self.headers.get("Range") or "")
                if not hub.ranges or match is None:
                    self.send_response(200)
                    self.send_header("Content-Length", str(SIZE))
                    self.end_headers()
                    self.wfile.write(DATA)
                    return
                start, end = int(match[1]), int(match[2])
                with hub.lock:
                    fail = start in hub.fail_once
                    hub.fail_once.discard(start)
                    short = start in hub.short_once
                    hub.short_once.discard(start)
                    if hub.truncate_end.get(end, 0) > 0:
                        hub.truncate_end[end] -= 1
                        short = True
                    extra = hub.overlong or start in hub.overlong_once
                    hub.overlong_once.discard(start)
                if fail:
                    self.send_response(500)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                body = DATA[start:end + 1] + (b"extra" if extra else b"")
                self.send_response(206)
                first = start + 1 if hub.wrong_content_range else start
                self.send_header("Content-Range", f"bytes {first}-{end}/{SIZE}")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if short:
                    self.wfile.write(body[: min(len(body) // 2, 4096)])
                    self.wfile.flush()
                    self.close_connection = True
                    return
                self.wfile.write(body)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)  # config-lint: ok (test server)
        self.server.daemon_threads = True
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"  # config-lint: ok (test server)
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()

    def gets(self):
        return [r for r in self.requests if r[0] == "GET"]

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def hub():
    h = FakeHub()
    yield h
    h.close()


@pytest.fixture
def cdn():
    h = FakeHub()
    yield h
    h.close()


CLIENTS = []


@pytest.fixture(autouse=True)
def close_clients():
    yield
    while CLIENTS:
        CLIENTS.pop().close()


def model():
    return ModelSpec(file="sub/m.bin", repo="org/m", revision="r1", dest="models/x/", size_bytes=SIZE)


def downloader(hub, *, connections=4, retries=3, token="", progress=None, sleeps=None, chunk=4096):
    client = httpx.Client(timeout=10)
    CLIENTS.append(client)
    return Downloader(
        hf_base=hub.base, token=token, client=client, retries=retries, backoff_s=1, chunk_bytes=chunk,
        sleep=(sleeps if sleeps is not None else []).append, on_progress=progress or (lambda *a: None),
        connections=connections, min_segment_bytes=MIN_SEGMENT,
    )


def ranged_gets(hub):
    return [r for r in hub.gets() if r[2] is not None]


def test_plan_splits_into_contiguous_segments_covering_the_file():
    for size, conns, minimum in [(SIZE, 4, MIN_SEGMENT), (SIZE, 16, MIN_SEGMENT), (10, 4, 100), (250, 4, 100)]:
        segs = plan(size, conns, minimum)
        assert segs[0].start == 0 and segs[-1].end == size - 1
        assert all(a.end + 1 == b.start for a, b in zip(segs, segs[1:]))
        assert len(segs) == max(1, min(conns, size // minimum))


def test_four_connections_download_the_exact_bytes_in_parallel(tmp_path, hub):
    hub.wait_for = 4  # each range is held until all four are in flight: they truly run at once
    path = downloader(hub).fetch(model(), tmp_path)
    assert path.read_bytes() == DATA
    ranges = sorted(r[2] for r in ranged_gets(hub))
    assert ranges == ["bytes=0-249999", "bytes=250000-499999", "bytes=500000-749999", "bytes=750000-1000002"]
    assert all(r[4] == "identity" for r in ranged_gets(hub))
    assert hub.max_active == 4
    assert not list(path.parent.glob("*.part"))


def test_progress_grows_to_the_size_across_segments(tmp_path, hub):
    seen = []
    downloader(hub, progress=lambda f, d, t: seen.append((f, d, t))).fetch(model(), tmp_path)
    assert {f for f, _, _ in seen} == {"m.bin"} and {t for _, _, t in seen} == {SIZE}
    done = [d for _, d, _ in seen]
    assert done == sorted(done) and done[-1] == SIZE


def test_one_connection_is_the_old_single_stream(tmp_path, hub):
    downloader(hub, connections=1).fetch(model(), tmp_path)
    assert [r[0] for r in hub.requests] == ["GET"] and hub.requests[0][2] is None


def test_a_small_file_uses_one_stream(tmp_path, hub):
    small = ModelSpec(file="s.bin", repo="org/m", revision="r1", dest="models/x/", size_bytes=SIZE)
    d = downloader(hub)
    d._min_segment = SIZE  # the file is smaller than two segments
    d.fetch(small, tmp_path)
    assert [r[0] for r in hub.requests] == ["GET"]


@pytest.mark.parametrize("change", [{"accept_ranges_header": None}, {"accept_ranges_header": "none"},
                                    {"head_length": SIZE + 1}])
def test_without_proper_range_support_one_stream_is_used(tmp_path, hub, change):
    for key, value in change.items():
        setattr(hub, key, value)
    path = downloader(hub).fetch(model(), tmp_path)
    assert path.read_bytes() == DATA
    assert [r[0] for r in hub.requests] == ["HEAD", "GET"] and hub.requests[1][2] is None


def test_a_server_that_ignores_range_falls_back_to_one_stream_in_the_same_attempt(tmp_path, hub):
    hub.ranges = False
    sleeps = []
    path = downloader(hub, sleeps=sleeps).fetch(model(), tmp_path)
    assert path.read_bytes() == DATA and sleeps == []
    assert hub.gets()[-1][2] is None


def test_redirects_are_followed_per_request_and_the_token_never_reaches_the_cdn(tmp_path, hub, cdn):
    hub.redirect_to = cdn.base
    path = downloader(hub, token=TOKEN).fetch(model(), tmp_path)
    assert path.read_bytes() == DATA
    # Every request (HEAD and each range) asked the resolve URL again and was signed anew.
    assert len(hub.requests) == 5 and all(r[3] == f"Bearer {TOKEN}" for r in hub.requests)
    assert all("signed=1" in r[1] for r in cdn.requests) and all(r[3] is None for r in cdn.requests)
    assert len(ranged_gets(cdn)) == 4


def test_a_failing_segment_is_retried_with_backoff_and_the_others_keep_theirs(tmp_path, hub):
    hub.fail_once = {250000}
    sleeps = []
    path = downloader(hub, sleeps=sleeps).fetch(model(), tmp_path)
    assert path.read_bytes() == DATA and sleeps == [1]
    starts = [int(RANGE.match(r[2])[1]) for r in ranged_gets(hub)]
    assert sorted(starts) == [0, 250000, 250000, 500000, 750000]


def test_a_short_read_resumes_the_segment_where_it_stopped(tmp_path, hub):
    hub.short_once = {500000}
    path = downloader(hub).fetch(model(), tmp_path)
    assert path.read_bytes() == DATA
    starts = sorted(int(RANGE.match(r[2])[1]) for r in ranged_gets(hub))
    third = [s for s in starts if 500000 <= s < 750000]
    assert len(third) == 2 and third[0] == 500000 and third[1] > 500000  # resumed after the bytes that arrived


@pytest.mark.parametrize("knob", ["overlong", "wrong_content_range"])
def test_a_bad_range_answer_never_becomes_a_model_file(tmp_path, hub, knob):
    setattr(hub, knob, True)
    with pytest.raises(DownloadError, match="m.bin"):
        downloader(hub, retries=2).fetch(model(), tmp_path)
    assert list((tmp_path / "models/x").iterdir()) == []


def test_a_segment_that_keeps_failing_fails_the_file_and_leaves_no_part(tmp_path, hub):
    class Always(set):
        def __contains__(self, item):
            return item == 0

        def discard(self, item):
            pass

    hub.fail_once = Always()
    with pytest.raises(DownloadError):
        downloader(hub, retries=2).fetch(model(), tmp_path)
    assert list((tmp_path / "models/x").iterdir()) == []


def test_a_progress_error_mid_download_cleans_up(tmp_path, hub):
    calls = []

    def progress(f, d, t):
        calls.append(d)
        if len(calls) == 3:
            raise OSError(28, "No space left on device")

    with pytest.raises(DownloadError):
        downloader(hub, retries=1, progress=progress).fetch(model(), tmp_path)
    assert list((tmp_path / "models/x").iterdir()) == []


def test_the_token_is_never_part_of_an_error(tmp_path, hub):
    hub.wrong_content_range = True
    with pytest.raises(DownloadError) as info:
        downloader(hub, retries=1, token=TOKEN).fetch(model(), tmp_path)
    assert TOKEN not in str(info.value)


def test_an_overlong_answer_is_refused_and_retried_so_no_byte_of_the_next_segment_is_overwritten(tmp_path, hub):
    hub.overlong_once = {0}
    sleeps = []
    path = downloader(hub, sleeps=sleeps).fetch(model(), tmp_path)
    assert path.read_bytes() == DATA and sleeps == [1]
    # The chunks before the excess were kept; the segment resumed after them.
    assert [r[2] for r in ranged_gets(hub) if r[2].endswith("-249999")][1:] == ["bytes=249856-249999"]


def test_a_segment_that_makes_progress_on_every_try_is_not_failed_by_the_retry_count(tmp_path, hub):
    hub.truncate_end = {249999: 3}  # three short reads in a row, each with data; retries is 3
    sleeps = []
    path = downloader(hub, retries=3, sleeps=sleeps).fetch(model(), tmp_path)
    assert path.read_bytes() == DATA and len(sleeps) == 3
    ends = [r[2].split("-")[1] for r in ranged_gets(hub)]
    # The segment resumed four times; nothing was started over (no whole-file retry).
    assert ends.count("249999") == 4 and all(ends.count(e) == 1 for e in ("499999", "749999", "1000002"))


def test_a_server_that_always_truncates_ends_in_a_bounded_failure_with_backoff(tmp_path, hub):
    hub.truncate_end = {249999: 10**9}
    sleeps, outcome = [], {}

    def run():
        try:
            downloader(hub, retries=2, sleeps=sleeps).fetch(model(), tmp_path)
            outcome["result"] = "ok"
        except DownloadError as exc:
            outcome["result"] = exc

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    worker.join(60)
    assert not worker.is_alive(), "the download never gave up"
    assert isinstance(outcome["result"], DownloadError)
    tries = [r for r in ranged_gets(hub) if r[2].endswith("-249999")]
    assert 2 < len(tries) <= 2 * 2 * 8  # outer retries x the per-segment attempt cap
    assert sleeps and set(sleeps) == {1}
    assert list((tmp_path / "models/x").iterdir()) == []
