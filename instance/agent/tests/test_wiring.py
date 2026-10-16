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
        return subprocess.CompletedProcess(cmd, 1 if cmd[0] == "vastai" else 0, "", "nope")

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
