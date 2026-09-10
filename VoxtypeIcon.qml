import QtQuick
import qs.Commons
import qs.Ui

// Microphone mark drawn with the configured Nerd Font; no image assets.
Item {
    id: root
    property color color: Color.foreground
    property real iconSize: Style.font.display
    property string daemonState: "idle"
    implicitWidth: iconSize
    implicitHeight: iconSize

    OpticalGlyph {
        anchors.fill: parent
        text: root.daemonState === "stopped" || root.daemonState === "unknown" ? "󰍭" : (root.daemonState === "transcribing" ? "󰦉" : "󰍬")
        fontFamily: Style.font.family
        fontSize: root.iconSize
        color: root.color
    }
}
