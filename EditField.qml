import QtQuick
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Model.js" as Model

// The single-line input behind every editable field in the panel.
//
// Qt's TextInput (inside qs.Ui TextField and the SpinBox of NumberField)
// reads the Wayland clipboard inside the shell process by itself: whenever
// another program changes the clipboard it fetches the whole text to decide
// whether Paste applies, and it fetches it again on Ctrl+V, Shift+Insert,
// the context menu and middle-click. Those reads have no byte limit and no
// overall deadline, so a program owning the clipboard could stall or fill
// the shared shell, even while this panel is closed.
//
// This field is a plain-text TextEdit instead. On a clipboard change Qt 6.12's
// TextEdit only checks which formats are offered; it never transfers the
// data. Every path where it WOULD read the clipboard is closed here: the
// paste keys are taken before TextEdit sees them, middle and right clicks are
// swallowed, and a plain TextEdit has no context menu and accepts no drops.
// A paste asks the panel instead (pasteRequested); the panel reads the
// clipboard in a child process with a byte cap and a total deadline
// (bridge.py --paste) and hands the text to insertText().
FocusScope {
    id: root

    property alias text: edit.text
    property string placeholderText: ""
    property color foreground: Commons.Color.foreground
    property color accent: Commons.Color.accent
    property color placeholderColor: Commons.Color.muted
    property bool hasCursor: false
    property int maximumLength: Model.EDIT_MAX_CHARS
    // When set, a RegExp that each typed or pasted character must match.
    property var allowedChars: null
    property int horizontalAlignment: TextEdit.AlignLeft
    // Room on the right for controls a caller places inside the field.
    property real rightInset: 0
    property alias cursorPosition: edit.cursorPosition
    readonly property int selectionStart: edit.selectionStart
    readonly property int selectionEnd: edit.selectionEnd
    readonly property bool hovered: hover.hovered

    signal pasteRequested()

    readonly property bool _focused: activeFocus
    readonly property bool _hot: hovered || hasCursor
    readonly property var _borderSpec: Border.controlSpec(_focused ? "focus" : (_hot ? "hover-cursor" : "normal"), foreground, accent)

    function selectAll() { edit.selectAll() }

    // Replace the selection with `s` (a paste), keeping TextEdit's undo.
    function insertText(s) {
        var add = String(s === null || s === undefined ? "" : s);
        if (allowedChars) add = add.split("").filter(function(c) { return root.allowedChars.test(c) }).join("");
        var a = Math.min(edit.selectionStart, edit.selectionEnd);
        var b = Math.max(edit.selectionStart, edit.selectionEnd);
        var next = Model.spliceText(edit.text, a, b, add, maximumLength);
        add = next.text.slice(a, next.cursor);
        if (b > a) edit.remove(a, b);
        if (add !== "") edit.insert(a, add);
        edit.cursorPosition = a + add.length;
    }

    function ensureCursorVisible() {
        var r = edit.cursorRectangle;
        var x = edit.x;
        if (r.x + x < 0) x = -r.x;
        else if (r.x + Math.max(1, r.width) + x > viewport.width) x = viewport.width - r.x - Math.max(1, r.width);
        edit.x = Math.min(0, Math.max(viewport.width - edit.width, x));
    }

    activeFocusOnTab: true
    implicitWidth: Style.space(150)
    implicitHeight: Math.ceil(metrics.height) + Style.spacing.inputPaddingY * 2 + Border.top(_borderSpec) + Border.bottom(_borderSpec)

    FontMetrics { id: metrics; font: edit.font }

    BorderSurface {
        anchors.fill: parent
        color: Style.controlFill(root._focused, root._hot, root.foreground, root.accent)
        borderSpec: root._borderSpec
        radius: Style.cornerRadius
    }

    HoverHandler { id: hover; cursorShape: Qt.IBeamCursor }

    // A click on the padding still lands in the field.
    MouseArea {
        anchors.fill: parent
        acceptedButtons: Qt.LeftButton
        onPressed: { edit.forceActiveFocus(); edit.cursorPosition = edit.length }
    }

    Item {
        id: viewport
        anchors.fill: parent
        anchors.leftMargin: Style.spacing.controlPaddingX + Border.left(root._borderSpec)
        anchors.rightMargin: Style.spacing.controlPaddingX + Border.right(root._borderSpec) + root.rightInset
        clip: true
        onWidthChanged: root.ensureCursorVisible()

        Text {
            anchors.fill: parent
            visible: edit.length === 0 && edit.preeditText === ""
            text: root.placeholderText
            textFormat: Text.PlainText
            elide: Text.ElideRight
            verticalAlignment: Text.AlignVCenter
            horizontalAlignment: root.horizontalAlignment
            color: root.placeholderColor
            font: edit.font
        }

        TextEdit {
            id: edit
            focus: true
            anchors.verticalCenter: parent.verticalCenter
            // A fixed caret allowance: the cursor rectangle depends on this
            // width, so binding to it would be a loop.
            width: Math.max(viewport.width, contentWidth + 2)
            textFormat: TextEdit.PlainText
            wrapMode: TextEdit.NoWrap
            selectByMouse: true
            horizontalAlignment: root.horizontalAlignment
            font.family: Style.font.family
            font.pixelSize: Style.font.body
            color: root.foreground
            selectionColor: Style.selectionFillFor(root.foreground, root.accent)
            selectedTextColor: root.foreground
            onCursorRectangleChanged: root.ensureCursorVisible()
            onWidthChanged: root.ensureCursorVisible()
            // Text an input method commits skips the key handler below, so
            // the one-line, allowed-characters and length rules apply here too.
            onTextChanged: {
                var kept = text.replace(/[\r\n\t\u2028\u2029]+/g, " ");
                if (root.allowedChars) kept = kept.split("").filter(function(c) { return root.allowedChars.test(c) }).join("");
                if (kept.length > root.maximumLength) kept = kept.slice(0, root.maximumLength);
                if (kept !== text) { const at = Math.min(cursorPosition, kept.length); text = kept; cursorPosition = at; }
            }

            // The caller's own Keys handlers (Return, Escape, Down…) run first.
            Keys.forwardTo: [root]
            Keys.onPressed: function(event) {
                if (event.matches(StandardKey.Paste)
                        || (event.key === Qt.Key_Insert && (event.modifiers & Qt.ShiftModifier))
                        || (event.key === Qt.Key_V && (event.modifiers & Qt.ControlModifier) && (event.modifiers & Qt.ShiftModifier))) {
                    root.pasteRequested();
                    event.accepted = true;
                    return;
                }
                // One line: Enter never inserts a break. Tab moves to the next
                // field, as it did with qs.Ui TextField, instead of typing a tab.
                if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
                    event.accepted = true;
                    return;
                }
                if (event.key === Qt.Key_Tab || event.key === Qt.Key_Backtab) {
                    const forward = event.key === Qt.Key_Tab && !(event.modifiers & Qt.ShiftModifier);
                    const next = root.nextItemInFocusChain(forward);
                    if (next && next !== root) next.forceActiveFocus();
                    event.accepted = true;
                    return;
                }
                var typed = Model.typedText(event.text, event.modifiers, Qt.ControlModifier, Qt.AltModifier, Qt.MetaModifier);
                if (typed !== "") {
                    const selected = Math.abs(edit.selectionEnd - edit.selectionStart);
                    const refused = (root.allowedChars && !root.allowedChars.test(typed))
                        || edit.length - selected + typed.length > root.maximumLength;
                    if (refused) { event.accepted = true; return; }
                }
                event.accepted = false;
            }
        }
    }

    // Middle-click pastes the primary selection and right-click could open a
    // menu with Paste; both would read inside the shell, so neither reaches
    // the TextEdit.
    MouseArea {
        anchors.fill: parent
        acceptedButtons: Qt.MiddleButton | Qt.RightButton
        onPressed: edit.forceActiveFocus()
    }
}
