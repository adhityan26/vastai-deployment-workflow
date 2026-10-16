import subprocess

import httpx

from vastcomfy_agent.comfy import ComfyClient, read_gpu


def client_for(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_queue_counts_reads_running_and_pending():
    def handler(request):
        assert request.url.path == "/queue"
        return httpx.Response(200, json={"queue_running": [[1]], "queue_pending": [[2], [3]]})

    comfy = ComfyClient("http://comfy.test:1", client_for(handler))
    assert comfy.queue_counts() == (1, 2)


def test_queue_counts_is_none_when_unreachable_or_malformed():
    def down(request):
        raise httpx.ConnectError("refused")

    def malformed(request):
        return httpx.Response(200, json={"nope": 1})

    def server_error(request):
        return httpx.Response(500, text="boom")

    assert ComfyClient("http://c.test:1", client_for(down)).queue_counts() is None
    assert ComfyClient("http://c.test:1", client_for(malformed)).queue_counts() is None
    assert ComfyClient("http://c.test:1", client_for(server_error)).queue_counts() is None


def test_ready_checks_system_stats():
    ok = ComfyClient("http://c.test:1", client_for(lambda r: httpx.Response(200, json={})))
    bad = ComfyClient("http://c.test:1", client_for(lambda r: httpx.Response(503)))

    def down(request):
        raise httpx.ConnectError("refused")

    assert ok.ready() is True
    assert bad.ready() is False
    assert ComfyClient("http://c.test:1", client_for(down)).ready() is False


def proc(out, code=0):
    return subprocess.CompletedProcess(args=[], returncode=code, stdout=out, stderr="")


def test_read_gpu_parses_nvidia_smi_csv():
    calls = []

    def run(cmd, **kwargs):
        calls.append(cmd)
        return proc("37, 20480, 24564\n")

    assert read_gpu(run, "nvidia-smi", 5) == {"util_percent": 37, "vram_used_mb": 20480, "vram_total_mb": 24564}
    assert calls[0][0] == "nvidia-smi"


def test_read_gpu_none_on_failure_or_garbage():
    assert read_gpu(lambda *a, **k: proc("", 9), "nvidia-smi", 5) is None
    assert read_gpu(lambda *a, **k: proc("[N/A], [N/A], [N/A]"), "nvidia-smi", 5) is None

    def missing(*a, **k):
        raise FileNotFoundError("nvidia-smi")

    assert read_gpu(missing, "nvidia-smi", 5) is None
