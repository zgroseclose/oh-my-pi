/**
 * Helpers for driving `omp join --once` in-process against a test host.
 */
import * as fs from "node:fs/promises";
import { type JoinOnceFlags, type JoinOnceIo, runJoinOnce } from "@oh-my-pi/pi-coding-agent/cli/join-once-cli";
import { TempDir } from "@oh-my-pi/pi-utils";

export interface OnceRun {
	exitCode: number;
	stdout: string;
	stderr: string;
	/** Parsed stdout (success) or stderr (failure) JSON object. */
	json: Record<string, unknown>;
}

/** Write {@link content} to a fresh file with {@link mode}; the directory is removed by the returned cleanup. */
export async function writeLinkFile(content: string, mode = 0o600): Promise<{ path: string; cleanup: () => void }> {
	const dir = TempDir.createSync("@omp-once-link-");
	const file = dir.join("link");
	await Bun.write(file, content);
	await fs.chmod(file, mode);
	return { path: file, cleanup: () => dir.removeSync() };
}

export async function runOnce(flags: JoinOnceFlags): Promise<OnceRun> {
	let stdout = "";
	let stderr = "";
	const io: JoinOnceIo = {
		stdout: text => {
			stdout += text;
		},
		stderr: text => {
			stderr += text;
		},
	};
	const exitCode = await runJoinOnce({ connectTimeout: 5, timeout: 10, ...flags }, io);
	const text = exitCode === 0 ? stdout : stderr;
	return { exitCode, stdout, stderr, json: JSON.parse(text) as Record<string, unknown> };
}
