import QtQuick
import QtQuick.Controls as Controls
import qs.Commons
import qs.Ui
import "Model.js" as Model

// One KeyboardPanel: hero, five sections, key-hint footer. State machine and
// cursor live here; every process lives in Service.qml.
Panel {
    id: root
    moduleName: "io.github.zeus-deus.voxtype"
    manageIpc: false
    property var anchorItem: null
    property var hostWidget: null

    // Bridge state
    property var status: null
    property var snapshot: ({})
    property var options: null
    property var modelRows: []
    property string modelsEngine: ""
    property var gpu: null
    property var restartNeeded: []
    property string errorText: ""
    property string notice: ""
    property bool tuiMissing: false
    property bool loaded: false
    property string previewOutput: ""
    property var exportPreview: null
    property var importPreview: null
    property string importPath: ""
    property bool attaching: false
    // Set ONLY by askImport, from the confirmation the user actually saw.
    // applyConfirmed sends it verbatim as accept_dangerous, so nothing else
    // may raise it: a stale true would make the bridge's refusal dead code.
    property bool importAcceptDangerous: false

    // Cursor / navigation
    property string section: "dictate"
    property string cursorKey: ""
    property int cursorIndex: -1
    property bool cursorActive: false
    property var focusedEditor: null
    property int openPopups: 0
    property string confirmAction: ""
    property var confirmPayload: null
    property string dictCategory: "Replacement"
    property bool exportOpen: false
    property string exportScope: "sync"
    property bool exportSecrets: false
    property bool importLocal: false
    // voxtype-tui's own import screen ships this OFF: importing an old bundle
    // to restore vocabulary must not silently overwrite whisper.model and the
    // rest of the settings block. The bridge defaults it to false too; the
    // panel still sends it explicitly on both ops.
    property bool importSettings: false

    readonly property var vocabulary: snapshot.vocabulary || []
    readonly property var replacements: snapshot.replacements || []
    readonly property var config: snapshot.settings || ({})
    readonly property var categories: snapshot.categories || ["Replacement", "Capitalization"]
    readonly property int vocabTokens: snapshot.vocab_tokens || 0
    readonly property int vocabTokenLimit: snapshot.vocab_token_limit || Model.TOKEN_LIMIT
    readonly property var filteredVocabulary: Model.filterVocabulary(vocabulary, vocabSearch.text)
    readonly property var filteredReplacements: Model.filterReplacements(replacements, dictSearch.text)
    readonly property string daemonState: service.daemonState
    readonly property string engine: String(Model.settingValue(config, "engine", status && status.engine ? status.engine : "whisper"))
    // True until the catalog for the current engine has been read; an engine
    // switch shows a neutral loading state rather than a stale "no models".
    readonly property bool modelsLoading: modelsEngine !== engine || !loaded
    readonly property string modelPath: options && options.model_paths && options.model_paths[engine] ? options.model_paths[engine] : engine + ".model"
    readonly property bool stale: (status && status.daemon && status.daemon.stale) || restartNeeded.length > 0
    readonly property var lockedState: Model.lockedState(status, tuiMissing ? Model.ERROR_TUI_MISSING : "")
    readonly property bool locked: lockedState !== null
    readonly property string lockedCommand: lockedState ? lockedState.command : ""
    // The install hand-off needs Omarchy's floating-terminal launcher; without
    // it the locked state falls back to the copy button alone.
    readonly property bool canInstallLocked: locked && !!lockedState.install && installTerminalAvailable
    readonly property bool modelMissing: status !== null && status.model && status.model.present === false
    // Undefined means an older bridge: assume the helper exists.
    readonly property bool terminalAvailable: !(status && status.terminal_launcher_available === false)
    readonly property bool installTerminalAvailable: !(status && status.install_terminal_available === false)
    readonly property bool pickerAvailable: !(status && status.picker_available === false)
    readonly property string primary: root.locked ? "" : Model.primaryAction(status)
    readonly property string tooltip: "Voxtype · " + Model.heroMeta(status, tuiMissing ? Model.ERROR_TUI_MISSING : "")
    readonly property color foreground: bar ? bar.foreground : Color.foreground
    readonly property color urgent: bar ? bar.urgent : Color.urgent
    // Commons/Color.qml ships `muted` from the theme (and a per-bar override
    // wins when a bar supplies one). Qt.darker(foreground) was wrong on a
    // light theme — it made "muted" text HEAVIER than the primary
    // foreground, inverting the hierarchy — and it ignored user overrides.
    readonly property color muted: bar && bar.muted ? bar.muted : Color.muted
    readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
    readonly property int pollIntervalMs: Math.max(1, Math.min(10, setting("pollIntervalSec", 2))) * 1000
    readonly property bool editing: focusedEditor !== null
    readonly property bool keysBlocked: editing || confirmation.opened || openPopups > 0
    readonly property var sectionOptions: [
        {value: "dictate", label: "Dictate"}, {value: "vocabulary", label: "Vocabulary"},
        {value: "dictionary", label: "Dictionary"}, {value: "settings", label: "Settings"}, {value: "models", label: "Models"}
    ]
    // Only the controls that are actually on screen: the predicates live in
    // Model.settingsTargets so Node can pin them against the `visible:`
    // bindings below.
    readonly property var settingsTargets: Model.settingsTargets(config, engine, modelPath)

    function targetsFor(sectionName) {
        if (sectionName === "dictate") {
            var t = ["record", "restart"];
            if (modelMissing) t.push("download");
            t.push("test");
            return t;
        }
        if (sectionName === "vocabulary") return ["search", "rows"];
        if (sectionName === "dictionary") return ["search", "rows"];
        if (sectionName === "settings") return settingsTargets;
        if (sectionName === "models") return ["engine", "rows", "export", "import"];
        return [];
    }
    function rowCount() {
        if (section === "vocabulary") return filteredVocabulary.length;
        if (section === "dictionary") return filteredReplacements.length;
        if (section === "models") return modelRows.length;
        return 0;
    }
    function cursorIs(key) { return cursorActive && cursorKey === key }
    function rowHasCursor(index) { return cursorActive && cursorKey === "rows" && cursorIndex === index }
    function setCursor(key, index) {
        cursorActive = true;
        cursorKey = key;
        cursorIndex = key === "rows" ? index : -1;
    }
    function moveCursor(dy) {
        var targets = targetsFor(section);
        if (targets.length === 0) return;
        if (!cursorActive || targets.indexOf(cursorKey) < 0) {
            cursorActive = true;
            cursorKey = targets[0];
            cursorIndex = cursorKey === "rows" ? 0 : -1;
            if (cursorKey === "rows" && rowCount() === 0) moveCursor(dy > 0 ? 1 : -1);
            return;
        }
        var i = targets.indexOf(cursorKey);
        if (cursorKey === "rows") {
            var count = rowCount();
            var next = cursorIndex + dy;
            if (count > 0 && next >= 0 && next < count) { cursorIndex = next; return; }
        }
        var j = i + dy;
        while (j >= 0 && j < targets.length) {
            if (targets[j] !== "rows" || rowCount() > 0) break;
            j += dy;
        }
        if (j < 0 || j >= targets.length) return;
        cursorKey = targets[j];
        cursorIndex = cursorKey === "rows" ? (dy > 0 ? 0 : rowCount() - 1) : -1;
    }
    function moveCursorH(dx) {
        if (!cursorActive) return;
        if (cursorKey === "audio.feedback.volume") nudgeSlider("audio.feedback.volume", dx * 0.05, 0, 1);
        else if (cursorKey === "vad.threshold") nudgeSlider("vad.threshold", dx * 0.05, 0, 1);
    }
    function nudgeSlider(path, delta, lo, hi) {
        var v = Number(Model.settingValue(config, path, 0.5)) + delta;
        setSetting(path, Math.round(Math.max(lo, Math.min(hi, v)) * 100) / 100);
    }
    function clampCursor() {
        if (cursorKey !== "rows") return;
        var count = rowCount();
        if (count === 0) { cursorIndex = -1; return; }
        cursorIndex = Math.max(0, Math.min(count - 1, cursorIndex));
    }
    function selectSection(name) {
        if (name === section || name === "") return;
        section = name;
        cursorActive = false;
        cursorKey = "";
        cursorIndex = -1;
        exportOpen = false;
        importPreview = null;
        body.contentY = 0;
        if (name === "models") loadModels();
        if (name === "settings") { loadModels(); if (!gpu) service.run({op: "gpu.status"}); }
        keyCatcher.forceActiveFocus();
    }
    function cycleSection(delta) { selectSection(Model.nextSection(section, delta)) }

    // ---- lifecycle ---------------------------------------------------------
    function open() {
        controller.show();
        errorText = "";
        refreshAll();
        Qt.callLater(function() { keyCatcher.forceActiveFocus() });
    }
    function close() {
        if (confirmation.opened) return;
        controller.hide();
    }
    function closeForPopoutSwitch() {
        // The bar transfers ownership immediately; a file chooser opened by
        // this panel must no longer reclaim the screen afterwards.
        popoutSwitchClosing = true;
        confirmation.opened = false;
        confirmAction = "";
        importAcceptDangerous = false;
        attaching = false;
        openPopups = 0;
        service.cancelPick();
        controller.hide();
        Qt.callLater(function() { root.popoutSwitchClosing = false });
    }
    function popoutTakenElsewhere() {
        // The bar hands the popout to whichever widget asked last; while this
        // panel is hidden for a chooser the marker is foreign, not ours.
        var owner = hostWidget || root;
        return !!(bar && bar.activePopout && bar.activePopout !== owner);
    }
    onOpenedChanged: {
        if (!opened) {
            confirmation.opened = false;
            confirmAction = "";
            importAcceptDangerous = false;
            focusedEditor = null;
            openPopups = 0;
            testField.text = "";
            previewOutput = "";
            vocabSearch.text = "";
            dictSearch.text = "";
            service.cancelQueued("status");
            // Slow enumerations (devices, compiled engines) are cached per
            // panel open only.
            options = null;
        }
    }
    function refreshAll() {
        service.run({op: "status"});
        service.run({op: "load"});
        if (!options) service.run({op: "options"});
        if (section === "models" || section === "settings") loadModels();
    }
    function loadModels() {
        if (service.downloading) return;
        service.cancelQueued("models.list");
        service.run({op: "models.list", engine: engine});
    }
    function toggleRecord() {
        if (locked) return;
        if (!service.toggleRecord()) return;
        notice = daemonState === "recording" ? "Stopping…" : "Recording…";
    }
    function restartDaemon() {
        if (locked || service.restarting) return;
        notice = "Restarting daemon…";
        // The bridge waits up to `timeout` s for readiness on top of
        // systemctl's own 15 s blocking restart; the Service deadline (40 s)
        // must stay above that sum. See Service.qml run() and bridge.py's
        // SYSTEMCTL_RESTART_TIMEOUT / DAEMON_RESTART_READY_TIMEOUT.
        service.run({op: "daemon.restart", timeout: 18});
    }
    function restartIfStale() { if (stale) restartDaemon() }
    function runPrimary() {
        if (primary === "start") service.run({op: "daemon.start"});
        else if (primary === "restart") restartDaemon();
        else if (primary === "record") toggleRecord();
    }
    function setSetting(path, value) {
        if (locked) return;
        if (!Model.settingChanged(config, path, value)) return;
        // Optimistic local echo so a slider or toggle never snaps back while
        // the bridge validates; the response snapshot is the truth.
        var next = {};
        for (var k in config) next[k] = config[k];
        next[path] = value;
        var snap = {};
        for (var s in snapshot) snap[s] = snapshot[s];
        snap.settings = next;
        snapshot = snap;
        service.cancelQueued("status");
        service.run({op: "settings.set", path: path, value: value});
    }
    function unsetSetting(path) { if (!locked) service.run({op: "settings.unset", path: path}) }
    function resetCursorSetting() {
        if (!cursorActive) return;
        var path = Model.resettableSetting(cursorKey);
        if (path !== "" && Model.settingIsSet(config, path)) unsetSetting(path);
    }
    function toggleModifier(mod) {
        var mods = Model.settingValue(config, "hotkey.modifiers", []);
        setSetting("hotkey.modifiers", Model.toggleInList(mods, mod));
    }
    function addVocab() {
        var phrase = vocabSearch.text.trim();
        if (phrase === "" || locked) return;
        service.run({op: "vocab.add", phrase: phrase});
        vocabSearch.text = "";
    }
    function upsertRule() {
        var from = dictFrom.text.trim();
        var to = dictTo.text.trim();
        if (from === "" || to === "" || locked) return;
        service.run({op: "dict.upsert", from: from, to: to, category: dictCategory});
        dictFrom.text = "";
        dictTo.text = "";
        keyCatcher.forceActiveFocus();
    }
    function cycleRuleCategory() {
        var rule = filteredReplacements[cursorIndex];
        if (!rule || cursorKey !== "rows" || locked) return;
        service.run({op: "dict.set_category", from: rule.from, category: Model.nextCategory(rule.category, categories)});
    }
    function previewPhrase() {
        var text = testField.text.trim();
        if (text === "") { previewOutput = ""; return; }
        service.cancelQueued("dictionary.preview");
        service.run({op: "dictionary.preview", text: text});
    }
    function ask(action, payload, message, confirmLabel) {
        if (locked) return;
        confirmAction = action;
        confirmPayload = payload;
        // The untrusted fragments were sanitized by the caller; this only
        // caps the assembled copy and keeps the panel's own literal "\n".
        confirmation.message = Model.sanitizeMessage(message, 600);
        confirmation.confirmText = confirmLabel;
        confirmation.selectedIndex = 0;
        confirmation.opened = true;
        keyCatcher.forceActiveFocus();
    }
    function deleteSelected() {
        if (cursorKey !== "rows") return;
        if (section === "vocabulary") {
            var word = filteredVocabulary[cursorIndex];
            if (word) ask("vocab.remove", {phrase: word.phrase}, "Remove “" + Model.sanitize(word.phrase, 60) + "” from the vocabulary?", "Remove");
        } else if (section === "dictionary") {
            var rule = filteredReplacements[cursorIndex];
            if (rule) ask("dict.remove", {from: rule.from}, "Delete the rule “" + Model.sanitize(rule.from, 60) + " → " + Model.sanitize(rule.to, 60) + "”?", "Delete");
        } else if (section === "models") {
            var m = modelRows[cursorIndex];
            if (!m) return;
            var why = Model.modelActionBlock(m, "delete");
            if (why !== "") { showNotice(why); return; }
            ask("models.delete", {engine: modelsEngine, name: m.name}, "Delete " + Model.sanitize(m.name, 60) + " from disk?\nIt can be downloaded again later.", "Delete");
        }
    }
    function applyConfirmed() {
        var action = confirmAction;
        var payload = confirmPayload;
        confirmAction = "";
        confirmPayload = null;
        if (action === "import.apply") {
            // accept_dangerous mirrors the confirmation the user just read.
            // With no dangerous rows it is false, so the bridge's own gate
            // stays live rather than being pre-waived on every import.
            var accept = importAcceptDangerous;
            importAcceptDangerous = false;
            service.run({op: "import.apply", path: importPath, include_local: importLocal, include_settings: importSettings, accept_dangerous: accept});
            return;
        }
        if (action === "") return;
        var req = {op: action};
        for (var k in payload) req[k] = payload[k];
        service.run(req);
    }
    function setActiveModel(m) {
        if (!m || locked) return;
        if (!m.downloaded) { startDownload(m); return; }
        service.run({op: "models.set_active", engine: modelsEngine, name: m.name});
    }
    function startDownload(m) {
        if (!m || locked || service.downloading) return;
        if (!service.download(modelsEngine, m.name)) return;
        notice = "Downloading " + m.name + "…";
    }
    function downloadCursorModel() {
        if (section !== "models" || cursorKey !== "rows") return;
        var m = modelRows[cursorIndex];
        if (!m) return;
        var why = Model.modelActionBlock(m, "download");
        if (why !== "") { showNotice(why); return; }
        startDownload(m);
    }
    function showNotice(text) {
        notice = text;
        noticeTimer.restart();
    }
    function activateCursor() {
        if (locked) { if (canInstallLocked) launchLockedInstall(); else copyLockedCommand(); return; }
        if (!cursorActive) { moveCursor(1); return; }
        var key = cursorKey;
        if (section === "dictate") {
            if (key === "record") toggleRecord();
            else if (key === "restart") restartDaemon();
            else if (key === "download") selectSection("models");
            else if (key === "test") testField.forceActiveFocus();
        } else if (section === "vocabulary") {
            if (key === "search") vocabSearch.forceActiveFocus();
        } else if (section === "dictionary") {
            if (key === "search") dictSearch.forceActiveFocus();
            else if (key === "rows") cycleRuleCategory();
        } else if (section === "models") {
            if (key === "engine") engineDropdown.open();
            else if (key === "rows") setActiveModel(modelRows[cursorIndex]);
            else if (key === "export") toggleExport();
            else if (key === "import") beginImport();
        } else if (section === "settings") {
            activateSetting(key);
        }
    }
    function activateSetting(key) {
        if (key.indexOf("hotkey.mod.") === 0) { toggleModifier(key.slice(11)); return; }
        if (key === "remote.clear") { unsetSetting("whisper.remote_api_key"); return; }
        if (key === "gpu.enable" || key === "gpu.disable") { launchGpu(key === "gpu.enable"); return; }
        var item = settingsForm.controlFor(key);
        if (!item) return;
        if (typeof item.activate === "function") item.activate();
    }
    function copyLockedCommand() {
        if (lockedCommand === "" || !service.copy(lockedCommand)) return;
        notice = "Copied";
        noticeTimer.restart();
    }
    function launchLockedInstall() {
        if (!canInstallLocked) return;
        // Same hand-off as the GPU buttons: the terminal would open under the
        // full-screen panel layer, so hide first. Reopen after installing.
        controller.hide();
        service.launchInstall(lockedState.kind);
    }
    function launchGpu(enable) {
        if (locked || !terminalAvailable) return;
        // A terminal opened under the full-screen panel layer is invisible;
        // hide first, then hand the sudo prompt to the user's terminal.
        controller.hide();
        // The terminal will change the backend; the card re-reads on reopen.
        gpu = null;
        service.launchGpuSetup(enable);
    }
    function toggleExport() {
        exportOpen = !exportOpen;
        importPreview = null;
        if (exportOpen) {
            service.run({op: "export.preview", scope: exportScope, include_secrets: exportSecrets});
            Qt.callLater(function() { root.revealForm(exportForm) });
        }
    }
    // The backup forms open below the fold; bring the form into view.
    function revealForm(item) {
        if (!item || !item.visible || !body) return;
        var top = item.mapToItem(body.contentItem, 0, 0).y;
        var maxY = Math.max(0, body.contentHeight - body.height);
        body.contentY = Math.min(maxY, Math.max(0, top - Style.space(12)));
    }
    function refreshExportPreview() { if (exportOpen) service.run({op: "export.preview", scope: exportScope, include_secrets: exportSecrets}) }
    // Both import ops carry include_local / include_settings explicitly, so a
    // permissive bridge default can never widen an import behind the user's
    // back, and the diff on screen is the diff that will be applied.
    function requestImportPreview() {
        if (importPath === "" || locked) return;
        service.cancelQueued("import.preview");
        service.run({op: "import.preview", path: importPath, include_local: importLocal, include_settings: importSettings});
    }
    // A toggle changes what the bundle would write, so the reviewed diff and
    // any acknowledgement built from it are both invalidated.
    function setImportSettings(value) {
        if (importSettings === value) return;
        importSettings = value;
        importAcceptDangerous = false;
        requestImportPreview();
    }
    function writeExport() {
        var path = exportPath.text.trim();
        if (path === "" || locked) return;
        service.run({op: "export.write", path: path, scope: exportScope, include_secrets: exportSecrets});
    }
    function beginImport() {
        if (locked || service.picking || !pickerAvailable) return;
        attaching = true;
        exportOpen = false;
        // Every import starts from the safe default; a toggle left on from a
        // previous bundle must not carry into the next one.
        importSettings = false;
        importAcceptDangerous = false;
        controller.hide();
        if (!service.pick()) { attaching = false; controller.show(); }
    }
    function resumeAfterPick() {
        if (!attaching) return;
        attaching = false;
        // A late chooser result must never reclaim the screen from the
        // widget that took the popout meanwhile; the result is still kept.
        if (popoutTakenElsewhere()) return;
        controller.show();
        Qt.callLater(function() { keyCatcher.forceActiveFocus() });
    }
    function askImport() {
        if (!importPreview) return;
        var confirmation = Model.importConfirmation(importPath.split("/").pop(), importPreview.diff);
        // The dialog is the acknowledgement: accept_dangerous is whatever
        // this message could actually show, never a constant.
        importAcceptDangerous = confirmation.accept;
        ask("import.apply", null, confirmation.message, confirmation.confirmText);
    }
    function noteEditor(item, focused) {
        if (focused) focusedEditor = item;
        else if (focusedEditor === item) focusedEditor = null;
    }
    function notePopup(open) { openPopups = Math.max(0, openPopups + (open ? 1 : -1)) }
    function ensureVisible(item) {
        if (!item || !body) return;
        var pt = item.mapToItem(body.contentItem, 0, 0);
        var top = pt.y, bottom = top + item.height;
        var margin = Style.space(12);
        if (top < body.contentY + margin) body.contentY = Math.max(0, top - margin);
        else if (bottom > body.contentY + body.height - margin) body.contentY = Math.min(Math.max(0, body.contentHeight - body.height), bottom + margin - body.height);
    }
    function applySnapshot(next) {
        if (!next || typeof next !== "object") return;
        var merged = {};
        for (var k in snapshot) merged[k] = snapshot[k];
        // Reassigning the model arrays destroys open row editors, so only
        // arrays whose contents changed are replaced.
        for (var key in next) {
            if ((key === "vocabulary" || key === "replacements") && Model.sameList(snapshot[key], next[key], true)) continue;
            merged[key] = next[key];
        }
        snapshot = merged;
        loaded = true;
    }
    function handleKey(event) {
        if (confirmation.opened) {
            confirmation.handleKey(event);
            event.accepted = true;
            return;
        }
        if (event.modifiers & Qt.ControlModifier) {
            if (event.key === Qt.Key_R) { restartDaemon(); event.accepted = true; }
            else if (event.key === Qt.Key_F) { focusSearch(); event.accepted = true; }
        }
    }
    function focusSearch() {
        if (section === "vocabulary") vocabSearch.forceActiveFocus();
        else if (section === "dictionary") dictSearch.forceActiveFocus();
        else if (section === "dictate") testField.forceActiveFocus();
    }
    function handleTextKey(t) {
        if (locked) { if (t === "y" && canInstallLocked) copyLockedCommand(); return; }
        var s = Model.sectionForKey(t);
        if (s !== "") { selectSection(s); return; }
        if (t === "/") focusSearch();
        else if (t === "a" && section === "vocabulary") vocabSearch.forceActiveFocus();
        else if (t === "a" && section === "dictionary") dictFrom.forceActiveFocus();
        else if (t === "c" && section === "dictionary") cycleRuleCategory();
        else if (t === "d" && section === "models") downloadCursorModel();
        else if (t === "u" && section === "settings") resetCursorSetting();
        else if (t === "r" || t === "R") toggleRecord();
    }
    onFilteredVocabularyChanged: clampCursor()
    onFilteredReplacementsChanged: clampCursor()
    onModelRowsChanged: clampCursor()
    onEngineChanged: if (opened && (section === "models" || section === "settings")) loadModels()

    Service {
        id: service
        pollState: true
        pollIntervalMs: 1500
        onCompleted: function(op, result, req) {
            if (Model.isTuiMissing(result)) { root.tuiMissing = true; root.errorText = ""; return; }
            if (!result.ok) {
                // The bridge refuses an apply whose diff no longer matches
                // what was acknowledged (the file changed between preview and
                // apply, or the dangerous set grew). Say what to do instead of
                // dumping the protocol error.
                if (op === "import.apply" && result.error === "dangerous-changes") {
                    root.importPreview = null;
                    root.importAcceptDangerous = false;
                    root.errorText = "Import refused: the bundle's dangerous changes no longer match what you reviewed. Preview it again.";
                    return;
                }
                if (op !== "status" || !root.status) root.errorText = Model.sanitize(result.error, 200);
                return;
            }
            root.tuiMissing = false;
            if (op !== "status") root.errorText = "";
            if (op === "status") { root.status = result; service.status = result; }
            else if (op === "load") { root.applySnapshot(result.snapshot); root.loaded = true; }
            else if (op === "options") root.options = result;
            else if (op === "models.list") {
                root.modelsEngine = result.engine || req.engine;
                if (!Model.sameList(root.modelRows, result.models || [], true)) root.modelRows = result.models || [];
            }
            else if (op === "gpu.status") root.gpu = result;
            else if (op === "dictionary.preview") root.previewOutput = Model.sanitize(result.output, 400);
            else if (op === "export.preview") { root.exportPreview = result; if (exportPath.text === "") exportPath.text = result.default_path || ""; }
            else if (op === "export.write") { root.notice = "Exported " + Model.formatBytes(result.bytes) + " to " + Model.sanitize(result.path, 80); noticeTimer.restart(); root.exportOpen = false; }
            else if (op === "import.preview") { root.importPreview = result; Qt.callLater(function() { root.revealForm(importCard) }); }
            else if (op === "daemon.restart") {
                root.notice = result.ready ? "Daemon restarted" : Model.sanitize(result.message || "Daemon restarting…", 120);
                root.restartNeeded = [];
                noticeTimer.restart();
                service.run({op: "status"});
            }
            else if (op === "daemon.start" || op === "daemon.stop" || op === "record.toggle") service.run({op: "status"});
            else if (result.snapshot !== undefined) {
                root.applySnapshot(result.snapshot);
                var needed = root.restartNeeded.slice();
                var paths = result.restart_needed || [];
                for (var i = 0; i < paths.length; i++) if (needed.indexOf(paths[i]) < 0) needed.push(paths[i]);
                root.restartNeeded = needed;
                root.notice = "Saved";
                noticeTimer.restart();
                if (op === "import.apply") { root.importPreview = null; root.notice = "Imported"; }
                if (op === "models.set_active" || op === "models.delete") root.loadModels();
                if (op === "gpu.set_device") service.run({op: "gpu.status"});
                if (op === "settings.set" && req.path === "engine") root.loadModels();
            }
        }
        onDownloadDone: function(engine, name, ok, reason) {
            root.notice = ok ? "Downloaded " + name : "";
            if (!ok) root.errorText = "Download of " + name + " failed: " + Model.sanitize(reason, 160);
            noticeTimer.restart();
            root.loadModels();
            service.run({op: "status"});
        }
        onRecordFinished: function(ok) {
            if (!ok) root.errorText = "Could not toggle recording. Is the voxtype daemon running?";
            else { root.notice = ""; service.run({op: "status"}); }
        }
        onPicked: function(path) {
            root.resumeAfterPick();
            root.importPath = path;
            root.requestImportPreview();
        }
        onPickCanceled: root.resumeAfterPick()
        onCopyFinished: function(ok) { if (!ok) { root.notice = ""; root.errorText = "Could not copy: is wl-copy installed?" } }
        onPickFailed: { root.resumeAfterPick(); root.errorText = Model.ERROR_PICKER_MISSING }
    }
    Timer {
        id: statusPoll
        interval: root.pollIntervalMs
        repeat: true
        running: root.opened && !root.locked
        onTriggered: service.run({op: "status"})
    }
    Timer { id: noticeTimer; interval: 2600; onTriggered: root.notice = "" }
    Timer { id: previewDebounce; interval: 350; onTriggered: root.previewPhrase() }

    KeyboardPanel {
        id: panel
        anchorItem: root.anchorItem
        owner: root.hostWidget || root
        bar: root.bar
        open: root.opened
        focusTarget: keyCatcher
        contentWidth: fittedContentWidth(Style.space(560))
        contentHeight: fittedContentHeight(Style.space(520))

        FocusScope {
            id: keys
            anchors.fill: parent
            Keys.onPressed: function(event) { root.handleKey(event) }

            PanelKeyCatcher {
                id: keyCatcher
                anchors.fill: parent
                blocked: root.keysBlocked
                onMoveRequested: function(dx, dy) {
                    if (dy !== 0) root.moveCursor(dy);
                    else root.moveCursorH(dx);
                }
                onActivateRequested: root.activateCursor()
                onCloseRequested: root.close()
                onDeleteRequested: root.deleteSelected()
                onTabRequested: function(direction) { root.cycleSection(direction) }
                onTextKey: function(t) { root.handleTextKey(t) }

                Column {
                    id: layout
                    anchors.fill: parent
                    spacing: Style.space(12)
                    enabled: !confirmation.opened

                    PanelHero {
                        id: hero
                        title: "Voxtype"
                        meta: Model.heroMeta(root.status, root.tuiMissing ? Model.ERROR_TUI_MISSING : root.errorText)
                        detail: root.locked ? "" : (root.stale ? "RESTART TO APPLY" : "")
                        foreground: root.foreground
                        fontFamily: root.fontFamily
                        iconOpacity: root.locked || root.daemonState === "stopped" ? 0.55 : 1
                        iconComponent: Component {
                            VoxtypeIcon {
                                daemonState: root.daemonState
                                color: root.daemonState === "recording" ? Color.accent : root.foreground
                            }
                        }
                        trailingControl: Component {
                            Button {
                                visible: root.primary !== ""
                                text: Model.primaryLabel(root.primary, root.daemonState)
                                iconText: root.primary === "record" ? (root.daemonState === "recording" ? "󰓛" : "󰍬") : (root.primary === "restart" ? "󰑓" : "󰐊")
                                bordered: true
                                focusable: false
                                foreground: root.foreground
                                fontFamily: root.fontFamily
                                enabled: !service.recording && !service.restarting
                                tooltipText: root.primary === "record" ? "r · toggle recording" : (root.primary === "restart" ? "Ctrl+R · restart the daemon" : "Start the voxtype service")
                                onClicked: root.runPrimary()
                            }
                        }
                    }

                    ButtonGroup {
                        id: tabs
                        width: parent.width
                        visible: !root.locked
                        options: root.sectionOptions
                        value: root.section
                        focusable: false
                        foreground: root.foreground
                        fontFamily: root.fontFamily
                        fontSize: Style.font.bodySmall
                        onChanged: function(v) { root.selectSection(v) }
                    }
                    PanelSeparator { id: tabSeparator; width: parent.width; foreground: root.foreground }

                    Flickable {
                        id: body
                        width: parent.width
                        height: Math.max(Style.space(80), layout.height - hero.height - (tabs.visible ? tabs.height : 0) - footer.height - tabSeparator.height - layout.spacing * 4)
                        contentWidth: width
                        contentHeight: root.locked ? lockedView.implicitHeight : sections.implicitHeight
                        clip: true
                        boundsBehavior: Flickable.StopAtBounds
                        flickableDirection: Flickable.VerticalFlick
                        interactive: contentHeight > height
                        Controls.ScrollBar.vertical: Controls.ScrollBar { policy: Controls.ScrollBar.AsNeeded }
                        // A wheel notch scrolls three rows immediately instead of
                        // starting a Flickable kinetic flick, so it matches the
                        // rest of the desktop. Touchpads pass pixelDelta through.
                        WheelHandler {
                            acceptedDevices: PointerDevice.Mouse | PointerDevice.TouchPad
                            onWheel: function(event) {
                                if (!body.interactive) return;
                                body.contentY = Model.wheelContentY(body.contentY, body.contentHeight, body.height,
                                                                    event.pixelDelta.y, event.angleDelta.y,
                                                                    Style.spacing.popupRowHeight * 3);
                                event.accepted = true;
                            }
                        }

                        // ---- locked / dependency-missing state --------------
                        Column {
                            id: lockedView
                            visible: root.locked
                            width: body.width - Style.space(24)
                            anchors.horizontalCenter: parent.horizontalCenter
                            spacing: Style.space(14)
                            topPadding: Style.space(40)
                            Text { anchors.horizontalCenter: parent.horizontalCenter; textFormat: Text.PlainText; text: "󰍭"; color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.space(38) }
                            Text {
                                width: parent.width; horizontalAlignment: Text.AlignHCenter; textFormat: Text.PlainText
                                text: root.lockedState ? root.lockedState.title : ""
                                color: root.foreground; font.family: root.fontFamily; font.pixelSize: Style.font.subtitle; wrapMode: Text.WordWrap
                            }
                            Text {
                                width: parent.width; horizontalAlignment: Text.AlignHCenter; textFormat: Text.PlainText
                                text: root.lockedState ? root.lockedState.hint : ""
                                color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.body; wrapMode: Text.WordWrap
                            }
                            // Install hands a fixed script to Omarchy's floating
                            // terminal, where the user confirms and sees it run.
                            Button {
                                anchors.horizontalCenter: parent.horizontalCenter
                                visible: root.canInstallLocked
                                text: root.lockedState && root.lockedState.install ? root.lockedState.install : ""
                                iconText: "󰏔"; bordered: true
                                foreground: root.foreground; fontFamily: root.fontFamily
                                tooltipText: "Opens a terminal that asks before installing"
                                onClicked: root.launchLockedInstall()
                            }
                            // The command is shown and copied, never run by the panel.
                            Button {
                                anchors.horizontalCenter: parent.horizontalCenter
                                visible: root.lockedCommand !== ""
                                text: root.lockedCommand; iconText: "󰆏"; bordered: !root.canInstallLocked
                                foreground: root.canInstallLocked ? root.muted : root.foreground; fontFamily: root.fontFamily
                                tooltipText: "Copy to clipboard"
                                enabled: !service.copying
                                onClicked: root.copyLockedCommand()
                            }
                        }

                        Column {
                            id: sections
                            visible: !root.locked
                            width: body.width - Style.space(6)
                            spacing: Style.space(12)

                            // ================= 1 · Dictate =================
                            Column {
                                visible: root.section === "dictate"
                                width: parent.width
                                spacing: Style.space(12)

                                CursorSurface {
                                    width: parent.width
                                    bordered: true
                                    foreground: root.foreground
                                    implicitHeight: statusGrid.implicitHeight + Style.space(24)
                                    Grid {
                                        id: statusGrid
                                        anchors.left: parent.left; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
                                        anchors.margins: Style.space(14)
                                        columns: 2
                                        columnSpacing: Style.space(16)
                                        rowSpacing: Style.space(10)
                                        StatusCell { width: (statusGrid.width - statusGrid.columnSpacing) / 2; label: "STATE"; value: root.status ? Model.titleCase(root.daemonState) : "…"; accent: root.daemonState === "recording" }
                                        StatusCell { width: (statusGrid.width - statusGrid.columnSpacing) / 2; label: "ENGINE"; value: root.status ? root.engine + " · " + Model.sanitize(root.status.model ? root.status.model.name : "", 60) : "…" }
                                        StatusCell { width: (statusGrid.width - statusGrid.columnSpacing) / 2; label: "HOTKEY"; value: root.status ? Model.hotkeyLabel(root.status.hotkey) : "…" }
                                        StatusCell { width: (statusGrid.width - statusGrid.columnSpacing) / 2; label: "OUTPUT"; value: root.status ? String(root.status.output_mode || "") + (root.status.hotkey && root.status.hotkey.mode ? " · " + String(root.status.hotkey.mode).replace(/_/g, " ") : "") : "…" }
                                    }
                                }

                                Row {
                                    spacing: Style.space(8)
                                    Button {
                                        text: root.daemonState === "recording" ? "Stop recording" : "Record"
                                        iconText: root.daemonState === "recording" ? "󰓛" : "󰍬"
                                        bordered: true
                                        hasCursor: root.cursorIs("record")
                                        foreground: root.foreground
                                        fontFamily: root.fontFamily
                                        enabled: root.daemonState !== "stopped" && root.daemonState !== "unknown" && !service.recording
                                        onHovered: function(h) { if (h) root.setCursor("record", -1) }
                                        onClicked: root.toggleRecord()
                                    }
                                    Button {
                                        text: "Restart daemon"
                                        iconText: "󰑓"
                                        bordered: true
                                        hasCursor: root.cursorIs("restart")
                                        foreground: root.foreground
                                        fontFamily: root.fontFamily
                                        enabled: !service.restarting
                                        onHovered: function(h) { if (h) root.setCursor("restart", -1) }
                                        onClicked: root.restartDaemon()
                                    }
                                }

                                Repeater {
                                    model: Model.notices(root.status, root.snapshot)
                                    delegate: CursorSurface {
                                        required property var modelData
                                        width: parent.width
                                        bordered: true
                                        foreground: modelData.kind === "warn" ? root.urgent : root.foreground
                                        accent: modelData.kind === "warn" ? root.urgent : Color.accent
                                        implicitHeight: noticeRow.implicitHeight + Style.space(20)
                                        Row {
                                            id: noticeRow
                                            anchors.left: parent.left; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
                                            anchors.margins: Style.space(12)
                                            spacing: Style.space(10)
                                            Text { textFormat: Text.PlainText; text: modelData.kind === "warn" ? "󰀦" : "󰋽"; color: modelData.kind === "warn" ? root.urgent : Color.accent; font.family: root.fontFamily; font.pixelSize: Style.font.heading; anchors.verticalCenter: parent.verticalCenter }
                                            Text {
                                                width: parent.width - Style.space(30) - parent.spacing
                                                textFormat: Text.PlainText; wrapMode: Text.WordWrap
                                                text: modelData.text
                                                color: root.foreground; font.family: root.fontFamily; font.pixelSize: Style.font.body
                                                anchors.verticalCenter: parent.verticalCenter
                                            }
                                        }
                                    }
                                }

                                CursorSurface {
                                    visible: root.modelMissing
                                    width: parent.width
                                    bordered: true
                                    hasCursor: root.cursorIs("download")
                                    foreground: root.urgent
                                    accent: root.urgent
                                    implicitHeight: bannerRow.implicitHeight + Style.space(20)
                                    MouseArea { anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onEntered: root.setCursor("download", -1); onClicked: root.selectSection("models") }
                                    Row {
                                        id: bannerRow
                                        anchors.left: parent.left; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
                                        anchors.margins: Style.space(12)
                                        spacing: Style.space(10)
                                        Text { textFormat: Text.PlainText; text: "󰀦"; color: root.urgent; font.family: root.fontFamily; font.pixelSize: Style.font.heading; anchors.verticalCenter: parent.verticalCenter }
                                        Text {
                                            width: parent.width - Style.space(30) - downloadHint.width - parent.spacing * 2
                                            textFormat: Text.PlainText; wrapMode: Text.WordWrap
                                            text: "Model " + Model.sanitize(root.status && root.status.model ? root.status.model.name : "", 60) + " is not downloaded"
                                            color: root.foreground; font.family: root.fontFamily; font.pixelSize: Style.font.body
                                            anchors.verticalCenter: parent.verticalCenter
                                        }
                                        Text { id: downloadHint; textFormat: Text.PlainText; text: "Download →"; color: root.urgent; font.family: root.fontFamily; font.pixelSize: Style.font.body; font.bold: true; anchors.verticalCenter: parent.verticalCenter }
                                    }
                                }

                                PanelSectionHeader { text: "TEST A PHRASE"; foreground: root.foreground; fontFamily: root.fontFamily }
                                TextField {
                                    id: testField
                                    width: parent.width
                                    placeholderText: "Type what you would say…"
                                    foreground: root.foreground
                                    hasCursor: root.cursorIs("test")
                                    onHoveredChanged: if (hovered) root.setCursor("test", -1)
                                    onActiveFocusChanged: root.noteEditor(testField, activeFocus)
                                    onTextChanged: previewDebounce.restart()
                                    Keys.onEscapePressed: function(event) { keyCatcher.forceActiveFocus(); event.accepted = true }
                                    Keys.onReturnPressed: root.previewPhrase()
                                }
                                Text {
                                    width: parent.width; textFormat: Text.PlainText; wrapMode: Text.WordWrap
                                    visible: testField.text.trim() !== ""
                                    text: root.previewOutput === "" ? "…" : "→ " + root.previewOutput
                                    color: root.previewOutput !== "" && root.previewOutput !== testField.text.trim() ? Color.accent : root.muted
                                    font.family: root.fontFamily; font.pixelSize: Style.font.subtitle
                                }
                            }

                            // ================= 2 · Vocabulary =================
                            Column {
                                visible: root.section === "vocabulary"
                                width: parent.width
                                spacing: Style.space(10)
                                Row {
                                    width: parent.width
                                    spacing: Style.space(10)
                                    TextField {
                                        id: vocabSearch
                                        width: parent.width - tokenMeter.width - parent.spacing
                                        placeholderText: "Search or add a word · Enter adds"
                                        foreground: root.foreground
                                        hasCursor: root.cursorIs("search")
                                        onHoveredChanged: if (hovered) root.setCursor("search", -1)
                                        onActiveFocusChanged: root.noteEditor(vocabSearch, activeFocus)
                                        onTextChanged: { root.cursorIndex = 0; body.contentY = 0 }
                                        Keys.onReturnPressed: root.addVocab()
                                        Keys.onEscapePressed: function(event) { if (text !== "") text = ""; else keyCatcher.forceActiveFocus(); event.accepted = true }
                                        Keys.onDownPressed: function(event) { keyCatcher.forceActiveFocus(); root.setCursor("rows", 0); event.accepted = true }
                                    }
                                    Text {
                                        id: tokenMeter
                                        anchors.verticalCenter: parent.verticalCenter
                                        text: Model.tokenMeter(root.vocabTokens, root.vocabTokenLimit)
                                        textFormat: Text.PlainText
                                        color: Model.tokenLevel(root.vocabTokens, root.vocabTokenLimit) === "urgent" ? root.urgent : (Model.tokenLevel(root.vocabTokens, root.vocabTokenLimit) === "amber" ? Color.accent : root.muted)
                                        font.family: root.fontFamily; font.pixelSize: Style.font.caption; font.bold: true
                                    }
                                }
                                Repeater {
                                    model: root.filteredVocabulary
                                    delegate: CursorSurface {
                                        id: vocabRow
                                        required property var modelData
                                        required property int index
                                        width: sections.width
                                        implicitHeight: Style.space(40)
                                        hasCursor: root.rowHasCursor(index)
                                        foreground: root.foreground
                                        onHasCursorChanged: if (hasCursor) root.ensureVisible(vocabRow)
                                        MouseArea { anchors.fill: parent; hoverEnabled: true; onEntered: root.setCursor("rows", vocabRow.index) }
                                        Text {
                                            anchors.left: parent.left; anchors.right: vocabActions.left; anchors.verticalCenter: parent.verticalCenter
                                            anchors.leftMargin: Style.space(12); anchors.rightMargin: Style.space(8)
                                            text: Model.sanitize(vocabRow.modelData.phrase, 120); textFormat: Text.PlainText; elide: Text.ElideRight
                                            color: root.foreground; font.family: root.fontFamily; font.pixelSize: Style.font.subtitle
                                        }
                                        Row {
                                            id: vocabActions
                                            anchors.right: parent.right; anchors.rightMargin: Style.space(8); anchors.verticalCenter: parent.verticalCenter
                                            opacity: vocabRow.hasCursor ? 1 : 0
                                            enabled: vocabRow.hasCursor && !service.mutating
                                            PanelActionButton { iconText: "󰆴"; foreground: root.foreground; hoverColor: root.urgent; tooltipText: "x · remove word"; onClicked: { root.setCursor("rows", vocabRow.index); root.deleteSelected() } }
                                        }
                                    }
                                }
                                EmptyState {
                                    visible: root.filteredVocabulary.length === 0
                                    glyph: "󰗊"
                                    title: !root.loaded ? (service.busy ? "Loading vocabulary…" : "Vocabulary unavailable") : (vocabSearch.text !== "" ? "Not in the vocabulary yet" : "No custom words yet")
                                    hint: vocabSearch.text !== "" ? "Press Enter to add “" + vocabSearch.text.trim() + "”" : "Names, products and jargon Voxtype should spell correctly."
                                }
                            }

                            // ================= 3 · Dictionary =================
                            Column {
                                visible: root.section === "dictionary"
                                width: parent.width
                                spacing: Style.space(10)
                                Row {
                                    width: parent.width
                                    spacing: Style.space(8)
                                    TextField {
                                        id: dictFrom
                                        width: (parent.width - categoryChip.width - addRule.width - parent.spacing * 3) * 0.5
                                        placeholderText: "spoken phrase"
                                        foreground: root.foreground
                                        onActiveFocusChanged: root.noteEditor(dictFrom, activeFocus)
                                        Keys.onReturnPressed: { if (dictTo.text.trim() === "") dictTo.forceActiveFocus(); else root.upsertRule() }
                                        Keys.onEscapePressed: function(event) { keyCatcher.forceActiveFocus(); event.accepted = true }
                                    }
                                    TextField {
                                        id: dictTo
                                        width: dictFrom.width
                                        placeholderText: "→ replacement"
                                        foreground: root.foreground
                                        onActiveFocusChanged: root.noteEditor(dictTo, activeFocus)
                                        Keys.onReturnPressed: root.upsertRule()
                                        Keys.onEscapePressed: function(event) { keyCatcher.forceActiveFocus(); event.accepted = true }
                                    }
                                    Button {
                                        id: categoryChip
                                        anchors.verticalCenter: parent.verticalCenter
                                        text: root.dictCategory
                                        bordered: true
                                        foreground: root.foreground
                                        fontFamily: root.fontFamily
                                        fontSize: Style.font.caption
                                        tooltipText: "Category for the new rule"
                                        onClicked: root.dictCategory = Model.nextCategory(root.dictCategory, root.categories)
                                    }
                                    Button {
                                        id: addRule
                                        anchors.verticalCenter: parent.verticalCenter
                                        iconText: "＋"
                                        bordered: true
                                        foreground: root.foreground
                                        enabled: dictFrom.text.trim() !== "" && dictTo.text.trim() !== ""
                                        tooltipText: "Add rule"
                                        onClicked: root.upsertRule()
                                    }
                                }
                                TextField {
                                    id: dictSearch
                                    width: parent.width
                                    placeholderText: "Search rules · /"
                                    foreground: root.foreground
                                    hasCursor: root.cursorIs("search")
                                    onHoveredChanged: if (hovered) root.setCursor("search", -1)
                                    onActiveFocusChanged: root.noteEditor(dictSearch, activeFocus)
                                    onTextChanged: { root.cursorIndex = 0; body.contentY = 0 }
                                    Keys.onReturnPressed: { keyCatcher.forceActiveFocus(); root.setCursor("rows", 0) }
                                    Keys.onEscapePressed: function(event) { if (text !== "") text = ""; else keyCatcher.forceActiveFocus(); event.accepted = true }
                                    Keys.onDownPressed: function(event) { keyCatcher.forceActiveFocus(); root.setCursor("rows", 0); event.accepted = true }
                                }
                                Repeater {
                                    model: root.filteredReplacements
                                    delegate: CursorSurface {
                                        id: ruleRow
                                        required property var modelData
                                        required property int index
                                        width: sections.width
                                        implicitHeight: Style.space(44)
                                        hasCursor: root.rowHasCursor(index)
                                        foreground: root.foreground
                                        onHasCursorChanged: if (hasCursor) root.ensureVisible(ruleRow)
                                        MouseArea { anchors.fill: parent; hoverEnabled: true; onEntered: root.setCursor("rows", ruleRow.index); onClicked: root.cycleRuleCategory() }
                                        Row {
                                            anchors.left: parent.left; anchors.right: ruleActions.left; anchors.verticalCenter: parent.verticalCenter
                                            anchors.leftMargin: Style.space(12); anchors.rightMargin: Style.space(8)
                                            spacing: Style.space(8)
                                            Text {
                                                width: Math.min(implicitWidth, parent.width * 0.45)
                                                text: Model.sanitize(ruleRow.modelData.from, 120); textFormat: Text.PlainText; elide: Text.ElideRight
                                                color: root.foreground; font.family: root.fontFamily; font.pixelSize: Style.font.body
                                                anchors.verticalCenter: parent.verticalCenter
                                            }
                                            Text { textFormat: Text.PlainText; text: "→"; color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.body; anchors.verticalCenter: parent.verticalCenter }
                                            Text {
                                                width: Math.min(implicitWidth, parent.width * 0.45)
                                                text: Model.sanitize(ruleRow.modelData.to, 120); textFormat: Text.PlainText; elide: Text.ElideRight
                                                color: Color.accent; font.family: root.fontFamily; font.pixelSize: Style.font.body; font.bold: true
                                                anchors.verticalCenter: parent.verticalCenter
                                            }
                                        }
                                        Row {
                                            id: ruleActions
                                            anchors.right: parent.right; anchors.rightMargin: Style.space(8); anchors.verticalCenter: parent.verticalCenter
                                            spacing: Style.space(6)
                                            Text {
                                                anchors.verticalCenter: parent.verticalCenter
                                                text: String(ruleRow.modelData.category || "").toUpperCase(); textFormat: Text.PlainText
                                                color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.caption; font.bold: true; font.letterSpacing: 1
                                            }
                                            PanelActionButton { visible: ruleRow.hasCursor; iconText: "󰑖"; foreground: root.foreground; tooltipText: "c · cycle category"; enabled: !service.mutating; onClicked: { root.setCursor("rows", ruleRow.index); root.cycleRuleCategory() } }
                                            PanelActionButton { visible: ruleRow.hasCursor; iconText: "󰆴"; foreground: root.foreground; hoverColor: root.urgent; tooltipText: "x · delete rule"; enabled: !service.mutating; onClicked: { root.setCursor("rows", ruleRow.index); root.deleteSelected() } }
                                        }
                                    }
                                }
                                EmptyState {
                                    visible: root.filteredReplacements.length === 0
                                    glyph: "󰬴"
                                    title: !root.loaded ? (service.busy ? "Loading rules…" : "Rules unavailable") : (dictSearch.text !== "" ? "No matching rules" : "No dictionary rules yet")
                                    hint: "Rules rewrite what you said before it is typed:\n“slash release” → “/release”."
                                }
                            }

                            // ================= 4 · Settings =================
                            Column {
                                id: settingsForm
                                visible: root.section === "settings"
                                width: parent.width
                                spacing: Style.space(10)
                                function controlFor(key) {
                                    var stack = [settingsForm];
                                    while (stack.length) {
                                        var item = stack.pop();
                                        if (item && item.settingKey === key) return item;
                                        var kids = item && item.children ? item.children : [];
                                        for (var i = 0; i < kids.length; i++) stack.push(kids[i]);
                                    }
                                    return null;
                                }

                                PanelSectionHeader { text: "ENGINE & MODEL"; foreground: root.foreground; fontFamily: root.fontFamily }
                                Row {
                                    width: parent.width
                                    spacing: Style.space(10)
                                    SettingDropdown { settingKey: "engine"; label: "Engine"; width: (parent.width - parent.spacing) / 2; fallback: "whisper"
                                        options: Model.plainOptions(root.options ? root.options.engines : [root.engine]) }
                                    SettingDropdown { settingKey: root.modelPath; label: "Model"; width: (parent.width - parent.spacing) / 2; fallback: root.status && root.status.model ? root.status.model.name : ""
                                        options: Model.modelOptions(root.modelsEngine === root.engine ? root.modelRows : [], String(Model.settingValue(root.config, root.modelPath, ""))) }
                                }
                                SettingText { settingKey: "whisper.language"; label: "Language"; placeholderText: "auto"; visible: root.engine === "whisper" }

                                PanelSeparator { width: parent.width; foreground: root.foreground }
                                PanelSectionHeader { text: "HOTKEY"; foreground: root.foreground; fontFamily: root.fontFamily }
                                Row {
                                    width: parent.width
                                    spacing: Style.space(10)
                                    SettingText { settingKey: "hotkey.key"; label: "Key (evdev name)"; placeholderText: "SCROLLLOCK"; width: (parent.width - parent.spacing) / 2 }
                                    SettingDropdown { settingKey: "hotkey.mode"; label: "Mode"; width: (parent.width - parent.spacing) / 2; fallback: "push_to_talk"
                                        options: Model.plainOptions(root.options ? root.options.hotkey_modes : ["push_to_talk", "toggle"]) }
                                }
                                Row {
                                    spacing: Style.space(6)
                                    Repeater {
                                        model: root.options ? root.options.hotkey_modifiers : ["LEFTCTRL", "LEFTALT", "LEFTSHIFT", "LEFTMETA"]
                                        delegate: Button {
                                            required property var modelData
                                            readonly property string settingKey: "hotkey.mod." + modelData
                                            text: Model.modifierLabel(modelData)
                                            bordered: true
                                            selected: Model.settingValue(root.config, "hotkey.modifiers", []).indexOf(modelData) >= 0
                                            hasCursor: root.cursorIs(settingKey)
                                            foreground: root.foreground
                                            fontFamily: root.fontFamily
                                            fontSize: Style.font.bodySmall
                                            onHovered: function(h) { if (h) root.setCursor(settingKey, -1) }
                                            onHasCursorChanged: if (hasCursor) root.ensureVisible(this)
                                            onClicked: root.toggleModifier(modelData)
                                        }
                                    }
                                    Text {
                                        anchors.verticalCenter: parent.verticalCenter
                                        textFormat: Text.PlainText; visible: !Model.settingIsSet(root.config, "hotkey.modifiers"); text: "default"
                                        color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.caption
                                    }
                                    ResetButton {
                                        anchors.verticalCenter: parent.verticalCenter
                                        visible: root.cursorActive && root.cursorKey.indexOf("hotkey.mod.") === 0
                                        enabled: Model.settingIsSet(root.config, "hotkey.modifiers") && !service.mutating
                                        settingKey: "hotkey.modifiers"
                                    }
                                }
                                SettingToggle { settingKey: "hotkey.enabled"; label: "Hotkey enabled"; description: "Turn off to drive recording from the panel or `voxtype record` only"; fallback: true }

                                PanelSeparator { width: parent.width; foreground: root.foreground }
                                PanelSectionHeader { text: "AUDIO"; foreground: root.foreground; fontFamily: root.fontFamily }
                                Row {
                                    width: parent.width
                                    spacing: Style.space(10)
                                    SettingDropdown { settingKey: "audio.device"; label: "Input device"; width: parent.width - maxDuration.width - parent.spacing; fallback: "default"
                                        options: Model.labelled(root.options ? root.options.audio_devices : [{label: "default", name: "default"}]) }
                                    SettingNumber { id: maxDuration; settingKey: "audio.max_duration_secs"; label: "Max seconds"; from: 5; to: 3600; stepSize: 5; fallback: 60 }
                                }
                                SettingToggle { settingKey: "audio.feedback.enabled"; label: "Audio feedback"; description: "Play a sound when recording starts and stops"; fallback: true }
                                Row {
                                    width: parent.width
                                    spacing: Style.space(10)
                                    visible: Model.settingValue(root.config, "audio.feedback.enabled", true) === true
                                    SettingDropdown { settingKey: "audio.feedback.theme"; label: "Feedback theme"; width: (parent.width - parent.spacing) / 2; fallback: "default"
                                        options: Model.plainOptions(root.options ? root.options.feedback_themes : ["default"]) }
                                    SettingSlider { settingKey: "audio.feedback.volume"; label: "Volume"; width: (parent.width - parent.spacing) / 2; fallback: 0.5 }
                                }

                                PanelSeparator { width: parent.width; foreground: root.foreground }
                                PanelSectionHeader { text: "OUTPUT"; foreground: root.foreground; fontFamily: root.fontFamily }
                                Row {
                                    width: parent.width
                                    spacing: Style.space(10)
                                    SettingDropdown { settingKey: "output.mode"; label: "Mode"; width: parent.width - typeDelay.width - parent.spacing; fallback: "type"
                                        options: Model.plainOptions(root.options ? root.options.output_modes : ["type", "clipboard", "paste"]) }
                                    SettingNumber { id: typeDelay; settingKey: "output.type_delay_ms"; label: "Type delay (ms)"; from: 0; to: 500; stepSize: 5; fallback: 0 }
                                }
                                SettingToggle { settingKey: "output.fallback_to_clipboard"; label: "Fall back to clipboard"; description: "When typing into the focused window is not possible"; fallback: true }
                                SettingToggle { settingKey: "output.auto_submit"; label: "Auto-submit"; description: "Press Enter after the text is typed"; fallback: false }
                                SettingToggle { settingKey: "text.smart_auto_submit"; label: "Smart auto-submit"; description: "Only submit when the phrase sounds like a command"; fallback: false }
                                SettingToggle { settingKey: "text.spoken_punctuation"; label: "Spoken punctuation"; description: "“comma”, “period”, “new line” become punctuation"; fallback: false }

                                PanelSeparator { width: parent.width; foreground: root.foreground }
                                PanelSectionHeader { text: "VOICE ACTIVITY"; foreground: root.foreground; fontFamily: root.fontFamily }
                                SettingToggle { settingKey: "vad.enabled"; label: "Voice activity detection"; description: "Trim silence before transcribing"; fallback: false }
                                Row {
                                    width: parent.width
                                    spacing: Style.space(10)
                                    visible: Model.settingValue(root.config, "vad.enabled", false) === true
                                    SettingSlider { settingKey: "vad.threshold"; label: "Threshold"; width: (parent.width - parent.spacing) / 2; fallback: 0.5 }
                                    SettingText { settingKey: "vad.model"; label: "VAD model path"; placeholderText: "bundled"; width: (parent.width - parent.spacing) / 2 }
                                }

                                PanelSeparator { width: parent.width; foreground: root.foreground }
                                PanelSectionHeader { text: "POST-PROCESSING"; foreground: root.foreground; fontFamily: root.fontFamily }
                                Row {
                                    width: parent.width
                                    spacing: Style.space(10)
                                    SettingText { settingKey: "output.post_process.command"; label: "Command"; placeholderText: "none"; width: parent.width - ppTimeout.width - parent.spacing }
                                    SettingNumber { id: ppTimeout; settingKey: "output.post_process.timeout_ms"; label: "Timeout (ms)"; from: 100; to: 60000; stepSize: 100; fallback: 5000 }
                                }

                                PanelSeparator { width: parent.width; foreground: root.foreground; visible: root.engine === "whisper" }
                                PanelSectionHeader { text: "REMOTE WHISPER"; foreground: root.foreground; fontFamily: root.fontFamily; visible: root.engine === "whisper" }
                                SettingText { settingKey: "whisper.remote_endpoint"; label: "Endpoint"; placeholderText: "https://…/v1/audio/transcriptions"; visible: root.engine === "whisper" }
                                Row {
                                    width: parent.width
                                    spacing: Style.space(10)
                                    visible: root.engine === "whisper"
                                    SettingText { settingKey: "whisper.remote_model"; label: "Remote model"; placeholderText: "whisper-1"; width: parent.width - remoteTimeout.width - parent.spacing }
                                    SettingNumber { id: remoteTimeout; settingKey: "whisper.remote_timeout_secs"; label: "Timeout (s)"; from: 1; to: 600; stepSize: 1; fallback: 30 }
                                }
                                Row {
                                    width: parent.width
                                    spacing: Style.space(10)
                                    visible: root.engine === "whisper"
                                    Text {
                                        width: parent.width - clearKey.width - parent.spacing
                                        anchors.verticalCenter: parent.verticalCenter
                                        textFormat: Text.PlainText; wrapMode: Text.WordWrap
                                        text: Model.settingValue(root.config, "whisper.remote_api_key_set", false) === true ? "󰌾  API key is set" : "No API key stored · set VOXTYPE_WHISPER_API_KEY in the daemon environment or config; the panel never asks for it"
                                        color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.caption
                                    }
                                    Button {
                                        id: clearKey
                                        readonly property string settingKey: "remote.clear"
                                        anchors.verticalCenter: parent.verticalCenter
                                        text: "Clear key"; bordered: true
                                        visible: Model.settingValue(root.config, "whisper.remote_api_key_set", false) === true
                                        hasCursor: root.cursorIs("remote.clear")
                                        foreground: root.foreground; fontFamily: root.fontFamily; fontSize: Style.font.bodySmall
                                        onHovered: function(h) { if (h) root.setCursor("remote.clear", -1) }
                                        onHasCursorChanged: if (hasCursor) root.ensureVisible(clearKey)
                                        onClicked: root.unsetSetting("whisper.remote_api_key")
                                    }
                                }

                                PanelSeparator { width: parent.width; foreground: root.foreground }
                                PanelSectionHeader { text: "GPU"; foreground: root.foreground; fontFamily: root.fontFamily }
                                Text {
                                    width: parent.width; textFormat: Text.PlainText; wrapMode: Text.WordWrap
                                    text: Model.gpuLines(root.gpu).join("\n")
                                    color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.caption
                                }
                                Row {
                                    width: parent.width
                                    spacing: Style.space(10)
                                    Dropdown {
                                        id: gpuDevice
                                        readonly property string settingKey: "gpu.device"
                                        function activate() { open() }
                                        width: parent.width - gpuButtons.width - parent.spacing
                                        label: "Device for the systemd drop-in"
                                        value: root.gpu ? String(root.gpu.device || "auto") : "auto"
                                        options: Model.labelled(root.options ? root.options.gpu_vendors : [{label: "Auto (first available)", value: "auto"}])
                                        foreground: root.foreground; fontFamily: root.fontFamily
                                        hasCursor: root.cursorIs("gpu.device")
                                        onHovered: function(h) { if (h) root.setCursor("gpu.device", -1) }
                                        onHasCursorChanged: if (hasCursor) root.ensureVisible(gpuDevice)
                                        onPopupOpenChanged: root.notePopup(popupOpen)
                                        onChanged: function(v) { if (!root.locked) service.run({op: "gpu.set_device", vendor: v}) }
                                    }
                                    Column {
                                        id: gpuButtons
                                        spacing: Style.space(4)
                                        anchors.bottom: parent.bottom
                                        Button {
                                            readonly property string settingKey: "gpu.enable"
                                            text: "Enable acceleration"; iconText: "󰢮"; bordered: true; width: Style.space(170)
                                            hasCursor: root.cursorIs("gpu.enable")
                                            foreground: root.foreground; fontFamily: root.fontFamily; fontSize: Style.font.bodySmall
                                            enabled: root.terminalAvailable
                                            tooltipText: root.terminalAvailable ? "Opens a terminal running sudo voxtype setup gpu --enable" : Model.ERROR_TERMINAL_MISSING
                                            onHovered: function(h) { if (h) root.setCursor("gpu.enable", -1) }
                                            onHasCursorChanged: if (hasCursor) root.ensureVisible(gpuButtons)
                                            onClicked: root.launchGpu(true)
                                        }
                                        Button {
                                            readonly property string settingKey: "gpu.disable"
                                            text: "Disable (CPU)"; iconText: "󰘚"; bordered: true; width: Style.space(170)
                                            hasCursor: root.cursorIs("gpu.disable")
                                            foreground: root.foreground; fontFamily: root.fontFamily; fontSize: Style.font.bodySmall
                                            enabled: root.terminalAvailable
                                            tooltipText: root.terminalAvailable ? "Opens a terminal running sudo voxtype setup gpu --disable" : Model.ERROR_TERMINAL_MISSING
                                            onHovered: function(h) { if (h) root.setCursor("gpu.disable", -1) }
                                            onHasCursorChanged: if (hasCursor) root.ensureVisible(gpuButtons)
                                            onClicked: root.launchGpu(false)
                                        }
                                    }
                                }
                                Item { width: 1; height: Style.space(4) }
                            }

                            // ================= 5 · Models =================
                            Column {
                                visible: root.section === "models"
                                width: parent.width
                                spacing: Style.space(10)
                                Row {
                                    width: parent.width
                                    spacing: Style.space(10)
                                    Dropdown {
                                        id: engineDropdown
                                        width: Style.spacing.dropdownWidth
                                        label: "Engine"
                                        value: root.engine
                                        options: Model.plainOptions(root.options ? root.options.engines : [root.engine])
                                        foreground: root.foreground; fontFamily: root.fontFamily
                                        hasCursor: root.cursorIs("engine")
                                        onHovered: function(h) { if (h) root.setCursor("engine", -1) }
                                        onHasCursorChanged: if (hasCursor) root.ensureVisible(engineDropdown)
                                        onPopupOpenChanged: root.notePopup(popupOpen)
                                        onChanged: function(v) { root.setSetting("engine", v) }
                                    }
                                    Text {
                                        anchors.bottom: parent.bottom; anchors.bottomMargin: Style.space(8)
                                        textFormat: Text.PlainText
                                        text: root.options && root.options.compiled_engines && root.options.compiled_engines.indexOf(root.engine) < 0 ? "󰀦 not compiled into this voxtype build" : (root.modelsLoading ? "" : root.modelRows.length + " models in catalog")
                                        color: root.options && root.options.compiled_engines && root.options.compiled_engines.indexOf(root.engine) < 0 ? root.urgent : root.muted
                                        font.family: root.fontFamily; font.pixelSize: Style.font.caption
                                    }
                                }

                                CursorSurface {
                                    visible: service.downloading
                                    width: parent.width
                                    bordered: true
                                    foreground: root.foreground
                                    implicitHeight: downloadColumn.implicitHeight + Style.space(24)
                                    Column {
                                        id: downloadColumn
                                        anchors.left: parent.left; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
                                        anchors.margins: Style.space(12)
                                        spacing: Style.space(8)
                                        Row {
                                            width: parent.width
                                            Text {
                                                width: parent.width - cancelDownload.width
                                                anchors.verticalCenter: parent.verticalCenter
                                                textFormat: Text.PlainText; elide: Text.ElideRight
                                                text: "Downloading " + service.downloadName + " · " + Math.round(service.downloadProgress) + "%"
                                                color: root.foreground; font.family: root.fontFamily; font.pixelSize: Style.font.body; font.bold: true
                                            }
                                            Button { id: cancelDownload; text: "Cancel"; bordered: true; foreground: root.foreground; fontFamily: root.fontFamily; fontSize: Style.font.bodySmall; onClicked: service.cancelDownload() }
                                        }
                                        Rectangle {
                                            width: parent.width; height: Math.max(Style.space(4), Style.spacing.sm); radius: height / 2
                                            color: Style.selectedFillFor(root.foreground, Color.accent)
                                            Rectangle { width: parent.width * service.downloadProgress / 100; height: parent.height; radius: parent.radius; color: Color.accent
                                                Behavior on width { NumberAnimation { duration: 160 } } }
                                        }
                                        Text {
                                            width: parent.width; textFormat: Text.PlainText; wrapMode: Text.WrapAnywhere
                                            visible: service.downloadLog.length > 0
                                            text: service.downloadLog.slice(-3).join("\n")
                                            color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.caption
                                        }
                                    }
                                }

                                Repeater {
                                    model: root.modelsEngine === root.engine ? root.modelRows : []
                                    delegate: CursorSurface {
                                        id: modelRow
                                        required property var modelData
                                        required property int index
                                        width: sections.width
                                        implicitHeight: Style.space(46)
                                        hasCursor: root.rowHasCursor(index)
                                        current: modelData.active === true
                                        foreground: root.foreground
                                        onHasCursorChanged: if (hasCursor) root.ensureVisible(modelRow)
                                        MouseArea { anchors.fill: parent; hoverEnabled: true; onEntered: root.setCursor("rows", modelRow.index); onClicked: root.setActiveModel(modelRow.modelData) }
                                        Column {
                                            anchors.left: parent.left; anchors.right: modelActions.left; anchors.verticalCenter: parent.verticalCenter
                                            anchors.leftMargin: Style.space(12); anchors.rightMargin: Style.space(8)
                                            spacing: Style.space(2)
                                            Text { width: parent.width; text: Model.sanitize(modelRow.modelData.name, 120); textFormat: Text.PlainText; elide: Text.ElideRight
                                                color: modelRow.modelData.downloaded ? root.foreground : root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.subtitle; font.bold: modelRow.modelData.active === true }
                                            Text { width: parent.width; text: Model.modelLine(modelRow.modelData); textFormat: Text.PlainText; elide: Text.ElideRight
                                                color: modelRow.modelData.active ? Color.accent : root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.caption }
                                        }
                                        Row {
                                            id: modelActions
                                            anchors.right: parent.right; anchors.rightMargin: Style.space(8); anchors.verticalCenter: parent.verticalCenter
                                            spacing: Style.space(4)
                                            opacity: modelRow.hasCursor ? 1 : 0
                                            enabled: modelRow.hasCursor && !service.mutating
                                            PanelActionButton { visible: modelRow.modelData.downloaded && !modelRow.modelData.active; iconText: "󰄬"; foreground: root.foreground; tooltipText: "Enter · set active"; onClicked: root.setActiveModel(modelRow.modelData) }
                                            PanelActionButton { visible: !modelRow.modelData.downloaded; iconText: "󰇚"; foreground: root.foreground; tooltipText: "d · download"; enabled: !service.downloading; onClicked: root.startDownload(modelRow.modelData) }
                                            PanelActionButton { visible: modelRow.modelData.downloaded && !modelRow.modelData.active; iconText: "󰆴"; foreground: root.foreground; hoverColor: root.urgent; tooltipText: "x · delete from disk"; onClicked: { root.setCursor("rows", modelRow.index); root.deleteSelected() } }
                                        }
                                    }
                                }
                                EmptyState {
                                    visible: root.modelsEngine !== root.engine || root.modelRows.length === 0
                                    glyph: root.modelsLoading ? "󰔟" : "󰆼"
                                    title: root.modelsLoading ? "Reading the model catalog…" : "No models known for " + root.engine
                                    hint: root.modelsLoading ? "" : "Models live under the voxtype data directory."
                                }

                                PanelSeparator { width: parent.width; foreground: root.foreground }
                                PanelSectionHeader { text: "BACKUP"; foreground: root.foreground; fontFamily: root.fontFamily }
                                Row {
                                    id: backupRow
                                    spacing: Style.space(8)
                                    Button {
                                        text: "Export…"; iconText: "󰈝"; bordered: true; selected: root.exportOpen
                                        hasCursor: root.cursorIs("export")
                                        foreground: root.foreground; fontFamily: root.fontFamily
                                        onHovered: function(h) { if (h) root.setCursor("export", -1) }
                                        onHasCursorChanged: if (hasCursor) root.ensureVisible(backupRow)
                                        onClicked: root.toggleExport()
                                    }
                                    Button {
                                        text: "Import…"; iconText: "󰈞"; bordered: true
                                        hasCursor: root.cursorIs("import")
                                        enabled: !service.picking && root.pickerAvailable
                                        foreground: root.foreground; fontFamily: root.fontFamily
                                        tooltipText: root.pickerAvailable ? "Choose a voxtype-tui bundle; changes are previewed before anything is written" : Model.ERROR_PICKER_MISSING
                                        onHovered: function(h) { if (h) root.setCursor("import", -1) }
                                        onHasCursorChanged: if (hasCursor) root.ensureVisible(backupRow)
                                        onClicked: root.beginImport()
                                    }
                                }
                                Column {
                                    id: exportForm
                                    visible: root.exportOpen
                                    width: parent.width
                                    spacing: Style.space(8)
                                    ButtonGroup {
                                        options: [{value: "sync", label: "Vocabulary + rules + settings"}, {value: "sync+local", label: "Also local paths"}]
                                        value: root.exportScope
                                        focusable: false
                                        foreground: root.foreground; fontFamily: root.fontFamily; fontSize: Style.font.bodySmall
                                        onChanged: function(v) { root.exportScope = v; root.refreshExportPreview() }
                                    }
                                    Toggle {
                                        width: parent.width
                                        label: "Include secrets"
                                        description: "Writes the remote API key into the file. Off by default."
                                        checked: root.exportSecrets
                                        foreground: root.foreground; fontFamily: root.fontFamily
                                        onClicked: { root.exportSecrets = !root.exportSecrets; root.refreshExportPreview() }
                                    }
                                    Row {
                                        width: parent.width
                                        spacing: Style.space(8)
                                        TextField {
                                            id: exportPath
                                            width: parent.width - exportButton.width - parent.spacing
                                            placeholderText: "Export path"
                                            foreground: root.foreground
                                            onActiveFocusChanged: root.noteEditor(exportPath, activeFocus)
                                            Keys.onReturnPressed: root.writeExport()
                                            Keys.onEscapePressed: function(event) { keyCatcher.forceActiveFocus(); event.accepted = true }
                                        }
                                        Button { id: exportButton; text: "Write"; bordered: true; foreground: root.foreground; fontFamily: root.fontFamily; enabled: exportPath.text.trim() !== "" && !service.mutating; onClicked: root.writeExport() }
                                    }
                                    Text {
                                        width: parent.width; textFormat: Text.PlainText; wrapMode: Text.WordWrap
                                        text: root.exportPreview && root.exportPreview.counts ? "Contains " + root.exportPreview.counts.vocabulary + " words · " + root.exportPreview.counts.replacements + " rules · " + root.exportPreview.counts.settings + " settings" + (root.exportPreview.counts.secrets ? " · " + root.exportPreview.counts.secrets + " secret" : "") : "…"
                                        color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.caption
                                    }
                                }
                                CursorSurface {
                                    id: importCard
                                    visible: root.importPreview !== null
                                    width: parent.width
                                    bordered: true
                                    foreground: root.foreground
                                    implicitHeight: importColumn.implicitHeight + Style.space(24)
                                    Column {
                                        id: importColumn
                                        anchors.left: parent.left; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
                                        anchors.margins: Style.space(12)
                                        spacing: Style.space(6)
                                        Text { width: parent.width; textFormat: Text.PlainText; elide: Text.ElideMiddle; text: root.importPath.split("/").pop() + (root.importPreview ? "  ·  " + String(root.importPreview.format || "") : ""); color: root.foreground; font.family: root.fontFamily; font.pixelSize: Style.font.body; font.bold: true }
                                        Text { width: parent.width; textFormat: Text.PlainText; wrapMode: Text.WordWrap; text: root.importPreview ? Model.diffSummary(root.importPreview.diff) : ""; color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.caption }
                                        // Every settings row, not just the
                                        // dangerous ones: the panel must not
                                        // show less than the TUI it fronts.
                                        // Dangerous rows keep the warning
                                        // glyph and the urgent colour.
                                        Repeater {
                                            model: root.importPreview ? Model.settingsRows(root.importPreview.diff, Model.IMPORT_CARD_ROWS) : []
                                            delegate: Text {
                                                required property var modelData
                                                width: importColumn.width; textFormat: Text.PlainText; wrapMode: Text.WrapAnywhere
                                                text: (modelData.dangerous ? "󰀦 " : (modelData.overflow ? "" : "· ")) + modelData.text
                                                color: modelData.dangerous ? root.urgent : root.muted
                                                font.family: root.fontFamily; font.pixelSize: Style.font.caption
                                                font.italic: modelData.overflow
                                            }
                                        }
                                        Repeater {
                                            model: root.importPreview ? (root.importPreview.warnings || []) : []
                                            delegate: Text {
                                                required property var modelData
                                                width: importColumn.width; textFormat: Text.PlainText; wrapMode: Text.WordWrap
                                                text: "• " + Model.sanitize(modelData, 120)
                                                color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.caption
                                            }
                                        }
                                        Toggle {
                                            id: includeSettingsToggle
                                            width: parent.width
                                            label: "Include settings"
                                            description: "Off by default: the bundle's vocabulary and rules are imported without overwriting your engine, model and other settings."
                                            checked: root.importSettings
                                            foreground: root.foreground; fontFamily: root.fontFamily
                                            titleSize: Style.font.body
                                            enabled: !service.mutating
                                            onClicked: root.setImportSettings(!root.importSettings)
                                        }
                                        Row {
                                            spacing: Style.space(8)
                                            Button { text: "Apply…"; bordered: true; foreground: root.foreground; fontFamily: root.fontFamily; fontSize: Style.font.bodySmall; enabled: !service.mutating; onClicked: root.askImport() }
                                            Button { text: "Discard"; bordered: true; foreground: root.foreground; fontFamily: root.fontFamily; fontSize: Style.font.bodySmall; onClicked: root.importPreview = null }
                                        }
                                    }
                                }
                                Item { width: 1; height: Style.space(4) }
                            }
                        }
                    }

                    Item {
                        id: footer
                        width: parent.width
                        height: Style.space(30)
                        readonly property var notice: Model.footerNotice({
                            error: root.errorText,
                            busyText: service.picking ? "Choosing a bundle…" : (service.restarting ? "Restarting daemon…" : ""),
                            notice: root.notice,
                            restartNeeded: root.stale,
                            idleText: root.locked ? "" : (root.status ? (root.status.daemon && root.status.daemon.active ? "Daemon running" : "Daemon stopped") : "")
                        })
                        Text {
                            anchors.left: parent.left; anchors.right: hints.left; anchors.rightMargin: Style.space(12); anchors.verticalCenter: parent.verticalCenter
                            text: footer.notice.text; textFormat: Text.PlainText; elide: Text.ElideRight
                            color: footer.notice.urgent ? root.urgent : root.muted
                            font.family: root.fontFamily; font.pixelSize: Style.font.caption
                        }
                        Text {
                            id: hints
                            anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
                            textFormat: Text.PlainText
                            text: root.locked ? (root.canInstallLocked ? "Enter install   y copy   Esc close" : (root.lockedCommand !== "" ? "Enter copy   Esc close" : "Esc close")) : Model.sectionHints(root.section, {editing: root.editing, cursorActive: root.cursorActive})
                            color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.caption
                        }
                    }
                }
            }
            ConfirmDialog {
                id: confirmation
                anchors.fill: parent
                z: 10
                selectedIndex: 0
                foreground: root.foreground
                fontFamily: root.fontFamily
                onCanceled: { opened = false; root.confirmAction = ""; root.confirmPayload = null; root.importAcceptDangerous = false; keyCatcher.forceActiveFocus() }
                onConfirmed: { opened = false; root.applyConfirmed(); keyCatcher.forceActiveFocus() }
            }
        }
    }

    // ---- reusable pieces -----------------------------------------------------
    component StatusCell: Column {
        id: cell
        property string label: ""
        property string value: ""
        property bool accent: false
        spacing: Style.space(2)
        Text { textFormat: Text.PlainText; text: cell.label; color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.caption; font.bold: true; font.letterSpacing: 1 }
        Text { width: parent.width; text: cell.value; textFormat: Text.PlainText; elide: Text.ElideRight; color: cell.accent ? Color.accent : root.foreground; font.family: root.fontFamily; font.pixelSize: Style.font.subtitle }
    }
    component EmptyState: Column {
        id: empty
        property string glyph: ""
        property string title: ""
        property string hint: ""
        width: parent ? parent.width : implicitWidth
        spacing: Style.space(10)
        topPadding: Style.space(24)
        Text { anchors.horizontalCenter: parent.horizontalCenter; textFormat: Text.PlainText; text: empty.glyph; color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.space(32) }
        Text { width: parent.width; horizontalAlignment: Text.AlignHCenter; textFormat: Text.PlainText; wrapMode: Text.WordWrap; text: empty.title; color: root.foreground; font.family: root.fontFamily; font.pixelSize: Style.font.subtitle }
        Text { width: parent.width; horizontalAlignment: Text.AlignHCenter; textFormat: Text.PlainText; wrapMode: Text.WordWrap; text: empty.hint; color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.body }
    }
    // Label row above a settings control: label, a "default" tag when the key
    // is absent from the snapshot, and a reset action on the cursor row.
    component SettingLabel: Item {
        id: labelRow
        required property string settingKey
        property string label: ""
        property bool hasCursor: false
        property bool isSet: false
        width: parent ? parent.width : implicitWidth
        height: Math.max(labelText.implicitHeight, resetButton.implicitHeight)
        Text {
            id: labelText
            anchors.left: parent.left; anchors.verticalCenter: parent.verticalCenter
            textFormat: Text.PlainText; text: labelRow.label
            // A set key reads at full strength, a default one is muted. Both
            // are theme tokens: Qt.darker() here inverted the hierarchy on a
            // light theme and ignored the theme's own muted colour.
            color: labelRow.isSet ? root.foreground : root.muted
            font.family: root.fontFamily; font.pixelSize: Style.font.caption; font.bold: true
        }
        Text {
            anchors.left: labelText.right; anchors.leftMargin: Style.space(6); anchors.verticalCenter: parent.verticalCenter
            textFormat: Text.PlainText; visible: !labelRow.isSet; text: "default"
            color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.caption
        }
        ResetButton { id: resetButton; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter; visible: labelRow.hasCursor; enabled: labelRow.isSet; settingKey: labelRow.settingKey }
    }
    component ResetButton: PanelActionButton {
        required property string settingKey
        iconText: "󰕌"
        size: Style.space(18)
        fontSize: Style.font.caption
        foreground: root.foreground
        fontFamily: root.fontFamily
        tooltipText: enabled ? "u · reset to default" : "Using the default"
        onClicked: root.unsetSetting(settingKey)
    }
    component SettingToggle: Toggle {
        id: toggleRow
        required property string settingKey
        property bool fallback: false
        readonly property bool isSet: Model.settingIsSet(root.config, settingKey)
        function activate() { clicked() }
        width: parent ? parent.width : implicitWidth
        checked: Model.settingValue(root.config, settingKey, fallback) === true
        hasCursor: root.cursorIs(settingKey)
        foreground: root.foreground
        fontFamily: root.fontFamily
        titleSize: Style.font.body
        onHovered: function(h) { if (h) root.setCursor(settingKey, -1) }
        onHasCursorChanged: if (hasCursor) root.ensureVisible(toggleRow)
        onClicked: root.setSetting(settingKey, !checked)
        // Toggle draws its own label; the reset sits left of the switch. The
        // hidden probe reports the switch width without hard-coding it.
        ToggleSwitch { id: switchProbe; visible: false; interactive: false }
        Row {
            anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
            anchors.rightMargin: toggleRow.borderRight + Style.spacing.rowPaddingX * 2 + switchProbe.implicitWidth
            spacing: Style.space(6)
            Text {
                anchors.verticalCenter: parent.verticalCenter
                textFormat: Text.PlainText; visible: !toggleRow.isSet; text: "default"
                color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.caption
            }
            ResetButton { anchors.verticalCenter: parent.verticalCenter; visible: toggleRow.hasCursor; enabled: toggleRow.isSet && !service.mutating; settingKey: toggleRow.settingKey }
        }
    }
    component SettingDropdown: Column {
        id: dropdownRow
        required property string settingKey
        property string label: ""
        property string fallback: ""
        property var options: []
        readonly property bool isSet: Model.settingIsSet(root.config, settingKey)
        function activate() { dropdown.open() }
        spacing: Style.spacing.labelGap
        SettingLabel { settingKey: dropdownRow.settingKey; label: dropdownRow.label; hasCursor: root.cursorIs(dropdownRow.settingKey); isSet: dropdownRow.isSet }
        Dropdown {
            id: dropdown
            width: parent.width
            showLabel: false
            value: String(Model.settingValue(root.config, dropdownRow.settingKey, dropdownRow.fallback))
            options: dropdownRow.options
            foreground: root.foreground
            fontFamily: root.fontFamily
            hasCursor: root.cursorIs(dropdownRow.settingKey)
            onHovered: function(h) { if (h) root.setCursor(dropdownRow.settingKey, -1) }
            onHasCursorChanged: if (hasCursor) root.ensureVisible(dropdownRow)
            onPopupOpenChanged: root.notePopup(popupOpen)
            onChanged: function(v) { root.setSetting(dropdownRow.settingKey, v) }
        }
    }
    component SettingNumber: Column {
        id: numberRow
        required property string settingKey
        property string label: ""
        property int fallback: 0
        property int from: 0
        property int to: 100
        property int stepSize: 1
        readonly property bool isSet: Model.settingIsSet(root.config, settingKey)
        function activate() { number.field.forceActiveFocus() }
        width: Math.max(number.implicitWidth, Style.space(150))
        spacing: Style.spacing.labelGap
        SettingLabel { settingKey: numberRow.settingKey; label: numberRow.label; hasCursor: root.cursorIs(numberRow.settingKey); isSet: numberRow.isSet }
        NumberField {
            id: number
            from: numberRow.from; to: numberRow.to; stepSize: numberRow.stepSize
            value: Number(Model.settingValue(root.config, numberRow.settingKey, numberRow.fallback))
            foreground: root.foreground
            fontFamily: root.fontFamily
            hasCursor: root.cursorIs(numberRow.settingKey)
            onHovered: function(h) { if (h) root.setCursor(numberRow.settingKey, -1) }
            onHasCursorChanged: if (hasCursor) root.ensureVisible(numberRow)
            onModified: function(v) { root.setSetting(numberRow.settingKey, v) }
            Connections {
                target: number.field
                function onActiveFocusChanged() { root.noteEditor(numberRow, number.field.activeFocus) }
            }
        }
    }
    component SettingText: Column {
        id: textRow
        required property string settingKey
        property string label: ""
        property string placeholderText: ""
        readonly property bool isSet: Model.settingIsSet(root.config, settingKey)
        function activate() { input.forceActiveFocus() }
        function sync() { if (!input.activeFocus) input.text = String(Model.settingValue(root.config, settingKey, "")) }
        function commit() {
            var v = input.text.trim();
            if (v === "") root.unsetSetting(settingKey);
            else root.setSetting(settingKey, v);
            keyCatcher.forceActiveFocus();
        }
        width: parent ? parent.width : implicitWidth
        spacing: Style.spacing.labelGap
        Component.onCompleted: sync()
        Connections { target: root; function onConfigChanged() { textRow.sync() } }
        SettingLabel { settingKey: textRow.settingKey; label: textRow.label; hasCursor: root.cursorIs(textRow.settingKey); isSet: textRow.isSet }
        TextField {
            id: input
            width: parent.width
            placeholderText: textRow.placeholderText
            foreground: root.foreground
            hasCursor: root.cursorIs(textRow.settingKey)
            onHoveredChanged: if (hovered) root.setCursor(textRow.settingKey, -1)
            onActiveFocusChanged: { root.noteEditor(textRow, activeFocus); if (!activeFocus) textRow.sync() }
            Keys.onReturnPressed: textRow.commit()
            Keys.onEscapePressed: function(event) { textRow.sync(); keyCatcher.forceActiveFocus(); event.accepted = true }
        }
    }
    component SettingSlider: Column {
        id: sliderRow
        required property string settingKey
        property string label: ""
        property real fallback: 0.5
        readonly property bool isSet: Model.settingIsSet(root.config, settingKey)
        readonly property real current: Number(Model.settingValue(root.config, settingKey, fallback))
        function activate() {}
        spacing: Style.spacing.labelGap
        SettingLabel {
            settingKey: sliderRow.settingKey; label: sliderRow.label + "  " + Math.round(sliderRow.current * 100) + "%"
            hasCursor: root.cursorIs(sliderRow.settingKey); isSet: sliderRow.isSet
        }
        CursorSurface {
            width: parent.width
            implicitHeight: Style.spacing.controlHeight
            hasCursor: root.cursorIs(sliderRow.settingKey)
            foreground: root.foreground
            outline: true
            HoverHandler { onHoveredChanged: if (hovered) root.setCursor(sliderRow.settingKey, -1) }
            PanelSlider {
                bar: root.bar
                anchors.fill: parent
                anchors.leftMargin: Style.space(6); anchors.rightMargin: Style.space(6)
                minimum: 0; maximum: 1; step: 0.05
                value: sliderRow.current
                onReleased: function(v) { root.setSetting(sliderRow.settingKey, Math.round(v * 100) / 100) }
            }
        }
    }
}
