# Voxtype for Omarchy — Agent Guide

## Architecture

- `BarWidget.qml` — bar button + nested panel loader (same pattern as the sibling Drafts plugin). Polls the daemon state file only; never runs the bridge.
- `Panel.qml` — one `KeyboardPanel`: hero, five sections (Dictate, Vocabulary, Dictionary, Settings, Models), key-hint footer, `ConfirmDialog`. Content lives in a `Flickable` because `KeyboardPanel` does not scroll.
- `Service.qml` — every external process: the bridge worker (JSON on stdin), the download streamer, `voxtype record toggle`, the zenity picker, and the detached terminal for the GPU sudo hand-off. All argv arrays; no `bash -c`.
- `Model.js` — pure helpers, no Qt imports (Node-testable): response parsing with the 2 MB cap, sanitising, diff summaries, hints, byte formatting.
- `bridge.py` — stateless JSON-over-stdio CLI that imports the installed `voxtype_tui` package. It never re-implements TOML writes, sidecar reconcile, migrations, sync/export/import, GPU drop-ins or the model catalog. Protocol: `docs/DESIGN.md` (kept in sync with the code — update it in the same commit as any shape change).

## Hard rules

1. `whisper.remote_api_key` never reaches QML, argv, env, logs or the import diff. The bridge reports only `whisper.remote_api_key_set`; `settings.set` refuses the key; import diff rows for secret paths are `redacted: true` with no `old`/`new`.
2. Untrusted strings (phrases, rules, model names, bundle contents, bridge errors) go through `Model.sanitize` before rendering or entering a `ConfirmDialog` message; every `Text` declares `textFormat: Text.PlainText`.
3. Every `ConfirmDialog` open sets `selectedIndex = 0` (Cancel) and blocks the `PanelKeyCatcher`.
4. External GUIs (zenity, terminal) are launched only after `controller.hide()`; `resumeAfterPick()` refuses to re-show once another widget owns the bar popout.
5. Sudo is never handled in QML or the bridge: GPU enable/disable is a detached `omarchy-launch-terminal sudo voxtype setup gpu --enable|--disable`.
6. No hard-coded colours, fonts, radii or margins — `Color.*`, `Style.*`, `bar ? bar.foreground : Color.foreground`.
7. `status` must stay fast (<150 ms, Textual-free, no `voxtype setup` calls); it is polled every 2 s while the panel is open.
8. Write ops are refused while the TUI holds `~/.config/voxtype-tui/.lock` (`bridge.WRITE_OPS`, `tui_lock_holder`): the TUI buffers edits until Ctrl+S and then rewrites the whole config, so a concurrent panel write would be lost. `status.tui_open_pid` drives the Dictate notice.
9. Recording toggles through the direct `voxtype record toggle` Process for latency; the bridge `record.toggle` op stays as the error-reporting fallback.

## Gates

```bash
node --test tests/*.test.js
uv run --python /usr/bin/python3 --with pytest pytest -q tests/test_bridge.py   # /usr/bin/python3 has no pytest module
qmllint -I /usr/share/omarchy/shell BarWidget.qml Panel.qml Service.qml VoxtypeIcon.qml   # exit 0, empty output (syntax only)
# Semantic lint: the Qt 6 linter with the shell importable as `qs`:
#   d=$(mktemp -d) && ln -s /usr/share/omarchy/shell "$d/qs" && /usr/lib/qt6/bin/qmllint -I "$d" -I /usr/lib/qt6/qml Panel.qml
# Expected noise only: unqualified access inside inline components, Style.font.* / bar.* missing-property, onExited handler parameters.
omarchy plugin validate .
```

Bridge tests run only against temporary config/sidecar/models/HOME trees via the
`VOXTYPE_CONFIG`, `VOXTYPE_TUI_SIDECAR`, `VOXTYPE_MODELS_DIR` and `HOME` overrides,
with a fake `voxtype` on `PATH`. They never touch `~/.config/voxtype`.

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
