const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const Model = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'Model.js'), 'utf8'), Model);

const same = (a, b, m) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b, m);

test('parseResponse gates on exit code and never trusts ok from a failed run', () => {
  same(Model.parseResponse('{"ok":true,"x":1}', 0, false), {ok: true, x: 1});
  assert.equal(Model.parseResponse('{"ok":true}', 1, false).ok, false);
  assert.equal(Model.parseResponse('', 3, false).error, 'voxtype-tui-missing');
  assert.equal(Model.parseResponse('{"ok":false,"error":"voxtype-tui-missing"}', 3, false).error, 'voxtype-tui-missing');
  assert.equal(Model.parseResponse('garbage', 0, false).ok, false);
  assert.match(Model.parseResponse('{"ok":true}', 0, true).error, /timed out/);
  assert.equal(Model.parseResponse('{"ok":false}', 0, false).error, 'The operation failed.');
  assert.equal(Model.parseResponse('x'.repeat(3 * 1024 * 1024), 0, false).ok, false);
  assert.equal(Model.parseResponse('[1,2]', 0, false).ok, false);
});

test('hotkey labels read like the hero line', () => {
  assert.equal(Model.hotkeyLabel({key: 'SCROLLLOCK', modifiers: ['LEFTALT', 'LEFTSHIFT', 'LEFTMETA']}), 'Alt+Shift+Super+ScrollLock');
  assert.equal(Model.hotkeyLabel({key: 'KEY_X', modifiers: ['LEFTCTRL']}), 'Ctrl+X');
  assert.equal(Model.hotkeyLabel({key: 'F9', modifiers: []}), 'F9');
  assert.equal(Model.hotkeyLabel(null), 'no hotkey');
  assert.equal(Model.modifierLabel('LEFTMETA'), 'Super');
});

test('hero meta and primary action follow the design table', () => {
  const base = {voxtype_installed: true, daemon: {active: true, state: 'idle', stale: false}, model: {name: 'large-v3'}, hotkey: {key: 'X', modifiers: ['LEFTCTRL']}};
  assert.equal(Model.heroMeta(base, ''), 'Listening · large-v3 · Ctrl+X');
  assert.equal(Model.primaryAction(base), 'record');
  const stale = Object.assign({}, base, {daemon: {active: true, state: 'idle', stale: true}});
  assert.equal(Model.heroMeta(stale, ''), 'Restart to apply changes');
  assert.equal(Model.primaryAction(stale), 'restart');
  const stopped = Object.assign({}, base, {daemon: {active: false, state: 'stopped'}});
  assert.equal(Model.heroMeta(stopped, ''), 'Stopped');
  assert.equal(Model.primaryAction(stopped), 'start');
  const rec = Object.assign({}, base, {daemon: {active: true, state: 'recording', stale: true}});
  assert.equal(Model.heroMeta(rec, ''), 'Recording…');
  assert.equal(Model.heroMeta(Object.assign({}, base, {daemon: {active: true, state: 'transcribing'}}), ''), 'Transcribing…');
  assert.equal(Model.heroMeta({voxtype_installed: false}, ''), 'Voxtype is not installed');
  assert.equal(Model.primaryAction({voxtype_installed: false}), '');
  assert.equal(Model.heroMeta(null, 'voxtype-tui-missing'), 'voxtype-tui is not installed');
  assert.equal(Model.heroMeta(null, ''), 'Checking…');
  assert.equal(Model.primaryLabel('record', 'recording'), 'Stop');
  assert.equal(Model.primaryLabel('record', 'idle'), 'Record');
});

test('bar glyph and state file parsing', () => {
  assert.equal(Model.readStateFile('idle\n'), 'idle');
  assert.equal(Model.readStateFile('RECORDING'), 'recording');
  assert.equal(Model.readStateFile(''), 'stopped');
  assert.equal(Model.readStateFile('weird'), 'stopped');
  assert.equal(Model.barActive('recording'), true);
  assert.equal(Model.barActive('idle'), false);
  assert.notEqual(Model.barGlyph('stopped'), Model.barGlyph('idle'));
});

test('vocabulary and dictionary filters are case-insensitive and skip junk', () => {
  const vocab = [{phrase: 'Omarchy'}, {phrase: 'Hyprland'}, null, {nope: 1}];
  same(Model.filterVocabulary(vocab, 'hyp'), [{phrase: 'Hyprland'}]);
  assert.equal(Model.filterVocabulary(vocab, '').length, 2);
  const rules = [{from: 'slash release', to: '/release', category: 'Replacement'}, {from: 'arch', to: 'Arch Linux', category: 'Capitalization'}];
  assert.equal(Model.filterReplacements(rules, 'LINUX').length, 1);
  assert.equal(Model.filterReplacements(rules, '/rel')[0].from, 'slash release');
});

test('token meter thresholds: amber at 200, urgent at 224', () => {
  assert.equal(Model.tokenLevel(10), 'ok');
  assert.equal(Model.tokenLevel(199), 'ok');
  assert.equal(Model.tokenLevel(200), 'amber');
  assert.equal(Model.tokenLevel(224), 'urgent');
  assert.equal(Model.tokenMeter(12, 224), '12 / 224');
});

test('category cycling wraps', () => {
  assert.equal(Model.nextCategory('Replacement', ['Replacement', 'Capitalization']), 'Capitalization');
  assert.equal(Model.nextCategory('Capitalization', ['Replacement', 'Capitalization']), 'Replacement');
  assert.equal(Model.nextCategory('Unknown', null), 'Replacement');
});

test('sameList diffs by content so Repeaters are not reset needlessly', () => {
  assert.equal(Model.sameList([{a: 1}], [{a: 1}], true), true);
  assert.equal(Model.sameList([{a: 1}], [{a: 2}], true), false);
  assert.equal(Model.sameList([1, 2], [1, 2]), true);
  assert.equal(Model.sameList([1], [1, 2]), false);
  assert.equal(Model.sameList(null, []), true);
});

test('download stream lines parse per the bridge protocol', () => {
  same(Model.parseDownloadLine('PROGRESS 42\n'), {type: 'progress', value: 42});
  same(Model.parseDownloadLine('PROGRESS 150'), {type: 'progress', value: 100});
  same(Model.parseDownloadLine('LOG fetching'), {type: 'log', text: 'fetching'});
  same(Model.parseDownloadLine('DONE'), {type: 'done'});
  same(Model.parseDownloadLine('FAILED no space left'), {type: 'failed', reason: 'no space left'});
  same(Model.parseDownloadLine('FAILED'), {type: 'failed', reason: 'Download failed.'});
  same(Model.parseDownloadLine(''), {type: 'ignore'});
  same(Model.parseDownloadLine('stray output'), {type: 'log', text: 'stray output'});
});

test('model row formatting', () => {
  assert.equal(Model.formatSize(2900), '2.9 GB');
  assert.equal(Model.formatSize(142), '142 MB');
  assert.equal(Model.formatSize(null), '');
  assert.equal(Model.formatBytes(1500000000), '1.5 GB');
  assert.equal(Model.modelLine({name: 'x', size_mb: 75, downloaded: false}), '75 MB · not downloaded');
  assert.equal(Model.modelLine({name: 'x', size_mb: 75, on_disk_bytes: 80000000, downloaded: true, active: true}), '80 MB · active');
  assert.equal(Model.modelStatus({unknown: true}), 'on disk');
});

test('settings helpers', () => {
  const cfg = {'audio.device': 'default', 'hotkey.modifiers': ['LEFTCTRL']};
  assert.equal(Model.settingValue(cfg, 'audio.device', 'x'), 'default');
  assert.equal(Model.settingValue(cfg, 'missing', 'x'), 'x');
  assert.equal(Model.settingChanged(cfg, 'audio.device', 'default'), false);
  assert.equal(Model.settingChanged(cfg, 'audio.device', 'other'), true);
  assert.equal(Model.settingChanged(cfg, 'hotkey.modifiers', ['LEFTCTRL']), false);
  same(Model.toggleInList(['A', 'B'], 'A'), ['B']);
  same(Model.toggleInList(['A'], 'B'), ['A', 'B']);
  same(Model.modelOptions([{name: 'a', downloaded: true}, {name: 'b', downloaded: false}], 'c'),
       [{value: 'a', label: 'a'}, {value: 'b', label: 'b  (not downloaded)'}, {value: 'c', label: 'c'}]);
  same(Model.modelOptions([{name: 'a\u202eb', downloaded: true}], 'c\u0007'),
       [{value: 'a\u202eb', label: 'ab'}, {value: 'c\u0007', label: 'c'}], 'labels are sanitized, values stay exact');
  same(Model.plainOptions(['x']), [{value: 'x', label: 'x'}]);
  same(Model.labelled([{label: 'Yeti', name: 'alsa_input.yeti'}, {label: 'Auto', value: 'auto'}]),
       [{value: 'alsa_input.yeti', label: 'Yeti'}, {value: 'auto', label: 'Auto'}]);
});

test('section navigation and footer', () => {
  assert.equal(Model.nextSection('dictate', 1), 'vocabulary');
  assert.equal(Model.nextSection('dictate', -1), 'models');
  assert.equal(Model.nextSection('bogus', 1), 'vocabulary');
  assert.equal(Model.sectionForKey('3'), 'dictionary');
  assert.equal(Model.sectionForKey('9'), '');
  assert.equal(Model.sectionForKey('a'), '');
  for (const s of Model.SECTIONS) assert.ok(Model.sectionHints(s).length > 0);
  same(Model.footerNotice({error: 'boom', notice: 'x'}), {text: 'boom', urgent: true});
  same(Model.footerNotice({busyText: 'Restarting…', notice: 'x'}), {text: 'Restarting…', urgent: false});
  same(Model.footerNotice({restartNeeded: true}), {text: 'Saved · restart to apply', urgent: false});
  same(Model.footerNotice({idleText: 'idle'}), {text: 'idle', urgent: false});
});

test('import diff summary and dangerous rows', () => {
  const diff = {vocab_add: ['a'], replacements_add: [{}], settings_change: [{path: 'p', old: 1, new: 2, dangerous: true}, {path: 'q', dangerous: false}]};
  assert.equal(Model.diffSummary(diff), '+1 vocab · +1 rules · 2 settings');
  assert.equal(Model.dangerousChanges(diff).length, 1);
  assert.equal(Model.diffSummary({}), 'No changes');
  assert.equal(Model.diffSummary(null), 'Nothing to import');
});

test('sanitize strips control and bidi characters and caps length', () => {
  assert.equal(Model.sanitize('a\u202eb\u0000c'), 'abc');
  assert.equal(Model.sanitize('x'.repeat(300)).length, 200);
  assert.equal(Model.sanitize(null), '');
});

test('Model.js never touches Qt', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'Model.js'), 'utf8');
  assert.doesNotMatch(src, /\bQt\./);
  assert.doesNotMatch(src, /Quickshell/);
  assert.doesNotMatch(src, /^import |^\.import /m);
});
