import httpx
import pytest

from vastcomfy_agent.model_link import (
    check_model_file, required_loader,
    ActiveLink, LinkError, clear_active, parse_link, probe_size, read_active, redirect_allowed, redirect_guard,
    sha256_of, write_active,
)

HOSTS = ["huggingface.co"]
DOMAINS = ["huggingface.co", "hf.co"]
GOOD = "https://huggingface.co/org/video-model/resolve/main/split_files/diffusion_models/model_fp16.safetensors"


def test_a_resolve_link_is_parsed_into_repo_revision_and_file():
    link = parse_link(GOOD, HOSTS)
    assert (link.host, link.repo, link.revision) == ("huggingface.co", "org/video-model", "main")
    assert link.file == "split_files/diffusion_models/model_fp16.safetensors" and link.name == "model_fp16.safetensors"
    assert link.url == GOOD


def test_a_blob_link_and_download_true_become_the_resolve_link():
    link = parse_link(GOOD.replace("/resolve/", "/blob/") + "?download=true", HOSTS)
    assert link.url == GOOD


@pytest.mark.parametrize("url, code", [
    ("http://huggingface.co/o/r/resolve/main/m.safetensors", "invalid_model_link"),
    ("https://user:pw@huggingface.co/o/r/resolve/main/m.safetensors", "invalid_model_link"),
    ("https://huggingface.co@evil.com/o/r/resolve/main/m.safetensors", "invalid_model_link"),
    ("https://huggingface.co:443/o/r/resolve/main/m.safetensors", "invalid_model_link"),
    ("https://huggingface.co:8443/o/r/resolve/main/m.safetensors", "invalid_model_link"),
    ("https://127.0.0.1/o/r/resolve/main/m.safetensors", "invalid_model_link"),
    ("https://[::1]/o/r/resolve/main/m.safetensors", "invalid_model_link"),
    ("https://localhost/o/r/resolve/main/m.safetensors", "invalid_model_link"),
    ("https://huggingface.co./o/r/resolve/main/m.safetensors", "invalid_model_link"),
    ("https://HUGGINGFACE.CO/o/r/resolve/main/m.safetensors", "invalid_model_link"),
    ("https://huggingface.co.evil.com/o/r/resolve/main/m.safetensors", "model_link_host_not_allowed"),
    ("https://evilhuggingface.co/o/r/resolve/main/m.safetensors", "model_link_host_not_allowed"),
    ("https://cdn-lfs.huggingface.co/o/r/resolve/main/m.safetensors", "model_link_host_not_allowed"),
    ("https://xn--hggingface-q9a.co/o/r/resolve/main/m.safetensors", "model_link_host_not_allowed"),
    ("https://hüggingface.co/o/r/resolve/main/m.safetensors", "invalid_model_link"),
    ("https://huggingface.co/o/r/resolve/main/../../m.safetensors", "invalid_model_link"),
    ("https://huggingface.co/o/r/resolve/main/a/..%2Fm.safetensors", "invalid_model_link"),
    ("https://huggingface.co/o/r/resolve/main/%252e%252e/m.safetensors", "invalid_model_link"),
    ("https://huggingface.co/o/r/resolve/main/a//m.safetensors", "invalid_model_link"),
    ("https://huggingface.co/o/r/tree/main/m.safetensors", "invalid_model_link"),
    ("https://huggingface.co/datasets/o/r/resolve/main/m.safetensors", "invalid_model_link"),
    ("https://huggingface.co/o/r/resolve/main/m.safetensors?x=1", "invalid_model_link"),
    ("https://huggingface.co/o/r/resolve/main/m.safetensors#frag", "invalid_model_link"),
    ("https://huggingface.co/o/r/resolve/main/m.safetensors\n", "invalid_model_link"),
    ("https://huggingface.co/o/r/resolve/main/a/b/c/d/e/m.safetensors", "invalid_model_link"),
    ("https://huggingface.co/o/r/resolve/main/m.ckpt", "model_link_unsupported_type"),
    ("https://huggingface.co/o/r/resolve/main/m.pt", "model_link_unsupported_type"),
    ("https://huggingface.co/o/r/resolve/main/m.pth", "model_link_unsupported_type"),
    ("https://huggingface.co/o/r/resolve/main/m.gguf.bin", "model_link_unsupported_type"),
    ("https://huggingface.co/o/r/resolve/main/.gguf", "invalid_model_link"),
    ("https://huggingface.co/o/r/resolve/main/m.bin", "model_link_unsupported_type"),
    ("https://huggingface.co/o/r/resolve/main/m.safetensors.pt", "model_link_unsupported_type"),
    ("https://huggingface.co/o/r/resolve/main/.safetensors", "invalid_model_link"),
    ("", "invalid_model_link"),
    (None, "invalid_model_link"),
    ("https://huggingface.co/o/r/resolve/main/" + "a" * 3000 + ".safetensors", "invalid_model_link"),
])
def test_refused_links(url, code):
    with pytest.raises(LinkError) as err:
        parse_link(url, HOSTS)
    assert err.value.code == code


def test_the_host_list_is_configuration():
    assert parse_link(GOOD.replace("huggingface.co", "hf-mirror.example"), ["hf-mirror.example"]).host == "hf-mirror.example"
    with pytest.raises(LinkError):
        parse_link(GOOD, ["hf-mirror.example"])


@pytest.mark.parametrize("host, ok", [
    ("huggingface.co", True), ("cdn-lfs.huggingface.co", True), ("cas-bridge.xethub.hf.co", True),
    ("hf.co", True), ("evilhf.co", False), ("hf.co.evil.com", False), ("huggingface.co.evil.com", False),
    ("1.2.3.4", False), ("localhost", False), ("", False), ("x..hf.co", False),
])
def test_redirect_hosts(host, ok):
    assert redirect_allowed(host, HOSTS, DOMAINS) is ok


def _client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler), event_hooks={"request": [redirect_guard(HOSTS, DOMAINS)]})


def test_probe_follows_an_allowed_cdn_redirect_and_reads_the_size():
    def handler(request):
        if request.url.host == "huggingface.co":
            return httpx.Response(302, headers={"location": "https://cdn-lfs.huggingface.co/x/y"})
        return httpx.Response(200, headers={"content-length": "1234"})

    assert probe_size(_client(handler), parse_link(GOOD, HOSTS), 10_000) == 1234


@pytest.mark.parametrize("location", [
    "https://evil.com/x", "http://cdn-lfs.huggingface.co/x", "https://cdn-lfs.huggingface.co:8443/x",
    "https://169.254.169.254/latest", "https://user@cdn-lfs.huggingface.co/x", "https://huggingface.co.evil.com/x",
])
def test_a_redirect_to_a_host_that_is_not_allowed_is_refused_before_it_is_sent(location):
    sent = []

    def handler(request):
        sent.append(str(request.url))
        if request.url.host == "huggingface.co":
            return httpx.Response(302, headers={"location": location})
        return httpx.Response(200, headers={"content-length": "5"})

    with pytest.raises(LinkError) as err:
        probe_size(_client(handler), parse_link(GOOD, HOSTS), 10_000)
    assert err.value.code == "model_link_redirect_not_allowed"
    assert sent == [GOOD]


@pytest.mark.parametrize("response, code", [
    (httpx.Response(404), "model_link_unreachable"),
    (httpx.Response(200), "model_link_unreachable"),
    (httpx.Response(200, headers={"content-length": "abc"}), "model_link_unreachable"),
    (httpx.Response(200, headers={"content-length": "10001"}), "model_link_too_large"),
])
def test_probe_refusals(response, code):
    with pytest.raises(LinkError) as err:
        probe_size(_client(lambda r: response), parse_link(GOOD, HOSTS), 10_000)
    assert err.value.code == code


def test_probe_of_an_unreachable_host():
    def boom(request):
        raise httpx.ConnectError("down")

    with pytest.raises(LinkError) as err:
        probe_size(_client(boom), parse_link(GOOD, HOSTS), 10)
    assert err.value.code == "model_link_unreachable"


def test_the_active_link_is_stored_read_back_strictly_and_cleared(tmp_path):
    f = tmp_path / "m.safetensors"
    f.write_bytes(b"abc")
    sha = sha256_of(f)
    assert sha == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    active = ActiveLink(url=GOOD, repo="org/video-model", revision="main", file="m.safetensors", name="m.safetensors",
                        dest="models/diffusion_models/", size_bytes=3, sha256=sha)
    assert read_active(tmp_path) is None
    write_active(tmp_path, active)
    assert read_active(tmp_path) == active
    (tmp_path / "video_link.json").write_text('{"name": "../x"}')
    assert read_active(tmp_path) is None
    write_active(tmp_path, active)
    clear_active(tmp_path)
    clear_active(tmp_path)
    assert read_active(tmp_path) is None


def test_a_stored_link_with_an_unsafe_name_or_dest_is_ignored(tmp_path):
    import json

    good = dict(url=GOOD, repo="o/r", revision="main", file="a/m.safetensors", name="m.safetensors",
                dest="models/diffusion_models/", size_bytes=3, sha256="a" * 64)
    for bad in ({"name": "../m.safetensors"}, {"dest": "../../etc/"}, {"dest": "/abs/"}, {"file": "a/other.safetensors"},
                {"size_bytes": 0}, {"sha256": "xyz"}, {"name": "m.bin", "file": "m.bin"}):
        (tmp_path / "video_link.json").write_text(json.dumps({**good, **bad}))
        assert read_active(tmp_path) is None, bad
    (tmp_path / "video_link.json").write_text(json.dumps(good))
    assert read_active(tmp_path) is not None


def test_a_gguf_link_is_accepted_and_needs_the_gguf_loader():
    link = parse_link("https://huggingface.co/o/r/resolve/main/q/model-Q5_K_M.gguf", HOSTS)
    assert link.name == "model-Q5_K_M.gguf"
    assert required_loader(link.name) == "UnetLoaderGGUF"
    assert required_loader("m.safetensors") is None


@pytest.mark.parametrize("name, body, ok", [
    ("m.gguf", b"GGUF\x03\x00\x00\x00", True),
    ("m.gguf", b"GGUG\x03\x00\x00\x00", False),
    ("m.gguf", b"", False),
    ("m.safetensors", (2).to_bytes(8, "little") + b"{}", True),
    ("m.safetensors", (2).to_bytes(8, "little") + b"[]", False),
    ("m.safetensors", (999).to_bytes(8, "little") + b"{}", False),  # a header longer than the file
    ("m.safetensors", (0).to_bytes(8, "little") + b"{", False),
    ("m.safetensors", b"GGUF\x03\x00\x00\x00{}", False),
    ("m.safetensors", b"\x80\x02}q", False),  # a pickle stream
])
def test_the_downloaded_file_must_be_what_its_extension_says(tmp_path, name, body, ok):
    path = tmp_path / name
    path.write_bytes(body)
    if ok:
        check_model_file(path)
    else:
        with pytest.raises(LinkError) as err:
            check_model_file(path)
        assert err.value.code == "model_link_bad_file"
