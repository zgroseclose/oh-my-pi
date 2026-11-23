/**
 * Lightweight, one-shot collab guest (`omp join --once`).
 *
 * Joins a live room, reads what the host is waiting on, optionally performs a
 * single write (answer an ask, prompt/steer, abort), and leaves. Unlike
 * {@link CollabGuestLink} it builds no replica session: `snapshot-chunk`
 * bodies are counted and discarded, so there is no session file, no
 * `AgentSession`, and no TUI. All frame handling for this guest lives here.
 *
 * Two host behaviors this module leans on, both present in a stock host:
 *
 * - **Welcome batch order.** `welcome` → every `snapshot-chunk` → the asks
 *   replayed to a writer, all as one queue entry. Targeted frames to a peer are
 *   FIFO behind it.
 * - **Barrier.** A `ui-response` for a reqId the host never issued is answered
 *   with a targeted `ui-request-end` for that reqId and has no other effect.
 *   Host reqIds count up from 1 (`++uiReqSeq`), so the negative
 *   {@link BARRIER_REQ_ID} can never name a real ask, whatever the allocator's
 *   starting point; a host that ever validated reqIds would refuse it with an
 *   `error` (a loud `host-error` here), never settle an ask with it.
 *   Sent right after `hello`, its reply marks the end of the replayed asks;
 *   sent right after a `prompt` or `abort`, its reply means the host has run
 *   that frame's synchronous handling (refusals included).
 */
import { COLLAB_PROTO } from "@oh-my-pi/pi-wire";
import { importRoomKey } from "./crypto";
import type { CollabFrame, CollabSessionState, CollabUiRequest, CollabUiSelectItem } from "./protocol";
import { parseCollabLink } from "./protocol";
import { CollabSocket } from "./relay-client";

/**
 * Collab protocol revision this module was written against. A rebase that bumps
 * {@link COLLAB_PROTO} without revisiting the frame handling here fails every
 * run loudly instead of misreading frames.
 */
export const HEADLESS_GUEST_PROTO = 3;

/** Version of the JSON objects `omp join --once` prints. Bump on any breaking change. */
export const HEADLESS_OUTPUT_VERSION = 1;

/** reqId of the barrier probe; negative so it can never collide with a host-issued id. See the module comment. */
export const BARRIER_REQ_ID = -1;

/** Display name the host shows for this guest unless overridden. */
export const DEFAULT_HEADLESS_GUEST_NAME = "omp-once";

/** Grace after a prompt's barrier for the host's asynchronous refusal (`prompt failed`, `not submitted`). */
const PROMPT_REFUSAL_GRACE_MS = 750;

/** Process exit codes for `omp join --once`. */
export const HeadlessExitCode = {
	ok: 0,
	internal: 1,
	usage: 2,
	link: 3,
	"read-only": 4,
	"host-gone": 5,
	timeout: 6,
	protocol: 7,
	"host-error": 8,
	"invalid-value": 9,
} as const;

export type HeadlessErrorCode = Exclude<keyof typeof HeadlessExitCode, "ok">;

export class HeadlessGuestError extends Error {
	constructor(
		readonly code: HeadlessErrorCode,
		message: string,
	) {
		super(message);
		this.name = "HeadlessGuestError";
	}

	get exitCode(): number {
		return HeadlessExitCode[this.code];
	}
}

export type HeadlessAction =
	| { kind: "print-requests" }
	| { kind: "answer"; reqId: number; value: string }
	| { kind: "prompt"; text: string }
	| { kind: "abort" };

export interface HeadlessGuestOptions {
	link: string;
	action: HeadlessAction;
	/** Name the host shows in its notices and on steered prompts. */
	name?: string;
	/** Budget for the relay connection to open. */
	connectTimeoutMs: number;
	/** Budget for the whole run, connection included. */
	deadlineMs: number;
	/** After a write, wait up to this long for a `state` frame reading idle. */
	waitIdleMs?: number;
}

export interface HeadlessSelectOption {
	label: string;
	description?: string;
}

export interface HeadlessRequest {
	reqId: number;
	kind: "select" | "editor";
	title: string;
	/** The select asks for a permission (a tool approval), not an answer. */
	approval: boolean;
	/** Select only. Answer with one of these labels, verbatim. */
	options?: HeadlessSelectOption[];
	helpText?: string;
	/** Editor only. */
	prefill?: string;
}

export interface HeadlessHostState {
	sessionId: string;
	sessionName?: string;
	cwd: string;
	isStreaming: boolean;
	queuedMessageCount: number;
	isAborting: boolean;
}

export interface HeadlessTimings {
	/** Relay connection open. */
	connectMs: number;
	/** `welcome` received. */
	welcomeMs: number;
	/** Final `snapshot-chunk` received. */
	snapshotMs: number;
	/** Every replayed ask received (barrier reply): time to the full request list. */
	requestsMs: number;
	totalMs: number;
	snapshotEntries: number;
	/** Plaintext JSON bytes of the discarded snapshot entries. */
	snapshotBytes: number;
}

/** Best-effort idle observation; derived from the host's debounced footer state, never authoritative. */
export interface HeadlessIdleHint {
	authoritative: false;
	/** True when a `state` frame read idle within the wait; false when the wait ran out. */
	idle: boolean;
	waitedMs: number;
}

interface HeadlessResultBase {
	version: typeof HEADLESS_OUTPUT_VERSION;
	host: HeadlessHostState;
	timings: HeadlessTimings;
}

export type HeadlessResult =
	| (HeadlessResultBase & { action: "print-requests"; status: "ok"; requests: HeadlessRequest[] })
	| (HeadlessResultBase & {
			action: "answer";
			reqId: number;
			/**
			 * `answered`: the answer was sent and the host then ended the ask (a concurrent
			 * answer from another writer that won the race reads the same).
			 * `already-settled`: the ask was not pending for this guest when it joined
			 * (answered elsewhere, aborted, or never offered to writers).
			 */
			status: "answered" | "already-settled";
			value?: string;
	  })
	| (HeadlessResultBase & {
			action: "prompt";
			status: "submitted";
			/** The host was streaming when the prompt was sent, so it lands as a steer (non-authoritative). */
			steer: boolean;
			idle?: HeadlessIdleHint;
	  })
	| (HeadlessResultBase & { action: "abort"; status: "submitted"; idle?: HeadlessIdleHint });

type WelcomeFrame = Extract<CollabFrame, { t: "welcome" }>;
/** A result minus the fields every result shares; distributes over the action union. */
type HeadlessResultFields = HeadlessResult extends infer R
	? R extends HeadlessResult
		? Omit<R, "version" | "host" | "timings">
		: never
	: never;

function normalizeOption(item: CollabUiSelectItem): HeadlessSelectOption {
	if (typeof item === "string") return { label: item };
	return item.description ? { label: item.label, description: item.description } : { label: item.label };
}

export function describeRequest(request: CollabUiRequest): HeadlessRequest {
	if (request.kind === "select") {
		const out: HeadlessRequest = {
			reqId: request.reqId,
			kind: "select",
			title: request.title,
			approval: request.approval === true,
			options: request.options.map(normalizeOption),
		};
		if (request.helpText) out.helpText = request.helpText;
		return out;
	}
	const out: HeadlessRequest = { reqId: request.reqId, kind: "editor", title: request.title, approval: false };
	if (request.prefill !== undefined) out.prefill = request.prefill;
	return out;
}

/**
 * The value to send for {@link request}, or an `invalid-value` error. A select
 * takes one of its labels; an exact match wins, otherwise a unique
 * case-insensitive match is normalized to the label. Anything else is refused
 * here rather than sent: a host reads an unknown approval label as a denial.
 */
export function resolveAnswerValue(request: CollabUiRequest, value: string): string {
	if (request.kind === "editor") return value;
	const labels = request.options.map(item => normalizeOption(item).label);
	if (labels.includes(value)) return value;
	const folded = value.trim().toLowerCase();
	const matches = labels.filter(label => label.toLowerCase() === folded);
	if (matches.length === 1) return matches[0]!;
	throw new HeadlessGuestError(
		"invalid-value",
		`value for request ${request.reqId} must be one of: ${labels.map(label => JSON.stringify(label)).join(", ")}`,
	);
}

function hostState(welcome: WelcomeFrame, state: CollabSessionState): HeadlessHostState {
	const out: HeadlessHostState = {
		sessionId: welcome.header.id,
		cwd: state.cwd,
		isStreaming: state.isStreaming,
		queuedMessageCount: state.queuedMessageCount,
		isAborting: state.isAborting === true,
	};
	if (state.sessionName) out.sessionName = state.sessionName;
	return out;
}

function isIdle(state: CollabSessionState): boolean {
	return !state.isStreaming && state.queuedMessageCount === 0 && state.isAborting !== true;
}

/**
 * Connect, read the welcome batch, perform {@link HeadlessGuestOptions.action},
 * leave. Resolves with the printable result or rejects with a
 * {@link HeadlessGuestError}; never hangs past `deadlineMs`. Error messages
 * never contain the link.
 */
export async function runHeadlessGuest(opts: HeadlessGuestOptions): Promise<HeadlessResult> {
	if (COLLAB_PROTO !== HEADLESS_GUEST_PROTO) {
		throw new HeadlessGuestError(
			"protocol",
			`headless guest speaks collab v${HEADLESS_GUEST_PROTO}, this build speaks v${COLLAB_PROTO}`,
		);
	}
	const parsed = parseCollabLink(opts.link);
	// parseCollabLink echoes the link in some errors; never pass them through.
	if ("error" in parsed) throw new HeadlessGuestError("link", "the link file does not hold a valid collab link");
	if (!parsed.writeToken) {
		throw new HeadlessGuestError(
			"read-only",
			"this is a view-only link: the host replays pending requests only to control links, and refuses writes from view links. Mint one with `omp collab link <id> --json` (without --view)",
		);
	}
	const writeToken = Buffer.from(parsed.writeToken).toString("base64url");
	const key = await importRoomKey(parsed.key);
	return new HeadlessRun(opts, parsed.wsUrl, key, writeToken).run();
}

/** One run's state machine; every frame is handled in {@link HeadlessRun.#onFrame}. */
class HeadlessRun {
	readonly #opts: HeadlessGuestOptions;
	readonly #socket: CollabSocket;
	readonly #writeToken: string;
	readonly #started = Date.now();
	readonly #done = Promise.withResolvers<HeadlessResult>();
	#finished = false;
	#opened = false;
	#timers: Timer[] = [];

	#welcome: WelcomeFrame | undefined;
	#state: CollabSessionState | undefined;
	#snapshotDone = false;
	#snapshotEntries = 0;
	#snapshotBytes = 0;
	#timings = { connectMs: -1, welcomeMs: -1, snapshotMs: -1, requestsMs: -1 };
	/** Asks this guest holds: replayed or newly posted, minus those the host ended. */
	readonly #pending = new Map<number, CollabUiRequest>();
	/** Barrier replies still expected, in send order. */
	#barriers: (() => void)[] = [];
	/** reqId of the answer in flight, once sent. */
	#answerSent: number | undefined;
	#onAnswerEnd: (() => void) | undefined;
	#onState: ((state: CollabSessionState) => void) | undefined;
	/** Set once a write left; a later drop is reported as outcome-unknown. */
	#wrote = false;

	constructor(opts: HeadlessGuestOptions, wsUrl: string, key: CryptoKey, writeToken: string) {
		this.#opts = opts;
		this.#writeToken = writeToken;
		this.#socket = new CollabSocket({ wsUrl, role: "guest", key });
	}

	async run(): Promise<HeadlessResult> {
		const socket = this.#socket;
		socket.onOpen = () => this.#onOpen();
		socket.onFrame = frame => this.#onFrame(frame);
		socket.onClose = (reason, willReconnect) => this.#onClose(reason, willReconnect);
		this.#arm(this.#opts.deadlineMs, () => this.#fail("timeout", this.#timeoutMessage()));
		this.#arm(this.#opts.connectTimeoutMs, () => {
			if (!this.#opened) this.#fail("timeout", "timed out connecting to the collab relay");
		});
		socket.connect();
		try {
			return await this.#done.promise;
		} finally {
			this.#finished = true;
			for (const timer of this.#timers) clearTimeout(timer);
			this.#timers = [];
			socket.onFrame = undefined;
			socket.onClose = undefined;
			socket.onOpen = undefined;
			// Drains queued frames (an answer, a prompt) ahead of the close frame.
			socket.close();
		}
	}

	#elapsed(): number {
		return Date.now() - this.#started;
	}

	#arm(ms: number, fn: () => void): void {
		this.#timers.push(setTimeout(fn, ms));
	}

	#timeoutMessage(): string {
		if (!this.#opened) return "timed out connecting to the collab relay";
		if (!this.#welcome) return "timed out waiting for the host's welcome";
		if (!this.#snapshotDone) return "timed out receiving the host's session snapshot";
		if (this.#barriers.length > 0 && this.#timings.requestsMs < 0) return "timed out waiting for pending requests";
		return "timed out waiting for the host to acknowledge";
	}

	#fail(code: HeadlessErrorCode, message: string): void {
		if (this.#finished) return;
		this.#finished = true;
		this.#done.reject(new HeadlessGuestError(code, message));
	}

	#succeed(result: HeadlessResult): void {
		if (this.#finished) return;
		this.#finished = true;
		this.#done.resolve(result);
	}

	#onOpen(): void {
		if (this.#finished) return;
		if (this.#opened) {
			// Never re-join mid-run: a second hello would replay and double-count, and a
			// write may already be in flight.
			this.#fail("host-gone", "the relay connection was re-established mid-run; retry");
			return;
		}
		this.#opened = true;
		this.#timings.connectMs = this.#elapsed();
		const socket = this.#socket;
		socket.send({
			t: "hello",
			proto: HEADLESS_GUEST_PROTO,
			name: this.#opts.name ?? DEFAULT_HEADLESS_GUEST_NAME,
			writeToken: this.#writeToken,
		});
		this.#barrier(() => this.#onRequestsComplete());
	}

	#onClose(reason: string, willReconnect: boolean): void {
		if (this.#finished) return;
		// Before the first open the socket retries on its own, bounded by the connect timeout.
		if (!this.#opened && willReconnect) return;
		const outcome = this.#wrote ? "; the write was sent but its outcome is unknown" : "";
		this.#fail("host-gone", `collab connection ended: ${reason}${outcome}`);
	}

	/** Queue a barrier probe; {@link onReply} runs on its `ui-request-end`. */
	#barrier(onReply: () => void): void {
		this.#barriers.push(onReply);
		this.#socket.send({ t: "ui-response", reqId: BARRIER_REQ_ID });
	}

	#onFrame(frame: CollabFrame): void {
		if (this.#finished) return;
		if (!this.#welcome) {
			switch (frame.t) {
				case "welcome":
					this.#onWelcome(frame);
					return;
				case "error":
					// Pre-welcome errors answer our hello; no welcome follows.
					if (/protocol mismatch/i.test(frame.message)) this.#fail("protocol", `collab host: ${frame.message}`);
					else this.#fail("host-error", `collab host refused the join: ${frame.message}`);
					return;
				case "bye":
					this.#fail("host-gone", `collab session ended: ${frame.reason}`);
					return;
				default:
					// Broadcast traffic for other guests, ahead of our welcome.
					return;
			}
		}
		switch (frame.t) {
			case "snapshot-chunk":
				if (this.#snapshotDone) return;
				this.#snapshotEntries += frame.entries.length;
				for (const entry of frame.entries) this.#snapshotBytes += JSON.stringify(entry).length;
				if (frame.final || this.#snapshotEntries >= this.#welcome.entryCount) {
					this.#snapshotDone = true;
					this.#timings.snapshotMs = this.#elapsed();
				}
				return;
			case "ui-request":
				this.#pending.set(frame.request.reqId, frame.request);
				return;
			case "ui-request-end":
				this.#onRequestEnd(frame.reqId);
				return;
			case "state":
				this.#state = frame.state;
				this.#onState?.(frame.state);
				return;
			case "bye":
				this.#fail("host-gone", `collab session ended: ${frame.reason}`);
				return;
			case "error":
				if (frame.resync) {
					this.#fail("host-gone", `collab host dropped this guest: ${frame.message}`);
					return;
				}
				if (/read-only link/i.test(frame.message)) {
					this.#fail("read-only", `collab host: ${frame.message}`);
					return;
				}
				this.#fail("host-error", `collab host: ${frame.message}`);
				return;
			default:
				// entry / event / bus / agents / transcript: replica traffic, not needed here.
				return;
		}
	}

	#onWelcome(frame: WelcomeFrame): void {
		if (frame.proto !== HEADLESS_GUEST_PROTO) {
			this.#fail("protocol", `collab host speaks v${frame.proto}, headless guest speaks v${HEADLESS_GUEST_PROTO}`);
			return;
		}
		if (frame.readOnly) {
			this.#fail(
				"read-only",
				"the host accepted this link as view-only (its write token is not current): view links get no pending requests and cannot write",
			);
			return;
		}
		this.#welcome = frame;
		this.#state = frame.state;
		this.#timings.welcomeMs = this.#elapsed();
		if (frame.entryCount === 0) {
			// The host still sends one empty `final` chunk; count it done now either way.
			this.#snapshotDone = true;
			this.#timings.snapshotMs = this.#timings.welcomeMs;
		}
	}

	#onRequestEnd(reqId: number): void {
		if (reqId === BARRIER_REQ_ID) {
			const next = this.#barriers.shift();
			next?.();
			return;
		}
		this.#pending.delete(reqId);
		if (reqId === this.#answerSent) this.#onAnswerEnd?.();
	}

	#result(fields: HeadlessResultFields): HeadlessResult {
		const welcome = this.#welcome!;
		return {
			version: HEADLESS_OUTPUT_VERSION,
			...fields,
			host: hostState(welcome, this.#state ?? welcome.state),
			timings: {
				...this.#timings,
				totalMs: this.#elapsed(),
				snapshotEntries: this.#snapshotEntries,
				snapshotBytes: this.#snapshotBytes,
			},
		} as HeadlessResult;
	}

	#onRequestsComplete(): void {
		if (!this.#welcome) {
			// The reply overtook a welcome that never came: the host did not register us.
			this.#fail("host-error", "collab host did not admit this guest");
			return;
		}
		this.#timings.requestsMs = this.#elapsed();
		const action = this.#opts.action;
		switch (action.kind) {
			case "print-requests":
				this.#succeed(
					this.#result({
						action: "print-requests",
						status: "ok",
						requests: [...this.#pending.values()].map(describeRequest),
					}),
				);
				return;
			case "answer":
				this.#answer(action.reqId, action.value);
				return;
			case "prompt":
				this.#prompt(action.text);
				return;
			case "abort":
				this.#abort();
				return;
		}
	}

	#answer(reqId: number, raw: string): void {
		const request = this.#pending.get(reqId);
		if (!request) {
			this.#succeed(this.#result({ action: "answer", reqId, status: "already-settled" }));
			return;
		}
		let value: string;
		try {
			value = resolveAnswerValue(request, raw);
		} catch (err) {
			if (err instanceof HeadlessGuestError) this.#fail(err.code, err.message);
			else throw err;
			return;
		}
		this.#answerSent = reqId;
		// The host ends the ask on every holder once it settles, and acknowledges an
		// answer to an ask that already settled the same way. Either way it is no
		// longer waiting; a concurrent answer from another writer cannot be told apart.
		this.#onAnswerEnd = () => {
			this.#succeed(this.#result({ action: "answer", reqId, status: "answered", value }));
		};
		this.#wrote = true;
		this.#socket.send({ t: "ui-response", reqId, value });
	}

	#prompt(text: string): void {
		const steer = this.#state?.isStreaming === true;
		this.#wrote = true;
		this.#socket.send({ t: "prompt", text });
		this.#barrier(() => {
			// The host refuses some prompts asynchronously (the turn could not start); give
			// that error a moment to arrive before reporting success.
			this.#arm(PROMPT_REFUSAL_GRACE_MS, () => {
				void this.#afterWrite().then(idle => {
					this.#succeed(this.#result({ action: "prompt", status: "submitted", steer, ...(idle ? { idle } : {}) }));
				});
			});
		});
	}

	#abort(): void {
		this.#wrote = true;
		this.#socket.send({ t: "abort" });
		this.#barrier(() => {
			void this.#afterWrite(this.#state).then(idle => {
				this.#succeed(this.#result({ action: "abort", status: "submitted", ...(idle ? { idle } : {}) }));
			});
		});
	}

	/**
	 * Optional `--wait-idle`: resolve once a `state` frame reads idle, or when the
	 * wait runs out. `current` lets an abort on an already idle host finish at once.
	 * The host debounces state and reads idle during scheduling pauses, so this is
	 * a hint only.
	 */
	async #afterWrite(current?: CollabSessionState): Promise<HeadlessIdleHint | undefined> {
		const waitMs = this.#opts.waitIdleMs;
		if (waitMs === undefined) return undefined;
		const start = Date.now();
		if (current && isIdle(current)) return { authoritative: false, idle: true, waitedMs: 0 };
		const { promise, resolve } = Promise.withResolvers<boolean>();
		this.#onState = state => {
			if (isIdle(state)) resolve(true);
		};
		this.#arm(waitMs, () => resolve(false));
		const idle = await promise;
		this.#onState = undefined;
		return { authoritative: false, idle, waitedMs: Date.now() - start };
	}
}
