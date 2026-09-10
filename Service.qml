import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

// Process wiring only — no UI. Speaks the JSON-over-stdio protocol from
// docs/DESIGN.md to bridge.py, streams model downloads, toggles recording
// and polls the daemon state file for the bar button.
Item {
    id: root
    readonly property string pythonBinary: "/usr/bin/python3"
    readonly property string bridgePath: decodeURIComponent(Qt.resolvedUrl("bridge.py").toString().replace(/^file:\/\//, ""))
    readonly property string stateFilePath: Quickshell.env("XDG_RUNTIME_DIR") + "/voxtype/state"

    property bool busy: false
    property var request: ({})
    property bool timedOut: false
    property int workerGeneration: 0
    property var queue: []

    property bool downloading: false
    property string downloadEngine: ""
    property string downloadName: ""
    property real downloadProgress: 0
    property var downloadLog: []
    property bool downloadFinished: false
    property int downloadGeneration: 0

    property bool recording: false
    property int recordGeneration: 0

    property bool picking: false
    property int pickerGeneration: 0

    property string daemonState: "unknown"
    property bool pollState: false
    property int pollIntervalMs: 1500

    signal completed(string op, var result, var request)
    signal downloadDone(string engine, string name, bool ok, string reason)
    signal recordFinished(bool ok)
    signal picked(string path)
    signal pickCanceled()

    // One bridge call at a time. Later requests queue in order so a write
    // never races a status poll for the same config file; status polls are
    // dropped when one is already waiting.
    function run(payload) {
        if (busy) {
            if (payload.op === "status" && queue.some(function(q) { return q.op === "status" })) return false;
            queue = queue.concat([payload]);
            return true;
        }
        request = payload;
        busy = true;
        timedOut = false;
        workerGeneration++;
        deadline.interval = payload.op === "daemon.restart" ? 30000 : 15000;
        worker.running = true;
        deadline.restart();
        return true;
    }
    function drainQueue() {
        if (busy || queue.length === 0) return;
        var next = queue[0];
        queue = queue.slice(1);
        run(next);
    }
    function cancelQueued(op) {
        queue = queue.filter(function(q) { return q.op !== op });
    }
    function finishWorker(code) {
        if (!busy) return;
        deadline.stop();
        var req = request;
        var op = req.op;
        request = ({});
        busy = false;
        // Only a clean exit means the collector holds this run's response; a
        // stale value from an earlier run is never read as a fresh result.
        var result = Model.parseResponse(output.text, code, timedOut);
        completed(op, result, req);
        Qt.callLater(drainQueue);
    }

    function download(engine, name) {
        if (downloading) return false;
        downloading = true;
        downloadFinished = false;
        downloadEngine = engine;
        downloadName = name;
        downloadProgress = 0;
        downloadLog = [];
        downloadGeneration++;
        downloader.running = true;
        return true;
    }
    function cancelDownload() {
        if (!downloading) return;
        if (downloader.running) downloader.signal(15);
        else finishDownload(-1);
    }
    function handleDownloadLine(line) {
        var event = Model.parseDownloadLine(line);
        if (event.type === "progress") downloadProgress = event.value;
        else if (event.type === "log") downloadLog = downloadLog.concat([Model.sanitize(event.text, 160)]).slice(-6);
        else if (event.type === "done") { downloadProgress = 100; downloadFinished = true; }
        else if (event.type === "failed") downloadLog = downloadLog.concat([Model.sanitize(event.reason, 160)]).slice(-6);
    }
    function finishDownload(code) {
        if (!downloading) return;
        downloading = false;
        var ok = code === 0 && downloadFinished;
        var reason = ok ? "" : (code === 0 ? "Download ended without completing." : (downloadLog.length ? downloadLog[downloadLog.length - 1] : "Download failed."));
        downloadDone(downloadEngine, downloadName, ok, reason);
    }

    function toggleRecord() {
        if (recording) return false;
        recording = true;
        recordGeneration++;
        recorder.running = true;
        recordDeadline.restart();
        return true;
    }
    function finishRecord(code) {
        if (!recording) return;
        recordDeadline.stop();
        recording = false;
        recordFinished(code === 0);
        stateFile.reload();
    }

    // The panel is a full-screen overlay layer, so the file chooser is only
    // reachable once the panel hides. The caller owns that handoff; this only
    // reports the chosen path (exit 0) or the cancel/failure case.
    function pick() {
        if (picking) return false;
        picking = true;
        pickerGeneration++;
        picker.running = true;
        pickerDeadline.restart();
        return true;
    }
    function finishPicker(code) {
        if (!picking) return;
        pickerDeadline.stop();
        picking = false;
        var path = String(pickerOutput.text || "").replace(/\r?\n$/, "");
        if (code === 0 && path !== "") picked(path);
        else pickCanceled();
    }

    // Privileged GPU toggles are handed to the user's own terminal; the shell
    // never sees a password. Fixed argv, no shell string.
    function launchGpuSetup(enable) {
        Quickshell.execDetached(["omarchy-launch-terminal", "sudo", "voxtype", "setup", "gpu", enable ? "--enable" : "--disable"]);
    }

    function applyStateText(text) {
        daemonState = Model.readStateFile(text);
    }

    Process {
        id: worker
        command: [root.pythonBinary, root.bridgePath]
        stdinEnabled: true
        stdout: StdioCollector { id: output; waitForEnd: true }
        stderr: StdioCollector { waitForEnd: true }
        onStarted: {
            write(JSON.stringify(root.request));
            stdinEnabled = false;
            stdinEnabled = true;
        }
        onRunningChanged: {
            // FailedToStart emits runningChanged(false), but not exited.
            // Let a normal exit deliver its status and collected output first.
            if (!running) {
                var generation = root.workerGeneration;
                Qt.callLater(function() {
                    if (generation === root.workerGeneration && !worker.running && root.busy)
                        root.finishWorker(-1);
                });
            }
        }
        onExited: function(code) { root.finishWorker(code) }
    }
    Timer {
        id: deadline
        interval: 15000
        onTriggered: {
            if (!root.busy) return;
            root.timedOut = true;
            if (worker.running) worker.signal(9);
            else root.finishWorker(-1);
        }
    }

    Process {
        id: downloader
        command: [root.pythonBinary, root.bridgePath, "--download", root.downloadEngine, root.downloadName]
        stdout: SplitParser { onRead: function(line) { root.handleDownloadLine(String(line)) } }
        stderr: SplitParser { onRead: function(line) { root.handleDownloadLine("LOG " + String(line)) } }
        onRunningChanged: {
            if (!running) {
                var generation = root.downloadGeneration;
                Qt.callLater(function() {
                    if (generation === root.downloadGeneration && !downloader.running && root.downloading)
                        root.finishDownload(-1);
                });
            }
        }
        onExited: function(code) { root.finishDownload(code) }
    }

    Process {
        id: recorder
        command: ["voxtype", "record", "toggle"]
        stdout: StdioCollector { waitForEnd: true }
        stderr: StdioCollector { waitForEnd: true }
        onRunningChanged: {
            if (!running) {
                var generation = root.recordGeneration;
                Qt.callLater(function() {
                    if (generation === root.recordGeneration && !recorder.running && root.recording)
                        root.finishRecord(-1);
                });
            }
        }
        onExited: function(code) { root.finishRecord(code) }
    }
    Timer {
        id: recordDeadline
        interval: 5000
        onTriggered: {
            if (!root.recording) return;
            if (recorder.running) recorder.signal(9);
            else root.finishRecord(-1);
        }
    }

    Process {
        id: picker
        command: ["zenity", "--file-selection", "--title=Import a voxtype-tui bundle", "--file-filter=JSON bundles | *.json"]
        stdout: StdioCollector { id: pickerOutput; waitForEnd: true }
        stderr: StdioCollector { waitForEnd: true }
        onRunningChanged: {
            if (!running) {
                var generation = root.pickerGeneration;
                Qt.callLater(function() {
                    if (generation === root.pickerGeneration && !picker.running && root.picking)
                        root.finishPicker(-1);
                });
            }
        }
        onExited: function(code) { root.finishPicker(code) }
    }
    Timer {
        id: pickerDeadline
        // A file chooser is human-paced; only abandon it after a long idle.
        interval: 300000
        onTriggered: {
            if (!root.picking) return;
            if (picker.running) picker.signal(15);
            else root.finishPicker(-1);
        }
    }

    // Cheap bar-button poll: the daemon writes one word to its state file.
    FileView {
        id: stateFile
        path: root.stateFilePath
        printErrors: false
        watchChanges: false
        onLoaded: root.applyStateText(text())
        onLoadFailed: root.daemonState = "stopped"
    }
    Timer {
        interval: root.pollIntervalMs
        repeat: true
        running: root.pollState
        triggeredOnStart: true
        onTriggered: stateFile.reload()
    }
}
