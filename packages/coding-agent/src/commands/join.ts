/**
 * Join a shared collab session from the CLI: launches the interactive TUI and
 * immediately runs `/join <link>`. With `--once`, runs the headless one-shot
 * guest instead (see `cli/join-once-cli.ts`).
 */

import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { parseArgs } from "../cli/args";
import { joinHelp as commandHelp } from "../cli/command-help";
import { runJoinOnce } from "../cli/join-once-cli";
import { HeadlessExitCode } from "../collab/headless-guest";
import { runRootCommand } from "../main";

export default class Join extends Command {
	static description = commandHelp.description;
	static args = {
		link: Args.string({
			description: "Collab link shared by the host (/collab); not accepted with --once",
			required: false,
		}),
	};

	static flags = {
		once: Flags.boolean({
			description: "Headless one-shot guest: join, do one action, print one JSON object, leave",
			default: false,
		}),
		"link-file": Flags.string({ description: "--once: file holding the link (mode 0600), never argv" }),
		"print-requests": Flags.boolean({ description: "--once: list the host's pending asks", default: false }),
		answer: Flags.integer({ description: "--once: answer the pending ask with this reqId (needs --value)" }),
		value: Flags.string({ description: "--once: answer value (a select option label, or editor text)" }),
		prompt: Flags.string({ description: "--once: send a prompt (steers when the host is streaming)" }),
		abort: Flags.boolean({ description: "--once: interrupt the host's current turn", default: false }),
		"wait-idle": Flags.integer({
			description:
				"--once: after --prompt/--abort, wait up to N s for the host to read idle (best-effort hint, not authoritative)",
		}),
		"connect-timeout": Flags.integer({ description: "--once: relay connect timeout in seconds (default 15)" }),
		timeout: Flags.integer({ description: "--once: overall deadline in seconds (default 120)" }),
		name: Flags.string({ description: "--once: display name shown to the host (default omp-once)" }),
	};

	static examples = [
		`${APP_NAME} join "relay.example.sh/abc123#key"`,
		`${APP_NAME} join --once --link-file ~/.omp-link --print-requests`,
		`${APP_NAME} join --once --link-file ~/.omp-link --answer 3 --value "Approve"`,
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Join);
		if (flags.once) {
			if (args.link !== undefined) {
				process.stderr.write(
					`${APP_NAME} join --once does not take the link as an argument; pass --link-file <path> (mode 0600)\n`,
				);
				process.exitCode = HeadlessExitCode.usage;
				return;
			}
			process.exitCode = await runJoinOnce({
				linkFile: flags["link-file"],
				printRequests: flags["print-requests"],
				answer: flags.answer,
				value: flags.value,
				prompt: flags.prompt,
				abort: flags.abort,
				waitIdle: flags["wait-idle"],
				connectTimeout: flags["connect-timeout"],
				timeout: flags.timeout,
				name: flags.name,
			});
			return;
		}
		const onceOnly = Object.entries(flags).filter(
			([name, value]) => name !== "once" && value !== undefined && value !== false,
		);
		if (onceOnly.length > 0) {
			process.stderr.write(`${APP_NAME} join: --${onceOnly[0]![0]} requires --once\n`);
			process.exitCode = HeadlessExitCode.usage;
			return;
		}
		const link = args.link?.trim();
		if (!link) {
			process.stderr.write(`Usage: ${APP_NAME} join <link>  |  ${APP_NAME} join --once --link-file <path> …\n`);
			process.exitCode = 1;
			return;
		}
		if (!process.stdin.isTTY || !process.stdout.isTTY) {
			process.stderr.write(`${APP_NAME} join requires an interactive terminal\n`);
			process.exitCode = 1;
			return;
		}
		const parsed = parseArgs([]);
		parsed.join = link;
		await runRootCommand(parsed, []);
	}
}
