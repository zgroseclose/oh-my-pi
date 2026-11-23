/**
 * `omp join --once`: argv-driven, one-shot headless collab guest.
 *
 * The link never travels in argv (world-readable through `/proc/<pid>/cmdline`
 * and kept in job records): it is read from `--link-file`, which must be a
 * regular file owned by the caller with no group/other permission bits. The
 * link is never printed. Prompt text and answer values can carry the same kind
 * of sensitive content, so `--prompt-file` / `--value-file` read them from
 * files under the same rule. One JSON object goes to stdout on success; on failure
 * one JSON object goes to stderr and the exit code names the failure class.
 */
import * as fs from "node:fs/promises";
import { isEnoent } from "@oh-my-pi/pi-utils";
import {
	DEFAULT_HEADLESS_GUEST_NAME,
	type HeadlessAction,
	type HeadlessErrorCode,
	HeadlessExitCode,
	HeadlessGuestError,
	HEADLESS_OUTPUT_VERSION,
	runHeadlessGuest,
} from "../collab/headless-guest";

export const DEFAULT_CONNECT_TIMEOUT_SEC = 15;
export const DEFAULT_ONCE_TIMEOUT_SEC = 120;

export interface JoinOnceFlags {
	linkFile?: string;
	printRequests?: boolean;
	answer?: number;
	value?: string;
	/** Private file holding the answer value; alternative to {@link value}. */
	valueFile?: string;
	/** {@link value} came from a file and is used verbatim (no JSON-literal decoding). */
	valueIsLiteral?: boolean;
	prompt?: string;
	/** Private file holding the prompt text; alternative to {@link prompt}. */
	promptFile?: string;
	abort?: boolean;
	waitIdle?: number;
	connectTimeout?: number;
	timeout?: number;
	name?: string;
}

export interface JoinOnceIo {
	stdout(text: string): void;
	stderr(text: string): void;
}

const processIo: JoinOnceIo = {
	stdout: text => process.stdout.write(text),
	stderr: text => process.stderr.write(text),
};

/** The stderr JSON object for a failed run. */
export interface JoinOnceErrorOutput {
	version: typeof HEADLESS_OUTPUT_VERSION;
	error: { code: HeadlessErrorCode; exitCode: number; message: string };
}

function usage(message: string): HeadlessGuestError {
	return new HeadlessGuestError("usage", message);
}

function positiveSeconds(name: string, value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || value <= 0) throw usage(`--${name} must be a positive number of seconds`);
	return value;
}

/** Exactly one action flag, with the operands it needs and no others. */
export function resolveOnceAction(flags: JoinOnceFlags): HeadlessAction {
	const chosen: string[] = [];
	if (flags.printRequests) chosen.push("--print-requests");
	if (flags.answer !== undefined) chosen.push("--answer");
	if (flags.prompt !== undefined) chosen.push("--prompt");
	if (flags.abort) chosen.push("--abort");
	if (chosen.length !== 1) {
		throw usage(
			chosen.length === 0
				? "--once needs one action: --print-requests, --answer <reqId> --value[-file] <v>, --prompt[-file] <text>, or --abort"
				: `--once takes one action, got ${chosen.join(" and ")}`,
		);
	}
	if (flags.value !== undefined && flags.answer === undefined) throw usage("--value is only valid with --answer");
	if (flags.waitIdle !== undefined && flags.prompt === undefined && !flags.abort) {
		throw usage("--wait-idle is only valid with --prompt or --abort");
	}
	if (flags.printRequests) return { kind: "print-requests" };
	if (flags.abort) return { kind: "abort" };
	if (flags.prompt !== undefined) {
		if (!flags.prompt.trim()) throw usage("--prompt text is empty");
		return { kind: "prompt", text: flags.prompt };
	}
	const reqId = flags.answer!;
	if (!Number.isInteger(reqId) || reqId <= 0) throw usage("--answer takes the positive reqId from --print-requests");
	if (flags.value === undefined) throw usage("--answer needs --value <label|text> or --value-file <path>");
	return { kind: "answer", reqId, value: flags.valueIsLiteral ? flags.value : decodeValue(flags.value) };
}

/** `--value` is the literal text, or a JSON string literal (for values with leading/trailing whitespace). */
function decodeValue(raw: string): string {
	if (!raw.startsWith('"')) return raw;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed === "string") return parsed;
	} catch {
		// Not JSON: the quote is part of the value.
	}
	return raw;
}

/**
 * Read {@link filePath} if it is a regular file owned by the caller with no
 * group/other permission bits. Errors carry {@link code} and name the file
 * (as {@link label}) and its path, never its content.
 */
async function readPrivateFile(filePath: string, label: string, code: HeadlessErrorCode): Promise<string> {
	const stat = await fs.stat(filePath).catch((err: unknown) => {
		if (isEnoent(err)) throw new HeadlessGuestError(code, `${label} not found: ${filePath}`);
		throw new HeadlessGuestError(code, `cannot read ${label} ${filePath}: ${(err as Error).message}`);
	});
	if (!stat.isFile()) throw new HeadlessGuestError(code, `${label} is not a regular file: ${filePath}`);
	if (process.platform !== "win32") {
		const mode = stat.mode & 0o777;
		if ((mode & 0o177) !== 0) {
			throw new HeadlessGuestError(
				code,
				`${label} ${filePath} has mode ${mode.toString(8).padStart(4, "0")}; it must be 0600 or stricter (chmod 600 ${filePath})`,
			);
		}
		const uid = process.getuid?.();
		if (uid !== undefined && stat.uid !== uid) {
			throw new HeadlessGuestError(code, `${label} ${filePath} is not owned by the current user`);
		}
	}
	try {
		return await Bun.file(filePath).text();
	} catch (err) {
		throw new HeadlessGuestError(code, `cannot read ${label} ${filePath}: ${(err as Error).message}`);
	}
}

/**
 * Read the collab link from {@link linkPath}: the raw link, or the JSON that
 * `omp collab link <id> --json` prints (its `url`). Refuses a file other users
 * can read or write. Messages name the path, never the content.
 */
export async function readLinkFile(linkPath: string): Promise<string> {
	const text = (await readPrivateFile(linkPath, "link file", "link")).trim();
	if (!text) throw new HeadlessGuestError("link", `link file is empty: ${linkPath}`);
	if (!text.startsWith("{")) return text;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new HeadlessGuestError("link", `link file ${linkPath} starts with "{" but is not valid JSON`);
	}
	const url = (parsed as { url?: unknown } | null)?.url;
	if (typeof url !== "string" || !url.trim()) {
		throw new HeadlessGuestError("link", `link file ${linkPath} holds JSON without a "url" string`);
	}
	return url.trim();
}

/** A prompt or value file's text, verbatim except for one trailing newline (what `echo` and editors add). */
async function readInputFile(filePath: string, label: string): Promise<string> {
	const text = await readPrivateFile(filePath, label, "input-file");
	return text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : text;
}

/** Replace `--prompt-file` / `--value-file` with their contents; each is exclusive with its argv form. */
async function inlineInputFiles(flags: JoinOnceFlags): Promise<JoinOnceFlags> {
	if (flags.promptFile !== undefined && flags.prompt !== undefined) {
		throw usage("pass either --prompt or --prompt-file, not both");
	}
	if (flags.valueFile !== undefined && flags.value !== undefined) {
		throw usage("pass either --value or --value-file, not both");
	}
	const out: JoinOnceFlags = { ...flags, promptFile: undefined, valueFile: undefined };
	if (flags.promptFile !== undefined) out.prompt = await readInputFile(flags.promptFile, "prompt file");
	if (flags.valueFile !== undefined) {
		if (flags.answer === undefined) throw usage("--value-file is only valid with --answer");
		// Verbatim: the JSON-literal escape is only for argv.
		out.value = await readInputFile(flags.valueFile, "value file");
		out.valueIsLiteral = true;
	}
	return out;
}

/** Run `omp join --once`; returns the process exit code. */
export async function runJoinOnce(flags: JoinOnceFlags, io: JoinOnceIo = processIo): Promise<number> {
	try {
		const action = resolveOnceAction(await inlineInputFiles(flags));
		if (!flags.linkFile) throw usage("--once requires --link-file <path> (the link is never accepted in argv)");
		const connectTimeoutMs =
			positiveSeconds("connect-timeout", flags.connectTimeout, DEFAULT_CONNECT_TIMEOUT_SEC) * 1000;
		const deadlineMs = positiveSeconds("timeout", flags.timeout, DEFAULT_ONCE_TIMEOUT_SEC) * 1000;
		const waitIdleMs =
			flags.waitIdle === undefined ? undefined : positiveSeconds("wait-idle", flags.waitIdle, 0) * 1000;
		if (waitIdleMs !== undefined && waitIdleMs >= deadlineMs) {
			throw usage("--wait-idle must be shorter than --timeout");
		}
		const link = await readLinkFile(flags.linkFile);
		const result = await runHeadlessGuest({
			link,
			action,
			name: flags.name?.trim() || DEFAULT_HEADLESS_GUEST_NAME,
			connectTimeoutMs,
			deadlineMs,
			waitIdleMs,
		});
		io.stdout(`${JSON.stringify(result)}\n`);
		return HeadlessExitCode.ok;
	} catch (err) {
		const error =
			err instanceof HeadlessGuestError
				? err
				: new HeadlessGuestError("internal", err instanceof Error ? err.message : String(err));
		const output: JoinOnceErrorOutput = {
			version: HEADLESS_OUTPUT_VERSION,
			error: { code: error.code, exitCode: error.exitCode, message: error.message },
		};
		io.stderr(`${JSON.stringify(output)}\n`);
		return error.exitCode;
	}
}
