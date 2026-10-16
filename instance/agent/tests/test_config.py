import pytest

from vastcomfy_agent import config as cfgmod
from vastcomfy_agent.config import ConfigError, load_config, load_schema, parse_env_file

SCHEMA = """
version: 1
keys:
  - {name: TOKEN, components: [instance], type: str, secret: true, required: true, default: null, description: "a token"}
  - {name: PORT, components: [instance], type: int, secret: false, required: false, default: 8189, description: "a port"}
  - {name: FLAG, components: [instance], type: bool, secret: false, required: false, default: false, description: "a flag"}
  - {name: ITEMS, components: [instance], type: csv, secret: false, required: false, default: "a,b", description: "a list"}
  - {name: NOTE, components: [instance], type: str, secret: false, required: false, default: "", description: "free text"}
  - {name: ONLY_APPS, components: [apps], type: str, secret: false, required: false, default: x, description: "apps only"}
"""


@pytest.fixture
def schema(tmp_path):
    path = tmp_path / "schema.yaml"
    path.write_text(SCHEMA)
    return path


def write_env(tmp_path, text):
    path = tmp_path / ".env"
    path.write_text(text)
    return path


def test_defaults_and_coercion(tmp_path, schema):
    env = write_env(tmp_path, "TOKEN=abc\nPORT=9000\nFLAG=true\nITEMS=x, y ,z\n")
    cfg = load_config(env, "instance", schema)
    assert cfg.token == "abc"
    assert cfg.port == 9000
    assert cfg.flag is True
    assert cfg.items == ["x", "y", "z"]
    assert cfg.note == ""


def test_defaults_applied_when_key_absent(tmp_path, schema):
    cfg = load_config(write_env(tmp_path, "TOKEN=abc\n"), "instance", schema)
    assert cfg.port == 8189
    assert cfg.flag is False
    assert cfg.items == ["a", "b"]


def test_unknown_key_fails_and_names_it(tmp_path, schema):
    env = write_env(tmp_path, "TOKEN=abc\nSURPRISE=1\n")
    with pytest.raises(ConfigError, match="SURPRISE"):
        load_config(env, "instance", schema)


def test_key_of_another_component_is_unknown(tmp_path, schema):
    env = write_env(tmp_path, "TOKEN=abc\nONLY_APPS=1\n")
    with pytest.raises(ConfigError, match="ONLY_APPS"):
        load_config(env, "instance", schema)


def test_missing_required_key_fails_and_names_it(tmp_path, schema):
    with pytest.raises(ConfigError, match="TOKEN"):
        load_config(write_env(tmp_path, "PORT=1\n"), "instance", schema)


def test_empty_required_value_counts_as_missing(tmp_path, schema):
    with pytest.raises(ConfigError, match="TOKEN"):
        load_config(write_env(tmp_path, "TOKEN=\n"), "instance", schema)


def test_bad_int_and_bad_bool_fail(tmp_path, schema):
    with pytest.raises(ConfigError, match="PORT"):
        load_config(write_env(tmp_path, "TOKEN=a\nPORT=abc\n"), "instance", schema)
    with pytest.raises(ConfigError, match="FLAG"):
        load_config(write_env(tmp_path, "TOKEN=a\nFLAG=yes\n"), "instance", schema)


def test_secret_never_appears_in_repr_or_redacted(tmp_path, schema):
    cfg = load_config(write_env(tmp_path, "TOKEN=supersecret\n"), "instance", schema)
    assert "supersecret" not in repr(cfg)
    assert cfg.redacted()["TOKEN"] == "***"
    assert cfg.redacted()["PORT"] == 8189


def test_value_with_equals_hash_and_spaces_round_trips(tmp_path, schema):
    # Review focus 2: tokens and URLs contain '=', '#', and may end with a space.
    env = write_env(tmp_path, "TOKEN=a=b#c d \nNOTE=x=y\n")
    cfg = load_config(env, "instance", schema)
    assert cfg.token == "a=b#c d "
    assert cfg.note == "x=y"


def test_parse_env_file_skips_blanks_and_comments(tmp_path):
    env = write_env(tmp_path, "# comment\n\nA=1\n  # indented comment\nB=2\n")
    assert parse_env_file(env) == {"A": "1", "B": "2"}


def test_parse_env_file_rejects_line_without_equals(tmp_path):
    with pytest.raises(ConfigError, match=":2:"):
        parse_env_file(write_env(tmp_path, "A=1\nBROKEN\n"))


def test_duplicate_schema_keys_are_rejected(tmp_path):
    path = tmp_path / "schema.yaml"
    path.write_text(
        "version: 1\nkeys:\n"
        "  - {name: A, components: [instance], type: str, secret: false, required: false, default: '', description: d}\n"
        "  - {name: A, components: [instance], type: str, secret: false, required: false, default: '', description: d}\n"
    )
    with pytest.raises(ConfigError, match="duplicate"):
        load_schema(path)


def test_real_schema_is_valid_and_has_the_essential_keys():
    specs = load_schema()
    names = {s.name for s in specs}
    assert {"CONTAINER_ID", "CONTAINER_API_KEY", "AGENT_TOKEN", "STATE_DIR", "IDLE_MINUTES",
            "FAILSAFE_HOURS", "HARD_CAP_HOURS", "VASTAI_BIN", "VAST_API_KEY", "DISCORD_BOT_TOKEN"} <= names
    secrets = {s.name for s in specs if s.secret}
    assert {"CONTAINER_API_KEY", "AGENT_TOKEN", "TS_AUTHKEY", "HF_TOKEN", "VAST_API_KEY"} <= secrets
    for spec in specs:
        assert spec.type in {"str", "int", "bool", "csv"}, spec.name
        assert spec.components and set(spec.components) <= {"instance", "apps"}, spec.name
        assert spec.description, spec.name
        if not spec.required and spec.type != "str":
            assert spec.default is not None, f"{spec.name} needs a default"


def test_main_list_marks_secrets_and_hides_their_defaults(capsys):
    assert cfgmod.main(["list", "--component", "instance"]) == 0
    out = capsys.readouterr().out
    assert "CONTAINER_API_KEY" in out and "secret" in out


def test_main_init_writes_empty_env_and_refuses_to_overwrite(tmp_path):
    target = tmp_path / ".env"
    assert cfgmod.main(["init", "--component", "instance", "--out", str(target)]) == 0
    text = target.read_text()
    assert "CONTAINER_API_KEY=" in text
    assert cfgmod.main(["init", "--component", "instance", "--out", str(target)]) == 1


def test_gen_keys_matches_committed_allowed_keys_file(tmp_path):
    generated = tmp_path / "keys.txt"
    assert cfgmod.main(["gen-keys", "--out", str(generated)]) == 0
    committed = cfgmod.SCHEMA_PATH.parents[1] / "instance" / "allowed-keys.txt"
    assert committed.read_text() == generated.read_text()


def test_missing_schema_file_raises_a_clear_config_error(tmp_path):
    missing = tmp_path / "nowhere" / "config-schema.yaml"
    with pytest.raises(ConfigError, match="config schema not found at .*nowhere"):
        load_schema(missing)


@pytest.mark.parametrize("text", ["1_0", "+5", " 08 ", "-1", "5 ", "1e3", "0x10", "٣", "12\n"])
def test_int_accepts_only_plain_ascii_digits(schema, text):
    port = next(s for s in load_schema(schema) if s.name == "PORT")
    with pytest.raises(ConfigError, match="PORT: expected an integer"):
        cfgmod._coerce(port, text)


def test_non_strict_int_in_an_env_file_fails_and_names_the_key(tmp_path, schema):
    with pytest.raises(ConfigError, match="PORT"):
        load_config(write_env(tmp_path, "TOKEN=a\nPORT=1_0\n"), "instance", schema)


def test_int_with_leading_zero_is_still_a_plain_integer(tmp_path, schema):
    assert load_config(write_env(tmp_path, "TOKEN=a\nPORT=08\n"), "instance", schema).port == 8


BOUNDED = """
version: 1
keys:
  - {name: HOURS, components: [instance], type: int, secret: false, required: false, default: 3, min: 1, max: 24, description: "hours"}
  - {name: BACKOFF, components: [instance], type: int, secret: false, required: false, default: 5, min: 0, description: "backoff"}
"""


@pytest.fixture
def bounded(tmp_path):
    path = tmp_path / "bounded.yaml"
    path.write_text(BOUNDED)
    return path


def test_schema_bounds_are_loaded(bounded):
    specs = {s.name: s for s in load_schema(bounded)}
    assert (specs["HOURS"].min, specs["HOURS"].max) == (1, 24)
    assert (specs["BACKOFF"].min, specs["BACKOFF"].max) == (0, None)


@pytest.mark.parametrize("text, bound", [("0", "minimum 1"), ("25", "maximum 24")])
def test_out_of_range_int_names_the_key_and_the_bound(tmp_path, bounded, text, bound):
    with pytest.raises(ConfigError, match=f"HOURS: {text} is .*{bound}"):
        load_config(write_env(tmp_path, f"HOURS={text}\n"), "instance", bounded)


def test_values_on_the_bounds_are_accepted(tmp_path, bounded):
    assert load_config(write_env(tmp_path, "HOURS=1\nBACKOFF=0\n"), "instance", bounded).hours == 1
    assert load_config(write_env(tmp_path, "HOURS=24\n"), "instance", bounded).hours == 24


def test_bounds_on_a_non_int_key_or_non_int_bound_are_rejected(tmp_path):
    path = tmp_path / "bad.yaml"
    for item in ("{name: A, components: [instance], type: str, secret: false, required: false, default: x, min: 1, description: d}",
                 "{name: A, components: [instance], type: int, secret: false, required: false, default: 1, min: '1', description: d}",
                 "{name: A, components: [instance], type: int, secret: false, required: false, default: 1, min: 5, max: 2, description: d}"):
        path.write_text(f"version: 1\nkeys:\n  - {item}\n")
        with pytest.raises(ConfigError, match="A:"):
            load_schema(path)


def test_list_shows_the_bounds(capsys, bounded):
    assert cfgmod.cmd_list("instance", bounded) == 0
    out = capsys.readouterr().out
    hours = next(line for line in out.splitlines() if line.startswith("HOURS"))
    assert "min=1" in hours and "max=24" in hours


MIN_1_KEYS = ("DESTROY_RETRIES", "DESTROY_TIMEOUT_S", "FAILSAFE_POLL_S", "FAILSAFE_HOURS", "HARD_CAP_HOURS",
              "IDLE_MINUTES", "IDLE_WARN_MINUTES", "COMFY_POLL_S", "EXTEND_MAX_IDLE_MIN", "EXTEND_MAX_FAILSAFE_MIN",
              "DOWNLOAD_RETRIES", "HTTP_TIMEOUT_S", "WORKFLOW_MAX_BYTES", "COMFY_START_TIMEOUT_S",
              "AGENT_START_TIMEOUT_S")


def test_real_schema_bounds_the_behaviour_driving_ints():
    specs = {s.name: s for s in load_schema()}
    for name in MIN_1_KEYS:
        assert specs[name].min == 1, name
    for name in ("DESTROY_BACKOFF_S", "DISK_MARGIN_MB"):
        assert specs[name].min == 0, name
    for name in ("FAILSAFE_HOURS", "HARD_CAP_HOURS"):
        assert specs[name].max == 24, name
    for spec in specs.values():  # every default satisfies its own bounds
        if spec.type == "int" and spec.default is not None:
            assert spec.min is None or spec.default >= spec.min, spec.name
            assert spec.max is None or spec.default <= spec.max, spec.name
