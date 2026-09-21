// Pure helpers for the Voxtype panel. No Qt imports: Node runs these directly
// (tests/model.test.js) and the QML side imports the same file.

var SECTIONS = ["dictate", "vocabulary", "dictionary", "settings", "models"];
var SECTION_LABELS = {dictate: "Dictate", vocabulary: "Vocabulary", dictionary: "Dictionary", settings: "Settings", models: "Models"};
var TOKEN_LIMIT = 224;
var TOKEN_AMBER = 200;
var RESPONSE_CAP = 2 * 1024 * 1024;
var ERROR_TUI_MISSING = "voxtype-tui-missing";
var ERROR_PICKER_MISSING = "zenity is not installed — install it to import a bundle";
var ERROR_TERMINAL_MISSING = "omarchy-launch-terminal is not available — run sudo voxtype setup gpu in a terminal";

var MODIFIER_LABELS = {LEFTCTRL: "Ctrl", LEFTALT: "Alt", LEFTSHIFT: "Shift", LEFTMETA: "Super",
                       RIGHTCTRL: "Ctrl", RIGHTALT: "AltGr", RIGHTSHIFT: "Shift", RIGHTMETA: "Super"};

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

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

// Locked states, in precedence order. The hint command is shown and copied,
// never executed by the panel.
function lockedState(status, error) {
    if (error === ERROR_TUI_MISSING) return {kind: "tui", title: "Install voxtype-tui (AUR) to manage Voxtype here", hint: "The panel is a front end over the voxtype-tui Python package.\nInstall it from the AUR, then reopen this panel.", command: ""};
    if (status && status.voxtype_installed === false) return {kind: "voxtype", title: "Voxtype is not installed", hint: "Run this in a terminal, then reopen the panel:", command: "omarchy install voxtype"};
    if (status && status.config_exists === false) return {kind: "setup", title: "Voxtype is installed but not set up", hint: "Run the setup wizard in a terminal, then reopen the panel:", command: "voxtype setup"};
    return null;
}

function heroMeta(status, error) {
    if (error === ERROR_TUI_MISSING) return "voxtype-tui is not installed";
    if (status && status.voxtype_installed === false) return "Voxtype is not installed";
    if (status && status.config_exists === false) return "Not set up yet";
    if (!status) return error ? "Unavailable" : "Checking…";
    var state = daemonState(status);
    if (state === "stopped") return "Stopped";
    if (state === "recording") return "Recording…";
    if (state === "transcribing") return "Transcribing…";
    if (status.daemon.stale) return "Restart to apply changes";
    var model = status.model && status.model.name ? status.model.name : (status.engine || "");
    return "Listening · " + model + " · " + hotkeyLabel(status.hotkey);
}

function primaryAction(status) {
    if (!status || status.voxtype_installed === false || status.config_exists === false) return "";
    var state = daemonState(status);
    if (state === "stopped") return "start";
    if (status.daemon.stale) return "restart";
    return "record";
}

function primaryLabel(action, state) {
    if (action === "start") return "Start";
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

// Why `x` / Enter on a model row does nothing, in words for the footer.
function modelActionBlock(m, action) {
    if (!m) return "";
    if (action === "delete") {
        if (m.active) return "Set another model active first";
        if (!m.downloaded) return "Not downloaded";
    }
    if (action === "download" && m.downloaded) return "Already downloaded";
    return "";
}

function modelStatus(m) {
    if (!m) return "";
    if (m.active) return "active";
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
        out.push({value: m.name, label: sanitize(m.name, 80) + (m.downloaded ? "" : "  (not downloaded)")});
    }
    if (current && !seen) out.push({value: current, label: sanitize(current, 80)});
    return out;
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
    if (c.editing) return section === "vocabulary" ? [["Enter", "add"], ["Esc", "back"]] : [["Enter", "save"], ["Esc", "cancel"]];
    var move = c.cursorActive ? [] : [["↑↓", "move"]];
    if (section === "dictate") return move.concat([["r", "record"], ["Ctrl+R", "restart"], ["1–5", "sections"]]);
    if (section === "vocabulary") return move.concat([["/", "search"], ["a", "add"], ["x", "delete"], ["Tab", "next"]]);
    if (section === "dictionary") return move.concat([["/", "search"], ["a", "add"], ["c", "category"], ["x", "delete"]]);
    if (section === "settings") return move.concat([["Enter", "change"], ["u", "reset"], ["Tab", "next"]]);
    if (section === "models") return move.concat([["Enter", "set active"], ["d", "download"], ["x", "delete"]]);
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

function sanitize(text, max) {
    var s = String(text === null || text === undefined ? "" : text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
    var lim = max || 200;
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
