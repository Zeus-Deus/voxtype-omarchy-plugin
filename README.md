# Voxtype for Omarchy

A bar widget for **Omarchy Quattro** that manages [Voxtype](https://github.com/peteonrails/voxtype), Omarchy's bundled voice-to-text daemon: record, restart, vocabulary, dictionary rules, every setting, model downloads and backups — without opening `config.toml`.

It is a native shell plugin built against the official Quattro plugin contract. It does not start another Quickshell instance and is not a first-party Omarchy product or an approved marketplace listing.

The panel is a thin QML front end over the installed **voxtype-tui** Python package. Every write goes through `voxtype_tui` (validated, atomic, comment-preserving saves; sidecar reconcile; sync bundle), so the panel and the TUI never disagree.

## What the panel does

- **Bar button** with the live daemon state: idle, recording (accent), transcribing, stopped. Left-click opens the panel, right-click toggles recording, middle-click restarts a stale daemon. The tooltip is the hero line.
- **Dictate** — status card (state, engine + model, hotkey, output mode), Record and Restart buttons, a missing-model banner, and a *test a phrase* field that shows what the dictionary engine would type.
- **Vocabulary** — search/add field (Enter adds), token meter `n / 224` (amber at 200, urgent at 224), delete on the cursor row (`x`, confirmed).
- **Dictionary** — add `from → to` with a category chip, search, `c` cycles category, `x` deletes (confirmed).
- **Settings** — engine & model, hotkey (key, modifier chips, mode, enabled), audio (device, max duration, feedback theme/volume), output (mode, fallback, auto-submit, smart auto-submit, spoken punctuation, type delay), voice activity, post-processing, remote Whisper (endpoint, model, timeout, *API key is set* indicator + Clear — the key is never entered or shown here), GPU (backend status, device drop-in, Enable/Disable acceleration handed to your terminal for `sudo`). Changes are written immediately and validated by the bridge; restart-sensitive ones light **Restart to apply**.
- **Models** — per-engine catalog with size and state, set active, download with progress and log tail (cancellable), delete (confirmed; refuses the active model). **Export…** writes a voxtype-tui bundle (secrets off by default); **Import…** opens a file chooser, previews the diff with dangerous rows highlighted, and asks before applying.
- Honest states: Voxtype not installed, voxtype-tui missing, installed but not set up (copyable `voxtype setup` hint — never run for you), daemon stopped, stale config, model missing, empty lists, bridge errors in the footer.

## Keyboard

`1`–`5` jump to a section, `Tab`/`Shift+Tab` cycle, `↑↓`/`j k` move the cursor, `Enter`/`Space` activate, `←→` nudge sliders, `/` or `Ctrl+F` focus search, `a` add, `c` cycle category, `d` download, `u` reset a setting to its default, `x` delete, `r` toggle recording, `Ctrl+R` restart the daemon, `Esc` leaves a field, then closes the panel.

## Dependencies

An installed Omarchy Quattro shell (`qs.Ui` / `qs.Commons`), `voxtype`, `/usr/bin/python3` with the `voxtype-tui` package (AUR: `voxtype-tui`), `zenity` for the import file chooser, `wl-copy` (wl-clipboard) for the copy buttons, and `omarchy-launch-terminal` for the GPU sudo hand-off. The panel says so in place when zenity or the terminal launcher is missing. Git is needed for plugin-manager installation. Node.js and pytest are only needed for the development tests.

No npm/pip packages, root privileges, background service, build step or vendored binaries. Nothing runs at install time.

## Install

```bash
omarchy plugin add https://github.com/Zeus-Deus/voxtype-omarchy-plugin.git --enable --yes
```

or from a local checkout: `omarchy plugin add "$PWD" --yes --enable`. The widget lands in the right bar section; move it with `omarchy bar move`. Settings (poll interval, right-click records) live under Setup › Plugins.

## Security

Plugins run unsandboxed inside `omarchy-shell`, so:

- **This plugin makes no network connections of its own: no telemetry, no
  analytics, no version check.** The only thing that touches the network is the
  `voxtype` binary when you ask for a model download; the plugin just spawns it
  with a fixed argv and relays its progress output. Nothing else leaves your
  machine.
- It never touches your audio or your transcripts. It edits configuration,
  vocabulary and dictionary rules, and reads the daemon's state file.
- Every process is a fixed argv array. Untrusted strings travel over stdin as
  JSON, never through a shell. There is no `shell=True`, `eval` or string-built
  command anywhere in the plugin.
- The bridge response is capped at 2 MB and parsed strictly; a non-zero exit is
  never read as success.
- The remote API key is never read back into QML; the bridge only reports
  whether one is set. Clearing it is a normal `settings.unset`.
- Sudo-needing actions (GPU enable/disable) are handed to your own terminal via
  `omarchy-launch-terminal`, with a fixed argv in which no element is
  user-influenced. The panel has no password field and the shell never sees a
  credential.
- Export defaults to no secrets and can only write inside your home directory,
  to a `.json` path.
- Import defaults to **vocabulary and rules only**: settings from a bundle are
  opt-in behind a checkbox, the preview shows every row that would change, and
  dangerous changes (anything that runs a command, repoints transcription or
  moves where audio and text are written) must be accepted explicitly. The
  plugin keeps its own dangerous-path list as a superset of upstream's, so a
  gap there cannot silently widen the hole here.
- Destructive actions confirm with **Cancel** selected by default.

## Uninstall

```bash
omarchy plugin remove io.github.zeus-deus.voxtype
```

That removes the plugin and its bar widget. It does not touch Voxtype itself,
your `config.toml`, your vocabulary or your dictionary rules — the plugin keeps
no state of its own outside the shell's plugin settings (poll interval,
right-click-records).

## Development

```bash
node --test tests/*.test.js
uv run --python /usr/bin/python3 --with pytest pytest -q tests/test_bridge.py
qmllint -I /usr/share/omarchy/shell BarWidget.qml Panel.qml Service.qml VoxtypeIcon.qml
omarchy plugin validate .
omarchy-restart-shell && qs log -p /usr/share/omarchy/shell --tail 60
```

`docs/DESIGN.md` is the specification, including the bridge protocol. `AGENTS.md` records the conventions and traps.

## License

MIT — see `LICENSE`.
