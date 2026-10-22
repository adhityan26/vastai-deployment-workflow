import pytest
from fastapi.testclient import TestClient

from vastcomfy_agent.app import Deps, create_app
from vastcomfy_agent.deadlines import DeadlineStore
from vastcomfy_agent.files import write_json
from vastcomfy_agent.state import State, StateStore
from vastcomfy_agent.status import StatusBuilder
from vastcomfy_agent.workflows import WorkflowStore

T0 = 3_000_000
AUTH = {"Authorization": "Bearer tok-123"}


class Clock:
    t = T0

    def __call__(self):
        return self.t


class FakeComfy:
    def queue_counts(self):
        return (0, 0)


class FakeFlow:
    def __init__(self):
        self.reasons = []

    def run(self, reason):
        self.reasons.append(reason)
        return True


@pytest.fixture
def env(tmp_path, make_cfg):
    cfg = make_cfg()
    clock = Clock()
    states = StateStore(tmp_path / "state", clock)
    deadlines = DeadlineStore(tmp_path / "state", clock)
    deadlines.init_first_boot(3, 6)
    for s in (State.BOOTING, State.DOWNLOADING, State.READY):
        states.set(s)
    deadlines.set_idle_destroy_at(T0 + 1800)
    flow = FakeFlow()
    builder = StatusBuilder(
        state_dir=tmp_path / "state", states=states, deadlines=deadlines, comfy=FakeComfy(),
        gpu_reader=lambda: None, profile="image", commit="abc123", now=clock,
    )
    deps = Deps(cfg=cfg, states=states, deadlines=deadlines, status=builder, flow=flow,
                workflows=WorkflowStore(tmp_path / "workflows", cfg.workflow_max_bytes))
    return TestClient(create_app(deps)), deps, flow


def test_health_is_open_everything_else_needs_the_token(env):
    client, _, _ = env
    assert client.get("/health").json() == {"ok": True}
    for method, path in [("get", "/status"), ("post", "/extend"), ("post", "/destroy"),
                         ("get", "/workflows"), ("get", "/workflows/a.json"), ("put", "/workflows/a.json")]:
        assert getattr(client, method)(path).status_code == 401
        assert getattr(client, method)(path, headers={"Authorization": "Bearer wrong"}).status_code == 401
        assert getattr(client, method)(path, headers={"Authorization": "tok-123"}).status_code == 401


def test_status_returns_the_contract_shape(env):
    client, _, _ = env
    body = client.get("/status", headers=AUTH).json()
    assert body["schema_version"] == 1 and body["state"] == "ready"
    assert body["queue"] == {"running": 0, "pending": 0}
    assert set(body) >= {"reason", "progress", "now", "boot_at", "uptime_s", "idle_destroy_at", "failsafe_at",
                         "hard_cap_at", "gpu", "profile", "commit", "failsafe_alive", "destroy"}


def test_extend_failsafe_and_idle(env):
    client, deps, _ = env
    res = client.post("/extend", headers=AUTH, json={"kind": "failsafe", "minutes": 30})
    assert res.status_code == 200 and res.json() == {"kind": "failsafe", "deadline": T0 + 3 * 3600 + 1800}
    res = client.post("/extend", headers=AUTH, json={"kind": "idle", "minutes": 15})
    assert res.json()["deadline"] == T0 + 1800 + 900
    assert deps.deadlines.idle_destroy_at() == T0 + 2700


def test_extend_beyond_hard_cap_names_the_limit_and_changes_nothing(env):
    client, deps, _ = env
    res = client.post("/extend", headers=AUTH, json={"kind": "failsafe", "minutes": 181})
    assert res.status_code == 400
    assert res.json()["detail"]["code"] == "beyond_hard_cap" or res.json()["detail"]["code"] == "too_large"
    assert deps.deadlines.deadline() == T0 + 3 * 3600


@pytest.mark.parametrize("minutes", [0, -5, 10**9])
def test_extend_out_of_range_integers_are_400(env, minutes):
    client, deps, _ = env
    res = client.post("/extend", headers=AUTH, json={"kind": "idle", "minutes": minutes})
    assert res.status_code == 400
    assert deps.deadlines.idle_destroy_at() == T0 + 1800


@pytest.mark.parametrize("minutes", ["10", 1.5, True, None])
def test_extend_wrong_types_are_rejected_and_change_nothing(env, minutes):
    client, deps, _ = env
    res = client.post("/extend", headers=AUTH, json={"kind": "idle", "minutes": minutes})
    assert res.status_code in (400, 422)
    assert deps.deadlines.idle_destroy_at() == T0 + 1800


def test_destroy_sets_stopping_and_runs_the_flow_in_the_background(env):
    client, deps, flow = env
    res = client.post("/destroy", headers=AUTH, json={"reason": "manual"})
    assert res.status_code == 202 and res.json() == {"accepted": True}
    assert deps.states.get().state == State.STOPPING and deps.states.get().reason == "manual"
    assert flow.reasons == ["manual"]
    again = client.post("/destroy", headers=AUTH, json={"reason": "watchdog"})
    assert again.status_code == 202


def test_destroy_rejects_unknown_reasons(env):
    client, _, flow = env
    assert client.post("/destroy", headers=AUTH, json={"reason": "idle_timeout"}).status_code == 422
    assert flow.reasons == []


def test_workflow_round_trip_and_errors(env):
    client, _, _ = env
    assert client.get("/workflows", headers=AUTH).json() == []
    assert client.put("/workflows/a.json", headers=AUTH, content=b'{"n": 1}').status_code == 200
    assert client.get("/workflows/a.json", headers=AUTH).json() == {"n": 1}
    assert [w["name"] for w in client.get("/workflows", headers=AUTH).json()] == ["a.json"]
    assert client.put("/workflows/a.json", headers=AUTH, content=b'{"n": 2}').status_code == 200
    assert client.get("/workflows/a.json", headers=AUTH).json() == {"n": 2}
    assert client.get("/workflows/missing.json", headers=AUTH).status_code == 404
    assert client.put("/workflows/bad.txt", headers=AUTH, content=b"{}").status_code == 400
    assert client.put("/workflows/b.json", headers=AUTH, content=b"{nope").status_code == 422
    too_big = b'{"x": "' + b"a" * 2_000_000 + b'"}'
    assert client.put("/workflows/c.json", headers=AUTH, content=too_big).status_code == 413
    assert client.put("/workflows/caf%C3%A9.json", headers=AUTH, content=b"{}").status_code == 400
    assert client.put("/workflows/..%2Fevil.json", headers=AUTH, content=b"{}").status_code in (400, 404)


def _set_state(deps, target):
    deps.states.set(State.STOPPING, "manual")
    if target == State.DESTROY_FAILED:
        deps.states.set(State.DESTROY_FAILED)
    if target == State.FAILED:
        write_json(deps.states._path, {"state": "failed", "reason": "boot_failed", "updated_at": T0})


@pytest.mark.parametrize("target", [State.STOPPING, State.DESTROY_FAILED, State.FAILED])
@pytest.mark.parametrize("kind", ["idle", "failsafe"])
def test_extend_is_409_while_stopping_destroy_failed_or_failed(env, target, kind):
    client, deps, _ = env
    _set_state(deps, target)
    assert deps.states.get().state == target
    res = client.post("/extend", headers=AUTH, json={"kind": kind, "minutes": 30})
    assert res.status_code == 409 and res.json()["detail"]["code"] == "not_extendable"
    assert res.json()["detail"]["message"]
    assert deps.deadlines.deadline() == T0 + 3 * 3600 and deps.deadlines.idle_destroy_at() == T0 + 1800


@pytest.mark.parametrize("kind", ["idle", "failsafe"])
def test_extend_is_409_while_the_failsafe_destroy_is_pending(env, tmp_path, kind):
    client, deps, _ = env
    write_json(tmp_path / "state" / "destroy_failsafe.json", {"attempts": 1, "last_error": "x", "pending": True})
    res = client.post("/extend", headers=AUTH, json={"kind": kind, "minutes": 30})
    assert res.status_code == 409 and res.json()["detail"]["code"] == "not_extendable"
    assert deps.deadlines.deadline() == T0 + 3 * 3600 and deps.deadlines.idle_destroy_at() == T0 + 1800


def test_extend_is_allowed_when_the_failsafe_record_is_not_pending(env, tmp_path):
    client, _, _ = env
    write_json(tmp_path / "state" / "destroy_failsafe.json", {"attempts": 0, "last_error": None, "pending": False})
    assert client.post("/extend", headers=AUTH, json={"kind": "idle", "minutes": 5}).status_code == 200


def test_openapi_declares_the_409(env):
    client, _, _ = env
    assert "409" in client.get("/openapi.json").json()["paths"]["/extend"]["post"]["responses"]


# --- POST /video-models ---

class FakeVideo:
    def __init__(self, refuse=None):
        from vastcomfy_agent.models import VideoModelsStatus

        self.refuse, self.calls = refuse, 0
        self.status = VideoModelsStatus(state="downloading", boot=False, bytes_done=0, bytes_total=50)

    def start(self):
        self.calls += 1
        if self.refuse is not None:
            raise self.refuse
        return self.status

    def view(self):
        return self.status


def test_video_models_starts_the_download_and_reports_it(env):
    client, deps, _ = env
    assert client.post("/video-models").status_code == 401
    assert client.post("/video-models", headers=AUTH).json()["detail"]["code"] == "video_unavailable"
    deps.video = FakeVideo()
    res = client.post("/video-models", headers=AUTH)
    assert res.status_code == 202
    assert res.json() == {"state": "downloading", "boot": False, "bytes_done": 0, "bytes_total": 50, "reason": None}


def test_video_models_refusals_keep_their_status_and_code(env):
    from vastcomfy_agent.video_models import VideoModelsRefused

    client, deps, _ = env
    deps.video = FakeVideo(VideoModelsRefused(409, "disk_insufficient", "too small"))
    res = client.post("/video-models", headers=AUTH)
    assert res.status_code == 409 and res.json()["detail"] == {"code": "disk_insufficient", "message": "too small"}


def test_status_carries_the_video_models_and_survives_their_errors(tmp_path, make_cfg):
    from vastcomfy_agent.models import VideoModelsStatus

    clock = Clock()
    states = StateStore(tmp_path / "s", clock)
    deadlines = DeadlineStore(tmp_path / "s", clock)
    ok = VideoModelsStatus(state="ready", boot=True, bytes_done=5, bytes_total=5)
    builder = StatusBuilder(state_dir=tmp_path / "s", states=states, deadlines=deadlines, comfy=FakeComfy(),
                            gpu_reader=lambda: None, profile="image", commit="c", now=clock, video=lambda: ok)
    assert builder.build().video_models == ok

    def boom():
        raise OSError("disk")

    builder._video = boom
    assert builder.build().video_models is None
