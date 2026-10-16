import os
import subprocess
import sys

from vastcomfy_agent.deadlines import DeadlineStore
from vastcomfy_agent.files import write_int, write_json
from vastcomfy_agent.models import Status
from vastcomfy_agent.state import State, StateStore
from vastcomfy_agent.status import StatusBuilder

T0 = 2_000_000


class FakeComfy:
    def __init__(self, counts=(0, 0)):
        self.counts = counts

    def queue_counts(self):
        return self.counts


class Clock:
    t = T0

    def __call__(self):
        return self.t


def setup(tmp_path, counts=(0, 0), gpu=None):
    clock = Clock()
    states = StateStore(tmp_path, clock)
    deadlines = DeadlineStore(tmp_path, clock)
    deadlines.init_first_boot(3, 6)
    comfy = FakeComfy(counts)
    builder = StatusBuilder(
        state_dir=tmp_path, states=states, deadlines=deadlines, comfy=comfy,
        gpu_reader=lambda: gpu, profile="image", commit="abc123", now=clock,
    )
    return clock, states, deadlines, builder


def test_build_returns_the_documented_fields(tmp_path):
    clock, states, deadlines, builder = setup(tmp_path, counts=(1, 2), gpu={"util_percent": 5, "vram_used_mb": 100, "vram_total_mb": 200})
    for s in (State.BOOTING, State.DOWNLOADING, State.READY):
        states.set(s)
    deadlines.set_idle_destroy_at(T0 + 1800)
    clock.t = T0 + 60
    status = builder.build()
    assert isinstance(status, Status)
    assert status.schema_version == 1
    assert status.state == State.READY
    assert status.now == T0 + 60 and status.boot_at == T0 and status.uptime_s == 60
    assert status.idle_destroy_at == T0 + 1800
    assert status.failsafe_at == T0 + 3 * 3600 and status.hard_cap_at == T0 + 6 * 3600
    assert status.queue.running == 1 and status.queue.pending == 2
    assert status.gpu.vram_total_mb == 200
    assert status.profile == "image" and status.commit == "abc123"


def test_queue_is_null_when_comfy_is_unreachable(tmp_path):
    _, _, _, builder = setup(tmp_path, counts=None)
    assert builder.build().queue is None


def test_gpu_fields_are_null_when_unavailable(tmp_path):
    _, _, _, builder = setup(tmp_path, gpu=None)
    gpu = builder.build().gpu
    assert gpu.util_percent is None and gpu.vram_used_mb is None and gpu.vram_total_mb is None


def test_progress_only_while_downloading(tmp_path):
    clock, states, _, builder = setup(tmp_path)
    states.set(State.BOOTING)
    states.set(State.DOWNLOADING)
    write_json(tmp_path / "progress.json", {"phase": "models", "file": "a.gguf", "bytes_done": 5, "bytes_total": 10})
    progress = builder.build().progress
    assert progress.file == "a.gguf" and progress.bytes_done == 5
    states.set(State.READY)
    assert builder.build().progress is None


def test_corrupt_progress_file_is_ignored(tmp_path):
    _, states, _, builder = setup(tmp_path)
    states.set(State.BOOTING)
    states.set(State.DOWNLOADING)
    (tmp_path / "progress.json").write_text("{broken")
    assert builder.build().progress is None


def test_failsafe_alive_reflects_the_pid_file(tmp_path):
    _, _, _, builder = setup(tmp_path)
    assert builder.build().failsafe_alive is False
    write_int(tmp_path / "failsafe.pid", os.getpid())
    assert builder.build().failsafe_alive is True
    done = subprocess.Popen([sys.executable, "-c", "pass"])
    done.wait()
    write_int(tmp_path / "failsafe.pid", done.pid)
    assert builder.build().failsafe_alive is False


def test_destroy_info_merges_failsafe_and_agent_records(tmp_path):
    _, _, _, builder = setup(tmp_path)
    assert builder.build().destroy.model_dump() == {"pending": False, "attempts": 0, "last_error": None}
    write_json(tmp_path / "destroy_failsafe.json", {"pending": True, "attempts": 4, "last_error": "api down"})
    write_json(tmp_path / "destroy_agent.json", {"attempts": 2, "last_error": None})
    info = builder.build().destroy
    assert info.pending is True and info.attempts == 4 and info.last_error == "api down"


def test_status_before_first_boot_has_null_state_and_times(tmp_path):
    clock = Clock()
    states = StateStore(tmp_path, clock)
    builder = StatusBuilder(
        state_dir=tmp_path, states=states, deadlines=DeadlineStore(tmp_path, clock), comfy=FakeComfy(),
        gpu_reader=lambda: None, profile="image", commit="c", now=clock,
    )
    status = builder.build()
    assert status.state is None and status.boot_at is None and status.uptime_s is None
