import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const MONITOR_DIR = join(homedir(), ".pi", "agent", "monitor");
const STATE_FILE = join(MONITOR_DIR, "state.json");
const LOCK_DIR = join(MONITOR_DIR, ".state.lock");
const EXTENSION_NAME = "monitor";
const REFRESH_MS = 1000;
const SESSION_ROOT = join(homedir(), ".pi", "agent", "sessions");
const MAX_SESSION_FILES = 200;
const BOARD_WINDOW_MS = 48 * 60 * 60 * 1000;

type MonitorStatus = "queued" | "in_progress" | "blocked" | "completed";
type MonitorKind = "session" | "agent" | "tool" | "bash" | "subagent" | "background";

type MonitorItem = {
	id: string;
	sessionId: string;
	sessionFile?: string;
	cwd: string;
	title: string;
	status: MonitorStatus;
	kind: MonitorKind;
	startedAt?: number;
	updatedAt: number;
	completedAt?: number;
	details?: string;
};

type MonitorSession = {
	id: string;
	sessionFile?: string;
	cwd: string;
	startedAt: number;
	updatedAt: number;
	state: "active" | "shutdown";
};

type MonitorState = {
	version: 1;
	updatedAt: number;
	sessions: Record<string, MonitorSession>;
	items: Record<string, MonitorItem>;
};

type SessionIdentity = {
	sessionId: string;
	sessionFile?: string;
	cwd: string;
};

function createEmptyState(): MonitorState {
	return { version: 1, updatedAt: Date.now(), sessions: {}, items: {} };
}

function ensureMonitorDir(): void {
	mkdirSync(MONITOR_DIR, { recursive: true });
}

function readState(): MonitorState {
	ensureMonitorDir();
	try {
		const raw = readFileSync(STATE_FILE, "utf8");
		const parsed = JSON.parse(raw) as MonitorState;
		return {
			version: 1,
			updatedAt: parsed.updatedAt ?? Date.now(),
			sessions: parsed.sessions ?? {},
			items: parsed.items ?? {},
		};
	} catch {
		return createEmptyState();
	}
}

function writeState(state: MonitorState): void {
	ensureMonitorDir();
	state.updatedAt = Date.now();
	const tmpFile = join(dirname(STATE_FILE), `.state.${process.pid}.${Date.now()}.tmp`);
	writeFileSync(tmpFile, `${JSON.stringify(state, null, "\t")}\n`, "utf8");
	renameSync(tmpFile, STATE_FILE);
}

function withState(mutator: (state: MonitorState) => void): void {
	ensureMonitorDir();
	acquireLock();
	try {
		const state = readState();
		mutator(state);
		writeState(state);
	} finally {
		releaseLock();
	}
}

function acquireLock(): void {
	const deadline = Date.now() + 500;
	while (true) {
		try {
			mkdirSync(LOCK_DIR);
			return;
		} catch {
			if (Date.now() > deadline) {
				rmSync(LOCK_DIR, { recursive: true, force: true });
				continue;
			}
		}
	}
}

function releaseLock(): void {
	rmSync(LOCK_DIR, { recursive: true, force: true });
}

function getSessionIdentity(ctx: any): SessionIdentity {
	const sessionManager = ctx.sessionManager;
	const sessionId = sessionManager?.getSessionId?.() ?? sessionManager?.getHeader?.()?.id ?? `pid-${process.pid}`;
	return {
		sessionId,
		sessionFile: sessionManager?.getSessionFile?.(),
		cwd: sessionManager?.getCwd?.() ?? ctx.cwd ?? process.cwd(),
	};
}

function ensureCurrentSessionName(pi: ExtensionAPI, ctx: any): string {
	const existing = pi.getSessionName?.() || ctx.sessionManager?.getSessionName?.();
	if (existing) {
		showSessionName(ctx, existing);
		return existing;
	}

	const generated = generateSessionName(ctx);
	pi.setSessionName?.(generated);
	showSessionName(ctx, generated);
	return generated;
}

function showSessionName(ctx: any, name: string): void {
	ctx.ui?.setStatus?.("monitor-session", `session ${name}`);
}

function generateSessionName(ctx: any): string {
	const sessionManager = ctx.sessionManager;
	const entries = sessionManager?.getEntries?.() ?? [];
	const firstPrompt = entries
		.map((entry: any) => entry?.message)
		.find((message: any) => message?.role === "user")?.content;
	const promptName = compactName(textFromInput(firstPrompt));
	if (promptName) return promptName;

	const cwd = sessionManager?.getCwd?.() ?? ctx.cwd ?? process.cwd();
	const sessionId = sessionManager?.getSessionId?.() ?? "session";
	return `${basename(cwd)}-${String(sessionId).slice(-4)}`;
}

function compactName(text: string): string {
	const words = oneLineSummary(text)
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, "")
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 5);
	return words.join("-");
}

function upsertSession(identity: SessionIdentity, state: "active" | "shutdown" = "active"): void {
	withState((monitorState) => {
		const now = Date.now();
		const existing = monitorState.sessions[identity.sessionId];
		monitorState.sessions[identity.sessionId] = {
			id: identity.sessionId,
			sessionFile: identity.sessionFile,
			cwd: identity.cwd,
			startedAt: existing?.startedAt ?? now,
			updatedAt: now,
			state,
		};
	});
}

function upsertItem(identity: SessionIdentity, item: Omit<MonitorItem, "sessionId" | "sessionFile" | "cwd" | "updatedAt">): void {
	withState((state) => {
		const now = Date.now();
		state.sessions[identity.sessionId] = {
			id: identity.sessionId,
			sessionFile: identity.sessionFile,
			cwd: identity.cwd,
			startedAt: state.sessions[identity.sessionId]?.startedAt ?? now,
			updatedAt: now,
			state: "active",
		};
		state.items[item.id] = {
			...state.items[item.id],
			...item,
			sessionId: identity.sessionId,
			sessionFile: identity.sessionFile,
			cwd: identity.cwd,
			updatedAt: now,
		};
	});
}

function completeItem(identity: SessionIdentity, itemId: string, details?: string): void {
	withState((state) => {
		const now = Date.now();
		const existing = state.items[itemId];
		if (!existing) return;
		state.items[itemId] = {
			...existing,
			status: "completed",
			details: details ?? existing.details,
			completedAt: now,
			updatedAt: now,
		};
		if (state.sessions[identity.sessionId]) {
			state.sessions[identity.sessionId].updatedAt = now;
		}
	});
}

function blockItem(identity: SessionIdentity, itemId: string, details?: string): void {
	withState((state) => {
		const now = Date.now();
		const existing = state.items[itemId];
		if (!existing) return;
		state.items[itemId] = {
			...existing,
			status: "blocked",
			details: details ?? existing.details,
			updatedAt: now,
		};
		if (state.sessions[identity.sessionId]) {
			state.sessions[identity.sessionId].updatedAt = now;
		}
	});
}

function textFromInput(text: unknown): string {
	if (typeof text === "string") return text.trim();
	if (Array.isArray(text)) {
		return text
			.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : ""))
			.join(" ")
			.trim();
	}
	return "";
}

function formatAge(timestamp?: number): string {
	if (!timestamp) return "";
	const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h`;
}

function statusColumns(state: MonitorState, extraItems: MonitorItem[] = []): Record<MonitorStatus, MonitorItem[]> {
	const columns: Record<MonitorStatus, MonitorItem[]> = {
		queued: [],
		in_progress: [],
		blocked: [],
		completed: [],
	};

	const items = extraItems.length > 0 ? extraItems : Object.values(state.items);
	for (const item of items) {
		if (shouldHideBoardItem(item)) continue;
		columns[item.status].push(item);
	}

	for (const items of Object.values(columns)) {
		items.sort((a, b) => b.updatedAt - a.updatedAt);
	}
	return columns;
}

function shouldHideBoardItem(item: MonitorItem): boolean {
	if (item.kind === "bash") return true;
	if (item.status === "completed" && item.kind === "tool") return true;
	return false;
}

function readPiSessionItems(): MonitorItem[] {
	const cutoff = Date.now() - BOARD_WINDOW_MS;
	return listSessionFiles(SESSION_ROOT)
		.filter((file) => safeMtimeMs(file) >= cutoff)
		.sort((a, b) => safeMtimeMs(b) - safeMtimeMs(a))
		.slice(0, MAX_SESSION_FILES)
		.map(readPiSessionItem)
		.filter((item): item is MonitorItem => Boolean(item));
}

function countArchivedPiSessions(): number {
	const cutoff = Date.now() - BOARD_WINDOW_MS;
	return listSessionFiles(SESSION_ROOT).filter((file) => safeMtimeMs(file) < cutoff).length;
}

function listSessionFiles(root: string): string[] {
	try {
		const files: string[] = [];
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			const path = join(root, entry.name);
			if (entry.isDirectory()) files.push(...listSessionFiles(path));
			if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
		}
		return files;
	} catch {
		return [];
	}
}

function readPiSessionItem(sessionFile: string): MonitorItem | undefined {
	const summary = readPiSessionSummary(sessionFile);
	if (!summary) return undefined;
	const updatedAt = safeMtimeMs(sessionFile) || Date.now();
	const status = inferPiSessionStatus(summary);
	return {
		id: `session:${sessionFile}`,
		sessionId: summary.sessionId ?? sessionFile,
		sessionFile,
		cwd: summary.cwd ?? "",
		title: formatPiSessionTitle(summary),
		status,
		kind: "session",
		startedAt: summary.startedAt,
		updatedAt,
		completedAt: status === "completed" ? updatedAt : undefined,
		details: formatPiSessionDetails(summary, sessionFile),
	};
}

function safeMtimeMs(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

type PiSessionSummary = {
	sessionId?: string;
	cwd?: string;
	name?: string;
	firstUserPrompt?: string;
	lastUserPrompt?: string;
	lastTool?: string;
	lastAssistantText?: string;
	lastMessageRole?: string;
	startedAt?: number;
};

function readPiSessionSummary(sessionFile: string): PiSessionSummary | undefined {
	try {
		const tail = readTail(sessionFile, 256 * 1024);
		const firstLine = readFirstLine(sessionFile);
		const lines = [firstLine, ...tail.split("\n")].filter((line) => line.trim().length > 0);
		const summary: PiSessionSummary = {};

		for (const line of lines) {
			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry.type === "session") {
				summary.sessionId = String(entry.id ?? "");
				summary.cwd = String(entry.cwd ?? "");
				summary.startedAt = Date.parse(entry.timestamp);
				continue;
			}
			if (entry.type === "session_info" && entry.name) {
				summary.name = String(entry.name);
				continue;
			}
			if (entry.type !== "message") continue;

			const message = entry.message;
			summary.lastMessageRole = message?.role;
			if (message?.role === "user") {
				const prompt = textFromInput(message.content);
				summary.firstUserPrompt ??= prompt;
				summary.lastUserPrompt = prompt;
			}
			if (message?.role === "assistant" && Array.isArray(message.content)) {
				const toolCall = [...message.content].reverse().find((part) => part?.type === "toolCall");
				const text = [...message.content].reverse().find((part) => part?.type === "text" && part.text);
				if (toolCall) summary.lastTool = String(toolCall.name ?? "tool");
				if (text) summary.lastAssistantText = String(text.text).trim();
			}
		}

		return summary;
	} catch {
		return undefined;
	}
}

function readTail(path: string, maxBytes: number): string {
	const size = statSync(path).size;
	const start = Math.max(0, size - maxBytes);
	const length = size - start;
	const buffer = Buffer.alloc(length);
	const fd = openSync(path, "r");
	try {
		readSync(fd, buffer, 0, length, start);
		return buffer.toString("utf8");
	} finally {
		closeSync(fd);
	}
}

function readFirstLine(path: string): string {
	const buffer = Buffer.alloc(8192);
	const fd = openSync(path, "r");
	try {
		const bytes = readSync(fd, buffer, 0, buffer.length, 0);
		return buffer.toString("utf8", 0, bytes).split("\n")[0] ?? "";
	} finally {
		closeSync(fd);
	}
}

function inferPiSessionStatus(summary: PiSessionSummary): MonitorStatus {
	const text = `${summary.lastAssistantText ?? ""} ${summary.lastUserPrompt ?? ""}`.toLowerCase();
	if (/queued|pending|next turn/.test(text)) return "queued";
	if (/awaiting user|waiting for user|waiting on user|seeking input|ask(?:ing)? for input|needs input|need your input|let me know|please confirm|confirm\b|permission required|needs attention/.test(text)) {
		return "blocked";
	}
	if (/running|launched|started|in progress|background|detached|monitoring|mid.flight|will report|once .* finishes|poll|screening|experiment/.test(text)) {
		return "in_progress";
	}
	if (summary.lastMessageRole === "toolResult") return "in_progress";
	return "completed";
}

function formatPiSessionTitle(summary: PiSessionSummary): string {
	const name = summary.name || summary.firstUserPrompt || "pi session";
	const activity = summary.lastAssistantText || summary.lastUserPrompt || "session active";
	return `${oneLineSummary(name)} — ${oneLineSummary(activity)}`;
}

function formatPiSessionDetails(summary: PiSessionSummary, sessionFile: string): string {
	const parts = [`resume ${resumeCommand(summary, sessionFile)}`];
	if (summary.name) parts.push(`name ${summary.name}`);
	parts.push(`summary ${shortSessionSummary(summary)}`);
	if (summary.cwd) parts.push(`cwd ${summary.cwd}`);
	if (summary.lastTool) parts.push(`last tool ${summary.lastTool}`);
	return parts.join(" • ");
}

function resumeCommand(summary: PiSessionSummary, sessionFile: string): string {
	return `pi --session ${summary.sessionId || shellQuote(sessionFile)}`;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function shortSessionSummary(summary: PiSessionSummary): string {
	const text = oneLineSummary(summary.lastAssistantText || summary.lastUserPrompt || summary.name || "No summary available.");
	return conciseSentences(text, 3, 80);
}

function conciseSentences(text: string, maxSentences: number, maxWords: number): string {
	const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [];
	const sentenceSummary = sentences.slice(0, maxSentences).join(" ");
	return limitWords(sentenceSummary || text, maxWords);
}

function limitWords(text: string, maxWords: number): string {
	const words = text.split(/\s+/).filter(Boolean);
	if (words.length <= maxWords) return words.join(" ");
	return `${words.slice(0, maxWords).join(" ")}…`;
}

function wrapDetailLine(label: string, text: string, width: number, maxLines: number): string[] {
	const prefix = `${label} `;
	const continuation = " ".repeat(prefix.length);
	const firstWidth = Math.max(20, width - visibleWidth(prefix));
	const nextWidth = Math.max(20, width - visibleWidth(continuation));
	const words = text.split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let current = "";
	let currentWidth = firstWidth;

	for (const word of words) {
		const candidate = current ? `${current} ${word}` : word;
		if (visibleWidth(candidate) <= currentWidth) {
			current = candidate;
			continue;
		}
		lines.push(`${lines.length === 0 ? prefix : continuation}${current}`);
		if (lines.length >= maxLines) return lines;
		current = word;
		currentWidth = nextWidth;
	}
	if (current && lines.length < maxLines) lines.push(`${lines.length === 0 ? prefix : continuation}${current}`);
	return lines;
}

function oneLineSummary(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/[#*_`>-]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

class MonitorDashboard {
	private interval: ReturnType<typeof setInterval> | undefined;
	private selectedColumn = 0;
	private selectedRow = 0;
	private expanded = false;
	private state = readState();
	private sessionItems = readPiSessionItems();
	private archivedSessionCount = countArchivedPiSessions();
	private version = 0;
	private cachedWidth = 0;
	private cachedVersion = -1;
	private cachedLines: string[] = [];

	constructor(
		private readonly tui: { requestRender: () => void },
		private readonly onClose: () => void,
	) {
		this.interval = setInterval(() => this.refresh(), REFRESH_MS);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q" || data === "Q") {
			this.dispose();
			this.onClose();
			return;
		}
		if (data === "r" || data === "R") {
			this.refresh();
			return;
		}
		if (matchesKey(data, "left")) this.selectedColumn = Math.max(0, this.selectedColumn - 1);
		if (matchesKey(data, "right")) this.selectedColumn = Math.min(3, this.selectedColumn + 1);
		if (matchesKey(data, "up")) this.selectedRow = Math.max(0, this.selectedRow - 1);
		if (matchesKey(data, "down")) this.selectedRow += 1;
		if (matchesKey(data, "enter")) this.expanded = !this.expanded;
		this.clampSelection();
		this.bump();
	}

	invalidate(): void {
		this.cachedWidth = 0;
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedVersion === this.version) return this.cachedLines;

		this.clampSelection();
		const lines: string[] = [];
		const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
		const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
		const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
		const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
		const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
		const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
		const reverse = (s: string) => `\x1b[7m${s}\x1b[27m`;

		const columnNames: Array<[MonitorStatus, string, (s: string) => string]> = [
			["queued", "Queued", yellow],
			["in_progress", "In Progress", cyan],
			["blocked", "Blocked", red],
			["completed", "Completed", green],
		];
		const columns = statusColumns(this.state, this.sessionItems);
		const columnWidth = Math.max(18, Math.floor((width - 5) / 4));
		const boardWidth = columnWidth * 4 + 5;
		const selectedItem = this.getSelectedItem(columns);

		lines.push(this.pad(truncateToWidth(`${bold("Pi Monitor")} ${dim("/monitor")}  ${dim("Board")}`, width), width));
		lines.push(this.pad(truncateToWidth(`${dim("r refresh • arrows select • enter details • q/esc close")}  ${dim(`pi sessions ${this.sessionItems.length} • archive ${this.archivedSessionCount} • updated ${formatAge(this.state.updatedAt)} ago`)}`, width), width));
		lines.push(this.pad(dim(`╭${"─".repeat(Math.max(0, boardWidth - 2))}╮`), width));

		const header = columnNames
			.map(([status, label, color], index) => {
				const title = ` ${color(bold(label))} ${dim(`(${columns[status].length})`)}`;
				return this.cell(index === this.selectedColumn ? reverse(title) : title, columnWidth);
			})
			.join(dim("│"));
		lines.push(this.pad(`${dim("│")}${header}${dim("│")}`, width));
		lines.push(this.pad(dim(`├${Array.from({ length: 4 }, () => "─".repeat(columnWidth)).join("┼")}┤`), width));

		const maxRows = Math.max(8, Math.min(18, Math.max(...Object.values(columns).map((items) => items.length), 1)));
		for (let row = 0; row < maxRows; row++) {
			const rowText = columnNames
				.map(([status], column) => {
					const item = columns[status][row];
					if (!item) return this.cell("", columnWidth);
					const marker = column === this.selectedColumn && row === this.selectedRow ? "›" : " ";
					const text = `${marker} ${kindIcon(item.kind)} ${item.title} ${dim(formatAge(item.updatedAt))}`;
					return this.cell(column === this.selectedColumn && row === this.selectedRow ? reverse(text) : text, columnWidth);
				})
				.join(dim("│"));
			lines.push(this.pad(`${dim("│")}${rowText}${dim("│")}`, width));
		}
		lines.push(this.pad(dim(`╰${"─".repeat(Math.max(0, boardWidth - 2))}╯`), width));

		if (this.expanded && selectedItem) {
			lines.push("");
			lines.push(this.pad(bold("Details"), width));
			lines.push(this.pad(truncateToWidth(`status: ${selectedItem.status}  age: ${formatAge(selectedItem.startedAt)}`, width), width));
			if (selectedItem.details) {
				for (const detail of selectedItem.details.split(" • ")) {
					if (detail.startsWith("summary ")) {
						for (const summaryLine of wrapDetailLine("summary", detail.slice("summary ".length), width, 3)) {
							lines.push(this.pad(summaryLine, width));
						}
						continue;
					}
					lines.push(this.pad(truncateToWidth(detail, width), width));
				}
			} else {
				lines.push(this.pad(truncateToWidth(`id: ${selectedItem.id}`, width), width));
				if (selectedItem.sessionFile) lines.push(this.pad(truncateToWidth(`session: ${selectedItem.sessionFile}`, width), width));
				if (selectedItem.cwd) lines.push(this.pad(truncateToWidth(`cwd: ${selectedItem.cwd}`, width), width));
			}
		}

		this.cachedLines = lines;
		this.cachedWidth = width;
		this.cachedVersion = this.version;
		return lines;
	}

	dispose(): void {
		if (this.interval) clearInterval(this.interval);
		this.interval = undefined;
	}

	private refresh(): void {
		this.state = readState();
		this.sessionItems = readPiSessionItems();
		this.archivedSessionCount = countArchivedPiSessions();
		this.clampSelection();
		this.bump();
		this.tui.requestRender();
	}

	private bump(): void {
		this.version++;
		this.cachedWidth = 0;
	}

	private clampSelection(): void {
		const columns = statusColumns(this.state, this.sessionItems);
		this.selectedColumn = Math.max(0, Math.min(3, this.selectedColumn));
		const status = ["queued", "in_progress", "blocked", "completed"][this.selectedColumn] as MonitorStatus;
		const maxRow = Math.max(0, columns[status].length - 1);
		this.selectedRow = Math.max(0, Math.min(maxRow, this.selectedRow));
	}

	private getSelectedItem(columns: Record<MonitorStatus, MonitorItem[]>): MonitorItem | undefined {
		const status = ["queued", "in_progress", "blocked", "completed"][this.selectedColumn] as MonitorStatus;
		return columns[status][this.selectedRow];
	}

	private cell(content: string, width: number): string {
		const text = truncateToWidth(content, width - 1);
		return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
	}

	private pad(line: string, width: number): string {
		return `${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`;
	}
}

function kindIcon(kind: MonitorKind): string {
	switch (kind) {
		case "agent":
			return "●";
		case "tool":
			return "◆";
		case "bash":
			return "$";
		case "subagent":
			return "◇";
		case "background":
			return "◌";
		case "session":
			return "○";
	}
}

export default function (pi: ExtensionAPI) {
	let heartbeat: ReturnType<typeof setInterval> | undefined;

	pi.on("session_start", async (_event, ctx) => {
		ensureCurrentSessionName(pi, ctx);
		const identity = getSessionIdentity(ctx);
		upsertSession(identity);
		if (heartbeat) clearInterval(heartbeat);
		heartbeat = setInterval(() => upsertSession(identity), 5000);
	});

	pi.on("session_info_changed", async (event, ctx) => {
		if (event.name) showSessionName(ctx, event.name);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (heartbeat) clearInterval(heartbeat);
		heartbeat = undefined;
		upsertSession(getSessionIdentity(ctx), "shutdown");
	});

	pi.on("input", async (event, ctx) => {
		if (!event.streamingBehavior) return;
		const identity = getSessionIdentity(ctx);
		const title = textFromInput(event.text) || `${event.streamingBehavior} message`;
		upsertItem(identity, {
			id: `${identity.sessionId}:queued:${Date.now()}`,
			kind: "agent",
			status: "queued",
			title,
			startedAt: Date.now(),
			details: `Queued ${event.streamingBehavior} message`,
		});
	});

	pi.on("agent_start", async (_event, ctx) => {
		const identity = getSessionIdentity(ctx);
		upsertItem(identity, {
			id: `${identity.sessionId}:agent`,
			kind: "agent",
			status: "in_progress",
			title: "Agent turn",
			startedAt: Date.now(),
			details: "Pi agent is processing a prompt",
		});
	});

	pi.on("agent_end", async (_event, ctx) => {
		const identity = getSessionIdentity(ctx);
		completeItem(identity, `${identity.sessionId}:agent`, "Agent turn completed");
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		const identity = getSessionIdentity(ctx);
		const kind: MonitorKind = event.toolName === "bash" ? "bash" : event.toolName?.includes("subagent") ? "subagent" : "tool";
		upsertItem(identity, {
			id: `${identity.sessionId}:tool:${event.toolCallId}`,
			kind,
			status: "in_progress",
			title: String(event.toolName ?? "tool"),
			startedAt: Date.now(),
			details: JSON.stringify(event.args ?? {}).slice(0, 500),
		});
	});

	pi.on("tool_execution_update", async (event, ctx) => {
		const identity = getSessionIdentity(ctx);
		upsertItem(identity, {
			id: `${identity.sessionId}:tool:${event.toolCallId}`,
			kind: event.toolName === "bash" ? "bash" : event.toolName?.includes("subagent") ? "subagent" : "tool",
			status: "in_progress",
			title: String(event.toolName ?? "tool"),
			startedAt: Date.now(),
			details: event.partialResult ? JSON.stringify(event.partialResult).slice(0, 500) : undefined,
		});
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		const identity = getSessionIdentity(ctx);
		const itemId = `${identity.sessionId}:tool:${event.toolCallId}`;
		if (event.isError) {
			blockItem(identity, itemId, "Tool ended with an error");
			return;
		}
		completeItem(identity, itemId, "Tool completed");
	});

	pi.on("after_provider_response", async (event, ctx) => {
		if (event.status !== 429 && event.status < 500) return;
		const identity = getSessionIdentity(ctx);
		blockItem(identity, `${identity.sessionId}:agent`, `Provider response ${event.status}`);
	});

	pi.registerCommand("monitor", {
		description: "Show a board of queued, in-progress, blocked, and completed pi work across sessions",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Monitor requires interactive TUI mode", "error");
				return;
			}

			upsertSession(getSessionIdentity(ctx));
			await ctx.ui.custom((tui, _theme, _keybindings, done) => new MonitorDashboard(tui, () => done(undefined)));
		},
	});
}
