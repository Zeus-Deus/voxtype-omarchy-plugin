import QtQuick
import qs.Commons
import qs.Commons as Commons

// A year of dictations as a 7 × 52 grid (contribution-graph style), in the
// theme accent. `grid` is Model.heatmap(): {cells:[{week, day, level, date,
// count, today}], months:[{week, label}], weeks}. Drawing only; no input.
Item {
    id: root
    property var grid: ({cells: [], months: [], weeks: 52})
    property color foreground: Commons.Color.foreground
    property color muted: Commons.Color.muted
    property color accent: Commons.Color.accent
    property string fontFamily: Style.font.family

    readonly property int weeks: grid && grid.weeks ? grid.weeks : 52
    readonly property real gap: Math.max(1, Style.space(2))
    readonly property real cell: Math.max(2, Math.floor((width - gap * (weeks - 1)) / weeks))
    readonly property real monthHeight: monthProbe.implicitHeight + Style.space(4)

    implicitHeight: monthHeight + cell * 7 + gap * 6

    Text { id: monthProbe; visible: false; textFormat: Text.PlainText; text: "Jan"; font.family: root.fontFamily; font.pixelSize: Style.font.caption }

    Repeater {
        model: root.grid && root.grid.months ? root.grid.months : []
        delegate: Text {
            required property var modelData
            x: modelData.week * (root.cell + root.gap)
            y: 0
            textFormat: Text.PlainText
            text: modelData.label
            color: root.muted
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
        }
    }
    Repeater {
        model: root.grid && root.grid.cells ? root.grid.cells : []
        delegate: Rectangle {
            required property var modelData
            x: modelData.week * (root.cell + root.gap)
            y: root.monthHeight + modelData.day * (root.cell + root.gap)
            width: root.cell
            height: root.cell
            radius: Style.cornerRadius > 0 ? Math.max(1, root.cell / 5) : 0
            color: modelData.level > 0 ? root.accent : Style.hoverFillFor(root.foreground, root.accent)
            opacity: modelData.level === 0 ? 1 : [1, 0.3, 0.5, 0.75, 1][modelData.level]
            border.width: modelData.today ? Math.max(1, Style.normalBorderWidth) : 0
            border.color: root.foreground
        }
    }
}
