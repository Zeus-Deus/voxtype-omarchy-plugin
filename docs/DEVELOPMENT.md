# Voxtype for Omarchy — Development Notes

Conventions, invariants and traps for anyone working on this plugin's source.
This is reference documentation for contributors; it is not a runtime component
and nothing here is executed by the plugin.

## Architecture

- `BarWidget.qml` — bar button + nested panel loader (same pattern as the sibling Drafts plugin). Polls the daemon state file only; never runs the bridge.
- `Panel.qml` — one `KeyboardPanel`: hero, five sections (Dictate, Vocabulary, Dictionary, Settings, Models), key-hint footer, `ConfirmDialog`. Content lives in a `Flickable` because `KeyboardPanel` does not scroll.
- `Service.qml` — every external process: the bridge worker (JSON on stdin), the download streamer, `voxtype record toggle`, the zenity picker, and the detached terminal for the GPU sudo hand-off. All argv arrays; no `bash -c`.
- `EditField.qml` — the only editable input. Never use the kit `TextField`/`NumberField` (or any TextInput-based control) here: see Hard rule 10.
- `Model.js` — pure helpers, no Qt imports (Node-testable): response parsing with the 2 MB cap, sanitising, diff summaries, hints, byte formatting.
- `bridge.py` — stateless JSON-over-stdio CLI that imports the installed `voxtype_tui` package. It never re-implements TOML writes, sidecar reconcile, migrations, sync/export/import, GPU drop-ins or the model catalog. Protocol: `docs/DESIGN.md` (kept in sync with the code — update it in the same commit as any shape change).

## Hard rules

1. `whisper.remote_api_key` never reaches QML, argv, env, logs or the import diff. The bridge reports only `whisper.remote_api_key_set`; `settings.set` refuses the key; import diff rows for secret paths are `redacted: true` with no `old`/`new`.
2. Untrusted strings (phrases, rules, model names, bundle contents, bridge errors) go through `Model.sanitize` before rendering or entering a `ConfirmDialog` message; every `Text` declares `textFormat: Text.PlainText`.
3. Every `ConfirmDialog` open sets `selectedIndex = 0` (Cancel) and blocks the `PanelKeyCatcher`.
4. External GUIs (zenity, terminal) are launched only after `controller.hide()`; `resumeAfterPick()` refuses to re-show once another widget owns the bar popout.
5. Sudo is never handled in QML or the bridge: GPU enable/disable is a detached `omarchy-launch-terminal sudo voxtype setup gpu --enable|--disable`.
6. No hard-coded colours, fonts, radii or margins — `Commons.Color.*`, `Style.*`, `bar ? bar.foreground : Commons.Color.foreground`. Always write `Commons.Color` (with `import qs.Commons as Commons`), never a bare `Color.`: Qt 6.12's built-in QtQuick `Color` singleton shadows it and every theme colour becomes undefined.
7. `status` must stay fast (<150 ms, Textual-free, no `voxtype setup` calls); it is polled every 2 s while the panel is open.
8. Write ops are refused while the TUI holds `~/.config/voxtype-tui/.lock` (`bridge.WRITE_OPS`, `tui_lock_holder`): the TUI buffers edits until Ctrl+S and then rewrites the whole config, so a concurrent panel write would be lost. `status.tui_open_pid` drives the Dictate notice.
9. Recording toggles through the direct `voxtype record toggle` Process for latency; the bridge `record.toggle` op stays as the error-reporting fallback.
10. The shell never reads the clipboard. Editable fields are `EditField.qml`; paste is `Service.paste()` → `bridge.py --paste` (16 KB, 2 s total, process group killed). `tests/clipboard.test.js` fails on any TextInput-based control in shipped QML.

## Gates

```bash
node --test tests/*.test.js
uv run --python /usr/bin/python3 --with pytest pytest -q tests/   # /usr/bin/python3 has no pytest module
# Extra models (Qwen3-ASR, quantized whisper) need a voxtype-tui that has them; run the suite
# against both the released package (those tests skip) and a checkout:
#   env PYTHONPATH=<voxtype-tui checkout> uv run --python /usr/bin/python3 --with pytest pytest -q tests/test_bridge.py
qmllint -I /usr/share/omarchy/shell BarWidget.qml Panel.qml Service.qml VoxtypeIcon.qml EditField.qml   # exit 0, empty output (syntax only)
# Semantic lint: the Qt 6 linter with the shell importable as `qs`:
#   d=$(mktemp -d) && ln -s /usr/share/omarchy/shell "$d/qs" && /usr/lib/qt6/bin/qmllint -I "$d" -I /usr/lib/qt6/qml Panel.qml
# Expected noise only: unqualified access inside inline components, Style.font.* / bar.* missing-property, onExited handler parameters.
omarchy plugin validate .
```

Bridge tests run only against temporary config/sidecar/models/HOME trees via the
`VOXTYPE_CONFIG`, `VOXTYPE_TUI_SIDECAR`, `VOXTYPE_MODELS_DIR` and `HOME` overrides,
with a fake `voxtype` on `PATH`. They never touch `~/.config/voxtype`. The fixture also
points `XDG_CONFIG_HOME` / `XDG_DATA_HOME` into the temp HOME, because voxtype-tui writes
the Qwen3-ASR unit, its hotwords file and the CrispASR build there.

## Startup sync acceptance boundary

`AppState.load` in both voxtype-tui v0.1.8 and v0.1.9 calls
`sync.reconcile_sync_on_startup`: a newer cross-device bundle is not covered
by the same-device drift guard, and an unrelated save persists the resulting
in-memory settings. Never call it unguarded from a bridge operation.
`_load_state` temporarily wraps the public `sync.read_sync_bundle`, deep-copies
its result, filters every path in `_dangerous_setting_paths()` union
`REDACTED_IMPORT_PATHS`, and excludes the entire secrets block. Safe siblings,
vocabulary, replacement rules and upstream reconciliation guards remain intact.
Filter before reconciliation, not after: upstream formats proposed values
and may regenerate the sync cache during same-device drift handling.

The reader is restored in `finally`, including reader/reconciler exceptions.
This is a synchronous, one-request-per-process bridge, not a concurrent
in-process dependency API. Explicit Import uses `sync.load_bundle_file` and
must see the original bundle, including when the selected file is `sync.json`.
Ignored dangerous peer settings are never queued for later acceptance: a save
regenerates sync.json from local accepted state. The dependency's fixed trusted
postprocessor remains available; tests never execute fixture commands.

Security regressions cover load plus unrelated settings/vocabulary saves,
fresh JSON-over-stdio subprocesses, every dangerous path present/absent locally,
parent/subtree replacement, upstream path-set growth, secrets-block injection,
failed/refused/accepted imports, hook restoration and post-download activation
with synthetic already-present model bytes. This is bridge/protocol proof,
not native shell, real daemon, network download or transcription E2E.

For v0.1.9, isolated test configs/sidecars must use default-shaped paths under
the fixture HOME and cached `CONFIG_PATH` / `SIDECAR_PATH` must be repointed:
alternate files intentionally cannot manage the default Qwen3 helper service.
The synthetic health server identifies `backend: qwen3`; helper teardown tests
assert files remain until a fake verified restart, matching the released API.
Run against immutable `git archive` extractions of both tags with command-local
`PYTHONPATH`, private HOME/XDG/TMP roots, and an owned copied uv cache:

```bash
uv run --offline --python /usr/bin/python3 --with pytest \
  --with 'textual>=8.0,<9' --with 'tomlkit>=0.13' \
  pytest -q -p no:cacheprovider tests/test_bridge.py
node --test tests/*.test.js
```

## Live verification

Install from the checkout with `omarchy plugin add "$PWD" --yes --enable`; later
commits need `git pull` in `~/.config/omarchy/plugins/io.github.zeus-deus.voxtype`.
`Panel.qml` edits need `omarchy-restart-shell`; then `qs log -p /usr/share/omarchy/shell --tail 80`
must show no errors, warnings or binding loops from this plugin. Open with
`omarchy-shell shell summon io.github.zeus-deus.voxtype '{}'`.

A restart claim is only proven by `systemctl --user show voxtype -p MainPID` changing
before/after. A model download rewrites `config.toml` to make the new model active —
set the previous model active again after testing. Use clearly marked QA entries and
remove them; compare `config.toml` / `metadata.json` against a held SHA-256 manifest
afterwards.

## Not exercised live

GPU enable/disable (sudo), import into a real config, the zenity/terminal-missing
states, the not-set-up locked state and the foreign-popout chooser race are covered
by tests only.
