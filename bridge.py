#!/usr/bin/python3
"""Stateless JSON-over-stdio bridge between the Omarchy plugin QML and
the installed ``voxtype_tui`` package.

    printf '{"op":"status"}' | python3 bridge.py        # one JSON object out
    python3 bridge.py --download whisper large-v3       # streaming lines

Every hard part (comment-preserving atomic config saves validated by
``voxtype -c <tmp> config``, sidecar reconcile, migrations, sync bundle,
GPU drop-in, model catalog, dictionary engine) is delegated to
``voxtype_tui``. This file only maps requests to those functions and
shapes the JSON the panel expects. See docs/DESIGN.md for the protocol.

Dependencies: Python stdlib + ``voxtype_tui`` (and ``tomlkit``, which is
a hard dependency of ``voxtype_tui`` and is only used to create empty
TOML tables). When ``voxtype_tui`` cannot be imported the bridge prints
``{"ok": false, "error": "voxtype-tui-missing"}`` and exits 3.

Environment overrides (tests only; never set in production):

* ``VOXTYPE_CONFIG``       config.toml path (default ~/.config/voxtype/config.toml)
* ``VOXTYPE_TUI_SIDECAR``  metadata.json path (default ~/.config/voxtype-tui/metadata.json)
* ``VOXTYPE_MODELS_DIR``   models directory (default ~/.local/share/voxtype/models)
* ``HOME``                 sync.json and the GPU drop-in derive from it
* ``XDG_RUNTIME_DIR``      daemon state file lives at ``$XDG_RUNTIME_DIR/voxtype/state``

``voxtype_tui`` resolves some of these as module constants at import
time, so the bridge re-points them before every call (see
``_apply_env_overrides``): ``models.MODELS_DIR`` (used by
``scan_downloaded``), ``sync.SYNC_PATH`` (used by ``AppState.save`` via
``write_sync_bundle``) and ``sync.DEFAULT_MODELS_DIR`` (used by the
startup sync reconcile inside ``AppState.load``). Config / sidecar paths
are passed explicitly to ``AppState.load``; ``gpu.DROPIN_PATH`` is a
``~``-relative path expanded at call time, so ``HOME`` covers it.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

EXIT_TUI_MISSING = 3
MAX_REQUEST_BYTES = 1_000_000

# ---------------------------------------------------------------------------
# voxtype_tui import guard
# ---------------------------------------------------------------------------

try:
    import voxtype_tui  # noqa: F401  (cheap: __init__ only sets __version__)
except ImportError:  # pragma: no cover - exercised via subprocess test
    _TUI_IMPORT_ERROR: Exception | None = sys.exc_info()[1]
else:
    _TUI_IMPORT_ERROR = None


def _tui_version() -> str | None:
    try:
        from importlib.metadata import version

        return version("voxtype-tui")
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Paths + environment overrides
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Paths:
    config: Path
    sidecar: Path
    models_dir: Path
    sync: Path
    dropin: Path
    runtime_state: Path


def _paths() -> Paths:
    home = Path.home()
    config = Path(
        os.environ.get("VOXTYPE_CONFIG") or (home / ".config" / "voxtype" / "config.toml")
    ).expanduser()
    sidecar = Path(
        os.environ.get("VOXTYPE_TUI_SIDECAR")
        or (home / ".config" / "voxtype-tui" / "metadata.json")
    ).expanduser()
    models_dir = Path(
        os.environ.get("VOXTYPE_MODELS_DIR")
        or (home / ".local" / "share" / "voxtype" / "models")
    ).expanduser()
    runtime = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    return Paths(
        config=config,
        sidecar=sidecar,
        models_dir=models_dir,
        sync=home / ".config" / "voxtype-tui" / "sync.json",
        dropin=home / ".config" / "systemd" / "user" / "voxtype.service.d" / "gpu.conf",
        runtime_state=Path(runtime) / "voxtype" / "state",
    )


def _apply_env_overrides(paths: Paths) -> None:
    """Re-point the module constants ``voxtype_tui`` resolved at import time.

    Only touches modules that are already imported (importing ``models``
    pulls in Textual, which ``status`` must avoid); lazy importers call
    this again after their import.
    """
    mods = sys.modules
    if "voxtype_tui.sync" in mods:
        mods["voxtype_tui.sync"].SYNC_PATH = paths.sync
        mods["voxtype_tui.sync"].DEFAULT_MODELS_DIR = paths.models_dir
    if "voxtype_tui.models" in mods:
        mods["voxtype_tui.models"].MODELS_DIR = paths.models_dir


def _import_models(paths: Paths):
    from voxtype_tui import models

    models.MODELS_DIR = paths.models_dir
    return models


def _import_state(paths: Paths):
    from voxtype_tui import state

    _apply_env_overrides(paths)
    return state


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


class BridgeError(Exception):
    """Human-readable failure; becomes ``{"ok": false, "error": str}``."""


_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def _strip_ansi(s: str) -> str:
    return _ANSI_RE.sub("", s)


def _plain(value: Any) -> Any:
    """Coerce tomlkit wrappers into JSON-native Python values."""
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, int):
        return int(value)
    if isinstance(value, float):
        return float(value)
    if isinstance(value, str):
        return str(value)
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    if hasattr(value, "items"):
        return {str(k): _plain(v) for k, v in value.items()}
    return str(value)


def _get_path(node: Any, dotted: str) -> Any:
    cur = node
    for part in dotted.split("."):
        if cur is None or not hasattr(cur, "get"):
            return None
        cur = cur.get(part)
    return cur


def _count_leaves(node: Any) -> int:
    if isinstance(node, dict):
        return sum(_count_leaves(v) for v in node.values())
    return 1


def _run(argv: list[str], timeout: float) -> tuple[int, str, str]:
    """argv-only subprocess wrapper. Never raises; missing binaries and
    timeouts come back as non-zero codes with a message in stderr."""
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        return 127, "", f"{argv[0]} not found"
    except subprocess.TimeoutExpired:
        return 124, "", f"{' '.join(argv)} timed out"
    except OSError as e:
        return 126, "", str(e)
    return r.returncode, r.stdout, r.stderr


def _require_str(args: dict, key: str, *, allow_empty: bool = False) -> str:
    val = args.get(key)
    if not isinstance(val, str):
        raise BridgeError(f"'{key}' must be a string")
    if not allow_empty and not val.strip():
        raise BridgeError(f"'{key}' must not be empty")
    return val


# ---------------------------------------------------------------------------
# Settings allow-list (dotted paths the TUI writes via AppState.set_setting)
# ---------------------------------------------------------------------------

# Value types the TUI writes for each path. ``settings.set`` coerces the
# JSON value to exactly this type so the TOML on disk matches what the
# TUI would have produced. Kept in sync with voxtype_tui/settings.py by
# tests/test_bridge.py::test_settings_allow_list_matches_tui.
SETTING_TYPES: dict[str, str] = {
    "engine": "str",
    "whisper.model": "str",
    "whisper.language": "str",
    "whisper.remote_endpoint": "str",
    "whisper.remote_model": "str",
    "whisper.remote_api_key": "str",
    "whisper.remote_timeout_secs": "int",
    "parakeet.model": "str",
    "moonshine.model": "str",
    "sensevoice.model": "str",
    "paraformer.model": "str",
    "dolphin.model": "str",
    "omnilingual.model": "str",
    "hotkey.key": "str",
    "hotkey.modifiers": "list",
    "hotkey.mode": "str",
    "hotkey.enabled": "bool",
    "audio.device": "str",
    "audio.max_duration_secs": "int",
    "audio.feedback.enabled": "bool",
    "audio.feedback.theme": "str",
    "audio.feedback.volume": "float",
    "output.mode": "str",
    "output.fallback_to_clipboard": "bool",
    "output.auto_submit": "bool",
    "output.type_delay_ms": "int",
    "output.post_process.command": "str",
    "output.post_process.timeout_ms": "int",
    "text.spoken_punctuation": "bool",
    "text.smart_auto_submit": "bool",
    "vad.enabled": "bool",
    "vad.model": "str",
    "vad.threshold": "float",
}

SECRET_SETTINGS = frozenset({"whisper.remote_api_key"})

# Tables the TUI treats as required once `engine` is set. Verified against
# `voxtype -c <tmp> config`: empty tables validate fine, but the engine's
# own `[<engine>]` table must NOT be created empty (voxtype then demands
# `model` inside it), so only these four are ensured.
REQUIRED_SECTIONS: tuple[str, ...] = ("hotkey", "audio", "whisper", "output")

_MODEL_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def _coerce_setting(path: str, value: Any) -> Any:
    kind = SETTING_TYPES[path]
    if kind == "bool":
        if isinstance(value, bool):
            return value
        if isinstance(value, str) and value.lower() in ("true", "false"):
            return value.lower() == "true"
        raise BridgeError(f"'{path}' expects a boolean")
    if kind == "int":
        if isinstance(value, bool):
            raise BridgeError(f"'{path}' expects an integer")
        if isinstance(value, int):
            return int(value)
        if isinstance(value, float) and value.is_integer():
            return int(value)
        if isinstance(value, str):
            try:
                return int(value.strip())
            except ValueError:
                pass
        raise BridgeError(f"'{path}' expects an integer")
    if kind == "float":
        if isinstance(value, bool):
            raise BridgeError(f"'{path}' expects a number")
        if isinstance(value, (int, float)):
            return float(value)
        if isinstance(value, str):
            try:
                return float(value.strip())
            except ValueError:
                pass
        raise BridgeError(f"'{path}' expects a number")
    if kind == "list":
        if isinstance(value, list) and all(isinstance(v, str) for v in value):
            return [v.strip() for v in value if v.strip()]
        raise BridgeError(f"'{path}' expects a list of strings")
    # str
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    raise BridgeError(f"'{path}' expects a string")


def _validate_setting(path: str, value: Any, paths: Paths) -> None:
    """Mirror the range/enum guards the TUI applies before set_setting.
    ``voxtype -c <tmp> config`` remains the authoritative validator at
    save time; these just give earlier, friendlier errors."""
    from voxtype_tui import settings

    if path == "engine" and value not in settings.ENGINES:
        raise BridgeError(f"unknown engine {value!r}")
    if path == "hotkey.mode" and value not in settings.HOTKEY_MODES:
        raise BridgeError(f"hotkey.mode must be one of {settings.HOTKEY_MODES}")
    if path == "output.mode" and value not in settings.OUTPUT_MODES:
        raise BridgeError(f"output.mode must be one of {settings.OUTPUT_MODES}")
    if path == "hotkey.modifiers":
        bad = [m for m in value if m not in settings.HOTKEY_MODIFIERS]
        if bad:
            raise BridgeError(f"unknown hotkey modifiers: {bad}")
    if path in ("audio.feedback.volume", "vad.threshold") and not 0.0 <= value <= 1.0:
        raise BridgeError(f"'{path}' must be between 0.0 and 1.0")
    if path in ("audio.max_duration_secs", "output.post_process.timeout_ms",
                "whisper.remote_timeout_secs") and value <= 0:
        raise BridgeError(f"'{path}' must be positive")
    if path == "output.type_delay_ms" and value < 0:
        raise BridgeError(f"'{path}' must not be negative")
    # Pointing the daemon at a model that isn't on disk crash-loops it
    # after restart. Absolute paths are the "custom model file" escape
    # hatch and are checked as plain files.
    engine = next(
        (e for e, p in settings.MODEL_PATH_PER_ENGINE.items() if p == path), None
    )
    if engine is not None:
        if value.startswith("/") or value.startswith("~"):
            if not Path(value).expanduser().exists():
                raise BridgeError(f"model file {value!r} does not exist")
        else:
            models = _import_models(paths)
            if not models.is_model_installed(engine, value, models_dir=paths.models_dir):
                raise BridgeError(
                    f"'{value}' is not downloaded for {engine} — download it first"
                )


# ---------------------------------------------------------------------------
# State loading + snapshot
# ---------------------------------------------------------------------------


def _load_state(paths: Paths):
    if not paths.config.exists():
        raise BridgeError(
            f"voxtype config not found at {paths.config} — run `voxtype setup` first"
        )
    state = _import_state(paths)
    try:
        return state.AppState.load(paths.config, paths.sidecar)
    except Exception as e:  # tomlkit parse errors, unreadable files
        raise BridgeError(f"could not load config: {e}") from e


def _snapshot(st) -> dict[str, Any]:
    from voxtype_tui import config, sidecar, sync

    phrases = [v.phrase for v in st.sc.vocabulary]
    reps = config.get_replacements(st.doc)
    settings_out: dict[str, Any] = {}
    for path in SETTING_TYPES:
        if path in SECRET_SETTINGS:
            continue
        val = _get_path(st.doc, path)
        if val is not None:
            settings_out[path] = _plain(val)
    api_key = _get_path(st.doc, "whisper.remote_api_key")
    settings_out["whisper.remote_api_key_set"] = bool(api_key) and str(api_key) != ""

    sr = st.sync_reconcile
    return {
        "vocabulary": [
            {"phrase": v.phrase, "added_at": v.added_at} for v in st.sc.vocabulary
        ],
        "vocab_tokens": sync.estimate_initial_prompt_tokens(phrases),
        "vocab_token_limit": sync.WHISPER_INITIAL_PROMPT_TOKEN_LIMIT,
        "replacements": [
            {"from": r.from_text, "to": reps.get(r.from_text, ""), "category": r.category}
            for r in st.sc.replacements
        ],
        "categories": list(sidecar.CATEGORIES),
        "settings": settings_out,
        "restart_sensitive": sorted(config.RESTART_SENSITIVE_PATHS),
        "warnings": list(st.reconcile_warnings) + list(sr.warnings),
        "migrations_applied": list(st.migrations_applied),
        "sync": {
            "applied_from": sr.applied_from,
            "conflicts": [str(p) for p in sr.conflict_files],
            "missing_model": sr.missing_model,
        },
    }


def _save_and_reply(st, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    from voxtype_tui import config

    try:
        restart_fields = st.save()
    except config.ValidationError as e:
        raise BridgeError(str(e)) from e
    except OSError as e:
        raise BridgeError(f"save failed: {e}") from e
    out: dict[str, Any] = {
        "ok": True,
        "snapshot": _snapshot(st),
        "restart_needed": list(restart_fields),
        # True for ANY config.toml write (voxtype reads its config once at
        # daemon start), not just the restart-sensitive subset above.
        "daemon_stale": bool(st.daemon_stale),
    }
    if extra:
        out.update(extra)
    return out


def _save_sidecar_only(st, paths: Paths) -> dict[str, Any]:
    """Persist a sidecar-only change without rewriting config.toml (which
    would bump its mtime and light the restart pill for nothing). Falls
    back to a full save when a config change is pending (migrations)."""
    if st.config_dirty:
        return _save_and_reply(st)
    from voxtype_tui import sidecar, sync

    try:
        sidecar.save_atomic(st.sc, paths.sidecar)
        sync.write_sync_bundle(st.doc, st.sc, path=paths.sync)
    except OSError as e:
        raise BridgeError(f"save failed: {e}") from e
    st.sidecar_dirty = False
    return {
        "ok": True,
        "snapshot": _snapshot(st),
        "restart_needed": [],
        "daemon_stale": bool(st.daemon_stale),
    }


# ---------------------------------------------------------------------------
# Daemon helpers (systemctl + state file)
# ---------------------------------------------------------------------------

SYSTEMCTL_SHOW = [
    "systemctl", "--user", "show", "voxtype",
    "-p", "MainPID", "-p", "ActiveState",
    "-p", "ExecMainStartTimestamp", "-p", "ExecMainStartTimestampMonotonic",
]

DAEMON_READY_STATES = ("idle", "recording", "transcribing")


@dataclass
class UnitInfo:
    active: bool
    active_state: str
    main_pid: int | None
    start_monotonic_us: int | None
    start_wall: float | None
    available: bool

    def as_dict(self) -> dict[str, Any]:
        return {
            "active": self.active,
            "active_state": self.active_state,
            "main_pid": self.main_pid,
            "started_at": _iso(self.start_wall),
            "start_monotonic_us": self.start_monotonic_us,
        }


def _iso(ts: float | None) -> str | None:
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).astimezone().isoformat(
        timespec="seconds"
    )


def _parse_systemd_timestamp(text: str) -> float | None:
    """``Thu 2026-09-10 16:40:12 CEST`` → epoch seconds (local time; the
    trailing zone name is dropped because strptime can't map it)."""
    parts = text.split()
    if len(parts) < 3:
        return None
    try:
        st = time.strptime(f"{parts[1]} {parts[2]}", "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None
    return time.mktime(st)


def _unit_info() -> UnitInfo:
    code, out, _err = _run(SYSTEMCTL_SHOW, timeout=3)
    if code != 0:
        return UnitInfo(False, "unknown", None, None, None, available=False)
    props: dict[str, str] = {}
    for line in out.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            props[k.strip()] = v.strip()
    active_state = props.get("ActiveState", "unknown")
    active = active_state == "active"
    try:
        pid = int(props.get("MainPID", "0") or 0)
    except ValueError:
        pid = 0
    mono: int | None = None
    try:
        mono = int(props.get("ExecMainStartTimestampMonotonic", "0") or 0) or None
    except ValueError:
        mono = None
    wall: float | None = None
    if mono:
        # CLOCK_MONOTONIC is what systemd reports; convert via the current
        # (wall, monotonic) pair. No clock trust needed beyond "both
        # sampled now".
        wall = time.time() - time.monotonic() + mono / 1_000_000
    elif props.get("ExecMainStartTimestamp"):
        wall = _parse_systemd_timestamp(props["ExecMainStartTimestamp"])
    if not active:
        wall = None
    return UnitInfo(active, active_state, pid or None, mono, wall, available=True)


def _state_file(paths: Paths, cfg: dict[str, Any] | None) -> Path | None:
    """Honour ``state_file`` from config; ``auto``/missing → runtime dir,
    ``disabled`` → None."""
    val = (cfg or {}).get("state_file")
    if isinstance(val, str) and val not in ("", "auto"):
        if val == "disabled":
            return None
        return Path(val).expanduser()
    return paths.runtime_state


def _read_state_word(path: Path | None) -> str | None:
    if path is None:
        return None
    try:
        return path.read_text().strip() or None
    except OSError:
        return None


def _wait_for_daemon_ready(path: Path | None, timeout: float, poll: float = 0.15) -> bool:
    if path is None:
        return False
    deadline = time.monotonic() + timeout
    while True:
        if _read_state_word(path) in DAEMON_READY_STATES:
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(poll)


def _mtime(path: Path) -> float | None:
    try:
        return path.stat().st_mtime
    except OSError:
        return None


# Per-engine on-disk layout, mirrored from voxtype_tui.models.model_file_path
# (pinned by tests/test_bridge.py::test_status_model_path_matches_tui).
# Inlined so `status` never imports the Textual-backed models module.
# Whisper is the only flat-file engine; the others are directories.
_MODEL_PATH_TEMPLATES: dict[str, str] = {
    "whisper": "ggml-{name}.bin",
    "moonshine": "moonshine-{name}",
    "sensevoice": "sensevoice-{name}",
    "paraformer": "paraformer-{name}",
    "dolphin": "dolphin-{name}",
    "omnilingual": "omnilingual-{name}",
    "parakeet": "{name}",
}


def _model_file_path(engine: str, name: str, models_dir: Path) -> Path:
    template = _MODEL_PATH_TEMPLATES.get(engine, "{name}.bin")
    return models_dir / template.format(name=name)


def _model_present(path: Path) -> bool:
    """Same rule as voxtype_tui.models.is_model_installed: a non-empty
    file, or a directory containing at least one regular file."""
    try:
        if path.is_file():
            return path.stat().st_size > 0
        if path.is_dir():
            for _root, _dirs, files in os.walk(path):
                if files:
                    return True
    except OSError:
        return False
    return False


# ---------------------------------------------------------------------------
# Read ops
# ---------------------------------------------------------------------------


def op_status(args: dict, paths: Paths) -> dict[str, Any]:
    """Fast path: stdlib tomllib + one systemctl call. Never imports the
    Textual-backed modules and never runs ``voxtype setup``."""
    import tomllib

    cfg: dict[str, Any] = {}
    config_error: str | None = None
    if paths.config.exists():
        try:
            cfg = tomllib.loads(paths.config.read_text())
        except (OSError, tomllib.TOMLDecodeError) as e:
            config_error = str(e)

    unit = _unit_info()
    state_path = _state_file(paths, cfg)
    word = _read_state_word(state_path) if unit.active else None
    if not unit.active:
        state = "stopped"
    elif word in DAEMON_READY_STATES:
        state = word
    else:
        state = "idle"

    stale = False
    if unit.active and unit.start_wall is not None:
        for p in (paths.config, paths.dropin):
            m = _mtime(p)
            if m is not None and m > unit.start_wall:
                stale = True
                break

    engine = str(cfg.get("engine") or "whisper")
    model_name = _get_path(cfg, f"{engine}.model")
    model_path: Path | None = None
    present: bool | None = None
    if isinstance(model_name, str) and model_name:
        if model_name.startswith("/") or model_name.startswith("~"):
            model_path = Path(model_name).expanduser()
            present = model_path.exists()
        else:
            model_path = _model_file_path(engine, model_name, paths.models_dir)
            present = _model_present(model_path)
    else:
        model_name = None

    hotkey = cfg.get("hotkey") or {}
    output = cfg.get("output") or {}
    daemon = unit.as_dict()
    daemon.update({
        "state": state,
        "stale": stale,
        "ready": word in DAEMON_READY_STATES,
        "systemctl_available": unit.available,
    })
    out: dict[str, Any] = {
        "ok": True,
        "voxtype_installed": shutil.which("voxtype") is not None,
        "tui_version": _tui_version(),
        "daemon": daemon,
        "engine": engine,
        "model": {
            "name": model_name,
            "path": str(model_path) if model_path else None,
            "present": present,
        },
        "hotkey": {
            "key": _plain(hotkey.get("key")),
            "modifiers": _plain(hotkey.get("modifiers") or []),
            "mode": str(hotkey.get("mode") or "push_to_talk"),
            "enabled": bool(hotkey.get("enabled", True)),
        },
        "output_mode": str(output.get("mode") or "type"),
        "config_path": str(paths.config),
        "config_exists": paths.config.exists(),
    }
    if config_error:
        out["warnings"] = [f"config.toml could not be parsed: {config_error}"]
    return out


def op_load(args: dict, paths: Paths) -> dict[str, Any]:
    st = _load_state(paths)
    return {"ok": True, "snapshot": _snapshot(st)}


def op_options(args: dict, paths: Paths) -> dict[str, Any]:
    from voxtype_tui import settings, voxtype_cli

    models = _import_models(paths)
    devices = [
        {"label": label, "name": name}
        for label, name in settings.enumerate_audio_devices_sync()
        if name != settings.CUSTOM_AUDIO_DEVICE
    ]
    return {
        "ok": True,
        "engines": list(settings.ENGINES),
        "compiled_engines": sorted(voxtype_cli.compiled_engines()),
        "models_per_engine": {
            e: [m.name for m in infos] for e, infos in models.MODEL_CATALOG.items()
        },
        "model_paths": dict(settings.MODEL_PATH_PER_ENGINE),
        "hotkey_modifiers": list(settings.HOTKEY_MODIFIERS),
        "hotkey_modes": list(settings.HOTKEY_MODES),
        "output_modes": list(settings.OUTPUT_MODES),
        "audio_devices": devices,
        "feedback_themes": list(settings.AUDIO_FEEDBACK_THEMES),
        "gpu_vendors": [
            {"label": label, "value": value}
            for label, value in settings.GPU_DEVICE_STATIC_OPTIONS
        ],
    }


def _active_model(doc: Any, engine: str) -> str:
    from voxtype_tui import settings

    path = settings.MODEL_PATH_PER_ENGINE.get(engine)
    if path is None:
        raise BridgeError(f"unknown engine {engine!r}")
    val = _get_path(doc, path)
    return str(val) if val else ""


def op_models_list(args: dict, paths: Paths) -> dict[str, Any]:
    engine = _require_str(args, "engine")
    models = _import_models(paths)
    if engine not in models.MODEL_CATALOG:
        raise BridgeError(f"unknown engine {engine!r}")
    st = _load_state(paths)
    active = _active_model(st.doc, engine)
    downloaded = models.scan_downloaded(engine)
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for info in models.MODEL_CATALOG[engine]:
        seen.add(info.name)
        on_disk = downloaded.get(info.name)
        rows.append({
            "name": info.name,
            "size_mb": info.size_mb,
            "on_disk_bytes": on_disk,
            "downloaded": on_disk is not None,
            "unknown": False,
            "active": info.name == active,
            "path": str(models.model_file_path(engine, info.name, models_dir=paths.models_dir)),
        })
    for name, size in downloaded.items():
        if name in seen:
            continue
        rows.append({
            "name": name,
            "size_mb": round(size / (1024 * 1024)),
            "on_disk_bytes": size,
            "downloaded": True,
            "unknown": True,
            "active": name == active,
            "path": str(models.model_file_path(engine, name, models_dir=paths.models_dir)),
        })
    return {
        "ok": True,
        "engine": engine,
        "active": active or None,
        "models": rows,
        "models_dir": str(paths.models_dir),
        "total_bytes": models.total_disk_usage(),
    }


def _parse_backend(text: str) -> str | None:
    for line in text.splitlines():
        s = line.strip()
        if s.endswith("- active"):
            return s[: -len("- active")].strip()
    for line in text.splitlines():
        s = line.strip()
        if s.lower().startswith("next launch:"):
            return s.split(":", 1)[1].strip()
    return None


def op_gpu_status(args: dict, paths: Paths) -> dict[str, Any]:
    from voxtype_tui import gpu, settings

    ok, raw = settings.gpu_status_sync()
    text = _strip_ansi(raw)
    detected = gpu.parse_detected_gpus(text) if ok else []
    return {
        "ok": ok,
        "text": text,
        "backend": _parse_backend(text) if ok else None,
        "gpus": [{"vendor": vendor, "label": label} for label, vendor in detected],
        "device": gpu.read_gpu_device(paths.dropin) or "auto",
        "dropin_path": str(paths.dropin),
        **({} if ok else {"error": text.strip() or "gpu status failed"}),
    }


def op_dictionary_preview(args: dict, paths: Paths) -> dict[str, Any]:
    from voxtype_tui import config, dictionary_engine

    text = _require_str(args, "text", allow_empty=True)
    st = _load_state(paths)
    reps = config.get_replacements(st.doc)
    rules = [
        dictionary_engine.Rule(
            trigger=r.from_text,
            replacement=reps[r.from_text],
            category=r.category,
        )
        for r in st.sc.replacements
        if r.from_text in reps
    ]
    return {
        "ok": True,
        "input": text,
        "output": dictionary_engine.process(text, rules),
        "rules": len(rules),
    }


def _export_args(args: dict) -> tuple[str, bool]:
    from voxtype_tui import sync

    scope = args.get("scope", sync.SCOPE_SYNC_ONLY)
    if scope not in sync.EXPORT_SCOPES:
        raise BridgeError(f"scope must be one of {list(sync.EXPORT_SCOPES)}")
    include_secrets = args.get("include_secrets", False)
    if not isinstance(include_secrets, bool):
        raise BridgeError("'include_secrets' must be a boolean")
    return scope, include_secrets


def op_export_preview(args: dict, paths: Paths) -> dict[str, Any]:
    from voxtype_tui import sync

    scope, include_secrets = _export_args(args)
    st = _load_state(paths)
    sync_block = sync.distill_sync(st.doc, st.sc.vocabulary, st.sc.replacements)
    local_block = sync.distill_local(st.doc) if scope == sync.SCOPE_SYNC_PLUS_LOCAL else {}
    secrets_available = _count_leaves(sync.distill_secrets(st.doc))
    return {
        "ok": True,
        "default_path": str(sync.default_export_path()),
        "scope": scope,
        "include_secrets": include_secrets,
        "counts": {
            "vocabulary": len(sync_block["vocabulary"]),
            "replacements": len(sync_block["replacements"]),
            "settings": _count_leaves(sync_block["settings"]),
            "local": _count_leaves(local_block),
            "secrets": secrets_available if include_secrets else 0,
            "secrets_available": secrets_available,
        },
    }


# Import-diff rows whose values must never reach the panel: the remote
# API key (credential) and the three shell-command hooks (a malicious
# bundle could carry `bash -c ...`; the panel only needs to know a change
# is proposed). Mirrors voxtype_tui.sync.SECRET_PATHS — pinned by
# tests/test_bridge.py::test_redacted_import_paths_match_tui.
REDACTED_IMPORT_PATHS = frozenset({
    "whisper.remote_api_key",
    "output.post_process.command",
    "output.pre_output_command",
    "output.post_output_command",
})


def _setting_change_row(change) -> dict[str, Any]:
    if change.path in REDACTED_IMPORT_PATHS:
        return {
            "path": change.path,
            "dangerous": True,
            "redacted": True,
            "old_set": change.old is not None and change.old != "",
            "new_set": change.new is not None and change.new != "",
        }
    return {
        "path": change.path,
        "old": _plain(change.old),
        "new": _plain(change.new),
        "dangerous": change.dangerous,
    }


def _diff_to_json(preview) -> dict[str, Any]:
    return {
        "vocab_add": list(preview.vocab.added),
        # Import merges; it never removes local vocabulary.
        "vocab_remove": [],
        "vocab_unchanged": list(preview.vocab.unchanged),
        "replacements_add": [{"from": f, "to": t} for f, t in preview.replacements.added],
        "replacements_change": [
            {"from": f, "old": o, "new": n} for f, o, n in preview.replacements.updated
        ],
        "settings_change": [_setting_change_row(c) for c in preview.settings],
    }


def _import_load(args: dict, paths: Paths):
    """Shared by import.preview / import.apply: (state, bundle, warnings,
    format, include_local, preview)."""
    from voxtype_tui import sync

    raw_path = _require_str(args, "path")
    include_local = bool(args.get("include_local", False))
    include_settings = bool(args.get("include_settings", True))
    path = Path(raw_path).expanduser()
    # Size gate BEFORE any read: a multi-GB "bundle" must never be pulled
    # into memory just to be rejected by load_bundle_file's own cap.
    try:
        size = path.stat().st_size
    except OSError as e:
        raise BridgeError(f"could not read file: {e}") from e
    if size > sync.MAX_BUNDLE_BYTES:
        raise BridgeError(
            f"file is {size} bytes; limit {sync.MAX_BUNDLE_BYTES}"
        )
    try:
        parsed = json.loads(path.read_bytes())
    except (OSError, ValueError):
        parsed = None
    fmt = sync.detect_format(parsed) if parsed is not None else sync.UNKNOWN_FORMAT
    try:
        bundle, warnings = sync.load_bundle_file(path)
    except sync.BundleError as e:
        raise BridgeError(str(e)) from e
    st = _load_state(paths)
    if not include_settings and bundle.sync.get("settings"):
        bundle = sync._bundle_with_stripped_settings(bundle)
    # Same guard as the startup reader: never point the daemon at a model
    # we don't have on disk.
    bundle.sync, model_warnings, _skipped = sync._filter_uninstalled_models(
        bundle.sync, paths.models_dir,
    )
    warnings = list(warnings) + list(model_warnings)
    if not bundle.local:
        include_local = False
    preview = sync.diff_bundle_against_state(
        bundle, st.doc, st.sc, include_local=include_local,
    )
    return st, bundle, warnings, fmt, include_local, preview


def op_import_preview(args: dict, paths: Paths) -> dict[str, Any]:
    _st, bundle, warnings, fmt, include_local, preview = _import_load(args, paths)
    diff = _diff_to_json(preview)
    return {
        "ok": True,
        "format": fmt,
        "source": preview.source,
        "has_local": bool(bundle.local),
        "include_local": include_local,
        "warnings": warnings,
        "dangerous": [c["path"] for c in diff["settings_change"] if c["dangerous"]],
        "diff": diff,
    }


# ---------------------------------------------------------------------------
# Write ops
# ---------------------------------------------------------------------------


def op_vocab_add(args: dict, paths: Paths) -> dict[str, Any]:
    phrase = _require_str(args, "phrase")
    st = _load_state(paths)
    if not st.add_vocab(phrase):
        raise BridgeError(f"'{phrase.strip()}' is empty or already in the vocabulary")
    return _save_and_reply(st)


def op_vocab_remove(args: dict, paths: Paths) -> dict[str, Any]:
    phrase = _require_str(args, "phrase")
    st = _load_state(paths)
    if not st.remove_vocab(phrase):
        raise BridgeError(f"'{phrase}' is not in the vocabulary")
    return _save_and_reply(st)


def op_vocab_set(args: dict, paths: Paths) -> dict[str, Any]:
    phrases = args.get("phrases")
    if not isinstance(phrases, list) or not all(isinstance(p, str) for p in phrases):
        raise BridgeError("'phrases' must be a list of strings")
    cleaned: list[str] = []
    seen: set[str] = set()
    for p in phrases:
        p = p.strip()
        if p and p not in seen:
            seen.add(p)
            cleaned.append(p)
    st = _load_state(paths)
    st.set_vocabulary(cleaned)
    return _save_and_reply(st)


def _category(args: dict, *, required: bool) -> str | None:
    from voxtype_tui import sidecar

    cat = args.get("category")
    if cat is None:
        if required:
            raise BridgeError("'category' is required")
        return None
    if cat not in sidecar.CATEGORIES:
        raise BridgeError(f"category must be one of {list(sidecar.CATEGORIES)}")
    return cat


def op_dict_upsert(args: dict, paths: Paths) -> dict[str, Any]:
    from voxtype_tui import sidecar

    from_text = _require_str(args, "from").strip()
    to_text = _require_str(args, "to")
    category = _category(args, required=False) or sidecar.DEFAULT_CATEGORY
    st = _load_state(paths)
    st.upsert_replacement(from_text, to_text, category)
    return _save_and_reply(st)


def op_dict_remove(args: dict, paths: Paths) -> dict[str, Any]:
    from_text = _require_str(args, "from")
    st = _load_state(paths)
    if not st.remove_replacement(from_text):
        raise BridgeError(f"no replacement rule for '{from_text}'")
    return _save_and_reply(st)


def op_dict_set_category(args: dict, paths: Paths) -> dict[str, Any]:
    from_text = _require_str(args, "from")
    category = _category(args, required=True)
    st = _load_state(paths)
    if not any(r.from_text == from_text for r in st.sc.replacements):
        raise BridgeError(f"no replacement rule for '{from_text}'")
    changed = st.set_replacement_category(from_text, category)
    out = _save_sidecar_only(st, paths)
    out["changed"] = changed
    return out


def _ensure_required_sections(doc: Any) -> None:
    import tomlkit

    for section in REQUIRED_SECTIONS:
        if section not in doc:
            doc[section] = tomlkit.table()


def op_settings_set(args: dict, paths: Paths) -> dict[str, Any]:
    path = _require_str(args, "path")
    if path not in SETTING_TYPES:
        raise BridgeError(f"'{path}' is not a settable path")
    if "value" not in args:
        raise BridgeError("'value' is required")
    value = args["value"]
    if value is None or (isinstance(value, str) and value == ""):
        # Voxtype's defaults only kick in when a key is absent — an empty
        # string is not "default". Treat it as unset.
        return op_settings_unset({"path": path}, paths)
    value = _coerce_setting(path, value)
    _validate_setting(path, value, paths)
    st = _load_state(paths)
    st.set_setting(path, value)
    if path == "engine":
        _ensure_required_sections(st.doc)
    return _save_and_reply(st, {"path": path, "value": value if path not in SECRET_SETTINGS else None})


def op_settings_unset(args: dict, paths: Paths) -> dict[str, Any]:
    path = _require_str(args, "path")
    if path not in SETTING_TYPES:
        raise BridgeError(f"'{path}' is not a settable path")
    st = _load_state(paths)
    changed = st.unset_setting(path)
    if not changed and not st.dirty:
        return {
            "ok": True,
            "snapshot": _snapshot(st),
            "restart_needed": [],
            "daemon_stale": False,
            "path": path,
            "changed": False,
        }
    return _save_and_reply(st, {"path": path, "changed": changed})


def _model_args(args: dict, paths: Paths):
    engine = _require_str(args, "engine")
    name = _require_str(args, "name").strip()
    models = _import_models(paths)
    if engine not in models.MODEL_CATALOG:
        raise BridgeError(f"unknown engine {engine!r}")
    if not _MODEL_NAME_RE.match(name):
        raise BridgeError(f"invalid model name {name!r}")
    return engine, name, models


def op_models_set_active(args: dict, paths: Paths) -> dict[str, Any]:
    from voxtype_tui import settings

    engine, name, models = _model_args(args, paths)
    if not models.is_model_installed(engine, name, models_dir=paths.models_dir):
        raise BridgeError(f"'{name}' is not downloaded for {engine} — download it first")
    st = _load_state(paths)
    st.set_setting(settings.MODEL_PATH_PER_ENGINE[engine], name)
    return _save_and_reply(st, {"engine": engine, "name": name})


def op_models_delete(args: dict, paths: Paths) -> dict[str, Any]:
    engine, name, models = _model_args(args, paths)
    st = _load_state(paths)
    if name == _active_model(st.doc, engine):
        raise BridgeError(
            f"'{name}' is the active {engine} model — set a different model active first"
        )
    path = models.model_file_path(engine, name, models_dir=paths.models_dir)
    if not path.exists():
        raise BridgeError(f"'{name}' is not downloaded — nothing to delete")
    try:
        freed = path.stat().st_size if path.is_file() else models._dir_size(path)
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()
    except OSError as e:
        raise BridgeError(f"delete failed: {e}") from e
    return {
        "ok": True,
        "snapshot": _snapshot(st),
        "restart_needed": [],
        "daemon_stale": False,
        "engine": engine,
        "name": name,
        "freed_bytes": freed,
    }


def op_gpu_set_device(args: dict, paths: Paths) -> dict[str, Any]:
    from voxtype_tui import gpu

    vendor = _require_str(args, "vendor").strip().lower()
    allowed = ("auto",) + tuple(gpu.VENDORS)
    if vendor not in allowed:
        raise BridgeError(f"vendor must be one of {list(allowed)}")
    try:
        gpu.write_gpu_device(paths.dropin, None if vendor == "auto" else vendor)
    except OSError as e:
        raise BridgeError(f"could not write {paths.dropin}: {e}") from e
    ran, msg = gpu.daemon_reload()
    st = _load_state(paths)
    return {
        "ok": True,
        "snapshot": _snapshot(st),
        "restart_needed": ["gpu.device"],
        "daemon_stale": True,
        "device": gpu.read_gpu_device(paths.dropin) or "auto",
        "dropin_path": str(paths.dropin),
        "daemon_reload": {"ok": ran, "message": msg},
    }


def op_export_write(args: dict, paths: Paths) -> dict[str, Any]:
    from voxtype_tui import sync

    scope, include_secrets = _export_args(args)
    raw_path = args.get("path") or str(sync.default_export_path())
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise BridgeError("'path' must be a non-empty string")
    st = _load_state(paths)
    try:
        bundle = sync.build_export_bundle(
            st.doc, st.sc, scope=scope, redact_secrets=not include_secrets,
        )
        written = sync.write_export_bundle(bundle, Path(raw_path))
    except (OSError, sync.BundleError, ValueError) as e:
        raise BridgeError(str(e)) from e
    return {
        "ok": True,
        "path": str(written),
        "bytes": written.stat().st_size,
        "scope": scope,
        "include_secrets": include_secrets,
        "snapshot": _snapshot(st),
        "restart_needed": [],
        "daemon_stale": False,
    }


def op_import_apply(args: dict, paths: Paths) -> dict[str, Any]:
    from voxtype_tui import sync

    accept_dangerous = bool(args.get("accept_dangerous", False))
    st, bundle, warnings, fmt, include_local, preview = _import_load(args, paths)
    diff = _diff_to_json(preview)
    dangerous = [c["path"] for c in diff["settings_change"] if c["dangerous"]]
    if dangerous and not accept_dangerous:
        return {
            "ok": False,
            "error": "dangerous-changes",
            "dangerous": dangerous,
            "diff": diff,
            "warnings": warnings,
        }
    apply_warnings = sync.apply_bundle_to_state(
        bundle, st.doc, st.sc, include_local=include_local,
    )
    st.config_dirty = True
    st.sidecar_dirty = True
    return _save_and_reply(st, {
        "format": fmt,
        "applied": diff,
        "warnings": warnings + list(apply_warnings),
    })


# ---------------------------------------------------------------------------
# Daemon ops
# ---------------------------------------------------------------------------


def _config_dict(paths: Paths) -> dict[str, Any]:
    import tomllib

    try:
        return tomllib.loads(paths.config.read_text())
    except (OSError, tomllib.TOMLDecodeError):
        return {}


def op_daemon_restart(args: dict, paths: Paths) -> dict[str, Any]:
    from voxtype_tui import voxtype_cli

    before = _unit_info()
    ok, message = voxtype_cli.restart_daemon()
    after = _unit_info()
    changed = (
        before.main_pid != after.main_pid
        or before.start_monotonic_us != after.start_monotonic_us
    )
    ready = False
    if ok and changed:
        timeout = args.get("timeout", 20.0)
        timeout = float(timeout) if isinstance(timeout, (int, float)) else 20.0
        ready = _wait_for_daemon_ready(_state_file(paths, _config_dict(paths)), timeout)
    if ok and not changed:
        message = (
            f"{message}; but MainPID/start timestamp did not change "
            "(unit may not be running)"
        )
    return {
        "ok": bool(ok and changed),
        "main_pid_before": before.main_pid,
        "main_pid_after": after.main_pid,
        "changed": changed,
        "ready": ready,
        "active": after.active,
        "message": message,
    }


def _daemon_verb(verb: str, paths: Paths) -> dict[str, Any]:
    code, out, err = _run(["systemctl", "--user", verb, "voxtype"], timeout=15)
    unit = _unit_info()
    message = (err or out).strip() or ("ok" if code == 0 else f"systemctl {verb} failed")
    return {
        "ok": code == 0,
        **({} if code == 0 else {"error": message}),
        "message": message,
        "daemon": unit.as_dict(),
    }


def op_daemon_start(args: dict, paths: Paths) -> dict[str, Any]:
    return _daemon_verb("start", paths)


def op_daemon_stop(args: dict, paths: Paths) -> dict[str, Any]:
    return _daemon_verb("stop", paths)


def op_record_toggle(args: dict, paths: Paths) -> dict[str, Any]:
    if shutil.which("voxtype") is None:
        raise BridgeError("voxtype binary not found")
    code, out, err = _run(["voxtype", "record", "toggle"], timeout=5)
    message = _strip_ansi((err or out).strip())
    if code != 0:
        raise BridgeError(message or f"voxtype record toggle exited {code}")
    return {"ok": True, "message": message}


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

OPS: dict[str, Callable[[dict, Paths], dict[str, Any]]] = {
    # read
    "status": op_status,
    "load": op_load,
    "options": op_options,
    "models.list": op_models_list,
    "gpu.status": op_gpu_status,
    "dictionary.preview": op_dictionary_preview,
    "export.preview": op_export_preview,
    "import.preview": op_import_preview,
    # write
    "vocab.add": op_vocab_add,
    "vocab.remove": op_vocab_remove,
    "vocab.set": op_vocab_set,
    "dict.upsert": op_dict_upsert,
    "dict.remove": op_dict_remove,
    "dict.set_category": op_dict_set_category,
    "settings.set": op_settings_set,
    "settings.unset": op_settings_unset,
    "models.set_active": op_models_set_active,
    "models.delete": op_models_delete,
    "gpu.set_device": op_gpu_set_device,
    "export.write": op_export_write,
    "import.apply": op_import_apply,
    # daemon
    "daemon.restart": op_daemon_restart,
    "daemon.start": op_daemon_start,
    "daemon.stop": op_daemon_stop,
    "record.toggle": op_record_toggle,
}


def handle(request: Any) -> dict[str, Any]:
    """Dispatch one request dict → one response dict. Never raises."""
    if _TUI_IMPORT_ERROR is not None:
        return {"ok": False, "error": "voxtype-tui-missing"}
    if not isinstance(request, dict):
        return {"ok": False, "error": "request must be a JSON object"}
    op = request.get("op")
    if not isinstance(op, str) or op not in OPS:
        return {"ok": False, "error": f"unknown op {op!r}", "ops": sorted(OPS)}
    paths = _paths()
    _apply_env_overrides(paths)
    try:
        return OPS[op](request, paths)
    except BridgeError as e:
        return {"ok": False, "error": str(e), "op": op}
    except Exception as e:  # never leak a traceback to the panel
        return {"ok": False, "error": f"{type(e).__name__}: {e}", "op": op}


# ---------------------------------------------------------------------------
# Streaming download mode
# ---------------------------------------------------------------------------


def run_download(engine: str, name: str, out=None) -> int:
    """``bridge.py --download <engine> <name>``: stream progress lines.

    Emits ``PROGRESS <pct>`` / ``LOG <text>`` and finally ``DONE`` or
    ``FAILED <reason>``. SIGTERM/SIGINT cancel the download and remove
    the partial artifact (same cleanup as the TUI's Models tab).
    """
    out = out or sys.stdout

    def emit(line: str) -> None:
        out.write(line + "\n")
        out.flush()

    if _TUI_IMPORT_ERROR is not None:
        emit("FAILED voxtype-tui-missing")
        return 1
    paths = _paths()
    _apply_env_overrides(paths)
    models = _import_models(paths)
    if engine not in models.MODEL_CATALOG:
        emit(f"FAILED unknown engine {engine!r}")
        return 1
    if not _MODEL_NAME_RE.match(name):
        emit(f"FAILED invalid model name {name!r}")
        return 1
    if shutil.which("voxtype") is None:
        emit("FAILED voxtype binary not found")
        return 1

    argv = ["voxtype", "setup", "--download", "--model", name]
    emit("LOG $ " + " ".join(argv))
    try:
        # bufsize=0: raw pipe, so read(256) returns whatever is available
        # instead of blocking until 256 bytes have accumulated. That is
        # what makes the progress lines stream in real time.
        proc = subprocess.Popen(
            argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, bufsize=0,
        )
    except OSError as e:
        emit(f"FAILED could not launch voxtype: {e}")
        return 1

    cancelled = False

    def _cancel(signum, _frame) -> None:
        nonlocal cancelled
        cancelled = True
        try:
            proc.terminate()
        except ProcessLookupError:
            pass

    signal.signal(signal.SIGTERM, _cancel)
    signal.signal(signal.SIGINT, _cancel)

    assert proc.stdout is not None
    buffer = b""
    last_pct: float | None = None
    while True:
        chunk = proc.stdout.read(256)
        if not chunk:
            break
        buffer += chunk
        units, buffer = models.split_terminal_output(buffer)
        for text, is_newline in units:
            pct = models.parse_percent(text)
            if pct is not None and pct != last_pct:
                last_pct = pct
                emit(f"PROGRESS {pct:g}")
            if is_newline and text.strip():
                emit(f"LOG {text.strip()}")
    if buffer:
        text = models.strip_ansi(buffer.decode(errors="replace"))
        pct = models.parse_percent(text)
        if pct is not None and pct != last_pct:
            emit(f"PROGRESS {pct:g}")
        if text.strip():
            emit(f"LOG {text.strip()}")

    try:
        code = proc.wait(timeout=3.0)
    except subprocess.TimeoutExpired:
        proc.kill()
        code = proc.wait()

    if cancelled:
        partial = models.model_file_path(engine, name, models_dir=paths.models_dir)
        if partial.exists():
            try:
                if partial.is_dir():
                    shutil.rmtree(partial)
                else:
                    partial.unlink()
                emit(f"LOG removed partial {partial.name}")
            except OSError as e:
                emit(f"LOG could not remove partial: {e}")
        emit("FAILED cancelled")
        return 1
    if code == 0:
        emit("DONE")
        return 0
    emit(f"FAILED exit {code}")
    return 1


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None, stdin=None, stdout=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout

    if argv and argv[0] == "--download":
        if len(argv) != 3:
            stdout.write("FAILED usage: bridge.py --download <engine> <name>\n")
            return 1
        return run_download(argv[1], argv[2], out=stdout)

    if _TUI_IMPORT_ERROR is not None:
        stdout.write(json.dumps({"ok": False, "error": "voxtype-tui-missing"}) + "\n")
        stdout.flush()
        return EXIT_TUI_MISSING

    raw = stdin.read(MAX_REQUEST_BYTES + 1)
    if len(raw) > MAX_REQUEST_BYTES:
        response: dict[str, Any] = {"ok": False, "error": "request too large"}
    elif not raw.strip():
        response = {"ok": False, "error": "empty request", "ops": sorted(OPS)}
    else:
        try:
            request = json.loads(raw)
        except ValueError as e:
            response = {"ok": False, "error": f"invalid JSON request: {e}"}
        else:
            # handle() validates the shape itself (null/true/1/"x"/[] all
            # become {"ok": false, "error": "request must be a JSON object"}).
            response = handle(request)
    stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
    stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
