import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Dirent } from "node:fs";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const MONITOR_DIR = join(homedir(), ".pi", "agent", "monitor");
const STATE_FILE = join(MONITOR_DIR, "state.json");
const LOCK_DIR = join(MONITOR_DIR, ".state.lock");
const SESSION_ROOT = join(homedir(), ".pi", "agent", "sessions");
const STATE_VERSION = 1;

const REFRESH_MS = 1000;
const HEARTBEAT_MS = 5000;
const MAX_SESSION_FILES = 200;
const BOARD_WINDOW_MS = 48 * 60 * 60 * 1000;
const LIVE_SESSION_PREFIX = "live-session:";
const QUEUED_ITEM_SUFFIX = ":queued";
const LIVE_QUEUED_TTL_MS = 20_000;
const LIVE_SESSION_STALE_MS = 15_000;
const SUBAGENT_ITEM_TTL_MS = 2 * 60 * 1000;
const LOCK_TIMEOUT_MS = 2000;
const LOCK_STALE_MS = 5000;
const LOCK_RETRY_MS = 5;
const MIN_BOARD_ROWS = 8;
const MAX_BOARD_ROWS = 18;
const DETAIL_LIMIT = 500;

const STATUS_ORDER = ["queued", "in_progress", "blocked", "completed"] as const;
const MONITOR_KINDS = ["session", "agent", "subagent"] as const;

type MonitorStatus = (typeof STATUS_ORDER)[number];
type MonitorKind = (typeof MONITOR_KINDS)[number];

const MONITOR_STATUSES: ReadonlySet<string> = new Set(STATUS_ORDER);
const MONITOR_KIND_SET: ReadonlySet<string> = new Set(MONITOR_KINDS);

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
	version: typeof STATE_VERSION;
	updatedAt: number;
	sessions: Record<string, MonitorSession>;
	items: Record<string, MonitorItem>;
};

type SessionIdentity = {
	sessionId: string;
	sessionFile?: string;
	cwd: string;
};

type ItemInput = Omit<MonitorItem, "sessionId" | "sessionFile" | "cwd" | "updatedAt">;

type BoardColumns = Record<MonitorStatus, MonitorItem[]>;

function createEmptyState(): MonitorState {
	return { version: STATE_VERSION, updatedAt: Date.now(), sessions: {}, items: {} };
}

function ensureMonitorDir(): void {
	mkdirSync(MONITOR_DIR, { recursive: true });
}

// --- state persistence -------------------------------------------------------

function readState(): MonitorState {
	ensureMonitorDir();
	try {
		const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<MonitorState>;
		if (parsed?.version !== STATE_VERSION) return createEmptyState();
		return {
			version: STATE_VERSION,
			updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
			sessions: validSessions(parsed.sessions),
			items: validItems(parsed.items),
		};
	} catch {
		return createEmptyState();
	}
}

function validSessions(value: unknown): Record<string, MonitorSession> {
	const sessions: Record<string, MonitorSession> = {};
	for (const [id, session] of recordEntries(value)) {
		if (isMonitorSession(session)) sessions[id] = session;
	}
	return sessions;
}

function validItems(value: unknown): Record<string, MonitorItem> {
	const items: Record<string, MonitorItem> = {};
	for (const [id, item] of recordEntries(value)) {
		if (isMonitorItem(item) && item.id === id) items[id] = item;
	}
	return items;
}

function recordEntries(value: unknown): Array<[string, unknown]> {
	return value && typeof value === "object" ? Object.entries(value as Record<string, unknown>) : [];
}

function isMonitorSession(value: unknown): value is MonitorSession {
	const session = value as MonitorSession | null;
	return (
		typeof session?.id === "string" &&
		typeof session.cwd === "string" &&
		typeof session.startedAt === "number" &&
		typeof session.updatedAt === "number" &&
		(session.state === "active" || session.state === "shutdown")
	);
}

function isMonitorItem(value: unknown): value is MonitorItem {
	const item = value as MonitorItem | null;
	return (
		typeof item?.id === "string" &&
		typeof item.sessionId === "string" &&
		typeof item.cwd === "string" &&
		typeof item.title === "string" &&
		typeof item.updatedAt === "number" &&
		MONITOR_STATUSES.has(item.status) &&
		MONITOR_KIND_SET.has(item.kind)
	);
}

function writeState(state: MonitorState): void {
	ensureMonitorDir();
	state.updatedAt = Date.now();
	const tmpFile = join(dirname(STATE_FILE), `.state.${process.pid}.${Date.now()}.tmp`);
	writeFileSync(tmpFile, `${JSON.stringify(state, null, "\t")}\n`, "utf8");
	renameSync(tmpFile, STATE_FILE);
}

/** The only transaction boundary: read, mutate, drop what the board can no longer show, write. */
function withState(mutator: (state: MonitorState) => void): void {
	ensureMonitorDir();
	if (!acquireLock()) return;
	try {
		const state = readState();
		mutator(state);
		pruneState(state);
		writeState(state);
	} finally {
		releaseLock();
	}
}

function pruneState(state: MonitorState): void {
	const now = Date.now();
	for (const [itemId, item] of Object.entries(state.items)) {
		if (!isBoardVisible(item, state, now)) delete state.items[itemId];
	}
}

const sleepSignal = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
	Atomics.wait(sleepSignal, 0, 0, ms);
}

/**
 * Returns false rather than stealing a lock another process still holds — a dropped
 * dashboard update is cheaper than two writers clobbering each other's state file.
 */
function acquireLock(): boolean {
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	let stolen = false;
	while (true) {
		try {
			mkdirSync(LOCK_DIR);
			return true;
		} catch {
			// Lock is held; decide whether to wait for it or reclaim an abandoned one.
		}
		if (!stolen && isAbandonedLock()) {
			stolen = true;
			rmSync(LOCK_DIR, { recursive: true, force: true });
			continue;
		}
		if (Date.now() >= deadline) return false;
		sleepSync(LOCK_RETRY_MS);
	}
}

function isAbandonedLock(): boolean {
	try {
		return Date.now() - statSync(LOCK_DIR).mtimeMs > LOCK_STALE_MS;
	} catch {
		return false;
	}
}

function releaseLock(): void {
	rmSync(LOCK_DIR, { recursive: true, force: true });
}

// --- board visibility --------------------------------------------------------

function liveSessionItemId(identity: SessionIdentity): string {
	return `${LIVE_SESSION_PREFIX}${identity.sessionId}`;
}

function queuedItemId(identity: SessionIdentity): string {
	return `${identity.sessionId}${QUEUED_ITEM_SUFFIX}`;
}

function subagentItemId(identity: SessionIdentity, toolCallId: unknown): string {
	return `${identity.sessionId}:tool:${String(toolCallId)}`;
}

/**
 * Single source of truth for what belongs on the board. Visibility only decays with
 * time, so pruning is just "delete what is no longer visible".
 */
function isBoardVisible(item: MonitorItem, state: MonitorState, now: number): boolean {
	if (item.id.startsWith(LIVE_SESSION_PREFIX)) return isLiveSessionFresh(item, state, now);
	if (item.id.endsWith(QUEUED_ITEM_SUFFIX)) return now - item.updatedAt <= LIVE_QUEUED_TTL_MS;
	if (item.kind === "subagent") return now - item.updatedAt <= SUBAGENT_ITEM_TTL_MS;
	return false;
}

/** A live row lives while its session heartbeats; once the session stops it lingers briefly, then the session-file scan takes over. */
function isLiveSessionFresh(item: MonitorItem, state: MonitorState, now: number): boolean {
	const session = state.sessions[item.sessionId];
	const anchor = session?.state === "active" ? session.updatedAt : item.updatedAt;
	return now - anchor <= LIVE_SESSION_STALE_MS;
}

// --- state mutators (all called inside withState) ----------------------------

function touchSession(state: MonitorState, identity: SessionIdentity, sessionState?: MonitorSession["state"]): void {
	const now = Date.now();
	const existing = state.sessions[identity.sessionId];
	state.sessions[identity.sessionId] = {
		id: identity.sessionId,
		sessionFile: identity.sessionFile,
		cwd: identity.cwd,
		startedAt: existing?.startedAt ?? now,
		updatedAt: now,
		state: sessionState ?? existing?.state ?? "active",
	};
}

function putItem(state: MonitorState, identity: SessionIdentity, item: ItemInput): void {
	const now = Date.now();
	touchSession(state, identity);
	const existing = state.items[item.id];
	state.items[item.id] = {
		...existing,
		...item,
		startedAt: existing?.startedAt ?? item.startedAt,
		sessionId: identity.sessionId,
		sessionFile: identity.sessionFile,
		cwd: identity.cwd,
		updatedAt: now,
	};
}

function putLiveSessionItem(state: MonitorState, identity: SessionIdentity, item: Pick<MonitorItem, "title" | "status" | "details">): void {
	putItem(state, identity, {
		id: liveSessionItemId(identity),
		kind: "session",
		startedAt: Date.now(),
		...item,
	});
}

function markItemCompleted(state: MonitorState, identity: SessionIdentity, itemId: string, details: string): void {
	const existing = state.items[itemId];
	if (!existing) return;
	const now = Date.now();
	state.items[itemId] = { ...existing, status: "completed", details, completedAt: now, updatedAt: now };
	touchSession(state, identity);
}

function removeQueuedItems(state: MonitorState, identity: SessionIdentity): void {
	const currentId = queuedItemId(identity);
	const legacyPrefix = `${currentId}:`;
	for (const itemId of Object.keys(state.items)) {
		if (itemId === currentId || itemId.startsWith(legacyPrefix)) delete state.items[itemId];
	}
}

function syncQueuedItem(state: MonitorState, identity: SessionIdentity, hasPending: boolean): void {
	if (!hasPending) {
		removeQueuedItems(state, identity);
		return;
	}
	const itemId = queuedItemId(identity);
	const existing = state.items[itemId];
	if (existing) {
		state.items[itemId] = { ...existing, updatedAt: Date.now() };
		touchSession(state, identity);
		return;
	}
	putItem(state, identity, {
		id: itemId,
		kind: "agent",
		status: "queued",
		title: "Queued message",
		startedAt: Date.now(),
		details: "Pi has pending steer or follow-up messages",
	});
}

// --- pi context adapters -----------------------------------------------------

function getSessionIdentity(ctx: any): SessionIdentity {
	const sessionManager = ctx.sessionManager;
	const sessionId = sessionManager?.getSessionId?.() ?? sessionManager?.getHeader?.()?.id ?? `pid-${process.pid}`;
	return {
		sessionId,
		sessionFile: sessionManager?.getSessionFile?.(),
		cwd: sessionManager?.getCwd?.() ?? ctx.cwd ?? process.cwd(),
	};
}

function hasPendingMessages(ctx: unknown): boolean {
	return (ctx as { hasPendingMessages?: () => boolean } | null)?.hasPendingMessages?.() === true;
}

function isSubagentTool(toolName: unknown): boolean {
	return String(toolName ?? "").includes("subagent");
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

function inferLiveSessionStatus(messages: unknown): MonitorStatus {
	const text = textFromMessages(messages).toLowerCase();
	return textNeedsInput(text) ? "blocked" : "completed";
}

function textFromMessages(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	return messages
		.map((message: any) => textFromInput(message?.content ?? message?.message?.content))
		.join(" ")
		.trim();
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

function textNeedsInput(text: string): boolean {
	return /awaiting user|waiting for user|waiting on user|seeking input|ask(?:ing)? for input|please enter|please provide|what should i use|needs input|need your input|let me know|please confirm|confirm\b|permission required|needs attention/.test(text);
}

// --- board assembly ----------------------------------------------------------

function emptyColumns(): BoardColumns {
	return { queued: [], in_progress: [], blocked: [], completed: [] };
}

function statusColumns(state: MonitorState, sessionItems: MonitorItem[]): BoardColumns {
	const now = Date.now();
	const columns = emptyColumns();

	const itemsByKey = new Map<string, MonitorItem>();
	for (const item of sessionItems) itemsByKey.set(boardItemKey(item), item);
	for (const item of Object.values(state.items)) {
		if (isBoardVisible(item, state, now)) itemsByKey.set(boardItemKey(item), item);
	}

	for (const item of itemsByKey.values()) columns[item.status].push(item);
	for (const items of Object.values(columns)) items.sort((a, b) => b.updatedAt - a.updatedAt);
	return columns;
}

function boardItemKey(item: MonitorItem): string {
	if (item.kind === "session") return `session:${item.sessionFile ?? item.sessionId}`;
	return item.id;
}

function visibleRowCount(columns: BoardColumns): number {
	const longest = Math.max(...STATUS_ORDER.map((status) => columns[status].length), 1);
	return Math.max(MIN_BOARD_ROWS, Math.min(MAX_BOARD_ROWS, longest));
}

function scrollMarker(total: number, offset: number, rows: number): string {
	const up = offset > 0 ? "↑" : "";
	const down = offset + rows < total ? "↓" : "";
	return up || down ? ` ${up}${down}` : "";
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

// --- pi session files (disk fallback) ----------------------------------------

type SessionFileInfo = { path: string; mtimeMs: number };

type PiSessionScan = { items: MonitorItem[]; archivedCount: number };

type CachedSessionItem = { mtimeMs: number; item: MonitorItem };

/** Parsed session files keyed by path, reused until the file's mtime changes. */
let sessionItemCache = new Map<string, CachedSessionItem>();

function scanPiSessions(): PiSessionScan {
	const cutoff = Date.now() - BOARD_WINDOW_MS;
	const recent: SessionFileInfo[] = [];
	let archivedCount = 0;

	for (const file of listSessionFiles(SESSION_ROOT)) {
		if (file.mtimeMs >= cutoff) recent.push(file);
		else archivedCount++;
	}
	recent.sort((a, b) => b.mtimeMs - a.mtimeMs);

	const nextCache = new Map<string, CachedSessionItem>();
	const items: MonitorItem[] = [];
	for (const file of recent.slice(0, MAX_SESSION_FILES)) {
		const item = cachedPiSessionItem(file, nextCache);
		if (item) items.push(item);
	}
	sessionItemCache = nextCache;

	return { items, archivedCount };
}

function cachedPiSessionItem(file: SessionFileInfo, nextCache: Map<string, CachedSessionItem>): MonitorItem | undefined {
	const cached = sessionItemCache.get(file.path);
	if (cached?.mtimeMs === file.mtimeMs) {
		nextCache.set(file.path, cached);
		return cached.item;
	}

	const item = readPiSessionItem(file);
	if (item) nextCache.set(file.path, { mtimeMs: file.mtimeMs, item });
	return item;
}

/** Stats each file exactly once — the mtime is carried alongside the path from here on. */
function listSessionFiles(root: string): SessionFileInfo[] {
	const files: SessionFileInfo[] = [];
	collectSessionFiles(root, files);
	return files;
}

function collectSessionFiles(dir: string, files: SessionFileInfo[]): void {
	for (const entry of readSessionDir(dir)) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			collectSessionFiles(path, files);
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
		const mtimeMs = safeMtimeMs(path);
		if (mtimeMs > 0) files.push({ path, mtimeMs });
	}
}

function readSessionDir(dir: string): Dirent[] {
	try {
		return readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

function safeMtimeMs(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

function readPiSessionItem(file: SessionFileInfo): MonitorItem | undefined {
	const summary = readPiSessionSummary(file.path);
	if (!summary) return undefined;
	return {
		id: `session:${file.path}`,
		sessionId: summary.sessionId ?? file.path,
		sessionFile: file.path,
		cwd: summary.cwd ?? "",
		title: formatPiSessionTitle(summary),
		status: "completed",
		kind: "session",
		startedAt: summary.startedAt,
		updatedAt: file.mtimeMs,
		completedAt: file.mtimeMs,
		details: formatPiSessionDetails(summary, file.path),
	};
}

type PiSessionSummary = {
	sessionId?: string;
	cwd?: string;
	name?: string;
	firstUserPrompt?: string;
	lastUserPrompt?: string;
	lastTool?: string;
	lastAssistantText?: string;
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

// --- formatting --------------------------------------------------------------

function formatAge(timestamp?: number): string {
	if (!timestamp) return "";
	const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h`;
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

function kindIcon(kind: MonitorKind): string {
	switch (kind) {
		case "agent":
			return "●";
		case "subagent":
			return "◇";
		case "session":
			return "○";
	}
}

// --- dashboard ---------------------------------------------------------------

class MonitorDashboard {
	private interval: ReturnType<typeof setInterval> | undefined;
	private selectedColumn = 0;
	private selectedRow = 0;
	private rowOffsets: Record<MonitorStatus, number> = { queued: 0, in_progress: 0, blocked: 0, completed: 0 };
	private expanded = false;
	private state = readState();
	private scan = scanPiSessions();
	private columns = statusColumns(this.state, this.scan.items);
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
		if (matchesKey(data, "left")) this.selectedColumn -= 1;
		if (matchesKey(data, "right")) this.selectedColumn += 1;
		if (matchesKey(data, "up")) this.selectedRow -= 1;
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

		const lines: string[] = [];
		const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
		const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
		const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
		const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
		const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
		const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
		const reverse = (s: string) => `\x1b[7m${s}\x1b[27m`;

		const columnStyles: Record<MonitorStatus, { label: string; color: (s: string) => string }> = {
			queued: { label: "Queued", color: yellow },
			in_progress: { label: "In Progress", color: cyan },
			blocked: { label: "Blocked", color: red },
			completed: { label: "Completed", color: green },
		};
		const columns = this.columns;
		const rows = visibleRowCount(columns);
		const columnWidth = Math.max(18, Math.floor((width - 5) / 4));
		const boardWidth = columnWidth * 4 + 5;
		const selectedItem = this.getSelectedItem();

		lines.push(this.pad(truncateToWidth(`${bold("Pi Monitor")} ${dim("/monitor")}  ${dim("Board")}`, width), width));
		lines.push(this.pad(truncateToWidth(`${dim("r refresh • arrows select • enter details • q/esc close")}  ${dim(`pi sessions ${this.scan.items.length} • archive ${this.scan.archivedCount} • updated ${formatAge(this.state.updatedAt)} ago`)}`, width), width));
		lines.push(this.pad(dim(`╭${"─".repeat(Math.max(0, boardWidth - 2))}╮`), width));

		const header = STATUS_ORDER.map((status, index) => {
			const { label, color } = columnStyles[status];
			const count = columns[status].length;
			const title = ` ${color(bold(label))} ${dim(`(${count})${scrollMarker(count, this.rowOffsets[status], rows)}`)}`;
			return this.cell(index === this.selectedColumn ? reverse(title) : title, columnWidth);
		}).join(dim("│"));
		lines.push(this.pad(`${dim("│")}${header}${dim("│")}`, width));
		lines.push(this.pad(dim(`├${Array.from({ length: 4 }, () => "─".repeat(columnWidth)).join("┼")}┤`), width));

		for (let row = 0; row < rows; row++) {
			const rowText = STATUS_ORDER.map((status, column) => {
				const index = row + this.rowOffsets[status];
				const item = columns[status][index];
				if (!item) return this.cell("", columnWidth);
				const selected = column === this.selectedColumn && index === this.selectedRow;
				const marker = selected ? "›" : " ";
				const text = `${marker} ${kindIcon(item.kind)} ${item.title} ${dim(formatAge(item.updatedAt))}`;
				return this.cell(selected ? reverse(text) : text, columnWidth);
			}).join(dim("│"));
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
		this.scan = scanPiSessions();
		this.columns = statusColumns(this.state, this.scan.items);
		this.clampSelection();
		this.bump();
		this.tui.requestRender();
	}

	private bump(): void {
		this.version++;
		this.cachedWidth = 0;
	}

	/** Keeps the cursor inside its column and scrolls that column so the cursor stays on screen. */
	private clampSelection(): void {
		this.selectedColumn = clamp(this.selectedColumn, 0, STATUS_ORDER.length - 1);
		const status = STATUS_ORDER[this.selectedColumn];
		const total = this.columns[status].length;
		const rows = visibleRowCount(this.columns);

		this.selectedRow = clamp(this.selectedRow, 0, Math.max(0, total - 1));
		const offset = clamp(this.rowOffsets[status], 0, Math.max(0, total - rows));
		if (this.selectedRow < offset) this.rowOffsets[status] = this.selectedRow;
		else if (this.selectedRow >= offset + rows) this.rowOffsets[status] = this.selectedRow - rows + 1;
		else this.rowOffsets[status] = offset;
	}

	private getSelectedItem(): MonitorItem | undefined {
		return this.columns[STATUS_ORDER[this.selectedColumn]][this.selectedRow];
	}

	private cell(content: string, width: number): string {
		const text = truncateToWidth(content, width - 1);
		return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
	}

	private pad(line: string, width: number): string {
		return `${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`;
	}
}

// --- extension ---------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let heartbeat: ReturnType<typeof setInterval> | undefined;

	pi.on("session_start", async (_event, ctx) => {
		const sessionName = ensureCurrentSessionName(pi, ctx);
		const identity = getSessionIdentity(ctx);
		withState((state) => {
			touchSession(state, identity);
			removeQueuedItems(state, identity);
			putLiveSessionItem(state, identity, {
				title: sessionName,
				status: "completed",
				details: "Pi session is idle and ready for input",
			});
		});

		if (heartbeat) clearInterval(heartbeat);
		heartbeat = setInterval(() => {
			const pending = hasPendingMessages(ctx);
			withState((state) => {
				touchSession(state, identity);
				syncQueuedItem(state, identity, pending);
			});
		}, HEARTBEAT_MS);
	});

	pi.on("session_info_changed", async (event, ctx) => {
		if (event.name) showSessionName(ctx, event.name);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (heartbeat) clearInterval(heartbeat);
		heartbeat = undefined;
		const identity = getSessionIdentity(ctx);
		const title = pi.getSessionName?.() || generateSessionName(ctx);
		withState((state) => {
			putLiveSessionItem(state, identity, {
				title,
				status: "completed",
				details: "Pi session shut down",
			});
			touchSession(state, identity, "shutdown");
		});
	});

	pi.on("input", async (event, ctx) => {
		if (!event.streamingBehavior) return;
		const identity = getSessionIdentity(ctx);
		const title = textFromInput(event.text) || `${event.streamingBehavior} message`;
		withState((state) => {
			removeQueuedItems(state, identity);
			putItem(state, identity, {
				id: queuedItemId(identity),
				kind: "agent",
				status: "queued",
				title,
				startedAt: Date.now(),
				details: `Queued ${event.streamingBehavior} message`,
			});
		});
	});

	pi.on("agent_start", async (_event, ctx) => {
		const identity = getSessionIdentity(ctx);
		const title = pi.getSessionName?.() || generateSessionName(ctx);
		withState((state) => {
			removeQueuedItems(state, identity);
			putLiveSessionItem(state, identity, {
				title,
				status: "in_progress",
				details: "Pi agent is processing a prompt",
			});
		});
	});

	pi.on("turn_start", async (_event, ctx) => {
		const identity = getSessionIdentity(ctx);
		const pending = hasPendingMessages(ctx);
		withState((state) => syncQueuedItem(state, identity, pending));
	});

	pi.on("agent_end", async (event, ctx) => {
		const identity = getSessionIdentity(ctx);
		const pending = hasPendingMessages(ctx);
		const status = inferLiveSessionStatus(event.messages);
		const title = pi.getSessionName?.() || generateSessionName(ctx);
		withState((state) => {
			syncQueuedItem(state, identity, pending);
			putLiveSessionItem(state, identity, {
				title,
				status,
				details: status === "blocked" ? "Pi agent is waiting for user input" : "Pi agent turn completed",
			});
		});
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		if (!isSubagentTool(event.toolName)) return;
		const identity = getSessionIdentity(ctx);
		withState((state) =>
			putItem(state, identity, {
				id: subagentItemId(identity, event.toolCallId),
				kind: "subagent",
				status: "in_progress",
				title: String(event.toolName ?? "subagent"),
				startedAt: Date.now(),
				details: JSON.stringify(event.args ?? {}).slice(0, DETAIL_LIMIT),
			}),
		);
	});

	pi.on("tool_execution_update", async (event, ctx) => {
		if (!isSubagentTool(event.toolName)) return;
		const identity = getSessionIdentity(ctx);
		const details = event.partialResult ? JSON.stringify(event.partialResult).slice(0, DETAIL_LIMIT) : undefined;
		withState((state) => {
			const itemId = subagentItemId(identity, event.toolCallId);
			const existing = state.items[itemId];
			if (!existing) return;
			state.items[itemId] = { ...existing, details: details ?? existing.details, updatedAt: Date.now() };
			touchSession(state, identity);
		});
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		const identity = getSessionIdentity(ctx);
		const details = event.isError ? "Subagent ended with an error" : "Subagent completed";
		withState((state) => markItemCompleted(state, identity, subagentItemId(identity, event.toolCallId), details));
	});

	pi.on("after_provider_response", async (event, ctx) => {
		if (event.status !== 429 && event.status < 500) return;
		const identity = getSessionIdentity(ctx);
		const title = pi.getSessionName?.() || generateSessionName(ctx);
		withState((state) =>
			putLiveSessionItem(state, identity, {
				title,
				status: "blocked",
				details: `Provider response ${event.status}`,
			}),
		);
	});

	pi.registerCommand("monitor", {
		description: "Show a board of queued, in-progress, blocked, and completed pi work across sessions",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Monitor requires interactive TUI mode", "error");
				return;
			}

			const identity = getSessionIdentity(ctx);
			withState((state) => touchSession(state, identity));
			await ctx.ui.custom((tui, _theme, _keybindings, done) => new MonitorDashboard(tui, () => done(undefined)));
		},
	});
}
