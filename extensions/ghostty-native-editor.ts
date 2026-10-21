/**
 * pi-ghostty-native-editor — macOS-style text editing for pi's prompt editor.
 *
 * Adds text selection (keyboard and mouse), Cmd shortcuts (copy, cut, paste, undo, redo,
 * select all, line/prompt navigation), and optionally swaps Enter / Shift+Enter.
 *
 * Cmd shortcuts need a terminal that forwards them to the program using the Kitty keyboard
 * protocol. For Ghostty, include ghostty.conf from this package in the Ghostty config.
 *
 * Settings live in ~/.pi/agent/ghostty-native-editor.json and can be changed with
 * the /native-editor command. See README.md.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CustomEditor, copyToClipboard, type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	decodeKittyPrintable,
	getKeybindings,
	matchesKey,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	type KeyId,
	visibleWidth,
} from "@earendil-works/pi-tui";

type Pos = { line: number; col: number };
type VisualLine = { logicalLine: number; startCol: number; length: number };
type Snapshot = { state: EditorState; pastes: Map<number, string>; pasteCounter: number };
type EditorState = { lines: string[]; cursorLine: number; cursorCol: number };

/** Base Editor internals (TypeScript-private, but reachable at runtime). */
interface Internals {
	state: EditorState;
	pastes: Map<number, string>;
	pasteCounter: number;
	lastWidth: number;
	scrollOffset: number;
	renderedVisibleLineCount: number;
	paddingX: number;
	isInPaste: boolean;
	jumpMode: "forward" | "backward" | null;
	lastAction: string | null;
	preferredVisualCol: number | null;
	autocompleteState: unknown;
	undoStack: { push(s: Snapshot): void; pop(): Snapshot | undefined; length: number };
	pushUndoSnapshot(): void;
	undo(): void;
	submitValue(): void;
	addNewLine(): void;
	setCursorCol(col: number): void;
	moveCursor(dLine: number, dCol: number): void;
	moveWordBackwards(): void;
	moveWordForwards(): void;
	moveToLineStart(): void;
	moveToLineEnd(): void;
	exitHistoryBrowsing(): void;
	cancelAutocomplete(): void;
	updateAutocomplete(): void;
	tryTriggerAutocomplete(explicitTab?: boolean): void;
	expandPasteMarkers(text: string): string;
	buildVisualLineMap(width: number): VisualLine[];
	findVisualLineAt(vls: VisualLine[], line: number, col: number): number;
	segment(text: string, mode: "grapheme" | "word"): Iterable<Intl.SegmentData>;
}

// ── settings ─────────────────────────────────────────────────────────

interface Settings {
	/** Enter inserts a newline and Shift+Enter submits (pi's default is the reverse). */
	enterInsertsNewline: boolean;
}

const DEFAULT_SETTINGS: Settings = { enterInsertsNewline: false };

const settingsPath = () => join(getAgentDir(), "ghostty-native-editor.json");

function loadSettings(): Settings {
	try {
		const path = settingsPath();
		if (!existsSync(path)) return { ...DEFAULT_SETTINGS };
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Settings>;
		return { enterInsertsNewline: raw.enterInsertsNewline === true };
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

function saveSettings(settings: Settings): void {
	writeFileSync(settingsPath(), `${JSON.stringify(settings, null, "\t")}\n`);
}

const cmp = (a: Pos, b: Pos) => (a.line - b.line) || (a.col - b.col);

// ── Ghostty config ───────────────────────────────────────────────────

/** Keybindings shipped with this package. */
const packagedGhosttyConf = () => fileURLToPath(new URL("../ghostty.conf", import.meta.url));

/** Stable copy referenced from the Ghostty config, so it survives package moves and temp installs. */
const installedGhosttyConf = () => join(getAgentDir(), "ghostty-native-editor.ghostty");

const GHOSTTY_MARKER = "# pi-ghostty-native-editor (added by /native-editor configure-ghostty)";

/** Ghostty config files, in the order Ghostty loads them. Ghostty reads every one that exists. */
function ghosttyConfigCandidates(): string[] {
	const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
	const paths = [join(xdg, "ghostty", "config.ghostty"), join(xdg, "ghostty", "config")];
	if (process.platform === "darwin") {
		const appSupport = join(homedir(), "Library", "Application Support", "com.mitchellh.ghostty");
		paths.push(join(appSupport, "config.ghostty"), join(appSupport, "config"));
	}
	return paths;
}

/** Config file to add the include to: the last existing one (it wins), or a new platform default. */
function ghosttyConfigTarget(): string {
	const candidates = ghosttyConfigCandidates();
	const existing = candidates.filter((p) => existsSync(p));
	if (existing.length > 0) return existing[existing.length - 1]!;
	return process.platform === "darwin" ? candidates[candidates.length - 1]! : candidates[1]!;
}

/** True for lines this extension added or that include this package's keybindings. */
const isOurGhosttyLine = (line: string) =>
	line.trim() === GHOSTTY_MARKER ||
	(/^\s*config-file\s*=/.test(line) &&
		(line.includes("ghostty-native-editor.ghostty") || line.includes("pi-ghostty-native-editor/ghostty.conf")));

/** Copy the packaged keybindings to the stable location when they changed (e.g. after a package update). */
function syncInstalledGhosttyConf(): boolean {
	const source = packagedGhosttyConf();
	const target = installedGhosttyConf();
	if (!existsSync(source)) throw new Error(`Missing ${source}`);
	if (existsSync(target) && readFileSync(target, "utf8") === readFileSync(source, "utf8")) return false;
	copyFileSync(source, target);
	return true;
}

type ExecFn = ExtensionAPI["exec"];

async function findGhosttyBinary(exec: ExecFn): Promise<string | undefined> {
	const candidates = ["ghostty", "/Applications/Ghostty.app/Contents/MacOS/ghostty"];
	for (const bin of candidates) {
		try {
			const result = await exec(bin, ["--version"], { timeout: 5000 });
			if (result.code === 0) return bin;
		} catch {
			// not found
		}
	}
	return undefined;
}

/** Returns an error message, or undefined when the config is valid or Ghostty isn't available to check. */
async function validateGhosttyConfig(exec: ExecFn): Promise<string | undefined> {
	const bin = await findGhosttyBinary(exec);
	if (!bin) return undefined;
	const result = await exec(bin, ["+validate-config"], { timeout: 10000 });
	return result.code === 0 ? undefined : (result.stdout + result.stderr).trim() || `exit code ${result.code}`;
}

async function configureGhostty(exec: ExecFn): Promise<string> {
	syncInstalledGhosttyConf();
	const include = `config-file = ?${installedGhosttyConf()}`;

	for (const path of ghosttyConfigCandidates()) {
		if (!existsSync(path)) continue;
		if (readFileSync(path, "utf8").split("\n").some((line) => line.trim() === include)) {
			return `Ghostty is already configured (${path}).`;
		}
	}

	const path = ghosttyConfigTarget();
	const original = existsSync(path) ? readFileSync(path, "utf8") : undefined;
	const base = original === undefined ? "" : original.endsWith("\n") || original === "" ? original : `${original}\n`;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${base}${base ? "\n" : ""}${GHOSTTY_MARKER}\n${include}\n`);

	const error = await validateGhosttyConfig(exec);
	if (error) {
		if (original === undefined) rmSync(path);
		else writeFileSync(path, original);
		throw new Error(`Ghostty rejected the config, change reverted:\n${error}`);
	}
	return `Added the keybindings include to ${path}. Reload Ghostty's config with Cmd+Shift+, (or restart Ghostty).`;
}

async function removeGhostty(exec: ExecFn): Promise<string> {
	const changed: string[] = [];
	for (const path of ghosttyConfigCandidates()) {
		if (!existsSync(path)) continue;
		const original = readFileSync(path, "utf8");
		const lines = original.split("\n");
		const kept = lines.filter((line) => !isOurGhosttyLine(line));
		if (kept.length === lines.length) continue;
		// Drop a blank line left behind where the block was appended.
		let text = kept.join("\n").replace(/\n{3,}/g, "\n\n");
		if (original.endsWith("\n") && !text.endsWith("\n")) text += "\n";
		text = text.replace(/\n\n$/, "\n");
		writeFileSync(path, text);
		changed.push(path);
	}
	rmSync(installedGhosttyConf(), { force: true });

	if (changed.length === 0) return "No Ghostty config changes to remove.";
	const error = await validateGhosttyConfig(exec);
	const warning = error ? `\nWarning: Ghostty reports config errors:\n${error}` : "";
	return `Removed the keybindings include from ${changed.join(", ")}. Reload Ghostty's config with Cmd+Shift+, (or restart Ghostty).${warning}`;
}

export class GhosttyNativeEditor extends CustomEditor {
	private anchor: Pos | null = null;
	/** Text at the time the selection was last updated; any other change drops the selection. */
	private anchorText = "";
	private redoStack: Snapshot[] = [];
	private suppressUndo = false;
	/** Skip the snapshot handlePaste pushes when the paste replaces a selection (one undo step). */
	private skipNextPasteSnapshot = false;
	private dragging = false;
	private readonly I = this as unknown as Internals;

	constructor(
		tui: ConstructorParameters<typeof CustomEditor>[0],
		theme: ConstructorParameters<typeof CustomEditor>[1],
		keybindings: ConstructorParameters<typeof CustomEditor>[2],
		private readonly highlight: (text: string) => string,
		private readonly settings: Settings,
	) {
		super(tui, theme, keybindings);
		const I = this.I;

		// Hook undo snapshots: support one-shot suppression (atomic replace) and clear redo on new edits.
		const basePush = I.pushUndoSnapshot.bind(this);
		I.pushUndoSnapshot = () => {
			if (this.suppressUndo) return;
			if (this.skipNextPasteSnapshot) {
				this.skipNextPasteSnapshot = false;
				return;
			}
			basePush();
			this.redoStack.length = 0;
		};
		const baseUndo = I.undo.bind(this);
		I.undo = () => {
			if (I.undoStack.length > 0) this.redoStack.push(this.snapshot());
			baseUndo();
			this.anchor = null;
		};
		const baseSubmit = I.submitValue.bind(this);
		I.submitValue = () => {
			this.anchor = null;
			this.redoStack.length = 0;
			baseSubmit();
		};
	}

	// ── selection model ────────────────────────────────────────────────

	private cursor(): Pos {
		return { line: this.I.state.cursorLine, col: this.I.state.cursorCol };
	}

	private setCursor(p: Pos): void {
		this.I.state.cursorLine = p.line;
		this.I.setCursorCol(p.col);
	}

	private selection(): { start: Pos; end: Pos } | null {
		if (!this.anchor) return null;
		if (this.getText() !== this.anchorText) {
			this.anchor = null;
			return null;
		}
		const c = this.cursor();
		const d = cmp(this.anchor, c);
		if (d === 0) return null;
		return d < 0 ? { start: this.anchor, end: c } : { start: c, end: this.anchor };
	}

	private setAnchor(p: Pos | null): void {
		this.anchor = p ? { ...p } : null;
		this.anchorText = this.getText();
	}

	private selectedText(): string {
		const sel = this.selection();
		if (!sel) return "";
		const { lines } = this.I.state;
		const { start, end } = sel;
		const text =
			start.line === end.line
				? lines[start.line]!.slice(start.col, end.col)
				: [
						lines[start.line]!.slice(start.col),
						...lines.slice(start.line + 1, end.line),
						lines[end.line]!.slice(0, end.col),
					].join("\n");
		return this.I.expandPasteMarkers(text);
	}

	/** Delete the selection as one undo step. Returns false when nothing is selected. */
	private deleteSelection(): boolean {
		const sel = this.selection();
		if (!sel) return false;
		const I = this.I;
		I.exitHistoryBrowsing();
		I.pushUndoSnapshot();
		const { start, end } = sel;
		const lines = I.state.lines;
		const merged = lines[start.line]!.slice(0, start.col) + lines[end.line]!.slice(end.col);
		lines.splice(start.line, end.line - start.line + 1, merged);
		this.setCursor(start);
		I.lastAction = null;
		this.anchor = null;
		this.onChange?.(this.getText());
		if (I.autocompleteState) I.updateAutocomplete();
		return true;
	}

	/** Replace the selection with whatever `insert` inserts, as one undo step. */
	private replaceSelection(insert: () => void): void {
		this.deleteSelection();
		this.suppressUndo = true;
		try {
			insert();
		} finally {
			this.suppressUndo = false;
		}
	}

	private snapshot(): Snapshot {
		return structuredClone({ state: this.I.state, pastes: this.I.pastes, pasteCounter: this.I.pasteCounter });
	}

	private redo(): void {
		const snap = this.redoStack.pop();
		if (!snap) return;
		const I = this.I;
		I.undoStack.push(this.snapshot());
		Object.assign(I.state, snap.state);
		I.pastes = snap.pastes;
		I.pasteCounter = snap.pasteCounter;
		I.lastAction = null;
		I.preferredVisualCol = null;
		this.anchor = null;
		this.onChange?.(this.getText());
	}

	private copy(cut: boolean): void {
		const text = this.selectedText();
		if (!text) return;
		copyToClipboard(text).catch(() => {});
		if (cut) this.deleteSelection();
	}

	private docEnd(): Pos {
		const lines = this.I.state.lines;
		return { line: lines.length - 1, col: lines[lines.length - 1]!.length };
	}

	// ── cursor motions (shared by plain and shift variants) ────────────

	private motions(): Record<string, () => void> {
		const I = this.I;
		const vertical = (dir: -1 | 1) => () => {
			const vls = I.buildVisualLineMap(I.lastWidth);
			const cur = I.findVisualLineAt(vls, I.state.cursorLine, I.state.cursorCol);
			if (dir < 0 && cur === 0) this.setCursor({ line: 0, col: 0 });
			else if (dir > 0 && cur === vls.length - 1) this.setCursor(this.docEnd());
			else I.moveCursor(dir, 0);
		};
		return {
			left: () => I.moveCursor(0, -1),
			right: () => I.moveCursor(0, 1),
			up: vertical(-1),
			down: vertical(1),
			wordLeft: () => I.moveWordBackwards(),
			wordRight: () => I.moveWordForwards(),
			lineStart: () => I.moveToLineStart(),
			lineEnd: () => I.moveToLineEnd(),
			docStart: () => this.setCursor({ line: 0, col: 0 }),
			docEnd: () => this.setCursor(this.docEnd()),
		};
	}

	private static readonly EXTEND_KEYS: [KeyId, string][] = [
		["shift+left", "left"],
		["shift+right", "right"],
		["shift+up", "up"],
		["shift+down", "down"],
		["alt+shift+left", "wordLeft"],
		["alt+shift+right", "wordRight"],
		["ctrl+shift+left", "wordLeft"],
		["ctrl+shift+right", "wordRight"],
		["shift+home", "lineStart"],
		["shift+end", "lineEnd"],
		["super+shift+left", "lineStart"],
		["super+shift+right", "lineEnd"],
		["super+shift+up", "docStart"],
		["super+shift+down", "docEnd"],
		["ctrl+shift+home", "docStart"],
		["ctrl+shift+end", "docEnd"],
	];

	private static readonly MOVE_KEYS: [KeyId, string][] = [
		["super+left", "lineStart"],
		["super+right", "lineEnd"],
		["super+up", "docStart"],
		["super+down", "docEnd"],
	];

	// ── keyboard ───────────────────────────────────────────────────────

	handleInput(data: string): void {
		const before = this.getText();
		this.handleKey(data);
		// Only when the text changed, so Escape can still dismiss the menu.
		if (this.getText() !== before) this.showArgumentCompletions();
	}

	/**
	 * pi only shows a command's argument completions once you type a letter after the space.
	 * Show them as soon as the prompt is "/command " so the options are discoverable.
	 */
	private showArgumentCompletions(): void {
		const I = this.I;
		if (I.autocompleteState || I.isInPaste || this.selection()) return;
		const { lines, cursorLine, cursorCol } = I.state;
		const line = lines[0]!;
		if (lines.length !== 1 || cursorLine !== 0 || cursorCol !== line.length) return;
		if (!/^\/\S+ $/.test(line)) return;
		I.tryTriggerAutocomplete();
	}

	private handleKey(data: string): void {
		const I = this.I;
		const kb = getKeybindings();

		// Paste: replace the selection with the pasted text.
		if (I.isInPaste || I.jumpMode !== null) return super.handleInput(data);
		if (data.includes("\x1b[200~")) {
			// Bracketed paste may arrive in several chunks. The snapshot taken by deleteSelection
			// covers the whole replacement, so skip the one handlePaste pushes when it completes.
			if (this.deleteSelection()) this.skipNextPasteSnapshot = true;
			this.anchor = null;
			return super.handleInput(data);
		}

		if (this.settings.enterInsertsNewline) {
			// Plain Enter: newline. Exceptions keep pi's behavior: the autocomplete menu is open
			// (Enter picks an item), or the prompt is a single-line slash command (Enter runs it).
			if (matchesKey(data, "enter") && !this.isShowingAutocomplete() && !this.isSlashCommand()) {
				if (this.selection()) this.replaceSelection(() => I.addNewLine());
				else I.addNewLine();
				this.anchor = null;
				return;
			}
			// Shift+Enter (CSI u, ESC CR, or LF depending on the terminal): submit.
			if (matchesKey(data, "shift+enter")) {
				this.anchor = null;
				return super.handleInput("\r");
			}
		}

		const motions = this.motions();
		const finishMove = () => {
			I.lastAction = null;
			if (I.autocompleteState) I.cancelAutocomplete();
			this.tui.requestRender();
		};

		// Extend selection.
		for (const [key, motion] of GhosttyNativeEditor.EXTEND_KEYS) {
			if (matchesKey(data, key)) {
				if (!this.selection()) this.setAnchor(this.cursor());
				motions[motion]!();
				this.anchorText = this.getText();
				return finishMove();
			}
		}

		// Cmd motions (no selection).
		for (const [key, motion] of GhosttyNativeEditor.MOVE_KEYS) {
			if (matchesKey(data, key)) {
				this.anchor = null;
				motions[motion]!();
				return finishMove();
			}
		}

		const sel = this.selection();

		// Commands.
		if (matchesKey(data, "super+a")) {
			this.setAnchor({ line: 0, col: 0 });
			this.setCursor(this.docEnd());
			return finishMove();
		}
		if (matchesKey(data, "super+c") || (sel && kb.matches(data, "tui.input.copy"))) return this.copy(false);
		if (matchesKey(data, "super+x")) return this.copy(true);
		if (matchesKey(data, "super+z")) return I.undo();
		if (matchesKey(data, "super+shift+z") || matchesKey(data, "super+y")) return this.redo();
		if (matchesKey(data, "super+backspace")) {
			if (!this.deleteSelection()) super.handleInput("\x15"); // ctrl+u
			return;
		}

		if (!sel) return super.handleInput(data);

		// ── there is a non-empty selection ──

		if (matchesKey(data, "escape")) {
			this.anchor = null;
			return this.tui.requestRender();
		}
		if (kb.matches(data, "tui.editor.cursorLeft") || kb.matches(data, "tui.editor.cursorRight")) {
			this.setCursor(kb.matches(data, "tui.editor.cursorLeft") ? sel.start : sel.end);
			this.anchor = null;
			return finishMove();
		}

		const deletes = [
			"tui.editor.deleteCharBackward",
			"tui.editor.deleteCharForward",
			"tui.editor.deleteWordBackward",
			"tui.editor.deleteWordForward",
			"tui.editor.deleteToLineStart",
			"tui.editor.deleteToLineEnd",
		] as const;
		if (deletes.some((id) => kb.matches(data, id)) || matchesKey(data, "shift+backspace") || matchesKey(data, "shift+delete")) {
			this.deleteSelection();
			return;
		}

		if (this.isInsertion(data, kb)) return this.replaceSelection(() => super.handleInput(data));

		// Anything else (submit, history, app shortcuts, …): drop the selection and pass through.
		this.anchor = null;
		super.handleInput(data);
	}

	/** A single-line prompt starting with "/", e.g. "/model" or "/native-editor enter-newline on". */
	private isSlashCommand(): boolean {
		const lines = this.I.state.lines;
		return lines.length === 1 && lines[0]!.startsWith("/");
	}

	private isInsertion(data: string, kb: ReturnType<typeof getKeybindings>): boolean {
		if (kb.matches(data, "tui.input.submit")) return false;
		if (
			kb.matches(data, "tui.input.newLine") ||
			data === "\x1b\r" ||
			data === "\x1b[13;2~" ||
			data === "\n" ||
			matchesKey(data, "shift+space")
		)
			return true;
		if (decodeKittyPrintable(data) !== undefined) return true;
		const c = data.charCodeAt(0);
		return c >= 32 && c !== 127 && !data.includes("\x1b");
	}

	// ── mouse ──────────────────────────────────────────────────────────

	private paddingFor(width: number): number {
		return Math.min(this.I.paddingX, Math.max(0, Math.floor((width - 1) / 2)));
	}

	/** Map local mouse coordinates (y = 1 is the first text row) to a text position. */
	private posAt(x: number, y: number, width: number): Pos {
		const I = this.I;
		const vls = I.buildVisualLineMap(I.lastWidth);
		const idx = Math.max(0, Math.min(vls.length - 1, I.scrollOffset + y - 1));
		const vl = vls[idx]!;
		const line = I.state.lines[vl.logicalLine] ?? "";
		const chunk = line.slice(vl.startCol, vl.startCol + vl.length);
		const target = Math.max(0, x - this.paddingFor(width));
		let column = 0;
		let index = chunk.length;
		let lastIndex = 0;
		for (const g of I.segment(chunk, "grapheme")) {
			const w = visibleWidth(g.segment);
			lastIndex = g.index;
			if (target < column + w) {
				// Snap to the nearer edge of the grapheme, like native text fields.
				index = target - column >= w / 2 && w > 1 ? g.index + g.segment.length : g.index;
				break;
			}
			column += w;
		}
		const isLastSegment = idx === vls.length - 1 || vls[idx + 1]?.logicalLine !== vl.logicalLine;
		if (!isLastSegment && index >= chunk.length && chunk.length > 0) index = lastIndex;
		return { line: vl.logicalLine, col: vl.startCol + index };
	}

	private selectWordAt(p: Pos): void {
		const line = this.I.state.lines[p.line] ?? "";
		for (const s of this.I.segment(line, "word")) {
			const end = s.index + s.segment.length;
			if (p.col >= s.index && (p.col < end || end === line.length)) {
				this.setAnchor({ line: p.line, col: s.index });
				this.setCursor({ line: p.line, col: end });
				return;
			}
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const I = this.I;
		const textRows = I.renderedVisibleLineCount;
		const inText = event.y >= 1 && event.y <= textRows;

		if (event.type === "press" && event.button === "left" && inText) {
			const p = this.posAt(event.x, event.y, event.width);
			I.exitHistoryBrowsing();
			I.lastAction = null;
			if (I.autocompleteState) I.cancelAutocomplete();
			if (event.shift) {
				if (!this.selection()) this.setAnchor(this.cursor());
			} else {
				this.setAnchor(p);
			}
			this.setCursor(p);
			this.anchorText = this.getText();
			this.dragging = true;
			return { capture: true, focus: true };
		}

		if (this.dragging && event.type === "drag") {
			// Rows above/below the visible text extend one line past it, so the view scrolls.
			const y = Math.max(0, Math.min(textRows + 1, event.y));
			this.setCursor(this.posAt(event.x, y, event.width));
			return { handled: true };
		}

		if (this.dragging && event.type === "release") {
			this.dragging = false;
			if (!this.selection()) this.anchor = null;
			return { handled: true, render: true };
		}

		if (event.type === "click" && event.button === "left" && inText) {
			const p = this.posAt(event.x, event.y, event.width);
			if (event.clickCount === 2) this.selectWordAt(p);
			else if (event.clickCount === 3) {
				const lines = I.state.lines;
				this.setAnchor({ line: p.line, col: 0 });
				this.setCursor(p.line < lines.length - 1 ? { line: p.line + 1, col: 0 } : { line: p.line, col: lines[p.line]!.length });
			}
			return { handled: true, focus: true };
		}

		return super.handleMouse(event);
	}

	// ── rendering ──────────────────────────────────────────────────────

	render(width: number): string[] {
		const out = super.render(width);
		const sel = this.selection();
		if (!sel) return out;

		const I = this.I;
		const vls = I.buildVisualLineMap(I.lastWidth);
		const cursorVl = I.findVisualLineAt(vls, I.state.cursorLine, I.state.cursorCol);
		const paddingX = this.paddingFor(width);
		const contentWidth = Math.max(1, width - paddingX * 2);
		const pad = " ".repeat(paddingX);

		for (let row = 0; row < I.renderedVisibleLineCount; row++) {
			const idx = I.scrollOffset + row;
			const vl = vls[idx];
			if (!vl) continue;
			const L = vl.logicalLine;
			if (L < sel.start.line || L > sel.end.line) continue;

			const line = I.state.lines[L] ?? "";
			const text = line.slice(vl.startCol, vl.startCol + vl.length);
			const selFrom = Math.max(0, (L === sel.start.line ? sel.start.col : 0) - vl.startCol);
			const selTo = Math.min(text.length, (L === sel.end.line ? sel.end.col : Number.POSITIVE_INFINITY) - vl.startCol);
			const isLastSegment = idx === vls.length - 1 || vls[idx + 1]?.logicalLine !== L;
			const newlineSelected = isLastSegment && L < sel.end.line;
			const hasCursor = idx === cursorVl;
			const cursorPos = hasCursor ? Math.min(I.state.cursorCol - vl.startCol, text.length) : -1;
			const marker = this.focused ? CURSOR_MARKER : "";

			let display = "";
			let run = "";
			const flush = () => {
				if (run) display += this.highlight(run);
				run = "";
			};
			for (const g of I.segment(text, "grapheme")) {
				const selected = g.index >= selFrom && g.index < selTo;
				if (g.index === cursorPos) {
					// Like native text fields, show no caret inside a selection; keep the marker for IME placement.
					flush();
					display += marker;
					if (selected) run += g.segment;
					else display += g.segment;
				} else if (selected) run += g.segment;
				else {
					flush();
					display += g.segment;
				}
			}
			flush();

			let w = visibleWidth(text);
			if (cursorPos === text.length) display += marker;
			if (newlineSelected && w < contentWidth) {
				display += this.highlight(" ");
				w += 1;
			}
			out[row + 1] = `${pad}${display}${" ".repeat(Math.max(0, contentWidth - w))}${pad}`;
		}
		return out;
	}
}

export default function (pi: ExtensionAPI) {
	// Shared with live editor instances, so /native-editor changes apply immediately.
	const settings = loadSettings();

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		const highlight = (text: string) => {
			try {
				return ctx.ui.theme.bg("selectedBg", text);
			} catch {
				return `\x1b[7m${text}\x1b[27m`;
			}
		};
		ctx.ui.setEditorComponent((tui, theme, kb) => new GhosttyNativeEditor(tui, theme, kb, highlight, settings));
	});

	const describe = () =>
		settings.enterInsertsNewline
			? "Enter inserts a newline, Shift+Enter submits"
			: "Enter submits, Shift+Enter inserts a newline (pi default)";

	pi.on("session_start", () => {
		// Keep the installed copy of the keybindings current after package updates.
		try {
			if (existsSync(installedGhosttyConf())) syncInstalledGhosttyConf();
		} catch {
			// ignore
		}
	});

	const exec: ExecFn = (command, args, options) => pi.exec(command, args, options);

	const USAGE = [
		"Usage:",
		"  /native-editor                     show settings",
		"  /native-editor enter-newline on    Enter inserts a newline, Shift+Enter submits",
		"  /native-editor enter-newline off   Enter submits, Shift+Enter inserts a newline",
		"  /native-editor configure-ghostty   add the keybindings to the Ghostty config",
		"  /native-editor remove-ghostty      remove them from the Ghostty config",
	].join("\n");

	const ghosttyStatus = () => {
		const include = `config-file = ?${installedGhosttyConf()}`;
		const configured = ghosttyConfigCandidates().find(
			(p) => existsSync(p) && readFileSync(p, "utf8").split("\n").some((line) => line.trim() === include),
		);
		return configured ? `configured in ${configured}` : "not configured (run /native-editor configure-ghostty)";
	};

	const OPTIONS = [
		{ value: "enter-newline on", description: "Enter inserts a newline, Shift+Enter submits" },
		{ value: "enter-newline off", description: "Enter submits, Shift+Enter inserts a newline (pi default)" },
		{ value: "configure-ghostty", description: "Add the keybindings to the Ghostty config" },
		{ value: "remove-ghostty", description: "Remove the keybindings from the Ghostty config" },
	];

	pi.registerCommand("native-editor", {
		description: "Native editor settings: enter-newline on|off, configure-ghostty, remove-ghostty",
		getArgumentCompletions: (prefix) => {
			const items = OPTIONS.filter((o) => o.value.startsWith(prefix.trimStart())).map((o) => ({
				value: o.value,
				label: o.value,
				description: o.description,
			}));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			let [option, value] = args.trim().split(/\s+/);
			if (!option) {
				const status = `Native editor\n  Enter: ${describe()}\n  Ghostty: ${ghosttyStatus()}\n  Settings: ${settingsPath()}`;
				if (ctx.mode !== "tui") {
					ctx.ui.notify(`${status}\n\n${USAGE}`, "info");
					return;
				}
				// No arguments: let the user pick an option, so they're discoverable.
				const labels = OPTIONS.map((o) => `${o.value} — ${o.description}`);
				const picked = await ctx.ui.select(`${status}\n`, labels);
				if (!picked) return;
				[option, value] = OPTIONS[labels.indexOf(picked)]!.value.split(" ");
			}
			if (option === "configure-ghostty" || option === "remove-ghostty") {
				try {
					const message = option === "configure-ghostty" ? await configureGhostty(exec) : await removeGhostty(exec);
					ctx.ui.notify(message, "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}
			if (option !== "enter-newline" || (value !== "on" && value !== "off")) {
				ctx.ui.notify(USAGE, "warning");
				return;
			}
			settings.enterInsertsNewline = value === "on";
			try {
				saveSettings(settings);
			} catch (error) {
				ctx.ui.notify(`Could not save ${settingsPath()}: ${String(error)}`, "error");
			}
			ctx.ui.notify(`Native editor: ${describe()}`, "info");
		},
	});
}
