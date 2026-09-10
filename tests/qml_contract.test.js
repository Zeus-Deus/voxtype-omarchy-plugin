const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const service = read('Service.qml');
const panel = read('Panel.qml');
const widget = read('BarWidget.qml');
const stripComments = s => s.replace(/^\s*\/\/.*$/gm, '');
const same = (actual, expected, message) =>
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);

// Exercise the actual QML JavaScript, not a second implementation. The VM
// supplies only Qt's deferred queue, Process events and timer boundaries.
// Compile successive closing-brace prefixes to handle nested JS, strings and
// regex literals without pretending to parse QML with a brace-counting regex.
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
function timer() {
  return {running: false, interval: 0, restart() { this.running = true; }, stop() { this.running = false; }};
}
function process() { return {running: false, signals: [], signal(code) { this.signals.push(code); }}; }

function serviceHarness() {
  const deferred = [], completions = [], downloads = [], records = [], picks = [], copies = [];
  const Model = {};
  vm.runInNewContext(read('Model.js'), Model);
  const root = {
    Model, busy: false, request: {}, timedOut: false, workerGeneration: 0, queue: [],
    downloading: false, downloadEngine: '', downloadName: '', downloadProgress: 0, downloadLog: [], downloadFinished: false, downloadGeneration: 0,
    recording: false, recordGeneration: 0, picking: false, pickerGeneration: 0, pickerStarted: false, pickCancelRequested: false, daemonState: 'unknown',
    worker: process(), downloader: process(), recorder: process(), picker: process(), clipboard: process(),
    copying: false, copyText: '', copyGeneration: 0, clipboardDeadline: timer(), copyFinished: ok => copies.push(ok),
    output: {text: ''}, pickerOutput: {text: ''}, status: null, stateFilePath: '/run/user/1000/voxtype/state',
    deadline: timer(), recordDeadline: timer(), pickerDeadline: timer(),
    stateFile: {reloads: 0, reload() { this.reloads++; }},
    Quickshell: {detached: [], execDetached(argv) { this.detached.push(argv); }},
    Qt: {callLater: cb => deferred.push(cb)},
    completed: (op, result, req) => completions.push({op, result, req}),
    downloadDone: (engine, name, ok, reason) => downloads.push({engine, name, ok, reason}),
    recordFinished: ok => records.push(ok),
    picked: p => picks.push(p), pickCanceled: () => picks.push(null), pickFailed: () => picks.push('failed'),
  };
  root.root = root;
  const context = vm.createContext(root);
  installFunctions(service, context);
  const fire = (id, event, ...args) => {
    const object = root[id];
    const scope = vm.createContext({root, ...root, running: object.running,
      write: text => { object.written = text; }, stdinEnabled: true});
    handler(objectSource(service, id), event, scope)(...args);
  };
  return {root, completions, downloads, records, picks, copies, fire, flush() { while (deferred.length) deferred.shift()(); }};
}

test('a bridge call writes the request on stdin and completes once from a normal exit', () => {
  const h = serviceHarness();
  assert.equal(h.root.run({op: 'load'}), true);
  assert.equal(h.root.busy, true);
  assert.equal(h.root.deadline.interval, 15000);
  h.root.worker.running = true;
  h.fire('worker', 'onStarted');
  assert.equal(h.root.worker.written, '{"op":"load"}');
  h.root.output.text = '{"ok":true,"snapshot":{"vocabulary":[]}}';
  h.root.worker.running = false;
  h.fire('worker', 'onRunningChanged');
  h.fire('worker', 'onExited', 0);
  h.flush();
  assert.equal(h.completions.length, 1);
  same(h.completions[0].result, {ok: true, snapshot: {vocabulary: []}});
  assert.equal(h.root.busy, false);
  assert.equal(h.root.deadline.running, false);
});

test('mutating excludes the status poll so row actions do not flicker every 2 s', () => {
  const h = serviceHarness();
  const mutating = () => vm.runInContext(service.match(/readonly property bool mutating: (.+)/)[1], h.root);
  const restarting = () => vm.runInContext(service.match(/readonly property bool restarting: (.+)/)[1], h.root);
  vm.createContext(h.root);
  assert.equal(mutating(), false);
  h.root.run({op: 'status'});
  assert.equal(mutating(), false, 'status poll is not a mutation');
  h.fire('worker', 'onExited', 0);
  h.root.run({op: 'vocab.add', phrase: 'x'});
  assert.equal(mutating(), true);
  assert.equal(restarting(), false);
  h.fire('worker', 'onExited', 0);
  h.root.run({op: 'daemon.restart'});
  assert.equal(restarting(), true);
  // Every row action / form button in the panel gates on mutating, never on raw busy.
  const gates = stripComments(panel).match(/enabled: [^\n]*service\.(busy|mutating|restarting)[^\n]*/g) || [];
  assert.ok(gates.length >= 8, 'found ' + gates.length + ' gates');
  for (const g of gates) assert.doesNotMatch(g, /service\.busy/, g);
});

test('daemon.restart gets the long deadline', () => {
  const h = serviceHarness();
  h.root.run({op: 'daemon.restart'});
  assert.equal(h.root.deadline.interval, 30000);
});

test('FailedToStart (runningChanged without exited) still completes, after a normal exit would have won', () => {
  const h = serviceHarness();
  h.root.run({op: 'status'});
  h.root.output.text = '{"ok":true,"stale":"from an earlier run"}';
  h.root.worker.running = false;
  h.fire('worker', 'onRunningChanged');
  assert.equal(h.completions.length, 0, 'deferred until the exit signal had its chance');
  h.flush();
  assert.equal(h.completions.length, 1);
  assert.equal(h.completions[0].result.ok, false, 'exit -1 never trusts stale collector text');
});

test('a newer generation discards the deferred fallback of the old process', () => {
  const h = serviceHarness();
  h.root.run({op: 'status'});
  h.root.worker.running = false;
  h.fire('worker', 'onRunningChanged');
  h.fire('worker', 'onExited', 0);
  h.root.output.text = '{"ok":true}';
  // completion 1 delivered synchronously by onExited; queue drained later
  h.root.run({op: 'load'});
  h.flush();
  assert.equal(h.completions.length, 1);
  assert.equal(h.root.busy, true, 'second request still in flight');
});

test('requests queue instead of being dropped, duplicate status polls collapse', () => {
  const h = serviceHarness();
  h.root.run({op: 'settings.set', path: 'x', value: 1});
  assert.equal(h.root.run({op: 'status'}), true, 'first status queues');
  assert.equal(h.root.run({op: 'status'}), false, 'second status collapses');
  h.root.run({op: 'load'});
  assert.equal(h.root.queue.filter(q => q.op === 'status').length, 1);
  assert.equal(h.root.queue.length, 2);
  h.root.cancelQueued('status');
  assert.equal(h.root.queue.length, 1);
  h.root.output.text = '{"ok":true,"snapshot":{}}';
  h.fire('worker', 'onExited', 0);
  h.flush();
  assert.equal(h.completions[0].op, 'settings.set');
  assert.equal(h.root.request.op, 'load', 'queued request started after completion');
});

test('the deadline kills a running bridge and reports a timeout', () => {
  const h = serviceHarness();
  h.root.run({op: 'options'});
  h.root.worker.running = true;
  h.fire('deadline', 'onTriggered');
  same(h.root.worker.signals, [9]);
  h.root.worker.running = false;
  h.fire('worker', 'onExited', 137);
  assert.match(h.completions[0].result.error, /timed out/);
});

test('exit 3 maps to the voxtype-tui-missing lock state', () => {
  const h = serviceHarness();
  h.root.run({op: 'status'});
  h.root.output.text = '{"ok":false,"error":"voxtype-tui-missing"}';
  h.fire('worker', 'onExited', 3);
  assert.equal(h.root.Model.isTuiMissing(h.completions[0].result), true);
});

test('download streams PROGRESS/LOG/DONE and only reports ok after DONE + exit 0', () => {
  const h = serviceHarness();
  assert.equal(h.root.download('whisper', 'base'), true);
  assert.equal(h.root.download('whisper', 'base'), false, 'one download at a time');
  h.root.handleDownloadLine('PROGRESS 10');
  h.root.handleDownloadLine('LOG fetching');
  assert.equal(h.root.downloadProgress, 10);
  same(h.root.downloadLog, ['fetching']);
  h.fire('downloader', 'onExited', 0);
  assert.equal(h.downloads[0].ok, false, 'exit 0 without DONE is not success');
  h.root.download('whisper', 'base');
  h.root.handleDownloadLine('PROGRESS 100');
  h.root.handleDownloadLine('DONE');
  h.fire('downloader', 'onExited', 0);
  assert.equal(h.downloads[1].ok, true);
  h.root.download('whisper', 'tiny');
  h.root.handleDownloadLine('FAILED disk full');
  h.fire('downloader', 'onExited', 1);
  assert.equal(h.downloads[2].ok, false);
  assert.equal(h.downloads[2].reason, 'disk full');
});

test('cancelling a download sends SIGTERM to the running process', () => {
  const h = serviceHarness();
  h.root.download('whisper', 'base');
  h.root.downloader.running = true;
  h.root.cancelDownload();
  same(h.root.downloader.signals, [15]);
});

test('record toggle reloads the state file and reports failure on non-zero exit', () => {
  const h = serviceHarness();
  assert.equal(h.root.toggleRecord(), true);
  assert.equal(h.root.toggleRecord(), false);
  h.fire('recorder', 'onExited', 1);
  same(h.records, [false]);
  assert.equal(h.root.stateFile.reloads, 1);
  h.root.toggleRecord();
  h.root.recorder.running = false;
  h.fire('recorder', 'onRunningChanged');
  h.flush();
  same(h.records, [false, false], 'FailedToStart also completes');
});

test('file picker only reports a path on a clean exit', () => {
  const h = serviceHarness();
  h.root.pick();
  h.root.pickerOutput.text = '/tmp/old.json\n';
  h.fire('picker', 'onExited', 1);
  same(h.picks, [null]);
  h.root.pick();
  h.root.pickerOutput.text = '/tmp/bundle.json\n';
  h.fire('picker', 'onExited', 0);
  same(h.picks, [null, '/tmp/bundle.json']);
});

test('a chooser that never starts reports pickFailed, a user cancel does not', () => {
  const h = serviceHarness();
  h.root.pick();
  h.root.picker.running = false;
  h.fire('picker', 'onRunningChanged');
  h.flush();
  same(h.picks, ['failed'], 'FailedToStart without onStarted');
  h.root.pick();
  h.root.picker.running = true;
  h.fire('picker', 'onStarted');
  assert.equal(h.root.pickerStarted, true);
  h.root.picker.running = false;
  h.fire('picker', 'onRunningChanged');
  h.fire('picker', 'onExited', 1);
  h.flush();
  same(h.picks, ['failed', null], 'exit 1 is the user backing out');
  h.root.pick();
  h.fire('picker', 'onStarted');
  h.fire('pickerDeadline', 'onTriggered');
  same(h.root.picker.signals, [15], 'a started chooser is terminated by the deadline');
  h.root.picker.running = false;
  h.fire('picker', 'onExited', 143);
  same(h.picks, ['failed', null, null], 'deadline on a started chooser is a cancel');
});

test('cancelPick terminates a running chooser, or completes a stopped one as cancelled', () => {
  const h = serviceHarness();
  h.root.pick();
  h.root.picker.running = true;
  h.root.cancelPick();
  same(h.root.picker.signals, [15]);
  assert.equal(h.root.picking, true, 'completion arrives with the exit');
  h.root.picker.running = false;
  h.fire('picker', 'onExited', 143);
  same(h.picks, [null]);
  h.root.pick();
  h.root.picker.running = false; // not started yet: nothing to signal
  h.root.cancelPick();
  assert.equal(h.root.picking, false);
  same(h.picks, [null, null], 'a requested cancel is never reported as a missing chooser');
  h.root.cancelPick();
  same(h.picks, [null, null], 'idle cancel is a no-op');
});

test('copy writes the text to wl-copy on stdin and completes once, including FailedToStart', () => {
  const h = serviceHarness();
  assert.equal(h.root.copy('voxtype setup'), true);
  assert.equal(h.root.copy('again'), false, 'one copy at a time');
  h.root.clipboard.running = true;
  h.fire('clipboard', 'onStarted');
  assert.equal(h.root.clipboard.written, 'voxtype setup');
  h.root.clipboard.running = false;
  h.fire('clipboard', 'onRunningChanged');
  h.fire('clipboard', 'onExited', 0);
  h.flush();
  same(h.copies, [true]);
  assert.equal(h.root.copyText, '');
  h.root.copy('x');
  h.root.clipboard.running = false;
  h.fire('clipboard', 'onRunningChanged');
  h.flush();
  same(h.copies, [true, false], 'missing wl-copy reports failure');
});

test('GPU setup goes to the terminal helper with a fixed argv and never a password', () => {
  const h = serviceHarness();
  h.root.launchGpuSetup(true);
  h.root.launchGpuSetup(false);
  same(h.root.Quickshell.detached, [
    ['omarchy-launch-terminal', 'sudo', 'voxtype', 'setup', 'gpu', '--enable'],
    ['omarchy-launch-terminal', 'sudo', 'voxtype', 'setup', 'gpu', '--disable'],
  ]);
  assert.doesNotMatch(stripComments(panel + service), /password:\s*true|echoMode|TextInput\.Password/);
});

test('state file text maps to the daemon state', () => {
  const h = serviceHarness();
  h.root.applyStateText('recording\n');
  assert.equal(h.root.daemonState, 'recording');
  h.root.applyStateText('');
  assert.equal(h.root.daemonState, 'stopped');
});

// ---- static contracts ------------------------------------------------------

test('every spawned command is an argv array against a fixed binary; the bridge is resolved next to the QML', () => {
  const code = stripComments(service);
  assert.match(code, /readonly property string pythonBinary: "\/usr\/bin\/python3"/);
  assert.match(code, /Qt\.resolvedUrl\("bridge\.py"\)/);
  const spawns = code.match(/command: \[[^\]]*\]/g) || [];
  assert.equal(spawns.length, 5);
  for (const spawn of spawns) assert.match(spawn, /^command: \[(root\.pythonBinary|"voxtype"|"zenity"|"wl-copy")/);
  assert.match(code, /command: \["wl-copy", "--type", "text\/plain;charset=utf-8"\]/, 'clipboard text travels over stdin, never argv');
  assert.doesNotMatch(stripComments(panel + service + widget), /bash", "-c|sh", "-c|bash -c/);
  assert.doesNotMatch(code, /stdinEnabled: true[\s\S]*?output\.text = /, 'StdioCollector.text is read-only');
});

test('bridge responses are size-capped and parsed strictly via Model.parseResponse', () => {
  assert.match(service, /Model\.parseResponse\(output\.text, code, timedOut\)/);
  assert.match(read('Model.js'), /RESPONSE_CAP = 2 \* 1024 \* 1024/);
});

test('the state poll follows status.state_file_path, falls back to the runtime dir, and stops when disabled', () => {
  assert.match(service, /readonly property var stateFilePath: Model\.stateFilePath\(status, fallbackStateFilePath\)/);
  assert.match(service, /Model\.defaultStateFilePath\(Quickshell\.env\("XDG_RUNTIME_DIR"\), Quickshell\.env\("DBUS_SESSION_BUS_ADDRESS"\), Quickshell\.env\("UID"\)\)/);
  assert.match(service, /FileView \{[\s\S]*?path: root\.stateFilePath === null \? "" : root\.stateFilePath/);
  assert.match(service, /running: root\.pollState && root\.stateFilePath !== null/);
  assert.match(panel, /id: statusPoll[\s\S]*?running: root\.opened && !root\.locked/);
  assert.match(panel, /interval: root\.pollIntervalMs/);
  assert.match(panel, /setting\("pollIntervalSec", 2\)/);
});

test('ConfirmDialog defaults to Cancel on every open and blocks the key catcher', () => {
  assert.match(panel, /function ask\([\s\S]{0,400}confirmation\.selectedIndex = 0;[\s\S]{0,60}confirmation\.opened = true/);
  assert.match(panel, /blocked: root\.keysBlocked/);
  assert.match(panel, /readonly property bool keysBlocked: editing \|\| confirmation\.opened \|\| openPopups > 0/);
  assert.match(panel, /ConfirmDialog \{[\s\S]*?selectedIndex: 0/);
  // Destructive paths only reach the bridge through the confirmed handler.
  for (const op of ['vocab.remove', 'dict.remove', 'models.delete']) {
    assert.doesNotMatch(stripComments(panel), new RegExp('service\\.run\\(\\{op: "' + op.replace('.', '\\.') + '"'));
  }
  assert.match(panel, /accept_dangerous: true/);
  assert.equal((stripComments(panel).match(/accept_dangerous: true/g) || []).length, 1);
  assert.match(panel, /function applyConfirmed\(\)[\s\S]{0,200}action === "import\.apply"/);
});

test('no panel shortcut depends on a key PanelKeyCatcher swallows (h, l, j, k, x, Tab)', () => {
  const textKeys = panel.match(/function handleTextKey\(t\) \{[\s\S]*?\n    \}/)[0];
  for (const k of ['"h"', '"l"', '"j"', '"k"', '"x"']) assert.doesNotMatch(textKeys, new RegExp('t === ' + k));
  assert.doesNotMatch(panel, /function escape\(/);
  assert.match(panel, /onDeleteRequested: root\.deleteSelected\(\)/);
  assert.match(panel, /onTabRequested: function\(direction\) \{ root\.cycleSection\(direction\) \}/);
  assert.match(textKeys, /Model\.sectionForKey\(t\)/);
});

test('closeForPopoutSwitch is overridden and clears the attach flag so a late chooser cannot reclaim the screen', () => {
  assert.match(panel, /function closeForPopoutSwitch\(\) \{[\s\S]*?popoutSwitchClosing = true;[\s\S]*?attaching = false;[\s\S]*?service\.cancelPick\(\);[\s\S]*?controller\.hide\(\);[\s\S]*?Qt\.callLater\(function\(\) \{ root\.popoutSwitchClosing = false \}\)/);
  assert.match(panel, /function resumeAfterPick\(\) \{[\s\S]*?if \(popoutTakenElsewhere\(\)\) return;[\s\S]*?controller\.show\(\)/);
  assert.match(panel, /bar\.activePopout !== owner/);
  assert.match(panel, /function beginImport\(\)[\s\S]{0,300}attaching = true;[\s\S]{0,120}controller\.hide\(\);[\s\S]{0,80}service\.pick\(\)/);
  assert.match(panel, /function launchGpu\(enable\)[\s\S]{0,400}controller\.hide\(\);[\s\S]{0,160}service\.launchGpuSetup\(enable\)/);
  assert.match(widget, /function closeForPopoutSwitch\(\) \{ if \(panelLoader\.item\) panelLoader\.item\.closeForPopoutSwitch\(\) \}/);
});

test('model arrays are diffed before reassignment so open editors survive a poll', () => {
  assert.match(panel, /Model\.sameList\(snapshot\[key\], next\[key\], true\)\) continue/);
  assert.match(panel, /if \(!Model\.sameList\(root\.modelRows, result\.models \|\| \[\], true\)\) root\.modelRows/);
});

test('the remote API key is never rendered or requested; only its presence and a Clear action exist', () => {
  const code = stripComments(panel);
  const mentions = code.match(/.*whisper\.remote_api_key(?!_set).*/g) || [];
  assert.equal(mentions.length, 2, 'keyboard and mouse Clear paths');
  for (const line of mentions) assert.match(line, /unsetSetting\("whisper\.remote_api_key"\)/);
  assert.match(code, /unsetSetting\("whisper\.remote_api_key"\)/);
  assert.match(code, /whisper\.remote_api_key_set/);
  assert.doesNotMatch(code, /settingKey: "whisper\.remote_api_key"/);
  assert.doesNotMatch(code, /settings\.set", path: "whisper\.remote_api_key"/);
});

test('the panel is built from the shipped kit with no hard-coded colours, fonts or pixel sizes', () => {
  const code = stripComments(panel + widget + read('VoxtypeIcon.qml'));
  assert.doesNotMatch(code, /"#[0-9a-fA-F]{3,8}"/);
  assert.doesNotMatch(code, /font\.family: "/);
  assert.doesNotMatch(code, /font\.pixelSize: \d/);
  for (const kit of ['KeyboardPanel', 'PanelKeyCatcher', 'PanelHero', 'ButtonGroup', 'PanelSectionHeader', 'PanelSeparator', 'Toggle', 'Dropdown', 'TextField', 'NumberField', 'PanelSlider', 'Button', 'PanelActionButton', 'CursorSurface', 'ConfirmDialog', 'Flickable'])
    assert.match(panel, new RegExp('\\b' + kit + ' \\{'), kit);
  assert.match(panel, /bar \? bar\.foreground : Color\.foreground/);
});

test('every Text element in Panel.qml declares textFormat (PlainText: no rich-text injection from bridge strings)', () => {
  const re = /(?<![A-Za-z])Text \{/g;
  let count = 0;
  for (let m = re.exec(panel); m; m = re.exec(panel)) {
    let depth = 0, i = m.index + 5;
    for (; i < panel.length; i++) {
      if (panel[i] === '{') depth++;
      else if (panel[i] === '}' && --depth === 0) break;
    }
    const body = panel.slice(m.index, i + 1);
    const line = panel.slice(0, m.index).split('\n').length;
    assert.match(body, /textFormat: Text\.PlainText/, 'Text at line ' + line + ' declares textFormat');
    count++;
  }
  assert.ok(count >= 30, 'found ' + count + ' Text elements');
});

test('bar button: left toggles, right records (setting), middle restarts when stale', () => {
  assert.match(widget, /Qt\.LeftButton\) root\.toggle\(\)/);
  assert.match(widget, /Qt\.RightButton && root\.rightClickRecords\) panelLoader\.item\.toggleRecord\(\)/);
  assert.match(widget, /Qt\.MiddleButton\) panelLoader\.item\.restartIfStale\(\)/);
  assert.match(widget, /setting\("rightClickRecords", true\)/);
  assert.match(panel, /function restartIfStale\(\) \{ if \(stale\) restartDaemon\(\) \}/);
});

test('manifest matches the design', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.id, 'io.github.zeus-deus.voxtype');
  assert.equal(manifest.name, 'Voxtype');
  same(manifest.kinds, ['bar-widget']);
  assert.equal(manifest.entryPoints.barWidget, 'BarWidget.qml');
  assert.equal(manifest.barWidget.category, 'System');
  assert.equal(manifest.barWidget.defaultSection, 'right');
  const keys = manifest.barWidget.schema.map(s => s.key);
  assert.ok(keys.includes('pollIntervalSec') && keys.includes('rightClickRecords'));
  const poll = manifest.barWidget.schema.find(s => s.key === 'pollIntervalSec');
  assert.equal(poll.type, 'integer'); assert.equal(poll.min, 1); assert.equal(poll.max, 10); assert.equal(poll.defaultValue, 2);
  assert.equal(manifest.barWidget.defaults.pollIntervalSec, 2);
  assert.equal(manifest.barWidget.defaults.rightClickRecords, true);
  assert.match(panel, /moduleName: "io\.github\.zeus-deus\.voxtype"/);
  assert.match(widget, /moduleName: "io\.github\.zeus-deus\.voxtype"/);
});

test('no home paths or usernames leak into shipped code', () => {
  for (const f of ['Panel.qml', 'Service.qml', 'BarWidget.qml', 'VoxtypeIcon.qml', 'Model.js', 'manifest.json', 'README.md'])
    assert.doesNotMatch(read(f), /\/home\/[a-z]/, f);
});
