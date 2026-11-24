/**
 * Read-only message stream for the headless collab guest
 * (`omp join --print-messages [--since <id>] [--follow]`).
 *
 * Joins **view-only** whatever link it is given: the write token is never sent,
 * so the host counts this peer as a viewer. A long-lived `--follow` therefore
 * never becomes a writer and never changes when the host's asks settle (see
 * docs/collab.md, "Keep the guest short-lived"). Viewers get no asks, so
 * approvals are not part of this stream; `--print-requests` lists them.
 *
 * Lines come from session entries only: the `snapshot-chunk` replay, then live
 * `entry` frames. An assistant message's entry is appended at its
 * `message_end`, so a `--follow` caller sees each message as it completes,
 * mid-turn included. Streaming deltas (`event` frames) are not printed.
 */
import { COLLAB_PROMPT_MESSAGE_TYPE, COLLAB_PROTO } from "@oh-my-pi/pi-wire";
import type { SessionEntry } from "../session/session-entries";
import { importRoomKey } from "./crypto";
import { HEADLESS_GUEST_PROTO, HeadlessGuestError, type HeadlessErrorCode } from "./headless-guest";
import type { CollabFrame } from "./protocol";
import { parseCollabLink } from "./protocol";
import { CollabSocket } from "./relay-client";
import { COLLAB_ENTRY_OMITTED_CUSTOM_TYPE } from "./replication-shrink";

/** Display name the host shows for a stream guest unless overridden. */
export const DEFAULT_STREAM_GUEST_NAME = "omp-watch";

/** Longest `summary` on a tool line; tool lines never carry the full payload. */
const TOOL_SUMMARY_CHARS = 160;

export interface StreamMessageLine {
	id: string;
	role: "assistant" | "user";
	ts: number;
	kind: "message";
	text: string;
	/** Display name of the collab guest that sent this prompt. */
	from?: string;
	/** Set only when `--max-chars` cut the text; `chars` is the full length. */
	truncated?: true;
	chars?: number;
	/** The host replaced an oversized entry (> 1 MiB of JSON) with a placeholder; the text is not the original. */
	omitted?: true;
	reset?: true;
}

export interface StreamToolLine {
	id: string;
	role: "assistant" | "tool" | "user";
	ts: number;
	kind: "tool";
	/** `call`: the assistant asked for a tool. `result`: the tool's output. `bash`: a user `!` command. */
	event: "call" | "result" | "bash";
	tool: string;
	toolCallId?: string;
	isError?: boolean;
	/** One line, at most {@link TOOL_SUMMARY_CHARS} characters. */
	summary: string;
	/** Length of the payload the summary stands for. */
	chars: number;
	reset?: true;
}

export type StreamLine = StreamMessageLine | StreamToolLine;

export interface EntryLineOptions {
	/** 0 = unlimited. */
	maxChars: number;
}

/** Sortable id prefix: the entry's own timestamp, zero-padded epoch ms. */
function idPrefix(entry: SessionEntry): { prefix: string; ts: number } {
	const parsed = Date.parse(entry.timestamp);
	const ts = Number.isFinite(parsed) ? parsed : 0;
	return { prefix: `${String(ts).padStart(13, "0")}-${entry.id}`, ts };
}

type ContentBlock = { type: string; text?: string };

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as ContentBlock[])
		.filter(block => block?.type === "text" && typeof block.text === "string")
		.map(block => block.text)
		.join("");
}

function oneLine(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > TOOL_SUMMARY_CHARS ? `${flat.slice(0, TOOL_SUMMARY_CHARS - 1)}…` : flat;
}

function messageLine(
	id: string,
	ts: number,
	role: "assistant" | "user",
	text: string,
	opts: EntryLineOptions,
): StreamMessageLine {
	const line: StreamMessageLine = { id, role, ts, kind: "message", text };
	if (opts.maxChars > 0 && text.length > opts.maxChars) {
		line.text = text.slice(0, opts.maxChars);
		line.truncated = true;
		line.chars = text.length;
	}
	return line;
}

/**
 * Every line one session entry yields, in order, tool lines included (the
 * caller filters). Ids are `<13-digit epoch ms>-<entry id>`, plus `.<n>` for the
 * n-th tool call of an assistant entry. They are stable across joins (both parts
 * are persisted), unique, and sort in append order.
 */
export function entryLines(entry: SessionEntry, opts: EntryLineOptions): StreamLine[] {
	const { prefix, ts } = idPrefix(entry);
	if (entry.type === "custom_message") {
		if (entry.customType === COLLAB_PROMPT_MESSAGE_TYPE) {
			const line = messageLine(prefix, ts, "user", textOf(entry.content), opts);
			const from = (entry.details as { from?: unknown } | undefined)?.from;
			if (typeof from === "string") line.from = from;
			return [line];
		}
		if (entry.customType === COLLAB_ENTRY_OMITTED_CUSTOM_TYPE) {
			const line = messageLine(prefix, ts, "assistant", textOf(entry.content), opts);
			line.omitted = true;
			return [line];
		}
		return [];
	}
	if (entry.type !== "message") return [];
	const message = entry.message as unknown as Record<string, unknown>;
	switch (message.role) {
		case "user": {
			const text = textOf(message.content);
			return text ? [messageLine(prefix, ts, "user", text, opts)] : [];
		}
		case "assistant": {
			const out: StreamLine[] = [];
			const text = textOf(message.content);
			if (text) out.push(messageLine(prefix, ts, "assistant", text, opts));
			const blocks = Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : [];
			let n = 0;
			for (const block of blocks) {
				if (block?.type !== "toolCall") continue;
				n++;
				const args = JSON.stringify(block.arguments ?? {});
				out.push({
					id: `${prefix}.${n}`,
					role: "assistant",
					ts,
					kind: "tool",
					event: "call",
					tool: String(block.name),
					toolCallId: String(block.id),
					summary: oneLine(args),
					chars: args.length,
				});
			}
			return out;
		}
		case "toolResult": {
			const text = textOf(message.content);
			return [
				{
					id: prefix,
					role: "tool",
					ts,
					kind: "tool",
					event: "result",
					tool: String(message.toolName),
					toolCallId: String(message.toolCallId),
					isError: message.isError === true,
					summary: oneLine(text),
					chars: text.length,
				},
			];
		}
		case "bashExecution": {
			const output = typeof message.output === "string" ? message.output : "";
			return [
				{
					id: prefix,
					role: "user",
					ts,
					kind: "tool",
					event: "bash",
					tool: "bash",
					isError: typeof message.exitCode === "number" && message.exitCode !== 0,
					summary: oneLine(String(message.command ?? "")),
					chars: output.length,
				},
			];
		}
		default:
			return [];
	}
}

/**
 * The snapshot lines to print for {@link since}: those after it, or all of them
 * marked `reset` when the cursor names no line of this snapshot.
 */
export function linesAfterCursor(lines: StreamLine[], since: string | undefined): StreamLine[] {
	if (since === undefined) return lines;
	const at = lines.findIndex(line => line.id === since);
	if (at >= 0) return lines.slice(at + 1);
	return lines.map(line => ({ ...line, reset: true }));
}

export interface HeadlessStreamOptions {
	link: string;
	name?: string;
	since?: string;
	follow: boolean;
	includeTools: boolean;
	/** 0 = unlimited. */
	maxChars: number;
	connectTimeoutMs: number;
	/** Budget to finish receiving the snapshot (the whole run without `follow`). */
	deadlineMs: number;
	/** Called once per line; must write it out unbuffered. */
	write(line: StreamLine): void;
}

/**
 * Join view-only, print the snapshot's lines after `since`, and, with `follow`,
 * every new line until the host ends the session. Resolves when the snapshot is
 * printed (no `follow`) or on the host's `bye` (`follow`); rejects with a
 * {@link HeadlessGuestError} on anything else, relay loss included. Never prints
 * or embeds the link.
 */
export async function runHeadlessStream(opts: HeadlessStreamOptions): Promise<void> {
	if (COLLAB_PROTO !== HEADLESS_GUEST_PROTO) {
		throw new HeadlessGuestError(
			"protocol",
			`headless guest speaks collab v${HEADLESS_GUEST_PROTO}, this build speaks v${COLLAB_PROTO}`,
		);
	}
	const parsed = parseCollabLink(opts.link);
	if ("error" in parsed) throw new HeadlessGuestError("link", "the link file does not hold a valid collab link");
	const key = await importRoomKey(parsed.key);
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	const done = Promise.withResolvers<void>();
	const timers: Timer[] = [];
	let finished = false;
	let opened = false;
	let welcomed = false;
	let expected = 0;
	let received = 0;
	let snapshotDone = false;
	const snapshot: StreamLine[] = [];
	const printed = new Set<string>();

	const fail = (code: HeadlessErrorCode, message: string) => {
		if (finished) return;
		finished = true;
		done.reject(new HeadlessGuestError(code, message));
	};
	const succeed = () => {
		if (finished) return;
		finished = true;
		done.resolve();
	};
	const clearTimers = () => {
		for (const timer of timers) clearTimeout(timer);
		timers.length = 0;
	};
	const emit = (line: StreamLine) => {
		if (printed.has(line.id)) return;
		printed.add(line.id);
		if (line.kind === "tool" && !opts.includeTools) return;
		opts.write(line);
	};
	const finishSnapshot = () => {
		snapshotDone = true;
		for (const line of linesAfterCursor(snapshot, opts.since)) emit(line);
		// Every snapshot id counts as seen, printed or skipped by the cursor.
		for (const line of snapshot) printed.add(line.id);
		snapshot.length = 0;
		if (!opts.follow) {
			succeed();
			return;
		}
		// Following: the join budget is spent; an idle session runs no timer.
		clearTimers();
	};

	const onFrame = (frame: CollabFrame) => {
		if (finished) return;
		if (!welcomed) {
			switch (frame.t) {
				case "welcome":
					if (frame.proto !== HEADLESS_GUEST_PROTO) {
						fail(
							"protocol",
							`collab host speaks v${frame.proto}, headless guest speaks v${HEADLESS_GUEST_PROTO}`,
						);
						return;
					}
					welcomed = true;
					expected = frame.entryCount;
					if (expected === 0) finishSnapshot();
					return;
				case "error":
					if (/protocol mismatch/i.test(frame.message)) fail("protocol", `collab host: ${frame.message}`);
					else fail("host-error", `collab host refused the join: ${frame.message}`);
					return;
				case "bye":
					fail("host-gone", `collab session ended: ${frame.reason}`);
					return;
				default:
					return;
			}
		}
		switch (frame.t) {
			case "snapshot-chunk":
				if (snapshotDone) return;
				received += frame.entries.length;
				for (const entry of frame.entries) snapshot.push(...entryLines(entry, opts));
				if (frame.final || received >= expected) finishSnapshot();
				return;
			case "entry":
				if (!snapshotDone) return;
				for (const line of entryLines(frame.entry, opts)) emit(line);
				return;
			case "bye":
				// The host ended the session: the one clean end of a follow.
				if (opts.follow && snapshotDone) succeed();
				else fail("host-gone", `collab session ended: ${frame.reason}`);
				return;
			case "error":
				fail("host-gone", `collab host dropped this guest: ${frame.message}`);
				return;
			default:
				// event / state / bus / agents: not part of the message stream.
				return;
		}
	};

	socket.onOpen = () => {
		if (finished) return;
		if (opened) {
			// A rejoin would replay the snapshot; the caller resumes with --since instead.
			fail("host-gone", "the relay connection was re-established mid-run; rejoin with --since <last id>");
			return;
		}
		opened = true;
		// No writeToken: the host registers this peer as a viewer.
		socket.send({ t: "hello", proto: HEADLESS_GUEST_PROTO, name: opts.name ?? DEFAULT_STREAM_GUEST_NAME });
	};
	socket.onFrame = onFrame;
	socket.onClose = (reason, willReconnect) => {
		if (finished) return;
		if (!opened && willReconnect) return;
		// The host's goodbye may still be decrypting when the relay reports the room
		// closed; let it land first so a clean host stop exits 0, not host-gone.
		void socket.received().then(() => fail("host-gone", `collab connection ended: ${reason}`));
	};
	timers.push(
		setTimeout(() => {
			if (snapshotDone) return;
			if (!opened) fail("timeout", "timed out connecting to the collab relay");
			else if (!welcomed) fail("timeout", "timed out waiting for the host's welcome");
			else fail("timeout", "timed out receiving the host's session snapshot");
		}, opts.deadlineMs),
		setTimeout(() => {
			if (!opened) fail("timeout", "timed out connecting to the collab relay");
		}, opts.connectTimeoutMs),
	);
	socket.connect();
	try {
		await done.promise;
	} finally {
		finished = true;
		clearTimers();
		socket.onFrame = undefined;
		socket.onClose = undefined;
		socket.onOpen = undefined;
		socket.close();
	}
}
