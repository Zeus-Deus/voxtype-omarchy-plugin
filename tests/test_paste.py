"""Tests for ``bridge.py --paste``, the bounded clipboard reader.

The panel's fields never let Qt read the Wayland clipboard inside the shell;
a paste runs this reader as a child process instead. Every test puts a fake
``wl-paste`` alone on PATH (absolute paths inside it), so the real clipboard
is never read and a missing fake cannot fall through to the real binary.

Run:  uv run --python /usr/bin/python3 --with pytest pytest -q tests/test_paste.py
"""
from __future__ import annotations

import json
import os
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

PY = sys.executable


def _fake(tmp_path: Path, body: str) -> dict[str, str]:
    """Install a fake wl-paste and return an environment that finds only it."""
    bindir = tmp_path / "bin"
    bindir.mkdir(exist_ok=True)
    script = bindir / "wl-paste"
    script.write_text("#!/bin/sh\n" + f"printf '%s\\n' \"$*\" >> {tmp_path}/argv.log\n" + body)
    script.chmod(0o755)
    env = {k: v for k, v in os.environ.items() if not k.startswith(("WAYLAND", "XDG_RUNTIME"))}
    env["PATH"] = str(bindir)
    return env


def _paste(env: dict[str, str], timeout: float = 15) -> tuple[subprocess.CompletedProcess, float]:
    t0 = time.monotonic()
    r = subprocess.run([PY, "-P", str(BRIDGE), "--paste"], env=env, capture_output=True, timeout=timeout)
    return r, time.monotonic() - t0


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    # A zombie still answers kill(0); it no longer runs anything.
    try:
        return Path(f"/proc/{pid}/stat").read_text().split(") ")[1][0] != "Z"
    except OSError:
        return False


def test_limits_match_the_panel():
    model = (REPO / "Model.js").read_text()
    assert f"var PASTE_MAX_BYTES = {bridge.PASTE_MAX_BYTES};" in model
    assert f"var PASTE_TIMEOUT_MS = {int(bridge.PASTE_TIMEOUT_SECONDS * 1000)};" in model
    assert f"var PASTE_EXIT_TOO_LARGE = {bridge.PASTE_EXIT_TOO_LARGE};" in model
    assert f"var PASTE_EXIT_TIMEOUT = {bridge.PASTE_EXIT_TIMEOUT};" in model
    assert bridge.PASTE_MAX_BYTES <= 16384 and bridge.PASTE_TIMEOUT_SECONDS <= 2


def test_plain_text_is_printed_exactly_with_a_fixed_argv(tmp_path):
    env = _fake(tmp_path, "printf 'hello wörld'\n")
    r, _ = _paste(env)
    assert r.returncode == 0
    assert r.stdout.decode() == "hello wörld"
    assert (tmp_path / "argv.log").read_text().splitlines() == ["--no-newline --type text"]


def test_exactly_the_cap_is_accepted(tmp_path):
    env = _fake(tmp_path, f"/usr/bin/head -c {bridge.PASTE_MAX_BYTES} /dev/zero | /usr/bin/tr '\\0' a\n")
    r, _ = _paste(env)
    assert r.returncode == 0
    assert len(r.stdout) == bridge.PASTE_MAX_BYTES


def test_one_byte_over_the_cap_prints_nothing(tmp_path):
    env = _fake(tmp_path, f"/usr/bin/head -c {bridge.PASTE_MAX_BYTES + 1} /dev/zero | /usr/bin/tr '\\0' a\n")
    r, _ = _paste(env)
    assert r.returncode == bridge.PASTE_EXIT_TOO_LARGE
    assert r.stdout == b""


def test_an_endless_stream_stops_at_the_cap_with_bounded_memory(tmp_path):
    env = _fake(tmp_path, "exec /usr/bin/yes AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n")
    probe = (
        "import resource, subprocess, sys, time\n"
        "t = time.monotonic()\n"
        f"r = subprocess.run([{PY!r}, '-P', {str(BRIDGE)!r}, '--paste'], capture_output=True)\n"
        "print(r.returncode, len(r.stdout), round(time.monotonic() - t, 3),\n"
        "      resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss)\n"
    )
    out = subprocess.run([PY, "-c", probe], env=env, capture_output=True, text=True, timeout=30)
    code, size, seconds, peak_kb = out.stdout.split()
    assert int(code) == bridge.PASTE_EXIT_TOO_LARGE
    assert int(size) == 0
    assert float(seconds) < bridge.PASTE_TIMEOUT_SECONDS
    assert int(peak_kb) < 64 * 1024, f"peak RSS {peak_kb} KB"


def test_a_clipboard_owner_that_never_finishes_hits_the_total_deadline(tmp_path):
    # A drip: one byte every 0.2 s forever. Qt's own reader only times out
    # when a single read waits over 1 s, so it would wait without end here.
    env = _fake(tmp_path, "while :; do printf a; /usr/bin/sleep 0.2; done\n")
    r, seconds = _paste(env)
    assert r.returncode == bridge.PASTE_EXIT_TIMEOUT
    assert r.stdout == b""
    assert bridge.PASTE_TIMEOUT_SECONDS - 0.2 < seconds < bridge.PASTE_TIMEOUT_SECONDS + 1.5


def test_a_silent_owner_hits_the_deadline_and_its_whole_group_is_killed(tmp_path):
    # wl-paste hands the pipe to a grandchild that never writes or exits.
    pidfile = tmp_path / "grandchild.pid"
    env = _fake(tmp_path, f"/usr/bin/sleep 300 & echo $! > {pidfile}\nwait\n")
    r, seconds = _paste(env)
    assert r.returncode == bridge.PASTE_EXIT_TIMEOUT
    assert seconds < bridge.PASTE_TIMEOUT_SECONDS + 1.5
    pid = int(pidfile.read_text())
    for _ in range(50):
        if not _alive(pid):
            break
        time.sleep(0.05)
    try:
        assert not _alive(pid), "the stalled grandchild outlived the reader"
    finally:
        if _alive(pid):
            os.kill(pid, signal.SIGKILL)


@pytest.mark.parametrize("body", [
    "exit 0\n",                                              # empty clipboard
    "echo 'Nothing is copied' >&2; exit 1\n",                # wl-paste: no selection
    "echo 'No suitable type of content copied' >&2; exit 1\n",
    "printf 'half'; exit 3\n",                               # failed mid-way
])
def test_no_text_or_a_failed_read_prints_nothing(tmp_path, body):
    env = _fake(tmp_path, body)
    r, _ = _paste(env)
    assert r.returncode == bridge.PASTE_EXIT_NO_TEXT
    assert r.stdout == b""


def test_missing_wl_paste_is_no_text(tmp_path):
    env = {k: v for k, v in os.environ.items()}
    env["PATH"] = str(tmp_path / "empty")
    r, _ = _paste(env)
    assert r.returncode == bridge.PASTE_EXIT_NO_TEXT
    assert r.stdout == b""


def test_invalid_utf8_is_replaced_not_fatal(tmp_path):
    env = _fake(tmp_path, "printf 'ok\\377\\376end'\n")
    r, _ = _paste(env)
    assert r.returncode == 0
    assert r.stdout.decode() == "ok\ufffd\ufffdend"


def test_paste_needs_no_voxtype_tui_and_ignores_stdin(tmp_path):
    env = _fake(tmp_path, "printf 'x'\n")
    r = subprocess.run([PY, "-S", "-P", str(BRIDGE), "--paste"], env=env,
                       input=json.dumps({"op": "settings.set"}).encode(), capture_output=True, timeout=15)
    assert r.returncode == 0 and r.stdout == b"x"


def test_paste_is_only_reachable_as_the_sole_argument(tmp_path):
    env = _fake(tmp_path, "printf 'x'\n")
    r = subprocess.run([PY, "-P", str(BRIDGE), "--paste", "--type", "image/png"], env=env,
                       input=b"", capture_output=True, timeout=15)
    assert r.stdout != b"x"
    assert not (tmp_path / "argv.log").exists(), "extra arguments never reach wl-paste"
