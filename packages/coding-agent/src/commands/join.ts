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
		"value-file": Flags.string({ description: "--once: read the answer value from a private file (mode 0600)" }),
		prompt: Flags.string({ description: "--once: send a prompt (steers when the host is streaming)" }),
		"prompt-file": Flags.string({
			description: "--once: read the prompt from a private file (mode 0600), keeping it out of argv",
		}),
		abort: Flags.boolean({ description: "--once: interrupt the host's current turn", default: false }),
		"wait-idle": Flags.integer({
			description:
				"--once: after --prompt/--abort, wait up to N s for the host to read idle (best-effort hint, not authoritative)",
		}),
		"connect-timeout": Flags.integer({ description: "--once: relay connect timeout in seconds (default 15)" }),
		timeout: Flags.integer({ description: "--once: overall deadline in seconds (default 120)" }),
		name: Flags.string({
			description: "--once: display name shown to the host (default omp-once; omp-watch with --print-messages)",
		}),
		"print-messages": Flags.boolean({
			description:
				"Headless, view-only: print session messages as JSON lines (full text) and exit at the end of the snapshot",
			default: false,
		}),
		since: Flags.string({ description: "--print-messages: print only lines after this id (an id it printed)" }),
		follow: Flags.boolean({
			description: "--print-messages: stay joined, print new lines as they land, exit 0 when the host ends",
			default: false,
		}),
		"include-tools": Flags.boolean({
			description: "--print-messages: also print compact tool-call/result lines (kind: tool)",
			default: false,
		}),
		"max-chars": Flags.integer({
			description: "--print-messages: cap each message's text (default 0 = unlimited)",
		}),
	};

	static examples = [
		`${APP_NAME} join "relay.example.sh/abc123#key"`,
		`${APP_NAME} join --once --link-file ~/.omp-link --print-requests`,
		`${APP_NAME} join --once --link-file ~/.omp-link --answer 3 --value "Approve"`,
		`${APP_NAME} join --print-messages --link-file ~/.omp-link --since <id> --follow`,
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Join);
		if (flags.once || flags["print-messages"]) {
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
				valueFile: flags["value-file"],
				prompt: flags.prompt,
				promptFile: flags["prompt-file"],
				abort: flags.abort,
				waitIdle: flags["wait-idle"],
				connectTimeout: flags["connect-timeout"],
				timeout: flags.timeout,
				name: flags.name,
				printMessages: flags["print-messages"],
				since: flags.since,
				follow: flags.follow,
				includeTools: flags["include-tools"],
				maxChars: flags["max-chars"],
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
