// Parity: the layout-B panel must not lose anything the 0.3.2 panel could do.
//
// 1. Every setting path the bridge accepts (SETTING_TYPES + EXTRA_SETTING_TYPES)
//    has a control in Panel.qml, or is reached through a named route below.
// 2. Every op the 0.3.2 panel sent is still sent, and every bridge op is
//    either sent by the panel or listed as headless with a reason.
// 3. Every 0.3.2 key binding is still bound (1–5 became 1–4, by design).
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const panel = fs.readFileSync(path.join(ROOT, 'Panel.qml'), 'utf8');
const model = fs.readFileSync(path.join(ROOT, 'Model.js'), 'utf8');
const bridge = fs.readFileSync(path.join(ROOT, 'bridge.py'), 'utf8');

function dictKeys(name) {
  const m = bridge.match(new RegExp('^' + name + ': dict\\[str, [^\\]]+\\] = \\{([\\s\\S]*?)^\\}', 'm'));
  assert.ok(m, name + ' not found in bridge.py');
  return [...m[1].matchAll(/^\s+"([a-z0-9_.-]+)":/gm)].map(x => x[1]);
}

// Paths with no settingKey of their own, and the control that reaches them.
const ROUTED = {
  // Per-engine model paths: Manage models › Set active (models.set_active).
  'whisper.model': /op: "models\.set_active"/,
  // The rest of the per-engine model keys share that route; matched below.
  // Modifier list: the Ctrl/Alt/Shift/Super toggles write hotkey.modifiers.
  'hotkey.modifiers': /settingKey: "hotkey\.mod\."|"hotkey\.modifiers"/,
};

test('every bridge setting path has a reachable control', () => {
  const paths = dictKeys('SETTING_TYPES').concat(dictKeys('EXTRA_SETTING_TYPES'));
  assert.ok(paths.length > 40, 'parsed ' + paths.length + ' paths');
  const missing = [];
  for (const p of paths) {
    if (ROUTED[p]) { if (!ROUTED[p].test(panel)) missing.push(p + ' (route gone)'); continue; }
    if (/\.model$/.test(p) && p !== 'vad.model') { if (!/op: "models\.set_active"/.test(panel)) missing.push(p); continue; }
    const quoted = '"' + p + '"';
    if (!panel.includes(quoted) && !model.includes(quoted)) missing.push(p);
  }
  assert.deepEqual(missing, [], 'setting paths with no control: ' + missing.join(', '));
});

// Sent by the 0.3.2 panel (git show e15a033:Panel.qml), directly or as a
// confirmed action.
const OLD_OPS = ['daemon.restart', 'daemon.start', 'daemon.stop', 'dictionary.preview', 'dict.set_category', 'dict.upsert',
  'dict.remove', 'export.preview', 'export.write', 'gpu.set_device', 'gpu.status', 'import.apply', 'import.preview', 'load',
  'models.list', 'models.set_active', 'models.delete', 'options', 'settings.set', 'settings.unset', 'status', 'vocab.add',
  'vocab.remove'];
// Bridge ops the panel never sends, and why.
const HEADLESS = {
  'record.toggle': 'the panel runs `voxtype record toggle` itself (Service.qml), the op serves the bar/CLI',
  'vocab.set': 'bulk reorder for scripts; the panel edits one phrase at a time',
  'archive.pick_dir': 'headless twin of the panel\'s own chooser (Service.pick("dir"))',
  'learn.everywhere.set': '',  // sent: listed here only if the panel stops sending it
};

function sends(op) {
  return panel.includes('op: "' + op + '"') || panel.includes('"' + op + '"');
}

test('every op the 0.3.2 panel used is still sent', () => {
  const lost = OLD_OPS.filter(op => !sends(op));
  assert.deepEqual(lost, []);
});

test('every bridge op is sent by the panel or documented as headless', () => {
  const block = bridge.match(/^OPS: dict\[str, Callable\[\[dict, Paths\], dict\[str, Any\]\]\] = \{([\s\S]*?)^\}/m);
  assert.ok(block, 'OPS table');
  const ops = [...block[1].matchAll(/^\s+"([a-z_.]+)":/gm)].map(x => x[1]);
  assert.ok(ops.length >= 40, 'parsed ' + ops.length + ' ops');
  const unreached = ops.filter(op => !sends(op) && !HEADLESS[op]);
  assert.deepEqual(unreached, [], 'ops with no panel control: ' + unreached.join(', '));
});

test('every 0.3.2 key binding is still bound (sections are now 1–4)', () => {
  const keys = panel.match(/function handleTextKey\(t\) \{[\s\S]*?\n    \}/)[0];
  // 0.3.2: / search · a add (vocabulary, dictionary) · c category (dictionary)
  // · d download (models) · o on/off (dictate) · r/R record · u reset
  // (settings) · y copy the install command (locked).
  const want = [
    [/t === "\/"/, '/'], [/t === "a" && page === "words"/, 'a'], [/t === "c" && page === "words"/, 'c'],
    [/t === "d" && page === "models"/, 'd'], [/t === "o" && page === "home"/, 'o'], [/t === "r" \|\| t === "R"/, 'r'],
    [/t === "u" && \(page === "settings" \|\| page === "advanced"\)/, 'u'], [/t === "y" && canInstallLocked/, 'y'],
  ];
  for (const [re, k] of want) assert.match(keys, re, k);
  assert.match(panel, /Model\.sectionForKey\(t\)/, 'digits still switch sections');
  for (const k of ['Qt.Key_R', 'onTabRequested', 'onMoveRequested', 'onActivateRequested', 'onDeleteRequested', 'onCloseRequested'])
    assert.ok(panel.includes(k), k);
});
