import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("check_config_usage", ROOT / "scripts" / "check_config_usage.py")
lint = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lint)


def rules(name, suffix, text):
    return [rule for _, rule, _ in lint.scan_text(name, suffix, text)]


def test_environment_reads_are_only_allowed_in_config_and_boot_modules():
    code = "import os\nvalue = os.environ['X']\nother = os.getenv('Y')\n"
    assert rules("agent.py", ".py", code) == ["env-read", "env-read"]
    assert rules("config.py", ".py", code) == []
    assert rules("boot.py", ".py", code) == []
    assert rules("server.ts", ".ts", "const a = process.env.X;\n") == ["env-read"]
    assert rules("config.ts", ".ts", "export default { a: process.env.X };\n") == []


@pytest.mark.parametrize(
    "line,rule",
    [
        ('host = "10.0.0.5"\n', "ipv4"),
        ('url = "https://example.com/x"\n', "url"),
        ('url = f"http://{host}:{port}"\n', "url"),
        ('addr = "localhost:8188"\n', "port"),
        ("port = 8189\n", "port"),
        ('path = "/var/lib/vastcomfy"\n', "abs-path"),
        ("path = '/opt/thing'\n", "abs-path"),
    ],
)
def test_python_hardcoded_values_are_flagged(line, rule):
    assert rule in rules("mod.py", ".py", line)


def test_marker_comments_docstrings_and_plain_code_are_not_flagged():
    clean = (
        '"""Talks to https://example.com on 10.0.0.1 and /var/lib/x."""\n'
        "# a comment mentioning http://example.com\n"
        'url = f"http://{h}"  # config-lint: ok (local scheme)\n'
        'doc = """\nmultiline mentions /etc/hosts and 127.0.0.1\n"""\n'
        "timeout = 30\n"
        'name = "/queue"\n'
    )
    assert rules("mod.py", ".py", clean) == []


def test_shell_and_conf_rules():
    assert "abs-path" in rules("x.sh", ".sh", "cp a /opt/vast-comfy/b\n")
    assert "url" in rules("x.sh", ".sh", "curl https://example.com\n")
    assert rules("x.sh", ".sh", 'PY=python3  # config-lint: ok (bootstrap)\nexec 2>/dev/null\n') == []
    assert rules("x.sh", ".sh", "# cp a /opt/x\n") == []
    assert "abs-path" in rules("s.conf", ".conf", "file=/var/lib/x.sock\n")
    assert rules("s.conf", ".conf", "file=%(ENV_STATE_DIR)s/supervisor.sock\n; /var/lib comment\n") == []


def test_scan_paths_skips_tests_and_virtualenvs(tmp_path):
    (tmp_path / "pkg").mkdir()
    (tmp_path / "pkg" / "a.py").write_text('x = "10.1.1.1"\n')
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "t.py").write_text('x = "10.1.1.1"\n')
    (tmp_path / ".venv").mkdir()
    (tmp_path / ".venv" / "v.py").write_text('x = "10.1.1.1"\n')
    found = lint.scan_paths([tmp_path])
    assert [(p.name, rule) for p, _, rule, _ in found] == [("a.py", "ipv4")]


def test_the_instance_tree_is_currently_clean():
    findings = lint.scan_paths([ROOT / "instance"])
    assert findings == [], "\n".join(f"{p}:{n}: [{r}] {t}" for p, n, r, t in findings)


@pytest.mark.parametrize(
    "line",
    [
        "COMFY_PORT = 8188\n",
        "PORT=8189\n",
        "const comfyPort = 8188;\n",
        "srv.listen(8188)\n",
        "sock.bind((host, 8188))\n",
        "run(app, port=8188)\n",
        "const COMFY_PORT: number = 8188;\n",
    ],
)
def test_port_literals_are_flagged_including_suffixed_names_and_listen_calls(line):
    assert "port" in rules("mod.py", ".py", line)


@pytest.mark.parametrize(
    "line",
    [
        "timeout = 30\n",
        "chunk = data[0:1000]\n",
        "chunk = data[start:1000]\n",
        "backlog = srv.listen(128)\n",
        "report = 12\n",
        "x = port\n",
    ],
)
def test_port_rule_ignores_slices_small_numbers_and_non_literals(line):
    assert "port" not in rules("mod.py", ".py", line)


@pytest.mark.parametrize(
    "name,suffix,line",
    [
        ("agent.py", ".py", 'from os import environ\nx = environ["X"]\n'),
        ("agent.py", ".py", 'from os import getenv\nx = getenv("X")\n'),
        ("agent.py", ".py", 'x = environ.get("X")\n'),
        ("a.ts", ".ts", "const a = import.meta.env.X;\n"),
        ("a.js", ".js", 'const a = process["env"].X;\n'),
        ("a.mjs", ".mjs", "const { X } = process.env;\n"),
    ],
)
def test_aliased_environment_reads_are_flagged(name, suffix, line):
    assert "env-read" in rules(name, suffix, line)
    allowed = {".py": "config.py", ".ts": "config.ts", ".js": "config.js", ".mjs": "config.mjs"}[suffix]
    assert "env-read" not in rules(allowed, suffix, line)


def test_environment_look_alikes_and_comments_are_not_flagged():
    code = "environment = 1\nmy_environ_name = 2\n# environ['X'] and getenv('Y')\nx = get_environment()\n"
    assert "env-read" not in rules("agent.py", ".py", code)
    assert "env-read" not in rules("a.ts", ".ts", "// import.meta.env\nconst environment = 1;\n")
