const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Runs the actual root-level JavaScript functions of Panel.qml (and the
// Service signal handlers wired inside it) in a Node VM. The harness only
// supplies the ids those functions touch, Qt's deferred queue and a fake
// Service; it never re-implements panel logic.
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const panel = read('Panel.qml');

function functionSource(source, start) {
  for (let end = source.indexOf('}', start); end !== -1; end = source.indexOf('}', end + 1)) {
    const candidate = source.slice(start, end + 1);
    try { new vm.Script('(' + candidate + ')'); return candidate; } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  throw new Error('Unterminated QML JavaScript function');
}
function installFunctions(source, context) {
  for (const match of source.matchAll(/^    function (\w+)\(/gm)) {
    vm.runInContext(functionSource(source, match.index + 4), context);
  }
}
function objectSource(source, id) {
  const start = source.indexOf('id: ' + id + '\n');
  assert.notEqual(start, -1, 'QML object exists: ' + id);
  const end = source.indexOf('\n    }', start);
  return source.slice(start, end === -1 ? undefined : end);
}
function handler(source, name, context) {
  const match = new RegExp('\\b' + name + ':\\s*').exec(source);
  if (!match) return () => {};
  const body = source.slice(match.index + match[0].length);
  const code = body.startsWith('function') ? functionSource(body, 0)
    : body.startsWith('{') ? functionSource('function() ' + body, 0)
    : 'function() { ' + body.split('\n')[0].replace(/\s*}\s*$/, '') + ' }';
  return vm.runInContext('(' + code + ')', context);
}
function timer() { return {running: false, restart() { this.running = true; }, stop() { this.running = false; }}; }
function field() { return {text: '', focused: 0, activeFocus: false, forceActiveFocus() { this.focused++; }, selectAll() {}}; }

function panelHarness(overrides) {
  const Model = {};
  vm.runInNewContext(read('Model.js'), Model);
  const deferred = [], requests = [], picks = [], copies = [];
  const root = Object.assign({
    Model,
    status: {voxtype_installed: true, config_exists: true, daemon: {active: true, state: 'idle', stale: false}, engine: 'whisper', model: {name: 'base', present: true}},
    snapshot: {vocabulary: [], replacements: [], settings: {}}, options: null, modelRows: [], modelsEngine: '', browseEngine: '', gpu: null,
    restartNeeded: [], errorText: '', notice: '', tuiMissing: false, loaded: true, previewOutput: '',
    exportPreview: null, importPreview: null, importPath: '', attaching: false, popoutSwitchClosing: false,
    importAcceptDangerous: false, importReview: '', importChanged: false,
    section: 'home', cursorKey: '', cursorIndex: -1, cursorActive: false, focusedEditor: null, openPopups: 0,
    confirmAction: '', confirmPayload: null, dictCategory: 'Replacement', exportOpen: false, exportScope: 'sync',
    exportSecrets: false, importLocal: false, importSettings: false, hostWidget: {id: 'widget'}, bar: {activePopout: null},
    anchorItem: null,
    controller: {open: true, show() { this.open = true; }, hide() { this.open = false; }},
    keyCatcher: field(), testField: field(), wordsField: field(), historySearch: field(), exportPath: field(),
    engineDropdown: {opened: 0, open() { this.opened++; }},
    confirmation: {opened: false, message: '', confirmText: '', selectedIndex: 1},
    body: {contentY: 0, height: 300, contentHeight: 900, contentItem: {}},
    exportForm: {y: 640, height: 120, visible: false, mapToItem() { return {x: 0, y: this.y}; }},
    importCard: {y: 700, height: 150, visible: false, mapToItem() { return {x: 0, y: this.y}; }},
    settingsForm: {controlFor() { return null; }},
    noticeTimer: timer(), previewDebounce: timer(), statusPoll: timer(),
    Style: {space: n => n},
    Qt: {callLater: cb => deferred.push(cb)},
    service: {
      busy: false, picking: false, downloading: false, recording: false, request: {}, daemonState: 'idle', stateFilePath: '/run/user/1000/voxtype/state',
      run(payload) { requests.push(payload); return true; },
      cancelQueued() {},
      pick() { if (this.picking) return false; this.picking = true; picks.push(true); return true; },
      cancelPick() { this.cancelled = (this.cancelled || 0) + 1; this.picking = false; },
      toggleRecord() { return true; }, download() { return true; }, launchGpuSetup() {}, cancelDownload() {},
      copy(text) { copies.push(text); return true; },
      cancelPaste() {},
    },
  }, overrides || {});
  // Plain `property <type> name: <literal>` declarations start at their QML
  // defaults, so a new state property does not need a hand-written fixture.
  for (const m of panel.matchAll(/^    property (?:string|int|bool|real|var) (\w+): (.+)$/gm)) {
    if (m[1] in root) continue;
    try { root[m[1]] = vm.runInNewContext('(' + m[2] + ')', {}); } catch (_) { /* binding, not a literal */ }
  }
  root.root = root;
  const context = vm.createContext(root);
  const bind = (name, expr) => Object.defineProperty(root, name, {get: () => vm.runInContext(expr, context), configurable: true});
  // Every single-line readonly property binding of the panel becomes a live
  // getter, so derived state (locked, engine, editing…) follows the real QML.
  for (const m of panel.matchAll(/^    readonly property \w+ (\w+): (.+)$/gm)) {
    if (!(m[1] in root) && !m[2].endsWith('[')) bind(m[1], m[2]);
  }
  // Multi-line array bindings (sectionOptions, settingsTargets).
  for (const m of panel.matchAll(/^    readonly property var (\w+): \[\n([\s\S]*?)\n    \]/gm)) {
    if (!(m[1] in root)) bind(m[1], '[' + m[2] + ']');
  }
  Object.defineProperty(root, 'opened', {get: () => root.controller.open});
  installFunctions(panel, context);
  const serviceSource = objectSource(panel, 'service');
  const on = name => handler(serviceSource, name, context);
  return {
    root, requests, picks, copies,
    complete(op, result, req) { root.service.busy = false; on('onCompleted')(op, result, req || {op}); },
    picked(p) { root.service.picking = false; on('onPicked')(p); },
    pickCanceled() { root.service.picking = false; on('onPickCanceled')(); },
    pickFailed() { root.service.picking = false; on('onPickFailed')(); },
    engineChanged() { handler(panel, 'onEngineChanged', context)(); },
    setInside(code) { return vm.runInContext(code, context); },
    flush() { while (deferred.length) deferred.shift()(); },
  };
}

module.exports = {panelHarness};

test('a late chooser result cannot reclaim the screen once another widget owns the popout', () => {
  const h = panelHarness();
  h.root.section = 'settings'; h.root.view = 'models';
  h.root.beginImport();
  assert.equal(h.root.controller.open, false, 'hidden for the chooser');
  assert.equal(h.root.attaching, true);
  // Our hide released the popout; a foreign widget then takes it, so the
  // bar never calls closeForPopoutSwitch on us.
  h.root.bar.activePopout = {foreign: true};
  h.picked('/tmp/bundle.json');
  h.flush();
  assert.equal(h.root.controller.open, false, 'panel must not show over the foreign popout');
  assert.equal(h.root.attaching, false);
  assert.equal(h.root.importPath, '/tmp/bundle.json', 'the chosen bundle is still kept');
  assert.ok(h.requests.some(r => r.op === 'import.preview'), 'preview still requested');
});

test('the chooser result reopens the panel when the popout is free or ours', () => {
  const h = panelHarness();
  h.root.beginImport();
  h.root.bar.activePopout = null;
  h.pickCanceled();
  assert.equal(h.root.controller.open, true);
  h.root.beginImport();
  h.root.bar.activePopout = h.root.hostWidget;
  h.pickCanceled();
  assert.equal(h.root.controller.open, true);
  h.root.hostWidget = null;
  h.root.beginImport();
  h.setInside('bar.activePopout = root');
  h.pickCanceled();
  assert.equal(h.root.controller.open, true, 'root itself is the owner when unhosted');
});

test('closeForPopoutSwitch cancels a running chooser and drops the attach flag', () => {
  const h = panelHarness();
  h.root.beginImport();
  h.root.closeForPopoutSwitch();
  assert.equal(h.root.attaching, false);
  assert.equal(h.root.service.cancelled, 1, 'picker cancelled');
  assert.equal(h.root.popoutSwitchClosing, true);
  h.pickCanceled();
  assert.equal(h.root.controller.open, false);
  h.flush();
  assert.equal(h.root.popoutSwitchClosing, false);
});

test('confirmation messages and row text strip bidi/control characters from untrusted strings', () => {
  const h = panelHarness();
  const evil = 'evil\u202ephrase\u0007!';
  h.root.snapshot = {vocabulary: [{phrase: evil}], replacements: [{from: evil, to: 'x\u202e', category: 'Replacement'}], settings: {}};
  // Words: one list, A–Z by what is written (the word, then the rule).
  h.root.section = 'words';
  h.root.setCursor('rows', 0);
  h.root.deleteSelected();
  assert.equal(h.root.confirmation.opened, true);
  assert.doesNotMatch(h.root.confirmation.message, /[\u202e\u0007]/);
  assert.match(h.root.confirmation.message, /evilphrase!/);
  assert.equal(h.root.confirmPayload.phrase, evil, 'the bridge still gets the exact phrase to remove');
  h.root.confirmation.opened = false;
  h.root.setCursor('rows', 1);
  h.root.deleteSelected();
  assert.equal(h.root.confirmAction, 'dict.remove');
  assert.doesNotMatch(h.root.confirmation.message, /[\u202e\u0007]/);
  h.root.confirmation.opened = false;
  h.root.section = 'settings'; h.root.view = 'models';
  h.root.modelsEngine = 'whisper';
  h.root.modelRows = [{name: 'm\u202e' + 'x'.repeat(100), downloaded: true, active: false}];
  h.root.setCursor('rows', 0);
  h.root.deleteSelected();
  assert.doesNotMatch(h.root.confirmation.message, /\u202e/);
  assert.ok(h.root.confirmation.message.length < 120, 'dialog strings are capped at 60');
  h.root.confirmation.opened = false;
  h.root.ask('vocab.remove', {}, 'a\u202eb'.repeat(400), 'Remove');
  assert.doesNotMatch(h.root.confirmation.message, /\u202e/);
  assert.ok(h.root.confirmation.message.length <= 600);
});

test('every row text binding for bridge strings goes through Model.sanitize', () => {
  // Words rows (vocabulary, rules and learned entries share WordRow).
  assert.match(panel, /text: wordRow\.word\.heard \? Model\.sanitize\(wordRow\.word\.heard, 80\) : "–"/);
  assert.match(panel, /text: Model\.sanitize\(wordRow\.word\.written, 120\)/);
  assert.match(panel, /text: Model\.sanitize\(modelRow\.modelData\.name, 120\)/);
  // History rows, the expanded text, the raw-vs-final words and Fix tokens.
  assert.match(panel, /text: Model\.sanitize\(line\.item\.text, 200\)/);
  assert.match(panel, /text: Model\.historyDetailText\(detail\.record\)/);
  assert.match(panel, /text: Model\.sanitize\(modelData\.raw, 40\)/);
  assert.doesNotMatch(panel, /text: (wordRow\.word\.written|line\.item\.text|modelRow\.modelData\.name|modelData\.raw)[;\s]/);
  assert.doesNotMatch(panel, /text: wordRow\.word\.heard[;\n]/);
});

test('redacted import rows never reach a value formatter, in the card or the confirmation', () => {
  const h = panelHarness();
  h.root.importPath = '/tmp/b.json';
  h.root.importPreview = {review: 'r'.repeat(64), format: 'v2', warnings: [], diff: {settings_change: [
    {path: 'whisper.remote_api_key', dangerous: true, redacted: true, old_set: true, new_set: true},
    {path: 'output.post_process.command', dangerous: true, old: 'a', new: 'rm -rf'},
  ]}};
  h.root.askImport();
  assert.match(h.root.confirmation.message, /whisper\.remote_api_key will be replaced/);
  assert.match(h.root.confirmation.message, /output\.post_process\.command: a → rm -rf/);
  assert.doesNotMatch(h.root.confirmation.message, /undefined/);
  assert.equal(h.root.confirmation.confirmText, 'Import anyway');
  assert.match(panel, /text: \(modelData\.dangerous \? "󰀦 " : \(modelData\.overflow \? "" : "· "\)\) \+ modelData\.text/);
  assert.doesNotMatch(panel, /modelData\.(old|new)\b/);
});

// ---- F3: the card renders every settings row, not only the dangerous ones -

test('the import card renders every settings_change row, dangerous ones distinguished, inside the scrolling Flickable', () => {
  const h = panelHarness();
  const Model = h.root.Model;
  // The Repeater model expression, taken from the QML rather than re-implemented.
  const expr = panel.match(/model: root\.importPreview \? (Model\.settingsRows\([^\n]*?)\s*:\s*\[\]/)[1];
  h.root.importPath = '/tmp/b.json';
  h.root.importPreview = {review: 'r'.repeat(64), format: 'v2', warnings: [], diff: {settings_change: [
    {path: 'audio.device', old: 'default', new: 'yeti', dangerous: false},
    {path: 'engine', old: 'whisper', new: 'parakeet', dangerous: true},
    {path: 'whisper.remote_api_key', dangerous: true, redacted: true, old_set: true, new_set: true},
  ]}};
  const rows = JSON.parse(JSON.stringify(h.setInside('(' + expr + ')')));
  assert.equal(rows.length, 3, 'the non-dangerous row is rendered too, not collapsed into "N settings"');
  assert.ok(rows.some(r => r.text === 'audio.device: default → yeti'), 'old → new is visible');
  assert.equal(rows.filter(r => r.dangerous).length, 2);
  assert.ok(rows.some(r => r.text === 'whisper.remote_api_key will be replaced'));
  for (const r of rows) assert.doesNotMatch(r.text, /undefined/);

  // No cap-free rendering: a long bridge list ends in one overflow line.
  const many = [];
  for (let i = 0; i < 40; i++) many.push({path: 'meeting.hook' + i, old: 'a', new: 'b', dangerous: false});
  h.root.importPreview = {review: 'r'.repeat(64), format: 'v2', warnings: [], diff: {settings_change: many}};
  const capped = JSON.parse(JSON.stringify(h.setInside('(' + expr + ')')));
  assert.ok(capped.length <= Model.IMPORT_CARD_ROWS + 1, 'capped at ' + Model.IMPORT_CARD_ROWS + ' rows + overflow');
  assert.equal(capped[capped.length - 1].overflow, true);
  assert.match(capped[capped.length - 1].text, /and \d+ more changes/);

  // The card lives inside the panel body Flickable, so a long list scrolls.
  const bodyStart = panel.indexOf('Flickable {\n                        id: body');
  assert.notEqual(bodyStart, -1);
  const cardStart = panel.indexOf('id: importCard');
  assert.ok(cardStart > bodyStart, 'importCard is nested inside the body Flickable');
  assert.match(panel, /id: importCard[\s\S]{0,400}implicitHeight: importColumn\.implicitHeight/, 'the card grows with its content');
});

// ---- F1: accept_dangerous is an acknowledgement, not a constant -----------

test('accept_dangerous is false for a clean diff and true only when the dialog named every dangerous row', () => {
  const h = panelHarness();
  h.root.importPath = '/tmp/b.json';
  // No dangerous rows: the bridge gate must stay live.
  h.root.importPreview = {review: 'r'.repeat(64), format: 'v2', warnings: [], diff: {settings_change: [{path: 'audio.device', old: 'a', new: 'b', dangerous: false}]}};
  h.root.askImport();
  assert.equal(h.root.importAcceptDangerous, false);
  assert.equal(h.root.confirmation.confirmText, 'Import', 'no dangerous rows: plain Import');
  h.root.applyConfirmed();
  const clean = h.requests.pop();
  assert.equal(clean.op, 'import.apply');
  assert.equal(clean.accept_dangerous, false, 'a clean import never pre-waives the bridge refusal');
  h.root.confirmation.opened = false;  // onConfirmed closed the dialog

  // Dangerous rows the dialog fully enumerates: acknowledged.
  h.root.importPreview = {review: 'r'.repeat(64), format: 'v2', warnings: [], diff: {settings_change: [
    {path: 'output.pre_recording_command', old: '', new: 'curl evil', dangerous: true},
    {path: 'engine', old: 'whisper', new: 'parakeet', dangerous: true},
  ]}};
  h.root.askImport();
  assert.equal(h.root.importAcceptDangerous, true);
  assert.equal(h.root.confirmation.confirmText, 'Import anyway');
  assert.match(h.root.confirmation.message, /output\.pre_recording_command/);
  assert.match(h.root.confirmation.message, /engine/);
  h.root.applyConfirmed();
  const risky = h.requests.pop();
  assert.equal(risky.accept_dangerous, true);
  assert.equal(h.root.importAcceptDangerous, false, 'the acknowledgement is consumed, never sticky');
});

test('an unreviewable dangerous list is not acknowledged, so the bridge refuses instead of the panel waiving it', () => {
  const h = panelHarness();
  const Model = h.root.Model;
  h.root.importPath = '/tmp/huge.json';
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push({path: 'meeting.hook' + i, old: 'a', new: 'b', dangerous: true});
  h.root.importPreview = {review: 'r'.repeat(64), format: 'v2', warnings: [], diff: {settings_change: rows}};
  h.root.askImport();
  assert.equal(h.root.importAcceptDangerous, false, 'nothing the user could read = nothing acknowledged');
  assert.match(h.root.confirmation.message, /40 dangerous changes/);
  h.root.applyConfirmed();
  assert.equal(h.requests.pop().accept_dangerous, false);
  // The mid tier still names every path, so it counts as acknowledged.
  const mid = [];
  for (let i = 0; i < 12; i++) mid.push({path: 'meeting.hook' + i, old: 'a', new: 'b', dangerous: true});
  assert.equal(Model.importConfirmation('x.json', {settings_change: mid}).accept, true);
  assert.equal(Model.importConfirmation('x.json', {settings_change: rows}).accept, false);
  assert.equal(Model.importConfirmation('x.json', {settings_change: []}).accept, false);
});

test('a dangerous-changes refusal from the bridge asks for a fresh preview instead of dumping the protocol error', () => {
  const h = panelHarness();
  h.root.importPath = '/tmp/b.json';
  h.root.importPreview = {review: 'r'.repeat(64), format: 'v2', warnings: [], diff: {settings_change: [{path: 'engine', old: 'a', new: 'b', dangerous: true}]}};
  h.root.importAcceptDangerous = true;
  h.complete('import.apply', {ok: false, error: 'dangerous-changes', dangerous: ['engine'], diff: {}, warnings: []}, {op: 'import.apply'});
  assert.doesNotMatch(h.root.errorText, /dangerous-changes/, 'no raw protocol string in the UI');
  assert.match(h.root.errorText, /[Pp]review it again/);
  assert.equal(h.root.importPreview, null, 'the stale preview is dropped');
  assert.equal(h.root.importAcceptDangerous, false, 'the stale acknowledgement is dropped too');
});

// ---- Review binding: a confirmation covers one preview, not a path ---------

test('import.apply carries the review token of the preview the dialog was built from, once', () => {
  const h = panelHarness();
  h.root.importPath = '/tmp/b.json';
  const token = 'a'.repeat(64);
  h.root.importPreview = {review: token, format: 'v2', warnings: [], diff: {settings_change: [{path: 'engine', old: 'a', new: 'b', dangerous: true}]}};
  h.root.askImport();
  assert.equal(h.root.importReview, token);
  // A newer preview arriving while the dialog is open does not re-bind it.
  h.root.importPreview = {review: 'b'.repeat(64), format: 'v2', warnings: [], diff: {settings_change: []}};
  h.root.applyConfirmed();
  const apply = h.requests.pop();
  assert.equal(apply.op, 'import.apply');
  assert.equal(apply.review, token, 'the token of what the dialog showed');
  assert.equal(h.root.importReview, '', 'consumed, never sticky');
});

test('a preview without a review token cannot open the import confirmation', () => {
  const h = panelHarness();
  h.root.importPath = '/tmp/b.json';
  for (const review of [undefined, '', 7]) {
    h.root.importPreview = {review, format: 'v2', warnings: [], diff: {settings_change: []}};
    h.root.askImport();
    assert.notEqual(h.root.confirmAction, 'import.apply');
    assert.equal(h.root.importReview, '');
  }
});

test('review-mismatch (file changed after preview) drops the confirmation and loads a fresh preview', () => {
  const h = panelHarness();
  h.root.importPath = '/tmp/b.json';
  h.root.importSettings = true;
  h.root.importPreview = {review: 'a'.repeat(64), format: 'v2', warnings: [], diff: {settings_change: [{path: 'engine', old: 'a', new: 'b', dangerous: true}]}};
  h.root.askImport();
  assert.equal(h.root.confirmation.opened, true);
  // What the dialog's onConfirmed does: close, then applyConfirmed().
  h.root.confirmation.opened = false;
  h.root.applyConfirmed();
  h.requests.length = 0;
  h.complete('import.apply', {ok: false, error: 'review-mismatch', dangerous: ['output.post_process.command'], diff: {}, warnings: []}, {op: 'import.apply'});
  assert.equal(h.root.importPreview, null, 'the stale preview is gone');
  assert.equal(h.root.importAcceptDangerous, false);
  assert.equal(h.root.importReview, '');
  const again = h.requests.pop();
  assert.equal(again.op, 'import.preview', 'the new bytes are shown before anything is applied');
  assert.equal(again.include_settings, true, 'same flags as the confirmed preview');
  assert.ok(!h.requests.some(r => r.op === 'import.apply'), 'nothing is re-applied automatically');
  assert.doesNotMatch(h.root.errorText, /review-mismatch/);
  h.complete('import.preview', {ok: true, review: 'c'.repeat(64), format: 'v2', warnings: [], diff: {settings_change: []}}, {op: 'import.preview'});
  assert.match(h.root.errorText, /changed after you reviewed it/);
  assert.equal(h.root.confirmation.opened, false, 'the user must confirm again');
});

test('cancelling the import confirmation drops the acknowledgement', () => {
  const h = panelHarness();
  h.root.importPath = '/tmp/b.json';
  h.root.importPreview = {review: 'r'.repeat(64), format: 'v2', warnings: [], diff: {settings_change: [{path: 'engine', old: 'a', new: 'b', dangerous: true}]}};
  h.root.askImport();
  assert.equal(h.root.importAcceptDangerous, true);
  h.root.closeForPopoutSwitch();
  assert.equal(h.root.importAcceptDangerous, false);
  assert.match(panel, /onCanceled: \{[^\n]*root\.importAcceptDangerous = false/, 'Cancel clears it too');
});

// ---- F2: include_settings is explicit on both ops and defaults OFF -------

test('both import ops send include_settings explicitly, defaulting OFF like voxtype-tui', () => {
  const h = panelHarness();
  h.root.section = 'settings'; h.root.view = 'models';
  h.root.beginImport();
  h.picked('/tmp/bundle.json');
  h.flush();
  const preview = h.requests.find(r => r.op === 'import.preview');
  assert.ok(preview, 'preview requested');
  assert.equal('include_settings' in preview, true, 'never left to the bridge default');
  assert.equal(preview.include_settings, false, 'voxtype-tui ships this OFF');
  assert.equal(preview.include_local, false);

  h.root.importPreview = {review: 'r'.repeat(64), format: 'v2', warnings: [], diff: {settings_change: []}};
  h.root.askImport();
  h.root.applyConfirmed();
  const apply = h.requests.pop();
  assert.equal(apply.op, 'import.apply');
  assert.equal('include_settings' in apply, true);
  assert.equal(apply.include_settings, false);
});

test('toggling Include settings re-previews with the new flag so the reviewed diff is the applied diff', () => {
  const h = panelHarness();
  h.root.importPath = '/tmp/bundle.json';
  h.root.importPreview = {review: 'r'.repeat(64), format: 'v2', warnings: [], diff: {settings_change: [{path: 'engine', old: 'a', new: 'b', dangerous: true}]}};
  h.root.askImport();
  assert.equal(h.root.importAcceptDangerous, true);
  h.requests.length = 0;

  h.root.setImportSettings(true);
  assert.equal(h.root.importSettings, true);
  assert.equal(h.root.importAcceptDangerous, false, 'the old acknowledgement no longer describes the diff');
  const again = h.requests.pop();
  assert.equal(again.op, 'import.preview');
  assert.equal(again.include_settings, true, 'the preview follows the toggle');
  assert.equal(again.path, '/tmp/bundle.json');

  h.root.setImportSettings(true);
  assert.equal(h.requests.length, 0, 'no redundant preview when the value did not change');
  h.root.setImportSettings(false);
  assert.equal(h.requests.pop().include_settings, false);
});

test('a fresh import always starts with settings excluded, whatever the last bundle used', () => {
  const h = panelHarness();
  h.root.section = 'settings'; h.root.view = 'models';
  h.root.importSettings = true;
  h.root.importAcceptDangerous = true;
  h.root.beginImport();
  assert.equal(h.root.importSettings, false, 'the safe default is re-armed per bundle');
  assert.equal(h.root.importAcceptDangerous, false);
});

test('the Include settings control is the shipped kit Toggle, not hand-rolled chrome', () => {
  assert.match(panel, /Toggle \{\n\s*id: includeSettingsToggle[\s\S]{0,400}label: "Include settings"/);
  assert.match(panel, /checked: root\.importSettings/);
  assert.match(panel, /onClicked: root\.setImportSettings\(!root\.importSettings\)/);
  assert.match(panel, /property bool importSettings: false/, 'default OFF, mirroring importLocal');
});

// ---- F4: the dialog-message BUILDER, end to end ---------------------------

test('no untrusted value can inject a line break into a confirmation, on any ask() path', () => {
  const h = panelHarness();
  // A phrase that tries to push the real question off the card and render its
  // own question right above the Cancel/Remove buttons.
  const evil = 'coffee\u000a\u000d\u0009\u2028\u2029\u200b\u00ad\ufeff\n\n\n\n\n\n\n\n\n\nDelete every model?';
  const breaks = /[\r\n\u2028\u2029]/;

  h.root.snapshot = {vocabulary: [{phrase: evil}], replacements: [{from: evil, to: evil, category: 'Replacement'}], settings: {}};

  h.root.section = 'words';
  const rows = h.root.wordsView.rows;
  h.root.setCursor('rows', rows.findIndex(r => r.kind === 'vocab'));
  h.root.deleteSelected();
  assert.equal(h.root.confirmation.opened, true);
  assert.doesNotMatch(h.root.confirmation.message, breaks, 'vocab delete: no injected break');
  assert.match(h.root.confirmation.message, /^Remove “coffee /, 'the real question stays first');
  assert.equal(h.root.confirmPayload.phrase, evil, 'the bridge still gets the exact phrase');

  h.root.confirmation.opened = false;
  h.root.setCursor('rows', rows.findIndex(r => r.kind === 'rule'));
  h.root.deleteSelected();
  assert.doesNotMatch(h.root.confirmation.message, breaks, 'dict delete: no injected break');
  assert.match(h.root.confirmation.message, /^Delete the rule /);

  h.root.confirmation.opened = false;
  h.root.section = 'settings'; h.root.view = 'models';
  h.root.modelsEngine = 'whisper';
  h.root.modelRows = [{name: evil, downloaded: true, active: false}];
  h.root.setCursor('rows', 0);
  h.root.deleteSelected();
  // This path DOES carry a deliberate literal \n in the panel's own copy.
  assert.match(h.root.confirmation.message, /^Delete coffee /, 'the real question stays first');
  assert.equal(h.root.confirmation.message.split('\n').length, 2, 'exactly the one static newline the panel wrote');
  assert.match(h.root.confirmation.message, /\nIt can be downloaded again later\.$/, 'the static \\n still works');

  // The import confirmation builds from bundle path, diff rows and warnings.
  h.root.confirmation.opened = false;
  h.root.importPath = '/tmp/' + evil + '.json';
  h.root.importPreview = {review: 'r'.repeat(64), format: 'v2', warnings: [], diff: {settings_change: [
    {path: evil, old: evil, new: evil, dangerous: true},
  ]}};
  h.root.askImport();
  const lines = h.root.confirmation.message.split('\n');
  assert.equal(lines.length, 3, 'exactly the lines importConfirmation joined, no injected extras');
  assert.match(lines[0], /^Import coffee /);
  for (const l of lines) assert.doesNotMatch(l, /[\u2028\u2029\u200b\u00ad\ufeff\r\t]/);
});

test('a missing zenity reopens the panel with an install hint instead of a silent cancel', () => {
  const h = panelHarness();
  h.root.beginImport();
  h.pickFailed();
  assert.equal(h.root.controller.open, true);
  assert.equal(h.root.errorText, h.root.Model.ERROR_PICKER_MISSING);
  assert.match(h.root.errorText, /zenity is not installed — install it to import a bundle/);
  h.root.beginImport();
  h.pickCanceled();
  assert.equal(h.root.errorText, h.root.Model.ERROR_PICKER_MISSING, 'a cancel does not touch the error text');
});

test('missing helpers disable Import and the GPU buttons; an old bridge without the flags keeps them enabled', () => {
  const h = panelHarness();
  assert.equal(h.root.pickerAvailable, true);
  assert.equal(h.root.terminalAvailable, true);
  h.root.status = Object.assign({}, h.root.status, {picker_available: false, terminal_launcher_available: false});
  assert.equal(h.root.pickerAvailable, false);
  assert.equal(h.root.terminalAvailable, false);
  h.root.beginImport();
  assert.equal(h.picks.length, 0, 'no chooser spawned');
  assert.equal(h.root.controller.open, true, 'panel stays visible');
  const hides = [];
  h.root.controller.hide = () => hides.push(1);
  h.root.launchGpu(true);
  assert.equal(hides.length, 0, 'panel not hidden for a terminal that cannot open');
  assert.match(panel, /enabled: !service\.picking && root\.pickerAvailable/);
  assert.equal((panel.match(/enabled: root\.terminalAvailable/g) || []).length, 2, 'both GPU buttons');
  assert.match(panel, /tooltipText: root\.terminalAvailable \? "Opens a terminal running sudo voxtype setup gpu --enable" : Model\.ERROR_TERMINAL_MISSING/);
  assert.match(panel, /tooltipText: root\.pickerAvailable \? "[^"]+" : Model\.ERROR_PICKER_MISSING/);
});

test('a missing config.toml locks the panel with a copyable, never executed, voxtype setup hint', () => {
  const h = panelHarness();
  assert.equal(h.root.locked, false);
  h.root.status = Object.assign({}, h.root.status, {config_exists: false});
  assert.equal(h.root.locked, true);
  assert.equal(h.root.lockedState.title, 'Voxtype is installed but not set up');
  assert.equal(h.root.lockedCommand, 'voxtype setup');
  assert.equal(h.root.primary, '');
  h.root.activateCursor();
  assert.deepEqual(h.copies.slice(), ['voxtype setup'], 'Enter copies the command');
  assert.equal(h.root.notice, 'Copied');
  h.root.toggleRecord();
  h.root.setSetting('engine', 'parakeet');
  assert.equal(h.requests.length, 0, 'locked: no bridge writes');
  assert.doesNotMatch(panel, /execDetached|"voxtype", "setup"/);
  assert.match(panel, /text: root\.lockedCommand; iconText: "󰆏"/);
  assert.match(panel, /onClicked: root\.copyLockedCommand\(\)/);
  h.root.status = Object.assign({}, h.root.status, {voxtype_installed: false});
  assert.equal(h.root.lockedCommand, 'omarchy install dictation voxtype', 'not-installed wins over not-set-up');
});

test('a missing voxtype-tui locks the panel with a copyable install command', () => {
  const h = panelHarness();
  h.root.tuiMissing = true;
  assert.equal(h.root.locked, true);
  assert.equal(h.root.lockedCommand, 'omarchy pkg aur add voxtype-tui');
  h.root.handleTextKey('y');
  assert.deepEqual(h.copies.slice(), ['omarchy pkg aur add voxtype-tui'], 'y copies the command');
  assert.equal(h.requests.length, 0, 'locked: nothing runs');
});

test('an engine switch shows a neutral loading state until its catalog arrives', () => {
  const h = panelHarness();
  h.root.section = 'settings'; h.root.view = 'models';
  h.root.loaded = false;
  assert.equal(h.root.modelsLoading, true, 'nothing loaded yet');
  h.root.loaded = true;
  h.complete('models.list', {ok: true, engine: 'whisper', models: [{name: 'base', downloaded: true}]}, {op: 'models.list', engine: 'whisper'});
  assert.equal(h.root.modelsLoading, false);
  h.root.snapshot = {settings: {engine: 'parakeet'}};
  assert.equal(h.root.engine, 'parakeet');
  assert.equal(h.root.modelsLoading, true, 'stale whisper catalog is not shown as parakeet having no models');
  h.complete('models.list', {ok: true, engine: 'parakeet', models: []}, {op: 'models.list', engine: 'parakeet'});
  assert.equal(h.root.modelsLoading, false, 'now an honest empty state');
  assert.match(panel, /title: root\.modelsLoading \? "Reading the model catalog…" : "No models known for " \+ Model\.engineLabel\(root\.options, root\.modelsView\)/);
});

test('u resets the cursor setting to its default only when the key is actually set', () => {
  const h = panelHarness();
  h.root.section = 'settings';
  h.root.view = 'advanced';
  h.root.snapshot = {settings: {'whisper.language': 'en', 'hotkey.modifiers': ['LEFTCTRL']}};
  h.root.handleTextKey('u');
  assert.equal(h.requests.length, 0, 'no cursor, nothing happens');
  h.root.setCursor('whisper.language', -1);
  h.root.handleTextKey('u');
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests)), [{op: 'settings.unset', path: 'whisper.language'}]);
  h.root.setCursor('audio.device', -1);
  h.root.handleTextKey('u');
  assert.equal(h.requests.length, 1, 'already at default: no write');
  h.root.setCursor('hotkey.mod.LEFTALT', -1);
  h.root.handleTextKey('u');
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[1])), {op: 'settings.unset', path: 'hotkey.modifiers'});
  h.root.setCursor('gpu.enable', -1);
  h.root.handleTextKey('u');
  assert.equal(h.requests.length, 2, 'GPU buttons are not settings');
  // The simple Settings rows reset the key behind them.
  h.root.view = '';
  h.root.setCursor('language', -1);
  h.root.handleTextKey('u');
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[2])), {op: 'settings.unset', path: 'whisper.language'});
  h.root.setCursor('drill.models', -1);
  h.root.handleTextKey('u');
  assert.equal(h.requests.length, 3, 'a drill-in row has nothing to reset');
  h.root.section = 'settings';
  h.root.view = 'models';
  h.root.setCursor('engine', -1);
  h.root.handleTextKey('u');
  assert.equal(h.requests.length, 3, 'u is a Settings-only verb');
  // Every settings component carries the reset action and the default tag.
  for (const c of ['SettingToggle', 'SettingDropdown', 'SettingNumber', 'SettingText', 'SettingSlider']) {
    const body = panel.slice(panel.indexOf('component ' + c + ':'));
    const own = body.slice(0, body.indexOf('\n    component ', 10) > 0 ? body.indexOf('\n    component ', 10) : undefined);
    assert.match(own, /SettingLabel \{|ResetButton \{/, c + ' has a reset action');
    assert.match(own, /readonly property bool isSet: Model\.settingIsSet\(root\.config, settingKey\)/, c);
  }
  assert.match(panel, /component ResetButton: PanelActionButton \{[\s\S]*?iconText: "󰕌"[\s\S]*?onClicked: root\.unsetSetting\(settingKey\)/);
  assert.match(panel, /visible: !labelRow\.isSet; text: "default"/);
});

test('x on the active or not-downloaded model shows a footer notice instead of a silent no-op', () => {
  const h = panelHarness();
  h.root.section = 'settings'; h.root.view = 'models';
  h.root.modelsEngine = 'whisper';
  h.root.modelRows = [{name: 'base', downloaded: true, active: true}, {name: 'tiny', downloaded: false, active: false}, {name: 'small', downloaded: true, active: false}];
  h.root.setCursor('rows', 0);
  h.root.deleteSelected();
  assert.equal(h.root.confirmation.opened, false);
  assert.equal(h.root.notice, 'Set another model active first');
  assert.equal(h.root.noticeTimer.running, true);
  h.root.setCursor('rows', 1);
  h.root.deleteSelected();
  assert.equal(h.root.notice, 'Not downloaded');
  h.root.setCursor('rows', 2);
  h.root.deleteSelected();
  assert.equal(h.root.confirmation.opened, true, 'a deletable model still confirms');
  h.root.confirmation.opened = false;
  h.root.setCursor('rows', 0);
  h.root.handleTextKey('d');
  assert.equal(h.root.notice, 'Already downloaded');
  // The bridge's own refusal reaches the footer as the error text.
  h.complete('models.delete', {ok: false, error: 'model base is active'}, {op: 'models.delete', name: 'base'});
  assert.equal(h.root.errorText, 'model base is active');
});

test('the export form and the import preview scroll into view when they open', () => {
  const h = panelHarness();
  h.root.section = 'settings'; h.root.view = 'models';
  h.root.toggleExport();
  assert.equal(h.root.exportOpen, true);
  assert.equal(h.root.body.contentY, 0, 'deferred until the form has laid out');
  h.root.exportForm.visible = true;
  h.flush();
  assert.equal(h.root.body.contentY, 600, 'clamped to contentHeight - height');
  h.root.body.contentY = 0;
  h.root.body.contentHeight = 2000;
  h.complete('import.preview', {ok: true, format: 'v2', warnings: [], diff: {}}, {op: 'import.preview'});
  h.root.importCard.visible = true;
  h.flush();
  assert.equal(h.root.body.contentY, 700 - 12);
  h.root.body.contentY = 0;
  h.root.toggleExport();
  h.flush();
  assert.equal(h.root.exportOpen, false);
  assert.equal(h.root.body.contentY, 0, 'closing does not scroll');
});

test('footer hints mirror the live key bindings: every hinted key is bound and every page-scoped binding is hinted', () => {
  const h = panelHarness();
  const Model = h.root.Model;
  const textKeys = panel.match(/function handleTextKey\(t\) \{[\s\S]*?\n    \}/)[0];
  // Page-scoped letter bindings actually present in handleTextKey:
  // `t === "c" && page === "words"` and `t === "u" && (page === "a" || page === "b")`.
  const bound = {};
  const add = (page, key) => (bound[page] = bound[page] || new Set()).add(key);
  for (const m of textKeys.matchAll(/t === "([a-z\/])" && page === "(\w+)"/g)) add(m[2], m[1]);
  for (const m of textKeys.matchAll(/t === "([a-z\/])" && \(page === "(\w+)" \|\| page === "(\w+)"\)/g)) { add(m[2], m[1]); add(m[3], m[1]); }
  assert.match(textKeys, /t === "\/"/, '/ is bound for every page');
  assert.match(textKeys, /t === "r" \|\| t === "R"/, 'r is global');
  // Catcher-level verbs available everywhere.
  const catcher = {Enter: /onActivateRequested: root\.activateCursor\(\)/, x: /onDeleteRequested: root\.deleteSelected\(\)/, Tab: /onTabRequested/,
                   '↑↓': /onMoveRequested/, '←→': /else root\.moveCursorH\(dx\)/, Esc: /onCloseRequested: root\.goBack\(\)/,
                   'Ctrl+R': /Qt\.Key_R\) \{ restartDaemon\(\)/, '1–4': /Model\.sectionForKey\(t\)/};
  const pages = Model.SECTIONS.map(s => ({page: s, section: s, view: ''}))
    .concat(Object.keys(Model.DRILLS).map(v => ({page: v, section: Model.DRILLS[v], view: v})));
  for (const {page, section, view} of pages) {
    for (const editing of [false, true]) for (const cursorActive of [false, true]) {
      const ctx = {editing, cursorActive, view};
      const pairs = Model.hintPairs(section, ctx);
      const text = Model.sectionHints(section, ctx);
      assert.equal(text, pairs.map(p => p.join(' ')).join('   '));
      for (const [key] of pairs) {
        if (catcher[key]) { assert.match(panel, catcher[key], key + ' in ' + page); continue; }
        if (key === '/' || key === 'r') continue;
        if (key === 'Shift+A–Z') { assert.match(textKeys, /page === "words" && \/\^\[A-Z\]\$\/\.test\(t\)\) jumpToLetter\(t\)/); continue; }
        assert.ok(bound[page] && bound[page].has(key), page + ' hints "' + key + '" but handleTextKey does not bind it');
      }
      if (editing) assert.ok(pairs.some(p => p[0] === 'Esc'), 'editing: Esc leaves the field');
      if (page === 'usage') continue;
      if (!cursorActive && !editing) assert.equal(pairs[0][0], '↑↓', 'no cursor yet: show how to get one');
      if (cursorActive && !editing) assert.notEqual(pairs[0][0], '↑↓', 'cursor active: hints show the verbs instead');
    }
    // and the reverse: every letter bound for this page appears in its idle
    // hints (Words: on a word row or on a learned row).
    const idle = new Set(Model.hintPairs(section, {editing: false, cursorActive: true, view}).map(p => p[0])
      .concat(Model.hintPairs(section, {editing: false, cursorActive: true, view, rowKind: 'learned'}).map(p => p[0])));
    for (const key of bound[page] || []) assert.ok(idle.has(key), page + ' binds "' + key + '" without hinting it');
  }
  for (const [key] of Model.hintPairs('words', {cursorActive: true, rowKind: 'learned'}))
    if (!catcher[key]) assert.ok(bound.words.has(key), 'learned row hints "' + key + '"');
  assert.match(panel, /rowKind: root\.cursorWord\(\) \? root\.cursorWord\(\)\.kind : ""/);
  // Fix a word has its own hints, and its keys are bound.
  assert.equal(JSON.stringify(Model.hintPairs('history', {fixing: true}).map(p => p[0])), JSON.stringify(['←→', 'Enter', 'Esc']));
  assert.match(textKeys, /if \(fixStage === "pick"\) \{\n\s*if \(t === "\]"\) growFix\(1\);\n\s*else if \(t === "\["\) growFix\(-1\);/);
  assert.match(panel, /Model\.sectionHints\(root\.section, \{editing: root\.editing, cursorActive: root\.cursorActive, view: root\.view, fixing: root\.fixStage === "pick", fixField: root\.fixStage === "type", rowKind: root\.cursorWord\(\) \? root\.cursorWord\(\)\.kind : ""\}\)/);
  assert.doesNotMatch(panel, /pid " \+/, 'the idle footer no longer prints the PID');
  assert.match(panel, /idleText: root\.locked \? "" : Model\.footerIdle\(root\.status\)/);
});

test('on/off: o stops and starts the unit, never restarts or disables it', () => {
  const h = panelHarness();
  const daemon = (over) => Object.assign({active: true, active_state: 'active', state: 'idle', ready: true, stale: false, starts_at_login: true}, over);
  h.root.status = Object.assign({}, h.root.status, {daemon: daemon(), state_file_path: '/run/user/1000/voxtype/state'});
  h.root.handleTextKey('o');
  assert.equal(JSON.stringify(h.requests.map(r => r.op)), JSON.stringify(['daemon.stop']), 'o while running stops');
  assert.equal(h.root.notice, 'Turning off…');
  h.complete('daemon.stop', {ok: true, daemon: {active: false}});
  assert.equal(h.root.notice, 'Turned off');
  assert.equal(h.requests[h.requests.length - 1].op, 'status');

  // Now off. Ctrl+R / middle-click must not quietly turn it back on (systemctl restart starts a stopped unit).
  h.root.status = Object.assign({}, h.root.status, {daemon: daemon({active: false, active_state: 'inactive', state: 'stopped', ready: false, stale: true})});
  h.root.service.daemonState = 'stopped';
  h.requests.length = 0;
  h.root.restartDaemon();
  h.root.restartIfStale();
  assert.equal(JSON.stringify(h.requests), JSON.stringify([]), 'restart is refused while off');
  assert.match(h.root.notice, /not running · press o/);
  assert.equal(h.root.stale, false, 'off is not "restart to apply"');

  h.root.handleTextKey('o');
  assert.equal(JSON.stringify(h.requests.map(r => r.op)), JSON.stringify(['daemon.start']), 'o while off starts');
  h.root.restartNeeded = ['engine'];
  h.complete('daemon.start', {ok: true, daemon: {active: true}});
  assert.equal(JSON.stringify(h.root.restartNeeded), JSON.stringify([]), 'a fresh start has read the saved config');

  // The Turn on hero button is the same start.
  h.requests.length = 0;
  assert.equal(h.root.primary, 'start');
  h.root.runPrimary();
  assert.equal(JSON.stringify(h.requests.map(r => r.op)), JSON.stringify(['daemon.start']));

  // o is Home-only; elsewhere it is not bound.
  h.requests.length = 0;
  h.root.section = 'words';
  h.root.handleTextKey('o');
  assert.equal(JSON.stringify(h.requests), JSON.stringify([]));

  // No enable/disable/restart op anywhere on the power path.
  const power = panel.match(/function togglePower\(\) \{[\s\S]*?\n    function runPrimary/)[0];
  assert.doesNotMatch(power, /daemon\.restart|disable|enable/);
});

test('on/off: turning off mid-dictation asks first, Cancel keeps it running', () => {
  const h = panelHarness();
  h.root.status = Object.assign({}, h.root.status, {daemon: {active: true, active_state: 'active', state: 'recording', ready: true, stale: false}});
  h.root.service.daemonState = 'recording';
  h.root.togglePower();
  assert.equal(JSON.stringify(h.requests), JSON.stringify([]), 'nothing stopped before the answer');
  assert.equal(h.root.confirmation.opened, true);
  assert.equal(h.root.confirmation.selectedIndex, 0, 'Cancel is the default');
  assert.match(h.root.confirmation.message, /drops this dictation/);
  h.root.confirmation.opened = false; h.root.confirmAction = ''; h.root.confirmPayload = null; // Cancel
  assert.equal(JSON.stringify(h.requests), JSON.stringify([]));
  h.root.togglePower();
  h.root.confirmation.opened = false;
  h.root.applyConfirmed();
  assert.equal(JSON.stringify(h.requests.map(r => r.op)), JSON.stringify(['daemon.stop']));
});

test('on/off: a second press while a start/stop is in flight is ignored, and the Dictate cursor reaches the button', () => {
  const h = panelHarness();
  h.root.service.powering = true;
  h.root.togglePower();
  h.root.turnOn();
  h.root.restartDaemon();
  assert.equal(JSON.stringify(h.requests), JSON.stringify([]));
  assert.equal(JSON.stringify(h.root.targetsFor('home').slice(0, 3)), JSON.stringify(['record', 'power', 'restart']));
  assert.match(panel, /else if \(key === "power"\) togglePower\(\)/);
  assert.match(panel, /hoverCursor\("power", -1\)/);
});

test('the panel forgets options and gpu status when appropriate, and asks the bridge for an 18 s restart wait', () => {
  const h = panelHarness();
  h.root.options = {engines: ['whisper']};
  h.root.gpu = {ok: true};
  h.root.restartDaemon();
  const restart = JSON.parse(JSON.stringify(h.requests.pop()));
  assert.deepEqual(restart, {op: 'daemon.restart', timeout: 18});
  // The readiness wait the panel asks for, plus systemctl's own blocking
  // restart inside the bridge, must fit under the Service deadline — else the
  // panel kills a bridge that succeeded. bridge.py owns the other half.
  const service = fs.readFileSync(path.join(__dirname, '..', 'Service.qml'), 'utf8');
  const deadlineMs = Number(service.match(/payload\.op === "daemon\.restart" \? (\d+)/)[1]);
  assert.equal(deadlineMs, 40000);
  assert.ok(restart.timeout * 1000 + 15000 < deadlineMs,
    'timeout ' + restart.timeout + ' s + systemctl 15 s must stay under the ' + deadlineMs + ' ms deadline');
  h.root.launchGpu(true);
  assert.equal(h.root.gpu, null, 'gpu status is stale once the terminal runs setup');
  assert.match(panel, /onOpenedChanged: \{[\s\S]*?options = null;/, 'options invalidated on close');
  assert.match(panel, /if \(op === "status"\) \{\n\s*var first = !root\.status \|\| !root\.status\.capabilities;\n\s*root\.status = result;\n\s*service\.status = result;/);
});

test('every Settings cursor target is reachable and visible: Clear key is skipped until a key is set, GPU controls scroll into view', () => {
  const h = panelHarness();
  h.root.section = 'settings';
  h.root.view = 'advanced';
  assert.ok(h.root.targetsFor('advanced').indexOf('remote.clear') < 0, 'no key stored: the invisible Clear button is not a cursor stop');
  h.root.snapshot = {settings: {'whisper.remote_api_key_set': true}};
  assert.ok(h.root.targetsFor('advanced').indexOf('remote.clear') >= 0);
  for (const key of ['gpu.device', 'gpu.enable', 'gpu.disable']) assert.ok(h.root.targetsFor('advanced').indexOf(key) >= 0, key);
  assert.match(panel, /hoverCursor\("gpu\.device", -1\) \}\n\s*onHasCursorChanged: if \(hasCursor\) root\.followCursor\(gpuDevice\)/);
  assert.equal((panel.match(/root\.followCursor\(gpuButtons\)/g) || []).length, 2);
  assert.match(panel, /root\.followCursor\(clearKey\)/);
  assert.match(panel, /onClicked: root\.toggleModifier\(modelData\)/);
  assert.match(panel, /onHasCursorChanged: if \(hasCursor\) root\.followCursor\(this\)\n\s*onClicked: root\.toggleModifier/);
  // Models: every non-row cursor target scrolls into view too, so Enter never lands on an off-screen Import button.
  assert.equal((panel.match(/root\.followCursor\(backupRow\)/g) || []).length, 2);
  assert.match(panel, /root\.followCursor\(engineDropdown\)/);
  const cursorTargets = new Set([...panel.matchAll(/(?:set|hover)Cursor\("([\w.]+)", -1\)/g)].map(m => m[1]));
  for (const key of ['export', 'import', 'engine', 'gpu.device', 'gpu.enable', 'gpu.disable', 'remote.clear', 'record', 'restart', 'download', 'test', 'search']) assert.ok(cursorTargets.has(key), key);
});

// ---- F6: conditionally-hidden Settings controls leave the cursor order ----
//
// Eight controls sit inside Rows with a `visible:` predicate. A static cursor
// list walked j/k onto them while off screen, and Enter then called
// forceActiveFocus() on an invisible TextField or open() on an invisible
// Dropdown. Only the live shell shows that; here the predicate is pinned
// against the very `visible:` bindings it mirrors.

test('Settings cursor targets drop every conditionally-hidden control (engine, feedback, VAD, API key)', () => {
  const h = panelHarness();
  h.root.section = 'settings';
  h.root.view = 'advanced';
  const targets = () => h.root.targetsFor('advanced');
  const has = key => targets().indexOf(key) >= 0;

  const whisperOnly = ['whisper.language', 'whisper.remote_endpoint', 'whisper.remote_model', 'whisper.remote_timeout_secs'];
  const feedbackOnly = ['audio.feedback.theme', 'audio.feedback.volume'];
  const vadOnly = ['vad.threshold', 'vad.model'];

  // Defaults: whisper engine, feedback on (fallback true), VAD off (fallback false), no API key.
  h.root.snapshot = {settings: {}};
  for (const k of whisperOnly) assert.ok(has(k), 'whisper engine shows ' + k);
  for (const k of feedbackOnly) assert.ok(has(k), 'feedback defaults on: ' + k);
  for (const k of vadOnly) assert.ok(!has(k), 'VAD defaults off: ' + k + ' must not be a cursor stop');
  assert.ok(!has('remote.clear'), 'no stored key: Clear is hidden');

  // A non-whisper engine hides the language field and the whole remote block.
  h.root.snapshot = {settings: {engine: 'parakeet', 'whisper.remote_api_key_set': true}};
  assert.equal(h.root.engine, 'parakeet');
  for (const k of whisperOnly) assert.ok(!has(k), 'engine !== whisper must drop ' + k);
  assert.ok(!has('remote.clear'), 'the Clear button is inside the whisper-only block');
  assert.ok(has('engine') && has('gpu.enable'), 'unconditional controls stay');

  // Feedback off hides its theme and volume Row.
  h.root.snapshot = {settings: {'audio.feedback.enabled': false}};
  for (const k of feedbackOnly) assert.ok(!has(k), 'feedback off must drop ' + k);
  assert.ok(has('audio.feedback.enabled'), 'the toggle itself stays reachable');

  // VAD on reveals its Row.
  h.root.snapshot = {settings: {'vad.enabled': true}};
  for (const k of vadOnly) assert.ok(has(k), 'VAD on shows ' + k);

  // Everything hidden at once: j/k must never land on an invisible control.
  h.root.snapshot = {settings: {engine: 'parakeet', 'audio.feedback.enabled': false, 'vad.enabled': false}};
  for (const k of whisperOnly.concat(feedbackOnly, vadOnly, ['remote.clear'])) assert.ok(!has(k), k);
  const list = JSON.parse(JSON.stringify(targets()));
  assert.equal(new Set(list).size, list.length, 'no duplicate cursor stops');
  h.root.cursorActive = false;
  for (let i = 0; i < list.length + 3; i++) {
    h.root.moveCursor(1);
    assert.ok(list.indexOf(h.root.cursorKey) >= 0, 'j landed on ' + h.root.cursorKey + ', which is not on screen');
  }
});

test('the cursor predicates mirror the visible: bindings that actually drive those Rows', () => {
  // If a Row's condition is edited, this fails rather than drifting silently.
  assert.match(panel, /visible: Model\.settingValue\(root\.config, "audio\.feedback\.enabled", true\) === true/);
  assert.match(panel, /visible: Model\.settingValue\(root\.config, "vad\.enabled", false\) === true/);
  assert.match(panel, /settingKey: "whisper\.language";[^\n]*visible: root\.engine === "whisper"/);
  assert.match(panel, /settingKey: "whisper\.remote_endpoint";[^\n]*visible: root\.engine === "whisper"/);
  assert.equal((panel.match(/visible: root\.engine === "whisper"/g) || []).length, 7, 'both separators, header, language, endpoint and the two whisper Rows, plus the simple Language row');
  assert.match(panel, /visible: Model\.settingValue\(root\.config, "whisper\.remote_api_key_set", false\) === true/);
  // The predicate is Node-testable, not inlined in the QML.
  assert.match(panel, /readonly property var settingsTargets: Model\.settingsTargets\(config, engine, modelPath\)/);
  assert.match(panel, /if \(name === "advanced"\) return settingsTargets;/);
});

test('locked install: Enter hides the panel and hands the fixed kind to the floating terminal; y still copies', () => {
  const installs = [];
  const h = panelHarness();
  h.root.service.launchInstall = kind => { installs.push(kind); return true; };
  h.root.tuiMissing = true;
  assert.equal(h.root.canInstallLocked, true);
  assert.equal(h.root.lockedState.install, 'Install voxtype-tui');
  h.root.handleTextKey('y');
  assert.deepEqual(h.copies.slice(), ['omarchy pkg aur add voxtype-tui'], 'y copies');
  h.root.handleTextKey('2');
  assert.equal(h.root.section, 'home', 'section keys stay dead while locked');
  h.root.activateCursor();
  assert.deepEqual(installs, ['tui']);
  assert.equal(h.root.opened, false, 'panel hides before the terminal opens over it');
  assert.equal(h.requests.length, 0, 'the bridge is never asked to install anything');

  h.root.tuiMissing = false;
  h.root.status = Object.assign({}, h.root.status, {voxtype_installed: false});
  h.root.controller.show();
  h.root.activateCursor();
  assert.deepEqual(installs, ['tui', 'voxtype']);

  h.root.status = Object.assign({}, h.root.status, {voxtype_installed: true, config_exists: false});
  assert.equal(h.root.canInstallLocked, false, 'the setup state offers copy only');
});

test('without Omarchy\'s floating-terminal launcher the locked state falls back to copy', () => {
  const installs = [];
  const h = panelHarness();
  h.root.service.launchInstall = kind => { installs.push(kind); return true; };
  h.root.tuiMissing = true;
  h.root.status = Object.assign({}, h.root.status, {install_terminal_available: false});
  assert.equal(h.root.canInstallLocked, false);
  h.root.activateCursor();
  assert.deepEqual(installs, []);
  assert.deepEqual(h.copies.slice(), ['omarchy pkg aur add voxtype-tui']);
});


// ---- extra models: Qwen3-ASR engine without a model yet, unavailable rows ----

test('picking Qwen3-ASR with no model downloaded browses its catalog instead of failing', () => {
  const h = panelHarness();
  h.root.section = 'settings'; h.root.view = 'models';
  h.root.options = {engines: ['whisper', 'qwen3-asr'], engine_labels: {'qwen3-asr': 'Qwen3-ASR'}};
  h.root.pickModelsEngine('qwen3-asr');
  const set = JSON.parse(JSON.stringify(h.requests.pop()));
  assert.deepEqual(set, {op: 'settings.set', path: 'engine', value: 'qwen3-asr'});
  h.requests.length = 0;
  h.complete('settings.set', {ok: false, error: 'no Qwen3-ASR model is downloaded yet — download one first', needs_download: true, engine: 'qwen3-asr'}, set);
  assert.equal(h.root.browseEngine, 'qwen3-asr');
  assert.equal(h.root.modelsView, 'qwen3-asr');
  assert.equal(h.root.errorText, '', 'not an error: the user just has to download one');
  assert.match(h.root.notice, /No Qwen3-ASR model yet/);
  const ops = JSON.parse(JSON.stringify(h.requests));
  assert.ok(ops.some(r => r.op === 'load'), 'the optimistic engine echo is undone');
  assert.ok(ops.some(r => r.op === 'models.list' && r.engine === 'qwen3-asr'), 'its catalog is listed');
  // The reload restores the real engine; picking it again leaves browse mode.
  h.complete('load', {ok: true, snapshot: {vocabulary: [], replacements: [], settings: {engine: 'whisper'}}}, {op: 'load'});
  assert.equal(h.root.engine, 'whisper');
  assert.equal(h.root.modelsView, 'qwen3-asr', 'still browsing after the reload');
  h.root.pickModelsEngine('whisper');
  assert.equal(h.root.browseEngine, '');
});

for (const selector of ['models', 'settings']) {
  test(`explicit ${selector} engine selection leaves failed Qwen3 catalog browsing`, () => {
    const h = panelHarness();
    h.root.section = selector;
    h.root.pickModelsEngine('qwen3-asr');
    h.engineChanged();
    const req = {op: 'settings.set', path: 'engine', value: 'qwen3-asr'};
    h.complete('settings.set', {ok: false, needs_download: true, engine: 'qwen3-asr'}, req);
    h.complete('load', {ok: true, snapshot: {settings: {engine: 'whisper'}}});
    h.engineChanged();
    assert.equal(h.root.modelsView, 'qwen3-asr', 'reload preserves legitimate failure browsing');
    h.requests.length = 0;
    if (selector === 'models') h.root.pickModelsEngine('parakeet');
    else h.root.setSetting('engine', 'parakeet');
    h.engineChanged();
    h.complete('settings.set', {ok: true, snapshot: {settings: {engine: 'parakeet'}}},
      {op: 'settings.set', path: 'engine', value: 'parakeet'});
    assert.equal(h.root.modelsView, 'parakeet');
    assert.equal(h.root.browseEngine, '');
    assert.equal(h.requests.at(-1).engine, 'parakeet');
  });
}

test('settings selecting the already active engine also leaves failed catalog browsing', () => {
  const h = panelHarness({browseEngine: 'qwen3-asr', section: 'settings', snapshot: {settings: {engine: 'whisper'}}});
  h.root.setSetting('engine', 'whisper');
  assert.equal(h.root.modelsView, 'whisper');
  assert.equal(h.root.browseEngine, '');
  assert.equal(h.requests.at(-1).op, 'models.list');
  assert.equal(h.requests.at(-1).engine, 'whisper');
  assert.ok(!h.requests.some(r => r.op === 'settings.set'), 'no unnecessary config write');
});

test('unavailable model rows explain themselves and never start a download', () => {
  const h = panelHarness();
  h.root.section = 'settings'; h.root.view = 'models';
  h.root.modelsEngine = 'whisper';
  h.root.modelRows = [{name: 'large-v3-turbo-q5_0', downloaded: false, available: false, disabled_reason: 'needs GPU acceleration'}];
  let downloads = 0;
  h.root.service.download = () => { downloads++; return true; };
  h.root.setCursor('rows', 0);
  h.root.downloadCursorModel();
  h.root.activateCursor();
  h.root.startDownload(h.root.modelRows[0]);
  assert.equal(downloads, 0);
  assert.equal(h.requests.length, 0);
  assert.match(h.root.notice, /needs GPU acceleration/);
  // An incomplete Qwen3 row (engine build missing) downloads on Enter.
  h.root.modelRows = [{name: '0.6b-q4_k', downloaded: true, available: true, incomplete: true}];
  h.root.activateCursor();
  assert.equal(downloads, 1);
  assert.match(panel, /visible: Model\.modelNeedsDownload\(modelRow\.modelData\) && !Model\.modelUnavailable\(modelRow\.modelData\); iconText: "󰇚"/);
});

test('a save whose Qwen3-ASR server update failed says so instead of a silent Saved', () => {
  const h = panelHarness();
  h.complete('vocab.add', {ok: true, snapshot: {vocabulary: [], replacements: [], settings: {}}, restart_needed: [], daemon_stale: true,
    asr_problems: ['could not enable voxtype-asr.service: boom']}, {op: 'vocab.add', phrase: 'x'});
  assert.match(h.root.errorText, /could not enable voxtype-asr\.service: boom/);
});

test('GPU reconciliation problems use the existing save warning instead of silent Saved', () => {
  const h = panelHarness();
  h.complete('gpu.set_device', {ok: true, snapshot: {settings: {engine: 'qwen3-asr'}},
    restart_needed: ['gpu.device'], daemon_stale: true,
    asr_problems: ['could not enable voxtype-asr.service: fixture enable denied']},
    {op: 'gpu.set_device', vendor: 'nvidia'});
  assert.match(h.root.errorText, /could not enable voxtype-asr\.service: fixture enable denied/);
  assert.deepEqual(JSON.parse(JSON.stringify(h.root.restartNeeded)), ['gpu.device']);
  assert.ok(h.requests.some(r => r.op === 'gpu.status'));
});

test('loadModels derives the engine itself: inside onEngineChanged the modelsView binding may still be stale', () => {
  // Found live: reopening the panel after the engine changed elsewhere listed
  // the previous engine's catalog and stayed on "Reading the model catalog…".
  const body = panel.slice(panel.indexOf('    function loadModels()'), panel.indexOf('    function pickModelsEngine('));
  assert.doesNotMatch(body.replace(/\/\/.*$/gm, ''), /modelsView/);
  const h = panelHarness();
  h.root.section = 'settings'; h.root.view = 'models';
  h.root.snapshot = {settings: {engine: 'qwen3-asr'}};
  // Simulate the stale binding: modelsView still reports the old engine.
  Object.defineProperty(h.root, 'modelsView', {get: () => 'qwen3-asr', configurable: true});
  h.root.snapshot = {settings: {engine: 'whisper'}};
  h.root.loadModels();
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests.pop())), {op: 'models.list', engine: 'whisper'});
});

test('Esc steps out one level (Fix, drill-in, panel); an outside click closes outright', () => {
  const h = panelHarness();
  let hidden = 0;
  h.root.controller = {hide() { hidden++; }};
  h.root.section = 'settings';
  h.root.view = 'models';
  h.root.goBack();
  assert.equal(h.root.view, '', 'Esc in Manage models returns to Settings');
  assert.equal(h.root.section, 'settings', 'the tab stays');
  assert.equal(hidden, 0);
  h.root.goBack();
  assert.equal(hidden, 1, 'Esc on a top page closes the panel');
  // The shell's dismiss area calls close(): that never just pops a level.
  h.root.view = 'advanced';
  h.root.close();
  assert.equal(hidden, 2);
  // Fix a word is cancelled before anything else.
  h.root.view = '';
  h.root.section = 'history';
  h.root.fixStage = 'pick'; h.root.fixId = 'r1';
  h.root.expandedId = 'r1';
  h.root.goBack();
  assert.equal(h.root.fixStage, '');
  assert.equal(h.root.expandedId, 'r1', 'Fix first');
  h.root.goBack();
  assert.equal(h.root.expandedId, '', 'then the open dictation');
  assert.equal(hidden, 2);
  h.root.goBack();
  assert.equal(hidden, 3, 'then the panel');
  assert.match(panel, /onCloseRequested: root\.goBack\(\)/);
});

test('Home usage card: Enter connects Voxtype while its hooks are pending, else opens Usage', () => {
  const h = panelHarness();
  h.root.status = Object.assign({}, h.root.status, {capabilities: {history: true, features: true}});
  h.root.features = {features: {usage: {enabled: true}}, available: {}, reasons: {}};
  h.root.usage = {enabled: true, days: [], totals: {}, health: {pending_wiring: ['capture', 'duration'], unavailable: []}};
  assert.equal(h.root.wiringPending, true);
  h.root.setCursor('usage', -1);
  h.root.activateCursor();
  const req = h.requests.filter(r => r.op === 'features.set').pop();
  assert.deepEqual(JSON.parse(JSON.stringify(req && req.patch)), {usage: {enabled: true}}, "re-saves the current switch, nothing else");
  assert.equal(h.root.page, 'home', 'stays on Home');
  // The reply marks the daemon stale: the hero asks for a restart.
  h.complete('features.set', {ok: true, features: {usage: {enabled: true}}, available: {}, reasons: {}, restart_needed: ['output.pre_recording_command'], daemon_stale: true}, req);
  assert.ok(h.root.restartNeeded.includes('output.pre_recording_command'));
  h.root.usage = {enabled: true, days: [], totals: {}, health: {pending_wiring: [], unavailable: []}};
  assert.equal(h.root.wiringPending, false);
  h.root.setCursor('usage', -1);
  h.root.activateCursor();
  assert.equal(h.root.page, 'usage');
  // A user who turned usage off keeps it off.
  const h2 = panelHarness();
  h2.root.status = Object.assign({}, h2.root.status, {capabilities: {history: true, features: true}});
  h2.root.features = {features: {usage: {enabled: false}, history: {enabled: true}}, available: {}, reasons: {}};
  h2.root.usage = {enabled: true, days: [], totals: {}, health: {pending_wiring: ['capture']}};
  h2.root.connectVoxtype();
  assert.deepEqual(JSON.parse(JSON.stringify(h2.requests.filter(r => r.op === "features.set").pop().patch)), {usage: {enabled: false}});
});

const record = (id, text, extra) => Object.assign({id, ts: '2026-11-06T20:35:53Z', raw: text, final: text}, extra || {});

test('Fix a word submits the stored text with only the picked span replaced, also past word 200', () => {
  const words = Array.from({length: 250}, (_, i) => 'w' + i);
  words[230] = 'omashi.';
  // Original spacing (double spaces, a line break) must survive untouched.
  const text = words.slice(0, 120).join(' ') + '\n\n' + words.slice(120).join('  ');
  const h = panelHarness();
  h.root.status = Object.assign({}, h.root.status, {capabilities: {history: true, learned: true}});
  h.root.section = 'history';
  h.root.historyList = [record('r1', text)];
  h.root.fixField = field();
  h.root.startFixFor({id: 'r1'});
  assert.equal(h.root.fixStage, 'pick');
  assert.equal(h.root.fixTokens.length, 250, 'every word is a token');
  for (let i = 0; i < 230; i++) h.root.moveCursor(1);
  assert.equal(h.root.fixStart, 230, 'word 231 is reachable with the arrows');
  const win = h.root.fixWindow;
  assert.ok(win.tokens.length <= h.root.Model.FIX_SHOWN_MAX && win.from <= 230 && win.to > 230, 'the shown window holds the pick');
  h.root.activateCursor();
  assert.equal(h.root.fixStage, 'type');
  assert.equal(h.root.fixField.text, 'omashi');
  h.root.fixField.text = 'Omarchy';
  h.root.submitFix();
  const req = h.requests.filter(r => r.op === 'learn.submit').pop();
  assert.equal(req.edited, text.replace('omashi.', 'Omarchy.'), 'one span changed, nothing else');
});

test('Fix a word refuses a shortened or over-long dictation instead of submitting a rewrite', () => {
  const h = panelHarness();
  h.root.status = Object.assign({}, h.root.status, {capabilities: {history: true, learned: true}});
  h.root.section = 'history';
  h.root.historyList = [record('r1', 'cut text', {truncated: true}), record('r2', 'x '.repeat(3000))];
  h.root.startFixFor({id: 'r1'});
  assert.equal(h.root.fixStage, '');
  assert.match(h.root.notice, /too long to fix/);
  h.root.startFixFor({id: 'r2'});
  assert.equal(h.root.fixStage, '');
  assert.match(panel, /enabled: !!root\.caps\.learned && root\.learningOn && detail\.record\.truncated !== true/);
  assert.match(panel, /onClicked: root\.startFixFor\(detail\.item\)/, 'the Fix button goes through the same checks');
});

test('collapsing or losing the dictation being fixed ends Fix, so keys are not swallowed', () => {
  const h = panelHarness();
  h.root.status = Object.assign({}, h.root.status, {capabilities: {history: true, learned: true}});
  h.root.section = 'history';
  h.root.historyList = [record('r1', 'open the omashi menu'), record('r2', 'second one')];
  h.root.setCursor('rows', 0);
  h.root.startFix();
  assert.equal(h.root.fixStage, 'pick');
  // Click the same dictation's header: it collapses and Fix ends.
  h.root.toggleExpand(h.root.historyItems[0]);
  assert.equal(h.root.expandedId, '');
  assert.equal(h.root.fixStage, '');
  assert.equal(h.root.fixId, '');
  h.root.handleTextKey('4');
  assert.equal(h.root.section, 'settings', 'section keys work again');
  // The dictation disappears (deleted, filtered out): Fix ends too.
  h.root.section = 'history';
  h.root.setCursor('rows', 1);
  h.root.startFix();
  assert.equal(h.root.fixId, 'r2');
  h.root.historyList = [record('r1', 'open the omashi menu')];
  h.root.dropStaleFix();
  assert.equal(h.root.fixStage, '');
  assert.match(panel, /onHistoryItemsChanged: \{ clampCursor\(\); dropStaleFix\(\) \}/);
  assert.match(panel, /onExpandedIdChanged: dropStaleFix\(\)/);
});

test('Load older: one request per cursor, late or repeated pages never duplicate records', () => {
  const h = panelHarness();
  h.root.status = Object.assign({}, h.root.status, {capabilities: {history: true}});
  h.root.section = 'history';
  h.root.historyList = [record('r3', 'c'), record('r2', 'b')];
  h.root.historyNext = 'r2';
  h.root.loadMoreHistory();
  h.root.loadMoreHistory();
  const more = h.requests.filter(r => r.op === 'history.list' && r.before);
  assert.equal(more.length, 1, 'a second click while the first is in flight sends nothing');
  const page = {ok: true, enabled: true, keep_days: 30, items: [record('r2', 'b'), record('r1', 'a')], next: null};
  h.complete('history.list', page, more[0]);
  assert.deepEqual([...h.root.historyList.map(r => r.id)], ['r3', 'r2', 'r1'], 'deduplicated by id');
  assert.equal(h.root.historyMoreCursor, '');
  // A duplicate reply for the old cursor (e.g. queued before the fix) is ignored.
  h.complete('history.list', page, more[0]);
  assert.deepEqual([...h.root.historyList.map(r => r.id)], ['r3', 'r2', 'r1']);
  // A failed page frees the cursor, so the user can retry.
  h.root.historyNext = 'r1';
  h.root.loadMoreHistory();
  const retry = h.requests.filter(r => r.op === 'history.list' && r.before).pop();
  h.complete('history.list', {ok: false, error: 'boom'}, retry);
  assert.equal(h.root.historyMoreCursor, '');
  h.root.loadMoreHistory();
  assert.equal(h.requests.filter(r => r.op === 'history.list' && r.before === 'r1').length, 2);
});

test('features.set with a wiring_error warns instead of a plain Saved', () => {
  const h = panelHarness();
  h.root.status = Object.assign({}, h.root.status, {capabilities: {features: true}});
  const req = {op: 'features.set', patch: {learning: {enabled: true}}};
  h.complete('features.set', {ok: true, features: {}, available: {}, reasons: {}, restart_needed: [], daemon_stale: false,
    wiring_error: "could not update voxtype's config: \u202eboom\nline"}, req);
  assert.notEqual(h.root.notice, 'Saved');
  assert.equal(h.root.errorText, "Saved, but Voxtype's config couldn't be updated, so it isn't connected yet",
    'a multi-line technical cause is dropped, not cut');
  h.complete('features.set', {ok: true, features: {}, available: {}, reasons: {}, restart_needed: [], daemon_stale: false,
    wiring_error: "could not update voxtype's config: disk full"}, req);
  assert.equal(h.root.errorText, "Saved, but Voxtype's config couldn't be updated, so it isn't connected yet (disk full)");
  h.complete('features.set', {ok: true, features: {}, available: {}, reasons: {}, restart_needed: [], daemon_stale: false}, req);
  assert.equal(h.root.notice, 'Saved');
  assert.equal(h.root.errorText, '');
});

test('Reset all stays reachable when only rejected or promoted entries remain', () => {
  const h = panelHarness();
  h.root.status = Object.assign({}, h.root.status, {capabilities: {learned: true}});
  h.root.section = 'words';
  h.root.learnedState = {ok: true, entries: [{id: 'l1', kind: 'spelling', written: 'Omarchy', heard: ['omashi'], state: 'rejected'}],
                         counts: {active: 0, suggested: 0, dormant: 0, rejected: 1, promoted: 0}};
  assert.equal(h.root.learnedWords.length, 0, 'the tombstone is not a visible row');
  assert.equal(h.root.learnedTotal, 1);
  assert.ok(h.root.targetsFor('words').includes('learn.reset'));
  h.root.resetLearned();
  assert.equal(h.root.confirmAction, 'learn.reset');
  assert.equal(h.root.confirmation.selectedIndex, 0, 'Cancel first');
  assert.match(h.root.confirmation.message, /1 learned words \(1 rejected or promoted\)/);
  assert.match(panel, /visible: root\.learnedGroupShown/);
  assert.match(panel, /visible: root\.learnedTotal > 0\n\s*text: "Reset all"/);
});

test('Words rows offer a hover delete for words and rules through the x confirmation', () => {
  const row = panel.slice(panel.indexOf('component WordRow'), panel.indexOf('component Tag'));
  assert.match(row, /PanelActionButton \{\n\s*visible: wordRow\.hasCursor && \(wordRow\.word\.kind === "vocab" \|\| wordRow\.word\.kind === "rule"\)/);
  assert.match(row, /hoverColor: root\.urgent/);
  assert.match(row, /onClicked: \{ root\.setCursor\("rows", wordRow\.rowIndex\); root\.deleteSelected\(\) \}/);
  const h = panelHarness();
  h.root.section = 'words';
  h.root.snapshot = {vocabulary: [{phrase: 'Codemux'}], replacements: [{from: 'code mucks', to: 'Codemux', category: 'Replacement'}], settings: {}};
  const asked = [];
  for (const i of [0, 1]) {
    h.root.setCursor('rows', i); h.root.deleteSelected();
    asked.push(h.root.confirmAction);
    assert.equal(h.root.confirmation.selectedIndex, 0, 'Cancel first');
    h.root.confirmation.opened = false;
  }
  assert.deepEqual(asked.sort(), ['dict.remove', 'vocab.remove']);
});

test('Shift+letter jumps on Words before r records; Shift+X stays the kit Delete and the hints say so', () => {
  const h = panelHarness();
  let records = 0;
  h.root.service.toggleRecord = () => { records++; return true; };
  h.root.section = 'words';
  h.root.snapshot = {vocabulary: [{phrase: 'Alpha'}, {phrase: 'Rust'}, {phrase: 'Zed'}], replacements: [], settings: {}};
  h.root.handleTextKey('R');
  assert.equal(records, 0, 'Shift+R does not record on Words');
  assert.equal(h.root.cursorIndex, 1, 'it jumps to R');
  h.root.handleTextKey('r');
  assert.equal(records, 1, 'r still records');
  h.root.section = 'home';
  h.root.handleTextKey('R');
  assert.equal(records, 2, 'Shift+R records outside Words');
  const kit = '/usr/share/omarchy/shell/Ui/PanelKeyCatcher.qml';
  if (fs.existsSync(kit)) assert.match(fs.readFileSync(kit, 'utf8'), /event\.text === "X"/, 'the kit still eats X as Delete');
  const hint = h.root.Model.hintPairs('words', {cursorActive: true}).find(p => p[0] === 'Shift+A–Z');
  assert.deepEqual(JSON.parse(JSON.stringify(hint)), ['Shift+A–Z', 'jump (not X)']);
  assert.match(read('README.md'), /Shift\+letter, not X/);
});

test('Settings labels: unknown values are sanitized at render, Voxtype hotkey mode is named as such', () => {
  const {Model} = panelHarness().root;
  assert.equal(Model.optionLabel(Model.LANGUAGES, 'xx\u202e\u2066evil\nline'), 'xxevil line');
  assert.equal(Model.optionLabel(Model.LANGUAGES, 'q'.repeat(200)).length, Model.OPTION_LABEL_MAX);
  assert.equal(Model.optionLabel(Model.LANGUAGES, 'de'), 'German');
  const simple = panel.slice(panel.indexOf('component SimpleRow'), panel.indexOf('component WordRow'));
  assert.match(simple, /text: Model\.sanitize\(simple\.value, 60\)/);
  assert.match(simple, /Keycap \{[^\n]*text: Model\.sanitize\(simple\.value, 60\)/);
  assert.match(panel, /SimpleRow \{ key: "mode"; label: "Hotkey mode"; hint: "Voxtype's own hotkey"/);
  // An unknown value is listed (so the dropdown shows what is set), but only
  // under a sanitized label; picking a real option writes its raw value.
  const h = panelHarness();
  h.root.section = 'settings';
  h.root.snapshot = {settings: {'whisper.language': 'xx\u202e'}};
  const opts = h.root.choiceOptions('language');
  assert.equal(opts[0].value, 'xx\u202e');
  assert.equal(opts[0].label, 'xx');
  assert.equal(opts.length, h.root.Model.LANGUAGES.length + 1);
  h.root.chooseSimple('language', 'auto');
  assert.equal(h.requests.pop().value, 'auto');
});

test('Home says LAST 12 MONTHS and the Usage hour chart has a 00 / 12 / 23 axis', () => {
  assert.match(panel, /SectionHead \{ title: "LAST 12 MONTHS"/);
  assert.doesNotMatch(panel, /"THIS YEAR"/);
  const axis = panel.slice(panel.indexOf('id: hourAxis'), panel.indexOf('text: hourRow.bars.busiest'));
  for (const t of ['"00"', '"12"', '"23"']) assert.ok(axis.includes('text: ' + t), t);
});

// ---- Settings choice rows: a dropdown of every value ---------------------

function choiceHarness() {
  const h = panelHarness();
  h.opened = [];
  h.root.openChoice = key => h.opened.push(key);
  h.root.section = 'settings';
  return h;
}
const CHOICE_KEYS = ['model', 'language', 'mode', 'indicator', 'other_audio', 'output_mode', 'keep'];

test('every Settings row with a fixed list of values is a dropdown, none is stepped with ←→', () => {
  const settingsRows = panel.slice(panel.indexOf('// ================= 4 · Settings (simple rows)'), panel.indexOf('component SimpleRow'));
  for (const key of CHOICE_KEYS) assert.match(settingsRows, new RegExp(`SimpleRow \\{ key: "${key}"; [^\\n]*kind: "choice"`), key);
  assert.doesNotMatch(panel, /kind: "cycle"|cycleSimple|keepTimer|commitKeep/);
  const row = panel.slice(panel.indexOf('component SimpleRow'), panel.indexOf('component WordRow'));
  assert.match(row, /Dropdown \{\s*id: choiceDropdown/);
  assert.match(row, /onPopupOpenChanged: \{\s*root\.notePopup\(popupOpen\);/, 'an open list blocks the panel keys');
  assert.doesNotMatch(row, /"‹"/);
  const h = choiceHarness();
  h.root.setCursor('mode', -1);
  h.root.moveCursorH(1);
  assert.equal(h.requests.length, 0, '→ no longer changes a value');
  assert.equal(h.root.Model.hintPairs('settings', {cursorActive: true}).some(p => p[0] === '←→'), false);
});

test('Enter or a click on a choice row opens that row\'s dropdown; picking the shown value writes nothing', () => {
  const h = choiceHarness();
  h.root.modelRows = [{name: 'base', downloaded: true}, {name: 'large-v3-turbo', downloaded: true}];
  h.root.modelsEngine = 'whisper';
  for (const key of CHOICE_KEYS) {
    h.root.activateSimple(key);
    assert.equal(h.opened.pop(), key);
  }
  same(h.root.choiceOptions('model').map(o => o.value), ['base', 'large-v3-turbo']);
  h.root.chooseSimple('model', 'base');
  assert.equal(h.requests.length, 0);
  h.root.chooseSimple('model', 'large-v3-turbo');
  assert.equal(h.requests.pop().value, 'large-v3-turbo');
  h.root.chooseSimple('indicator', 'off');
  assert.ok(h.requests.length > 0, 'indicator writes through Model.indicatorWrites');
});

test('the model dropdown with no downloaded model points to Manage models instead of an empty list', () => {
  const h = choiceHarness();
  h.root.status = Object.assign({}, h.root.status, {model: {name: '', present: false}});
  h.root.modelRows = [];
  h.root.activateSimple('model');
  assert.deepEqual(h.opened, []);
  assert.match(h.root.notice, /Manage models/);
});

function keepHarness(keepDays, history) {
  const h = choiceHarness();
  h.root.status = Object.assign({}, h.root.status, {capabilities: {features: true, history: true}});
  h.root.features = {features: {history: {enabled: true, keep_days: keepDays}}, available: {history: true}, reasons: {}};
  h.root.setCursor('keep', -1);
  if (history) { h.root.historyList = history; h.root.historyLoaded = true; h.root.historyNext = null; }
  return h;
}
const same = (actual, expected, message) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);
const keepWrites = h => h.requests.filter(r => r.op === 'features.set');

test('Keep for: the dropdown lists every period, and a longer one saves without asking', () => {
  const h = keepHarness(30);
  same(h.root.choiceOptions('keep').map(o => o.label), ['1 week', '1 month', '3 months', '1 year', 'forever']);
  assert.equal(h.root.choiceValue('keep'), '30');
  h.root.chooseSimple('keep', 'forever');
  assert.equal(h.root.confirmation.opened, false);
  same(keepWrites(h).map(r => r.patch), [{history: {keep_days: null}}]);
});

test('Keep for: a shorter period asks first, Cancel selected, and says how many dictations it deletes', () => {
  const day = 86400000, now = Date.now();
  const h = keepHarness(30, [
    {id: 'new', ts: new Date(now - 2 * day).toISOString(), final: 'recent'},
    {id: 'old', ts: new Date(now - 20 * day).toISOString(), final: 'twenty days ago'},
  ]);
  h.root.chooseSimple('keep', '7');
  assert.equal(keepWrites(h).length, 0, 'nothing is saved before the user confirms');
  assert.equal(h.root.confirmation.opened, true);
  assert.equal(h.root.confirmation.selectedIndex, 0, 'Cancel is the default');
  assert.match(h.root.confirmation.message, /1 dictation older than 1 week will be deleted/);
  h.root.confirmation.opened = false;
  handler(panel.slice(panel.indexOf('id: confirmation')), 'onCanceled', vm.createContext(h.root)).call(h.root.confirmation);
  assert.equal(keepWrites(h).length, 0, 'Cancel writes nothing');
  assert.equal(h.root.choiceValue('keep'), '30', 'the row still shows the saved period');
  h.root.chooseSimple('keep', '7');
  h.root.applyConfirmed();
  same(keepWrites(h).map(r => r.patch), [{history: {keep_days: 7}}]);
});

test('Keep for: with history not fully loaded the confirmation says plainly that older dictations are deleted', () => {
  const h = keepHarness(null);
  h.root.historyLoaded = true; h.root.historyNext = 'more-id';
  h.root.chooseSimple('keep', '7');
  assert.equal(h.root.confirmation.opened, true);
  assert.match(h.root.confirmation.message, /Dictations older than 1 week will be deleted/);
  assert.equal(keepWrites(h).length, 0);
});

test('Keep for: a pick never replaces an open confirmation, and values outside the list are refused', () => {
  const h = keepHarness(30, []);
  h.root.ask('daemon.stop', {}, 'Turn off?', 'Turn off');
  h.root.chooseSimple('keep', '7');
  assert.equal(h.root.confirmAction, 'daemon.stop');
  assert.equal(h.root.confirmation.message, 'Turn off?');
  h.root.confirmation.opened = false; h.root.confirmAction = '';
  for (const bad of ['14', '0', '-1', 'null', '7; rm', '']) h.root.chooseSimple('keep', bad);
  assert.equal(keepWrites(h).length, 0);
  assert.equal(h.root.confirmation.opened, false);
});

test('Keep for: a hand-edited period is listed under its own label so the row shows what is set', () => {
  const h = keepHarness(14);
  const opts = h.root.choiceOptions('keep');
  same(opts[0], {value: '14', label: '14 days'});
  assert.equal(h.root.choiceValue('keep'), '14');
  h.root.chooseSimple('keep', '14');
  assert.equal(keepWrites(h).length, 0);
});

test('the mouse back button steps out one level like Esc, and only while no dialog or list is open', () => {
  const tap = panel.match(/TapHandler \{[^}]*\}/);
  assert.ok(tap, 'a TapHandler on the panel');
  assert.match(tap[0], /acceptedButtons: Qt\.BackButton/);
  assert.match(tap[0], /enabled: !root\.keysBlocked/);
  assert.match(tap[0], /onTapped: root\.goBack\(\)/);
});

test('hovering a row never scrolls the list; moving the cursor with keys still does', () => {
  const h = panelHarness();
  let scrolled = 0;
  h.root.ensureVisible = () => { scrolled++; };
  h.root.section = 'settings';
  h.root.hoverCursor('mode', -1);
  h.root.followCursor({});
  assert.equal(scrolled, 0, 'the pointer put the cursor there');
  h.root.moveCursor(1);
  h.root.followCursor({});
  assert.equal(scrolled, 1, 'a key moved it');
  // Every hover handler goes through hoverCursor, every row through followCursor.
  for (const line of panel.split('\n'))
    if (/onEntered|onHovered|hovered\)/.test(line)) assert.doesNotMatch(line, /root\.setCursor\(/, line.trim());
  assert.doesNotMatch(panel, /onHasCursorChanged: if \(hasCursor\) root\.ensureVisible\(/);
});

test('every panel dropdown is ChoiceDropdown: hover highlights without scrolling, a wheel notch moves three rows', () => {
  assert.doesNotMatch(panel, /^\s*Dropdown \{/m, 'no kit Dropdown, whose hover scrolls its list');
  const dd = read('ChoiceDropdown.qml');
  assert.match(dd, /onEntered: optionList\.active = parent\.index/);
  assert.doesNotMatch(dd, /currentIndex = /, 'the ListView currentIndex (which scrolls) is never driven');
  assert.match(dd, /positionViewAtIndex\(active, ListView\.Contain\)/, 'only key steps scroll');
  assert.match(dd, /WheelHandler \{[\s\S]*Model\.wheelContentY\([\s\S]*\* 3, event\.phase\)/);
  assert.match(panel, /Style\.spacing\.popupRowHeight \* 3, event\.phase\);/, 'the panel body passes the scroll phase too');
  assert.match(dd, /return Model\.sanitize\(value, Model\.OPTION_LABEL_MAX\)/, 'an unlisted value is shown sanitized');
});

test('Replace has two fields: what you say, then what is written; Enter in the first moves on', () => {
  const h = panelHarness();
  const written = field();
  h.root.writtenField = written;
  h.root.wordFilter = 'replace';
  h.root.wordsField.text = 'code mucks';
  h.root.addWord();
  assert.equal(written.focused, 1, 'focus moves to the second field');
  assert.equal(h.requests.length, 0);
  written.text = 'Codemux';
  h.root.addWord();
  same(h.requests.pop(), {op: 'dict.upsert', from: 'code mucks', to: 'Codemux', category: 'Replacement'});
  assert.equal(h.root.wordsField.text, '');
  assert.equal(written.text, '');
  // The arrow form still works from the first field.
  h.root.wordsField.text = 'slash release -> /release';
  h.root.addWord();
  same(h.requests.pop(), {op: 'dict.upsert', from: 'slash release', to: '/release', category: 'Replacement'});
  assert.match(panel, /placeholderText: root\.replaceMode \? "When you say…"/);
  assert.match(panel, /placeholderText: "Write instead…"/);
});

test('a confirmation opening under the pointer keeps Cancel selected; a later hover can select', () => {
  const h = panelHarness();
  h.root.ask('history.clear', {}, 'Delete all?', 'Delete all');
  const t0 = h.root.confirmOpenedAt;
  assert.equal(h.root.confirmation.selectedIndex, 0);
  assert.equal(h.root.hoverHijack(t0 + 104), true, 'the dialog appeared under the pointer (measured 104 ms): not a choice');
  assert.equal(h.root.hoverHijack(t0 + 2000), false, 'a later hover is a real choice');
  const c = panel.slice(panel.indexOf('target: confirmation'));
  assert.match(c, /function onSelectedIndexChanged\(\) \{[\s\S]*root\.hoverHijack\(Date\.now\(\)\)\)\s*confirmation\.selectedIndex = 0;/);
});

test('expanded History renders the whole sanitized transcript, Learn everywhere lists every planned file', () => {
  assert.match(panel, /text: Model\.historyDetailText\(detail\.record\)/);
  assert.doesNotMatch(panel, /Model\.recordText\(detail\.record\), 2000\)/);
  const card = panel.slice(panel.indexOf('component EverywhereCard'));
  assert.match(card, /model: Model\.everywhereFiles\(everywhere\.preview\)/);
  assert.doesNotMatch(card, /slice\(0, 8\)/);
});
