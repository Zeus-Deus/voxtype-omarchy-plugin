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
function field() { return {text: '', focused: 0, forceActiveFocus() { this.focused++; }}; }

function panelHarness(overrides) {
  const Model = {};
  vm.runInNewContext(read('Model.js'), Model);
  const deferred = [], requests = [], picks = [], copies = [];
  const root = Object.assign({
    Model,
    status: {voxtype_installed: true, config_exists: true, daemon: {active: true, state: 'idle', stale: false}, engine: 'whisper', model: {name: 'base', present: true}},
    snapshot: {vocabulary: [], replacements: [], settings: {}}, options: null, modelRows: [], modelsEngine: '', gpu: null,
    restartNeeded: [], errorText: '', notice: '', tuiMissing: false, loaded: true, previewOutput: '',
    exportPreview: null, importPreview: null, importPath: '', attaching: false, popoutSwitchClosing: false,
    section: 'dictate', cursorKey: '', cursorIndex: -1, cursorActive: false, focusedEditor: null, openPopups: 0,
    confirmAction: '', confirmPayload: null, dictCategory: 'Replacement', exportOpen: false, exportScope: 'sync',
    exportSecrets: false, importLocal: false, hostWidget: {id: 'widget'}, bar: {activePopout: null},
    anchorItem: null,
    controller: {open: true, show() { this.open = true; }, hide() { this.open = false; }},
    keyCatcher: field(), testField: field(), vocabSearch: field(), dictSearch: field(), dictFrom: field(), dictTo: field(), exportPath: field(),
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
    },
  }, overrides || {});
  root.root = root;
  const context = vm.createContext(root);
  const bind = (name, expr) => Object.defineProperty(root, name, {get: () => vm.runInContext(expr, context), configurable: true});
  const binding = name => {
    const m = panel.match(new RegExp('readonly property \\w+ ' + name + ': (.+)'));
    assert.ok(m, 'binding exists: ' + name);
    return m[1];
  };
  for (const name of ['vocabulary', 'replacements', 'config', 'categories', 'filteredVocabulary', 'filteredReplacements', 'daemonState',
                      'engine', 'modelPath', 'stale', 'locked', 'lockedCommand', 'modelMissing', 'primary', 'editing', 'terminalAvailable', 'pickerAvailable']) {
    if (panel.match(new RegExp('readonly property \\w+ ' + name + ':'))) bind(name, binding(name));
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
    setInside(code) { vm.runInContext(code, context); },
    flush() { while (deferred.length) deferred.shift()(); },
  };
}

module.exports = {panelHarness};

test('a late chooser result cannot reclaim the screen once another widget owns the popout', () => {
  const h = panelHarness();
  h.root.section = 'models';
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
  h.root.section = 'vocabulary';
  h.root.setCursor('rows', 0);
  h.root.deleteSelected();
  assert.equal(h.root.confirmation.opened, true);
  assert.doesNotMatch(h.root.confirmation.message, /[\u202e\u0007]/);
  assert.match(h.root.confirmation.message, /evilphrase!/);
  assert.equal(h.root.confirmPayload.phrase, evil, 'the bridge still gets the exact phrase to remove');
  h.root.confirmation.opened = false;
  h.root.section = 'dictionary';
  h.root.setCursor('rows', 0);
  h.root.deleteSelected();
  assert.doesNotMatch(h.root.confirmation.message, /[\u202e\u0007]/);
  h.root.confirmation.opened = false;
  h.root.section = 'models';
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
  assert.match(panel, /text: Model\.sanitize\(vocabRow\.modelData\.phrase, 120\)/);
  assert.match(panel, /text: Model\.sanitize\(ruleRow\.modelData\.from, 120\)/);
  assert.match(panel, /text: Model\.sanitize\(ruleRow\.modelData\.to, 120\)/);
  assert.match(panel, /text: Model\.sanitize\(modelRow\.modelData\.name, 120\)/);
  assert.doesNotMatch(panel, /text: (vocabRow\.modelData\.phrase|ruleRow\.modelData\.(from|to)|modelRow\.modelData\.name)[;\s]/);
});

test('redacted import rows never reach a value formatter, in the card or the confirmation', () => {
  const h = panelHarness();
  h.root.importPath = '/tmp/b.json';
  h.root.importPreview = {format: 'v2', warnings: [], diff: {settings_change: [
    {path: 'whisper.remote_api_key', dangerous: true, redacted: true, old_set: true, new_set: true},
    {path: 'output.post_process.command', dangerous: true, old: 'a', new: 'rm -rf'},
  ]}};
  h.root.askImport();
  assert.match(h.root.confirmation.message, /whisper\.remote_api_key will be replaced/);
  assert.match(h.root.confirmation.message, /output\.post_process\.command: a → rm -rf/);
  assert.doesNotMatch(h.root.confirmation.message, /undefined/);
  assert.equal(h.root.confirmation.confirmText, 'Import anyway');
  assert.match(panel, /text: "󰀦 " \+ Model\.dangerLine\(modelData, 40, 60\)/);
  assert.doesNotMatch(panel, /modelData\.(old|new)\b/);
});
