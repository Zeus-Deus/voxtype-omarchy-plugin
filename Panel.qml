import QtQuick
import QtQuick.Controls as Controls
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Model.js" as Model

// One KeyboardPanel: hero, four sections (Home, Words, History, Settings)
// with drill-ins (Home › Usage; Settings › Manage models, All Voxtype
// settings, Backup), key-hint footer. State machine and cursor live here;
// every process lives in Service.qml.
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
    // Engine the Models section shows when it is not the live one yet: picking
    // Qwen3-ASR before any of its models is downloaded lists its catalog so
    // one can be downloaded (the download then makes it active).
    property string browseEngine: ""
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
    // The bridge's token for the exact preview the confirmation was built
    // from (bundle bytes + flags + diff). Set and consumed together with
    // importAcceptDangerous; import.apply refuses anything else.
    property string importReview: ""
    // Set when import.apply found the file changed since its preview; the
    // fresh preview then says so instead of silently replacing the card.
    property bool importChanged: false

    // Cursor / navigation
    property string section: "home"
    property string cursorKey: ""
    property int cursorIndex: -1
    property bool cursorActive: false
    property var focusedEditor: null
    // The field a pending paste belongs to (see requestPaste).
    property var pasteTarget: null
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

    // ---- layout B ----------------------------------------------------------
    // `view` is the drill-in shown inside `section` ("" = the section itself).
    property string view: ""
    // Data for the new sections (voxtype-tui 0.2+; see `caps`).
    property var shortcuts: null
    property var features: null
    property var usage: null
    property var historyList: []
    property var historyNext: null
    // The `before` cursor of the "Load older" request in flight ("" = none):
    // one request per cursor, so a double click cannot append a page twice.
    property string historyMoreCursor: ""
    property bool historyLoaded: false
    property var learnedState: null
    property var everywherePreview: null
    property bool everywhereOpen: false
    // op -> reason, for ops an older voxtype-tui answered with `unavailable`.
    property var unavailable: ({})
    property string wordFilter: "all"
    property string expandedId: ""
    // Fix a word: the dictation, the chosen word span and the stage
    // ("pick" = choosing words, "type" = typing the correction).
    property string fixId: ""
    property int fixStart: -1
    property int fixEnd: -1
    property string fixKind: "sounds_like"
    property string fixStage: ""
    // What the shared file chooser is picking: "bundle" (import) or "dir".
    property string pickKind: ""
    // The Fix card's "should be" field registers itself here while shown.
    property var fixField: null
    property bool historyEnabled: true
    property var historyKeepDays: 30
    // Keep for: ←/→ only preview a value; keepTimer saves the one the user
    // settles on (a shorter one after a confirmation), so cycling past
    // "1 week" on the way to "forever" never prunes anything. The preview is
    // dropped, never saved, once the cursor leaves the row, the page changes,
    // the panel hides or any other confirmation opens (dropKeep).
    property bool keepPending: false
    property var keepPendingDays: null

    readonly property var vocabulary: snapshot.vocabulary || []
    readonly property var replacements: snapshot.replacements || []
    readonly property var config: snapshot.settings || ({})
    readonly property var categories: snapshot.categories || ["Replacement", "Capitalization"]
    readonly property int vocabTokens: snapshot.vocab_tokens || 0
    readonly property int vocabTokenLimit: snapshot.vocab_token_limit || Model.TOKEN_LIMIT
    readonly property string page: view !== "" ? view : section
    readonly property var caps: status && status.capabilities ? status.capabilities : ({})
    readonly property var shortcutInfo: Model.shortcutSummary(shortcuts ? shortcuts.bindings : [], status ? status.hotkey : null)
    readonly property var homeHero: Model.homeState(status, shortcutInfo.primary)
    readonly property var myWords: Model.wordRows(vocabulary, replacements)
    readonly property var learnedWords: Model.learnedRows(learnedState ? learnedState.entries : [])
    // Everything learned.json holds (rejected/promoted tombstones too), so
    // Reset all stays reachable when no visible learned row is left.
    readonly property int learnedTotal: Model.learnedTotal(learnedState)
    readonly property bool learnedGroupShown: (wordFilter === "all" || wordFilter === "learned") && (wordsView.learned.length > 0 || learnedTotal > 0 || wordFilter === "learned")
    readonly property var wordsView: Model.filterWords(myWords, learnedWords, wordFilter, wordsField.text)
    readonly property var historyView: Model.historyRows(historyList, historySearch.text, null)
    readonly property var historyItems: Model.historyItems(historyView)
    readonly property var recentItems: Model.historyItems(Model.historyRows(historyList.slice(0, 3), "", null))
    readonly property var fixRecord: Model.findRecord(historyList, fixId)
    readonly property string fixText: Model.recordText(fixRecord)
    readonly property var fixTokens: Model.fixTokens(fixText)
    // The words the Fix card renders: a window that follows the pick, so a
    // long dictation stays light and every word is still reachable.
    readonly property var fixWindow: Model.fixWindow(fixTokens, fixStart, fixEnd, Model.FIX_SHOWN_MAX)
    readonly property var usageNumbers: Model.usageNumbers(usage, null)
    readonly property var featureAvail: features && features.available ? features.available : ({})
    readonly property var featureReasons: features && features.reasons ? features.reasons : ({})
    readonly property var feat: features && features.features ? features.features : ({})
    readonly property bool archiveOn: !!(feat.archive && feat.archive.enabled)
    readonly property bool learningOn: !(feat.learning && feat.learning.enabled === false)
    readonly property bool usageReady: !!caps.history && usage !== null && usage.enabled !== false
    // The switches are on but voxtype does not call voxtype-tui yet (right
    // after an upgrade). Enter / click on Home's usage card connects it.
    readonly property bool wiringPending: usageReady && Model.pendingWiring(usage.health).length > 0
    readonly property string usageMessage: !caps.history ? "Usage " + Model.NEEDS_TUI_02 + "." : (unavailable["usage.summary"] ? "Usage: " + unavailable["usage.summary"] : (usage && usage.enabled === false ? "Usage counting is off · turn it on in Settings" : "Reading usage…"))
    readonly property int advancedChanged: Model.changedCount(config, Model.ADVANCED_PATHS)
    readonly property var simpleTargets: Model.simpleSettingsTargets({whisper: engine === "whisper", archiveOn: archiveOn, learningOn: learningOn && !!caps.features, everywhereAvailable: !!featureAvail.everywhere})
    readonly property string daemonState: service.daemonState
    readonly property string engine: String(Model.settingValue(config, "engine", status && status.engine ? status.engine : "whisper"))
    readonly property string modelsView: browseEngine !== "" ? browseEngine : engine
    // True until the catalog for the current engine has been read; an engine
    // switch shows a neutral loading state rather than a stale "no models".
    readonly property bool modelsLoading: modelsEngine !== modelsView || !loaded
    readonly property string modelPath: options && options.model_paths && options.model_paths[engine] ? options.model_paths[engine] : engine + ".model"
    // Off is not stale: the next start reads the saved config anyway.
    readonly property bool stale: Model.powerAction(status) !== "on" && ((status && status.daemon && status.daemon.stale) || restartNeeded.length > 0)
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
    readonly property string tooltip: "Voxtype · " + Model.heroMeta(status, tuiMissing ? Model.ERROR_TUI_MISSING : "", shortcutInfo.primary)
    readonly property color foreground: bar ? bar.foreground : Commons.Color.foreground
    readonly property color urgent: bar ? bar.urgent : Commons.Color.urgent
    // Commons/Color.qml ships `muted` from the theme (and a per-bar override
    // wins when a bar supplies one). Qt.darker(foreground) was wrong on a
    // light theme — it made "muted" text HEAVIER than the primary
    // foreground, inverting the hierarchy — and it ignored user overrides.
    readonly property color muted: bar && bar.muted ? bar.muted : Commons.Color.muted
    readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
    readonly property int pollIntervalMs: Math.max(1, Math.min(10, setting("pollIntervalSec", 2))) * 1000
    readonly property bool editing: focusedEditor !== null
    readonly property bool keysBlocked: editing || confirmation.opened || openPopups > 0
    readonly property var sectionOptions: [
        {value: "home", label: "Home"}, {value: "words", label: "Words"},
        {value: "history", label: "History"}, {value: "settings", label: "Settings"}
    ]
    // Only the controls that are actually on screen: the predicates live in
    // Model.settingsTargets so Node can pin them against the `visible:`
    // bindings below.
    readonly property var settingsTargets: Model.settingsTargets(config, engine, modelPath)

    function targetsFor(name) {
        if (name === "home") {
            var t = ["record", "power", "restart"];
            if (modelMissing) t.push("download");
            t.push("usage");
            if (recentItems.length > 0) t.push("rows");
            t.push("test");
            return t;
        }
        if (name === "words") return learnedGroupShown && learnedTotal > 0 ? ["search", "filter", "rows", "learn.reset"] : ["search", "filter", "rows"];
        if (name === "history") {
            var h = ["search", "rows"];
            if (historyNext) h.push("more");
            if (historyList.length > 0) h.push("clear");
            return h;
        }
        if (name === "settings") return simpleTargets;
        if (name === "advanced") return settingsTargets;
        if (name === "models") return ["engine", "rows"];
        if (name === "backup") return ["export", "import"];
        return [];
    }
    function rowCount() {
        if (page === "words") return wordsView.rows.length;
        if (page === "history") return historyItems.length;
        if (page === "home") return recentItems.length;
        if (page === "models") return modelRows.length;
        return 0;
    }
    function cursorIs(key) { return cursorActive && cursorKey === key }
    function rowHasCursor(index) { return cursorActive && cursorKey === "rows" && cursorIndex === index }
    function setCursor(key, index) {
        cursorActive = true;
        cursorKey = key;
        cursorIndex = key === "rows" ? index : -1;
    }
    function resetCursor() {
        cursorActive = false;
        cursorKey = "";
        cursorIndex = -1;
    }
    function moveCursor(dy) {
        if (fixStage === "pick") { moveFix(dy); return; }
        var targets = targetsFor(page);
        if (targets.length === 0) {
            // Usage has nothing to select: arrows scroll it.
            body.contentY = Model.wheelContentY(body.contentY, body.contentHeight, body.height, 0, -dy * 120, Style.spacing.popupRowHeight * 3);
            return;
        }
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
        if (fixStage === "pick") { moveFix(dx); return; }
        if (!cursorActive) return;
        if (page === "settings") { cycleSimple(cursorKey, dx); return; }
        if (page === "words" && cursorKey === "filter") { wordFilter = Model.cycleValue(Model.wordFilters(myWords, learnedWords), wordFilter, dx); cursorIndex = -1; return; }
        if (cursorKey === "audio.feedback.volume") nudgeSlider("audio.feedback.volume", dx * 0.05, 0, 1);
        else if (cursorKey === "vad.threshold") nudgeSlider("vad.threshold", dx * 0.05, 0, 1);
        else if (cursorKey === "osd.opacity") nudgeSlider("osd.opacity", dx * 0.05, 0, 1);
    }
    function nudgeSlider(path, delta, lo, hi) {
        var v = Number(Model.settingValue(config, path, Model.SETTING_DEFAULTS[path] !== undefined ? Model.SETTING_DEFAULTS[path] : 0.5)) + delta;
        setSetting(path, Math.round(Math.max(lo, Math.min(hi, v)) * 100) / 100);
    }
    function clampCursor() {
        if (cursorKey !== "rows") return;
        var count = rowCount();
        if (count === 0) { cursorIndex = -1; return; }
        cursorIndex = Math.max(0, Math.min(count - 1, cursorIndex));
    }
    function leavePage() {
        dropKeep();
        resetCursor();
        exportOpen = false;
        importPreview = null;
        everywhereOpen = false;
        cancelFix();
        body.contentY = 0;
    }
    function selectSection(name) {
        if (name === "" || (name === section && view === "")) return;
        section = name;
        view = "";
        leavePage();
        loadPage(name);
        keyCatcher.forceActiveFocus();
    }
    // Drill-ins live inside a section: the tab stays lit, Esc comes back.
    function openDrill(name) {
        if (!Model.isDrill(name)) return;
        section = Model.drillSection(name);
        view = name;
        leavePage();
        loadPage(name);
        keyCatcher.forceActiveFocus();
    }
    function back() {
        if (view === "") return false;
        var from = view;
        view = "";
        leavePage();
        // Land on the row that opened the drill-in.
        if (from === "usage") setCursor("usage", -1);
        else setCursor("drill." + from, -1);
        loadPage(section);
        keyCatcher.forceActiveFocus();
        return true;
    }
    function loadPage(name) {
        if (name === "models" || name === "settings" || name === "advanced") loadModels();
        if (name === "advanced" && !gpu) service.run({op: "gpu.status"});
        if (name === "home" || name === "usage") { loadUsage(); loadHistory(); }
        if (name === "history") loadHistory();
        if (name === "words") loadLearned();
        if (name === "settings") loadFeatures();
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
    // Esc steps out one level: Fix, an open dictation, a drill-in, then the
    // panel. A click outside still closes it outright (KeyboardPanel → close()).
    function goBack() {
        if (confirmation.opened) return;
        if (fixStage !== "") { cancelFix(); return; }
        if (section === "history" && expandedId !== "") { expandedId = ""; return; }
        if (back()) return;
        close();
    }
    function closeForPopoutSwitch() {
        // The bar transfers ownership immediately; a file chooser opened by
        // this panel must no longer reclaim the screen afterwards.
        popoutSwitchClosing = true;
        confirmation.opened = false;
        confirmAction = "";
        importAcceptDangerous = false;
        importReview = "";
        attaching = false;
        pickKind = "";
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
            importReview = "";
            focusedEditor = null;
            openPopups = 0;
            pasteTarget = null;
            service.cancelPaste();
            // An unconfirmed Keep for value is dropped, never saved unseen.
            dropKeep();
            testField.text = "";
            previewOutput = "";
            wordsField.text = "";
            historySearch.text = "";
            if (fixField) fixField.text = "";
            fixId = "";
            fixStage = "";
            expandedId = "";
            everywhereOpen = false;
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
        // Hyprland binds change rarely: once per open.
        service.run({op: "shortcuts.list"});
        loadPage(page);
    }
    // The new sections ask only once `status` said the module exists, so an
    // older voxtype-tui never sees these ops (and never shows an error).
    function loadUsage() { if (caps.history) { service.cancelQueued("usage.summary"); service.run({op: "usage.summary", days: 365}); } }
    function loadHistory() { if (caps.history) { service.cancelQueued("history.list"); historyMoreCursor = ""; service.run({op: "history.list", limit: Model.HISTORY_PAGE}); } }
    function loadMoreHistory() {
        if (!caps.history || !historyNext || historyMoreCursor === historyNext) return;
        historyMoreCursor = historyNext;
        service.run({op: "history.list", limit: Model.HISTORY_PAGE, before: historyNext});
    }
    function loadLearned() { if (caps.learned) service.run({op: "learn.list"}); }
    function loadFeatures() { if (caps.features) service.run({op: "features.get"}); }
    function loadInsights() {
        if (caps.features) loadFeatures();
        loadPage(page);
    }
    function loadModels() {
        if (service.downloading) return;
        service.cancelQueued("models.list");
        // Derived here, not read from `modelsView`: inside onEngineChanged
        // that binding can still hold the previous engine, which would list
        // the old catalog and leave the section loading forever.
        service.run({op: "models.list", engine: browseEngine !== "" ? browseEngine : engine});
    }
    function pickModelsEngine(value) {
        if (value === engine) { if (browseEngine !== "") { browseEngine = ""; loadModels(); } return; }
        setSetting("engine", value);
    }
    function toggleRecord() {
        if (locked) return;
        if (!service.toggleRecord()) return;
        notice = daemonState === "recording" ? "Stopping…" : "Recording…";
    }
    function restartDaemon() {
        if (locked || service.restarting || service.powering) return;
        // `systemctl restart` starts a stopped unit, so Ctrl+R / middle-click
        // would silently undo "off". Turning it back on is the power button's job.
        if (Model.powerAction(status) === "on") { showNotice("Voxtype is not running · press o to turn it on"); return; }
        notice = "Restarting daemon…";
        // The bridge waits up to `timeout` s for readiness on top of
        // systemctl's own 15 s blocking restart; the Service deadline (40 s)
        // must stay above that sum. See Service.qml run() and bridge.py's
        // SYSTEMCTL_RESTART_TIMEOUT / DAEMON_RESTART_READY_TIMEOUT.
        service.run({op: "daemon.restart", timeout: 18});
    }
    function restartIfStale() { if (stale) restartDaemon() }
    // Off = `systemctl --user stop voxtype`: the process exits and its model
    // leaves VRAM/RAM. The unit stays enabled (no disable), so it comes back
    // at the next login; on = `start`. Stopping mid-dictation drops that
    // recording, so it asks first.
    function togglePower() {
        if (locked || service.powering || service.restarting) return;
        var action = Model.powerAction(status);
        if (action === "on") turnOn();
        else if (action === "off") {
            if (daemonState === "recording" || daemonState === "transcribing")
                ask("daemon.stop", {}, "Voxtype is " + daemonState + ".\nTurning it off now drops this dictation.", "Turn off");
            else turnOff();
        }
    }
    function turnOn() {
        if (locked || service.powering) return;
        notice = "Turning on…";
        service.run({op: "daemon.start"});
    }
    function turnOff() {
        if (locked || service.powering) return;
        notice = "Turning off…";
        service.run({op: "daemon.stop"});
    }
    function runPrimary() {
        if (primary === "start") turnOn();
        else if (primary === "restart") restartDaemon();
        else if (primary === "record") toggleRecord();
    }
    function setSetting(path, value) {
        if (locked) return;
        // Explicit engine picks leave failure-only catalog browsing. A reload
        // after needs_download still keeps that browse target until a pick.
        if (path === "engine" && browseEngine !== "") {
            browseEngine = "";
            if (!Model.settingChanged(config, path, value)) loadModels();
        }
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
        var path = page === "settings" ? Model.simpleSettingPath(cursorKey, modelPath) : Model.resettableSetting(cursorKey);
        if (path !== "" && Model.settingIsSet(config, path)) unsetSetting(path);
    }
    function toggleModifier(mod) {
        var mods = Model.settingValue(config, "hotkey.modifiers", []);
        setSetting("hotkey.modifiers", Model.toggleInList(mods, mod));
    }
    // Words: one field. "Codemux" adds a word, "code mucks → Codemux" a rule.
    function addWord() {
        var parsed = Model.parseWordInput(wordsField.text);
        if (!parsed || locked) return;
        if (parsed.kind === "invalid") { showNotice(parsed.reason); return; }
        if (parsed.kind === "rule") service.run({op: "dict.upsert", from: parsed.from, to: parsed.to, category: "Replacement"});
        else service.run({op: "vocab.add", phrase: parsed.phrase});
        wordsField.text = "";
    }
    function cursorWord() { return cursorKey === "rows" && page === "words" ? (wordsView.rows[cursorIndex] || null) : null }
    // `c` on a rule cycles Replacement ↔ Capitalization (the old Dictionary `c`).
    function cycleRuleCategory() {
        var rule = cursorWord();
        if (!rule || rule.kind !== "rule" || locked) return;
        service.run({op: "dict.set_category", from: rule.from, category: Model.nextCategory(rule.category, categories)});
    }
    function acceptLearned() {
        var w = cursorWord();
        if (!w || w.kind !== "learned") return;
        if (w.state === "suggested") service.run({op: "learn.accept", id: w.entryId});
        else showNotice("Already in use · p adds it to your words, x rejects it");
    }
    function promoteLearned() {
        var w = cursorWord();
        if (!w || w.kind !== "learned" || locked) return;
        service.run({op: "learn.promote", id: w.entryId});
    }
    function forgetLearned() {
        var w = cursorWord();
        if (!w || w.kind !== "learned") return;
        ask("learn.forget", {id: w.entryId}, "Forget “" + Model.sanitize(w.heard, 40) + " → " + Model.sanitize(w.written, 40) + "”?\nIt can be learned again from a later correction.", "Forget");
    }
    function resetLearned() {
        var total = learnedTotal;
        if (total === 0) return;
        var hidden = Math.max(0, total - learnedWords.length);
        ask("learn.reset", {}, "Delete all " + total + " learned words" + (hidden > 0 ? " (" + hidden + " rejected or promoted)" : "") + "?\nThey can be learned again. Your own words stay as they are.", "Delete all");
    }
    function jumpToLetter(letter) {
        var i = Model.letterIndex(wordsView.rows, letter);
        if (i < 0) { showNotice("Nothing from " + letter); return; }
        setCursor("rows", i);
    }
    // ---- History ------------------------------------------------------------
    function cursorHistoryItem() {
        if (page !== "history" && page !== "home") return null;
        if (cursorKey === "rows") return (page === "home" ? recentItems : historyItems)[cursorIndex] || null;
        return null;
    }
    function toggleExpand(item) {
        if (!item) return;
        // Collapsing the dictation being fixed ends Fix too: a hidden pick
        // would keep swallowing arrows and section keys.
        if (fixId !== "" && (fixId !== item.id || expandedId === item.id)) cancelFix();
        expandedId = expandedId === item.id ? "" : item.id;
    }
    // Fix lives inside its open dictation: when that collapses, scrolls
    // out of the filtered list or leaves the loaded history, Fix ends.
    function dropStaleFix() {
        if (fixId === "" && fixStage === "") return;
        var shown = false;
        for (var i = 0; i < historyItems.length; i++) if (historyItems[i].id === fixId) { shown = true; break; }
        if (expandedId !== fixId || !shown || fixRecord === null) cancelFix();
    }
    function openRecent(item) {
        if (!item) return;
        selectSection("history");
        expandedId = item.id;
        for (var i = 0; i < historyItems.length; i++) if (historyItems[i].id === item.id) { setCursor("rows", i); break; }
    }
    function copyHistory() { copyRecord(cursorHistoryItem()) }
    function copyRecord(item) {
        if (!item) return;
        if (!service.copy(Model.recordText(item.record))) return;
        showNotice(item.record && item.record.truncated ? "Copied the part shown · this dictation is too long to load in full" : "Copied");
    }
    function deleteHistory(item) {
        if (!item) return;
        ask("history.delete", {id: item.id}, "Delete this dictation from your history?\n“" + Model.sanitize(item.text, 70) + "”", "Delete");
    }
    function clearHistory() {
        if (historyList.length === 0) return;
        ask("history.clear", {}, "Delete your whole dictation history?\nUsage counts are kept; they hold no text.", "Delete all");
    }
    // ---- Fix a word -----------------------------------------------------------
    function startFix() {
        var item = cursorHistoryItem();
        if (!item && expandedId !== "") item = {id: expandedId};
        startFixFor(item);
    }
    function startFixFor(item) {
        if (!item || locked) return;
        if (!caps.learned) { showNotice("Fix a word " + Model.NEEDS_TUI_02); return; }
        if (learningOn === false) { showNotice("Learning is off · turn it on in Settings"); return; }
        var rec = Model.findRecord(historyList, item.id);
        // A shortened record is not the stored text: an edit of it would
        // read as a rewrite. learn.submit also caps the edited text.
        if (rec && rec.truncated) { showNotice("This dictation is too long to fix here"); return; }
        if (rec && Model.recordText(rec).length > Model.FIX_TEXT_MAX_CHARS) { showNotice("This dictation is too long to fix here"); return; }
        expandedId = item.id;
        fixId = item.id;
        fixStart = 0;
        fixEnd = 0;
        fixStage = "pick";
        if (fixField) fixField.text = "";
        keyCatcher.forceActiveFocus();
    }
    function moveFix(d) {
        var n = fixTokens.length;
        if (n === 0) return;
        var i = Math.max(0, Math.min(n - 1, (d > 0 ? fixEnd : fixStart) + d));
        fixStart = i;
        fixEnd = i;
    }
    // `]` takes the next word too, `[` gives one back.
    function growFix(d) {
        var n = fixTokens.length;
        if (n === 0 || fixStart < 0) return;
        fixEnd = Math.max(fixStart, Math.min(n - 1, fixEnd + d));
    }
    function pickFixWord(index, extend) {
        if (extend && fixStart >= 0 && index > fixEnd && index - fixStart < 6) fixEnd = index;
        else { fixStart = index; fixEnd = index; }
        if (fixStage === "") fixStage = "pick";
    }
    function confirmFixSpan() {
        if (fixStart < 0) return;
        fixStage = "type";
        var heard = Model.spanText(fixTokens, fixStart, fixEnd);
        fixKind = "sounds_like";
        if (!fixField) return;
        fixField.text = heard;
        fixField.forceActiveFocus();
        fixField.selectAll();
    }
    function cycleFixKind(d) { fixKind = Model.cycleValue(Model.FIX_KINDS, fixKind, d) }
    function submitFix() {
        var written = fixField ? fixField.text.trim() : "";
        if (fixId === "" || written === "" || locked) return;
        var heard = Model.spanText(fixTokens, fixStart, fixEnd);
        if (written === heard) { showNotice("Type how it should be written"); return; }
        // The stored text with only the picked span replaced.
        var edited = Model.fixedText(fixText, fixTokens, fixStart, fixEnd, written);
        if (edited === null) return;
        if (edited.length > Model.FIX_TEXT_MAX_CHARS) { showNotice("This dictation is too long to fix here"); return; }
        service.run({op: "learn.submit", id: fixId, edited: edited, kind: fixKind});
    }
    function cancelFix() {
        if (fixId === "" && fixStage === "") return;
        var refocus = !!fixField && fixField.activeFocus;
        fixId = "";
        fixStage = "";
        fixStart = -1;
        fixEnd = -1;
        if (fixField) fixField.text = "";
        if (refocus) keyCatcher.forceActiveFocus();
    }
    // ---- Settings (simple rows) ----------------------------------------------
    // Re-saving the current usage switch makes voxtype-tui wire its hooks;
    // the reply marks the daemon stale, so the hero then says Restart.
    function connectVoxtype() {
        if (locked || !caps.features || features === null) return;
        setFeature("usage", "enabled", featureValue("usage", "enabled", true) === true);
    }
    function setFeature(group, key, value) {
        if (locked || !caps.features) return;
        var patch = {};
        patch[group] = {};
        patch[group][key] = value;
        service.run({op: "features.set", patch: patch});
    }
    function featureValue(group, key, fallback) {
        var g = feat[group];
        return g && g[key] !== undefined ? g[key] : fallback;
    }
    function featureOk(name) { return !!caps.features && (features === null || featureAvail[name] !== false) }
    function featureReason(name) { return !caps.features ? Model.NEEDS_TUI_02 : String(featureReasons[name] || "") }
    function setLogin(enabled) {
        if (locked) return;
        service.run({op: "daemon.set_login", enabled: enabled});
    }
    function pickArchiveDir() {
        if (locked || !caps.features || service.picking || !pickerAvailable) return;
        pickKind = "dir";
        attaching = true;
        controller.hide();
        if (!service.pick("dir")) { attaching = false; pickKind = ""; controller.show(); }
    }
    function writeSettings(writes) {
        for (var i = 0; i < writes.length; i++) setSetting(writes[i][0], writes[i][1]);
    }
    // ←/→ (and Enter, which steps forward) on a simple Settings row.
    function cycleSimple(key, d) {
        if (locked) return;
        if (key === "model") {
            var opts = Model.modelCycleOptions(modelsEngine === engine ? modelRows : [], String(Model.settingValue(config, modelPath, "")));
            if (opts.length < 2) { showNotice(opts.length ? "Only one model downloaded · Manage models to add more" : "No model downloaded · open Manage models"); return; }
            setSetting(modelPath, Model.cycleValue(opts, String(Model.settingValue(config, modelPath, "")), d));
        }
        else if (key === "language") setSetting("whisper.language", Model.cycleValue(Model.LANGUAGES, String(Model.settingOr(config, "whisper.language")), d));
        else if (key === "mode") setSetting("hotkey.mode", Model.cycleValue(Model.HOTKEY_MODE_OPTIONS, String(Model.settingOr(config, "hotkey.mode")), d));
        else if (key === "output_mode") setSetting("output.mode", Model.cycleValue(Model.OUTPUT_MODE_OPTIONS, String(Model.settingOr(config, "output.mode")), d));
        else if (key === "indicator") writeSettings(Model.indicatorWrites(Model.cycleValue(Model.INDICATOR_OPTIONS, Model.indicatorValue(config), d)));
        else if (key === "other_audio") writeSettings(Model.otherAudioWrites(Model.cycleValue(Model.OTHER_AUDIO_OPTIONS, Model.otherAudioValue(config), d)));
        else if (key === "keep") stepKeep(d);
        else activateSimple(key);
    }
    function keepShown() { return keepPending ? keepPendingDays : featureValue("history", "keep_days", 30) }
    function stepKeep(d) {
        if (locked || !caps.features || confirmation.opened) return;
        var next = Model.cycleValue(Model.KEEP_OPTIONS, keepShown(), d);
        keepPendingDays = next;
        keepPending = next !== featureValue("history", "keep_days", 30);
        if (keepPending) keepTimer.restart(); else keepTimer.stop();
    }
    function dropKeep() {
        keepTimer.stop();
        keepPending = false;
    }
    // The timer fires on its own, so it only acts while the user is still
    // looking at the row and nothing else is being confirmed: it must never
    // replace (or reuse) another dialog's action.
    function commitKeep() {
        keepTimer.stop();
        if (!keepPending || locked || confirmation.opened || page !== "settings" || !cursorIs("keep")) { keepPending = false; return; }
        var days = keepPendingDays;
        var saved = featureValue("history", "keep_days", 30);
        if (days === saved) { keepPending = false; return; }
        if (!Model.keepIsShorter(saved, days)) { keepPending = false; setFeature("history", "keep_days", days); return; }
        // Stays pending (the row keeps showing it) until Cancel or confirm.
        ask("features.set", {patch: {history: {keep_days: days}}},
            Model.keepConfirmMessage(days, historyList, historyLoaded && !historyNext, Date.now()), "Delete older", true);
    }
    function activateSimple(key) {
        if (locked) return;
        if (key === "drill.models") openDrill("models");
        else if (key === "drill.advanced" || key === "shortcut") openDrill("advanced");
        else if (key === "drill.backup") openDrill("backup");
        else if (key === "sounds") setSetting("audio.feedback.enabled", !Model.settingOr(config, "audio.feedback.enabled"));
        else if (key === "spoken_punctuation") setSetting("text.spoken_punctuation", !Model.settingOr(config, "text.spoken_punctuation"));
        else if (key === "filler_words") setSetting("text.filter_filler_words", !Model.settingOr(config, "text.filter_filler_words"));
        else if (key === "login") { if (status && status.daemon && status.daemon.starts_at_login !== null) setLogin(!status.daemon.starts_at_login); }
        else if (key === "usage") setFeature("usage", "enabled", !featureValue("usage", "enabled", true));
        else if (key === "history") setFeature("history", "enabled", !featureValue("history", "enabled", true));
        else if (key === "archive") setFeature("archive", "enabled", !archiveOn);
        else if (key === "archive.dir") pickArchiveDir();
        else if (key === "archive.audio") setFeature("archive", "save_audio", !featureValue("archive", "save_audio", true));
        else if (key === "archive.text") setFeature("archive", "save_text", !featureValue("archive", "save_text", true));
        else if (key === "learning") setFeature("learning", "enabled", !learningOn);
        else if (key === "everywhere") toggleEverywhereCard();
        else cycleSimple(key, 1);
    }
    function toggleEverywhereCard() {
        everywhereOpen = !everywhereOpen;
        if (everywhereOpen && caps.everywhere) service.run({op: "learn.everywhere.preview"});
    }
    function setEverywhere(enabled) {
        if (locked || !caps.everywhere) return;
        service.run({op: "learn.everywhere.set", enabled: enabled});
    }
    function previewPhrase() {
        var text = testField.text.trim();
        if (text === "") { previewOutput = ""; return; }
        service.cancelQueued("dictionary.preview");
        service.run({op: "dictionary.preview", text: text});
    }
    // keepRetention: only commitKeep's own confirmation keeps the Keep for
    // preview; any other one drops it. An open confirmation is never
    // replaced: its action is what the user is reading.
    function confirming() { return confirmation.opened }
    function ask(action, payload, message, confirmLabel, keepRetention) {
        if (locked || confirmation.opened) return;
        if (!keepRetention) dropKeep();
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
        if (page === "history") { deleteHistory(cursorHistoryItem()); return; }
        if (cursorKey !== "rows") return;
        if (page === "words") {
            var w = cursorWord();
            if (!w) return;
            if (w.kind === "vocab") ask("vocab.remove", {phrase: w.phrase}, "Remove “" + Model.sanitize(w.phrase, 60) + "” from your words?", "Remove");
            else if (w.kind === "rule") ask("dict.remove", {from: w.from}, "Delete the rule “" + Model.sanitize(w.from, 60) + " → " + Model.sanitize(w.written, 60) + "”?", "Delete");
            else ask("learn.reject", {id: w.entryId}, "Stop using “" + Model.sanitize(w.heard, 40) + " → " + Model.sanitize(w.written, 40) + "”?\nIt will not be learned again.", "Reject");
        } else if (page === "models") {
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
        keepPending = false;
        if (action === "import.apply") {
            // accept_dangerous mirrors the confirmation the user just read.
            // With no dangerous rows it is false, so the bridge's own gate
            // stays live rather than being pre-waived on every import.
            var accept = importAcceptDangerous;
            var review = importReview;
            importAcceptDangerous = false;
            importReview = "";
            // `review` binds this confirmation to the preview it showed: if
            // the file, the flags or the local state changed since, the
            // bridge computes a different token and writes nothing.
            service.run({op: "import.apply", path: importPath, include_local: importLocal, include_settings: importSettings, accept_dangerous: accept, review: review});
            return;
        }
        if (action === "") return;
        var req = {op: action};
        for (var k in payload) req[k] = payload[k];
        service.run(req);
    }
    function setActiveModel(m) {
        if (!m || locked) return;
        var why = Model.modelActionBlock(m, "activate");
        if (why !== "") { showNotice(why); return; }
        if (Model.modelNeedsDownload(m)) { startDownload(m); return; }
        service.run({op: "models.set_active", engine: modelsEngine, name: m.name});
    }
    function startDownload(m) {
        if (!m || locked || service.downloading) return;
        if (Model.modelUnavailable(m)) { showNotice(Model.modelActionBlock(m, "download")); return; }
        if (!service.download(modelsEngine, m.name)) return;
        notice = "Downloading " + m.name + "…";
    }
    function downloadCursorModel() {
        if (page !== "models" || cursorKey !== "rows") return;
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
        if (fixStage === "pick") { confirmFixSpan(); return; }
        if (!cursorActive) { moveCursor(1); return; }
        var key = cursorKey;
        if (page === "home") {
            if (key === "record") toggleRecord();
            else if (key === "power") togglePower();
            else if (key === "restart") restartDaemon();
            else if (key === "download") openDrill("models");
            else if (key === "usage") { if (wiringPending) connectVoxtype(); else openDrill("usage"); }
            else if (key === "rows") openRecent(recentItems[cursorIndex]);
            else if (key === "test") testField.forceActiveFocus();
        } else if (page === "words") {
            if (key === "search") wordsField.forceActiveFocus();
            else if (key === "filter") wordFilter = Model.cycleValue(Model.wordFilters(myWords, learnedWords), wordFilter, 1);
            else if (key === "learn.reset") resetLearned();
            else if (key === "rows") {
                var w = cursorWord();
                if (w && w.kind === "rule") cycleRuleCategory();
                else if (w && w.kind === "learned") acceptLearned();
            }
        } else if (page === "history") {
            if (key === "search") historySearch.forceActiveFocus();
            else if (key === "rows") toggleExpand(historyItems[cursorIndex]);
            else if (key === "more") loadMoreHistory();
            else if (key === "clear") clearHistory();
        } else if (page === "models") {
            if (key === "engine") engineDropdown.open();
            else if (key === "rows") setActiveModel(modelRows[cursorIndex]);
        } else if (page === "backup") {
            if (key === "export") toggleExport();
            else if (key === "import") beginImport();
        } else if (page === "settings") {
            activateSimple(key);
        } else if (page === "advanced") {
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
        importReview = "";
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
        importReview = "";
        importChanged = false;
        pickKind = "bundle";
        controller.hide();
        if (!service.pick("bundle")) { attaching = false; pickKind = ""; controller.show(); }
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
        if (confirming() || !importPreview || typeof importPreview.review !== "string" || importPreview.review === "") return;
        var confirmation = Model.importConfirmation(importPath.split("/").pop(), importPreview.diff);
        // The dialog is the acknowledgement: accept_dangerous is whatever
        // this message could actually show, never a constant, and it only
        // covers the preview it was built from.
        importAcceptDangerous = confirmation.accept;
        importReview = importPreview.review;
        ask("import.apply", null, confirmation.message, confirmation.confirmText);
    }
    // Ctrl+V / Shift+Insert in a field. The clipboard is read by a bounded
    // child (Service.paste), never by Qt inside the shell; the text lands
    // only in the field that asked, and only if it still has focus.
    function requestPaste(field) {
        // One read at a time; a second Ctrl+V never re-targets a running one.
        if (!field || service.pasting) return;
        pasteTarget = field;
        service.paste();
    }
    function finishPaste(text) {
        var field = pasteTarget;
        pasteTarget = null;
        if (!field || !opened || focusedEditor === null || !field.activeFocus) return;
        field.insertText(text);
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
        if (page === "words") wordsField.forceActiveFocus();
        else if (page === "history") historySearch.forceActiveFocus();
        else if (page === "home") testField.forceActiveFocus();
    }
    function handleTextKey(t) {
        if (locked) { if (t === "y" && canInstallLocked) copyLockedCommand(); return; }
        if (fixStage === "pick") {
            if (t === "]") growFix(1);
            else if (t === "[") growFix(-1);
            return;
        }
        var s = Model.sectionForKey(t);
        if (s !== "") { selectSection(s); return; }
        if (t === "/") focusSearch();
        else if (t === "a" && page === "words") wordsField.forceActiveFocus();
        else if (t === "c" && page === "words") cycleRuleCategory();
        else if (t === "c" && page === "history") copyHistory();
        else if (t === "f" && page === "history") startFix();
        else if (t === "p" && page === "words") promoteLearned();
        else if (t === "d" && page === "words") forgetLearned();
        else if (t === "d" && page === "models") downloadCursorModel();
        else if (t === "u" && (page === "settings" || page === "advanced")) resetCursorSetting();
        else if (t === "u" && page === "home") openDrill("usage");
        else if (t === "o" && page === "home") togglePower();
        // Capitals jump on Words before any letter action (Shift+R jumps to
        // R there; r still records). Shift+X never arrives: the kit key
        // catcher turns it into Delete.
        else if (page === "words" && /^[A-Z]$/.test(t)) jumpToLetter(t);
        else if (t === "r" || t === "R") toggleRecord();
    }
    onWordsViewChanged: clampCursor()
    onPageChanged: dropKeep()
    onCursorKeyChanged: if (keepPending && cursorKey !== "keep") dropKeep()
    onHistoryItemsChanged: { clampCursor(); dropStaleFix() }
    onExpandedIdChanged: dropStaleFix()
    onModelRowsChanged: clampCursor()
    onEngineChanged: {
        if (browseEngine === engine) browseEngine = "";
        if (opened && (page === "models" || page === "settings" || page === "advanced")) loadModels();
    }
    // A dictation just finished while the panel is open: show it.
    property string lastDaemonState: ""
    onDaemonStateChanged: {
        var was = lastDaemonState;
        lastDaemonState = daemonState;
        if (opened && was === "transcribing" && daemonState !== "transcribing" && (page === "home" || page === "history" || page === "usage")) {
            loadHistory();
            loadUsage();
        }
    }

    Service {
        id: service
        pollState: true
        pollIntervalMs: 1500
        onCompleted: function(op, result, req) {
            // Whatever came back, the "Load older" request for this cursor
            // is no longer in flight.
            if (op === "history.list" && req.before && root.historyMoreCursor === req.before) root.historyMoreCursor = "";
            if (Model.isTuiMissing(result)) { root.tuiMissing = true; root.errorText = ""; return; }
            // An older voxtype-tui (or one without a feature) answers the new
            // ops with `unavailable`: the section says so, no error line.
            if (!result.ok && typeof result.unavailable === "string") {
                var un = {};
                for (var u in root.unavailable) un[u] = root.unavailable[u];
                un[op] = Model.sanitize(result.unavailable, 80);
                root.unavailable = un;
                return;
            }
            if (!result.ok) {
                if (op === "learn.submit") { root.errorText = "Not learned: " + Model.sanitize(result.error, 160); return; }
                // The bridge refuses an apply whose diff no longer matches
                // what was acknowledged (the file changed between preview and
                // apply, or the dangerous set grew). Say what to do instead of
                // dumping the protocol error.
                // Qwen3-ASR picked before any of its models is downloaded:
                // undo the optimistic engine echo and show its catalog so one
                // can be downloaded.
                if (op === "settings.set" && req.path === "engine" && result.needs_download === true) {
                    root.browseEngine = String(result.engine || req.value);
                    root.errorText = "";
                    root.showNotice("No " + Model.engineLabel(root.options, root.browseEngine) + " model yet · pick one and press d to download");
                    service.run({op: "load"});
                    root.loadModels();
                    return;
                }
                if (op === "import.apply" && result.error === "dangerous-changes") {
                    root.importPreview = null;
                    root.importAcceptDangerous = false;
                    root.importReview = "";
                    root.errorText = "Import refused: the bundle's dangerous changes no longer match what you reviewed. Preview it again.";
                    return;
                }
                // The file (or the flags, or local state) changed after the
                // preview. Nothing was written; load the new preview and say
                // why, so the user confirms what would actually be applied.
                if (op === "import.apply" && result.error === "review-mismatch") {
                    root.importPreview = null;
                    root.importAcceptDangerous = false;
                    root.importReview = "";
                    root.importChanged = true;
                    root.errorText = "";
                    root.requestImportPreview();
                    return;
                }
                if (op !== "status" || !root.status) root.errorText = Model.sanitize(result.error, 200);
                return;
            }
            root.tuiMissing = false;
            if (op !== "status") root.errorText = "";
            if (op === "status") {
                var first = !root.status || !root.status.capabilities;
                root.status = result;
                service.status = result;
                // Capabilities arrive with the first status; the new
                // sections load only once we know they exist.
                if (first) root.loadInsights();
            }
            else if (op === "shortcuts.list") root.shortcuts = result;
            else if (op === "features.get") root.features = result;
            else if (op === "features.set") {
                root.features = result;
                if (result.daemon_stale) {
                    var need = root.restartNeeded.slice();
                    var hooks = result.restart_needed || [];
                    for (var h = 0; h < hooks.length; h++) if (need.indexOf(hooks[h]) < 0) need.push(hooks[h]);
                    if (need.length === 0) need.push("output");
                    root.restartNeeded = need;
                }
                // Switches saved, hooks not rewired: capture may still be
                // disconnected, so this is a warning, not "Saved".
                if (typeof result.wiring_error === "string" && result.wiring_error !== "") {
                    root.notice = "";
                    // voxtype-tui's text is technical ("could not update voxtype's config: <toml error>"):
                    // one plain line, the cause only when it is already short.
                    var cause = Model.shortDetail(String(result.wiring_error).replace(/^could not update voxtype's config: /, ""), 50);
                    root.errorText = "Saved, but Voxtype's config couldn't be updated, so it isn't connected yet" + (cause ? " (" + cause + ")" : "");
                } else {
                    root.notice = "Saved";
                    noticeTimer.restart();
                }
                if (req.patch && (req.patch.history || req.patch.usage)) { root.loadHistory(); root.loadUsage(); }
            }
            else if (op === "usage.summary") root.usage = result;
            else if (op === "history.list") {
                // A page with `before` appends; anything else replaces.
                var items = result.items || [];
                if (req.before) {
                    // Only the page that continues the list as it is now;
                    // a record already shown is never added twice.
                    if (req.before !== root.historyNext) return;
                    root.historyList = Model.appendHistory(root.historyList, items);
                }
                else if (!Model.sameList(root.historyList, items, true)) root.historyList = items;
                root.historyNext = result.next || null;
                root.historyLoaded = true;
                root.historyEnabled = result.enabled !== false;
                root.historyKeepDays = result.keep_days === undefined ? 30 : result.keep_days;
            }
            else if (op === "history.delete" || op === "history.clear") {
                root.showNotice(op === "history.clear" ? "History cleared" : "Deleted");
                if (op === "history.clear") root.expandedId = "";
                root.loadHistory();
                root.loadUsage();
            }
            else if (op === "learn.list") root.learnedState = result;
            else if (op === "learn.submit") {
                var applied = result.applied || [];
                var cands = result.candidates || [];
                root.cancelFix();
                root.showNotice(Model.learnNotice(result));
                root.loadLearned();
            }
            else if (op === "learn.accept" || op === "learn.reject" || op === "learn.forget" || op === "learn.reset") {
                root.showNotice(op === "learn.accept" ? "Now in use" : (op === "learn.reset" ? "Learned words deleted" : (op === "learn.reject" ? "Rejected" : "Forgotten")));
                root.loadLearned();
            }
            else if (op === "learn.promote") {
                if (result.snapshot !== undefined) root.applySnapshot(result.snapshot);
                root.showNotice("Added to your words");
                root.loadLearned();
            }
            else if (op === "learn.everywhere.preview") root.everywherePreview = result;
            else if (op === "learn.everywhere.set") {
                root.showNotice(req.enabled ? "Learn everywhere is on · log out and back in to apply" : "Learn everywhere is off");
                root.loadFeatures();
                service.run({op: "learn.everywhere.preview"});
            }
            else if (op === "daemon.set_login") {
                root.showNotice(result.starts_at_login ? "Starts at login" : "Won't start at login");
                service.run({op: "status"});
            }
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
            else if (op === "import.preview") {
                root.importPreview = result;
                if (root.importChanged) {
                    root.importChanged = false;
                    root.errorText = "Nothing imported: the file changed after you reviewed it. Check this preview and apply again.";
                }
                Qt.callLater(function() { root.revealForm(importCard) });
            }
            else if (op === "daemon.restart") {
                root.notice = result.ready ? "Daemon restarted" : Model.sanitize(result.message || "Daemon restarting…", 120);
                root.restartNeeded = [];
                noticeTimer.restart();
                service.run({op: "status"});
            }
            else if (op === "daemon.start" || op === "daemon.stop") {
                root.notice = op === "daemon.stop" ? "Turned off" : "Turned on";
                // A fresh start reads the config as it is now.
                if (op === "daemon.start") root.restartNeeded = [];
                noticeTimer.restart();
                service.run({op: "status"});
            }
            else if (op === "record.toggle") service.run({op: "status"});
            else if (result.snapshot !== undefined) {
                root.applySnapshot(result.snapshot);
                var needed = root.restartNeeded.slice();
                var paths = result.restart_needed || [];
                for (var i = 0; i < paths.length; i++) if (needed.indexOf(paths[i]) < 0) needed.push(paths[i]);
                root.restartNeeded = needed;
                root.notice = "Saved";
                noticeTimer.restart();
                // The save worked, but the Qwen3-ASR server unit could not be
                // updated (newer voxtype-tui only): say so instead of "Saved".
                if (result.asr_problems && result.asr_problems.length) root.errorText = Model.sanitize(result.asr_problems.join("; "), 200);
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
            // A download makes the model active (config.toml changed).
            service.run({op: "load"});
            service.run({op: "status"});
        }
        onRecordFinished: function(ok) {
            if (!ok) root.errorText = "Could not toggle recording. Is the voxtype daemon running?";
            else { root.notice = ""; service.run({op: "status"}); }
        }
        onPicked: function(path) {
            var kind = root.pickKind;
            root.pickKind = "";
            root.resumeAfterPick();
            if (kind === "dir") { root.setFeature("archive", "dir", path); return; }
            root.importPath = path;
            root.requestImportPreview();
        }
        onPickCanceled: { root.pickKind = ""; root.resumeAfterPick() }
        onCopyFinished: function(ok) { if (!ok) { root.notice = ""; root.errorText = "Could not copy: is wl-copy installed?" } }
        onPickFailed: { root.pickKind = ""; root.resumeAfterPick(); root.errorText = Model.ERROR_PICKER_MISSING }
        onPasted: function(text) { root.finishPaste(text) }
        onPasteFailed: function(reason) { root.pasteTarget = null; root.showNotice(reason) }
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
    Timer { id: keepTimer; interval: 1200; onTriggered: root.commitKeep() }

    KeyboardPanel {
        id: panel
        anchorItem: root.anchorItem
        owner: root.hostWidget || root
        bar: root.bar
        open: root.opened
        focusTarget: keyCatcher
        contentWidth: fittedContentWidth(Style.space(560))
        // Tall enough for Home's hero, the year and three recent lines;
        // fittedContentHeight still caps it to the screen.
        contentHeight: fittedContentHeight(Style.space(640))

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
                onCloseRequested: root.goBack()
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
                        meta: Model.heroMeta(root.status, root.tuiMissing ? Model.ERROR_TUI_MISSING : root.errorText, root.shortcutInfo.primary)
                        detail: root.locked ? "" : (root.stale ? "RESTART TO APPLY" : "")
                        foreground: root.foreground
                        fontFamily: root.fontFamily
                        iconOpacity: root.locked || root.daemonState === "stopped" ? 0.55 : 1
                        iconComponent: Component {
                            VoxtypeIcon {
                                daemonState: root.daemonState
                                color: root.daemonState === "recording" ? Commons.Color.accent : root.foreground
                            }
                        }
                        trailingControl: Component {
                            Button {
                                visible: root.primary !== ""
                                text: Model.primaryLabel(root.primary, root.daemonState)
                                iconText: root.primary === "record" ? (root.daemonState === "recording" ? "󰓛" : "󰍬") : (root.primary === "restart" ? "󰑓" : "󰐥")
                                bordered: true
                                focusable: false
                                foreground: root.foreground
                                fontFamily: root.fontFamily
                                enabled: !service.recording && !service.restarting && !service.powering
                                tooltipText: root.primary === "record" ? "r · toggle recording" : (root.primary === "restart" ? "Ctrl+R · restart the daemon" : "o · load the model and start listening")
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

                            // Breadcrumb on drill-ins: "Settings › All Voxtype settings   Esc back"
                            Item {
                                visible: root.view !== ""
                                width: parent.width
                                height: crumbText.implicitHeight + Style.space(4)
                                Text {
                                    id: crumbText
                                    anchors.left: parent.left; anchors.verticalCenter: parent.verticalCenter
                                    textFormat: Text.PlainText
                                    text: Model.SECTION_LABELS[root.section] + "  ›  "
                                    color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.title
                                }
                                Text {
                                    anchors.left: crumbText.right; anchors.verticalCenter: parent.verticalCenter
                                    textFormat: Text.PlainText
                                    text: Model.drillTitle(root.view)
                                    color: root.foreground; font.family: root.fontFamily; font.pixelSize: Style.font.title; font.bold: true
                                }
                                Text {
                                    anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
                                    textFormat: Text.PlainText; text: "Esc back"
                                    color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.body
                                    MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.back() }
                                }
                            }

                            // ================= 1 · Home =================
                            Column {
                                visible: root.page === "home"
                                width: parent.width
                                spacing: Style.space(12)

                                // One word, and how to start.
                                Column {
                                    width: parent.width
                                    spacing: Style.space(6)
                                    topPadding: Style.space(6)
                                    Text {
                                        anchors.horizontalCenter: parent.horizontalCenter
                                        textFormat: Text.PlainText
                                        text: root.homeHero.title
                                        color: root.homeHero.tone === "accent" ? Commons.Color.accent : (root.homeHero.tone === "urgent" ? root.urgent : (root.homeHero.tone === "muted" ? root.muted : root.foreground))
                                        font.family: root.fontFamily; font.pixelSize: Style.font.displayLarge; font.bold: true
                                    }
                                    Row {
                                        anchors.horizontalCenter: parent.horizontalCenter
                                        spacing: Style.space(6)
                                        readonly property bool keyed: root.homeHero.title === "Ready" && root.shortcutInfo.primary !== ""
                                        Text {
                                            visible: parent.keyed
                                            anchors.verticalCenter: parent.verticalCenter
                                            textFormat: Text.PlainText; text: root.shortcutInfo.isHold ? "Hold" : "Press"
                                            color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.subtitle
                                        }
                                        Keycap { visible: parent.keyed; anchors.verticalCenter: parent.verticalCenter; text: root.shortcutInfo.primary }
                                        Text {
                                            anchors.verticalCenter: parent.verticalCenter
                                            textFormat: Text.PlainText
                                            text: parent.keyed ? "and talk" + (root.status && root.status.model && root.status.model.name ? "  ·  " + Model.sanitize(root.status.model.name, 40) : "") : root.homeHero.line
                                            color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.subtitle
                                        }
                                    }
                                    Text {
                                        anchors.horizontalCenter: parent.horizontalCenter
                                        visible: root.homeHero.title === "Ready" && root.shortcutInfo.hold !== ""
                                        textFormat: Text.PlainText
                                        text: "or hold " + root.shortcutInfo.hold
                                        color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.caption
                                    }
                                }

                                Row {
                                    anchors.horizontalCenter: parent.horizontalCenter
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
                                    // On/off: stop frees the model's VRAM/RAM; the unit stays
                                    // enabled, so it starts again at the next login.
                                    Button {
                                        readonly property string action: Model.powerAction(root.status)
                                        text: Model.powerLabel(action) || "Turn off"
                                        iconText: "󰐥"
                                        bordered: true
                                        hasCursor: root.cursorIs("power")
                                        foreground: root.foreground
                                        fontFamily: root.fontFamily
                                        enabled: action !== "" && !service.powering && !service.restarting
                                        tooltipText: action === "on" ? "o · load the model and start listening" : "o · stop Voxtype and free its GPU/RAM until you turn it on (it still starts at login)"
                                        onHovered: function(h) { if (h) root.setCursor("power", -1) }
                                        onClicked: root.togglePower()
                                    }
                                    Button {
                                        text: "Restart"
                                        iconText: "󰑓"
                                        bordered: true
                                        hasCursor: root.cursorIs("restart")
                                        foreground: root.foreground
                                        fontFamily: root.fontFamily
                                        enabled: !service.restarting && !service.powering && root.daemonState !== "stopped"
                                        tooltipText: "Ctrl+R · restart the daemon"
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
                                        accent: modelData.kind === "warn" ? root.urgent : Commons.Color.accent
                                        implicitHeight: noticeRow.implicitHeight + Style.space(20)
                                        Row {
                                            id: noticeRow
                                            anchors.left: parent.left; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
                                            anchors.margins: Style.space(12)
                                            spacing: Style.space(10)
                                            Text { textFormat: Text.PlainText; text: modelData.kind === "warn" ? "󰀦" : "󰋽"; color: modelData.kind === "warn" ? root.urgent : Commons.Color.accent; font.family: root.fontFamily; font.pixelSize: Style.font.heading; anchors.verticalCenter: parent.verticalCenter }
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
                                    MouseArea { anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onEntered: root.setCursor("download", -1); onClicked: root.openDrill("models") }
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

                                // The last 12 months (rolling): heatmap + four numbers. Enter opens Usage.
                                SectionHead { title: "LAST 12 MONTHS"; trailing: "usage ›"; onTrailingClicked: root.openDrill("usage") }
                                CursorSurface {
                                    id: usageCard
                                    width: parent.width
                                    bordered: true
                                    hasCursor: root.cursorIs("usage")
                                    foreground: root.foreground
                                    implicitHeight: usageColumn.implicitHeight + Style.space(24)
                                    onHasCursorChanged: if (hasCursor) root.ensureVisible(usageCard)
                                    MouseArea { anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onEntered: root.setCursor("usage", -1); onClicked: if (root.wiringPending) root.connectVoxtype(); else root.openDrill("usage") }
                                    Column {
                                        id: usageColumn
                                        anchors.left: parent.left; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
                                        anchors.margins: Style.space(12)
                                        spacing: Style.space(10)
                                        Heatmap {
                                            visible: root.usageReady
                                            width: parent.width
                                            grid: Model.heatmap(root.usage ? root.usage.days : [], null, 52)
                                            foreground: root.foreground; muted: root.muted; accent: Commons.Color.accent; fontFamily: root.fontFamily
                                        }
                                        Row {
                                            visible: root.usageReady
                                            spacing: Style.space(18)
                                            Stat { value: root.usageNumbers.today; label: "today" }
                                            Stat { value: root.usageNumbers.words; label: "words" }
                                            Stat { value: root.usageNumbers.wpm; label: "wpm" }
                                            Text {
                                                visible: root.usageNumbers.saved !== ""
                                                textFormat: Text.PlainText; text: root.usageNumbers.saved
                                                color: Commons.Color.accent; font.family: root.fontFamily; font.pixelSize: Style.font.subtitle; font.bold: true
                                            }
                                        }
                                        Text {
                                            visible: !root.usageReady
                                            width: parent.width; wrapMode: Text.WordWrap
                                            textFormat: Text.PlainText
                                            text: root.usageMessage
                                            color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.body
                                        }
                                        Text {
                                            visible: root.wiringPending
                                            width: parent.width; wrapMode: Text.WordWrap
                                            textFormat: Text.PlainText
                                            text: Model.healthLine({pending_wiring: root.usage && root.usage.health ? root.usage.health.pending_wiring : []}) + " · Enter connects it"
                                            color: Commons.Color.accent; font.family: root.fontFamily; font.pixelSize: Style.font.caption
                                        }
                                    }
                                }

                                SectionHead { visible: root.recentItems.length > 0; title: "RECENT"; trailing: "history ›"; onTrailingClicked: root.selectSection("history") }
                                Repeater {
                                    model: root.recentItems
                                    delegate: HistoryLine {
                                        required property var modelData
                                        required property int index
                                        pageName: "home"
                                        item: modelData
                                        rowIndex: index
                                        onPicked: root.openRecent(modelData)
                                    }
                                }

                                PanelSectionHeader { text: "TEST A PHRASE"; foreground: root.foreground; fontFamily: root.fontFamily }
                                EditField {
                                    id: testField
                                    onPasteRequested: root.requestPaste(testField)
                                    width: parent.width
                                    placeholderText: "Type what you would say…"
                                    foreground: root.foreground
                                    hasCursor: root.cursorIs("test")
                                    onHoveredChanged: if (hovered) root.setCursor("test", -1)
                                    onHasCursorChanged: if (hasCursor) root.ensureVisible(testField)
                                    onActiveFocusChanged: root.noteEditor(testField, activeFocus)
                                    onTextChanged: previewDebounce.restart()
                                    Keys.onEscapePressed: function(event) { keyCatcher.forceActiveFocus(); event.accepted = true }
                                    Keys.onReturnPressed: root.previewPhrase()
                                }
                                Text {
                                    width: parent.width; textFormat: Text.PlainText; wrapMode: Text.WordWrap
                                    visible: testField.text.trim() !== ""
                                    text: root.previewOutput === "" ? "…" : "→ " + root.previewOutput
                                    color: root.previewOutput !== "" && root.previewOutput !== testField.text.trim() ? Commons.Color.accent : root.muted
                                    font.family: root.fontFamily; font.pixelSize: Style.font.subtitle
                                }
                            }

                            // ================= Home › Usage =================
                            Column {
                                visible: root.page === "usage"
                                width: parent.width
                                spacing: Style.space(14)
                                Text {
                                    visible: !root.usageReady
                                    width: parent.width; wrapMode: Text.WordWrap
                                    textFormat: Text.PlainText; text: root.usageMessage
                                    color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.body
                                }
                                PanelSectionHeader { visible: root.usageReady; text: "LAST 12 MONTHS"; foreground: root.foreground; fontFamily: root.fontFamily }
                                Heatmap {
                                    visible: root.usageReady
                                    width: parent.width
                                    grid: Model.heatmap(root.usage ? root.usage.days : [], null, 52)
                                    foreground: root.foreground; muted: root.muted; accent: Commons.Color.accent; fontFamily: root.fontFamily
                                }
                                Row {
                                    visible: root.usageReady
                                    spacing: Style.space(26)
                                    BigStat { value: root.usageNumbers.wordsFull; label: "words" }
                                    BigStat { value: root.usageNumbers.dictations; label: "dictations" }
                                    BigStat { value: root.usageNumbers.spoken; label: "spoken" }
                                    BigStat { value: root.usageNumbers.wpm; label: "wpm" }
                                }
                                Text {
                                    visible: root.usageReady && root.usageNumbers.saved !== ""
                                    textFormat: Text.PlainText
                                    text: root.usageNumbers.saved + " vs typing at " + Number(root.featureValue("usage", "typing_wpm", 40)) + " wpm"
                                    color: Commons.Color.accent; font.family: root.fontFamily; font.pixelSize: Style.font.title; font.bold: true
                                }
                                Row {
                                    visible: root.usageReady
                                    width: parent.width
                                    spacing: Style.space(20)
                                    Column {
                                        width: (parent.width - parent.spacing) * 0.55
                                        spacing: Style.space(6)
                                        PanelSectionHeader { text: "WHEN YOU DICTATE"; foreground: root.foreground; fontFamily: root.fontFamily }
                                        Row {
                                            id: hourRow
                                            readonly property var bars: Model.hourBars(root.usage ? root.usage.hours : [])
                                            width: parent.width
                                            height: Style.space(44)
                                            spacing: Style.space(2)
                                            Repeater {
                                                model: hourRow.bars.bars
                                                delegate: Item {
                                                    required property var modelData
                                                    width: (hourRow.width - hourRow.spacing * 23) / 24
                                                    height: hourRow.height
                                                    Rectangle {
                                                        anchors.bottom: parent.bottom
                                                        width: parent.width
                                                        height: Math.max(modelData.value > 0 ? Style.space(2) : 0, parent.height * modelData.value)
                                                        color: Commons.Color.accent
                                                        opacity: modelData.top ? 1 : 0.55
                                                    }
                                                }
                                            }
                                        }
                                        // A minimal time axis under the bars: 00 · 12 · 23.
                                        Item {
                                            id: hourAxis
                                            width: hourRow.width
                                            height: hourAxisStart.implicitHeight
                                            readonly property real slot: (hourRow.width + hourRow.spacing) / 24
                                            Text { id: hourAxisStart; x: 0; textFormat: Text.PlainText; text: "00"; color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.caption }
                                            Text { x: hourAxis.slot * 12; textFormat: Text.PlainText; text: "12"; color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.caption }
                                            Text { anchors.right: parent.right; textFormat: Text.PlainText; text: "23"; color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.caption }
                                        }
                                        Text { textFormat: Text.PlainText; text: hourRow.bars.busiest; color: root.foreground; font.family: root.fontFamily; font.pixelSize: Style.font.body }
                                    }
                                    Column {
                                        width: (parent.width - parent.spacing) * 0.45
                                        spacing: Style.space(6)
                                        PanelSectionHeader { text: "BY MODEL"; foreground: root.foreground; fontFamily: root.fontFamily }
                                        Repeater {
                                            model: root.usage && root.usage.models ? root.usage.models.slice(0, 5) : []
                                            delegate: Item {
                                                required property var modelData
                                                required property int index
                                                width: parent.width
                                                height: modelName.implicitHeight + Style.space(4)
                                                Text {
                                                    id: modelName
                                                    anchors.left: parent.left; anchors.right: modelCount.left; anchors.rightMargin: Style.space(8)
                                                    textFormat: Text.PlainText; elide: Text.ElideRight
                                                    text: Model.sanitize(modelData.model || modelData.engine, 40)
                                                    color: index === 0 ? root.foreground : root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.body
                                                }
                                                Text {
                                                    id: modelCount
                                                    anchors.right: parent.right
                                                    textFormat: Text.PlainText; text: Model.groupedNumber(modelData.dictations)
                                                    color: index === 0 ? root.foreground : root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.body
                                                }
                                            }
                                        }
                                    }
                                }
                                Text {
                                    visible: root.usageReady && Model.healthLine(root.usage ? root.usage.health : null) !== ""
                                    width: parent.width; wrapMode: Text.WordWrap
                                    textFormat: Text.PlainText
                                    text: "󰀦  " + Model.healthLine(root.usage ? root.usage.health : null)
                                    color: root.urgent; font.family: root.fontFamily; font.pixelSize: Style.font.caption
                                }
                                Text {
                                    visible: root.usageReady
                                    width: parent.width; wrapMode: Text.WordWrap
                                    textFormat: Text.PlainText
                                    text: "Counts only, no text" + (root.usage && root.usage.since ? " · since " + Model.sanitize(root.usage.since, 20) : "") + " · turn off in Settings"
                                    color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.caption
                                }
                            }

                            // ================= 2 · Words =================
                            Column {
                                visible: root.page === "words"
                                width: parent.width
                                spacing: Style.space(10)
                                Row {
                                    width: parent.width
                                    spacing: Style.space(10)
                                    EditField {
                                        id: wordsField
                                        onPasteRequested: root.requestPaste(wordsField)
                                        width: parent.width
                                        placeholderText: "Add a word, or heard → written · type to search"
                                        foreground: root.foreground
                                        hasCursor: root.cursorIs("search")
                                        onHoveredChanged: if (hovered) root.setCursor("search", -1)
                                        onActiveFocusChanged: root.noteEditor(wordsField, activeFocus)
                                        onTextChanged: { root.cursorIndex = 0; body.contentY = 0 }
                                        Keys.onReturnPressed: root.addWord()
                                        Keys.onEscapePressed: function(event) { if (text !== "") text = ""; else keyCatcher.forceActiveFocus(); event.accepted = true }
                                        Keys.onDownPressed: function(event) { keyCatcher.forceActiveFocus(); root.setCursor("rows", 0); event.accepted = true }
                                    }
                                }
                                ButtonGroup {
                                    id: wordFilterGroup
                                    readonly property var filterOptions: Model.wordFilters(root.myWords, root.learnedWords)
                                    width: parent.width
                                    options: filterOptions
                                    value: root.wordFilter
                                    focusable: false
                                    cursorIndex: root.cursorIs("filter") ? Math.max(0, filterOptions.map(function(o) { return o.value }).indexOf(root.wordFilter)) : -1
                                    foreground: root.foreground
                                    fontFamily: root.fontFamily
                                    fontSize: Style.font.bodySmall
                                    onHovered: function(i, h) { if (h) root.setCursor("filter", -1) }
                                    onChanged: function(v) { root.wordFilter = v }
                                }
                                // Column heads, with the vocabulary's share of the
                                // model prompt on the right (learned words cost none).
                                Item {
                                    visible: root.wordsView.mine.length > 0
                                    width: parent.width
                                    height: tokenMeter.implicitHeight
                                    Text {
                                        x: Style.space(12) + parent.width * 0.32 - width
                                        textFormat: Text.PlainText; text: "HEARD"
                                        color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.caption; font.bold: true
                                    }
                                    Text {
                                        x: Style.space(12) + parent.width * 0.32 + Style.space(30)
                                        textFormat: Text.PlainText; text: "WRITTEN"
                                        color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.caption; font.bold: true
                                    }
                                    Row {
                                        anchors.right: parent.right; anchors.rightMargin: Style.space(10)
                                        spacing: Style.space(6)
                                        Text {
                                            anchors.verticalCenter: parent.verticalCenter
                                            textFormat: Text.PlainText; text: "prompt"
                                            color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.caption
                                        }
                                        Rectangle {
                                            anchors.verticalCenter: parent.verticalCenter
                                            width: Style.space(44); height: Math.max(2, Style.space(4)); radius: height / 2
                                            color: Style.hoverFillFor(root.foreground, Commons.Color.accent)
                                            Rectangle {
                                                width: parent.width * Math.min(1, root.vocabTokens / Math.max(1, root.vocabTokenLimit)); height: parent.height; radius: parent.radius
                                                color: tokenMeter.color
                                            }
                                        }
                                        Text {
                                            id: tokenMeter
                                            anchors.verticalCenter: parent.verticalCenter
                                            text: Model.tokenMeter(root.vocabTokens, root.vocabTokenLimit)
                                            textFormat: Text.PlainText
                                            color: Model.tokenLevel(root.vocabTokens, root.vocabTokenLimit) === "urgent" ? root.urgent : (Model.tokenLevel(root.vocabTokens, root.vocabTokenLimit) === "amber" ? Commons.Color.accent : root.muted)
                                            font.family: root.fontFamily; font.pixelSize: Style.font.caption; font.bold: true
                                        }
                                    }
                                }
                                Column {
                                    width: parent.width
                                    spacing: 0
                                    Repeater {
                                        model: root.wordsView.mine
                                        delegate: WordRow {
                                            required property var modelData
                                            required property int index
                                            word: modelData
                                            rowIndex: index
                                        }
                                    }
                                }
                                // Learned words: kept apart from yours; accept, promote, reject.
                                Item {
                                    visible: root.learnedGroupShown
                                    width: parent.width
                                    height: learnedHead.implicitHeight + Style.space(10)
                                    PanelSectionHeader {
                                        id: learnedHead
                                        anchors.left: parent.left; anchors.bottom: parent.bottom
                                        text: "LEARNED FROM YOUR CORRECTIONS · " + root.learnedWords.length
                                        foreground: root.foreground; fontFamily: root.fontFamily
                                    }
                                    Button {
                                        anchors.right: parent.right; anchors.bottom: parent.bottom
                                        visible: root.learnedTotal > 0
                                        text: "Reset all"; bordered: true
                                        hasCursor: root.cursorIs("learn.reset")
                                        foreground: root.foreground; fontFamily: root.fontFamily; fontSize: Style.font.caption
                                        onHovered: function(h) { if (h) root.setCursor("learn.reset", -1) }
                                        onHasCursorChanged: if (hasCursor) root.ensureVisible(this)
                                        onClicked: root.resetLearned()
                                    }
                                }
                                Column {
                                    width: parent.width
                                    spacing: 0
                                    Repeater {
                                        model: root.wordsView.learned
                                        delegate: WordRow {
                                            required property var modelData
                                            required property int index
                                            word: modelData
                                            rowIndex: root.wordsView.mine.length + index
                                        }
                                    }
                                }
                                EmptyState {
                                    visible: root.wordsView.rows.length === 0
                                    glyph: "󰗊"
                                    title: !root.loaded ? (service.busy ? "Loading your words…" : "Words unavailable") : (wordsField.text !== "" ? "Not in your words yet" : (root.wordFilter === "learned" ? "Nothing learned yet" : "No words yet"))
                                    hint: wordsField.text !== "" ? "Press Enter to add “" + Model.sanitize(wordsField.text.trim(), 60) + "”" : (root.wordFilter === "learned" ? "Fix a word in History and it shows up here." : "Names and jargon to spell right, or “heard → written” rules:\n“slash release → /release”.")
                                }
                                Text {
                                    width: parent.width; wrapMode: Text.WordWrap
                                    textFormat: Text.PlainText
                                    text: !root.caps.learned ? "Learning from your corrections " + Model.NEEDS_TUI_02 + "." : (root.learningOn ? "Shift+letter jumps (not X, which deletes) · learned words apply without a restart" : "Learning is off · learned words are paused")
                                    color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.caption
                                }
                            }

                            // ================= 3 · History =================
                            Column {
                                visible: root.page === "history"
                                width: parent.width
                                spacing: Style.space(8)
                                EditField {
                                    id: historySearch
                                    onPasteRequested: root.requestPaste(historySearch)
                                    width: parent.width
                                    visible: root.caps.history === true
                                    placeholderText: "Search history · /"
                                    foreground: root.foreground
                                    hasCursor: root.cursorIs("search")
                                    onHoveredChanged: if (hovered) root.setCursor("search", -1)
                                    onActiveFocusChanged: root.noteEditor(historySearch, activeFocus)
                                    onTextChanged: { root.cursorIndex = 0; body.contentY = 0 }
                                    Keys.onReturnPressed: { keyCatcher.forceActiveFocus(); root.setCursor("rows", 0) }
                                    Keys.onEscapePressed: function(event) { if (text !== "") text = ""; else keyCatcher.forceActiveFocus(); event.accepted = true }
                                    Keys.onDownPressed: function(event) { keyCatcher.forceActiveFocus(); root.setCursor("rows", 0); event.accepted = true }
                                }
                                Repeater {
                                    model: root.historyView
                                    delegate: Column {
                                        id: historyEntry
                                        required property var modelData
                                        width: sections.width
                                        spacing: Style.space(4)
                                        Item {
                                            visible: historyEntry.modelData.type === "day"
                                            width: parent.width
                                            height: dayLabel.implicitHeight + Style.space(12)
                                            PanelSectionHeader { id: dayLabel; anchors.left: parent.left; anchors.bottom: parent.bottom; text: String(historyEntry.modelData.label || "").toUpperCase(); foreground: root.foreground; fontFamily: root.fontFamily }
                                            Text { anchors.right: parent.right; anchors.bottom: parent.bottom; textFormat: Text.PlainText; text: historyEntry.modelData.meta || ""; color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.caption }
                                        }
                                        HistoryLine {
                                            pageName: "history"
                                            visible: historyEntry.modelData.type === "item"
                                            item: historyEntry.modelData
                                            rowIndex: historyEntry.modelData.index === undefined ? -1 : historyEntry.modelData.index
                                            expanded: root.expandedId === historyEntry.modelData.id
                                            onPicked: root.toggleExpand(historyEntry.modelData)
                                        }
                                        HistoryDetail {
                                            visible: historyEntry.modelData.type === "item" && root.expandedId === historyEntry.modelData.id
                                            item: historyEntry.modelData
                                        }
                                    }
                                }
                                Button {
                                    visible: !!root.historyNext
                                    text: "Load older"; bordered: true
                                    hasCursor: root.cursorIs("more")
                                    foreground: root.foreground; fontFamily: root.fontFamily; fontSize: Style.font.bodySmall
                                    onHovered: function(h) { if (h) root.setCursor("more", -1) }
                                    onHasCursorChanged: if (hasCursor) root.ensureVisible(this)
                                    onClicked: root.loadMoreHistory()
                                }
                                EmptyState {
                                    visible: root.historyItems.length === 0
                                    glyph: "󰋚"
                                    title: !root.caps.history ? "History " + Model.NEEDS_TUI_02 : (!root.historyLoaded ? "Loading history…" : (historySearch.text !== "" ? "Nothing matches" : (root.historyEnabled ? "No dictations yet" : "History is off")))
                                    hint: !root.caps.history ? "Update voxtype-tui to keep recent dictations here." : (root.historyEnabled ? "Each dictation shows up here, with what Voxtype heard and what it wrote." : "Turn on Save history in Settings.")
                                }
                                Item {
                                    visible: root.caps.history === true
                                    width: parent.width
                                    height: Math.max(retention.implicitHeight, clearAll.implicitHeight) + Style.space(8)
                                    Text {
                                        id: retention
                                        anchors.left: parent.left; anchors.right: clearAll.left; anchors.rightMargin: Style.space(10); anchors.verticalCenter: parent.verticalCenter
                                        wrapMode: Text.WordWrap
                                        textFormat: Text.PlainText
                                        text: Model.retentionLine(root.historyEnabled, root.historyKeepDays, root.feat.archive)
                                        color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.caption
                                    }
                                    Button {
                                        id: clearAll
                                        anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
                                        visible: root.historyList.length > 0
                                        text: "Clear all"; bordered: true
                                        hasCursor: root.cursorIs("clear")
                                        foreground: root.foreground; fontFamily: root.fontFamily; fontSize: Style.font.bodySmall
                                        onHovered: function(h) { if (h) root.setCursor("clear", -1) }
                                        onHasCursorChanged: if (hasCursor) root.ensureVisible(clearAll)
                                        onClicked: root.clearHistory()
                                    }
                                }
                            }

                            // ================= 4 · Settings (simple rows) =================
                            Column {
                                visible: root.page === "settings"
                                width: parent.width
                                spacing: Style.space(2)
                                SimpleRow { key: "model"; label: "Model"; kind: "cycle"; value: Model.sanitize(String(Model.settingValue(root.config, root.modelPath, root.status && root.status.model ? root.status.model.name || "" : "")), 40) }
                                SimpleRow { key: "drill.models"; label: "Manage models"; kind: "drill"; value: Model.modelsSummary(root.modelsEngine === root.engine ? root.modelRows : []) }
                                SimpleRow { key: "language"; label: "Language"; kind: "cycle"; visible: root.engine === "whisper"; value: Model.optionLabel(Model.LANGUAGES, String(Model.settingOr(root.config, "whisper.language"))) }
                                SimpleRow { key: "shortcut"; label: "Shortcut"; kind: "keycap"; value: root.shortcutInfo.primary !== "" ? root.shortcutInfo.primary : "none"; hint: root.shortcutInfo.hold !== "" ? "hold " + root.shortcutInfo.hold : "" }
                                SimpleRow { key: "mode"; label: "Hotkey mode"; hint: "Voxtype's own hotkey"; kind: "cycle"; value: Model.optionLabel(Model.HOTKEY_MODE_OPTIONS, String(Model.settingOr(root.config, "hotkey.mode"))) }
                                SettingsGroup { title: "WHILE DICTATING" }
                                SimpleRow { key: "indicator"; label: "Indicator"; kind: "cycle"; value: Model.optionLabel(Model.INDICATOR_OPTIONS, Model.indicatorValue(root.config)) }
                                SimpleRow { key: "sounds"; label: "Sounds"; kind: "toggle"; checked: Model.settingOr(root.config, "audio.feedback.enabled") === true }
                                SimpleRow { key: "other_audio"; label: "Other audio"; kind: "cycle"; value: Model.optionLabel(Model.OTHER_AUDIO_OPTIONS, Model.otherAudioValue(root.config)) }
                                SettingsGroup { title: "TEXT" }
                                SimpleRow { key: "output_mode"; label: "Insert text by"; kind: "cycle"; value: Model.optionLabel(Model.OUTPUT_MODE_OPTIONS, String(Model.settingOr(root.config, "output.mode"))) }
                                SimpleRow { key: "spoken_punctuation"; label: "Spoken punctuation"; kind: "toggle"; checked: Model.settingOr(root.config, "text.spoken_punctuation") === true }
                                SimpleRow { key: "filler_words"; label: "Remove filler words"; kind: "toggle"; checked: Model.settingOr(root.config, "text.filter_filler_words") === true }
                                SettingsGroup { title: "SYSTEM" }
                                SimpleRow {
                                    key: "login"; label: "Start at login"; kind: "toggle"
                                    checked: !!(root.status && root.status.daemon && root.status.daemon.starts_at_login === true)
                                    available: !!(root.status && root.status.daemon && root.status.daemon.starts_at_login !== null && root.status.daemon.starts_at_login !== undefined)
                                    reason: "systemd did not report the unit"
                                }
                                SettingsGroup { title: "HISTORY & USAGE" }
                                SimpleRow { key: "usage"; label: "Count usage"; kind: "toggle"; checked: root.featureValue("usage", "enabled", true) === true; available: root.featureOk("usage"); reason: root.featureReason("usage") }
                                SimpleRow { key: "history"; label: "Save history"; kind: "toggle"; checked: root.featureValue("history", "enabled", true) === true; available: root.featureOk("history"); reason: root.featureReason("history") }
                                SimpleRow { key: "keep"; label: "Keep for"; kind: "cycle"; value: Model.keepLabel(root.keepShown()); available: root.featureOk("history"); reason: root.featureReason("history") }
                                SimpleRow { key: "archive"; label: "Archive (your dataset)"; kind: "toggle"; checked: root.archiveOn; available: root.featureOk("archive"); reason: root.featureReason("archive") }
                                SimpleRow { key: "archive.dir"; visible: root.archiveOn; label: "   Folder"; kind: "drill"; value: Model.sanitize(root.featureValue("archive", "dir", null) || "~/Documents/Voxtype", 48) }
                                SimpleRow { key: "archive.audio"; visible: root.archiveOn; label: "   Save audio"; kind: "toggle"; hint: "separate recording of your mic"; checked: root.featureValue("archive", "save_audio", true) === true }
                                SimpleRow { key: "archive.text"; visible: root.archiveOn; label: "   Save text"; kind: "toggle"; checked: root.featureValue("archive", "save_text", true) === true }
                                SettingsGroup { title: "LEARNING" }
                                SimpleRow { key: "learning"; label: "Learn from corrections"; kind: "toggle"; checked: root.learningOn; available: root.featureOk("learning"); reason: root.featureReason("learning") }
                                SimpleRow {
                                    key: "everywhere"; visible: root.learningOn && root.featureOk("everywhere") && !!root.caps.features
                                    label: "Learn everywhere"; kind: "drill"
                                    value: root.featureValue("learning", "everywhere", false) === true ? "on" : "off"
                                    hint: "also from browsers and apps"
                                }
                                EverywhereCard {
                                    id: everywhereCard
                                    visible: root.everywhereOpen
                                    // Opened below the fold, and it grows when the preview arrives.
                                    onVisibleChanged: if (visible) Qt.callLater(root.ensureVisible, everywhereCard)
                                    onImplicitHeightChanged: if (visible) Qt.callLater(root.ensureVisible, everywhereCard)
                                }
                                SettingsGroup { title: "MORE" }
                                SimpleRow { key: "drill.advanced"; label: "All Voxtype settings"; kind: "drill"; badge: root.advancedChanged > 0 ? root.advancedChanged + " changed" : ""; value: "hotkey, audio, output, GPU…" }
                                SimpleRow { key: "drill.backup"; label: "Backup"; kind: "drill"; value: "export / import" }
                                Item { width: 1; height: Style.space(4) }
                            }

                            // ============ Settings › All Voxtype settings ============
                            Column {
                                id: settingsForm
                                visible: root.page === "advanced"
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
                                        options: Model.engineOptions(root.options, root.engine) }
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
                                SettingNumber { visible: Model.settingOr(root.config, "audio.duck_media") === true; settingKey: "audio.duck_media_volume_percent"; label: "Lowered volume (%)"; from: 0; to: 150; stepSize: 5; fallback: 34 }

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
                                SettingToggle { settingKey: "output.restore_clipboard"; label: "Restore clipboard"; description: "Put the previous clipboard back after a paste"; fallback: false }
                                SettingToggle { settingKey: "output.shift_enter_newlines"; label: "Shift+Enter for new lines"; description: "So chat apps don't send early"; fallback: false }

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
                                PanelSectionHeader { text: "INDICATOR DETAILS"; foreground: root.foreground; fontFamily: root.fontFamily }
                                Row {
                                    width: parent.width
                                    spacing: Style.space(10)
                                    SettingDropdown { settingKey: "osd.position"; label: "Position"; width: (parent.width - parent.spacing) / 2; fallback: "bottom-center"
                                        options: Model.plainOptions(Model.OSD_POSITIONS) }
                                    SettingSlider { settingKey: "osd.opacity"; label: "Opacity"; width: (parent.width - parent.spacing) / 2; fallback: 0.95 }
                                }
                                Row {
                                    width: parent.width
                                    spacing: Style.space(10)
                                    // Unset = the package decides the colours (u resets it).
                                    SettingDropdown { settingKey: "osd.palette"; label: "Colours"; width: (parent.width - parent.spacing) / 2; fallback: "package"
                                        options: Model.plainOptions(["omarchy", "package", "fallback", "custom"]) }
                                    SettingDropdown { settingKey: "osd.frontend"; label: "Drawn by"; width: (parent.width - parent.spacing) / 2; fallback: "gtk4"
                                        options: Model.plainOptions(["gtk4", "native", "quickshell"]) }
                                }

                                PanelSeparator { width: parent.width; foreground: root.foreground }
                                PanelSectionHeader { text: "NOTIFICATIONS"; foreground: root.foreground; fontFamily: root.fontFamily }
                                SettingToggle { settingKey: "output.notification.on_transcription"; label: "Show the text"; description: "A notification with each transcription"; fallback: true }
                                SettingToggle { settingKey: "output.notification.on_recording_start"; label: "Recording started"; fallback: false }
                                SettingToggle { settingKey: "output.notification.on_recording_stop"; label: "Recording stopped"; fallback: false }
                                SettingToggle { settingKey: "output.notification.on_no_speech"; label: "No speech heard"; fallback: true }
                                SettingDropdown { settingKey: "output.notification.urgency"; label: "Urgency"; width: parent.width / 2; fallback: "normal"
                                    options: Model.plainOptions(["low", "normal", "critical"]) }

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

                            // ============ Settings › Manage models ============
                            Column {
                                visible: root.page === "models"
                                width: parent.width
                                spacing: Style.space(10)
                                Row {
                                    width: parent.width
                                    spacing: Style.space(10)
                                    Dropdown {
                                        id: engineDropdown
                                        width: Style.spacing.dropdownWidth
                                        label: "Engine"
                                        value: root.modelsView
                                        options: Model.engineOptions(root.options, root.modelsView)
                                        foreground: root.foreground; fontFamily: root.fontFamily
                                        hasCursor: root.cursorIs("engine")
                                        onHovered: function(h) { if (h) root.setCursor("engine", -1) }
                                        onHasCursorChanged: if (hasCursor) root.ensureVisible(engineDropdown)
                                        onPopupOpenChanged: root.notePopup(popupOpen)
                                        onChanged: function(v) { root.pickModelsEngine(v) }
                                    }
                                    Text {
                                        anchors.bottom: parent.bottom; anchors.bottomMargin: Style.space(8)
                                        textFormat: Text.PlainText
                                        text: root.options && root.options.compiled_engines && root.options.compiled_engines.indexOf(root.modelsView) < 0 ? "󰀦 not compiled into this voxtype build" : (root.modelsLoading ? "" : root.modelRows.length + " models in catalog")
                                        color: root.options && root.options.compiled_engines && root.options.compiled_engines.indexOf(root.modelsView) < 0 ? root.urgent : root.muted
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
                                            color: Style.selectedFillFor(root.foreground, Commons.Color.accent)
                                            Rectangle { width: parent.width * service.downloadProgress / 100; height: parent.height; radius: parent.radius; color: Commons.Color.accent
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
                                    model: root.modelsEngine === root.modelsView ? root.modelRows : []
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
                                                color: modelRow.modelData.downloaded && !Model.modelUnavailable(modelRow.modelData) ? root.foreground : root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.subtitle; font.bold: modelRow.modelData.active === true }
                                            Text { width: parent.width; text: Model.modelLine(modelRow.modelData); textFormat: Text.PlainText; elide: Text.ElideRight
                                                color: modelRow.modelData.active ? Commons.Color.accent : root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.caption }
                                        }
                                        Row {
                                            id: modelActions
                                            anchors.right: parent.right; anchors.rightMargin: Style.space(8); anchors.verticalCenter: parent.verticalCenter
                                            spacing: Style.space(4)
                                            opacity: modelRow.hasCursor ? 1 : 0
                                            enabled: modelRow.hasCursor && !service.mutating
                                            PanelActionButton { visible: !Model.modelNeedsDownload(modelRow.modelData) && !Model.modelUnavailable(modelRow.modelData) && !modelRow.modelData.active; iconText: "󰄬"; foreground: root.foreground; tooltipText: "Enter · set active"; onClicked: root.setActiveModel(modelRow.modelData) }
                                            PanelActionButton { visible: Model.modelNeedsDownload(modelRow.modelData) && !Model.modelUnavailable(modelRow.modelData); iconText: "󰇚"; foreground: root.foreground; tooltipText: "d · download"; enabled: !service.downloading; onClicked: root.startDownload(modelRow.modelData) }
                                            PanelActionButton { visible: modelRow.modelData.downloaded && !modelRow.modelData.active; iconText: "󰆴"; foreground: root.foreground; hoverColor: root.urgent; tooltipText: "x · delete from disk"; onClicked: { root.setCursor("rows", modelRow.index); root.deleteSelected() } }
                                        }
                                    }
                                }
                                EmptyState {
                                    visible: root.modelsEngine !== root.modelsView || root.modelRows.length === 0
                                    glyph: root.modelsLoading ? "󰔟" : "󰆼"
                                    title: root.modelsLoading ? "Reading the model catalog…" : "No models known for " + Model.engineLabel(root.options, root.modelsView)
                                    hint: root.modelsLoading ? "" : "Models live under the voxtype data directory."
                                }

                                Item { width: 1; height: Style.space(4) }
                            }

                            // ============ Settings › Backup ============
                            Column {
                                visible: root.page === "backup"
                                width: parent.width
                                spacing: Style.space(10)
                                Text {
                                    width: parent.width; wrapMode: Text.WordWrap
                                    textFormat: Text.PlainText
                                    text: "Export your words, rules and settings to a file, or import a voxtype-tui bundle. Imports are previewed before anything is written."
                                    color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.body
                                }
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
                                        EditField {
                                            id: exportPath
                                            onPasteRequested: root.requestPaste(exportPath)
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
                            idleText: root.locked ? "" : Model.footerIdle(root.status)
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
                            text: root.locked ? (root.canInstallLocked ? "Enter install   y copy   Esc close" : (root.lockedCommand !== "" ? "Enter copy   Esc close" : "Esc close")) : Model.sectionHints(root.section, {editing: root.editing, cursorActive: root.cursorActive, view: root.view, fixing: root.fixStage === "pick", fixField: root.fixStage === "type", rowKind: root.cursorWord() ? root.cursorWord().kind : ""})
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
                onCanceled: { opened = false; root.confirmAction = ""; root.confirmPayload = null; root.importAcceptDangerous = false; root.importReview = ""; root.keepPending = false; keyCatcher.forceActiveFocus() }
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
        Text { width: parent.width; text: cell.value; textFormat: Text.PlainText; elide: Text.ElideRight; color: cell.accent ? Commons.Color.accent : root.foreground; font.family: root.fontFamily; font.pixelSize: Style.font.subtitle }
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
    // A whole-number setting. Not qs.Ui NumberField: its SpinBox edits through
    // a Qt TextInput, which reads the clipboard inside the shell (see
    // EditField.qml). Typing, ↑↓ and the step arrows all commit through
    // Model.clampNumber, so a value outside [from, to] never reaches the bridge.
    component SettingNumber: Column {
        id: numberRow
        required property string settingKey
        property string label: ""
        property int fallback: 0
        property int from: 0
        property int to: 100
        property int stepSize: 1
        readonly property bool isSet: Model.settingIsSet(root.config, settingKey)
        readonly property int current: Model.clampNumber(Model.settingValue(root.config, settingKey, fallback), from, to, fallback)
        function activate() { number.forceActiveFocus(); number.selectAll() }
        function sync() { if (!number.activeFocus) number.text = String(current) }
        function commit(value) {
            var next = Model.clampNumber(value, from, to, current);
            number.text = String(next);
            if (next !== current) root.setSetting(settingKey, next);
        }
        function step(direction) { commit(Model.clampNumber(number.text, from, to, current) + direction * stepSize) }
        width: Style.space(150)
        spacing: Style.spacing.labelGap
        Component.onCompleted: sync()
        onCurrentChanged: sync()
        SettingLabel { settingKey: numberRow.settingKey; label: numberRow.label; hasCursor: root.cursorIs(numberRow.settingKey); isSet: numberRow.isSet }
        EditField {
            id: number
            onPasteRequested: root.requestPaste(number)
            width: Style.spacing.numberFieldWidth
            horizontalAlignment: TextEdit.AlignHCenter
            allowedChars: numberRow.from < 0 ? /[-0-9]/ : /[0-9]/
            maximumLength: Math.max(String(numberRow.from).length, String(numberRow.to).length)
            rightInset: stepper.width
            foreground: root.foreground
            placeholderColor: root.muted
            hasCursor: root.cursorIs(numberRow.settingKey)
            onHoveredChanged: if (hovered) root.setCursor(numberRow.settingKey, -1)
            onHasCursorChanged: if (hasCursor) root.ensureVisible(numberRow)
            onActiveFocusChanged: { root.noteEditor(numberRow, activeFocus); if (!activeFocus) numberRow.commit(text) }
            Keys.onReturnPressed: { numberRow.commit(text); keyCatcher.forceActiveFocus() }
            Keys.onEnterPressed: { numberRow.commit(text); keyCatcher.forceActiveFocus() }
            Keys.onUpPressed: numberRow.step(1)
            Keys.onDownPressed: numberRow.step(-1)
            Keys.onEscapePressed: function(event) { number.text = String(numberRow.current); keyCatcher.forceActiveFocus(); event.accepted = true }
            Column {
                id: stepper
                anchors.right: parent.right
                anchors.rightMargin: Style.spacing.controlPaddingX
                anchors.verticalCenter: parent.verticalCenter
                Repeater {
                    model: [1, -1]
                    delegate: Text {
                        required property int modelData
                        textFormat: Text.PlainText
                        text: modelData > 0 ? "▴" : "▾"
                        color: stepArea.containsMouse ? root.foreground : root.muted
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                        MouseArea {
                            id: stepArea
                            anchors.fill: parent
                            anchors.margins: -Style.space(2)
                            hoverEnabled: true
                            onClicked: numberRow.step(parent.modelData)
                        }
                    }
                }
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
        EditField {
            id: input
            onPasteRequested: root.requestPaste(input)
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

    // ---- layout B pieces ------------------------------------------------------
    // A key name in a thin box: "Super+Ctrl+X".
    component Keycap: Rectangle {
        id: cap
        property string text: ""
        implicitWidth: capText.implicitWidth + Style.space(14)
        implicitHeight: capText.implicitHeight + Style.space(6)
        color: Style.hoverFillFor(root.foreground, Commons.Color.accent)
        border.width: Math.max(1, Style.normalBorderWidth)
        border.color: root.muted
        radius: Style.cornerRadius
        Text {
            id: capText
            anchors.centerIn: parent
            textFormat: Text.PlainText; text: cap.text
            color: root.foreground; font.family: root.fontFamily; font.pixelSize: Style.font.body
        }
    }
    // Section header with a right-aligned link ("usage ›").
    component SectionHead: Item {
        id: head
        property string title: ""
        property string trailing: ""
        signal trailingClicked()
        width: parent ? parent.width : implicitWidth
        height: Math.max(headTitle.implicitHeight, headLink.implicitHeight)
        PanelSectionHeader { id: headTitle; anchors.left: parent.left; anchors.verticalCenter: parent.verticalCenter; text: head.title; foreground: root.foreground; fontFamily: root.fontFamily }
        Text {
            id: headLink
            anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
            textFormat: Text.PlainText; text: head.trailing
            color: linkArea.containsMouse ? root.foreground : root.muted
            font.family: root.fontFamily; font.pixelSize: Style.font.caption
            MouseArea { id: linkArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: head.trailingClicked() }
        }
    }
    component Stat: Row {
        id: stat
        property string value: ""
        property string label: ""
        spacing: Style.space(5)
        Text { textFormat: Text.PlainText; text: stat.value; color: root.foreground; font.family: root.fontFamily; font.pixelSize: Style.font.subtitle; font.bold: true }
        Text { textFormat: Text.PlainText; text: stat.label; color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.subtitle }
    }
    component BigStat: Column {
        id: big
        property string value: ""
        property string label: ""
        spacing: Style.space(2)
        Text { textFormat: Text.PlainText; text: big.value; color: root.foreground; font.family: root.fontFamily; font.pixelSize: Style.font.display; font.bold: true }
        Text { textFormat: Text.PlainText; text: big.label; color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.body }
    }
    component SettingsGroup: Item {
        id: group
        property string title: ""
        width: parent ? parent.width : implicitWidth
        height: groupTitle.implicitHeight + Style.space(16)
        PanelSectionHeader { id: groupTitle; anchors.left: parent.left; anchors.bottom: parent.bottom; anchors.bottomMargin: Style.space(4); text: group.title; foreground: root.foreground; fontFamily: root.fontFamily }
    }
    // One Settings row: label left; on the right a ‹ value › cycler, a
    // switch, a key cap or "value ›" for a drill-in. Enter / ←→ change it.
    component SimpleRow: CursorSurface {
        id: simple
        required property string key
        property string label: ""
        property string kind: "cycle"
        property string value: ""
        property string hint: ""
        property string badge: ""
        property bool checked: false
        property bool available: true
        property string reason: ""
        readonly property bool rowHasCursor: root.page === "settings" && root.cursorIs(key)
        width: parent ? parent.width : implicitWidth
        implicitHeight: Math.max(Style.spacing.popupRowHeight + Style.space(6), simpleLabel.implicitHeight + Style.space(12))
        hasCursor: rowHasCursor
        foreground: root.foreground
        onHasCursorChanged: if (hasCursor) root.ensureVisible(simple)
        MouseArea {
            anchors.fill: parent; hoverEnabled: true; cursorShape: simple.available ? Qt.PointingHandCursor : Qt.ArrowCursor
            onEntered: root.setCursor(simple.key, -1)
            onClicked: if (simple.available) root.activateSimple(simple.key)
        }
        Text {
            id: simpleLabel
            anchors.left: parent.left; anchors.leftMargin: Style.spacing.rowPaddingX; anchors.verticalCenter: parent.verticalCenter
            textFormat: Text.PlainText; text: simple.label
            color: simple.available ? root.foreground : root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.body
        }
        Text {
            anchors.left: simpleLabel.right; anchors.leftMargin: Style.space(10); anchors.right: simpleRight.left; anchors.rightMargin: Style.space(10)
            anchors.verticalCenter: parent.verticalCenter
            visible: text !== ""
            textFormat: Text.PlainText; elide: Text.ElideRight
            text: !simple.available ? Model.sanitize(simple.reason, 60) : simple.hint
            color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.caption
        }
        Row {
            id: simpleRight
            anchors.right: parent.right; anchors.rightMargin: Style.spacing.rowPaddingX; anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(8)
            visible: simple.available
            Rectangle {
                visible: simple.badge !== ""
                anchors.verticalCenter: parent.verticalCenter
                implicitWidth: badgeText.implicitWidth + Style.space(10); implicitHeight: badgeText.implicitHeight + Style.space(4)
                color: "transparent"; border.width: Math.max(1, Style.normalBorderWidth); border.color: Commons.Color.accent; radius: Style.cornerRadius
                Text { id: badgeText; anchors.centerIn: parent; textFormat: Text.PlainText; text: simple.badge; color: Commons.Color.accent; font.family: root.fontFamily; font.pixelSize: Style.font.caption }
            }
            Text {
                visible: simple.kind === "cycle" && simple.rowHasCursor
                anchors.verticalCenter: parent.verticalCenter
                textFormat: Text.PlainText; text: "‹"; color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.body
                MouseArea { anchors.fill: parent; anchors.margins: -Style.space(4); onClicked: root.cycleSimple(simple.key, -1) }
            }
            Text {
                visible: simple.kind === "cycle" || simple.kind === "drill"
                anchors.verticalCenter: parent.verticalCenter
                textFormat: Text.PlainText; text: Model.sanitize(simple.value, 60)
                color: simple.kind === "drill" ? root.muted : root.foreground; font.family: root.fontFamily; font.pixelSize: Style.font.body
            }
            Text {
                visible: simple.kind === "drill" || (simple.kind === "cycle" && simple.rowHasCursor)
                anchors.verticalCenter: parent.verticalCenter
                textFormat: Text.PlainText; text: "›"; color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.body
                MouseArea { anchors.fill: parent; anchors.margins: -Style.space(4); onClicked: simple.kind === "cycle" ? root.cycleSimple(simple.key, 1) : root.activateSimple(simple.key) }
            }
            Keycap { visible: simple.kind === "keycap"; anchors.verticalCenter: parent.verticalCenter; text: Model.sanitize(simple.value, 60) }
            ToggleSwitch {
                visible: simple.kind === "toggle"
                anchors.verticalCenter: parent.verticalCenter
                checked: simple.checked
                hasCursor: simple.rowHasCursor
                cursorRing: false
                foreground: root.foreground
                onToggled: root.activateSimple(simple.key)
            }
        }
    }
    // One Words row: heard → written, a type tag; learned rows add a state.
    component WordRow: CursorSurface {
        id: wordRow
        property var word: ({})
        property int rowIndex: -1
        readonly property bool learned: word.kind === "learned"
        width: parent ? parent.width : implicitWidth
        implicitHeight: Style.spacing.popupRowHeight
        hasCursor: root.page === "words" && root.rowHasCursor(rowIndex)
        foreground: root.foreground
        onHasCursorChanged: if (hasCursor) root.ensureVisible(wordRow)
        MouseArea { anchors.fill: parent; hoverEnabled: true; onEntered: root.setCursor("rows", wordRow.rowIndex); onClicked: { root.setCursor("rows", wordRow.rowIndex); root.activateCursor() } }
        Text {
            id: heardText
            anchors.left: parent.left; anchors.leftMargin: Style.space(12); anchors.verticalCenter: parent.verticalCenter
            width: parent.width * 0.32
            horizontalAlignment: Text.AlignRight
            textFormat: Text.PlainText; elide: Text.ElideLeft
            text: wordRow.word.heard ? Model.sanitize(wordRow.word.heard, 80) : "–"
            color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.body
        }
        Text {
            id: arrowText
            anchors.left: heardText.right; anchors.leftMargin: Style.space(10); anchors.verticalCenter: parent.verticalCenter
            textFormat: Text.PlainText; text: "→"; color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.body
        }
        Text {
            anchors.left: arrowText.right; anchors.leftMargin: Style.space(10); anchors.right: wordTags.left; anchors.rightMargin: Style.space(8)
            anchors.verticalCenter: parent.verticalCenter
            textFormat: Text.PlainText; elide: Text.ElideRight
            text: Model.sanitize(wordRow.word.written, 120)
            color: root.foreground; font.family: root.fontFamily; font.pixelSize: Style.font.subtitle
        }
        Row {
            id: wordTags
            anchors.right: parent.right; anchors.rightMargin: Style.space(10); anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(6)
            Tag { anchors.verticalCenter: parent.verticalCenter; text: wordRow.word.tag || ""; tone: "muted" }
            Tag { anchors.verticalCenter: parent.verticalCenter; visible: wordRow.learned; text: wordRow.word.stateLabel || ""; tone: wordRow.word.state === "suggested" ? "muted" : "accent" }
            // Mouse deletion, as in the old Vocabulary/Dictionary rows: the
            // same confirmation as x (ConfirmDialog, Cancel first).
            PanelActionButton {
                visible: wordRow.hasCursor && (wordRow.word.kind === "vocab" || wordRow.word.kind === "rule")
                anchors.verticalCenter: parent.verticalCenter
                iconText: "󰆴"; foreground: root.foreground; hoverColor: root.urgent
                tooltipText: wordRow.word.kind === "rule" ? "x · delete rule" : "x · remove word"
                enabled: !service.mutating
                onClicked: { root.setCursor("rows", wordRow.rowIndex); root.deleteSelected() }
            }
        }
    }
    component Tag: Rectangle {
        id: tag
        property string text: ""
        property string tone: "muted"
        visible: text !== ""
        implicitWidth: tagText.implicitWidth + Style.space(12)
        implicitHeight: tagText.implicitHeight + Style.space(4)
        color: "transparent"
        border.width: Math.max(1, Style.normalBorderWidth)
        border.color: tone === "accent" ? Commons.Color.accent : root.muted
        radius: Style.cornerRadius
        Text { id: tagText; anchors.centerIn: parent; textFormat: Text.PlainText; text: tag.text; color: tag.tone === "accent" ? Commons.Color.accent : root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.caption }
    }
    // A dictation: "14:32  first words of the text…  16w".
    component HistoryLine: CursorSurface {
        id: line
        property var item: ({})
        property int rowIndex: -1
        property string pageName: "history"
        property bool expanded: false
        signal picked()
        width: parent ? parent.width : implicitWidth
        implicitHeight: Style.spacing.popupRowHeight
        hasCursor: root.page === pageName && root.rowHasCursor(rowIndex)
        current: expanded
        foreground: root.foreground
        onHasCursorChanged: if (hasCursor) root.ensureVisible(line)
        MouseArea { anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onEntered: root.setCursor("rows", line.rowIndex); onClicked: { root.setCursor("rows", line.rowIndex); line.picked() } }
        Text {
            id: lineTime
            anchors.left: parent.left; anchors.leftMargin: Style.space(12); anchors.verticalCenter: parent.verticalCenter
            textFormat: Text.PlainText; text: line.item.time || ""
            color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.body
        }
        Text {
            anchors.left: lineTime.right; anchors.leftMargin: Style.space(14); anchors.right: lineWords.left; anchors.rightMargin: Style.space(12)
            anchors.verticalCenter: parent.verticalCenter
            textFormat: Text.PlainText; elide: Text.ElideRight
            text: Model.sanitize(line.item.text, 200)
            color: root.foreground; font.family: root.fontFamily; font.pixelSize: Style.font.body
        }
        Text {
            id: lineWords
            anchors.right: parent.right; anchors.rightMargin: Style.space(12); anchors.verticalCenter: parent.verticalCenter
            textFormat: Text.PlainText; text: (line.item.words || 0) + "w"
            color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.caption
        }
    }
    // The expanded dictation: full text, what Voxtype heard, actions, Fix.
    component HistoryDetail: Item {
        id: detail
        property var item: ({})
        readonly property var record: item.record || ({})
        readonly property bool fixing: root.fixId !== "" && root.fixId === item.id
        readonly property bool rewritten: Model.changedByRules(record.raw, record.final)
        width: parent ? parent.width : implicitWidth
        implicitHeight: detailColumn.implicitHeight + Style.space(16)
        Rectangle { anchors.left: parent.left; anchors.top: parent.top; anchors.bottom: parent.bottom; width: Math.max(2, Style.normalBorderWidth * 2); color: Commons.Color.accent }
        Column {
            id: detailColumn
            anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top
            anchors.leftMargin: Style.space(18); anchors.rightMargin: Style.space(8); anchors.topMargin: Style.space(8)
            spacing: Style.space(8)
            Text {
                width: parent.width; wrapMode: Text.WordWrap
                textFormat: Text.PlainText
                text: Model.historyDetailText(detail.record)
                color: root.foreground; font.family: root.fontFamily; font.pixelSize: Style.font.subtitle
            }
            // The bridge shortened a dictation too large for one response.
            Text {
                visible: detail.record.truncated === true
                width: parent.width; wrapMode: Text.WordWrap
                textFormat: Text.PlainText
                text: detail.record.oversized === true ? "Too large to load here · open it with voxtype-tui" : "Only the start is shown · too long to load in full, so Fix a word is off for it"
                color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.caption
            }
            // What Voxtype heard, changed words in the accent colour.
            Flow {
                visible: detail.rewritten
                width: parent.width
                spacing: Style.space(5)
                Text { textFormat: Text.PlainText; text: "heard:"; color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.body }
                Repeater {
                    model: detail.rewritten ? Model.diffWords(detail.record.raw, detail.record.final) : []
                    delegate: Text {
                        required property var modelData
                        textFormat: Text.PlainText; text: modelData.text
                        color: modelData.changed ? Commons.Color.accent : root.muted
                        font.family: root.fontFamily; font.pixelSize: Style.font.body; font.underline: modelData.changed
                    }
                }
            }
            Text {
                visible: !!detail.record.model || detail.record.duration_s !== undefined
                textFormat: Text.PlainText
                text: [detail.record.model ? Model.sanitize(detail.record.model, 40) : "", detail.record.duration_s ? Math.round(detail.record.duration_s * 10) / 10 + " s" : "",
                       detail.record.app && detail.record.app["class"] ? Model.sanitize(detail.record.app["class"], 30) : ""].filter(function(x) { return x !== "" }).join("  ·  ")
                color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.caption
            }
            Row {
                visible: !detail.fixing
                spacing: Style.space(8)
                Button { text: "Copy"; iconText: "󰆏"; bordered: true; foreground: root.foreground; fontFamily: root.fontFamily; fontSize: Style.font.bodySmall; tooltipText: "c · copy the text"
                    onClicked: root.copyRecord(detail.item) }
                Button { text: "Fix a word"; iconText: "󰏫"; bordered: true; foreground: root.foreground; fontFamily: root.fontFamily; fontSize: Style.font.bodySmall
                    enabled: !!root.caps.learned && root.learningOn && detail.record.truncated !== true
                    tooltipText: !root.caps.learned ? "Fix a word " + Model.NEEDS_TUI_02 : (detail.record.truncated === true ? "Too long to fix here" : (root.learningOn ? "f · teach Voxtype the right word" : "Learning is off in Settings"))
                    onClicked: root.startFixFor(detail.item) }
                Button { text: "Delete"; iconText: "󰆴"; bordered: true; foreground: root.foreground; fontFamily: root.fontFamily; fontSize: Style.font.bodySmall; tooltipText: "x · delete from history"
                    onClicked: root.deleteHistory(detail.item) }
            }
            // Fix a word: pick the misheard word(s), type the right one,
            // choose how to learn it, Teach.
            Column {
                visible: detail.fixing
                width: parent.width
                spacing: Style.space(8)
                Text {
                    textFormat: Text.PlainText
                    text: root.fixStage === "pick" ? "Fix a word — pick what was misheard (←→, ] for more, Enter):" : "Fix a word"
                    color: root.foreground; font.family: root.fontFamily; font.pixelSize: Style.font.body
                }
                Flow {
                    width: parent.width
                    spacing: Style.space(4)
                    Text {
                        visible: detail.fixing && root.fixWindow.from > 0
                        textFormat: Text.PlainText; text: "… " + root.fixWindow.from + " words before"
                        color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.caption
                    }
                    Repeater {
                        model: detail.fixing ? root.fixWindow.tokens : []
                        delegate: Button {
                            required property var modelData
                            readonly property bool inSpan: modelData.index >= root.fixStart && modelData.index <= root.fixEnd
                            text: Model.sanitize(modelData.raw, 40)
                            bordered: inSpan
                            selected: inSpan
                            foreground: inSpan ? Commons.Color.accent : root.foreground
                            fontFamily: root.fontFamily; fontSize: Style.font.body
                            horizontalPadding: Style.space(5)
                            onClicked: root.pickFixWord(modelData.index, root.fixStage === "pick" && modelData.index === root.fixEnd + 1)
                        }
                    }
                    Text {
                        visible: detail.fixing && root.fixWindow.to < root.fixTokens.length
                        textFormat: Text.PlainText; text: (root.fixTokens.length - root.fixWindow.to) + " more words · → reaches them"
                        color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.caption
                    }
                }
                Row {
                    width: parent.width
                    spacing: Style.space(10)
                    Text { anchors.verticalCenter: parent.verticalCenter; textFormat: Text.PlainText; text: "should be"; color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.body }
                    EditField {
                        id: fixEdit
                        onPasteRequested: root.requestPaste(fixEdit)
                        width: parent.width - Style.space(90)
                        placeholderText: root.fixStage === "pick" ? "press Enter after picking the word" : "the right spelling"
                        foreground: root.foreground
                        onVisibleChanged: if (visible) root.fixField = fixEdit
                        Component.onCompleted: if (visible) root.fixField = fixEdit
                        onActiveFocusChanged: { root.noteEditor(fixEdit, activeFocus); if (activeFocus && root.fixStage === "pick") root.confirmFixSpan() }
                        Keys.onReturnPressed: root.submitFix()
                        Keys.onEnterPressed: root.submitFix()
                        Keys.onUpPressed: root.cycleFixKind(-1)
                        Keys.onDownPressed: root.cycleFixKind(1)
                        Keys.onEscapePressed: function(event) { root.cancelFix(); event.accepted = true }
                    }
                }
                Row {
                    id: teachRow
                    spacing: Style.space(10)
                    // Keep the whole Fix block on screen as it opens and moves on.
                    Connections {
                        target: root
                        function onFixStageChanged() { if (detail.fixing) Qt.callLater(root.ensureVisible, teachRow) }
                    }
                    Text { anchors.verticalCenter: parent.verticalCenter; textFormat: Text.PlainText; text: "teach as"; color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.body }
                    ButtonGroup {
                        anchors.verticalCenter: parent.verticalCenter
                        options: Model.FIX_KINDS
                        value: root.fixKind
                        focusable: false
                        foreground: root.foreground; fontFamily: root.fontFamily; fontSize: Style.font.bodySmall
                        onChanged: function(v) { root.fixKind = v }
                    }
                    Button { text: "Cancel"; bordered: true; foreground: root.foreground; fontFamily: root.fontFamily; fontSize: Style.font.bodySmall; onClicked: root.cancelFix() }
                    Button { text: "Teach"; bordered: true; foreground: Commons.Color.accent; fontFamily: root.fontFamily; fontSize: Style.font.bodySmall
                        enabled: root.fixStage === "type" && !service.mutating; onClicked: root.submitFix() }
                }
            }
        }
    }
    // "Learn everywhere": exactly which files it writes, and that it needs a
    // re-login. Nothing is written until the user presses Turn on.
    component EverywhereCard: CursorSurface {
        id: everywhere
        readonly property var preview: root.everywherePreview
        readonly property bool on: root.featureValue("learning", "everywhere", false) === true
        width: parent ? parent.width : implicitWidth
        bordered: true
        foreground: root.foreground
        implicitHeight: everyColumn.implicitHeight + Style.space(20)
        Column {
            id: everyColumn
            anchors.left: parent.left; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
            anchors.margins: Style.space(12)
            spacing: Style.space(6)
            Text {
                width: parent.width; wrapMode: Text.WordWrap; textFormat: Text.PlainText
                text: everywhere.on ? "Learn everywhere is on. Turning it off removes only what it added:" : "Lets browsers and apps show their text to Voxtype, so a correction you type in place can be learned. It writes:"
                color: root.foreground; font.family: root.fontFamily; font.pixelSize: Style.font.body
            }
            Repeater {
                model: Model.everywhereFiles(everywhere.preview)
                delegate: Text {
                    required property var modelData
                    width: everyColumn.width; wrapMode: Text.WrapAnywhere; textFormat: Text.PlainText
                    text: modelData.text
                    color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.caption
                }
            }
            Text {
                visible: !everywhere.preview
                textFormat: Text.PlainText; text: root.unavailable["learn.everywhere.preview"] ? Model.sanitize(root.unavailable["learn.everywhere.preview"], 80) : "Reading what it would change…"
                color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.caption
            }
            Text {
                visible: !!everywhere.preview && everywhere.preview.needs_relogin !== false
                textFormat: Text.PlainText; text: "Log out and back in afterwards. Terminals still learn through History › Fix."
                color: root.muted; font.family: root.fontFamily; font.pixelSize: Style.font.caption
            }
            Row {
                spacing: Style.space(8)
                Button { text: everywhere.on ? "Turn off" : "Turn on"; bordered: true; foreground: root.foreground; fontFamily: root.fontFamily; fontSize: Style.font.bodySmall
                    enabled: !!everywhere.preview && !service.mutating; onClicked: root.setEverywhere(!everywhere.on) }
                Button { text: "Close"; bordered: true; foreground: root.foreground; fontFamily: root.fontFamily; fontSize: Style.font.bodySmall; onClicked: root.everywhereOpen = false }
            }
        }
    }
}
