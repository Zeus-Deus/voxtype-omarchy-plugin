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
  assert.equal(h.root.lockedCommand, 'omarchy install voxtype', 'not-installed wins over not-set-up');
});

test('an engine switch shows a neutral loading state until its catalog arrives', () => {
  const h = panelHarness();
  h.root.section = 'models';
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
  assert.match(panel, /title: root\.modelsLoading \? "Reading the model catalog…" : "No models known for " \+ root\.engine/);
});

test('u resets the cursor setting to its default only when the key is actually set', () => {
  const h = panelHarness();
  h.root.section = 'settings';
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
  h.root.section = 'models';
  h.root.setCursor('engine', -1);
  h.root.handleTextKey('u');
  assert.equal(h.requests.length, 2, 'u is a Settings-only verb');
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
  h.root.section = 'models';
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
  h.root.section = 'models';
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

test('footer hints mirror the live key bindings: every hinted key is bound and every section-scoped binding is hinted', () => {
  const h = panelHarness();
  const Model = h.root.Model;
  const textKeys = panel.match(/function handleTextKey\(t\) \{[\s\S]*?\n    \}/)[0];
  // Section-scoped letter bindings actually present in handleTextKey.
  const bound = {};
  for (const m of textKeys.matchAll(/t === "([a-z\/])" && section === "(\w+)"/g)) (bound[m[2]] = bound[m[2]] || new Set()).add(m[1]);
  assert.match(textKeys, /t === "\/"/, '/ is bound for every section');
  assert.match(textKeys, /t === "r" \|\| t === "R"/, 'r is global');
  // Catcher-level verbs available everywhere.
  const catcher = {Enter: /onActivateRequested: root\.activateCursor\(\)/, x: /onDeleteRequested: root\.deleteSelected\(\)/, Tab: /onTabRequested/, '↑↓': /onMoveRequested/, Esc: /onCloseRequested: root\.close\(\)/, 'Ctrl+R': /Qt\.Key_R\) \{ restartDaemon\(\)/, '1–5': /Model\.sectionForKey\(t\)/};
  for (const section of Model.SECTIONS) {
    for (const editing of [false, true]) for (const cursorActive of [false, true]) {
      const pairs = Model.hintPairs(section, {editing, cursorActive});
      const text = Model.sectionHints(section, {editing, cursorActive});
      assert.equal(text, pairs.map(p => p.join(' ')).join('   '));
      for (const [key] of pairs) {
        if (catcher[key]) { assert.match(panel, catcher[key], key + ' in ' + section); continue; }
        if (key === '/' || key === 'r') continue;
        assert.ok(bound[section] && bound[section].has(key), section + ' hints "' + key + '" but handleTextKey does not bind it');
      }
      if (!cursorActive && !editing) assert.equal(pairs[0][0], '↑↓', 'no cursor yet: show how to get one');
      if (cursorActive && !editing) assert.notEqual(pairs[0][0], '↑↓', 'cursor active: hints show the verbs instead');
      if (editing) assert.ok(pairs.some(p => p[0] === 'Esc'), 'editing: Esc leaves the field');
    }
    // and the reverse: every letter bound for this section appears in its idle hints
    const idle = new Set(Model.hintPairs(section, {editing: false, cursorActive: true}).map(p => p[0]));
    for (const key of bound[section] || []) assert.ok(idle.has(key), section + ' binds "' + key + '" without hinting it');
  }
  assert.match(panel, /Model\.sectionHints\(root\.section, \{editing: root\.editing, cursorActive: root\.cursorActive\}\)/);
  assert.doesNotMatch(panel, /pid " \+/, 'the idle footer no longer prints the PID');
  assert.match(panel, /"Daemon running" : "Daemon stopped"/);
});

test('the panel forgets options and gpu status when appropriate, and asks the bridge for an 18 s restart wait', () => {
  const h = panelHarness();
  h.root.options = {engines: ['whisper']};
  h.root.gpu = {ok: true};
  h.root.restartDaemon();
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests.pop())), {op: 'daemon.restart', timeout: 18});
  h.root.launchGpu(true);
  assert.equal(h.root.gpu, null, 'gpu status is stale once the terminal runs setup');
  assert.match(panel, /onOpenedChanged: \{[\s\S]*?options = null;/, 'options invalidated on close');
  assert.match(panel, /if \(op === "status"\) \{ root\.status = result; service\.status = result; \}/);
});

test('every Settings cursor target is reachable and visible: Clear key is skipped until a key is set, GPU controls scroll into view', () => {
  const h = panelHarness();
  h.root.section = 'settings';
  assert.ok(h.root.targetsFor('settings').indexOf('remote.clear') < 0, 'no key stored: the invisible Clear button is not a cursor stop');
  h.root.snapshot = {settings: {'whisper.remote_api_key_set': true}};
  assert.ok(h.root.targetsFor('settings').indexOf('remote.clear') >= 0);
  for (const key of ['gpu.device', 'gpu.enable', 'gpu.disable']) assert.ok(h.root.targetsFor('settings').indexOf(key) >= 0, key);
  assert.match(panel, /setCursor\("gpu\.device", -1\) \}\n\s*onHasCursorChanged: if \(hasCursor\) root\.ensureVisible\(gpuDevice\)/);
  assert.equal((panel.match(/root\.ensureVisible\(gpuButtons\)/g) || []).length, 2);
  assert.match(panel, /root\.ensureVisible\(clearKey\)/);
  assert.match(panel, /onClicked: root\.toggleModifier\(modelData\)/);
  assert.match(panel, /onHasCursorChanged: if \(hasCursor\) root\.ensureVisible\(this\)\n\s*onClicked: root\.toggleModifier/);
  // Models: every non-row cursor target scrolls into view too, so Enter never lands on an off-screen Import button.
  assert.equal((panel.match(/root\.ensureVisible\(backupRow\)/g) || []).length, 2);
  assert.match(panel, /root\.ensureVisible\(engineDropdown\)/);
  const cursorTargets = new Set([...panel.matchAll(/setCursor\("([\w.]+)", -1\)/g)].map(m => m[1]));
  for (const key of ['export', 'import', 'engine', 'gpu.device', 'gpu.enable', 'gpu.disable', 'remote.clear', 'record', 'restart', 'download', 'test', 'search']) assert.ok(cursorTargets.has(key), key);
});
