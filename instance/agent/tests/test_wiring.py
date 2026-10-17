import subprocess

import httpx

from vastcomfy_agent import wiring
from vastcomfy_agent.state import State


def test_stop_comfy_uses_configured_binary_conf_and_program(make_cfg):
    cfg = make_cfg(SUPERVISORCTL_BIN="sctl", SUPERVISOR_CONF="/x/sup.conf", COMFY_PROGRAM="comfy")
    calls = []

    def run(cmd, **kwargs):
        calls.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, "", "")

    wiring.make_stop_comfy(cfg, run)()
    assert calls == [["sctl", "-c", "/x/sup.conf", "stop", "comfy"]]


def test_build_wires_a_working_status_and_destroy_flow(make_cfg, tmp_path):
    cfg = make_cfg(DESTROY_RETRIES="1", DESTROY_BACKOFF_S="0")
    calls = []

    def run(cmd, **kwargs):
        calls.append(cmd)
        # the real CLI exits 0 even when the call is refused
        out = "Failed with error 401: Authorization Error" if cmd[0] == "vastai" else ""
        return subprocess.CompletedProcess(cmd, 0, out, "")

    http = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, json={"queue_running": [], "queue_pending": []})))
    wired = wiring.build(cfg, now=lambda: 1000, run=run, http_client=http)
    wired.states.set(State.BOOTING)
    assert wired.status.build().state == State.BOOTING
    assert wired.status.build().queue.running == 0
    assert wired.flow.run("manual") is False
    assert wired.states.get().state == State.DESTROY_FAILED
    assert any(cmd[0] == "supervisorctl" for cmd in calls)


def test_build_passes_the_destroy_failed_retry_interval_to_the_runner(make_cfg):
    cfg = make_cfg(DESTROY_FAILED_RETRY_S="77")
    with httpx.Client() as client:
        wired = wiring.build(cfg, now=lambda: 1000, run=lambda *a, **k: None, http_client=client)
    assert wired.runner._retry_s == 77


def test_build_wires_the_ok_markers_so_a_real_success_text_destroys(make_cfg):
    cfg = make_cfg(DESTROY_RETRIES="1", DESTROY_BACKOFF_S="0")
    calls = []

    def run(cmd, **kwargs):
        calls.append(cmd)
        out = f"destroying instance {cfg.container_id}." if cmd[0] == "vastai" else ""
        return subprocess.CompletedProcess(cmd, 0, out, "")

    with httpx.Client() as client:
        wired = wiring.build(cfg, now=lambda: 1000, run=run, http_client=client)
    wired.states.set(State.BOOTING)
    assert wired.flow.run("manual") is True
    assert [c for c in calls if c[0] == "vastai"][0][4] == "-y"


def test_build_passes_destroy_assume_yes_to_the_destroy_command(make_cfg):
    for value, expected in (("true", True), ("false", False)):
        cfg = make_cfg(DESTROY_RETRIES="1", DESTROY_BACKOFF_S="0", DESTROY_ASSUME_YES=value)
        calls = []

        def run(cmd, **kwargs):
            calls.append(cmd)
            return subprocess.CompletedProcess(cmd, 0, "destroying instance 1.", "")

        http = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, json={})))
        wired = wiring.build(cfg, now=lambda: 1000, run=run, http_client=http)
        assert wired.destroyer.attempt() == (True, None)
        assert ("-y" in calls[0]) is expected
