const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {panelHarness} = require('./panel_lifecycle.test.js');

// The marketplace review of 0.3.0 found that the panel's editable Qt text
// inputs let a clipboard owner stall or fill the shared shell: Qt's
// TextInput reads the whole Wayland clipboard text on every clipboard change
// (canPaste) and on paste, with no byte limit and no total deadline, and the
// bar keeps the panel loaded. These tests pin the fix as a contract.

const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const stripComments = s => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const Model = {};
vm.runInNewContext(read('Model.js'), Model);

const shippedQml = fs.readdirSync(root).filter(f => f.endsWith('.qml'));

test('no shipped QML instantiates a Qt text input that reads the clipboard on its own', () => {
  assert.ok(shippedQml.includes('EditField.qml'));
  for (const f of shippedQml) {
    const code = stripComments(read(f));
    // TextInput (and everything built on it: qs.Ui TextField, the SpinBox in
    // qs.Ui NumberField, SearchableDropdown, MultiSelect, Controls TextField
    // and SpinBox) connects QClipboard::dataChanged to a full text read.
    for (const type of ['TextInput', 'TextField', 'NumberField', 'SpinBox', 'SearchableDropdown', 'MultiSelect', 'TextArea'])
      assert.doesNotMatch(code, new RegExp('(^|[^.\\w])' + type + '\\s*\\{', 'm'), `${f} instantiates ${type}`);
    assert.doesNotMatch(code, /\bclipboard\b[\s\S]{0,40}\.(text|mimeData)\b/i, `${f} reads the clipboard in-process`);
    // Service.paste() is the bounded child reader; any other .paste() is a
    // Qt text item reading the clipboard in-process.
    for (const call of code.matchAll(/(\w+)\.paste\(\)/g))
      assert.ok(call[1] === 'service' && f === 'Panel.qml', `${f} calls ${call[0]}`);
  }
});

test('EditField is the only TextEdit, plain text, with every Qt paste path closed', () => {
  const field = stripComments(read('EditField.qml'));
  for (const f of shippedQml.filter(n => n !== 'EditField.qml'))
    assert.doesNotMatch(stripComments(read(f)), /\bTextEdit\s*\{/, `${f} has its own TextEdit`);
  assert.equal((field.match(/\bTextEdit\s*\{/g) || []).length, 1);
  assert.match(field, /textFormat: TextEdit\.PlainText/, 'PlainText: no rich-text mime reads');
  // The paste chords are taken before TextEdit's own key handling.
  assert.match(field, /event\.matches\(StandardKey\.Paste\)/);
  assert.match(field, /Qt\.Key_Insert && \(event\.modifiers & Qt\.ShiftModifier\)/);
  assert.match(field, /root\.pasteRequested\(\);\s*event\.accepted = true;/);
  // Middle-click (primary selection paste) and right-click never reach it.
  assert.match(field, /acceptedButtons: Qt\.MiddleButton \| Qt\.RightButton/);
  assert.doesNotMatch(field, /ContextMenu|DropArea|onDropped/);
  assert.doesNotMatch(field, /persistentSelection: true/);
  // TextEdit's own shortcuts still run for everything else.
  assert.match(field, /event\.accepted = false;\s*}\s*}\s*}/);
});

test('every panel field is an EditField wired to the bounded paste', () => {
  const panel = read('Panel.qml');
  const fields = [...panel.matchAll(/EditField \{\n\s*id: (\w+)\n\s*onPasteRequested: root\.requestPaste\((\w+)\)/g)];
  assert.deepEqual(fields.map(m => m[1]).sort(), ['dictFrom', 'dictSearch', 'dictTo', 'exportPath', 'input', 'number', 'testField', 'vocabSearch']);
  for (const m of fields) assert.equal(m[1], m[2], 'a paste lands in the field that asked');
  assert.equal((panel.match(/EditField \{/g) || []).length, fields.length);
});

test('a paste goes to the field that asked, only while it still has focus', () => {
  const h = panelHarness();
  const pastes = [];
  const field = {activeFocus: true, insertText(t) { pastes.push(t); }};
  let started = 0;
  h.root.service.paste = () => { started++; return true; };
  h.root.focusedEditor = field;
  h.root.requestPaste(field);
  assert.equal(started, 1);
  assert.equal(h.root.pasteTarget, field);
  h.root.finishPaste('hello');
  assert.deepEqual(pastes, ['hello']);
  assert.equal(h.root.pasteTarget, null);

  // Focus moved on while the reader ran: nothing is inserted anywhere.
  h.root.requestPaste(field);
  field.activeFocus = false;
  h.root.finishPaste('late');
  assert.deepEqual(pastes, ['hello']);

  // The panel closed meanwhile.
  field.activeFocus = true;
  h.root.requestPaste(field);
  h.root.controller.hide();
  h.root.finishPaste('closed');
  assert.deepEqual(pastes, ['hello']);
});

test('closing the panel cancels a running paste reader', () => {
  const panel = read('Panel.qml');
  assert.match(panel, /onOpenedChanged: \{\s*if \(!opened\) \{[\s\S]*?pasteTarget = null;\s*service\.cancelPaste\(\);/);
  assert.match(panel, /onPasted: function\(text\) \{ root\.finishPaste\(text\) \}/);
  assert.match(panel, /onPasteFailed: function\(reason\) \{ root\.pasteTarget = null; root\.showNotice\(reason\) \}/);
});

test('Model limits mirror the bridge reader', () => {
  const bridge = read('bridge.py');
  assert.equal(Number(/^PASTE_MAX_BYTES = (\d+)$/m.exec(bridge)[1]), Model.PASTE_MAX_BYTES);
  assert.equal(Number(/^PASTE_TIMEOUT_SECONDS = ([\d.]+)$/m.exec(bridge)[1]) * 1000, Model.PASTE_TIMEOUT_MS);
  assert.equal(Number(/^PASTE_EXIT_TOO_LARGE = (\d+)$/m.exec(bridge)[1]), Model.PASTE_EXIT_TOO_LARGE);
  assert.equal(Number(/^PASTE_EXIT_TIMEOUT = (\d+)$/m.exec(bridge)[1]), Model.PASTE_EXIT_TIMEOUT);
  assert.ok(Model.PASTE_MAX_BYTES <= 16384);
  assert.ok(Model.PASTE_TIMEOUT_MS <= 2000);
});

test('pasteResult and pasteError: only a clean, capped read is inserted', () => {
  assert.equal(Model.pasteResult('abc', 0, false), 'abc');
  assert.equal(Model.pasteResult('abc', 0, true), null, 'deadline hit');
  assert.equal(Model.pasteResult('abc', 1, false), null);
  assert.equal(Model.pasteResult('abc', -1, false), null, 'failed to start / killed');
  assert.equal(Model.pasteResult('x'.repeat(Model.PASTE_MAX_BYTES + 1), 0, false), null);
  assert.match(Model.pasteError(Model.PASTE_EXIT_TOO_LARGE, false), /over 16 KB/);
  assert.match(Model.pasteError(Model.PASTE_EXIT_TIMEOUT, false), /did not answer/);
  assert.match(Model.pasteError(-1, true), /did not answer/);
  assert.match(Model.pasteError(1, false), /no text/);
});

test('spliceText keeps one line, drops unsafe characters and respects the cap', () => {
  const s = (...a) => JSON.parse(JSON.stringify(Model.spliceText(...a)));
  assert.deepEqual(s('hello', 5, 5, ' world'), {text: 'hello world', cursor: 11});
  assert.deepEqual(s('hello', 0, 5, 'bye'), {text: 'bye', cursor: 3}, 'replaces the selection');
  assert.deepEqual(s('ab', 2, 0, 'X'), {text: 'X', cursor: 1}, 'reversed selection');
  assert.deepEqual(s('', 0, 0, 'a\r\nb\tc'), {text: 'a b c', cursor: 5});
  assert.deepEqual(s('', 0, 0, 'a\u202eb\u0000c\u2028d'), {text: 'abcd', cursor: 4});
  assert.deepEqual(s('abc', 1, 1, 'XYZ', 5), {text: 'aXYbc', cursor: 3}, 'clipped to the room left');
  assert.deepEqual(s('abcde', 2, 2, 'XYZ', 5), {text: 'abcde', cursor: 2}, 'full field takes nothing');
  assert.deepEqual(s('', 0, 0, 'a\ud83d\ude00', 2), {text: 'a', cursor: 1}, 'never splits a surrogate pair');
  assert.equal(Model.spliceText('', 0, 0, 'x'.repeat(10000)).text.length, Model.EDIT_MAX_CHARS);
});

test('typedText: printable keys only; Ctrl/Alt/Meta chords never type, AltGr does', () => {
  const C = 0x04000000, A = 0x08000000, M = 0x10000000;
  assert.equal(Model.typedText('a', 0, C, A, M), 'a');
  assert.equal(Model.typedText('é', 0, C, A, M), 'é');
  assert.equal(Model.typedText('@', C | A, C, A, M), '@', 'AltGr');
  assert.equal(Model.typedText('v', C, C, A, M), '');
  assert.equal(Model.typedText('x', M, C, A, M), '');
  for (const bad of ['', '\r', '\t', '\u0016', '\u202e', '\u200b'])
    assert.equal(Model.typedText(bad, 0, C, A, M), '', JSON.stringify(bad));
});

test('number settings clamp every route to the bridge', () => {
  assert.equal(Model.clampNumber('60', 5, 3600, 60), 60);
  assert.equal(Model.clampNumber('99999', 5, 3600, 60), 3600);
  assert.equal(Model.clampNumber('1', 5, 3600, 60), 5);
  assert.equal(Model.clampNumber('', 5, 3600, 60), 60);
  assert.equal(Model.clampNumber('abc', 5, 3600, 60), 60);
  assert.equal(Model.clampNumber(65, 5, 3600, 60), 65);
  assert.equal(Model.clampNumber(7.6, 0, 10, 0), 8);
  const panel = read('Panel.qml');
  const number = panel.slice(panel.indexOf('    component SettingNumber:'), panel.indexOf('    component SettingText:'));
  assert.match(number, /var next = Model\.clampNumber\(value, from, to, current\);/);
  assert.match(number, /if \(next !== current\) root\.setSetting\(settingKey, next\);/);
  assert.match(number, /allowedChars: numberRow\.from < 0 \? \/\[-0-9\]\/ : \/\[0-9\]\//);
  assert.doesNotMatch(number, /NumberField \{/);
});

// ---- Service.qml: the paste reader process -------------------------------

const service = read('Service.qml');
function objectSource(source, id) {
  const start = source.indexOf('id: ' + id + '\n');
  assert.notEqual(start, -1, 'QML object exists: ' + id);
  const end = source.indexOf('\n    }', start);
  return source.slice(start, end === -1 ? undefined : end);
}
function functionSource(source, start) {
  for (let end = source.indexOf('}', start); end !== -1; end = source.indexOf('}', end + 1)) {
    const candidate = source.slice(start, end + 1);
    try { new vm.Script('(' + candidate + ')'); return candidate; } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  throw new Error('Unterminated QML JavaScript function');
}
function pasteService() {
  const deferred = [], events = [];
  const proc = {running: false, signals: [], signal(c) { this.signals.push(c); }};
  const timer = {running: false, interval: 0, restart() { this.running = true; }, stop() { this.running = false; }};
  const svc = {
    Model, pasting: false, pasteTimedOut: false, pasteGeneration: 0,
    paster: proc, pasteDeadline: timer, pasteOutput: {text: ''},
    pasted: text => events.push({text}), pasteFailed: reason => events.push({reason}),
    Qt: {callLater: cb => deferred.push(cb)},
  };
  svc.root = svc;
  const ctx = vm.createContext(svc);
  for (const name of ['paste', 'cancelPaste', 'finishPaste']) {
    const at = service.indexOf('    function ' + name + '(');
    vm.runInContext(functionSource(service, at + 4), ctx);
  }
  const handler = (source, name, scope) => {
    const match = new RegExp('\\b' + name + ':\\s*').exec(source);
    const rest = source.slice(match.index + match[0].length);
    const code = rest.startsWith('function') ? functionSource(rest, 0) : functionSource('function() ' + rest, 0);
    return vm.runInContext('(' + code + ')', scope);
  };
  const scoped = () => vm.createContext(Object.assign(Object.create(null), svc, {root: svc, paster: proc, running: proc.running}));
  return {
    svc, events, proc, timer,
    exit(code) { handler(objectSource(service, 'paster'), 'onExited', ctx)(code); },
    stopped() { proc.running = false; handler(objectSource(service, 'paster'), 'onRunningChanged', scoped())(); },
    deadline() { handler(objectSource(service, 'pasteDeadline'), 'onTriggered', ctx)(); },
    flush() { while (deferred.length) deferred.shift()(); },
  };
}

test('the paste reader is the bridge with a fixed argv, bounded by a backstop deadline', () => {
  assert.match(objectSource(service, 'paster'), /command: \[root\.pythonBinary, root\.bridgePath, "--paste"\]/);
  assert.match(objectSource(service, 'pasteDeadline'), /interval: Model\.PASTE_TIMEOUT_MS \+ 2000/);
  assert.match(objectSource(service, 'pasteDeadline'), /root\.pasteTimedOut = true;\s*if \(paster\.running\) paster\.signal\(9\);/);
});

test('one paste at a time; a clean exit delivers the text once', () => {
  const h = pasteService();
  assert.equal(h.svc.paste(), true);
  assert.equal(h.svc.paste(), false, 'second request while one runs');
  assert.equal(h.timer.running, true);
  h.proc.running = true;
  h.svc.pasteOutput.text = 'voxtype';
  h.exit(0);
  assert.deepEqual(h.events, [{text: 'voxtype'}]);
  assert.equal(h.svc.pasting, false);
  assert.equal(h.timer.running, false);
  h.exit(0);
  assert.equal(h.events.length, 1, 'a second exit signal is ignored');
});

test('a stalled clipboard owner is killed at the deadline and nothing is inserted', () => {
  const h = pasteService();
  h.svc.paste();
  h.proc.running = true;
  h.deadline();
  assert.deepEqual(h.proc.signals, [9]);
  h.svc.pasteOutput.text = 'partial';
  h.exit(-1);
  assert.equal(h.events.length, 1);
  assert.match(h.events[0].reason, /did not answer/);
});

test('oversized, empty or failed reads report a notice and insert nothing', () => {
  for (const [code, re] of [[Model.PASTE_EXIT_TOO_LARGE, /over 16 KB/], [1, /no text/], [Model.PASTE_EXIT_TIMEOUT, /did not answer/]]) {
    const h = pasteService();
    h.svc.paste();
    h.svc.pasteOutput.text = 'ignored';
    h.exit(code);
    assert.equal(h.events.length, 1);
    assert.match(h.events[0].reason, re);
  }
});

test('a reader that never starts completes as a failure; cancel kills a running one', () => {
  const h = pasteService();
  h.svc.paste();
  h.stopped();
  h.flush();
  assert.equal(h.events.length, 1);
  assert.ok(h.events[0].reason);
  const c = pasteService();
  c.svc.paste();
  c.proc.running = true;
  c.svc.cancelPaste();
  assert.deepEqual(c.proc.signals, [9]);
  assert.equal(c.svc.pasting, false);
  c.exit(0);
  assert.equal(c.events.length, 0, 'a cancelled paste never delivers');
});
