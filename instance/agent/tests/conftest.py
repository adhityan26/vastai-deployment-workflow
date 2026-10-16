import pytest

from vastcomfy_agent.config import load_config


@pytest.fixture
def make_cfg(tmp_path):
    def _make(**overrides):
        values = {
            "CONTAINER_ID": "42",
            "CONTAINER_API_KEY": "container-key",
            "AGENT_TOKEN": "tok-123",
            "TS_HOSTNAME": "vast-test",
            "REPO_URL": "https://example.invalid/repo.git",
            "REPO_COMMIT": "abc123",
            "PROFILE": "image",
            "STATE_DIR": str(tmp_path / "state"),
            "WORKFLOWS_DIR": str(tmp_path / "workflows"),
            "COMFY_DIR": str(tmp_path / "comfy"),
        }
        values.update(overrides)
        env = tmp_path / ".env"
        env.write_text("".join(f"{key}={value}\n" for key, value in values.items()))
        return load_config(env, "instance")

    return _make
