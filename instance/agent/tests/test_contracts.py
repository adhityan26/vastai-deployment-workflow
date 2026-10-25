import json
from pathlib import Path

import jsonschema

from vastcomfy_agent.contracts_export import build_contracts

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"


def test_committed_generated_contracts_are_current():
    for name, text in build_contracts().items():
        assert (CONTRACTS / name).read_text() == text, f"{name} is stale; run contracts_export"


def test_openapi_lists_every_endpoint_of_the_spec():
    paths = json.loads((CONTRACTS / "agent.openapi.json").read_text())["paths"]
    assert set(paths) == {"/health", "/status", "/extend", "/destroy", "/workflows", "/workflows/{name}", "/video-models", "/loras"}
    assert set(paths["/workflows/{name}"]) == {"get", "put"}
    assert json.loads((CONTRACTS / "agent.openapi.json").read_text())["openapi"].startswith("3.1")


def test_status_schema_requires_the_fields_the_watchdog_reads():
    schema = json.loads((CONTRACTS / "status.schema.json").read_text())
    required = set(schema["required"])
    assert {"state", "now", "boot_at", "queue", "failsafe_alive", "destroy", "hard_cap_at", "failsafe_at"} <= required
    assert schema["properties"]["schema_version"]["const"] == 1


def test_registry_schema_is_valid_and_accepts_a_sample_record():
    schema = json.loads((CONTRACTS / "instance-registry.schema.json").read_text())
    jsonschema.Draft202012Validator.check_schema(schema)
    record = {
        "vast_instance_id": 123, "created_at": 1_700_000_000, "vast_start_date": 1_700_000_005.5,
        "profile": "image", "agent_token": "x" * 32, "tailnet_hostname": "vast-ab12",
        "status": "booting", "unreachable_since": None,
    }
    jsonschema.validate(record, schema)
    for broken in ({**record, "status": "weird"}, {**record, "extra": 1}, {k: v for k, v in record.items() if k != "profile"}):
        try:
            jsonschema.validate(broken, schema)
        except jsonschema.ValidationError:
            continue
        raise AssertionError("schema accepted a broken record")


def test_registry_schema_takes_the_boot_extra_minutes_of_a_video_boot():
    schema = json.loads((CONTRACTS / "instance-registry.schema.json").read_text())
    record = {
        "vast_instance_id": 123, "created_at": 1_700_000_000, "profile": "image", "agent_token": "x" * 32,
        "tailnet_hostname": "vast-ab12", "status": "booting",
    }
    jsonschema.validate({**record, "boot_extra_min": 40}, schema)
    for bad in (0, -1, 1.5, "40", None):
        try:
            jsonschema.validate({**record, "boot_extra_min": bad}, schema)
        except jsonschema.ValidationError:
            continue
        raise AssertionError(f"schema accepted boot_extra_min {bad!r}")


def test_registry_null_vast_id_only_while_creating():
    schema = json.loads((CONTRACTS / "instance-registry.schema.json").read_text())
    record = {
        "vast_instance_id": None, "created_at": 1_700_000_000, "profile": "image",
        "agent_token": "x" * 32, "tailnet_hostname": "vast-ab12", "status": "creating",
    }
    jsonschema.validate(record, schema)
    jsonschema.validate({**record, "status": "gone"}, schema)  # create failed before Vast
    for status in ("booting", "ready", "stopping", "anomaly"):
        try:
            jsonschema.validate({**record, "status": status}, schema)
        except jsonschema.ValidationError:
            continue
        raise AssertionError(f"null id accepted for status {status}")
