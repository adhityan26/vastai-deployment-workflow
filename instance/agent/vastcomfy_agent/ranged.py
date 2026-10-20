"""Parallel ranged download of one model file (DOWNLOAD_CONNECTIONS connections).

One stream from Hugging Face was measured at about 2.8 MB/s on a machine whose link was far faster
(2026-10-19); several ranged connections to the same file usually add up. The file is split into
contiguous segments, each fetched by its own thread with `Range: bytes=a-b` and written at its offset
into the preallocated .part file with os.pwrite. Guarantees (the caller keeps the rest: the pinned size
check, .part then atomic rename, the disk space check before):
- a segment is complete only when exactly its length arrived in 206 answers whose Content-Range names
  that range of a file of the pinned size; a short read resumes the segment from where it stopped, an
  over-long one is an error, so no hole of the preallocated file can pass for data;
- each request goes to the original (resolve) URL and follows its redirects again, so a signed CDN URL
  that expired between retries is simply signed anew; httpx drops the Authorization header when a
  redirect leaves the origin, as for the single stream;
- a server that answers a ranged request with 200 (it ignores Range) raises RangeUnsupported and the
  caller falls back to one plain stream; nothing is guessed from a 200 body;
- memory per connection is one chunk (chunk_bytes); progress (bytes done across segments) is reported
  under a lock, so it only grows within one attempt.
"""
from __future__ import annotations

import os
import re
import threading
from concurrent.futures import FIRST_EXCEPTION, ThreadPoolExecutor, wait
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import httpx

CONTENT_RANGE = re.compile(r"bytes (\d+)-(\d+)/(\d+)")
# Ranged answers must be the file's own bytes: a compressed body would not match the range length.
IDENTITY = {"Accept-Encoding": "identity"}


# All tries of one segment are capped at DOWNLOAD_RETRIES times this (tries that made progress included).
MAX_ATTEMPTS_PER_RETRY = 8


class RangeUnsupported(Exception):
    """The server does not serve byte ranges of this file (the caller downloads it in one stream)."""


class SegmentError(Exception):
    pass


@dataclass
class Segment:
    start: int
    end: int  # inclusive
    done: int = 0

    @property
    def length(self) -> int:
        return self.end - self.start + 1


def plan(size: int, connections: int, min_segment: int) -> list[Segment]:
    """At most `connections` contiguous segments of at least `min_segment` bytes (the last takes the rest)."""
    count = max(1, min(connections, size // max(1, min_segment)))
    step = size // count
    segments = [Segment(i * step, (i + 1) * step - 1) for i in range(count)]
    segments[-1].end = size - 1
    return segments


def ranges_supported(client: httpx.Client, url: str, headers: dict, size: int) -> bool:
    """HEAD (redirects followed): 200 with `Accept-Ranges: bytes` and the pinned Content-Length."""
    response = client.head(url, headers={**headers, **IDENTITY}, follow_redirects=True)
    if response.status_code != 200:
        return False
    accepts = "bytes" in [v.strip().lower() for v in response.headers.get("accept-ranges", "").split(",")]
    return accepts and response.headers.get("content-length") == str(size)


def _pwrite_all(fd: int, data: bytes, offset: int) -> None:
    view = memoryview(data)
    while view:
        written = os.pwrite(fd, view, offset)
        view = view[written:]
        offset += written


class RangedDownload:
    def __init__(
        self,
        *,
        client: httpx.Client,
        url: str,
        headers: dict,
        size: int,
        connections: int,
        min_segment: int,
        retries: int,
        backoff_s: int,
        chunk_bytes: int,
        sleep: Callable[[float], None],
        on_bytes: Callable[[int], None],
    ):
        self._client, self._url, self._headers, self._size = client, url, headers, size
        self._segments = plan(size, connections, min_segment)
        self._retries, self._backoff, self._chunk, self._sleep = retries, backoff_s, chunk_bytes, sleep
        self._on_bytes = on_bytes
        self._abort = threading.Event()
        self._lock = threading.Lock()

    @property
    def segments(self) -> list[Segment]:
        return self._segments

    def run(self, part: Path) -> None:
        """Fill `part` (created, preallocated to the size). Raises RangeUnsupported, SegmentError or OSError."""
        fd = os.open(part, os.O_RDWR | os.O_CREAT | os.O_TRUNC, 0o644)
        try:
            os.ftruncate(fd, self._size)
            with ThreadPoolExecutor(max_workers=len(self._segments), thread_name_prefix="segment") as pool:
                futures = [pool.submit(self._fetch, fd, seg) for seg in self._segments]
                done, _pending = wait(futures, return_when=FIRST_EXCEPTION)
                if any(f.exception() is not None for f in done):
                    self._abort.set()
                wait(futures)
            errors = [f.exception() for f in futures if f.exception() is not None]
            unsupported = [e for e in errors if isinstance(e, RangeUnsupported)]
            if unsupported:
                raise unsupported[0]
            if errors:
                raise errors[0]
            if any(seg.done != seg.length for seg in self._segments):
                raise SegmentError("a segment is incomplete")
            os.fsync(fd)
        finally:
            os.close(fd)

    def _fetch(self, fd: int, seg: Segment) -> None:
        # `failures` counts tries in a row without progress (a try that brought bytes starts it over);
        # `attempts` caps all tries of the segment, so a server that always sends a little and then
        # drops the connection still ends in a bounded failure.
        failures = 0
        attempts = 0
        while not self._abort.is_set() and seg.done < seg.length:
            before = seg.done
            attempts += 1
            try:
                self._fetch_once(fd, seg)
                if seg.done < seg.length and not self._abort.is_set():
                    raise SegmentError(f"short read at byte {seg.start + seg.done}")
            except RangeUnsupported:
                raise
            except (httpx.HTTPError, SegmentError, OSError) as exc:
                failures = 1 if seg.done > before else failures + 1
                if failures >= self._retries or attempts >= self._retries * MAX_ATTEMPTS_PER_RETRY:
                    raise SegmentError(f"segment {seg.start}-{seg.end}: {exc}") from exc
                self._sleep(self._backoff)

    def _fetch_once(self, fd: int, seg: Segment) -> None:
        start = seg.start + seg.done
        headers = {**self._headers, **IDENTITY, "Range": f"bytes={start}-{seg.end}"}
        with self._client.stream("GET", self._url, headers=headers, follow_redirects=True) as response:
            if response.status_code == 200:
                raise RangeUnsupported("the server ignored the Range header")
            response.raise_for_status()
            if response.status_code != 206:
                raise SegmentError(f"unexpected HTTP {response.status_code} for a range")
            match = CONTENT_RANGE.fullmatch(response.headers.get("content-range", "").strip())
            if match is None or (int(match[1]), int(match[2]), int(match[3])) != (start, seg.end, self._size):
                raise SegmentError("Content-Range does not match the requested range")
            for chunk in response.iter_bytes(self._chunk):
                if self._abort.is_set():
                    return
                if seg.done + len(chunk) > seg.length:
                    raise SegmentError("the server sent more than the range")
                _pwrite_all(fd, chunk, seg.start + seg.done)
                seg.done += len(chunk)
                with self._lock:
                    self._on_bytes(len(chunk))
