/**
 * Contract: `omp join --once` reads and answers a live host's asks, prompts
 * and aborts it, and fails with a distinct exit code and a JSON error —
 * without ever building a replica or exposing the link.
 *
 * Drives the production `CollabHost` over the in-memory relay; the guest runs
 * through `runJoinOnce`, the same entry the CLI calls.
 */
import { afterEach, expect, it } from "bun:test";
import type { CollabUiRequestDraft } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import * as path from "node:path";
import type { HeadlessRequest } from "@oh-my-pi/pi-coding-agent/collab/headless-guest";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { formatCollabLink, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { runOnce, writeLinkFile } from "./helpers/headless";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";
import { type HostObservations, makeHostContext, makeSnapshot, waitFor } from "./helpers/throttled-host";

const RELAY = "ws://localhost:8788";
const APPROVAL: CollabUiRequestDraft = {
	kind: "select",
	title: "Allow bash?",
	options: ["Approve", "Deny"],
	approval: true,
};

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	try {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	} finally {
		uninstallInMemoryRelay();
	}
});

interface Prompted {
	details: unknown;
	options: unknown;
}

async function startHost(opts: { streaming?: boolean } = {}): Promise<{
	host: CollabHost;
	seen: HostObservations;
	prompts: Prompted[];
	aborts: number[];
	linkFile: string;
}> {
	installInMemoryRelay();
	const seen: HostObservations = { notices: [], participantCounts: [] };
	const ctx = makeHostContext(makeSnapshot(), seen);
	const prompts: Prompted[] = [];
	const aborts: number[] = [];
	const session = ctx.session as unknown as Record<string, unknown>;
	session.isStreaming = opts.streaming === true;
	session.promptCustomMessage = (message: { details: unknown }, options: unknown) => {
		prompts.push({ details: message.details, options });
		return Promise.resolve();
	};
	session.abort = () => {
		aborts.push(Date.now());
		return Promise.resolve();
	};
	(ctx as unknown as Record<string, unknown>).updatePendingMessagesDisplay = () => {};
	const host = new CollabHost(ctx as InteractiveModeContext);
	cleanups.push(() => host.stop("test done"));
	await host.start(RELAY);
	const file = await writeLinkFile(host.link);
	cleanups.push(file.cleanup);
	return { host, seen, prompts, aborts, linkFile: file.path };
}

it("exits on the answered ask's ui-request-end, and reports a settled reqId as already-settled", async () => {
	const { host, linkFile } = await startHost();
	const asked = host.requestGuestUi(APPROVAL, undefined, { retainOnReconnect: true });
	if (!asked) throw new Error("host refused the ask");
	const [request] = (await runOnce({ linkFile, printRequests: true })).json.requests as { reqId: number }[];

	// A value the select does not offer is refused locally, not sent as a denial.
	const invalid = await runOnce({ linkFile, answer: request!.reqId, value: "Yes please" });
	expect(invalid.exitCode).toBe(9);
	expect(host.inputRequired).toBe(true);

	const answered = await runOnce({ linkFile, answer: request!.reqId, value: "deny" });
	expect(answered.exitCode).toBe(0);
	expect(answered.json).toMatchObject({
		action: "answer",
		reqId: request!.reqId,
		status: "settled",
		confirmed: false,
		value: "Deny",
	});
	expect(await asked).toEqual({ kind: "answered", value: "Deny" });

	const again = await runOnce({ linkFile, answer: request!.reqId, value: "Approve" });
	expect(again.exitCode).toBe(0);
	expect(again.json).toMatchObject({ action: "answer", status: "already-settled" });
}, 30_000);

it("never settles a live ask with its barrier probes, even when the guest holds the ask", async () => {
	const { host, prompts, linkFile } = await startHost({ streaming: true });
	const asked = host.requestGuestUi(APPROVAL, undefined, { retainOnReconnect: true });
	if (!asked) throw new Error("host refused the ask");

	// A prompt run sends two barriers: one after hello (as a recipient of the
	// replayed ask) and one after the prompt.
	const run = await runOnce({ linkFile, prompt: "keep going" });
	expect(run.exitCode).toBe(0);
	expect(prompts).toHaveLength(1);
	// A barrier that named the ask would answer it with no value: a denial.
	expect(await Promise.race([asked, Bun.sleep(100).then(() => "pending" as const)])).toBe("pending");
	expect(host.inputRequired).toBe(true);
}, 30_000);

it("lands a prompt sent while the host streams as a steer attributed to the guest", async () => {
	const { prompts, linkFile } = await startHost({ streaming: true });
	const run = await runOnce({ linkFile, prompt: "stop and run the tests", name: "dammy" });
	expect(run.exitCode).toBe(0);
	expect(run.json).toMatchObject({ action: "prompt", status: "submitted", steer: true });
	expect(prompts).toEqual([
		{ details: { from: "dammy" }, options: { streamingBehavior: "steer", queueChipText: "stop and run the tests" } },
	]);
}, 30_000);

it("reads the prompt and the answer value from private files, refusing loose ones", async () => {
	const { host, prompts, linkFile } = await startHost({ streaming: true });
	const asked = host.requestGuestUi(APPROVAL, undefined, { retainOnReconnect: true });
	if (!asked) throw new Error("host refused the ask");
	const secret = "rewrite src/billing.ts using the ticket below";

	const loose = await writeLinkFile(`${secret}\n`, 0o644);
	cleanups.push(loose.cleanup);
	const refused = await runOnce({ linkFile, promptFile: loose.path });
	expect(refused.exitCode).toBe(10);
	expect(refused.stderr).not.toContain(secret);
	expect(prompts).toEqual([]);

	// One trailing newline (as `echo` writes) is dropped; the rest is verbatim.
	const promptFile = await writeLinkFile(`${secret}\n`);
	cleanups.push(promptFile.cleanup);
	const prompted = await runOnce({ linkFile, promptFile: promptFile.path });
	expect(prompted.exitCode).toBe(0);
	expect(prompted.stdout).not.toContain(secret);
	expect(prompts.map(prompt => (prompt.options as { queueChipText: string }).queueChipText)).toEqual([secret]);

	const [request] = (await runOnce({ linkFile, printRequests: true })).json.requests as HeadlessRequest[];
	const valueFile = await writeLinkFile("Approve\n");
	cleanups.push(valueFile.cleanup);
	const answered = await runOnce({ linkFile, answer: request!.reqId, valueFile: valueFile.path });
	expect(answered.json).toMatchObject({ status: "settled", value: "Approve" });
	expect(await asked).toEqual({ kind: "answered", value: "Approve" });
}, 30_000);

it("forwards --abort to the host session", async () => {
	const { aborts, linkFile } = await startHost({ streaming: true });
	const run = await runOnce({ linkFile, abort: true });
	expect(run.json).toMatchObject({ action: "abort", status: "submitted" });
	await waitFor(() => aborts.length === 1, "host never aborted");
}, 30_000);

it("rejects view-only links for listing and writes, and a stale write token the host demotes", async () => {
	const { host, prompts } = await startHost();
	host.requestGuestUi(APPROVAL, undefined, { retainOnReconnect: true });
	const view = await writeLinkFile(host.viewLink);
	cleanups.push(view.cleanup);

	const listed = await runOnce({ linkFile: view.path, printRequests: true });
	expect(listed.exitCode).toBe(4);
	expect(String((listed.json.error as { message: string }).message)).toContain(
		"replays pending requests only to control links",
	);
	expect((await runOnce({ linkFile: view.path, prompt: "hi" })).exitCode).toBe(4);

	// A full-shaped link whose token the host does not recognize joins read-only.
	const parsed = parseCollabLink(host.link);
	if ("error" in parsed) throw new Error(parsed.error);
	const stale = await writeLinkFile(formatCollabLink(RELAY, parsed.roomId, parsed.key, new Uint8Array(16).fill(7)));
	cleanups.push(stale.cleanup);
	const demoted = await runOnce({ linkFile: stale.path, prompt: "hi" });
	expect(demoted.exitCode).toBe(4);
	expect(prompts).toEqual([]);
	expect(host.inputRequired).toBe(true);
}, 30_000);

it("refuses a link file others can read and never prints the link", async () => {
	const { host, linkFile } = await startHost();
	const parsed = parseCollabLink(host.link);
	if ("error" in parsed) throw new Error(parsed.error);
	const secrets = [host.link, parsed.roomId, Buffer.from(parsed.key).toString("base64url")];

	const loose = await writeLinkFile(host.link, 0o644);
	cleanups.push(loose.cleanup);
	const refused = await runOnce({ linkFile: loose.path, printRequests: true });
	expect(refused.exitCode).toBe(3);
	expect(String((refused.json.error as { message: string }).message)).toContain("0644");

	// The JSON `omp collab link --json` prints is accepted as-is.
	const json = await writeLinkFile(JSON.stringify({ version: 1, access: "control", url: host.link }));
	cleanups.push(json.cleanup);
	const garbled = await writeLinkFile(`${host.link.slice(0, -4)}!!!!`);
	cleanups.push(garbled.cleanup);
	const runs = [
		refused,
		await runOnce({ linkFile, printRequests: true }),
		await runOnce({ linkFile: json.path, printRequests: true }),
		await runOnce({ linkFile: garbled.path, printRequests: true }),
	];
	expect(runs.map(run => run.exitCode)).toEqual([3, 0, 0, 3]);
	for (const run of runs) {
		for (const secret of secrets) {
			expect(run.stdout).not.toContain(secret);
			expect(run.stderr).not.toContain(secret);
		}
	}
}, 30_000);

it("fails with host-gone when the host stops mid-run, instead of waiting out the deadline", async () => {
	const { host, prompts, linkFile } = await startHost({ streaming: true });
	const run = runOnce({ linkFile, prompt: "hello", waitIdle: 8 });
	await waitFor(() => prompts.length === 1, "host never received the prompt");
	const started = Date.now();
	await host.stop("host closed the room");
	const result = await run;
	expect(result.exitCode).toBe(5);
	expect(Date.now() - started).toBeLessThan(2_000);
}, 30_000);

const cliEntry = path.join(import.meta.dir, "../../src/cli.ts");

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const child = Bun.spawn([process.execPath, cliEntry, ...args], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, NO_COLOR: "1" },
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { exitCode, stdout, stderr };
}

it("keeps `omp join <link>` interactive-only and refuses the link as an argument to --once", async () => {
	const link = "localhost:7466/r/AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
	const piped = await runCli(["join", link]);
	expect(piped.exitCode).toBe(1);
	expect(piped.stderr).toContain("requires an interactive terminal");

	const inArgv = await runCli(["join", "--once", link, "--print-requests"]);
	expect(inArgv.exitCode).toBe(2);
	expect(inArgv.stderr).toContain("--link-file");
	expect(inArgv.stderr).not.toContain(link);
	expect(inArgv.stdout).toBe("");
}, 60_000);
