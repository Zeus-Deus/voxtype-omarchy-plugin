# Voxtype for Omarchy — design & bridge protocol

Omarchy Quattro bar-widget plugin that manages **Voxtype** (Omarchy's bundled
voice-to-text daemon) end to end, so the user never has to touch
`~/.config/voxtype/config.toml`, `metadata.json`, systemd drop-ins or the
`voxtype` CLI by hand.

It is a **QML frontend over the installed `voxtype-tui` Python package**.
`voxtype-tui` (AUR, `/usr/lib/python3.*/site-packages/voxtype_tui`) already
owns every hard part — comment-preserving atomic saves pre-validated by
`voxtype -c <tmp> config`, sidecar reconcile, schema migrations, the
sync/export/import bundle with secret stripping, the GPU systemd drop-in, the
model catalog + download parser, the Vexis-parity dictionary engine, and a
restart that proves itself via `MainPID`. The plugin never re-implements any
of that; it ships `bridge.py`, a stateless JSON-over-stdio CLI that imports
`voxtype_tui` and exposes operations to QML.

```
manifest.json        id io.github.zeus-deus.voxtype, kind bar-widget
BarWidget.qml        bar button (mic glyph, live daemon state) + nested panel loader
Panel.qml            KeyboardPanel: hero, section tabs, rows, dialogs
Service.qml          Process wiring: bridge calls, streaming download, record toggle
VoxtypeIcon.qml      glyph drawn natively
Model.js             pure helpers, no Qt imports (Node-testable)
bridge.py            stdin JSON request -> stdout JSON response; imports voxtype_tui
tests/               node --test tests/*.test.js ; python -m pytest tests/
AGENTS.md README.md LICENSE
```

## Dependency / states the UI must design for

| State | Detection | UI |
|---|---|---|
| `voxtype` binary missing | bridge `status.voxtype_installed=false` | Locked hero: "Voxtype is not installed" + `omarchy install voxtype` hint (copy, never execute) |
| `voxtype_tui` package missing | bridge exits 3 / QML gets `{"ok":false,"error":"voxtype-tui-missing"}` | Locked hero: "Install voxtype-tui (AUR) to manage Voxtype here" |
| daemon stopped | `status.daemon.active=false` | Hero meta "Stopped", primary action **Start** |
| daemon stale (config newer than daemon start) | `status.daemon.stale=true` | Amber pill "Restart to apply" + **Restart** action; footer hint `Ctrl+R` |
| recording / transcribing | `status.daemon.state` | Bar glyph turns accent (recording) / pulses (transcribing); hero meta updates |
| model missing on disk | `status.model.present=false` | Urgent banner "Model large-v3 is not downloaded" + Download button (jumps to Models) |

## Bridge protocol

`python3 bridge.py` reads **one** JSON object on stdin, writes **one** JSON
object on stdout, exits 0. Every response has `ok: bool`; failures carry
`error: string` (human readable, no stack traces) and exit 0 unless the
process itself cannot run (missing interpreter/package → exit 3, stdout
`{"ok":false,"error":"voxtype-tui-missing"}`).

Every request: `{"op": "<name>", ...args}`. All writes go through
`voxtype_tui.state.AppState` → `save()` (validated, atomic, sidecar + sync
bundle) and return the **fresh snapshot** (`snapshot` key, same shape as
`load`) plus `restart_needed: [paths]` so the panel never has to guess. The
bridge is **stateless**: each call loads from disk.

Environment overrides for tests (never set in production): `VOXTYPE_CONFIG`
(config.toml path), `VOXTYPE_TUI_SIDECAR` (metadata.json path),
`VOXTYPE_MODELS_DIR`, and `HOME` (sync.json / gpu drop-in derive from it).

### Read ops

| op | args | result |
|---|---|---|
| `status` | — | `{voxtype_installed, tui_version, daemon:{active, state:"idle"|"recording"|"transcribing"|"stopped", main_pid, started_at, stale}, engine, model:{name, path, present}, hotkey:{key, modifiers:[], mode, enabled}, output_mode, config_path}` — **must be fast (<150 ms)**: no `voxtype setup` calls, one `systemctl --user show` call. `stale` = config.toml mtime > `ExecMainStartTimestampMonotonic`-derived start (or fallback: mtime > `started_at`). |
| `load` | — | `{snapshot}` where snapshot = `{vocabulary:[{phrase, added_at}], vocab_tokens:int, vocab_token_limit:224, replacements:[{from, to, category}], categories:["Replacement","Capitalization"], settings:{<dotted path>: value ...}, restart_sensitive:[paths], warnings:[str], migrations_applied:[str], sync:{applied_from, conflicts:[...], missing_model}}`. `settings` contains every key `voxtype_tui.settings` maps (engine, whisper.model, whisper.language, per-engine model keys, hotkey.*, audio.device/max_duration_secs/feedback.*, output.mode/fallback_to_clipboard/auto_submit/type_delay_ms, text.spoken_punctuation/smart_auto_submit, vad.*, output.post_process.command/timeout_ms, whisper.remote_endpoint/remote_model/remote_timeout_secs, and `whisper.remote_api_key_set: bool` — **never the key itself**). Missing keys are omitted (UI shows voxtype default). |
| `options` | — | `{engines:[name], compiled_engines:[name], models_per_engine:{engine:[name]}, model_paths:{engine: "whisper.model"}, hotkey_modifiers:[...], hotkey_modes:[...], output_modes:[...], audio_devices:[{label, name}], feedback_themes:[...], gpu_vendors:[{label,value}]}` — may take a few seconds (`compiled_engines`, `pactl`). QML caches it per panel open. |
| `models.list` | `{engine}` | `{engine, active, models:[{name, size_mb, on_disk_bytes|null, downloaded, unknown, active, path}]}` (catalog ∪ unknown files on disk, via `voxtype_tui.models`). |
| `gpu.status` | — | `{ok, text, backend, gpus:[{vendor,label}], device: "auto"|"nvidia"|"amd"|"intel", dropin_path}` from `voxtype setup gpu --status` + `gpu.read_gpu_device`. |
| `dictionary.preview` | `{text}` | `{input, output}` — runs `voxtype_tui.dictionary_engine` over current rules; lets the user test a phrase. |
| `export.preview` | `{scope, include_secrets}` | `{default_path, counts:{vocabulary, replacements, settings, local, secrets}}` |
| `import.preview` | `{path, include_local, include_settings}` (defaults `false`, `true`) | `{format, source, has_local, include_local, warnings:[...], dangerous:[paths], diff:{vocab_add:[], vocab_remove:[] (always empty — import merges, never removes), vocab_unchanged:[], replacements_add:[{from,to}], replacements_change:[{from,old,new}], settings_change:[row]}}`. A `settings_change` row is `{path, old, new, dangerous}` **except** for the secret paths `whisper.remote_api_key`, `output.post_process.command`, `output.pre_output_command`, `output.post_output_command`, which are emitted **redacted** as `{path, dangerous:true, redacted:true, old_set:bool, new_set:bool}` with no `old`/`new` (the panel shows "API key: set → set", never the value). Files larger than `sync.MAX_BUNDLE_BYTES` (1 MB) are refused by `stat()` before any byte is read (`ok:false, error:"file is N bytes; limit …"`). |

### Write ops (all return `{ok, snapshot, restart_needed:[...]}`)

| op | args |
|---|---|
| `vocab.add` | `{phrase}` (rejects empty/duplicate → `ok:false`) |
| `vocab.remove` | `{phrase}` |
| `vocab.set` | `{phrases:[...]}` (bulk reorder/edit) |
| `dict.upsert` | `{from, to, category}` |
| `dict.remove` | `{from}` |
| `dict.set_category` | `{from, category}` |
| `settings.set` | `{path, value}` — value typed as JSON (bool/int/float/string/list). `path` must be in the allow-list derived from `voxtype_tui.settings`; unknown path → `ok:false`. Setting `engine` also guarantees the required sections exist. |
| `settings.unset` | `{path}` (revert to voxtype default) |
| `models.set_active` | `{engine, name}` |
| `models.delete` | `{engine, name}` — refuses the active model (`ok:false, error`). |
| `gpu.set_device` | `{vendor: "auto"|"nvidia"|"amd"|"intel"}` → writes drop-in via `gpu.write_gpu_device`, runs `daemon_reload`; result includes `restart_needed:["gpu.device"]`. |
| `export.write` | `{path, scope:"sync"|"sync+local", include_secrets:bool}` → `{path, bytes}` |
| `import.apply` | `{path, include_local, accept_dangerous}` — refuses (`ok:false, error:"dangerous-changes"`) when the diff has dangerous changes and `accept_dangerous` is false. |

### Daemon ops

| op | args | result |
|---|---|---|
| `daemon.restart` | — | uses `voxtype_cli.restart_daemon` then `wait_for_daemon_ready` (≤20 s) → `{ok, main_pid_before, main_pid_after, ready:bool, message}`; `ok` only if PID or start-timestamp actually changed. |
| `daemon.start` / `daemon.stop` | — | `systemctl --user start|stop voxtype` |
| `record.toggle` | — | `voxtype record toggle` → `{ok}` |

### Streaming op (not JSON-response; used by a dedicated QML Process)

`python3 bridge.py --download <engine> <name>` runs `voxtype setup --download
--model <name>` and prints one line per progress unit: `PROGRESS <pct>`,
`LOG <text>`, and finally `DONE` or `FAILED <reason>`; exit 0/1. SIGTERM
cancels and removes the partial file (mirrors `voxtype_tui.models`).

## UI

One `KeyboardPanel` anchored to the bar button, `contentWidth ≈ Style.space(560)`,
`contentHeight ≈ Style.space(520)`, content in a `Flickable` (KeyboardPanel
does not scroll). Everything from the shipped kit: `PanelHero`,
`ButtonGroup` (section tabs), `PanelSectionHeader`, `PanelSeparator`,
`Toggle`/`ToggleSwitch`, `Dropdown`/`SearchableDropdown`, `TextField`,
`NumberField`, `PanelSlider`, `Button`, `PanelActionButton`, `CursorSurface`
rows, `ConfirmDialog` (always `selectedIndex = 0` on open; block the key
catcher while open). No hard-coded colours/fonts/radii — `Color.*`,
`Style.*`, `bar ? bar.foreground : Color.foreground`.

**Hero**: mic glyph (accent while recording), title "Voxtype", meta = daemon
line ("Listening · large-v3 · Super+Ctrl+X" / "Transcribing…" / "Stopped" /
"Restart to apply changes"), trailing control = primary action (Record /
Restart / Start).

**Sections** (ButtonGroup, keys `1–5`, `Tab`/`Shift+Tab` cycle):

1. **Dictate** — status card (state, engine+model, hotkey, output mode), big
   Record toggle, Restart daemon, missing-model banner, "test a phrase"
   field showing dictionary-engine output.
2. **Vocabulary** — search + add field (Enter adds), token meter
   `n / 224` (amber ≥ 200, urgent ≥ 224), cursor rows with delete action on
   the cursor row only (`x` → confirm).
3. **Dictionary** — add row (from → to, category chip), search, rows show
   `from → to` + category chip; `c` cycles category; `x` deletes (confirm).
4. **Settings** — grouped: Engine & model (engine dropdown; model dropdown
   built from `models.list`; language), Hotkey (key, modifier toggles, mode,
   built-in detect), Audio (device dropdown, max duration, feedback
   on/theme/volume slider), Output (mode, fallback, auto-submit, smart
   auto-submit, spoken punctuation, type delay), Voice activity (enable,
   threshold slider, model path), Post-processing (command, timeout),
   Remote (endpoint, model, timeout, "API key is set" indicator + Clear;
   **no key entry field** — point at `VOXTYPE_WHISPER_API_KEY`), GPU
   (backend text, detected GPUs, device dropdown → drop-in; Enable/Disable
   acceleration open a terminal running `sudo voxtype setup gpu --enable`
   after hiding the panel — never a password field). Every restart-sensitive
   change lights the "Restart to apply" pill; changes are written immediately
   (no separate Save — the bridge validates each write).
5. **Models** — engine dropdown, rows `name · size · downloaded/active`,
   actions: Set active, Download (progress bar + log tail, Cancel), Delete
   (confirm; refuses active). Backup/Import: **Export…** (scope + include
   secrets toggle, default `~/Downloads/voxtype-tui-export-YYYY-MM-DD.json`)
   and **Import…** (hide panel → zenity file chooser → preview diff with
   dangerous rows highlighted → confirm).

**Footer**: left = live notice / error (urgent) / "Saved · restart to apply";
right = key hints for the current section. Poll `status` every 2 s only
while the panel is open; the bar button polls the state file
(`/run/user/<uid>/voxtype/state`) via a cheap `FileView`/Process every 1.5 s.

**Bar button**: `󰍬` glyph; left-click toggles the panel, right-click runs
`record.toggle`, middle-click restarts when stale. Tooltip = hero meta.

## Security rules (unsandboxed shell plugin)

- Only argv arrays; untrusted strings go through stdin JSON, never
  interpolated into shell. `bash -c` is not used.
- The remote API key is never read back to QML; the bridge reports only
  `remote_api_key_set`. Clearing is `settings.unset`.
- Sudo-needing actions (GPU enable/disable) are handed to the user's
  terminal; the plugin never prompts for a password.
- Export defaults `include_secrets=false`; import refuses dangerous changes
  unless explicitly accepted after the preview. Secret rows in the preview
  (API key, shell-command hooks) are redacted to `old_set`/`new_set` — the
  bridge never emits their values in any response.
- Destructive actions (delete rule/word/model, import apply) go through
  `ConfirmDialog` defaulting to Cancel.
- Response bytes from the bridge are capped (2 MB) and parsed strictly.
