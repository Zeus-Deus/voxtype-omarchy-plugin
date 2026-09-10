"""Tests for bridge.py — the JSON-over-stdio bridge to voxtype_tui.

Everything runs against temporary config/sidecar/models/HOME/runtime
directories selected through the environment overrides documented in
docs/DESIGN.md. Fake ``voxtype``, ``systemctl`` and ``pactl`` executables
are placed first on PATH so no test ever touches the real daemon, the
real ``~/.config/voxtype`` or the network.

Run:  /usr/bin/python3 -m pytest -q tests/test_bridge.py
"""
from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
BRIDGE = REPO / "bridge.py"
sys.path.insert(0, str(REPO))

import bridge  # noqa: E402

pytest.importorskip("voxtype_tui")

# Deliberately keeps comments so tests can prove comment preservation.
BASE_CONFIG = '''# Voxtype Configuration (test fixture)
state_file = "auto"

[hotkey]
# Hotkey is configured in Hyprland
enabled = false

[audio]
device = "default"
sample_rate = 16000
max_duration_secs = 60

[whisper]
# Model to use for transcription
model = "base.en"
language = "en"

[output]
mode = "type"
fallback_to_clipboard = true
type_delay_ms = 1
'''

FAKE_VOXTYPE = r'''#!/usr/bin/python3
import os, sys, time
from pathlib import Path

GPU_STATUS = """=== Voxtype Backend Status ===

Next launch: GPU (Vulkan) (no daemon running)
  Binary: /usr/lib/voxtype/voxtype-vulkan

Available backends:
  CPU (AVX2) - installed
  GPU (Vulkan) - active

GPUs detected:
  1. [NVIDIA] NVIDIA Corporation GA102 [GeForce RTX 3090] (rev a1)
  2. [AMD] Advanced Micro Devices, Inc. [AMD/ATI] Raphael (rev c6)

GPU selection: auto (first available)
"""

MODEL_LIST = """Voxtype Model Selection

--- Whisper (OpenAI, 99+ languages) ---

  [ 1] tiny             (  75 MB) multi - Fastest
 *[ 4] base.en          ( 142 MB) en - Good balance (default)

--- Parakeet (NVIDIA FastConformer, English) ---

  (not available - rebuild with --features parakeet)

--- Moonshine (Moonshine AI) ---

  (not available - rebuild with --features moonshine)
"""

log = os.environ.get("FAKE_VOXTYPE_LOG")
if log:
    with open(log, "a") as f:
        f.write(" ".join(sys.argv[1:]) + "\n")
a = sys.argv[1:]

if a[:1] == ["-c"] and a[2:3] == ["config"]:
    text = Path(a[1]).read_text()
    if "REJECTME" in text:
        print("Error: Configuration error: Invalid config: rejected by fake", file=sys.stderr)
        sys.exit(1)
    print("[engine]\nengine = \"whisper\"")
    sys.exit(0)

if a[:1] == ["setup"]:
    if a[1:2] == ["gpu"]:
        sys.stdout.write(GPU_STATUS)
        sys.exit(0)
    if a[1:2] == ["model"]:
        sys.stdout.write(MODEL_LIST)
        sys.exit(0)
    if a[1:2] == ["--download"]:
        name = a[a.index("--model") + 1]
        models = Path(os.environ["VOXTYPE_MODELS_DIR"])
        models.mkdir(parents=True, exist_ok=True)
        target = models / f"ggml-{name}.bin"
        sys.stdout.write(f"Downloading whisper model '{name}'...\n")
        sys.stdout.flush()
        if name == "broken":
            sys.stdout.write("curl: (22) The requested URL returned error: 404\n")
            sys.stdout.flush()
            sys.exit(1)
        for pct in ("12.5", "50.0", "87.5"):
            sys.stdout.write(f"\r  {pct}%   1.2M/s")
            sys.stdout.flush()
            time.sleep(0.02)
        if name == "slow":
            target.write_bytes(b"partial")
            sys.stdout.write("\nstill downloading\n")
            sys.stdout.flush()
            time.sleep(30)
            sys.exit(0)
        sys.stdout.write("\r  100.0%   1.2M/s\n")
        target.write_bytes(b"x" * 1024)
        sys.stdout.write(f"Model downloaded to {target}\n")
        sys.exit(0)

if a[:2] == ["record", "toggle"]:
    print("Recording started")
    sys.exit(0)

print(f"fake voxtype: unsupported args {a}", file=sys.stderr)
sys.exit(2)
'''

FAKE_SYSTEMCTL = r'''#!/usr/bin/python3
import json, os, sys, time
from pathlib import Path

state_dir = Path(os.environ["FAKE_SYSTEMCTL_DIR"])
state_path = state_dir / "unit.json"
log = os.environ.get("FAKE_SYSTEMCTL_LOG")
if log:
    with open(log, "a") as f:
        f.write(" ".join(sys.argv[1:]) + "\n")

def load():
    if state_path.exists():
        return json.loads(state_path.read_text())
    return {"active": False, "pid": 0, "mono": 0}

def save(st):
    state_path.write_text(json.dumps(st))

def daemon_state_file():
    return Path(os.environ["XDG_RUNTIME_DIR"]) / "voxtype" / "state"

def start(st):
    st["active"] = True
    st["pid"] = (st.get("pid") or 4000) + 1
    st["mono"] = time.monotonic_ns() // 1000
    p = daemon_state_file()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("idle")

a = sys.argv[1:]
if a[:1] != ["--user"]:
    sys.exit(1)
verb = a[1]
st = load()
if verb == "show":
    active = "active" if st["active"] else "inactive"
    lines = []
    for prop in a[a.index("-p") + 1::2] if "-p" in a else []:
        pass
    props = [a[i + 1] for i, x in enumerate(a) if x == "-p"]
    for prop in props:
        if prop == "MainPID":
            lines.append(f"MainPID={st['pid'] if st['active'] else 0}")
        elif prop == "ActiveState":
            lines.append(f"ActiveState={active}")
        elif prop == "ExecMainStartTimestamp":
            lines.append("ExecMainStartTimestamp=" + (
                time.strftime("%a %Y-%m-%d %H:%M:%S %Z") if st["active"] else ""))
        elif prop == "ExecMainStartTimestampMonotonic":
            lines.append(f"ExecMainStartTimestampMonotonic={st['mono'] if st['active'] else 0}")
    print("\n".join(lines))
    sys.exit(0)
if verb == "restart":
    if os.environ.get("FAKE_SYSTEMCTL_NOOP_RESTART") != "1":
        start(st)
    save(st)
    sys.exit(0)
if verb == "start":
    if not st["active"]:
        start(st)
    save(st)
    sys.exit(0)
if verb == "stop":
    st["active"] = False
    st["pid"] = 0
    save(st)
    p = daemon_state_file()
    if p.exists():
        p.unlink()
    sys.exit(0)
if verb == "is-active":
    print("active" if st["active"] else "inactive")
    sys.exit(0 if st["active"] else 3)
if verb == "daemon-reload":
    sys.exit(0)
sys.exit(1)
'''

FAKE_PACTL = r'''#!/usr/bin/python3
import sys
if sys.argv[1:] == ["list", "sources", "short"]:
    print("0\talsa_output.pci-0000_00_1f.3.analog-stereo.monitor\tPipeWire\ts32le 2ch 48000Hz\tRUNNING")
    print("1\talsa_input.usb-Blue_Yeti-00.analog-stereo\tPipeWire\ts32le 2ch 48000Hz\tSUSPENDED")
    sys.exit(0)
sys.exit(1)
'''


class Env:
    """Handle on the isolated environment one test runs in."""

    def __init__(self, root: Path, monkeypatch: pytest.MonkeyPatch):
        self.root = root
        self.monkeypatch = monkeypatch
        self.home = root / "home"
        self.config = root / "cfg" / "config.toml"
        self.sidecar = root / "tui" / "metadata.json"
        self.models_dir = root / "models"
        self.runtime = root / "run"
        self.fakebin = root / "bin"
        self.sync_path = self.home / ".config" / "voxtype-tui" / "sync.json"
        self.dropin = self.home / ".config" / "systemd" / "user" / "voxtype.service.d" / "gpu.conf"
        self.state_file = self.runtime / "voxtype" / "state"
        self.voxtype_log = root / "voxtype.log"
        self.systemctl_log = root / "systemctl.log"
        self.systemctl_dir = root / "systemctl"

    # --- request helpers -------------------------------------------------

    def call(self, op: str, **args):
        return bridge.handle({"op": op, **args})

    def ok(self, op: str, **args):
        res = self.call(op, **args)
        assert res.get("ok") is True, res
        return res

    def fail(self, op: str, **args):
        res = self.call(op, **args)
        assert res.get("ok") is False, res
        assert isinstance(res.get("error"), str) and res["error"]
        assert "Traceback" not in res["error"]
        return res

    # --- fixtures on disk ------------------------------------------------

    def write_config(self, text: str = BASE_CONFIG) -> None:
        self.config.parent.mkdir(parents=True, exist_ok=True)
        self.config.write_text(text)

    def read_config(self) -> str:
        return self.config.read_text()

    def config_dict(self) -> dict:
        import tomllib

        return tomllib.loads(self.read_config())

    def sidecar_dict(self) -> dict:
        return json.loads(self.sidecar.read_text())

    def add_model(self, engine: str, name: str, size: int = 2048) -> Path:
        from voxtype_tui import models

        p = models.model_file_path(engine, name, models_dir=self.models_dir)
        if engine == "whisper":
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(b"m" * size)
        else:
            p.mkdir(parents=True, exist_ok=True)
            (p / "model.onnx").write_bytes(b"m" * size)
        return p

    def daemon(self, active: bool, state: str | None = "idle") -> None:
        st = {"active": active, "pid": 4242 if active else 0,
              "mono": time.monotonic_ns() // 1000 if active else 0}
        self.systemctl_dir.mkdir(parents=True, exist_ok=True)
        (self.systemctl_dir / "unit.json").write_text(json.dumps(st))
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        if active and state:
            self.state_file.write_text(state)
        elif self.state_file.exists():
            self.state_file.unlink()

    def age_config(self, seconds: float = 120.0) -> None:
        t = time.time() - seconds
        os.utime(self.config, (t, t))

    def remove_fake(self, name: str) -> None:
        """Drop a fake executable AND restrict PATH to the fake bin dir so
        the real one (if installed on this machine) cannot be found."""
        (self.fakebin / name).unlink()
        self.monkeypatch.setenv("PATH", str(self.fakebin))

    def voxtype_calls(self) -> list[str]:
        return self.voxtype_log.read_text().splitlines() if self.voxtype_log.exists() else []

    def systemctl_calls(self) -> list[str]:
        return self.systemctl_log.read_text().splitlines() if self.systemctl_log.exists() else []

    def subprocess_env(self) -> dict[str, str]:
        return dict(os.environ)

    def run_cli(self, request, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(BRIDGE), *args],
            input=json.dumps(request) if request is not None else "",
            capture_output=True, text=True, timeout=60, env=self.subprocess_env(),
        )


def _install(path: Path, body: str) -> None:
    path.write_text(body)
    path.chmod(0o755)


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Env:
    e = Env(tmp_path, monkeypatch)
    for d in (e.home, e.models_dir, e.runtime, e.fakebin, e.systemctl_dir,
              e.home / "Downloads"):
        d.mkdir(parents=True, exist_ok=True)
    _install(e.fakebin / "voxtype", FAKE_VOXTYPE)
    _install(e.fakebin / "systemctl", FAKE_SYSTEMCTL)
    _install(e.fakebin / "pactl", FAKE_PACTL)

    monkeypatch.setenv("HOME", str(e.home))
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(e.runtime))
    monkeypatch.setenv("VOXTYPE_CONFIG", str(e.config))
    monkeypatch.setenv("VOXTYPE_TUI_SIDECAR", str(e.sidecar))
    monkeypatch.setenv("VOXTYPE_MODELS_DIR", str(e.models_dir))
    monkeypatch.setenv("PATH", f"{e.fakebin}{os.pathsep}{os.environ.get('PATH', '')}")
    monkeypatch.setenv("FAKE_VOXTYPE_LOG", str(e.voxtype_log))
    monkeypatch.setenv("FAKE_SYSTEMCTL_LOG", str(e.systemctl_log))
    monkeypatch.setenv("FAKE_SYSTEMCTL_DIR", str(e.systemctl_dir))
    monkeypatch.delenv("FAKE_SYSTEMCTL_NOOP_RESTART", raising=False)

    e.write_config()
    e.add_model("whisper", "base.en")
    e.daemon(active=False)
    return e


# ---------------------------------------------------------------------------
# Sanity: isolation + hygiene
# ---------------------------------------------------------------------------


def test_isolation_paths_are_temporary(env: Env):
    res = env.ok("status")
    assert res["config_path"] == str(env.config)
    assert str(env.root) in res["config_path"]
    assert Path.home() == env.home


def test_source_has_no_home_paths_or_usernames():
    src = BRIDGE.read_text()
    assert "/home/" not in src
    real_user = Path(os.path.expanduser("~")).name
    if real_user and real_user not in ("root", "home"):
        assert real_user not in src
    assert "getuid()" in src and "Path.home()" in src


def test_bridge_imports_only_stdlib_and_voxtype_tui():
    src = BRIDGE.read_text()
    imports = set(re.findall(r"^\s*(?:from|import)\s+([A-Za-z_][\w]*)", src, re.M))
    stdlib = set(sys.stdlib_module_names)
    third_party = {m for m in imports if m not in stdlib and m != "__future__"}
    assert third_party == {"voxtype_tui", "tomlkit"}, third_party


# ---------------------------------------------------------------------------
# Protocol plumbing
# ---------------------------------------------------------------------------


def test_unknown_op(env: Env):
    res = env.fail("nope")
    assert "unknown op" in res["error"]
    assert "status" in res["ops"]


def test_request_must_be_object(env: Env):
    assert bridge.handle([1, 2])["ok"] is False
    assert bridge.handle({"op": 5})["ok"] is False


def test_every_design_op_is_registered():
    design = (REPO / "docs" / "DESIGN.md").read_text()
    table_ops = set(re.findall(r"^\| `([a-z_.]+)` \|", design, re.M))
    table_ops |= set(re.findall(r"`([a-z_]+\.[a-z_]+)` / `([a-z_]+\.[a-z_]+)`", design)[0])
    table_ops.discard("daemon.start / daemon.stop")
    missing = table_ops - set(bridge.OPS)
    assert not missing, missing


def test_cli_invalid_json_exits_zero_with_error(env: Env):
    r = subprocess.run([sys.executable, str(BRIDGE)], input="{not json",
                       capture_output=True, text=True, env=env.subprocess_env())
    assert r.returncode == 0
    out = json.loads(r.stdout)
    assert out["ok"] is False and "invalid JSON" in out["error"]


def test_cli_empty_request(env: Env):
    r = env.run_cli(None)
    assert r.returncode == 0
    out = json.loads(r.stdout)
    assert out["ok"] is False and out["error"] == "empty request"


@pytest.mark.parametrize("raw", ["null", "true", "1", '"x"', "[]", "[1, 2]"])
def test_cli_non_object_json_is_clean_error(env: Env, raw: str):
    r = subprocess.run([sys.executable, str(BRIDGE)], input=raw,
                       capture_output=True, text=True, env=env.subprocess_env())
    assert r.returncode == 0, r.stderr
    assert "Traceback" not in r.stderr
    out = json.loads(r.stdout)
    assert isinstance(out, dict)
    assert out["ok"] is False and "JSON object" in out["error"]


def test_cli_roundtrip_write_op(env: Env):
    r = env.run_cli({"op": "vocab.add", "phrase": "Omarchy"})
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout)
    assert out["ok"] is True
    assert [v["phrase"] for v in out["snapshot"]["vocabulary"]] == ["Omarchy"]
    assert 'initial_prompt = "Omarchy"' in env.read_config()


def test_cli_exit_3_when_voxtype_tui_missing(env: Env):
    # -S drops site-packages, so voxtype_tui is unimportable while the
    # stdlib still is: exactly the "package missing" failure mode.
    r = subprocess.run([sys.executable, "-S", str(BRIDGE)], input='{"op":"status"}',
                       capture_output=True, text=True, env=env.subprocess_env())
    assert r.returncode == 3
    assert json.loads(r.stdout) == {"ok": False, "error": "voxtype-tui-missing"}


def test_cli_response_never_contains_traceback(env: Env, monkeypatch):
    def boom(args, paths):
        raise RuntimeError("kaboom")

    monkeypatch.setitem(bridge.OPS, "load", boom)
    res = env.fail("load")
    assert res["error"] == "RuntimeError: kaboom"


# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------


def test_status_stopped_daemon(env: Env):
    res = env.ok("status")
    assert res["voxtype_installed"] is True
    assert res["tui_version"]
    assert res["daemon"]["active"] is False
    assert res["daemon"]["state"] == "stopped"
    assert res["daemon"]["main_pid"] is None
    assert res["daemon"]["stale"] is False
    assert res["engine"] == "whisper"
    assert res["model"] == {"name": "base.en", "path": str(env.models_dir / "ggml-base.en.bin"), "present": True}
    assert res["hotkey"] == {"key": None, "modifiers": [], "mode": "push_to_talk", "enabled": False}
    assert res["output_mode"] == "type"


ENGINES = ("whisper", "moonshine", "sensevoice", "paraformer", "dolphin", "omnilingual", "parakeet")


def _engine_config(engine: str, name: str) -> str:
    if engine == "whisper":
        return BASE_CONFIG.replace('model = "base.en"', f'model = "{name}"')
    return f'engine = "{engine}"\n[{engine}]\nmodel = "{name}"\n' + BASE_CONFIG


def test_status_engine_list_matches_tui():
    from voxtype_tui import settings

    assert set(ENGINES) == set(settings.ENGINES)
    assert set(bridge._MODEL_PATH_TEMPLATES) == set(settings.ENGINES)


@pytest.mark.parametrize("engine", ENGINES)
def test_status_model_path_matches_tui(env: Env, engine: str):
    from voxtype_tui import models

    assert bridge._model_file_path(engine, "some-name", env.models_dir) == \
        models.model_file_path(engine, "some-name", models_dir=env.models_dir)


@pytest.mark.parametrize("engine", ENGINES)
def test_status_is_fast_and_never_runs_voxtype_setup(env: Env, engine: str):
    env.add_model(engine, "m1")
    env.write_config(_engine_config(engine, "m1"))
    env.daemon(active=True)
    t = time.monotonic()
    res = env.ok("status")
    elapsed = time.monotonic() - t
    assert elapsed < 0.15, elapsed
    assert res["engine"] == engine and res["model"]["present"] is True
    assert env.voxtype_calls() == []
    assert env.systemctl_calls() == ["--user show voxtype -p MainPID -p ActiveState -p ExecMainStartTimestamp -p ExecMainStartTimestampMonotonic"]


@pytest.mark.parametrize("engine", ENGINES)
def test_status_does_not_import_textual(env: Env, engine: str):
    env.add_model(engine, "m1")
    env.write_config(_engine_config(engine, "m1"))
    code = (
        "import sys; sys.path.insert(0, %r); import bridge; "
        "r = bridge.handle({'op': 'status'}); "
        "print(r['ok'], r['engine'], r['model']['present'], "
        "'textual' in sys.modules, 'voxtype_tui.models' in sys.modules)"
        % str(REPO)
    )
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True,
                       env=env.subprocess_env())
    assert r.stdout.strip() == f"True {engine} True False False", r.stderr


@pytest.mark.parametrize("word", ["idle", "recording", "transcribing"])
def test_status_reports_daemon_state_word(env: Env, word: str):
    env.daemon(active=True, state=word)
    env.age_config()
    res = env.ok("status")
    assert res["daemon"]["active"] is True
    assert res["daemon"]["state"] == word
    assert res["daemon"]["main_pid"] == 4242
    assert res["daemon"]["started_at"]
    assert res["daemon"]["stale"] is False


def test_status_stale_when_config_newer_than_daemon_start(env: Env):
    env.daemon(active=True)
    env.age_config()
    assert env.ok("status")["daemon"]["stale"] is False
    time.sleep(0.01)
    env.write_config(BASE_CONFIG + "\n# edited\n")
    assert env.ok("status")["daemon"]["stale"] is True


def test_status_stale_when_gpu_dropin_newer_than_daemon_start(env: Env):
    env.daemon(active=True)
    env.age_config()
    env.ok("gpu.set_device", vendor="nvidia")
    assert env.ok("status")["daemon"]["stale"] is True


def test_status_active_without_state_file_is_idle_not_ready(env: Env):
    env.daemon(active=True, state=None)
    res = env.ok("status")
    assert res["daemon"]["state"] == "idle"
    assert res["daemon"]["ready"] is False


def test_status_model_missing(env: Env):
    env.write_config(BASE_CONFIG.replace('model = "base.en"', 'model = "large-v3"'))
    res = env.ok("status")
    assert res["model"]["name"] == "large-v3"
    assert res["model"]["present"] is False


def test_status_custom_model_path(env: Env):
    custom = env.root / "custom.bin"
    custom.write_bytes(b"x")
    env.write_config(BASE_CONFIG.replace('model = "base.en"', f'model = "{custom}"'))
    res = env.ok("status")
    assert res["model"]["path"] == str(custom)
    assert res["model"]["present"] is True


def test_status_non_whisper_engine(env: Env):
    env.add_model("parakeet", "parakeet-tdt-0.6b-v3")
    env.write_config('engine = "parakeet"\n[parakeet]\nmodel = "parakeet-tdt-0.6b-v3"\n' + BASE_CONFIG)
    res = env.ok("status")
    assert res["engine"] == "parakeet"
    assert res["model"]["name"] == "parakeet-tdt-0.6b-v3"
    assert res["model"]["present"] is True


def test_status_voxtype_binary_missing(env: Env):
    env.remove_fake("voxtype")
    res = env.ok("status")
    assert res["voxtype_installed"] is False


def test_status_without_config_file(env: Env):
    env.config.unlink()
    res = env.ok("status")
    assert res["config_exists"] is False
    assert res["model"]["name"] is None
    assert res["engine"] == "whisper"


def test_status_corrupt_config_warns(env: Env):
    env.write_config("this is not = [ toml")
    res = env.ok("status")
    assert res["warnings"] and "could not be parsed" in res["warnings"][0]


def test_status_state_file_disabled(env: Env):
    env.daemon(active=True, state="recording")
    env.write_config(BASE_CONFIG.replace('state_file = "auto"', 'state_file = "disabled"'))
    res = env.ok("status")
    assert res["daemon"]["state"] == "idle"
    assert res["daemon"]["ready"] is False


def test_status_custom_state_file_path(env: Env):
    custom = env.root / "custom-state"
    custom.write_text("transcribing")
    env.daemon(active=True, state="idle")
    env.write_config(BASE_CONFIG.replace('state_file = "auto"', f'state_file = "{custom}"'))
    assert env.ok("status")["daemon"]["state"] == "transcribing"


def test_status_without_systemctl(env: Env):
    env.remove_fake("systemctl")
    res = env.ok("status")
    assert res["daemon"]["systemctl_available"] is False
    assert res["daemon"]["state"] == "stopped"


# ---------------------------------------------------------------------------
# load / options / models.list / gpu.status / dictionary.preview
# ---------------------------------------------------------------------------


def test_load_snapshot_shape(env: Env):
    snap = env.ok("load")["snapshot"]
    assert snap["vocabulary"] == []
    assert snap["vocab_tokens"] == 0
    assert snap["vocab_token_limit"] == 224
    assert snap["replacements"] == []
    assert snap["categories"] == ["Replacement", "Capitalization"]
    assert snap["settings"]["whisper.model"] == "base.en"
    assert snap["settings"]["hotkey.enabled"] is False
    assert snap["settings"]["audio.max_duration_secs"] == 60
    assert snap["settings"]["output.fallback_to_clipboard"] is True
    assert snap["settings"]["whisper.remote_api_key_set"] is False
    assert "whisper.remote_api_key" not in snap["settings"]
    assert "hotkey.key" not in snap["settings"]  # absent keys are omitted
    assert "whisper.initial_prompt" in snap["restart_sensitive"]
    assert snap["warnings"] == []
    assert snap["migrations_applied"] == []
    assert snap["sync"] == {"applied_from": None, "conflicts": [], "missing_model": None}


def test_load_never_returns_api_key(env: Env):
    env.write_config(BASE_CONFIG.replace('language = "en"', 'language = "en"\nremote_api_key = "sk-SECRET"'))
    res = env.ok("load")
    assert "sk-SECRET" not in json.dumps(res)
    assert res["snapshot"]["settings"]["whisper.remote_api_key_set"] is True


def test_load_reconciles_hand_edited_vocabulary(env: Env):
    env.write_config(BASE_CONFIG.replace('language = "en"', 'language = "en"\ninitial_prompt = "Hyprland, Omarchy"'))
    snap = env.ok("load")["snapshot"]
    assert [v["phrase"] for v in snap["vocabulary"]] == ["Hyprland", "Omarchy"]
    assert snap["vocab_tokens"] > 0
    assert snap["warnings"] and "diverged" in snap["warnings"][0]


def test_load_reports_sync_conflicts(env: Env):
    env.sync_path.parent.mkdir(parents=True, exist_ok=True)
    (env.sync_path.parent / "sync.sync-conflict-20260101-000000-ABCDEF.json").write_text("{}")
    snap = env.ok("load")["snapshot"]
    assert len(snap["sync"]["conflicts"]) == 1


def test_load_missing_config_is_clean_error(env: Env):
    env.config.unlink()
    res = env.fail("load")
    assert "not found" in res["error"]


def test_options(env: Env):
    res = env.ok("options")
    assert res["engines"][0] == "whisper"
    assert res["compiled_engines"] == ["whisper"]
    assert "large-v3" in res["models_per_engine"]["whisper"]
    assert res["model_paths"]["parakeet"] == "parakeet.model"
    assert res["hotkey_modifiers"] == ["LEFTCTRL", "LEFTALT", "LEFTSHIFT", "LEFTMETA"]
    assert res["hotkey_modes"] == ["push_to_talk", "toggle"]
    assert res["output_modes"] == ["type", "clipboard", "paste"]
    assert res["audio_devices"][0] == {"label": "default", "name": "default"}
    assert res["audio_devices"][1]["name"] == "alsa_input.usb-Blue_Yeti-00.analog-stereo"
    assert res["feedback_themes"] == ["default", "subtle", "mechanical"]
    assert res["gpu_vendors"][0]["value"] == "auto"
    assert any("setup model" in c for c in env.voxtype_calls())


def test_models_list(env: Env):
    env.add_model("whisper", "tiny", size=100)
    (env.models_dir / "ggml-mystery.bin").write_bytes(b"?" * 10)
    res = env.ok("models.list", engine="whisper")
    assert res["engine"] == "whisper" and res["active"] == "base.en"
    rows = {m["name"]: m for m in res["models"]}
    assert rows["base.en"]["downloaded"] and rows["base.en"]["active"]
    assert rows["base.en"]["on_disk_bytes"] == 2048
    assert rows["tiny"]["on_disk_bytes"] == 100 and rows["tiny"]["unknown"] is False
    assert rows["large-v3"]["downloaded"] is False and rows["large-v3"]["on_disk_bytes"] is None
    assert rows["large-v3"]["size_mb"] == 3100
    assert rows["mystery"]["unknown"] is True and rows["mystery"]["downloaded"] is True
    assert rows["tiny"]["path"] == str(env.models_dir / "ggml-tiny.bin")


def test_models_list_unknown_engine(env: Env):
    env.fail("models.list", engine="cohere")
    env.fail("models.list")


def test_gpu_status(env: Env):
    res = env.ok("gpu.status")
    assert res["backend"] == "GPU (Vulkan)"
    assert res["gpus"] == [
        {"vendor": "nvidia", "label": "NVIDIA — GA102 [GeForce RTX 3090]"},
        {"vendor": "amd", "label": "AMD — [AMD/ATI] Raphael"},
    ]
    assert res["device"] == "auto"
    assert res["dropin_path"] == str(env.dropin)
    assert "GPUs detected" in res["text"]


def test_gpu_status_without_binary(env: Env):
    env.remove_fake("voxtype")
    res = env.fail("gpu.status")
    assert res["device"] == "auto"


def test_dictionary_preview(env: Env):
    env.ok("dict.upsert", **{"from": "slash codemux release", "to": "/codemux-release", "category": "Replacement"})
    env.ok("dict.upsert", **{"from": "hyprland", "to": "Hyprland", "category": "Capitalization"})
    res = env.ok("dictionary.preview", text="run /codemux release on hyprland now")
    assert res["output"] == "run /codemux-release on Hyprland now"
    assert res["rules"] == 2
    assert env.ok("dictionary.preview", text="")["output"] == ""


# ---------------------------------------------------------------------------
# vocabulary
# ---------------------------------------------------------------------------


def test_vocab_add_writes_config_sidecar_and_sync(env: Env):
    res = env.ok("vocab.add", phrase="  Omarchy ")
    assert res["restart_needed"] == ["whisper.initial_prompt"]
    assert res["daemon_stale"] is True
    assert res["snapshot"]["vocabulary"][0]["phrase"] == "Omarchy"
    assert res["snapshot"]["vocabulary"][0]["added_at"]
    assert env.config_dict()["whisper"]["initial_prompt"] == "Omarchy"
    assert "# Model to use for transcription" in env.read_config()  # comments preserved
    assert env.sidecar_dict()["vocabulary"][0]["phrase"] == "Omarchy"
    bundle = json.loads(env.sync_path.read_text())
    assert bundle["sync"]["vocabulary"][0]["phrase"] == "Omarchy"
    assert "secrets" not in bundle
    assert env.config.with_name("config.toml.voxtype-tui-bak").exists()
    assert any(c.startswith("-c ") and c.endswith(" config") for c in env.voxtype_calls())


def test_vocab_add_rejects_empty_and_duplicate(env: Env):
    env.fail("vocab.add", phrase="   ")
    env.fail("vocab.add")
    env.ok("vocab.add", phrase="Omarchy")
    res = env.fail("vocab.add", phrase="Omarchy")
    assert "already" in res["error"]


def test_vocab_remove(env: Env):
    env.ok("vocab.add", phrase="A")
    env.ok("vocab.add", phrase="B")
    res = env.ok("vocab.remove", phrase="A")
    assert [v["phrase"] for v in res["snapshot"]["vocabulary"]] == ["B"]
    assert env.config_dict()["whisper"]["initial_prompt"] == "B"
    env.fail("vocab.remove", phrase="A")
    env.ok("vocab.remove", phrase="B")
    assert "initial_prompt" not in env.config_dict()["whisper"]


def test_vocab_set_reorders_dedupes_and_keeps_added_at(env: Env):
    env.ok("vocab.add", phrase="A")
    added = env.ok("load")["snapshot"]["vocabulary"][0]["added_at"]
    res = env.ok("vocab.set", phrases=["C", " B ", "A", "B", ""])
    assert [v["phrase"] for v in res["snapshot"]["vocabulary"]] == ["C", "B", "A"]
    assert res["snapshot"]["vocabulary"][2]["added_at"] == added
    assert env.config_dict()["whisper"]["initial_prompt"] == "C, B, A"
    env.fail("vocab.set", phrases="C")
    env.fail("vocab.set", phrases=[1])


# ---------------------------------------------------------------------------
# dictionary
# ---------------------------------------------------------------------------


def test_dict_upsert_wires_post_process(env: Env):
    res = env.ok("dict.upsert", **{"from": "vox type", "to": "Voxtype"})
    assert res["snapshot"]["replacements"] == [
        {"from": "vox type", "to": "Voxtype", "category": "Replacement"}
    ]
    assert "text.replacements" in res["restart_needed"]
    cfg = env.config_dict()
    assert cfg["text"]["replacements"] == {"vox type": "Voxtype"}
    assert cfg["output"]["post_process"]["command"] == "voxtype-tui-postprocess"
    res = env.ok("dict.upsert", **{"from": "vox type", "to": "Voxtype!", "category": "Capitalization"})
    assert res["snapshot"]["replacements"][0]["category"] == "Capitalization"
    assert res["snapshot"]["replacements"][0]["to"] == "Voxtype!"
    env.fail("dict.upsert", **{"from": "", "to": "x"})
    env.fail("dict.upsert", **{"from": "a", "to": "b", "category": "Command"})


def test_dict_remove(env: Env):
    env.ok("dict.upsert", **{"from": "a", "to": "b"})
    res = env.ok("dict.remove", **{"from": "a"})
    assert res["snapshot"]["replacements"] == []
    assert "replacements" not in env.config_dict().get("text", {})
    assert env.sidecar_dict()["replacements"] == []
    env.fail("dict.remove", **{"from": "a"})


def test_dict_set_category_is_sidecar_only(env: Env):
    env.ok("dict.upsert", **{"from": "a", "to": "b"})
    before = env.config.stat().st_mtime_ns
    res = env.ok("dict.set_category", **{"from": "a", "category": "Capitalization"})
    assert res["changed"] is True
    assert res["restart_needed"] == []
    assert res["daemon_stale"] is False
    assert res["snapshot"]["replacements"][0]["category"] == "Capitalization"
    assert env.config.stat().st_mtime_ns == before
    assert env.sidecar_dict()["replacements"][0]["category"] == "Capitalization"
    assert env.ok("dict.set_category", **{"from": "a", "category": "Capitalization"})["changed"] is False
    env.fail("dict.set_category", **{"from": "zzz", "category": "Replacement"})
    env.fail("dict.set_category", **{"from": "a", "category": "Nope"})


# ---------------------------------------------------------------------------
# settings
# ---------------------------------------------------------------------------


def test_settings_allow_list_matches_tui():
    from voxtype_tui import settings

    src = Path(settings.__file__).read_text()
    used = set(re.findall(r"set_setting\(\s*\"([a-z_.]+)\"", src))
    used |= set(re.findall(r"unset_setting\(\s*\"([a-z_.]+)\"", src))
    used |= set(settings.MODEL_PATH_PER_ENGINE.values())
    assert used == set(bridge.SETTING_TYPES), used ^ set(bridge.SETTING_TYPES)


@pytest.mark.parametrize("path,value,expected", [
    ("hotkey.enabled", True, True),
    ("hotkey.enabled", "false", False),
    ("audio.max_duration_secs", 90, 90),
    ("audio.max_duration_secs", "45", 45),
    ("audio.max_duration_secs", 30.0, 30),
    ("audio.feedback.volume", 0.5, 0.5),
    ("audio.feedback.volume", 1, 1.0),
    ("vad.threshold", "0.25", 0.25),
    ("hotkey.modifiers", ["LEFTCTRL", "LEFTMETA"], ["LEFTCTRL", "LEFTMETA"]),
    ("hotkey.key", "F13", "F13"),
    ("output.mode", "clipboard", "clipboard"),
    ("output.type_delay_ms", 0, 0),
    ("output.post_process.command", "cat", "cat"),
    ("whisper.remote_timeout_secs", 15, 15),
    ("text.spoken_punctuation", True, True),
])
def test_settings_set_coerces_to_toml_types(env: Env, path, value, expected):
    res = env.ok("settings.set", path=path, value=value)
    assert res["snapshot"]["settings"][path] == expected
    node = env.config_dict()
    for part in path.split("."):
        node = node[part]
    assert node == expected and type(node) is type(expected)


@pytest.mark.parametrize("path,value", [
    ("hotkey.enabled", "yes"),
    ("hotkey.enabled", 1),
    ("audio.max_duration_secs", "ten"),
    ("audio.max_duration_secs", 2.5),
    ("audio.max_duration_secs", 0),
    ("audio.max_duration_secs", True),
    ("audio.feedback.volume", 1.5),
    ("audio.feedback.volume", "loud"),
    ("vad.threshold", -0.1),
    ("hotkey.modifiers", "LEFTCTRL"),
    ("hotkey.modifiers", ["RIGHTCTRL"]),
    ("hotkey.mode", "hold"),
    ("output.mode", "speak"),
    ("output.type_delay_ms", -1),
    ("hotkey.key", ["F13"]),
    ("engine", "bogus"),
])
def test_settings_set_rejects_bad_values(env: Env, path, value):
    before = env.read_config()
    env.fail("settings.set", path=path, value=value)
    assert env.read_config() == before


def test_settings_set_unknown_path_rejected(env: Env):
    res = env.fail("settings.set", path="output.pre_output_command", value="rm -rf /")
    assert "not a settable path" in res["error"]
    env.fail("settings.set", path="whisper.model")
    env.fail("settings.unset", path="state_file")


def test_settings_set_engine_ensures_required_sections(env: Env):
    env.write_config('state_file = "auto"\n\n[whisper]\nmodel = "base.en"\n')
    res = env.ok("settings.set", path="engine", value="whisper")
    assert res["snapshot"]["settings"]["engine"] == "whisper"
    cfg = env.config_dict()
    for section in ("hotkey", "audio", "whisper", "output"):
        assert section in cfg
    assert "engine" in res["restart_needed"]


def test_settings_set_model_requires_download(env: Env):
    res = env.fail("settings.set", path="whisper.model", value="large-v3")
    assert "download" in res["error"]
    env.add_model("whisper", "large-v3")
    res = env.ok("settings.set", path="whisper.model", value="large-v3")
    assert res["restart_needed"] == ["whisper.model"]
    assert env.config_dict()["whisper"]["model"] == "large-v3"


def test_settings_set_model_custom_path(env: Env):
    custom = env.root / "custom.bin"
    env.fail("settings.set", path="whisper.model", value=str(custom))
    custom.write_bytes(b"x")
    env.ok("settings.set", path="whisper.model", value=str(custom))


def test_settings_set_api_key_round_trip_never_returns_it(env: Env):
    res = env.ok("settings.set", path="whisper.remote_api_key", value="sk-SECRET")
    assert "sk-SECRET" not in json.dumps(res)
    assert res["snapshot"]["settings"]["whisper.remote_api_key_set"] is True
    assert env.config_dict()["whisper"]["remote_api_key"] == "sk-SECRET"
    res = env.ok("settings.unset", path="whisper.remote_api_key")
    assert res["changed"] is True
    assert res["snapshot"]["settings"]["whisper.remote_api_key_set"] is False
    assert "remote_api_key" not in env.config_dict()["whisper"]


def test_settings_set_empty_string_unsets(env: Env):
    res = env.ok("settings.set", path="whisper.language", value="")
    assert "whisper.language" not in res["snapshot"]["settings"]
    assert "language" not in env.config_dict()["whisper"]


def test_settings_unset(env: Env):
    env.ok("settings.set", path="vad.threshold", value=0.5)
    res = env.ok("settings.unset", path="vad.threshold")
    assert res["changed"] is True and "vad.threshold" in res["restart_needed"]
    assert "vad" not in env.config_dict()  # empty parent table cleaned up
    res = env.ok("settings.unset", path="vad.threshold")
    assert res["changed"] is False and res["restart_needed"] == []


def test_settings_set_is_idempotent(env: Env):
    res = env.ok("settings.set", path="output.mode", value="type")
    assert res["restart_needed"] == []
    assert res["daemon_stale"] is False


def test_settings_set_rejected_by_voxtype_validator_leaves_config_untouched(env: Env):
    before = env.read_config()
    res = env.fail("settings.set", path="hotkey.key", value="REJECTME")
    assert "rejected" in res["error"]
    assert env.read_config() == before
    assert not list(env.config.parent.glob("*.tmp"))


# ---------------------------------------------------------------------------
# models
# ---------------------------------------------------------------------------


def test_models_set_active(env: Env):
    env.fail("models.set_active", engine="whisper", name="tiny")
    env.add_model("whisper", "tiny")
    res = env.ok("models.set_active", engine="whisper", name="tiny")
    assert res["restart_needed"] == ["whisper.model"]
    assert res["snapshot"]["settings"]["whisper.model"] == "tiny"
    assert env.ok("models.list", engine="whisper")["active"] == "tiny"
    env.fail("models.set_active", engine="nope", name="tiny")
    env.fail("models.set_active", engine="whisper", name="../etc")


def test_models_delete(env: Env):
    res = env.fail("models.delete", engine="whisper", name="base.en")
    assert "active" in res["error"]
    env.fail("models.delete", engine="whisper", name="tiny")
    p = env.add_model("whisper", "tiny", size=777)
    res = env.ok("models.delete", engine="whisper", name="tiny")
    assert res["freed_bytes"] == 777 and res["restart_needed"] == []
    assert not p.exists()
    assert env.models_dir.joinpath("ggml-base.en.bin").exists()


def test_models_delete_directory_engine(env: Env):
    p = env.add_model("parakeet", "parakeet-tdt-0.6b-v3")
    env.ok("models.delete", engine="parakeet", name="parakeet-tdt-0.6b-v3")
    assert not p.exists()


# ---------------------------------------------------------------------------
# gpu.set_device
# ---------------------------------------------------------------------------


def test_gpu_set_device_writes_dropin_and_reloads(env: Env):
    res = env.ok("gpu.set_device", vendor="nvidia")
    assert res["restart_needed"] == ["gpu.device"]
    assert res["device"] == "nvidia"
    assert res["daemon_reload"]["ok"] is True
    text = env.dropin.read_text()
    assert 'Environment="VOXTYPE_VULKAN_DEVICE=nvidia"' in text
    assert 'Environment="VK_LOADER_DRIVERS_SELECT=nvidia*"' in text
    assert "--user daemon-reload" in env.systemctl_calls()
    assert env.ok("gpu.status")["device"] == "nvidia"
    assert env.config_dict().get("gpu") is None  # never in config.toml
    res = env.ok("gpu.set_device", vendor="auto")
    assert res["device"] == "auto"
    assert not env.dropin.exists()
    env.fail("gpu.set_device", vendor="apple")


# ---------------------------------------------------------------------------
# export / import
# ---------------------------------------------------------------------------


def _seed(env: Env) -> None:
    env.ok("vocab.add", phrase="Omarchy")
    env.ok("dict.upsert", **{"from": "vox type", "to": "Voxtype"})
    env.ok("settings.set", path="hotkey.key", value="F13")
    env.ok("settings.set", path="whisper.remote_api_key", value="sk-SECRET")


def test_export_preview(env: Env):
    _seed(env)
    res = env.ok("export.preview", scope="sync", include_secrets=False)
    assert res["default_path"] == str(env.home / "Downloads" / f"voxtype-tui-export-{time.strftime('%Y-%m-%d')}.json")
    assert res["counts"]["vocabulary"] == 1
    assert res["counts"]["replacements"] == 1
    assert res["counts"]["settings"] > 0
    assert res["counts"]["local"] == 0
    assert res["counts"]["secrets"] == 0
    assert res["counts"]["secrets_available"] == 2  # api key + post_process command
    res = env.ok("export.preview", scope="sync+local", include_secrets=True)
    assert res["counts"]["local"] > 0 and res["counts"]["secrets"] == 2
    env.fail("export.preview", scope="everything")
    env.fail("export.preview", include_secrets="yes")


def test_export_write_redacts_secrets_by_default(env: Env):
    _seed(env)
    target = env.root / "out" / "bundle.json"
    target.parent.mkdir()
    res = env.ok("export.write", path=str(target), scope="sync")
    assert res["path"] == str(target) and res["bytes"] == target.stat().st_size
    bundle = json.loads(target.read_text())
    assert "sk-SECRET" not in target.read_text()
    assert bundle["secrets"]["whisper"]["remote_api_key"] == ""
    assert bundle["local"] == {}
    assert bundle["sync"]["vocabulary"][0]["phrase"] == "Omarchy"


def test_export_write_with_secrets_and_local(env: Env):
    _seed(env)
    target = env.root / "full.json"
    env.ok("export.write", path=str(target), scope="sync+local", include_secrets=True)
    bundle = json.loads(target.read_text())
    assert bundle["secrets"]["whisper"]["remote_api_key"] == "sk-SECRET"
    assert bundle["local"]["hotkey"]["key"] == "F13"


def test_export_write_default_path_and_bad_parent(env: Env):
    res = env.ok("export.write")
    assert res["path"].startswith(str(env.home / "Downloads"))
    assert Path(res["path"]).exists()
    env.fail("export.write", path=str(env.root / "no" / "such" / "dir" / "x.json"))


def _bundle(env: Env, *, settings: dict | None = None, local: dict | None = None,
            secrets: dict | None = None) -> Path:
    from voxtype_tui import sync

    block = {
        "vocabulary": [{"phrase": "Hyprland", "added_at": "2026-01-01T00:00:00Z", "notes": None}],
        "replacements": [{"from": "hyper land", "to": "Hyprland", "category": "Capitalization", "added_at": "2026-01-01T00:00:00Z"}],
        "settings": settings or {},
    }
    b = sync.build_bundle(sync=block, local=local or {}, secrets=secrets,
                          device_label="other-box", include_secrets=secrets is not None)
    p = env.root / "import.json"
    p.write_text(sync.to_json(b))
    return p


def test_import_preview_diff(env: Env):
    env.ok("vocab.add", phrase="Omarchy")
    p = _bundle(env, settings={"output": {"mode": "clipboard"}, "whisper": {"remote_endpoint": "http://evil:8080"}},
                local={"hotkey": {"key": "F24"}})
    res = env.ok("import.preview", path=str(p))
    assert res["format"] == "voxtype-tui"
    assert res["source"] == "other-box"
    assert res["has_local"] is True and res["include_local"] is False
    d = res["diff"]
    assert d["vocab_add"] == ["Hyprland"] and d["vocab_remove"] == []
    assert d["replacements_add"] == [{"from": "hyper land", "to": "Hyprland"}]
    changes = {c["path"]: c for c in d["settings_change"]}
    assert changes["output.mode"] == {"path": "output.mode", "old": "type", "new": "clipboard", "dangerous": False}
    assert changes["whisper.remote_endpoint"]["dangerous"] is True
    assert res["dangerous"] == ["whisper.remote_endpoint"]
    assert "hotkey.key" not in changes
    res = env.ok("import.preview", path=str(p), include_local=True)
    assert {c["path"] for c in res["diff"]["settings_change"]} >= {"hotkey.key"}


def test_import_preview_filters_uninstalled_model(env: Env):
    p = _bundle(env, settings={"whisper": {"model": "large-v3"}})
    res = env.ok("import.preview", path=str(p))
    assert not any(c["path"] == "whisper.model" for c in res["diff"]["settings_change"])
    assert any("not installed" in w for w in res["warnings"])


def test_import_preview_vexis_dictionary(env: Env):
    p = env.root / "vexis-dictionary.json"
    p.write_text(json.dumps([
        {"id": 1, "trigger": "vox type", "replacement": "Voxtype", "category": "replacement"},
        {"id": 2, "trigger": "slash commit", "replacement": "/commit", "category": "command"},
    ]))
    res = env.ok("import.preview", path=str(p))
    assert res["format"] == "vexis-dictionary"
    assert len(res["diff"]["replacements_add"]) == 2


def test_import_preview_errors(env: Env):
    env.fail("import.preview", path=str(env.root / "missing.json"))
    bad = env.root / "bad.json"
    bad.write_text("{not json")
    env.fail("import.preview", path=str(bad))
    env.fail("import.preview")


def test_import_preview_refuses_oversize_file_without_reading_it(env: Env, monkeypatch):
    from voxtype_tui import sync

    big = env.root / "big.json"
    with big.open("wb") as f:
        f.truncate(5 * 1024 * 1024)
    assert big.stat().st_size > sync.MAX_BUNDLE_BYTES

    def no_read(self, *a, **k):
        raise AssertionError(f"read attempted on {self}")

    monkeypatch.setattr(Path, "read_bytes", no_read)
    monkeypatch.setattr(Path, "read_text", no_read)
    res = env.fail("import.preview", path=str(big))
    assert "limit" in res["error"] and str(sync.MAX_BUNDLE_BYTES) in res["error"]
    res = env.fail("import.apply", path=str(big), accept_dangerous=True)
    assert "limit" in res["error"]


def test_import_apply_refuses_dangerous_unless_accepted(env: Env):
    p = _bundle(env, settings={"whisper": {"remote_endpoint": "http://evil:8080"}})
    before = env.read_config()
    res = env.fail("import.apply", path=str(p))
    assert res["error"] == "dangerous-changes"
    assert res["dangerous"] == ["whisper.remote_endpoint"]
    assert env.read_config() == before
    res = env.ok("import.apply", path=str(p), accept_dangerous=True)
    assert env.config_dict()["whisper"]["remote_endpoint"] == "http://evil:8080"
    assert "whisper.remote_endpoint" in res["restart_needed"]


def test_import_apply_merges(env: Env):
    env.ok("vocab.add", phrase="Omarchy")
    p = _bundle(env, settings={"output": {"mode": "clipboard"}}, local={"hotkey": {"key": "F24"}})
    res = env.ok("import.apply", path=str(p))
    snap = res["snapshot"]
    assert [v["phrase"] for v in snap["vocabulary"]] == ["Omarchy", "Hyprland"]
    assert snap["replacements"] == [{"from": "hyper land", "to": "Hyprland", "category": "Capitalization"}]
    assert snap["settings"]["output.mode"] == "clipboard"
    assert "hotkey.key" not in snap["settings"]
    assert res["applied"]["vocab_add"] == ["Hyprland"]
    cfg = env.config_dict()
    assert cfg["whisper"]["initial_prompt"] == "Omarchy, Hyprland"
    assert cfg["text"]["replacements"] == {"hyper land": "Hyprland"}
    res = env.ok("import.apply", path=str(p), include_local=True)
    assert res["snapshot"]["settings"]["hotkey.key"] == "F24"


def test_import_apply_can_skip_settings(env: Env):
    p = _bundle(env, settings={"output": {"mode": "clipboard"}})
    res = env.ok("import.apply", path=str(p), include_settings=False)
    assert res["snapshot"]["settings"]["output.mode"] == "type"
    assert res["applied"]["settings_change"] == []


def test_redacted_import_paths_match_tui():
    from voxtype_tui import sync

    assert bridge.REDACTED_IMPORT_PATHS == {".".join(p) for p in sync.SECRET_PATHS}


def test_import_preview_and_apply_never_leak_secret_values(env: Env):
    env.ok("settings.set", path="whisper.remote_api_key", value="sk-SECRET123")
    env.ok("settings.set", path="output.post_process.command", value="old-hook --SECRETARG")
    p = _bundle(
        env,
        secrets={
            "whisper": {"remote_api_key": "sk-OTHER456"},
            "output": {
                "post_process": {"command": "new-hook --OTHERARG"},
                "pre_output_command": "pre-hook --OTHERARG",
            },
        },
    )
    key_leaks = ("sk-SECRET123", "sk-OTHER456")
    # The current post_process command is legitimately part of the
    # snapshot (editable Settings field); it must not appear in the diff.
    diff_leaks = key_leaks + ("SECRETARG", "OTHERARG")

    res = env.ok("import.preview", path=str(p))
    raw = json.dumps(res)
    for s in diff_leaks:
        assert s not in raw, s
    rows = {c["path"]: c for c in res["diff"]["settings_change"]}
    assert rows["whisper.remote_api_key"] == {
        "path": "whisper.remote_api_key", "dangerous": True, "redacted": True,
        "old_set": True, "new_set": True,
    }
    assert rows["output.post_process.command"] == {
        "path": "output.post_process.command", "dangerous": True, "redacted": True,
        "old_set": True, "new_set": True,
    }
    assert rows["output.pre_output_command"] == {
        "path": "output.pre_output_command", "dangerous": True, "redacted": True,
        "old_set": False, "new_set": True,
    }
    assert set(res["dangerous"]) == set(rows)

    refused = env.fail("import.apply", path=str(p))
    assert refused["error"] == "dangerous-changes"
    for s in diff_leaks:
        assert s not in json.dumps(refused), s

    applied = env.ok("import.apply", path=str(p), accept_dangerous=True)
    for s in key_leaks:
        assert s not in json.dumps(applied), s
    for s in diff_leaks:
        assert s not in json.dumps(applied["applied"]), s
    assert applied["applied"]["settings_change"] == res["diff"]["settings_change"]
    assert env.config_dict()["whisper"]["remote_api_key"] == "sk-OTHER456"


# ---------------------------------------------------------------------------
# daemon ops
# ---------------------------------------------------------------------------


def test_daemon_restart_proves_pid_change_and_waits_ready(env: Env):
    env.daemon(active=True)
    res = env.ok("daemon.restart")
    assert res["main_pid_before"] == 4242
    assert res["main_pid_after"] == 4243
    assert res["changed"] is True and res["ready"] is True and res["active"] is True
    calls = env.systemctl_calls()
    assert "--user restart voxtype" in calls
    assert calls.count("--user show voxtype -p MainPID -p ActiveState -p ExecMainStartTimestamp -p ExecMainStartTimestampMonotonic") == 2
    assert env.ok("status")["daemon"]["main_pid"] == 4243


def test_daemon_restart_from_stopped(env: Env):
    res = env.ok("daemon.restart")
    assert res["main_pid_before"] is None and res["main_pid_after"] == 4001
    assert res["ready"] is True


def test_daemon_restart_noop_is_not_ok(env: Env, monkeypatch):
    env.daemon(active=True)
    monkeypatch.setenv("FAKE_SYSTEMCTL_NOOP_RESTART", "1")
    res = env.call("daemon.restart")
    assert res["ok"] is False
    assert res["main_pid_before"] == res["main_pid_after"] == 4242
    assert res["changed"] is False and res["ready"] is False
    assert "did not change" in res["message"]


def test_daemon_restart_ready_timeout(env: Env, monkeypatch):
    env.daemon(active=True)
    # A restart that never writes the state file: fake systemctl writes
    # "idle" on restart, so point the daemon's state_file elsewhere.
    env.write_config(BASE_CONFIG.replace('state_file = "auto"', f'state_file = "{env.root}/never"'))
    t0 = time.monotonic()
    res = env.call("daemon.restart", timeout=0.3)
    elapsed = time.monotonic() - t0
    assert res["ok"] is True and res["changed"] is True and res["ready"] is False
    assert res["ready_timeout"] == 0.3
    assert elapsed < 3.0, elapsed


def test_daemon_restart_timeout_arg_is_honoured(env: Env, monkeypatch):
    env.daemon(active=True)
    seen: list[float] = []

    def fake_wait(path, timeout, poll=0.15):
        seen.append(timeout)
        return True

    monkeypatch.setattr(bridge, "_wait_for_daemon_ready", fake_wait)
    assert env.ok("daemon.restart")["ready_timeout"] == 18.0
    assert env.ok("daemon.restart", timeout=5)["ready_timeout"] == 5.0
    assert env.ok("daemon.restart", timeout=2.5)["ready_timeout"] == 2.5
    assert env.ok("daemon.restart", timeout=999)["ready_timeout"] == bridge.DAEMON_RESTART_READY_TIMEOUT_MAX
    assert seen == [18.0, 5.0, 2.5, bridge.DAEMON_RESTART_READY_TIMEOUT_MAX]
    assert bridge.DAEMON_RESTART_READY_TIMEOUT == 18.0
    env.fail("daemon.restart", timeout="soon")
    env.fail("daemon.restart", timeout=True)
    assert "--user restart voxtype" not in env.systemctl_calls()[-1]


def test_design_documents_restart_timeout():
    design = (REPO / "docs" / "DESIGN.md").read_text()
    assert "timeout:18" in design or "timeout: 18" in design


def test_daemon_restart_without_systemctl(env: Env):
    env.remove_fake("systemctl")
    res = env.call("daemon.restart")
    assert res["ok"] is False and res["changed"] is False
    assert "systemctl" in res["message"]


def test_daemon_start_stop(env: Env):
    res = env.ok("daemon.start")
    assert res["daemon"]["active"] is True and res["daemon"]["main_pid"] == 4001
    assert "--user start voxtype" in env.systemctl_calls()
    assert env.ok("status")["daemon"]["state"] == "idle"
    res = env.ok("daemon.stop")
    assert res["daemon"]["active"] is False
    assert "--user stop voxtype" in env.systemctl_calls()
    assert env.ok("status")["daemon"]["state"] == "stopped"


def test_daemon_start_failure(env: Env):
    env.remove_fake("systemctl")
    res = env.fail("daemon.start")
    assert "systemctl" in res["error"]


def test_record_toggle(env: Env):
    res = env.ok("record.toggle")
    assert res["message"] == "Recording started"
    assert env.voxtype_calls() == ["record toggle"]
    env.remove_fake("voxtype")
    env.fail("record.toggle")


# ---------------------------------------------------------------------------
# --download streaming mode
# ---------------------------------------------------------------------------


def test_download_streams_progress_and_creates_model(env: Env):
    r = env.run_cli(None, "--download", "whisper", "tiny")
    assert r.returncode == 0, r.stdout + r.stderr
    lines = r.stdout.splitlines()
    assert lines[0] == "LOG $ voxtype setup --download --model tiny"
    assert "PROGRESS 12.5" in lines
    assert "PROGRESS 50" in lines
    assert "PROGRESS 100" in lines
    assert lines[-1] == "DONE"
    assert any(l.startswith("LOG Downloading whisper model") for l in lines)
    progress_idx = [i for i, l in enumerate(lines) if l.startswith("PROGRESS")]
    assert progress_idx == sorted(progress_idx)
    assert (env.models_dir / "ggml-tiny.bin").stat().st_size == 1024
    assert all(l.split()[0] in {"PROGRESS", "LOG", "DONE"} for l in lines)
    assert env.ok("models.list", engine="whisper")["models"][0]["downloaded"] is True


def test_download_progress_is_streamed_not_batched(env: Env):
    """Progress lines must arrive while the download is still running
    (the fake sleeps 30 s after 'still downloading'), not at exit."""
    proc = subprocess.Popen(
        [sys.executable, str(BRIDGE), "--download", "whisper", "slow"],
        stdout=subprocess.PIPE, text=True, env=env.subprocess_env(),
    )
    assert proc.stdout is not None
    t0 = time.monotonic()
    seen: list[str] = []
    try:
        while time.monotonic() - t0 < 10:
            line = proc.stdout.readline()
            if not line:
                break
            seen.append(line.rstrip("\n"))
            if line.startswith("LOG still downloading"):
                break
        assert time.monotonic() - t0 < 10, seen
        assert "PROGRESS 12.5" in seen and "PROGRESS 87.5" in seen
    finally:
        proc.kill()
        proc.wait(timeout=10)


def test_download_failure(env: Env):
    r = env.run_cli(None, "--download", "whisper", "broken")
    assert r.returncode == 1
    lines = r.stdout.splitlines()
    assert lines[-1] == "FAILED exit 1"
    assert any("404" in l for l in lines)


def test_download_rejects_bad_arguments(env: Env):
    r = env.run_cli(None, "--download", "cohere", "tiny")
    assert r.returncode == 1 and r.stdout.startswith("FAILED unknown engine")
    r = env.run_cli(None, "--download", "whisper", "../../etc/passwd")
    assert r.returncode == 1 and r.stdout.startswith("FAILED invalid model name")
    r = env.run_cli(None, "--download", "whisper")
    assert r.returncode == 1 and r.stdout.startswith("FAILED usage")
    assert env.voxtype_calls() == []


def test_download_without_binary(env: Env):
    env.remove_fake("voxtype")
    r = env.run_cli(None, "--download", "whisper", "tiny")
    assert r.returncode == 1 and "FAILED voxtype binary not found" in r.stdout


def test_download_sigterm_cancels_and_removes_partial(env: Env):
    proc = subprocess.Popen(
        [sys.executable, str(BRIDGE), "--download", "whisper", "slow"],
        stdout=subprocess.PIPE, text=True, env=env.subprocess_env(),
    )
    assert proc.stdout is not None
    seen: list[str] = []
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        line = proc.stdout.readline()
        if not line:
            break
        seen.append(line.rstrip("\n"))
        if line.startswith("LOG still downloading"):
            break
    assert (env.models_dir / "ggml-slow.bin").exists()
    proc.send_signal(signal.SIGTERM)
    rest = proc.stdout.read().splitlines()
    code = proc.wait(timeout=20)
    assert code == 1
    assert rest[-1] == "FAILED cancelled"
    assert "LOG removed partial ggml-slow.bin" in rest
    assert not (env.models_dir / "ggml-slow.bin").exists()
    assert "PROGRESS 12.5" in seen
