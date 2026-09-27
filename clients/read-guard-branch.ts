/**
 * The read guard across conversation moves (#3521): `/tree`, `/fork`,
 * `/clone`, resume and `pi --fork <path>`.
 *
 * A read record is evidence only while the conversation still shows the
 * agent the tool result it came from. pi keeps entry ids and tool-call ids
 * intact across `/tree`, `createBranchedSession` and `forkFrom`, and the
 * handler's `ctx.sessionManager.getBranch()` is the ground truth for what the
 * conversation now holds. So the rule is: keep a record exactly when its
 * `toolCallId` has a `toolResult` entry on that branch.
 *
 * Accepted residual (maintainer decision on #3521): pi stores provider
 * tool-call ids verbatim, and some providers reuse them across responses —
 * Mistral's fallback derives `toolcall:<index>`, OpenAI-compatible servers
 * may send index ids or none (`id || ""`), Google makes ids unique within one
 * message only. With those providers a sibling branch's read can match an id
 * that is also on this branch. An empty id is never recorded
 * (`resolveToolCallCorrelationId` returns undefined), so it never matches.
 *
 * The fork hand-off. pi re-runs the extension factory for the forked runtime,
 * so a closure-local stash dies with the parent's activation. The parent's
 * `session_before_fork` leaves its read-set in a PROCESS-wide slot
 * ({@link stashForkHandoff}): an in-process `/fork` always runs in the same
 * process, and `getProcessSingleton` keys on `globalThis`, so the slot also
 * survives a module re-import. The hook's budget is 0 ms (#2523), so the
 * parent's sidecar is saved fire-and-forget; it is the fallback, and the only
 * channel for `pi --fork <path>`, which starts a new process.
 */

import { promises as fs } from "node:fs";
import { logLatency } from "./latency-logger.js";
import { getProcessSingleton } from "./process-singletons.js";
import type { PersistedReadGuardState } from "./read-guard.js";
import { sanitizeCorrelationId } from "./read-guard-logger.js";

export interface BranchToolResults {
	/** `toolResult` tool-call ids on the branch, in record (`sanitizeCorrelationId`) form. */
	ids: Set<string>;
	/** False when the session manager was missing or threw: no id is on the branch. */
	readable: boolean;
}

/**
 * The tool-call ids whose `toolResult` entry is on the session's current
 * branch. The result, not the call: a `/tree` target can be the assistant
 * entry that issued a call whose result is not on the branch, and then the
 * agent never saw the read's bytes. An unreadable session manager (a stale
 * ctx, a host without `getBranch`) yields no ids, so every record is dropped:
 * a re-read, never an edit vouched for by a branch nobody can see.
 */
export function branchToolResultIds(
	sessionManager: unknown,
): BranchToolResults {
	const ids = new Set<string>();
	try {
		const branch = (
			sessionManager as { getBranch?: () => unknown } | undefined
		)?.getBranch?.();
		if (!Array.isArray(branch)) return { ids, readable: false };
		for (const entry of branch) {
			// Only a `toolResult` message carries `toolCallId`; an assistant
			// message holds its calls' ids inside `content`.
			const message =
				(entry as { type?: unknown; message?: unknown } | undefined)?.type ===
				"message"
					? ((entry as { message?: unknown }).message as
							| { toolCallId?: unknown }
							| undefined)
					: undefined;
			const id = sanitizeCorrelationId(message?.toolCallId);
			if (id !== undefined) ids.add(id);
		}
		return { ids, readable: true };
	} catch {
		return { ids: new Set<string>(), readable: false };
	}
}

/** What a parent's `session_before_fork` hands to the forked activation. */
export interface ForkHandoff {
	sourceSessionFile: string | undefined;
	readGuard: PersistedReadGuardState;
}

const FORK_HANDOFF_FAMILY = "read-guard.fork-handoff";
/** Bump when {@link ForkHandoff}'s shape changes. */
const FORK_HANDOFF_VERSION = 1;

function forkHandoffSlot(): { handoff: ForkHandoff | undefined } {
	return getProcessSingleton(FORK_HANDOFF_FAMILY, FORK_HANDOFF_VERSION, () => ({
		handoff: undefined,
	}));
}

/** One slot: a later `session_before_fork` replaces an unconsumed one. */
export function stashForkHandoff(handoff: ForkHandoff): void {
	forkHandoffSlot().handoff = handoff;
}

/** Take and clear the slot. Every primary session start consumes it. */
export function takeForkHandoff(): ForkHandoff | undefined {
	const slot = forkHandoffSlot();
	const handoff = slot.handoff;
	slot.handoff = undefined;
	return handoff;
}

/** A session header line is small; this bounds a corrupt first line. */
const SESSION_HEADER_MAX_BYTES = 64 * 1024;

/**
 * The stable session id in a pi session file's header (its first JSONL line,
 * `{"type":"session","id":…}`), which keys that session's sidecar.
 * `undefined` for a missing, unreadable or malformed file.
 */
export async function readSessionHeaderId(
	sessionFile: string,
): Promise<string | undefined> {
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(sessionFile, "r");
		const buffer = Buffer.alloc(SESSION_HEADER_MAX_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const firstLine =
			buffer.toString("utf8", 0, bytesRead).split("\n")[0] ?? "";
		const header = JSON.parse(firstLine) as { id?: unknown } | null;
		return typeof header?.id === "string" ? header.id : undefined;
	} catch {
		return undefined;
	} finally {
		await handle?.close().catch(() => {});
	}
}

export type ReadGuardStartSource =
	| "fork-slot"
	| "parent-sidecar"
	| "own-sidecar"
	| "none";

/**
 * Which persisted read-set a primary `session_start` (other than `/new` and
 * reload, which import nothing) takes, before the branch filter. Consumes
 * the fork slot, so a hand-off never outlives the start it was left for.
 *
 * - `fork`: the slot, when it came from this fork's parent; otherwise the
 *   parent's sidecar.
 * - anything else (resume, startup): this session's own sidecar; without
 *   one, the parent's (`pi --fork <path>` starts as `startup` with
 *   `header.parentSession` set).
 */
export async function resolveReadGuardStartState(args: {
	reason: string | undefined;
	ownState: PersistedReadGuardState | undefined;
	parentSessionFile: string | undefined;
	loadParentState: (
		parentSessionId: string,
	) => Promise<PersistedReadGuardState | undefined>;
}): Promise<{
	state: PersistedReadGuardState | undefined;
	source: ReadGuardStartSource;
}> {
	const handoff = takeForkHandoff();
	// Same parent: both files match, or both are unknown (an in-memory
	// session has no file, and neither does its fork).
	if (
		args.reason === "fork" &&
		handoff &&
		handoff.sourceSessionFile === args.parentSessionFile
	)
		return { state: handoff.readGuard, source: "fork-slot" };
	if (args.ownState) return { state: args.ownState, source: "own-sidecar" };
	if (args.parentSessionFile) {
		const parentId = await readSessionHeaderId(args.parentSessionFile);
		const parentState = parentId
			? await args.loadParentState(parentId)
			: undefined;
		if (parentState) return { state: parentState, source: "parent-sidecar" };
	}
	return { state: undefined, source: "none" };
}

/**
 * One `read_guard_branch_retained` latency row per conversation move: which
 * move, where the read-set came from, and how many records the branch kept.
 * A move that drops every read (an unreadable branch included) is otherwise
 * indistinguishable from a guard that was never populated.
 */
export function logReadGuardBranchMove(args: {
	trigger: string;
	source: ReadGuardStartSource | "live";
	kept: number;
	dropped: number;
	branch: BranchToolResults;
	cwd: string;
}): void {
	logLatency({
		type: "phase",
		phase: "read_guard_branch_retained",
		filePath: args.cwd,
		durationMs: 0,
		metadata: {
			trigger: args.trigger,
			source: args.source,
			kept: args.kept,
			dropped: args.dropped,
			branchToolResults: args.branch.ids.size,
			branchReadable: args.branch.readable,
		},
	});
}
