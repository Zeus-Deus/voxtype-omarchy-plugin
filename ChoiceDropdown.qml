import QtQuick
import QtQuick.Controls
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Model.js" as Model

// The kit Dropdown's look and API (label, value, options, open/close,
// popupOpen, changed, hovered) with two list fixes for long option lists:
//
// - Hovering a row only highlights it. The kit moves the ListView's
//   currentIndex on hover, and the view then scrolls that row fully into
//   view, so moving the pointer near the list's edge nudged the list.
//   Here the highlighted row is `active`, and only the keyboard scrolls.
// - A wheel notch moves three rows at once, like the panel body and
//   Omarchy's menu, instead of a Flickable kinetic flick.
//
// No text input: the clipboard is never read (see EditField.qml).
Item {
  id: root

  property string label: ""
  property string value: ""
  property var options: []

  property color foreground: Commons.Color.popups.text
  property color background: Commons.Color.popups.background
  property color popupBorder: Commons.Color.popups.border
  property color accent: Commons.Color.accent
  property color muted: Commons.Color.muted
  readonly property var popupBorderSpec: Border.localOrSurfaceSpec("popups", "border", popupBorder, Commons.Color.popups.border, Style.normalBorderWidth)
  property string fontFamily: Style.font.family
  property int rowHeight: Style.spacing.controlHeight
  property int popupRowHeight: Style.spacing.popupRowHeight
  property bool showLabel: true
  property bool hasCursor: false

  readonly property bool popupOpen: popup.opened
  function open() { popup.open() }
  function close() { popup.close() }
  function toggle() { popup.opened ? popup.close() : popup.open() }

  signal changed(string value)
  signal hovered(bool isHovered)

  function optionValue(o) { return (o && typeof o === "object") ? String(o.value) : String(o) }
  function optionLabel(o) { return (o && typeof o === "object") ? String(o.label) : String(o) }
  function currentLabel() {
    for (var i = 0; i < options.length; i++)
      if (optionValue(options[i]) === value) return optionLabel(options[i])
    return Model.sanitize(value, Model.OPTION_LABEL_MAX)
  }

  implicitWidth: Style.spacing.dropdownWidth
  implicitHeight: showLabel && label !== "" ? rowHeight + Style.spacing.huge : rowHeight

  Column {
    anchors.fill: parent
    spacing: Style.spacing.labelGap

    Text {
      textFormat: Text.PlainText
      visible: root.showLabel && root.label !== ""
      text: root.label
      color: root.muted
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      font.bold: true
    }

    BorderSurface {
      id: trigger
      width: parent.width
      height: root.rowHeight
      radius: Style.cornerRadius

      readonly property bool _focused: trigger.activeFocus
      readonly property bool _hot: triggerHover.hovered || root.hasCursor

      color: Style.controlFill(trigger._focused, trigger._hot, root.foreground, root.accent)
      borderSpec: Border.controlSpec(trigger._focused ? "focus" : (trigger._hot ? "hover-cursor" : "normal"), root.foreground, root.accent)
      activeFocusOnTab: true

      HoverHandler {
        id: triggerHover
        onHoveredChanged: root.hovered(hovered)
      }

      Keys.onPressed: function(event) {
        if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter
            || event.key === Qt.Key_Space || event.key === Qt.Key_Down) {
          root.toggle(); event.accepted = true
        } else if (event.key === Qt.Key_Escape && popup.opened) {
          popup.close(); event.accepted = true
        }
      }

      Text {
        textFormat: Text.PlainText
        anchors.left: parent.left
        anchors.right: chevron.left
        anchors.verticalCenter: parent.verticalCenter
        anchors.leftMargin: trigger.borderLeft + Style.spacing.controlPaddingX
        anchors.rightMargin: trigger.borderRight + Style.spacing.md
        text: root.currentLabel()
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        elide: Text.ElideRight
      }

      Text {
        id: chevron
        textFormat: Text.PlainText
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        anchors.rightMargin: trigger.borderRight + Style.spacing.controlGap
        text: "󰅀"
        color: root.muted
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
      }

      MouseArea {
        anchors.fill: parent
        cursorShape: Qt.PointingHandCursor
        onClicked: { trigger.forceActiveFocus(); root.toggle() }
      }

      Popup {
        id: popup
        x: 0
        y: trigger.height + Style.spacing.xxs
        closePolicy: Popup.CloseOnPressOutsideParent | Popup.CloseOnEscape
        width: trigger.width
        implicitHeight: Math.min(root.options.length * root.popupRowHeight + Math.max(0, root.options.length - 1) * Style.spacing.labelGap,
                                 root.popupRowHeight * 8 + 7 * Style.spacing.labelGap)
                        + topPadding + bottomPadding
        padding: Style.spacing.hairline
        leftPadding: Border.left(root.popupBorderSpec) + Style.spacing.hairline
        rightPadding: Border.right(root.popupBorderSpec) + Style.spacing.hairline
        topPadding: Border.top(root.popupBorderSpec) + Style.spacing.hairline
        bottomPadding: Border.bottom(root.popupBorderSpec) + Style.spacing.hairline
        focus: true

        background: BorderSurface {
          color: root.background
          borderSpec: root.popupBorderSpec
          radius: Style.cornerRadius
        }

        onOpened: {
          optionList.active = Math.max(0, optionList.indexOfValue(root.value))
          optionList.positionViewAtIndex(optionList.active, ListView.Center)
          optionList.forceActiveFocus()
        }

        contentItem: ListView {
          id: optionList
          // The highlighted row. Not currentIndex, which would scroll the
          // view whenever the pointer moves onto a partly hidden row.
          property int active: -1
          spacing: Style.spacing.labelGap
          implicitHeight: contentHeight
          clip: true
          boundsBehavior: Flickable.StopAtBounds
          model: root.options
          currentIndex: -1

          function indexOfValue(v) {
            for (var i = 0; i < root.options.length; i++)
              if (root.optionValue(root.options[i]) === v) return i
            return -1
          }
          function step(d) {
            active = Math.max(0, Math.min(root.options.length - 1, active + d))
            positionViewAtIndex(active, ListView.Contain)
          }
          function selectActive() {
            if (active < 0 || active >= root.options.length) return
            var v = root.optionValue(root.options[active])
            popup.close()
            root.changed(v)
          }

          Keys.priority: Keys.BeforeItem
          Keys.onPressed: function(event) {
            if (event.key === Qt.Key_Escape) { popup.close(); event.accepted = true }
            else if (event.key === Qt.Key_Down || event.text === "j") { optionList.step(1); event.accepted = true }
            else if (event.key === Qt.Key_Up || event.text === "k") { optionList.step(-1); event.accepted = true }
            else if (event.key === Qt.Key_PageDown) { optionList.step(7); event.accepted = true }
            else if (event.key === Qt.Key_PageUp) { optionList.step(-7); event.accepted = true }
            else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter || event.key === Qt.Key_Space) {
              optionList.selectActive(); event.accepted = true
            }
          }

          WheelHandler {
            acceptedDevices: PointerDevice.Mouse | PointerDevice.TouchPad
            onWheel: function(event) {
              optionList.contentY = Model.wheelContentY(optionList.contentY, optionList.contentHeight, optionList.height,
                                                        event.pixelDelta.y, event.angleDelta.y,
                                                        (root.popupRowHeight + Style.spacing.labelGap) * 3, event.phase)
              event.accepted = true
            }
          }

          delegate: Rectangle {
            required property var modelData
            required property int index
            width: optionList.width
            height: root.popupRowHeight
            color: index === optionList.active ? Style.hoverFillFor(root.foreground, root.accent) : "transparent"

            Text {
              textFormat: Text.PlainText
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              anchors.leftMargin: Style.spacing.controlPaddingX
              anchors.rightMargin: Style.spacing.controlPaddingX
              text: root.optionLabel(parent.modelData)
              color: parent.index === optionList.active ? Style.hoverStateColor(root.foreground, root.accent) : root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              elide: Text.ElideRight
            }

            MouseArea {
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onEntered: optionList.active = parent.index
              onClicked: { optionList.active = parent.index; optionList.selectActive() }
            }
          }
        }
      }
    }
  }
}
