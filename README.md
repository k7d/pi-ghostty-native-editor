# pi-ghostty-native-editor

macOS-style text editing for the prompt editor of the [pi coding agent](https://pi.dev), tuned for the [Ghostty](https://ghostty.org) terminal.

pi's prompt editor uses Emacs-style keys and has no text selection. This extension makes it behave like a native macOS text field: select with Shift+arrows or the mouse, use Cmd+C / Cmd+X / Cmd+V / Cmd+Z / Cmd+A, and type over the selection to replace it.

## Features

### Selection

| Keys | Action |
|---|---|
| Shift+← / → / ↑ / ↓ | Extend the selection by character or line |
| Option+Shift+← / → (or Ctrl+Shift+← / →) | Extend by word |
| Cmd+Shift+← / →, Shift+Home / End | Extend to line start / end |
| Cmd+Shift+↑ / ↓ | Extend to the start / end of the prompt |
| Cmd+A | Select all |
| ← / → while text is selected | Collapse to the start / end of the selection |
| Esc while text is selected | Clear the selection (instead of interrupting the agent) |

### Editing

| Keys | Action |
|---|---|
| Cmd+C | Copy the selection (Ctrl+C also copies when text is selected) |
| Cmd+X | Cut |
| Cmd+V | Paste; replaces the selection as one undo step |
| Cmd+Z | Undo (pi's own Ctrl+- keeps working) |
| Cmd+Shift+Z or Cmd+Y | Redo |
| Cmd+← / → | Go to line start / end |
| Cmd+↑ / ↓ | Go to the start / end of the prompt |
| Typing, Backspace, Delete, Enter | Replace or delete the selection |

### Mouse

Only in pi's fullscreen mode, which is the default (`tuiMode: "fullscreen"`). In regular mode the terminal owns the mouse.

| Gesture | Action |
|---|---|
| Click | Place the cursor |
| Drag | Select text |
| Double-click | Select a word |
| Triple-click | Select a line |
| Shift+click | Extend the selection (requires `mouse-shift-capture = true` in Ghostty) |

### Optional: Enter inserts a newline, Shift+Enter submits

Off by default. When enabled, Enter inserts a newline and Shift+Enter submits, like chat apps that are built for multi-line messages. Enter still runs single-line slash commands (like `/model`) and picks the highlighted item when the autocomplete menu is open. See [Configuration](#configuration).

## Installation

### 1. Install the pi package

```bash
pi install npm:pi-ghostty-native-editor
```

Or from git: `pi install git:github.com/k7d/pi-ghostty-native-editor`.

To try it for one session without installing:

```bash
pi -e npm:pi-ghostty-native-editor
```

### 2. Configure Ghostty

Ghostty handles Cmd+Z, Cmd+A, Cmd+X, Cmd+C, Cmd+↑/↓ and Shift+arrows itself, so pi never receives them. [`ghostty.conf`](ghostty.conf) in this package turns those bindings off or makes them conditional, so Ghostty forwards the keys to pi using the Kitty keyboard protocol.

In pi, run:

```text
/native-editor configure-ghostty
```

This copies the keybindings to `~/.pi/agent/ghostty-native-editor.ghostty` and adds an include for it to your Ghostty config (two lines, marked with a comment). It does nothing if the include is already there. If the `ghostty` CLI is available, the config is validated and the change is reverted when Ghostty rejects it. Then reload Ghostty's config with Cmd+Shift+, (or restart Ghostty).

To undo it:

```text
/native-editor remove-ghostty
```

The Ghostty config used is the last existing one of `$XDG_CONFIG_HOME/ghostty/config.ghostty`, `$XDG_CONFIG_HOME/ghostty/config`, and on macOS `~/Library/Application Support/com.mitchellh.ghostty/config.ghostty` and `.../config` (the same files Ghostty reads). If none exists, a new one is created.

<details>
<summary>Manual setup</summary>

Add an include to your Ghostty config. Use an absolute path; the leading `?` makes the include optional:

```ini
config-file = ?/absolute/path/to/pi-ghostty-native-editor/ghostty.conf
```

</details>

What `ghostty.conf` changes:

| Key | Ghostty default | With ghostty.conf |
|---|---|---|
| Cmd+Z, Cmd+Shift+Z | Undo / redo closing tabs and splits | Sent to the program |
| Cmd+A | Select the whole screen | Sent to the program |
| Cmd+X | (nothing) | Sent to the program |
| Cmd+C | Copy Ghostty's selection | Copies Ghostty's selection if there is one, otherwise sent to the program |
| Shift+arrows, Shift+Home/End | Adjust Ghostty's selection | Same if there is a Ghostty selection, otherwise sent to the program |
| Cmd+↑ / ↓, Cmd+Shift+↑ / ↓ | Jump to the previous / next shell prompt | Sent to the program |

Ghostty's defaults for Cmd+← / →, Option+← / → and Cmd+Backspace already work with pi and in the shell, so they are left alone. Programs that don't understand the forwarded keys, such as most shells, ignore them.

## Configuration

Settings are stored in `~/.pi/agent/ghostty-native-editor.json`. Change them with the `/native-editor` command, which applies right away:

```text
/native-editor                      show the current settings and Ghostty status
/native-editor enter-newline on     Enter inserts a newline, Shift+Enter submits
/native-editor enter-newline off    Enter submits, Shift+Enter inserts a newline (default)
/native-editor configure-ghostty    add the keybindings to the Ghostty config
/native-editor remove-ghostty       remove them from the Ghostty config
```

Or edit the file directly; it's read when pi starts:

```json
{
	"enterInsertsNewline": true
}
```

| Setting | Default | Description |
|---|---|---|
| `enterInsertsNewline` | `false` | Swap Enter and Shift+Enter: Enter inserts a newline and Shift+Enter submits. |

Shift+Enter has to reach pi as its own key. Ghostty sends it correctly when pi enables the Kitty keyboard protocol, which pi does automatically. If you added `keybind = shift+enter=text:\x1b\r` for older pi versions, it still works.

## Other terminals

The extension itself is terminal-agnostic. Cmd shortcuts work in any terminal that forwards Cmd (the "super" modifier) through the [Kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/), such as kitty (`map cmd+z no_op`, etc.) or WezTerm (with `enable_kitty_keyboard = true` and the default Cmd bindings disabled). Shift+arrow selection, mouse selection, Ctrl+C copy and the Enter swap work in most modern terminals without any configuration.

Inside tmux, enable extended keys (`set -g extended-keys on`, plus `set -g extended-keys-format csi-u` on tmux 3.5+) so modifiers aren't dropped.

## How it works

The extension replaces pi's prompt editor with a subclass of pi's built-in `CustomEditor` (see pi's [`modal-editor.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/modal-editor.ts) example). It adds a selection anchor, a redo stack, mouse handling and selection rendering on top of the base editor, and passes all other keys (app shortcuts, autocomplete, history, kill ring) through unchanged.

Copying uses pi's own clipboard helper, which uses the native clipboard locally and OSC 52 over SSH.

The extension relies on some internal (non-public) details of pi's editor, so a future pi release could break it. If that happens, `pi remove npm:pi-ghostty-native-editor` restores the default editor. Run `/native-editor remove-ghostty` first to restore Ghostty's keybindings too.

Tested with pi 1.3.0 and Ghostty 1.3.1 on macOS.

## License

[MIT](LICENSE)
