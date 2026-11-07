// Pure helpers for the Voxtype panel. No Qt imports: Node runs these directly
// (tests/model.test.js) and the QML side imports the same file.

var SECTIONS = ["home", "words", "history", "settings"];
var SECTION_LABELS = {home: "Home", words: "Words", history: "History", settings: "Settings"};
// Drill-in views and the section each one belongs to. Esc goes back to it.
var DRILLS = {usage: "home", models: "settings", advanced: "settings", backup: "settings"};
var DRILL_TITLES = {usage: "Usage", models: "Manage models", advanced: "All Voxtype settings", backup: "Backup"};
var NEEDS_TUI_02 = "needs voxtype-tui 0.2 or newer";
var TOKEN_LIMIT = 224;
var TOKEN_AMBER = 200;
var RESPONSE_CAP = 2 * 1024 * 1024;
var ERROR_TUI_MISSING = "voxtype-tui-missing";
var ERROR_PICKER_MISSING = "zenity is not installed — install it to import a bundle";
var ERROR_TERMINAL_MISSING = "omarchy-launch-terminal is not available — run sudo voxtype setup gpu in a terminal";

var MODIFIER_LABELS = {LEFTCTRL: "Ctrl", LEFTALT: "Alt", LEFTSHIFT: "Shift", LEFTMETA: "Super",
                       RIGHTCTRL: "Ctrl", RIGHTALT: "AltGr", RIGHTSHIFT: "Shift", RIGHTMETA: "Super"};

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// Lists read back from a QML `var` property (bridge data stored on the
// panel) arrive as Qt sequence objects: Array.isArray() is false for them in
// the running shell although they index like arrays. Test for a list with
// isList() and copy it into a real Array with toList() before using Array
// methods on it.
function isList(x) { return x !== null && x !== undefined && typeof x === "object" && typeof x.length === "number"; }
function toList(x) {
    var out = [];
    if (!isList(x)) return out;
    for (var i = 0; i < x.length; i++) out.push(x[i]);
    return out;
}

// Bridge output is attacker-influenced text from a child process: cap it,
// parse strictly, and never trust `ok` from a non-zero exit.
function parseResponse(text, code, timedOut) {
    if (timedOut) return {ok: false, error: "Voxtype bridge timed out."};
    var raw = String(text || "");
    if (raw.length > RESPONSE_CAP) return {ok: false, error: "Bridge response too large."};
    var result = null;
    try { result = JSON.parse(raw); } catch (_) { result = null; }
    if (!result || typeof result !== "object" || typeof result.ok !== "boolean") {
        if (code === 3) return {ok: false, error: ERROR_TUI_MISSING};
        return {ok: false, error: code === 0 ? "Bridge returned an unreadable response." : "Bridge could not run (exit " + code + ")."};
    }
    if (code !== 0 && result.ok) return {ok: false, error: "Bridge failed (exit " + code + ")."};
    if (!result.ok && typeof result.error !== "string") result.error = "The operation failed.";
    return result;
}

function isTuiMissing(result) { return !!result && result.ok === false && result.error === ERROR_TUI_MISSING; }

function hotkeyLabel(hotkey) {
    if (!hotkey || !hotkey.key) return "no hotkey";
    var parts = [];
    var mods = hotkey.modifiers || [];
    for (var i = 0; i < mods.length; i++) parts.push(MODIFIER_LABELS[mods[i]] || titleCase(mods[i]));
    parts.push(keyLabel(hotkey.key));
    return parts.join("+");
}

function modifierLabel(mod) { return MODIFIER_LABELS[mod] || titleCase(mod); }

function keyLabel(key) {
    var k = String(key || "").replace(/^KEY_/, "");
    if (k.length <= 1) return k.toUpperCase();
    var known = {SCROLLLOCK: "ScrollLock", CAPSLOCK: "CapsLock", NUMLOCK: "NumLock", PAUSE: "Pause", INSERT: "Insert",
                 SPACE: "Space", PRINT: "PrtSc", SYSRQ: "SysRq", RIGHTALT: "AltGr", COMPOSE: "Compose", MENU: "Menu"};
    if (known[k]) return known[k];
    if (/^F\d+$/.test(k)) return k;
    return titleCase(k);
}

function titleCase(s) { s = String(s || ""); return s.length ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s; }

// Hero meta / primary action. `status` is the bridge `status` result; null
// means not loaded yet. `error` is the panel's current bridge error text.
function daemonState(status) {
    if (!status || !status.daemon) return "unknown";
    if (!status.daemon.active) return "stopped";
    return status.daemon.state || "idle";
}

// On/off. "Off" is `systemctl --user stop`: the process exits, so the model
// leaves VRAM/RAM, and the unit stays enabled, so the next login starts it
// again. A unit systemd gave up on (crash loop) is `failed`, not off; one
// it is bringing up again after a crash is `activating`.
function daemonFailed(status) {
    return !!status && !!status.daemon && !status.daemon.active && status.daemon.active_state === "failed";
}

function daemonStarting(status) {
    if (!status || !status.daemon) return false;
    var d = status.daemon;
    if (!d.active) return d.active_state === "activating" || d.active_state === "reloading";
    // Active but the state file has not appeared yet: the model is loading.
    // Unknowable when the config disables the state file.
    return d.ready === false && typeof status.state_file_path === "string" && status.state_file_path !== "";
}

// What the on/off button does next: "off" while the daemon is up (or coming
// up), "on" while it is stopped or failed, "" before the first status.
function powerAction(status) {
    if (!status || !status.daemon || status.voxtype_installed === false || status.config_exists === false) return "";
    var d = status.daemon;
    return d.active || d.active_state === "activating" || d.active_state === "reloading" ? "off" : "on";
}

function powerLabel(action) { return action === "on" ? "Turn on" : (action === "off" ? "Turn off" : ""); }

// STATE cell on the Dictate card.
function stateLabel(status) {
    if (!status) return "…";
    if (daemonStarting(status)) return "Turning on…";
    if (daemonFailed(status)) return "Failed";
    var state = daemonState(status);
    return state === "stopped" ? "Off" : titleCase(state);
}

// Footer line when nothing else is going on. While off it answers "will it
// come back after a reboot?" from the unit's real UnitFileState.
function footerIdle(status) {
    if (!status || !status.daemon) return "";
    var d = status.daemon;
    if (d.active) return "Daemon running";
    if (daemonFailed(status)) return "Daemon crashed";
    if (d.starts_at_login === true) return "Back on at next login";
    if (d.starts_at_login === false) return "Won't start at login";
    return "Daemon stopped";
}

// Install commands for the locked states. Both are Omarchy's own entry points
// (`omarchy commands --all`); tests/model.test.js pins the exact strings.
var INSTALL_TUI_COMMAND = "omarchy pkg aur add voxtype-tui";
var INSTALL_VOXTYPE_COMMAND = "omarchy install dictation voxtype";

// What the Install button runs, keyed by locked-state kind. Each script is a
// fixed literal handed to Omarchy's floating terminal
// (omarchy-launch-floating-terminal-with-presentation), which shows the
// Omarchy header and a Done/Failed screen. Nothing in them comes from the
// bridge, the config or the user. `omarchy install dictation voxtype` asks its own
// confirmation; the AUR install is prefixed with one so no package is added
// without a yes in the terminal (omarchy pkg aur add runs yay --noconfirm).
var INSTALL_SCRIPTS = {
    tui: "if gum confirm \"Install voxtype-tui from the AUR?\"; then " + INSTALL_TUI_COMMAND + "; fi",
    voxtype: INSTALL_VOXTYPE_COMMAND
};
function installScript(kind) {
    return Object.prototype.hasOwnProperty.call(INSTALL_SCRIPTS, kind) ? INSTALL_SCRIPTS[kind] : "";
}

// Locked states, in precedence order. `command` is shown and copied, never
// executed by the panel; `install` labels the button that hands the matching
// INSTALL_SCRIPTS entry to a terminal the user watches.
function lockedState(status, error) {
    if (error === ERROR_TUI_MISSING) return {kind: "tui", title: "Install voxtype-tui to manage Voxtype here", hint: "The panel runs on the voxtype-tui package from the AUR.\nInstall it in a terminal, then reopen the panel:", command: INSTALL_TUI_COMMAND, install: "Install voxtype-tui"};
    if (status && status.voxtype_installed === false) return {kind: "voxtype", title: "Voxtype is not installed", hint: "Install it in a terminal, then reopen the panel:", command: INSTALL_VOXTYPE_COMMAND, install: "Install Voxtype"};
    if (status && status.config_exists === false) return {kind: "setup", title: "Voxtype is installed but not set up", hint: "Run the setup wizard in a terminal, then reopen the panel:", command: "voxtype setup"};
    return null;
}

function heroMeta(status, error, shortcut) {
    if (error === ERROR_TUI_MISSING) return "voxtype-tui is not installed";
    if (status && status.voxtype_installed === false) return "Voxtype is not installed";
    if (status && status.config_exists === false) return "Not set up yet";
    if (!status) return error ? "Unavailable" : "Checking…";
    var state = daemonState(status);
    if (daemonStarting(status)) return "Turning on · loading model…";
    if (daemonFailed(status)) return "Stopped unexpectedly";
    if (state === "stopped") return "Off · model unloaded";
    if (state === "recording") return "Recording…";
    if (state === "transcribing") return "Transcribing…";
    if (status.daemon.stale) return "Restart to apply changes";
    if (asrDown(status)) return "Qwen3-ASR server down";
    var model = status.model && status.model.name ? status.model.name : (status.engine || "");
    return "Ready · " + model + " · " + (shortcut ? shortcut : hotkeyLabel(status.hotkey));
}

// The Home hero: one word and how to start. Same precedence as heroMeta.
function homeState(status, shortcut) {
    if (!status) return {title: "…", line: "", tone: "muted"};
    var state = daemonState(status);
    var model = status.model && status.model.name ? sanitize(status.model.name, 60) : "";
    if (daemonStarting(status)) return {title: "Turning on", line: "Loading " + (model || "the model") + "…", tone: "muted"};
    if (daemonFailed(status)) return {title: "Stopped", line: "Voxtype stopped unexpectedly · press o to turn it on", tone: "urgent"};
    if (state === "stopped") return {title: "Off", line: "Model unloaded · press o to turn it on", tone: "muted"};
    if (state === "recording") return {title: "Listening", line: "Speak now · press r or your shortcut to stop", tone: "accent"};
    if (state === "transcribing") return {title: "Transcribing", line: "Writing it down…", tone: "accent"};
    if (status.daemon.stale) return {title: "Restart to apply", line: "Saved changes load after a restart · Ctrl+R", tone: "accent"};
    var how = shortcut ? "Press " + shortcut + " and talk" : "Press r to record";
    return {title: "Ready", line: how + (model ? " · " + model : ""), tone: "normal"};
}

// shortcuts.list → the one shortcut worth naming plus a hold-to-talk key.
// Toggle binds win (one press starts and stops); a start/stop pair on the
// same key is "hold". voxtype's own hotkey is the fallback.
function shortcutSummary(bindings, hotkey) {
    var list = bindings || [];
    var toggle = "", hold = "";
    for (var i = 0; i < list.length; i++) {
        var b = list[i];
        if (!b || typeof b.keys !== "string" || b.keys === "") continue;
        var keys = sanitize(b.keys, 40);
        if (b.action === "toggle" && toggle === "") toggle = keys;
        else if (b.action === "start" && hold === "") hold = keys;
    }
    if (toggle === "" && hold === "" && hotkey && hotkey.key && hotkey.enabled !== false) {
        var hk = hotkeyLabel(hotkey);
        if (hotkey.mode === "toggle") toggle = hk; else hold = hk;
    }
    var primary = toggle !== "" ? toggle : hold;
    return {primary: primary, hold: toggle !== "" ? hold : "", isHold: toggle === "" && hold !== ""};
}

function primaryAction(status) {
    if (!status || status.voxtype_installed === false || status.config_exists === false) return "";
    var state = daemonState(status);
    if (state === "stopped") return powerAction(status) === "on" ? "start" : "";
    if (daemonStarting(status)) return "";
    if (status.daemon.stale) return "restart";
    return "record";
}

function primaryLabel(action, state) {
    if (action === "start") return "Turn on";
    if (action === "restart") return "Restart";
    if (action === "record") return state === "recording" ? "Stop" : "Record";
    return "";
}

// Bar button: glyph + whether it should paint in the active colour.
function barGlyph(state) {
    if (state === "recording") return "󰍬";
    if (state === "transcribing") return "󰦉";
    if (state === "stopped" || state === "unknown") return "󰍭";
    return "󰍬";
}

function barActive(state) { return state === "recording" || state === "transcribing"; }

// Where the daemon writes its one-word state. `status.state_file_path` is
// authoritative once known: a string, or null when the config disables it.
// Before the bridge answers, the runtime dir comes from XDG_RUNTIME_DIR,
// else the session bus address (unix:path=/run/user/<uid>/bus), else a UID
// env; with none of them there is nothing to poll (null).
function defaultStateFilePath(runtimeDir, dbusAddress, uid) {
    var dir = String(runtimeDir || "");
    if (dir === "") {
        var m = /unix:path=(\/run\/user\/\d+)\//.exec(String(dbusAddress || ""));
        if (m) dir = m[1];
    }
    if (dir === "") {
        var id = String(uid || "").replace(/\D/g, "");
        if (id !== "") dir = "/run/user/" + id;
    }
    return dir === "" ? null : dir + "/voxtype/state";
}

function stateFilePath(status, fallback) {
    if (status && typeof status === "object" && "state_file_path" in status) {
        var p = status.state_file_path;
        if (p === null) return null;
        if (typeof p === "string" && p !== "") return p;
    }
    return fallback;
}

function readStateFile(text) {
    var s = String(text || "").trim().toLowerCase();
    if (s === "idle" || s === "recording" || s === "transcribing") return s;
    return "stopped";
}

function normalize(s) { return String(s || "").trim().toLowerCase(); }

function filterVocabulary(list, query) {
    var q = normalize(query);
    var out = [];
    for (var i = 0; i < (list || []).length; i++) {
        var item = list[i];
        if (!item || typeof item.phrase !== "string") continue;
        if (!q || item.phrase.toLowerCase().indexOf(q) !== -1) out.push(item);
    }
    return out;
}

function filterReplacements(list, query) {
    var q = normalize(query);
    var out = [];
    for (var i = 0; i < (list || []).length; i++) {
        var r = list[i];
        if (!r || typeof r.from !== "string") continue;
        if (!q || r.from.toLowerCase().indexOf(q) !== -1 || String(r.to || "").toLowerCase().indexOf(q) !== -1) out.push(r);
    }
    return out;
}

function tokenLevel(tokens, limit) {
    var lim = limit || TOKEN_LIMIT;
    if (tokens >= lim) return "urgent";
    if (tokens >= TOKEN_AMBER * lim / TOKEN_LIMIT) return "amber";
    return "ok";
}

function tokenMeter(tokens, limit) { return (tokens || 0) + " / " + (limit || TOKEN_LIMIT); }

function nextCategory(current, categories) {
    var cats = categories && categories.length ? categories : ["Replacement", "Capitalization"];
    var i = cats.indexOf(current);
    return cats[(i + 1) % cats.length];
}

// Reassigning a model array resets Repeaters (and any inline editor inside
// them), so callers compare first and only assign when membership changed.
function sameList(a, b, key) {
    a = a || []; b = b || [];
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
        var x = a[i], y = b[i];
        if (key) {
            if (!x || !y) return false;
            if (JSON.stringify(x) !== JSON.stringify(y)) return false;
        } else if (x !== y) return false;
    }
    return true;
}

// Streaming download protocol from `bridge.py --download`.
function parseDownloadLine(line) {
    var s = String(line || "").replace(/\r?\n$/, "");
    var m = /^PROGRESS\s+(\d+(?:\.\d+)?)\s*$/.exec(s);
    if (m) return {type: "progress", value: clamp(parseFloat(m[1]), 0, 100)};
    if (s === "DONE") return {type: "done"};
    m = /^FAILED(?:\s+(.*))?$/.exec(s);
    if (m) return {type: "failed", reason: m[1] || "Download failed."};
    m = /^LOG\s?(.*)$/.exec(s);
    if (m) return {type: "log", text: m[1]};
    if (s === "") return {type: "ignore"};
    return {type: "log", text: s};
}

function formatSize(mb) {
    if (mb === null || mb === undefined || isNaN(mb)) return "";
    if (mb >= 1000) return (mb / 1000).toFixed(1).replace(/\.0$/, "") + " GB";
    return Math.round(mb) + " MB";
}

function formatBytes(bytes) {
    if (bytes === null || bytes === undefined || isNaN(bytes)) return "";
    var b = Number(bytes);
    if (b < 1000) return Math.round(b) + " B";
    if (b < 1000000) return (b / 1000).toFixed(1).replace(/\.0$/, "") + " KB";
    return formatSize(b / 1000000);
}

// Structured lines for the GPU card: never the raw CLI dump, which carries
// unrelated advice and a misleading "(no daemon running)" note.
function gpuLines(gpu) {
    if (!gpu) return ["Checking GPU status…"];
    if (gpu.ok === false) return ["GPU status unavailable" + (gpu.error ? ": " + sanitize(gpu.error, 80) : "")];
    var lines = ["Backend: " + (gpu.backend ? sanitize(gpu.backend, 60) : "unknown")];
    var gpus = gpu.gpus || [];
    var labels = [];
    for (var i = 0; i < gpus.length; i++) if (gpus[i] && gpus[i].label) labels.push(sanitize(gpus[i].label, 60));
    lines.push("GPUs: " + (labels.length ? labels.join(", ") : "none"));
    lines.push("Device: " + sanitize(gpu.device || "auto", 20));
    return lines;
}

// Rows from a newer voxtype-tui may carry `available:false` plus a
// `disabled_reason` (e.g. a GPU-only model on a CPU build), and
// `incomplete:true` when the file is there but the engine it runs on is not
// (Download fetches the rest). Older bridges send neither: same as before.
function modelUnavailable(m) { return !!m && m.available === false; }
function modelNeedsDownload(m) { return !!m && (!m.downloaded || m.incomplete === true); }
function modelReason(m) { return sanitize(m && m.disabled_reason ? m.disabled_reason : "not available on this machine", 80); }

// Why `x` / `d` / Enter on a model row does nothing, in words for the footer.
function modelActionBlock(m, action) {
    if (!m) return "";
    if (action === "delete") {
        if (m.active) return "Set another model active first";
        if (!m.downloaded) return "Not downloaded";
    }
    if (action === "download") {
        if (modelUnavailable(m)) return "Can't download: " + modelReason(m);
        if (!modelNeedsDownload(m)) return "Already downloaded";
    }
    if (action === "activate" && modelUnavailable(m)) return "Can't use it: " + modelReason(m);
    return "";
}

function modelStatus(m) {
    if (!m) return "";
    if (m.active) return "active";
    if (modelUnavailable(m)) return (m.downloaded ? "downloaded · " : "") + modelReason(m);
    if (m.incomplete === true) return "engine not downloaded";
    if (m.downloaded) return "downloaded";
    if (m.unknown) return "on disk";
    return "not downloaded";
}

function modelLine(m) {
    if (!m) return "";
    var parts = [];
    var size = m.on_disk_bytes ? formatBytes(m.on_disk_bytes) : formatSize(m.size_mb);
    if (size) parts.push(size);
    parts.push(modelStatus(m));
    return parts.join(" · ");
}

function settingValue(settings, path, fallback) {
    if (!settings || !(path in settings)) return fallback;
    var v = settings[path];
    return v === null || v === undefined ? fallback : v;
}

// A key absent from the snapshot means voxtype's own default is in effect.
function settingIsSet(settings, path) {
    if (!settings || !(path in settings)) return false;
    var v = settings[path];
    return v !== null && v !== undefined;
}

// Which setting `u` (reset to default) unsets for a cursor key. Modifier
// chips reset the whole modifier list; non-setting cursor targets (GPU
// buttons, Clear key) have nothing to reset.
function resettableSetting(cursorKey) {
    var k = String(cursorKey || "");
    if (k === "") return "";
    if (k.indexOf("hotkey.mod.") === 0) return "hotkey.modifiers";
    if (k === "remote.clear" || k.indexOf("gpu.") === 0) return "";
    return k;
}

function settingChanged(settings, path, value) {
    var current = settings ? settings[path] : undefined;
    return JSON.stringify(current === undefined ? null : current) !== JSON.stringify(value === undefined ? null : value);
}

function toggleInList(list, item) {
    var out = [];
    var found = false;
    for (var i = 0; i < (list || []).length; i++) {
        if (list[i] === item) { found = true; continue; }
        out.push(list[i]);
    }
    if (!found) out.push(item);
    return out;
}

function modelOptions(models, current) {
    var out = [];
    var seen = false;
    for (var i = 0; i < (models || []).length; i++) {
        var m = models[i];
        if (!m || !m.name) continue;
        if (m.name === current) seen = true;
        var note = modelUnavailable(m) ? "  (" + modelReason(m) + ")" : (modelNeedsDownload(m) ? "  (not downloaded)" : "");
        out.push({value: m.name, label: sanitize(m.name, 80) + note});
    }
    if (current && !seen) out.push({value: current, label: sanitize(current, 80)});
    return out;
}

// Engine dropdown: the bridge's display labels (`Qwen3-ASR` for the engine
// key `qwen3-asr`) when it sends them, else the key itself.
function engineLabel(options, engine) {
    var e = String(engine || "");
    var labels = options && options.engine_labels ? options.engine_labels : null;
    return labels && typeof labels[e] === "string" && labels[e] !== "" ? labels[e] : e;
}

function engineOptions(options, fallback) {
    var list = options && options.engines ? options.engines : [fallback];
    var out = [];
    for (var i = 0; i < list.length; i++) out.push({value: String(list[i]), label: engineLabel(options, list[i])});
    return out;
}

// Qwen3-ASR runs as a local server next to the daemon (status.asr, newer
// voxtype-tui only). It starts and stops with voxtype, so it is only news
// when voxtype is up and the server is not answering.
function asrDown(status) {
    return !!status && !!status.asr && status.asr.healthy === false && !!status.daemon && status.daemon.active === true;
}

function asrNotice(status) {
    if (!asrDown(status)) return "";
    // voxtype-tui sends a short human reason ("not running", "still starting",
    // "port taken by another program"); older builds sent a long technical
    // string, so only show reasons that fit on one line.
    var d = status.asr.detail ? sanitize(status.asr.detail, 60) : "";
    var why = (d && d.length <= 40 && d !== "ok") ? " (" + d + ")" : "";
    return "Qwen3-ASR server is down" + why + ". Restart to fix it.";
}

function plainOptions(list) {
    var out = [];
    for (var i = 0; i < (list || []).length; i++) out.push({value: String(list[i]), label: String(list[i])});
    return out;
}

function labelled(list) {
    var out = [];
    for (var i = 0; i < (list || []).length; i++) {
        var o = list[i];
        if (!o) continue;
        out.push({value: String(o.value !== undefined ? o.value : o.name), label: String(o.label || o.name || o.value)});
    }
    return out;
}

// Footer hints as [key, verb] pairs, derived from the same state the key
// bindings read (section, editing, cursorActive). tests/panel_lifecycle
// checks every key here is bound in Panel.qml and every bound key is hinted.
function hintPairs(section, context) {
    var c = context || {};
    var view = c.view || "";
    if (c.fixing) return [["←→", "word"], ["Enter", "next"], ["Esc", "cancel"]];
    if (c.editing) return section === "words" ? [["Enter", "add"], ["Esc", "back"]] : (c.fixField ? [["↑↓", "kind"], ["Enter", "teach"], ["Esc", "cancel"]] : [["Enter", "save"], ["Esc", "cancel"]]);
    var move = c.cursorActive ? [] : [["↑↓", "move"]];
    if (view === "usage") return [["Esc", "back"], ["r", "record"], ["1–4", "sections"]];
    if (view === "models") return move.concat([["Enter", "set active"], ["d", "download"], ["x", "delete"], ["Esc", "back"]]);
    if (view === "advanced") return move.concat([["Enter", "change"], ["u", "reset"], ["Esc", "back"]]);
    if (view === "backup") return move.concat([["Enter", "open"], ["Esc", "back"]]);
    if (section === "home") return move.concat([["r", "record"], ["o", "on/off"], ["u", "usage"], ["Ctrl+R", "restart"], ["1–4", "sections"]]);
    // A learned row has its own verbs; the footer follows the cursor.
    if (section === "words" && c.rowKind === "learned") return [["Enter", "accept"], ["p", "promote"], ["x", "reject"], ["d", "forget"]];
    // Shift+X is the kit key catcher's Delete (it never reaches the panel as
    // a letter), so the jump covers every other capital.
    if (section === "words") return move.concat([["/", "search"], ["a", "add"], ["c", "type"], ["x", "delete"], ["Shift+A–Z", "jump (not X)"]]);
    if (section === "history") return move.concat([["Enter", "open"], ["c", "copy"], ["f", "fix"], ["x", "delete"]]);
    if (section === "settings") return move.concat([["←→", "change"], ["Enter", "open"], ["u", "reset"], ["1–4", "sections"]]);
    return [];
}

function sectionHints(section, context) {
    var pairs = hintPairs(section, context);
    var out = [];
    for (var i = 0; i < pairs.length; i++) out.push(pairs[i][0] + " " + pairs[i][1]);
    return out.join("   ");
}

function footerNotice(state) {
    var s = state || {};
    if (s.error) return {text: s.error, urgent: true};
    if (s.busyText) return {text: s.busyText, urgent: false};
    if (s.notice) return {text: s.notice, urgent: false};
    if (s.restartNeeded) return {text: "Saved · restart to apply", urgent: false};
    return {text: s.idleText || "", urgent: false};
}

function nextSection(current, delta) {
    var i = SECTIONS.indexOf(current);
    if (i < 0) i = 0;
    return SECTIONS[(i + delta + SECTIONS.length) % SECTIONS.length];
}

function sectionForKey(text) {
    var n = parseInt(text, 10);
    if (isNaN(n) || n < 1 || n > SECTIONS.length) return "";
    return SECTIONS[n - 1];
}

function restartNeededSummary(paths) {
    if (!paths || !paths.length) return "";
    return paths.length === 1 ? "Restart to apply " + paths[0] : "Restart to apply " + paths.length + " changes";
}

// The Settings section's keyboard cursor order. Eight controls in Panel.qml
// live inside Rows that are conditionally visible, so a static list walks the
// highlight onto things that are not on screen and Enter then calls
// forceActiveFocus() on an invisible TextField or open() on an invisible
// Dropdown. These predicates MIRROR the `visible:` bindings that drive those
// Rows — keep them in step:
//   whisper.language                       Panel.qml  engine === "whisper"
//   audio.feedback.theme / .volume         Row        audio.feedback.enabled
//   vad.threshold / vad.model              Row        vad.enabled
//   whisper.remote_endpoint                Panel.qml  engine === "whisper"
//   whisper.remote_model / _timeout_secs   Row        engine === "whisper"
//   remote.clear                           Button     engine === "whisper"
//                                                     && remote_api_key_set
function settingsTargets(config, engine, modelPath) {
    var eng = String(engine || "whisper");
    var whisper = eng === "whisper";
    var feedback = settingValue(config, "audio.feedback.enabled", true) === true;
    var vad = settingValue(config, "vad.enabled", false) === true;
    var keySet = settingValue(config, "whisper.remote_api_key_set", false) === true;
    var out = ["engine", String(modelPath || (eng + ".model"))];
    if (whisper) out.push("whisper.language");
    out = out.concat(["hotkey.key", "hotkey.mod.LEFTCTRL", "hotkey.mod.LEFTALT", "hotkey.mod.LEFTSHIFT", "hotkey.mod.LEFTMETA", "hotkey.mode", "hotkey.enabled",
                      "audio.device", "audio.max_duration_secs", "audio.feedback.enabled"]);
    if (feedback) out = out.concat(["audio.feedback.theme", "audio.feedback.volume"]);
    if (settingValue(config, "audio.duck_media", false) === true) out.push("audio.duck_media_volume_percent");
    out = out.concat(["output.mode", "output.fallback_to_clipboard", "output.auto_submit", "text.smart_auto_submit", "text.spoken_punctuation",
                      "output.restore_clipboard", "output.shift_enter_newlines", "output.type_delay_ms",
                      "vad.enabled"]);
    if (vad) out = out.concat(["vad.threshold", "vad.model"]);
    out = out.concat(["output.post_process.command", "output.post_process.timeout_ms"]);
    if (whisper) {
        out = out.concat(["whisper.remote_endpoint", "whisper.remote_model", "whisper.remote_timeout_secs"]);
        if (keySet) out.push("remote.clear");
    }
    out = out.concat(["osd.position", "osd.opacity", "osd.palette", "osd.frontend", "output.notification.on_transcription", "output.notification.on_recording_start",
                      "output.notification.on_recording_stop", "output.notification.on_no_speech", "output.notification.urgency"]);
    return out.concat(["gpu.device", "gpu.enable", "gpu.disable"]);
}

function dangerousChanges(diff) {
    var out = [];
    var changes = diff && diff.settings_change ? diff.settings_change : [];
    for (var i = 0; i < changes.length; i++) if (changes[i] && changes[i].dangerous) out.push(changes[i]);
    return out;
}

// A dangerous change may arrive redacted ({path, dangerous, redacted:true,
// old_set, new_set}) with no old/new at all; never format values for those.
function dangerLine(change, oldMax, newMax) {
    if (!change) return "";
    var path = sanitize(change.path, 80);
    if (change.redacted === true) return path + " will be replaced";
    return path + ": " + sanitize(change.old, oldMax || 40) + " → " + sanitize(change.new, newMax || 60);
}

// Every settings row the import would write, in the order the user should
// read them: dangerous first (so nothing dangerous can fall below the cut),
// then the rest. Formatting goes through dangerLine, which is the
// redaction-aware path, so a secret value is never rendered. The list is a
// bridge response of arbitrary length, so it is capped and the remainder is
// reported as one overflow line rather than overflowing the card.
var IMPORT_CARD_ROWS = 12;

function settingsRows(diff, max) {
    var changes = (diff && diff.settings_change) ? diff.settings_change : [];
    var lim = max || IMPORT_CARD_ROWS;
    var ordered = [];
    var i;
    for (i = 0; i < changes.length; i++) if (changes[i] && changes[i].dangerous) ordered.push(changes[i]);
    for (i = 0; i < changes.length; i++) if (changes[i] && !changes[i].dangerous) ordered.push(changes[i]);
    var out = [];
    for (i = 0; i < ordered.length && i < lim; i++)
        out.push({text: dangerLine(ordered[i], 40, 60), dangerous: ordered[i].dangerous === true, overflow: false});
    var rest = ordered.length - lim;
    if (rest > 0) out.push({text: "and " + rest + " more change" + (rest === 1 ? "" : "s"), dangerous: false, overflow: true});
    return out;
}

// The import confirmation, and with it the ONE thing allowed to set
// `accept_dangerous` on import.apply. The bridge's own refusal is the second
// half of the gate, so the panel must never claim an acknowledgement the
// dialog did not actually obtain: `accept` is true only when the message
// below named every dangerous row.
//
// Tiers, because the kit's ConfirmDialog card grows with its message and an
// unbounded list would push the buttons off the screen:
//   <= IMPORT_CONFIRM_ROWS  every row with its old -> new values
//   <= IMPORT_CONFIRM_MAX   every row by path only (values live in the card)
//   more                    nothing can be acknowledged here; accept stays
//                           false and the bridge refuses. The escape hatch is
//                           the include-settings toggle, which is off by
//                           default and removes settings rows from the diff.
var IMPORT_CONFIRM_ROWS = 8;
var IMPORT_CONFIRM_MAX = 24;

function importConfirmation(fileName, diff) {
    var danger = dangerousChanges(diff);
    var lines = ["Import " + sanitize(fileName, 60) + "?", diffSummary(diff)];
    var named = 0;
    var i;
    if (danger.length > 0 && danger.length <= IMPORT_CONFIRM_ROWS) {
        for (i = 0; i < danger.length; i++) { lines.push("⚠ " + dangerLine(danger[i], 30, 40)); named++; }
    } else if (danger.length > IMPORT_CONFIRM_ROWS && danger.length <= IMPORT_CONFIRM_MAX) {
        var paths = [];
        for (i = 0; i < danger.length; i++) { paths.push(sanitize(danger[i].path, 60)); named++; }
        lines.push("⚠ " + danger.length + " dangerous changes: " + paths.join(", "));
    } else if (danger.length > IMPORT_CONFIRM_MAX) {
        lines.push("⚠ " + danger.length + " dangerous changes — too many to review here. Turn off “Include settings”, or import a smaller bundle.");
    }
    return {
        message: lines.join("\n"),
        confirmText: danger.length ? "Import anyway" : "Import",
        accept: danger.length > 0 && named === danger.length,
        dangerous: danger.length
    };
}

function diffSummary(diff) {
    if (!diff) return "Nothing to import";
    var d = diff;
    var parts = [];
    var n = (d.vocab_add || []).length; if (n) parts.push("+" + n + " vocab");
    n = (d.vocab_remove || []).length; if (n) parts.push("-" + n + " vocab");
    n = (d.replacements_add || []).length; if (n) parts.push("+" + n + " rules");
    n = (d.replacements_change || []).length; if (n) parts.push(n + " rules changed");
    n = (d.settings_change || []).length; if (n) parts.push(n + " settings");
    return parts.length ? parts.join(" · ") : "No changes";
}

// Characters that must never reach a Text element: C0 controls, DEL, the
// bidi overrides/isolates, and the invisible formatters that let an imported
// value fake its own layout. U+2028/U+2029 are line/paragraph separators and
// U+200B/U+00AD/U+FEFF are zero-width — all of them survive
// `textFormat: PlainText`.
var UNSAFE_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u00ad\u200b\u200e\u200f\u202a-\u202e\u2028\u2029\u2066-\u2069\ufeff]/g;

// Untrusted fragments (phrases, rules, model names, bundle paths, bridge
// errors). ConfirmDialog renders its message with wrapMode WordWrap, so a
// value containing LF/CR/TAB becomes real lines and can push the genuine
// question off the top of the card, putting its own question directly above
// the Cancel/Confirm buttons. PlainText stops HTML, not line breaks — so
// flatten them here, in the fragment, and assemble the static copy after.
function sanitize(text, max) {
    var s = String(text === null || text === undefined ? "" : text)
        .replace(UNSAFE_CHARS, "")
        .replace(/[\r\n\t]+/g, " ")
        .replace(/\s{2,}/g, " ");
    var lim = max || 200;
    return s.length > lim ? s.slice(0, lim - 1) + "…" : s;
}

// ---- clipboard-safe text editing -------------------------------------------
//
// Qt's TextInput (qs.Ui TextField, and the SpinBox inside qs.Ui NumberField)
// reads the Wayland clipboard inside the shell process on its own: the whole
// text on every clipboard change, to decide whether Paste applies, and again
// on Ctrl+V, Shift+Insert, the context menu and middle-click. Those reads
// have no byte limit and no overall deadline. EditField.qml replaces both:
// its TextEdit only checks offered formats on a clipboard change, its paste
// paths are closed, and a paste goes through `bridge.py --paste` (at most
// PASTE_MAX_BYTES, PASTE_TIMEOUT_MS in total, in a child process).
var EDIT_MAX_CHARS = 4096;
var PASTE_MAX_BYTES = 16384;
var PASTE_TIMEOUT_MS = 2000;

// One edit: replace [start, end) of `text` with `insert`. The insert is
// flattened to one line with the same unsafe-character class sanitize()
// drops, and clipped so the result stays within `max` characters.
function spliceText(text, start, end, insert, max) {
    var s = String(text === null || text === undefined ? "" : text);
    var lim = max || EDIT_MAX_CHARS;
    var a = clamp(Math.min(start, end) | 0, 0, s.length);
    var b = clamp(Math.max(start, end) | 0, 0, s.length);
    var add = String(insert === null || insert === undefined ? "" : insert)
        .replace(/[\r\n\t]+/g, " ")
        .replace(UNSAFE_CHARS, "");
    var room = Math.max(0, lim - (s.length - (b - a)));
    if (add.length > room) {
        add = add.slice(0, room);
        // Never leave half of a surrogate pair at the cut.
        if (add.length && /[\ud800-\udbff]$/.test(add)) add = add.slice(0, -1);
    }
    return {text: s.slice(0, a) + add + s.slice(b), cursor: a + add.length};
}

// Text a key press would type: printable, no Ctrl/Alt/Meta (AltGr arrives
// as Ctrl+Alt and is allowed through), no control characters.
function typedText(text, modifiers, ctrl, alt, meta) {
    var t = String(text || "");
    if (t === "" || /[\u0000-\u001f\u007f]/.test(t) || t.replace(UNSAFE_CHARS, "") !== t) return "";
    var m = modifiers | 0;
    var altGr = (m & ctrl) && (m & alt);
    if (!altGr && (m & (ctrl | alt | meta))) return "";
    return t;
}

// A number field's text (or a stepped number) as a value inside [lo, hi];
// anything unreadable keeps `fallback`.
function clampNumber(value, lo, hi, fallback) {
    var n = typeof value === "number" ? value : parseInt(String(value === null || value === undefined ? "" : value).trim(), 10);
    if (!isFinite(n)) return fallback;
    return clamp(Math.round(n), lo, hi);
}

// The bridge's --paste result: the text the bounded reader produced, or null
// for anything the panel must not insert (a failed, killed or oversized read).
function pasteResult(text, code, timedOut) {
    if (timedOut || code !== 0) return null;
    var s = String(text === null || text === undefined ? "" : text);
    return s.length > PASTE_MAX_BYTES ? null : s;
}

// Exit codes of `bridge.py --paste` (bridge.py PASTE_EXIT_*).
var PASTE_EXIT_TOO_LARGE = 4;
var PASTE_EXIT_TIMEOUT = 5;
function pasteError(code, timedOut) {
    if (timedOut || code === PASTE_EXIT_TIMEOUT) return "The clipboard did not answer in time · nothing pasted";
    if (code === PASTE_EXIT_TOO_LARGE) return "Clipboard text is over " + (PASTE_MAX_BYTES / 1024) + " KB · nothing pasted";
    return "Nothing to paste: the clipboard holds no text";
}

// Defence in depth for an ALREADY-assembled dialog message: strip the same
// unsafe characters and cap, but keep "\n" because the panel's own static
// copy uses it deliberately. Every untrusted fragment inside the message has
// been through sanitize() first, so no injected break can reach this.
function sanitizeMessage(text, max) {
    var s = String(text === null || text === undefined ? "" : text)
        .replace(UNSAFE_CHARS, "")
        .replace(/[\r\t]+/g, " ");
    var lim = max || 600;
    return s.length > lim ? s.slice(0, lim - 1) + "…" : s;
}

// Wheel scrolling for the panel body. Qt's Flickable turns each notch into a
// decelerating flick, which reads as sluggish next to GTK and browsers; this
// steps contentY directly. Touchpads report pixelDelta and are passed
// through 1:1; a mouse wheel notch (angleDelta 120) moves `stepPx`.
function wheelContentY(contentY, contentHeight, viewHeight, pixelDeltaY, angleDeltaY, stepPx) {
    var maxY = Math.max(0, (contentHeight || 0) - (viewHeight || 0));
    var delta;
    if (pixelDeltaY) delta = -pixelDeltaY;
    else if (angleDeltaY) delta = -(angleDeltaY / 120) * (stepPx || 0);
    else return contentY || 0;
    return Math.max(0, Math.min(maxY, (contentY || 0) + delta));
}

// Informational notices the TUI shows as banners: who else holds the
// config, what the sidecar reconcile rewrote, where sync.json came from,
// and Syncthing conflict files. Pure so the panel can list them.
function notices(status, snapshot) {
    var out = [];
    var asr = asrNotice(status);
    if (asr) out.push({kind: "warn", text: asr});
    var pid = status ? status.tui_open_pid : null;
    if (pid !== null && pid !== undefined)
        out.push({kind: "warn", text: "voxtype-tui is open" + (pid > 0 ? " (pid " + pid + ")" : "") + " — save and close it before editing here, or its next save overwrites these changes"});
    var s = snapshot || {};
    var sync = s.sync || {};
    if (sync.conflicts && sync.conflicts.length)
        out.push({kind: "warn", text: sync.conflicts.length + " sync conflict file" + (sync.conflicts.length === 1 ? "" : "s") + " in the voxtype-tui folder — resolve in the TUI"});
    (s.warnings || []).forEach(function(w) { out.push({kind: "info", text: sanitize(w, 160)}); });
    if (sync.applied_from)
        out.push({kind: "info", text: "Settings synced from " + sanitize(sync.applied_from, 60) + " — save any change to keep them"});
    (s.migrations_applied || []).forEach(function(m) { out.push({kind: "info", text: "Migrated: " + sanitize(m, 120)}); });
    return out;
}


// ===========================================================================
// Layout B: Home · Words · History · Settings (+ drill-ins)
// ===========================================================================

function isDrill(view) { return Object.prototype.hasOwnProperty.call(DRILLS, String(view || "")); }
function drillSection(view) { return isDrill(view) ? DRILLS[view] : ""; }
function drillTitle(view) { return isDrill(view) ? DRILL_TITLES[view] : ""; }

// ---- Words: vocabulary + dictionary (+ learned) as one list ---------------

var WORD_TAGS = {spelling: "spelling", sounds_like: "sounds like", replace: "replace", capitalization: "capitalization"};
var WORD_FILTERS = ["all", "spelling", "replace", "capitalization", "learned"];
var WORD_FILTER_LABELS = {all: "All", spelling: "Spelling", replace: "Replace", capitalization: "Capitalization", learned: "Learned"};

function sortKey(s) { return String(s || "").replace(/^[^A-Za-z0-9]+/, "").toLowerCase(); }

function ruleTag(category) { return String(category || "") === "Capitalization" ? "capitalization" : "replace"; }

// Your own words: every vocabulary phrase (spelling) and every dictionary
// rule (replace / capitalization), A–Z by what gets written. `id` is unique
// across both kinds so the cursor survives a reload.
function wordRows(vocabulary, replacements) {
    var out = [];
    var i;
    for (i = 0; i < (vocabulary || []).length; i++) {
        var v = vocabulary[i];
        if (!v || typeof v.phrase !== "string") continue;
        out.push({id: "v:" + v.phrase, kind: "vocab", heard: "", written: v.phrase, tag: "spelling", phrase: v.phrase});
    }
    for (i = 0; i < (replacements || []).length; i++) {
        var r = replacements[i];
        if (!r || typeof r.from !== "string") continue;
        out.push({id: "r:" + r.from, kind: "rule", heard: r.from, written: String(r.to || ""), tag: ruleTag(r.category), from: r.from, category: r.category});
    }
    out.sort(function(a, b) {
        var x = sortKey(a.written), y = sortKey(b.written);
        return x < y ? -1 : (x > y ? 1 : (a.id < b.id ? -1 : 1));
    });
    return out;
}

var LEARN_STATE_LABELS = {active: "learned", suggested: "suggested", dormant: "paused", rejected: "rejected", promoted: "promoted"};

// Learned entries (learn.list), kept apart from the user's words. Rejected
// and promoted ones are history, not vocabulary: hidden here.
function learnedRows(entries) {
    var out = [];
    for (var i = 0; i < (entries || []).length; i++) {
        var e = entries[i];
        if (!e || typeof e.id !== "string" || typeof e.written !== "string") continue;
        if (e.state === "rejected" || e.state === "promoted") continue;
        var heard = isList(e.heard) ? toList(e.heard).join(", ") : String(e.heard || "");
        out.push({id: "l:" + e.id, entryId: e.id, kind: "learned", heard: heard, written: e.written,
                  tag: WORD_TAGS[e.kind] || String(e.kind || ""), state: String(e.state || ""),
                  stateLabel: LEARN_STATE_LABELS[e.state] || String(e.state || "")});
    }
    out.sort(function(a, b) {
        // Suggestions first: they wait for a decision.
        var sa = a.state === "suggested" ? 0 : 1, sb = b.state === "suggested" ? 0 : 1;
        if (sa !== sb) return sa - sb;
        var x = sortKey(a.written), y = sortKey(b.written);
        return x < y ? -1 : (x > y ? 1 : 0);
    });
    return out;
}

// Everything learned.json holds, rejected and promoted tombstones included
// (learn.reset clears those too): from learn.list's counts, else entries.
function learnedTotal(state) {
    if (!state) return 0;
    var c = state.counts || {};
    var sum = 0;
    for (var k in c) if (typeof c[k] === "number" && c[k] > 0) sum += c[k];
    return Math.max(sum, (state.entries || []).length);
}

function matchesQuery(row, q) {
    if (!q) return true;
    return String(row.written).toLowerCase().indexOf(q) !== -1 || String(row.heard).toLowerCase().indexOf(q) !== -1;
}

// What the Words list shows for a filter + search. Learned rows sit in their
// own group after "Your words" (filter "learned" shows only them).
function filterWords(mine, learned, filter, query) {
    var q = normalize(query);
    var f = WORD_FILTERS.indexOf(filter) >= 0 ? filter : "all";
    var own = [], lrn = [];
    var i;
    if (f !== "learned")
        for (i = 0; i < (mine || []).length; i++)
            if ((f === "all" || mine[i].tag === f) && matchesQuery(mine[i], q)) own.push(mine[i]);
    if (f === "all" || f === "learned")
        for (i = 0; i < (learned || []).length; i++)
            if (matchesQuery(learned[i], q)) lrn.push(learned[i]);
    return {mine: own, learned: lrn, rows: own.concat(lrn)};
}

function wordFilters(mine, learned) {
    var counts = {all: (mine || []).length + (learned || []).length, spelling: 0, replace: 0, capitalization: 0, learned: (learned || []).length};
    for (var i = 0; i < (mine || []).length; i++) if (counts[mine[i].tag] !== undefined) counts[mine[i].tag]++;
    var out = [];
    for (var j = 0; j < WORD_FILTERS.length; j++) {
        var f = WORD_FILTERS[j];
        if (f !== "all" && counts[f] === 0) continue;
        out.push({value: f, label: WORD_FILTER_LABELS[f] + " " + counts[f], count: counts[f]});
    }
    return out;
}

// The one add field: "Codemux" adds a word, "code mucks → Codemux" (or ->,
// =>) adds a rule.
function parseWordInput(text) {
    var s = String(text || "").trim();
    if (s === "") return null;
    var m = /^(.*?)\s*(?:→|->|=>)\s*(.*)$/.exec(s);
    if (m) {
        var from = m[1].trim(), to = m[2].trim();
        if (from === "" || to === "") return {kind: "invalid", reason: "Write it as: heard → written"};
        return {kind: "rule", from: from, to: to};
    }
    return {kind: "vocab", phrase: s};
}

// A–Z jump: first row whose written form starts with `letter`, else the
// next letter that has one; -1 when nothing follows.
function letterIndex(rows, letter) {
    var l = String(letter || "").toLowerCase();
    if (!/^[a-z]$/.test(l)) return -1;
    var best = -1;
    for (var i = 0; i < (rows || []).length; i++) {
        var k = sortKey(rows[i].written);
        var c = k.charAt(0);
        if (c === l) return i;
        if (best < 0 && c > l && /[a-z]/.test(c)) best = i;
    }
    return best;
}

// ---- History ---------------------------------------------------------------

function pad2(n) { return (n < 10 ? "0" : "") + n; }
function dayKey(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }

function recordDate(rec) {
    var t = rec && (rec.ts || rec.started_at);
    var d = t ? new Date(t) : null;
    return d && !isNaN(d.getTime()) ? d : null;
}

function dayLabel(d, now) {
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var that = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    var diff = Math.round((today - that) / 86400000);
    if (diff === 0) return "Today";
    if (diff === 1) return "Yesterday";
    var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    var days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    if (diff > 1 && diff < 7) return days[d.getDay()];
    return d.getDate() + " " + months[d.getMonth()] + (d.getFullYear() !== now.getFullYear() ? " " + d.getFullYear() : "");
}

function recordText(rec) { return String(rec && (rec.final !== undefined && rec.final !== null ? rec.final : rec.raw) || ""); }
function wordCount(text) { var t = String(text || "").trim(); return t === "" ? 0 : t.split(/\s+/).length; }

// Flat display list: a header per day ("Today · 4 dictations · 49 words")
// then its rows. `index` on item rows is the cursor index among items only.
function historyRows(items, query, now) {
    var q = normalize(query);
    var n = now || new Date();
    var out = [];
    var lastKey = "", header = null, idx = 0;
    for (var i = 0; i < (items || []).length; i++) {
        var rec = items[i];
        if (!rec || typeof rec.id !== "string") continue;
        var text = recordText(rec);
        if (q && text.toLowerCase().indexOf(q) === -1 && String(rec.raw || "").toLowerCase().indexOf(q) === -1) continue;
        var d = recordDate(rec);
        var key = d ? dayKey(d) : "unknown";
        if (key !== lastKey) {
            header = {type: "day", key: key, label: d ? dayLabel(d, n) : "Earlier", count: 0, words: 0};
            out.push(header);
            lastKey = key;
        }
        var words = typeof rec.words === "number" ? rec.words : wordCount(text);
        header.count++;
        header.words += words;
        out.push({type: "item", index: idx++, id: rec.id, time: d ? pad2(d.getHours()) + ":" + pad2(d.getMinutes()) : "--:--",
                  text: sanitize(text, 400), words: words, record: rec});
    }
    for (var j = 0; j < out.length; j++)
        if (out[j].type === "day") out[j].meta = out[j].count + " dictation" + (out[j].count === 1 ? "" : "s") + " · " + out[j].words + " words";
    return out;
}

// An older page appended to the loaded list: records already shown (same
// id) are not added again.
function appendHistory(list, items) {
    var seen = {};
    var out = toList(list);
    for (var i = 0; i < out.length; i++) if (out[i] && typeof out[i].id === "string") seen[out[i].id] = true;
    var add = toList(items);
    for (var j = 0; j < add.length; j++) {
        var rec = add[j];
        if (!rec || typeof rec.id !== "string" || seen[rec.id]) continue;
        seen[rec.id] = true;
        out.push(rec);
    }
    return out;
}

function historyItems(rows) {
    var out = [];
    for (var i = 0; i < (rows || []).length; i++) if (rows[i].type === "item") out.push(rows[i]);
    return out;
}

var KEEP_OPTIONS = [{value: 7, label: "1 week"}, {value: 30, label: "1 month"}, {value: 90, label: "3 months"},
                    {value: 365, label: "1 year"}, {value: null, label: "forever"}];

function keepLabel(days) {
    for (var i = 0; i < KEEP_OPTIONS.length; i++) if (KEEP_OPTIONS[i].value === (days === undefined ? 30 : days)) return KEEP_OPTIONS[i].label;
    return days + " days";
}

function retentionLine(enabled, keepDays, archive) {
    if (enabled === false) return "History is off · nothing new is saved";
    var audio = archive && archive.enabled && archive.save_audio ? "audio archived" : "audio not saved";
    return "Text only on this machine, kept " + keepLabel(keepDays) + " · " + audio;
}

// Raw-vs-final: the raw transcript as words, each marked when it did not
// survive into the final text (longest common subsequence on words).
function diffWords(raw, finalText) {
    var a = String(raw || "").split(/\s+/).filter(function(w) { return w !== ""; });
    var b = String(finalText || "").split(/\s+/).filter(function(w) { return w !== ""; });
    if (a.length > 400 || b.length > 400) return [{text: sanitize(a.join(" "), 2000), changed: false}];
    var n = a.length, m = b.length;
    var dp = [];
    var i, j;
    for (i = 0; i <= n; i++) { dp.push(new Array(m + 1)); for (j = 0; j <= m; j++) dp[i][j] = 0; }
    for (i = n - 1; i >= 0; i--)
        for (j = m - 1; j >= 0; j--)
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    var out = [];
    i = 0; j = 0;
    while (i < n) {
        if (j < m && a[i] === b[j]) { out.push({text: sanitize(a[i], 80), changed: false}); i++; j++; }
        else if (j < m && dp[i][j + 1] > dp[i + 1][j]) j++;
        else { out.push({text: sanitize(a[i], 80), changed: true}); i++; }
    }
    return out;
}

function changedByRules(raw, finalText) { return String(raw || "").trim() !== String(finalText || "").trim(); }

// ---- Fix a word -------------------------------------------------------------

// The words of a dictation as clickable tokens: leading/trailing
// punctuation is kept aside so "Omashi." offers "Omashi". `start`/`end` are
// offsets into the original text, so a fix replaces only the picked span.
var FIX_EDGE = /^([\"'“”‘’«»(\[{¿¡]*)(.*?)([\"'“”‘’«»)\]}.,!?;:…]*)$/;
// learn.submit refuses a longer edited text (bridge LEARN_EDIT_MAX_CHARS).
var FIX_TEXT_MAX_CHARS = 4096;
// How many words the Fix card shows at once; the window follows the pick.
var FIX_SHOWN_MAX = 200;
function fixTokens(text) {
    var s = String(text || "");
    var re = /\S+/g;
    var out = [];
    var m;
    while ((m = re.exec(s)) !== null) {
        var e = FIX_EDGE.exec(m[0]);
        out.push({index: out.length, raw: m[0], lead: e ? e[1] : "", word: e ? e[2] : m[0], trail: e ? e[3] : "",
                  start: m.index, end: m.index + m[0].length});
    }
    return out;
}

// The slice of tokens the Fix card renders: at most `max`, always holding
// the picked span, so every word of a long dictation can be reached.
function fixWindow(tokens, start, end, max) {
    var list = toList(tokens);
    var n = list.length;
    var cap = max || FIX_SHOWN_MAX;
    if (n <= cap) return {from: 0, to: n, tokens: list};
    var s = clamp(Math.min(start, end), 0, n - 1), e = clamp(Math.max(start, end), 0, n - 1);
    var from = clamp(Math.floor((s + e + 1) / 2) - Math.floor(cap / 2), 0, n - cap);
    if (s < from) from = s;
    if (e >= from + cap) from = e - cap + 1;
    return {from: from, to: from + cap, tokens: list.slice(from, from + cap)};
}

function clampSpan(tokens, start, end) {
    var n = (tokens || []).length;
    if (n === 0) return {start: -1, end: -1};
    var a = clamp(Math.min(start, end), 0, n - 1), b = clamp(Math.max(start, end), 0, n - 1);
    return {start: a, end: b};
}

function spanText(tokens, start, end) {
    var sp = clampSpan(tokens, start, end);
    if (sp.start < 0) return "";
    var words = [];
    for (var i = sp.start; i <= sp.end; i++) words.push(tokens[i].word || tokens[i].raw);
    return words.join(" ");
}

// The original dictation with only the chosen span replaced: every other
// character (spacing, line breaks, words after the span) is the original
// text, and punctuation that framed the span stays ("Omashi." -> "Omarchy.").
// `tokens` must come from fixTokens(text).
function fixedText(text, tokens, start, end, replacement) {
    var s = String(text || "");
    var sp = clampSpan(tokens, start, end);
    var rep = String(replacement || "").replace(/[\r\n\t]+/g, " ").replace(UNSAFE_CHARS, "").trim();
    if (sp.start < 0 || rep === "") return null;
    var a = tokens[sp.start], b = tokens[sp.end];
    if (typeof a.start !== "number" || typeof b.end !== "number" || s.slice(a.start, a.end) !== a.raw || s.slice(b.start, b.end) !== b.raw) return null;
    return s.slice(0, a.start + a.lead.length) + rep + s.slice(b.end - b.trail.length);
}

var FIX_KINDS = [{value: "sounds_like", label: "sounds like"}, {value: "replace", label: "replace"}, {value: "spelling", label: "spelling"}];

// A sensible first guess: same letters, different case/spacing → spelling;
// a single short word → sounds like; anything else → replace.
function guessFixKind(heard, written) {
    var h = String(heard || "").toLowerCase().replace(/[\s-]+/g, ""), w = String(written || "").toLowerCase().replace(/[\s-]+/g, "");
    if (h !== "" && h === w) return "spelling";
    if (/\s/.test(String(written || "").trim()) && String(written).length > 24) return "replace";
    return "sounds_like";
}

function cycleValue(options, current, delta) {
    var list = options || [];
    if (!list.length) return current;
    var idx = -1;
    for (var i = 0; i < list.length; i++) if (JSON.stringify(list[i].value) === JSON.stringify(current)) { idx = i; break; }
    if (idx < 0) return list[0].value;
    return list[(idx + delta + list.length) % list.length].value;
}

// A row's display label. A value outside the known options comes from the
// config file (bridge data): it is sanitized and capped here, at the
// rendering boundary; writes keep using the raw setting value.
var OPTION_LABEL_MAX = 40;
function optionLabel(options, value, fallback) {
    for (var i = 0; i < (options || []).length; i++) if (JSON.stringify(options[i].value) === JSON.stringify(value)) return sanitize(options[i].label, OPTION_LABEL_MAX);
    return sanitize(fallback !== undefined ? fallback : String(value), OPTION_LABEL_MAX);
}

// ---- Usage -----------------------------------------------------------------

function compactNumber(n) {
    var v = Number(n) || 0;
    if (v >= 1000000) return (v / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
    if (v >= 10000) return Math.round(v / 1000) + "k";
    if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    return String(Math.round(v));
}

function groupedNumber(n) { return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }

function formatDuration(seconds) {
    var s = Math.max(0, Math.round(Number(seconds) || 0));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    if (h > 0) return h + "h " + m + "m";
    if (m > 0) return m + "m";
    return s + "s";
}

function savedLabel(seconds) {
    if (seconds === null || seconds === undefined || !(Number(seconds) > 0)) return "";
    var h = Number(seconds) / 3600;
    if (h >= 1.5) return "≈ " + Math.round(h) + " h saved";
    return "≈ " + Math.max(1, Math.round(Number(seconds) / 60)) + " min saved";
}

// days: [{date:"YYYY-MM-DD", dictations, words, seconds}] → 7×N grid ending
// with the week of `end` (Sunday-first rows, like a contribution graph).
// level 0..4 from quartiles of the non-zero days, so one huge day does
// not flatten the rest.
function heatmap(days, end, weeks) {
    var W = weeks || 52;
    var e = end ? new Date(end.getFullYear(), end.getMonth(), end.getDate()) : new Date();
    var byDate = {};
    var counts = [];
    for (var i = 0; i < (days || []).length; i++) {
        var d = days[i];
        if (!d || typeof d.date !== "string") continue;
        var c = Number(d.dictations) || 0;
        byDate[d.date] = {count: c, words: Number(d.words) || 0};
        if (c > 0) counts.push(c);
    }
    counts.sort(function(a, b) { return a - b; });
    function q(p) { return counts.length ? counts[Math.min(counts.length - 1, Math.floor(p * counts.length))] : 0; }
    var t1 = q(0.25), t2 = q(0.5), t3 = q(0.75);
    var start = new Date(e.getFullYear(), e.getMonth(), e.getDate() - e.getDay() - (W - 1) * 7);
    var cells = [], months = [];
    var lastMonth = -1;
    for (var w = 0; w < W; w++) {
        for (var dow = 0; dow < 7; dow++) {
            var day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + dow);
            if (day > e) continue;
            var key = dayKey(day);
            var v = byDate[key] ? byDate[key].count : 0;
            var level = v <= 0 ? 0 : (v <= t1 ? 1 : (v <= t2 ? 2 : (v <= t3 ? 3 : 4)));
            cells.push({week: w, day: dow, level: level, date: key, count: v, today: day.getTime() === e.getTime()});
            if (dow === 0 && day.getMonth() !== lastMonth) {
                lastMonth = day.getMonth();
                if (w <= W - 3) months.push({week: w, label: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][lastMonth]});
            }
        }
    }
    return {cells: cells, months: months, weeks: W};
}

function todayCount(days, now) {
    var key = dayKey(now || new Date());
    for (var i = 0; i < (days || []).length; i++) if (days[i] && days[i].date === key) return Number(days[i].dictations) || 0;
    return 0;
}

// The four Home numbers and the Usage detail numbers. Unknown values are
// shown as "–", never as a made-up 0.
function usageNumbers(summary, now) {
    var s = summary || {};
    var t = s.totals || {};
    return {
        today: String(todayCount(s.days, now)),
        words: compactNumber(t.words),
        wordsFull: groupedNumber(t.words),
        dictations: groupedNumber(t.dictations),
        spoken: t.seconds ? formatDuration(t.seconds) : "–",
        wpm: t.wpm === null || t.wpm === undefined ? "–" : String(Math.round(t.wpm)),
        saved: savedLabel(t.saved_seconds),
        typing: t.saved_seconds !== null && t.saved_seconds !== undefined && t.seconds ? formatDuration(Number(t.saved_seconds) + Number(t.seconds)) : ""
    };
}

function hourBars(hours) {
    var h = [];
    var max = 0, best = -1;
    for (var i = 0; i < 24; i++) {
        var v = Number((hours || [])[i]) || 0;
        h.push(v);
        if (v > max) { max = v; best = i; }
    }
    var bars = h.map(function(v, i) { return {hour: i, value: max ? v / max : 0, top: i === best && max > 0}; });
    return {bars: bars, busiest: best >= 0 ? "busiest at " + pad2(best) + ":00" : ""};
}

// A11 health: silent failure must never read as zero usage.
// Features whose voxtype hook is not wired yet (voxtype-tui 0.2 reports this
// right after an upgrade, before anything saved the config).
function pendingWiring(health) {
    var p = health && health.pending_wiring;
    var out = [];
    if (!isList(p)) return out;
    for (var i = 0; i < p.length; i++) if (typeof p[i] === "string") out.push(p[i]);
    return out;
}

function healthLine(health) {
    if (!health) return "";
    var parts = [];
    var pending = pendingWiring(health);
    if (pending.indexOf("capture") >= 0) parts.push("Not counting yet: Voxtype isn't connected");
    else if (pending.indexOf("duration") >= 0) parts.push("Durations start once Voxtype is connected");
    else if (pending.length) parts.push("Learning in apps starts once Voxtype is connected");
    var un = toList(health.unavailable).filter(function(u) { return u && pending.indexOf(u.feature) < 0; });
    for (var i = 0; i < un.length && i < 2; i++) if (un[i].reason) parts.push(sanitize(un[i].feature, 20) + ": " + sanitize(un[i].reason, 60));
    if (health.dropped) parts.push(health.dropped + " dictation" + (health.dropped === 1 ? "" : "s") + " not counted");
    var f = toList(health.failures);
    if (f.length) parts.push("last error: " + sanitize(f[f.length - 1].msg || f[f.length - 1].where, 60));
    return parts.join(" · ");
}

// ---- Settings (simple rows) --------------------------------------------------

// Whisper language codes (whisper.cpp's list, most used first).
var LANGUAGES = [
    {value: "auto", label: "Auto-detect"}, {value: "en", label: "English"}, {value: "de", label: "German"},
    {value: "nl", label: "Dutch"}, {value: "fr", label: "French"}, {value: "es", label: "Spanish"},
    {value: "it", label: "Italian"}, {value: "pt", label: "Portuguese"}, {value: "tr", label: "Turkish"},
    {value: "pl", label: "Polish"}, {value: "sv", label: "Swedish"}, {value: "da", label: "Danish"},
    {value: "no", label: "Norwegian"}, {value: "fi", label: "Finnish"}, {value: "cs", label: "Czech"},
    {value: "uk", label: "Ukrainian"}, {value: "ru", label: "Russian"}, {value: "el", label: "Greek"},
    {value: "ro", label: "Romanian"}, {value: "hu", label: "Hungarian"}, {value: "ar", label: "Arabic"},
    {value: "he", label: "Hebrew"}, {value: "hi", label: "Hindi"}, {value: "ja", label: "Japanese"},
    {value: "ko", label: "Korean"}, {value: "zh", label: "Chinese"}, {value: "id", label: "Indonesian"},
    {value: "vi", label: "Vietnamese"}, {value: "th", label: "Thai"}
];

var HOTKEY_MODE_OPTIONS = [{value: "push_to_talk", label: "Hold to talk"}, {value: "toggle", label: "Toggle"}];
var OUTPUT_MODE_OPTIONS = [{value: "type", label: "Typing"}, {value: "clipboard", label: "Clipboard"}, {value: "paste", label: "Paste"}];
var INDICATOR_OPTIONS = [{value: "off", label: "Off"}, {value: "compact", label: "Pill"}, {value: "wide", label: "Wide"},
                         {value: "minimal", label: "Minimal"}, {value: "orb", label: "Orb"}, {value: "tile", label: "Tile"}];
var OSD_POSITIONS = ["bottom-center", "top-center", "bottom-left", "bottom-right", "top-left", "top-right"];
var OTHER_AUDIO_OPTIONS = [{value: "leave", label: "Leave"}, {value: "lower", label: "Lower"}, {value: "pause", label: "Pause"}];

// Voxtype's built-in defaults (voxtype 1.1.1 `voxtype config schema`) for
// the keys whose absence the panel has to read as a value.
var SETTING_DEFAULTS = {
    "engine": "whisper", "whisper.language": "en", "hotkey.mode": "push_to_talk", "hotkey.enabled": true,
    "audio.device": "default", "audio.max_duration_secs": 60, "audio.feedback.enabled": true, "audio.feedback.theme": "default",
    "audio.feedback.volume": 0.5, "output.mode": "type", "output.fallback_to_clipboard": true, "output.auto_submit": false,
    "output.type_delay_ms": 0, "output.post_process.timeout_ms": 5000, "text.spoken_punctuation": false,
    "text.smart_auto_submit": false, "vad.enabled": false, "vad.threshold": 0.5, "whisper.remote_timeout_secs": 30,
    "audio.pause_media": false, "audio.duck_media": false, "audio.duck_media_volume_percent": 34, "audio.duck_media_fade_ms": 150,
    "osd.enabled": true, "osd.layout": "compact", "osd.position": "bottom-center", "osd.opacity": 0.95,
    "text.filter_filler_words": true, "output.restore_clipboard": false, "output.shift_enter_newlines": false,
    "output.notification.on_recording_start": false, "output.notification.on_recording_stop": false,
    "output.notification.on_transcription": true, "output.notification.on_no_speech": true, "output.notification.urgency": "normal"
};

function settingOr(config, path) { return settingValue(config, path, SETTING_DEFAULTS[path]); }

function indicatorValue(config) {
    if (settingOr(config, "osd.enabled") === false) return "off";
    return String(settingOr(config, "osd.layout"));
}
// [path, value] writes for an indicator pick. Off keeps the layout.
function indicatorWrites(value) {
    if (value === "off") return [["osd.enabled", false]];
    return [["osd.enabled", true], ["osd.layout", value]];
}

function otherAudioValue(config) {
    if (settingOr(config, "audio.duck_media") === true) return "lower";
    if (settingOr(config, "audio.pause_media") === true) return "pause";
    return "leave";
}
function otherAudioWrites(value) {
    return [["audio.duck_media", value === "lower"], ["audio.pause_media", value === "pause"]];
}

// "N changed" for a drill-in: keys set to something other than voxtype's
// default (a key whose default the panel does not know counts when set).
function changedCount(config, paths) {
    var n = 0;
    for (var i = 0; i < (paths || []).length; i++) {
        var p = paths[i];
        if (!settingIsSet(config, p)) continue;
        if (!(p in SETTING_DEFAULTS) || JSON.stringify(config[p]) !== JSON.stringify(SETTING_DEFAULTS[p])) n++;
    }
    return n;
}

// Every key the All-settings drill-in edits (its "N changed" badge).
var ADVANCED_PATHS = ["engine", "hotkey.key", "hotkey.modifiers", "hotkey.enabled", "audio.device", "audio.max_duration_secs",
    "audio.feedback.theme", "audio.feedback.volume", "audio.duck_media_volume_percent", "output.fallback_to_clipboard",
    "output.auto_submit", "text.smart_auto_submit", "output.type_delay_ms", "output.restore_clipboard", "output.shift_enter_newlines",
    "vad.enabled", "vad.threshold", "vad.model", "output.post_process.command", "output.post_process.timeout_ms",
    "whisper.remote_endpoint", "whisper.remote_model", "whisper.remote_timeout_secs", "osd.position", "osd.opacity",
    "osd.palette", "osd.frontend", "output.notification.on_recording_start", "output.notification.on_recording_stop", "output.notification.on_transcription",
    "output.notification.on_no_speech", "output.notification.urgency"];

// Settings › simple rows, top to bottom (the cursor order). Rows that need
// voxtype-tui 0.2 are present but say so; the archive details appear only
// while the archive is on.
function simpleSettingsTargets(ctx) {
    var c = ctx || {};
    var out = ["model", "drill.models", "language", "shortcut", "mode", "indicator", "sounds", "other_audio",
               "output_mode", "spoken_punctuation", "filler_words", "login", "usage", "history", "keep"];
    if (c.whisper === false) out.splice(out.indexOf("language"), 1);
    out.push("archive");
    if (c.archiveOn) out = out.concat(["archive.dir", "archive.audio", "archive.text"]);
    out.push("learning");
    if (c.learningOn && c.everywhereAvailable) out.push("everywhere");
    return out.concat(["drill.advanced", "drill.backup"]);
}

// Downloaded models of the current engine, for the Settings › Model cycler.
function modelCycleOptions(rows, current) {
    var out = [];
    var seen = false;
    for (var i = 0; i < (rows || []).length; i++) {
        var m = rows[i];
        if (!m || !m.name || !m.downloaded || modelUnavailable(m) || m.incomplete === true) continue;
        if (m.name === current) seen = true;
        out.push({value: m.name, label: sanitize(m.name, 60)});
    }
    if (current && !seen) out.unshift({value: current, label: sanitize(current, 60)});
    return out;
}

function modelsSummary(rows) {
    var n = 0, bytes = 0;
    for (var i = 0; i < (rows || []).length; i++) {
        if (!rows[i] || !rows[i].downloaded) continue;
        n++;
        bytes += Number(rows[i].on_disk_bytes) || (Number(rows[i].size_mb) || 0) * 1000000;
    }
    return n === 0 ? "none downloaded" : n + " downloaded" + (bytes ? " · " + formatBytes(bytes) : "");
}

var HISTORY_PAGE = 30;

function findRecord(items, id) {
    if (!id) return null;
    for (var i = 0; i < (items || []).length; i++) if (items[i] && items[i].id === id) return items[i];
    return null;
}

// "Omashi → Omarchy" for the footer after a Fix.
// The one-line answer to History › Fix: what was learned, what was only
// suggested, or voxtype-tui's reason for learning nothing ("an ordinary
// word …"), so the user knows to pick "replace" or leave it.
function learnNotice(result) {
    var r = result || {};
    if ((r.applied || []).length) return "Learned " + learnSummary(r.applied);
    if ((r.candidates || []).length) return "Suggested " + learnSummary(r.candidates) + " · review it in Words";
    var skipped = (r.skipped || [])[0];
    var why = skipped && skipped.reason ? skipped.reason : r.reason;
    if (why) return "Not learned: " + sanitize(why, 70);
    return "Nothing new to learn from that";
}

function learnSummary(entries) {
    var e = (entries || [])[0];
    if (!e) return "";
    var heard = isList(e.heard) ? e.heard[0] : e.heard;
    var s = (heard ? sanitize(heard, 30) + " → " : "") + sanitize(e.written, 30);
    return entries.length > 1 ? s + " +" + (entries.length - 1) : s;
}

// `u` on a simple Settings row resets the voxtype key behind it.
var SIMPLE_PATHS = {language: "whisper.language", mode: "hotkey.mode", sounds: "audio.feedback.enabled", output_mode: "output.mode",
                    spoken_punctuation: "text.spoken_punctuation", filler_words: "text.filter_filler_words"};
function simpleSettingPath(key, modelPath) {
    if (key === "model") return String(modelPath || "");
    return Object.prototype.hasOwnProperty.call(SIMPLE_PATHS, key) ? SIMPLE_PATHS[key] : "";
}
