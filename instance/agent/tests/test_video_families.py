"""Video families besides the base `video:` section (profile `video_families:`, switched on by VIDEO_FAMILIES)."""
import json
from pathlib import Path, PurePosixPath

import pytest
import yaml

from vastcomfy_agent.profile import (
    ProfileError, boot_models, boot_node_classes, family_model_specs, load_profile, video_family_ids,
)

INSTANCE = Path(__file__).resolve().parents[2]
SHIPPED = INSTANCE / "profiles" / "image.yaml"
FAMILY = "wan22_a14b"
SIZE = 1000


def _raw():
    return yaml.safe_load(SHIPPED.read_text())


def _family(raw):
    return next(f for f in raw["video_families"] if f["id"] == FAMILY)


def _pin_family(raw):
    """Pin-shaped `models` entries for every 14B file not pinned yet (the real pins are the owner's)."""
    have = {m["file"].rsplit("/", 1)[-1] for m in raw["models"]}
    for m in _family(raw)["models"]:
        if m["file"] not in have:
            raw["models"].append({"file": f"split_files/x/{m['file']}", "repo": "o/r", "revision": "a" * 40,
                                  "dest": m["dest"], "size_bytes": SIZE})
    return raw


def _write(tmp_path, raw):
    path = tmp_path / "image.yaml"
    path.write_text(yaml.safe_dump(raw))
    return path


def _names(models):
    return [PurePosixPath(m.file).name for m in models]


def test_the_shipped_family_is_validated_off_and_its_workflows_load_its_files():
    raw = _raw()
    fam = _family(raw)
    profile = load_profile(SHIPPED, video_enabled=True)
    assert video_family_ids(profile) == ("wan22_5b",)
    assert profile.video_base_id == "wan22_5b"
    assert [f.id for f in profile.video_families] == [FAMILY] and profile.video_families[0].enabled is False
    for mode in ("text", "image"):
        assert fam[mode]["workflow"] in raw["workflows"]
        graph = json.loads((INSTANCE / "workflows" / fam[mode]["workflow"]).read_text())
        assert {n["class_type"] for n in graph.values()} <= set(fam["node_classes"])
    used = set()
    for mode in ("text", "image"):
        graph = json.loads((INSTANCE / "workflows" / fam[mode]["workflow"]).read_text())
        used |= {v for n in graph.values() for v in n["inputs"].values() if isinstance(v, str)}
    # Every file is loaded by a workflow, except the extra LoRA, which the web app adds when a user picks it.
    extra = {e[side]["file"] for e in fam["extra_loras"] for side in ("high", "low") if side in e}
    assert extra == {"calisthenics_moves_high_noise.safetensors"}
    assert {m["file"] for m in fam["models"]} - extra <= used
    # The text encoder is the base family's own pin, shared (never a second entry).
    assert sum(1 for m in raw["models"] if m["file"].endswith("umt5_xxl_fp8_e4m3fn_scaled.safetensors")) == 1


def test_video_families_switches_a_family_on_only_with_video_enabled_and_its_pins(tmp_path):
    path = _write(tmp_path, _pin_family(_raw()))
    on = load_profile(path, video_enabled=True, video_families=(FAMILY,))
    assert video_family_ids(on) == ("wan22_5b", FAMILY)
    fam = on.video_families[0]
    assert fam.enabled and fam.title == "Quality (14B, 4 steps)" and len(fam.models) == 11
    assert ("text", "high", "wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors") in fam.experts
    assert ("image", "low", "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors") in fam.experts
    assert video_family_ids(load_profile(path, video_enabled=False, video_families=(FAMILY,))) == ()
    assert video_family_ids(load_profile(path, video_enabled=True)) == ("wan22_5b",)


def _unpin_family(raw):
    """The profile without the family's own pins (as before the owner pinned them on 2026-10-24)."""
    base = {m["file"] for m in raw["video"]["models"]}
    own = {m["file"] for m in _family(raw)["models"]} - base
    raw["models"] = [m for m in raw["models"] if m["file"].rsplit("/", 1)[-1] not in own]
    return raw


def test_the_shipped_family_is_pinned_and_switches_on(tmp_path):
    on = load_profile(SHIPPED, video_enabled=True, video_families=(FAMILY,))
    assert video_family_ids(on) == ("wan22_5b", FAMILY)
    specs = family_model_specs(on, FAMILY)
    assert len(specs) == 11 and all(len(m.revision) == 40 for m in specs)
    # 62.49 GB of its own (the extra LoRA's 153 MB included) plus the shared text encoder.
    assert sum(m.size_bytes for m in specs) == 69_228_418_399
    assert "calisthenics_moves_high_noise.safetensors" in {PurePosixPath(m.file).name for m in specs}


def test_an_enabled_family_without_its_pins_or_an_unknown_id_is_refused(tmp_path):
    with pytest.raises(ProfileError, match="wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors is not listed in models"):
        load_profile(_write(tmp_path, _unpin_family(_raw())), video_enabled=True, video_families=(FAMILY,))
    for enabled in (True, False):
        with pytest.raises(ProfileError, match="VIDEO_FAMILIES names an unknown video family: nope"):
            load_profile(SHIPPED, video_enabled=enabled, video_families=("nope",))
    raw = _pin_family(_raw())
    next(m for m in raw["models"] if m["file"].endswith("wan_2.1_vae.safetensors"))["dest"] = "models/loras/"
    with pytest.raises(ProfileError, match="wan_2.1_vae.safetensors must have dest models/vae/"):
        load_profile(_write(tmp_path, raw), video_enabled=True, video_families=(FAMILY,))


def test_a_boot_downloads_only_the_chosen_families_files(tmp_path):
    profile = load_profile(_write(tmp_path, _pin_family(_raw())), video_enabled=True, video_families=(FAMILY,))
    image_only = _names(boot_models(profile, False))
    assert "umt5_xxl_fp8_e4m3fn_scaled.safetensors" not in image_only and len(image_only) == 5
    # Include video with no family named: the base family only (as before families existed).
    base = _names(boot_models(profile, True))
    assert base == image_only + ["wan2.2_ti2v_5B_fp16.safetensors", "wan2.2_vae.safetensors", "umt5_xxl_fp8_e4m3fn_scaled.safetensors"]
    assert _names(boot_models(profile, True, ("wan22_5b",))) == base
    # The 14B family alone: its ten files (the shared text encoder once), none of the 5B's own.
    only14 = _names(boot_models(profile, True, (FAMILY,)))
    assert "wan2.2_ti2v_5B_fp16.safetensors" not in only14 and "wan2.2_vae.safetensors" not in only14
    assert set(only14) - set(image_only) == {m["file"] for m in _family(_raw())["models"]}
    both = _names(boot_models(profile, True, ("wan22_5b", FAMILY)))
    assert len(both) == len(set(both)) == 5 + 3 + 10
    # Not included: no video file at all, whatever families are named.
    assert _names(boot_models(profile, False, (FAMILY,))) == image_only


def test_a_boot_requires_the_chosen_families_node_classes(tmp_path):
    profile = load_profile(_write(tmp_path, _pin_family(_raw())), video_enabled=True, video_families=(FAMILY,))
    classes = boot_node_classes(profile, True, (FAMILY,))
    assert "KSamplerAdvanced" in classes and "LoraLoaderModelOnly" in classes and len(set(classes)) == len(classes)
    assert "Wan22ImageToVideoLatent" not in classes  # the 5B family's own latent node
    assert "KSamplerAdvanced" not in boot_node_classes(profile, True)
    assert boot_node_classes(profile, False, (FAMILY,)) == profile.provides_node_classes


def test_a_boot_family_that_is_not_on_is_refused(tmp_path):
    profile = load_profile(_write(tmp_path, _pin_family(_raw())), video_enabled=True)
    for fn in (boot_models, boot_node_classes):
        with pytest.raises(ProfileError, match="VIDEO_BOOT_FAMILIES names a video family that is not on: wan22_a14b"):
            fn(profile, True, (FAMILY,))


def test_family_model_specs(tmp_path):
    profile = load_profile(_write(tmp_path, _pin_family(_raw())), video_enabled=True, video_families=(FAMILY,))
    assert len(family_model_specs(profile, FAMILY)) == 11
    assert _names(family_model_specs(profile, "wan22_5b")) == ["wan2.2_ti2v_5B_fp16.safetensors", "wan2.2_vae.safetensors",
                                                              "umt5_xxl_fp8_e4m3fn_scaled.safetensors"]
    with pytest.raises(ProfileError):
        family_model_specs(profile, "nope")


@pytest.mark.parametrize("change, message", [
    (lambda f, r: f.update(enabled=True), "list the id in VIDEO_FAMILIES"),
    (lambda f, r: f.update(id="Bad"), "id"),
    (lambda f, r: f.update(id="wan22_5b"), "unique"),
    (lambda f, r: f.update(models=[]), "models must be a non-empty list"),
    (lambda f, r: f.update(models=[{"file": "a/b.safetensors", "dest": "models/vae/"}]), "plain file name"),
    (lambda f, r: f.update(node_classes=["a b"]), "invalid node class name"),
    (lambda f, r: f.pop("text"), "text"),
    (lambda f, r: f["image"].update(workflow="../x.json"), "workflow"),
    (lambda f, r: r.update(workflows=[w for w in r["workflows"] if w != f["text"]["workflow"]]), "is not listed in workflows"),
    (lambda f, r: f["text"]["experts"].pop(), "experts"),
    (lambda f, r: f["text"]["experts"][0].update(file="wan_2.1_vae.safetensors"), "diffusion"),
    (lambda f, r: f["text"]["experts"][0].update(file="other.safetensors"), "family's models"),
    (lambda f, r: f["text"]["experts"][1].update(slot="high"), "unique"),
    (lambda f, r: f.update(extra_loras="x"), "extra_loras must be a list"),
    (lambda f, r: f["extra_loras"][0].update(id="Bad"), "id"),
    (lambda f, r: f["extra_loras"].append(dict(f["extra_loras"][0])), "unique"),
    (lambda f, r: f["extra_loras"][0].pop("high"), "needs a high or a low file"),
    (lambda f, r: f["extra_loras"][0].update(high={"file": "other.safetensors"}), "one of the family's models"),
    (lambda f, r: f["extra_loras"][0].update(low={"file": "wan_2.1_vae.safetensors"}), "must be a LoRA"),
])
def test_a_malformed_family_fails_the_profile_even_while_off(tmp_path, change, message):
    raw = _raw()
    change(_family(raw), raw)
    for enabled in (False, True):
        with pytest.raises(ProfileError, match=message):
            load_profile(_write(tmp_path, raw), video_enabled=enabled)


def test_the_base_section_id_and_title_are_optional(tmp_path):
    raw = _raw()
    del raw["video"]["id"], raw["video"]["title"]
    assert load_profile(_write(tmp_path, raw), video_enabled=True).video_base_id == "standard"
    raw["video"]["id"] = "Not Ok"
    with pytest.raises(ProfileError, match="id"):
        load_profile(_write(tmp_path, raw), video_enabled=True)
