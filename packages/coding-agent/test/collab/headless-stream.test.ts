/**
 * Contract: `omp join --print-messages` prints every message as one JSON line
 * with its complete text, resumes after a printed id, follows live entries
 * until the host ends the session, and joins as a viewer so it never holds asks.
 *
 * Drives the production `CollabHost` over the in-memory relay; the guest runs
 * through `runJoinOnce`, the same entry the CLI calls.
 */
import { afterEach, expect, it, spyOn } from "bun:test";
import type { JoinOnceFlags, JoinOnceIo } from "@oh-my-pi/pi-coding-agent/cli/join-once-cli";
import { runJoinOnce } from "@oh-my-pi/pi-coding-agent/cli/join-once-cli";
import type { StreamLine } from "@oh-my-pi/pi-coding-agent/collab/headless-stream";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { writeLinkFile } from "./helpers/headless";
import { type FakeWebSocket, installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";
import { type HostObservations, makeHostContext, type Snapshot, waitFor } from "./helpers/throttled-host";

const RELAY = "ws://localhost:8788";
const LONG = `${"a long assistant reply ".repeat(40)}— ends here`;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	try {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	} finally {
		uninstallInMemoryRelay();
	}
});

let clock = Date.parse("2026-11-24T10:00:00.000Z");
function nextTimestamp(): string {
	clock += 1000;
	return new Date(clock).toISOString();
}

function userEntry(id: string, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: nextTimestamp(),
		message: { role: "user", content: text, timestamp: 0 },
	} as SessionEntry;
}

function assistantEntry(id: string, text: string, toolCall = false): SessionEntry {
	const content: unknown[] = [
		{ type: "thinking", thinking: "hidden" },
		{ type: "text", text },
	];
	if (toolCall) content.push({ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls -la" } });
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: nextTimestamp(),
		message: { role: "assistant", content },
	} as unknown as SessionEntry;
}

function toolResultEntry(id: string, output: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: nextTimestamp(),
		message: {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text: output }],
			isError: false,
			timestamp: 0,
		},
	} as unknown as SessionEntry;
}

async function startHost(entries: SessionEntry[]) {
	const relay = installInMemoryRelay();
	const sockets: FakeWebSocket[] = [];
	const connect = relay.connect.bind(relay);
	spyOn(relay, "connect").mockImplementation(ws => {
		sockets.push(ws);
		connect(ws);
	});
	const seen: HostObservations = { notices: [], participantCounts: [] };
	const snapshot: Snapshot = {
		header: { type: "session", id: "sess-stream", timestamp: "2026-11-24T00:00:00Z", cwd: "/tmp" },
		entries,
	};
	const ctx = makeHostContext(snapshot, seen);
	const host = new CollabHost(ctx as InteractiveModeContext);
	cleanups.push(() => host.stop("test done"));
	await host.start(RELAY);
	const file = await writeLinkFile(host.link);
	cleanups.push(file.cleanup);
	const sessionManager = ctx.sessionManager as unknown as { onEntryAppended?: (entry: SessionEntry) => void };
	/** Append like SessionManager does: into the file, then mirror live. */
	const append = (entry: SessionEntry) => {
		snapshot.entries.push(entry);
		sessionManager.onEntryAppended?.(entry);
	};
	return { host, linkFile: file.path, append, sockets };
}

interface StreamRun {
	exitCode: number;
	lines: StreamLine[];
	stderr: string;
}

function startStream(flags: JoinOnceFlags): { lines: StreamLine[]; done: Promise<StreamRun> } {
	const lines: StreamLine[] = [];
	let stderr = "";
	const io: JoinOnceIo = {
		stdout: text => {
			// One write per line: the caller can act on each as it lands.
			expect(text.endsWith("\n")).toBe(true);
			expect(text.indexOf("\n")).toBe(text.length - 1);
			lines.push(JSON.parse(text) as StreamLine);
		},
		stderr: text => {
			stderr += text;
		},
	};
	const done = runJoinOnce({ connectTimeout: 5, timeout: 10, printMessages: true, ...flags }, io).then(exitCode => ({
		exitCode,
		lines,
		stderr,
	}));
	return { lines, done };
}

it("prints full message text past 240 chars, and --since resumes after exactly the printed id", async () => {
	const { linkFile, append } = await startHost([
		userEntry("u1", "first question"),
		assistantEntry("a1", LONG, true),
		toolResultEntry("t1", "file-a\nfile-b"),
	]);
	const first = await startStream({ linkFile }).done;
	expect(first.exitCode).toBe(0);
	expect(first.lines.map(line => [line.kind, line.role])).toEqual([
		["message", "user"],
		["message", "assistant"],
	]);
	const reply = first.lines[1]!;
	expect(reply.kind === "message" && reply.text).toBe(LONG);
	expect(Buffer.byteLength(reply.kind === "message" ? reply.text : "")).toBe(Buffer.byteLength(LONG));
	expect(first.lines.every(line => line.reset === undefined)).toBe(true);

	// A new turn lands; resuming from the last id prints only that turn.
	append(userEntry("u2", "second question"));
	append(assistantEntry("a2", "second answer"));
	const resumed = await startStream({ linkFile, since: reply.id }).done;
	expect(resumed.exitCode).toBe(0);
	expect(resumed.lines.map(line => (line.kind === "message" ? line.text : line.kind))).toEqual([
		"second question",
		"second answer",
	]);
	// Nothing after the last id: no output, still success.
	const caughtUp = await startStream({ linkFile, since: resumed.lines[1]!.id }).done;
	expect(caughtUp).toMatchObject({ exitCode: 0, lines: [] });
}, 30_000);

it("marks every line reset when the cursor is not in the snapshot", async () => {
	const { linkFile } = await startHost([userEntry("u1", "hi"), assistantEntry("a1", "hello")]);
	const run = await startStream({ linkFile, since: "0000000000000-gone" }).done;
	expect(run.exitCode).toBe(0);
	expect(run.lines.map(line => [line.kind === "message" && line.text, line.reset])).toEqual([
		["hi", true],
		["hello", true],
	]);
}, 30_000);

it("prints compact tool lines only with --include-tools, and their ids are valid cursors", async () => {
	const bigOutput = "x".repeat(50_000);
	const { linkFile } = await startHost([assistantEntry("a1", "running", true), toolResultEntry("t1", bigOutput)]);
	const run = await startStream({ linkFile, includeTools: true }).done;
	expect(run.lines.map(line => (line.kind === "tool" ? `${line.event}:${line.tool}` : line.kind))).toEqual([
		"message",
		"call:bash",
		"result:bash",
	]);
	const result = run.lines[2]!;
	expect(result).toMatchObject({ kind: "tool", toolCallId: "call-1", isError: false, chars: 50_000 });
	expect(result.kind === "tool" && result.summary.length).toBeLessThanOrEqual(160);

	const afterCall = await startStream({ linkFile, includeTools: true, since: run.lines[1]!.id }).done;
	expect(afterCall.lines.map(line => line.id)).toEqual([result.id]);
}, 30_000);

it("--max-chars cuts text and says so; the default is unlimited", async () => {
	const { linkFile } = await startHost([assistantEntry("a1", LONG)]);
	const run = await startStream({ linkFile, maxChars: 100 }).done;
	expect(run.lines[0]).toMatchObject({ kind: "message", truncated: true, chars: LONG.length });
	expect(run.lines[0]!.kind === "message" && run.lines[0]!.text).toBe(LONG.slice(0, 100));
}, 30_000);

it("--follow prints live entries as they land and exits 0 when the host ends the session", async () => {
	const { host, linkFile, append } = await startHost([userEntry("u1", "start")]);
	const stream = startStream({ linkFile, follow: true });
	await waitFor(() => stream.lines.length === 1, "snapshot line");
	// Viewer: the host counts the follower as a participant but never as a writer.
	expect(host.inputRequired).toBe(false);

	append(assistantEntry("a1", "mid-turn message"));
	await waitFor(() => stream.lines.length === 2, "live line");
	expect(stream.lines[1]).toMatchObject({ kind: "message", role: "assistant", text: "mid-turn message" });

	await host.stop("host closed");
	const run = await stream.done;
	expect(run.exitCode).toBe(0);
	expect(run.lines).toHaveLength(2);
}, 30_000);

it("--follow exits non-zero when the relay connection is lost", async () => {
	const { linkFile, sockets } = await startHost([userEntry("u1", "start")]);
	const stream = startStream({ linkFile, follow: true });
	await waitFor(() => stream.lines.length === 1, "snapshot line");
	for (const ws of sockets) if (ws.role === "guest") ws.closeFatal();
	const run = await stream.done;
	expect(run.exitCode).toBe(5);
	expect(JSON.parse(run.stderr)).toMatchObject({ error: { code: "host-gone" } });
}, 30_000);

it("refuses stream modifiers without --print-messages and write actions with it", async () => {
	const { linkFile } = await startHost([]);
	const lone = await runJoinOnce(
		{ linkFile, follow: true, printRequests: true },
		{ stdout: () => {}, stderr: () => {} },
	);
	expect(lone).toBe(2);
	const mixed = startStream({ linkFile, abort: true });
	expect((await mixed.done).exitCode).toBe(2);
}, 30_000);
