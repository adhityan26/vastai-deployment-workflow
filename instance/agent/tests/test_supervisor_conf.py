import configparser

import pytest

from vastcomfy_agent import supervisor_conf
from vastcomfy_agent.config import ConfigError


def parsed(text):
    parser = configparser.RawConfigParser(strict=True)
    parser.read_string(text)
    return parser


def test_render_defines_both_programs_with_literal_values(make_cfg, tmp_path):
    cfg = make_cfg(TAILSCALED_BIN="/usr/sbin/tailscaled", TS_SOCKET="/run/ts.sock", STATE_DIR="/var/lib/vc",
                   AGENT_PYTHON="/opt/venv/bin/python", ENV_FILE_PATH="/etc/vc/.env", REPO_DIR="/opt/repo")
    text = supervisor_conf.render(cfg)
    assert "%" not in text and "ENV_" not in text
    conf = parsed(text)
    assert set(conf.sections()) == {"program:tailscaled", "program:agent"}
    ts, agent = conf["program:tailscaled"], conf["program:agent"]
    assert ts["command"] == ("/usr/sbin/tailscaled --tun=userspace-networking "
                             "--state=/var/lib/vc/tailscale/tailscaled.state --socket=/run/ts.sock")
    assert agent["command"] == "/opt/venv/bin/python -m vastcomfy_agent --env-file /etc/vc/.env"
    assert agent["directory"] == "/opt/repo/instance/agent"
    for section in (ts, agent):
        assert section["autostart"] == "false" and section["autorestart"] == "true"
    assert agent["startsecs"] == "1" and agent["startretries"] == "10"


def test_render_ends_with_a_newline_and_is_deterministic(make_cfg):
    cfg = make_cfg()
    assert supervisor_conf.render(cfg) == supervisor_conf.render(cfg)
    assert supervisor_conf.render(cfg).endswith("\n")


@pytest.mark.parametrize("key", ["TAILSCALED_BIN", "TS_SOCKET", "STATE_DIR", "AGENT_PYTHON", "ENV_FILE_PATH", "REPO_DIR"])
@pytest.mark.parametrize("bad", ["/a b/x", "/a\tb", "/a%(ENV_X)s", "/a%b"])
def test_render_rejects_values_supervisor_would_reparse(make_cfg, key, bad):
    with pytest.raises(ConfigError, match=key):
        supervisor_conf.render(make_cfg(**{key: bad}))
