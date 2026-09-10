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

Every request: `{"op": "<name>", ...args}`. Failures from an op carry
`{ok:false, error, op}`; an unknown op adds `ops:[...]` (the registry).
All writes go through
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
| `status` | — | `{ok, voxtype_installed, tui_version, daemon:{active, active_state, state:"idle"|"recording"|"transcribing"|"stopped", main_pid, started_at, start_monotonic_us, stale, ready, systemctl_available}, engine, model:{name, path, present}, hotkey:{key, modifiers:[], mode, enabled}, output_mode, config_path, config_exists, state_file_path, terminal_launcher_available, picker_available, tui_open_pid, warnings?:[str]}` — **must be fast (<150 ms)**: no `voxtype setup` calls, no Textual import, one `systemctl --user show` call. `stale` = config.toml **or** the GPU drop-in mtime > `ExecMainStartTimestampMonotonic`-derived start (or fallback: mtime > `started_at`). `ready` = state file holds idle/recording/transcribing (false when the file is missing or `state_file = "disabled"`). `systemctl_available=false` when `systemctl` is missing or fails (daemon then reads as stopped). `config_exists=false` (with `engine:"whisper"`, `model.name:null`) when config.toml is absent; a corrupt config adds `warnings`. `state_file_path` = the config's `state_file` resolved: `"auto"`/missing → `$XDG_RUNTIME_DIR/voxtype/state` (or `/run/user/<uid>/voxtype/state`), explicit path → that path (`~` expanded), `"disabled"` → `null` — the bar button polls exactly this path. `terminal_launcher_available` = `omarchy-launch-terminal` on PATH (GPU enable/disable buttons); `picker_available` = `zenity` on PATH (Import… button). `tui_open_pid` = PID of a running voxtype-tui holding `~/.config/voxtype-tui/.lock` (`-1` if the holder is unknown, `null` when nobody does); while non-null every write op answers `{ok:false, error:"voxtype-tui is open (pid N) — …", tui_open_pid}` without touching disk, because the TUI buffers edits until Ctrl+S and then rewrites the whole config. |
| `load` | — | `{ok, snapshot}` where snapshot = `{vocabulary:[{phrase, added_at}], vocab_tokens:int, vocab_token_limit:224, replacements:[{from, to, category}], categories:["Replacement","Capitalization"], settings:{<dotted path>: value ...}, restart_sensitive:[paths], warnings:[str], migrations_applied:[str], sync:{applied_from, conflicts:[...], missing_model}}`. `settings` contains every key `voxtype_tui.settings` maps (engine, whisper.model, whisper.language, per-engine model keys, hotkey.*, audio.device/max_duration_secs/feedback.*, output.mode/fallback_to_clipboard/auto_submit/type_delay_ms, text.spoken_punctuation/smart_auto_submit, vad.*, output.post_process.command/timeout_ms, whisper.remote_endpoint/remote_model/remote_timeout_secs, and `whisper.remote_api_key_set: bool` — **never the key itself**). Missing keys are omitted (UI shows voxtype default). Missing config.toml → `ok:false` ("not found … run `voxtype setup`"). |
| `options` | — | `{ok, engines:[name], compiled_engines:[name], models_per_engine:{engine:[name]}, model_paths:{engine: "whisper.model"}, hotkey_modifiers:[...], hotkey_modes:[...], output_modes:[...], audio_devices:[{label, name}], feedback_themes:[...], gpu_vendors:[{label,value}]}` — may take a few seconds (`compiled_engines`, `pactl`). QML caches it per panel open. |
| `models.list` | `{engine}` | `{ok, engine, active:name|null, models:[{name, size_mb, on_disk_bytes|null, downloaded, unknown, active, path}], models_dir, total_bytes}` (catalog ∪ unknown files on disk, via `voxtype_tui.models`; `total_bytes` = disk usage of the whole models dir). |
| `gpu.status` | — | `{ok, text, backend, gpus:[{vendor,label}], device: "auto"|"nvidia"|"amd"|"intel", dropin_path, error?}` from `voxtype setup gpu --status` + `gpu.read_gpu_device`; on failure `ok:false` with `error` but `device`/`dropin_path` still filled. |
| `dictionary.preview` | `{text}` | `{ok, input, output, rules:int}` — runs `voxtype_tui.dictionary_engine` over current rules; lets the user test a phrase. |
| `export.preview` | `{scope:"sync"|"sync+local", include_secrets:bool}` (defaults `"sync"`, `false`) | `{ok, default_path, scope, include_secrets, counts:{vocabulary, replacements, settings, local, secrets, secrets_available}}` — `secrets` is 0 unless `include_secrets`; `secrets_available` is how many secret fields exist on disk. |
| `import.preview` | `{path, include_local, include_settings}` (defaults `false`, `true`) | `{ok, format, source, has_local, include_local, warnings:[...], dangerous:[paths], diff:{vocab_add:[], vocab_remove:[] (always empty — import merges, never removes), vocab_unchanged:[], replacements_add:[{from,to}], replacements_change:[{from,old,new}], settings_change:[row]}}`. A `settings_change` row is `{path, old, new, dangerous}` **except** for the secret paths `whisper.remote_api_key`, `output.post_process.command`, `output.pre_output_command`, `output.post_output_command`, which are emitted **redacted** as `{path, dangerous:true, redacted:true, old_set:bool, new_set:bool}` with no `old`/`new` (the panel shows "API key: set → set", never the value). Files larger than `sync.MAX_BUNDLE_BYTES` (1 MB) are refused by `stat()` before any byte is read (`ok:false, error:"file is N bytes; limit …"`). |

### Write ops

Every write op returns `{ok, snapshot, restart_needed:[paths], daemon_stale:bool, ...extra}`.
`restart_needed` lists the restart-sensitive paths that changed;
`daemon_stale` is true for **any** config.toml write (voxtype reads its
config once at start), so the panel lights the "Restart to apply" pill on
`daemon_stale`, not only on `restart_needed`. Sidecar-only writes
(`dict.set_category`) and non-config writes (`models.delete`,
`export.write`) return `restart_needed:[]`, `daemon_stale:false`.

| op | args | extra result keys |
|---|---|---|
| `vocab.add` | `{phrase}` (rejects empty/duplicate → `ok:false`) | — |
| `vocab.remove` | `{phrase}` (unknown → `ok:false`) | — |
| `vocab.set` | `{phrases:[...]}` (bulk reorder/edit; trims, dedupes, drops blanks) | — |
| `dict.upsert` | `{from, to, category?}` (default category `Replacement`) | — |
| `dict.remove` | `{from}` | — |
| `dict.set_category` | `{from, category}` | `changed:bool` |
| `settings.set` | `{path, value}` — value typed as JSON (bool/int/float/string/list). `path` must be in the allow-list derived from `voxtype_tui.settings`; unknown path → `ok:false`. `whisper.remote_api_key` is **refused** (`ok:false`, error points at `VOXTYPE_WHISPER_API_KEY` / config.toml) — only `settings.unset` may touch it. `null`/`""` value = unset. Setting `engine` also guarantees the required sections exist. Model paths (`whisper.model` etc.) must name a downloaded model or an existing absolute file. | `path, value` |
| `settings.unset` | `{path}` (revert to voxtype default) | `path, changed:bool` |
| `models.set_active` | `{engine, name}` — refuses a model that is not downloaded. | `engine, name` |
| `models.delete` | `{engine, name}` — refuses the active model (`ok:false, error`). | `engine, name, freed_bytes` |
| `gpu.set_device` | `{vendor: "auto"|"nvidia"|"amd"|"intel"}` → writes drop-in via `gpu.write_gpu_device`, runs `daemon_reload`; always `restart_needed:["gpu.device"]`, `daemon_stale:true`. | `device, dropin_path, daemon_reload:{ok, message}` |
| `export.write` | `{path?, scope:"sync"|"sync+local", include_secrets:bool}` (default path = `export.preview.default_path`) | `path, bytes, scope, include_secrets` |
| `import.apply` | `{path, include_local, include_settings, accept_dangerous}` — refuses (`ok:false, error:"dangerous-changes", dangerous:[paths], diff, warnings`) when the diff has dangerous changes and `accept_dangerous` is false. `include_settings:false` imports vocabulary/replacements only. | `format, applied:<diff, same shape and redaction as import.preview>, warnings` |

### Daemon ops

| op | args | result |
|---|---|---|
| `daemon.restart` | `{timeout?}` — seconds for the post-restart ready wait, default **18**, clamped to 0–60 | uses `voxtype_cli.restart_daemon` (itself capped at 15 s) then `wait_for_daemon_ready` (≤ `timeout`) → `{ok, main_pid_before, main_pid_after, changed:bool, ready:bool, ready_timeout, active:bool, message}`; `ok` only if PID or start-timestamp actually changed (`changed`); `ready` is whether the state file reported idle/recording/transcribing before the timeout. **QML sends `timeout: 18` and kills the process at a 30 s deadline**; if the deadline fires the panel treats it as "restart issued, readiness unknown" and re-polls `status`. |
| `daemon.start` / `daemon.stop` | — | `systemctl --user start|stop voxtype` → `{ok, message, daemon:{active, active_state, main_pid, started_at, start_monotonic_us}, error?}` (`error` only when `ok:false`). |
| `record.toggle` | — | `voxtype record toggle` → `{ok, message}`; on failure `{ok:false, error}` where `error` is the CLI's stderr (ANSI stripped), suffixed with "(daemon is not running)" when the unit is inactive, or `"voxtype record toggle exited N"` when the CLI was silent. Kept for the panel's Record button; the bar button may use it too. |

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
  The bridge enforces the same cap on its side: a response that would
  serialise above `MAX_RESPONSE_BYTES` is replaced by
  `{ok:false, error:"response too large", op, limit_bytes}`.
