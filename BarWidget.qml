import QtQuick
import Quickshell
import qs.Commons
import qs.Ui
import "Model.js" as Model

// The bar owns one nested panel; shell summon/hide use this same instance.
BarWidget {
    id: root
    moduleName: "io.github.zeus-deus.voxtype"
    readonly property bool opened: panelLoader.item ? panelLoader.item.opened : false
    readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing : false
    readonly property string daemonState: panelLoader.item ? panelLoader.item.daemonState : "unknown"
    readonly property bool rightClickRecords: setting("rightClickRecords", true)
    function open() { if (panelLoader.item) panelLoader.item.open() }
    function close() { if (panelLoader.item) panelLoader.item.close() }
    function toggle() { if (panelLoader.item) panelLoader.item.toggle() }
    function closeForPopoutSwitch() { if (panelLoader.item) panelLoader.item.closeForPopoutSwitch() }
    function injectPanel() {
        if (!panelLoader.item) return;
        panelLoader.item.bar = root.bar;
        panelLoader.item.settings = root.settings;
        panelLoader.item.anchorItem = button;
        panelLoader.item.hostWidget = root;
    }
    implicitWidth: button.implicitWidth
    implicitHeight: button.implicitHeight
    onBarChanged: injectPanel()
    onSettingsChanged: injectPanel()
    Loader {
        id: panelLoader
        active: true
        visible: false
        source: Qt.resolvedUrl("Panel.qml")
        onLoaded: { root.injectPanel(); Qt.callLater(root.injectPanel) }
    }
    BarIconButton {
        id: button
        anchors.fill: parent
        bar: root.bar
        text: Model.barGlyph(root.daemonState)
        active: Model.barActive(root.daemonState)
        activeColor: root.daemonState === "recording" ? Color.accent : (root.bar ? root.bar.urgent : Color.urgent)
        tooltipText: panelLoader.item ? panelLoader.item.tooltip : "Voxtype"
        onPressed: function(buttonCode) {
            if (!panelLoader.item) return;
            if (buttonCode === Qt.LeftButton) root.toggle();
            else if (buttonCode === Qt.RightButton && root.rightClickRecords) panelLoader.item.toggleRecord();
            else if (buttonCode === Qt.MiddleButton) panelLoader.item.restartIfStale();
        }
    }
}
