/**
 * #3521: the read guard across `/tree`, `/fork`, `/clone`, resume and
 * `pi --fork <path>`, driven through pi 0.85's REAL `AgentSessionRuntime`.
 *
 * Why the real host and not the pi mock: pi re-runs the extension factory for
 * a forked runtime, and `/tree` stays in one activation. The earlier fork
 * tests emitted `session_before_fork` and `session_start` on ONE mock
 * activation, which pi never does, so a closure-local fork stash looked alive
 * while it was dead on every real `/fork`. Here pi itself runs the factory
 * (`extensionFactories: [extension]`, the same module instance these tests
 * import), builds each branch, and emits every lifecycle event. Tool calls go
 * through the session's installed agent hooks (`beforeToolCall` ->
 * `tool_call`, `afterToolCall` -> `tool_result`), reads use pi's real `read`
 * tool, and the matching session entries are appended so `/fork` and `/tree`
 * see the conversation the guard saw. No model is called.
 *
 * The rule under test: after a conversation move, the guard holds exactly
 * the reads whose tool call's `toolResult` is on the new branch, each record
 * kept whole, with no FileTime stamp, so every edit is judged line by line
 * against disk.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	type AgentSessionRuntime,
	type ExtensionAPI,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createReadToolDefinition,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import extension from "../index.js";
import { getProjectDataDir } from "../clients/file-utils.js";
import {
	clearLatencyLog,
	flushLatencyLog,
	getLatencyLogPath,
} from "../clients/latency-logger.js";
import { takeForkHandoff } from "../clients/read-guard-branch.js";
import { _resetSessionLifecycleForTests } from "../clients/session-lifecycle.js";
import {
	cleanupTestEnvironmentsDrained,
	drainBackgroundWritesForTests,
	setupTestEnvironment,
} from "./clients/test-utils.js";

const FLAGS = new Map<string, boolean>([
	["no-lsp", true],
	["no-autofix", true],
	["no-autoformat", true],
	["no-tests", true],
	["no-opengrep", true],
	["no-delta", true],
]);

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * pi-lens's session_start schedules background writes (the project
 * snapshot) into `PILENS_DATA_DIR`, which lives under `root`; they can land
 * after a test ends and recreate the directory. Drain them before removing
 * it, and sweep the prefix once more after the file.
 */
const TMP_PREFIX = "pi-lens-3521-";
let env: ReturnType<typeof setupTestEnvironment>;
let root: string;
let cwd: string;
let agentDir: string;
let sessionsDir: string;
let previousDataDir: string | undefined;
let previousTestMode: string | undefined;
let nextMtimeMs: number;
const runtimes: AgentSessionRuntime[] = [];

beforeEach(async () => {
	_resetSessionLifecycleForTests();
	env = setupTestEnvironment(TMP_PREFIX);
	root = env.tmpDir;
	cwd = path.join(root, "proj");
	agentDir = path.join(root, "agent");
	sessionsDir = path.join(root, "sessions");
	for (const dir of [cwd, path.join(cwd, ".git"), agentDir, sessionsDir])
		fs.mkdirSync(dir, { recursive: true });
	previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(root, "data");
	// The latency row and the turn_end sidecar are both off in test mode.
	previousTestMode = process.env.PI_LENS_TEST_MODE;
	process.env.PI_LENS_TEST_MODE = "0";
	// Strictly increasing and in the past: every write is visible to FileTime,
	// and none postdates a guard's session anchor by accident.
	nextMtimeMs = Date.now() - 1_800_000;
	clearLatencyLog();
	await flushLatencyLog();
});

afterEach(async () => {
	try {
		for (const runtime of runtimes.splice(0)) await runtime.dispose();
		await drainBackgroundWritesForTests();
	} finally {
		_resetSessionLifecycleForTests();
		if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = previousDataDir;
		if (previousTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
		else process.env.PI_LENS_TEST_MODE = previousTestMode;
		env.cleanup();
	}
});

afterAll(async () => {
	await cleanupTestEnvironmentsDrained(TMP_PREFIX);
});

async function startRuntime(
	sessionManager: SessionManager,
	alongside: Array<(pi: ExtensionAPI) => void> = [],
): Promise<AgentSessionRuntime> {
	const runtime = await createAgentSessionRuntime(
		async ({ cwd: runtimeCwd, sessionManager: sm, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd: runtimeCwd,
				agentDir,
				extensionFlagValues: FLAGS,
				resourceLoaderOptions: {
					extensionFactories: [extension, ...alongside],
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager: sm,
					sessionStartEvent,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		},
		{ cwd, agentDir, sessionManager },
	);
	runtime.setRebindSession(async () => {
		await runtime.session.bindExtensions({});
	});
	await runtime.session.bindExtensions({});
	runtimes.push(runtime);
	return runtime;
}

/** A conversation driven through one runtime's live session. */
function conversation(runtime: AgentSessionRuntime) {
	const S = () => runtime.session;
	const assistant = (
		content: unknown[],
		stopReason: "toolUse" | "stop" = "toolUse",
	) => ({
		role: "assistant" as const,
		content,
		api: "x",
		provider: "x",
		model: "x",
		usage,
		stopReason,
		timestamp: Date.now(),
	});
	const append = (message: unknown): string =>
		S().sessionManager.appendMessage(
			message as Parameters<SessionManager["appendMessage"]>[0],
		);
	const toolCall = async (id: string, name: string, args: object) => {
		const callEntry = append(
			assistant([{ type: "toolCall", id, name, arguments: args }]),
		);
		const verdict = (await S().agent.beforeToolCall?.({
			toolCall: { type: "toolCall", id, name, arguments: args },
			args,
		} as never)) as { block?: boolean; reason?: string } | undefined;
		return { callEntry, verdict };
	};
	const toolResult = async (
		id: string,
		name: string,
		args: object,
		content: unknown[],
		isError = false,
	): Promise<string> => {
		const patched = (await S().agent.afterToolCall?.({
			toolCall: { type: "toolCall", id, name, arguments: args },
			args,
			result: { content, details: undefined },
			isError,
		} as never)) as { content?: unknown[] } | undefined;
		return append({
			role: "toolResult",
			toolCallId: id,
			toolName: name,
			content: patched?.content ?? content,
			isError,
			timestamp: Date.now(),
		});
	};
	return {
		S,
		user: (text: string): string =>
			append({ role: "user", content: text, timestamp: Date.now() }),
		done: (): string =>
			append(assistant([{ type: "text", text: "done" }], "stop")),
		async read(id: string, file: string) {
			const args = { path: file };
			const { callEntry } = await toolCall(id, "read", args);
			const result = await createReadToolDefinition(cwd).execute(
				id,
				args,
				undefined,
				undefined,
				{ cwd } as never,
			);
			const resultEntry = await toolResult(id, "read", args, result.content);
			return { callEntry, resultEntry };
		},
		/** A positional edit of one line; applied to disk only when allowed. */
		async editLine(
			id: string,
			file: string,
			line: number,
			newText: string,
			apply = true,
		): Promise<string> {
			const args = {
				path: file,
				edits: [{ range: { start: { line }, end: { line } }, newText }],
			};
			const { verdict } = await toolCall(id, "edit", args);
			const blocked = verdict?.block === true;
			if (!blocked && apply) {
				const lines = fs.readFileSync(file, "utf8").split("\n");
				lines.splice(line - 1, 1, newText);
				writeNow(file, lines.join("\n"));
				await toolResult(id, "edit", args, [{ type: "text", text: "ok" }]);
			} else {
				await toolResult(
					id,
					"edit",
					args,
					[{ type: "text", text: verdict?.reason ?? "blocked" }],
					true,
				);
			}
			return blocked ? `BLOCK: ${firstLine(verdict?.reason)}` : "ALLOW";
		},
		async write(id: string, file: string, content: string) {
			const args = { path: file, content };
			const { verdict } = await toolCall(id, "write", args);
			writeNow(file, content);
			await toolResult(id, "write", args, [{ type: "text", text: "ok" }]);
			return verdict?.block === true ? "BLOCK" : "ALLOW";
		},
		/** A bash call whose output the host returned as `output`. */
		async bash(id: string, command: string, output: string) {
			const args = { command };
			await toolCall(id, "bash", args);
			return toolResult(id, "bash", args, [{ type: "text", text: output }]);
		},
		/** One of pi-lens's own tools, executed as the host would. */
		async ownTool(id: string, name: string, args: object) {
			await toolCall(id, name, args);
			const tool = S().getToolDefinition(name);
			if (!tool) throw new Error(`tool ${name} is not registered`);
			const result = (await tool.execute(
				id,
				args as never,
				undefined,
				undefined,
				{
					cwd,
				} as never,
			)) as { content: unknown[] };
			return toolResult(id, name, args, result.content);
		},
	};
}

function firstLine(text: string | undefined): string {
	return String(text ?? "").split("\n")[0] ?? "";
}

/** A file authored before this session: its mtime is an hour old. */
function fixture(name: string, lines: number): string {
	const file = path.join(cwd, name);
	fs.writeFileSync(
		file,
		Array.from({ length: lines }, (_, i) => `${name}-line${i + 1}`).join("\n"),
	);
	const old = (Date.now() - 3_600_000) / 1000;
	fs.utimesSync(file, old, old);
	return file;
}

/** A write with a strictly later mtime, so FileTime always sees it. */
function writeNow(file: string, content: string): void {
	fs.writeFileSync(file, content);
	nextMtimeMs += 10_000;
	fs.utimesSync(file, nextMtimeMs / 1000, nextMtimeMs / 1000);
}

const ZERO_READ = expect.stringMatching(/^BLOCK: .*Edit without read/);

async function branchRetainedRows(): Promise<Record<string, unknown>[]> {
	await flushLatencyLog();
	const text = fs.existsSync(getLatencyLogPath())
		? fs.readFileSync(getLatencyLogPath(), "utf8")
		: "";
	return text
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter((row) => row.phase === "read_guard_branch_retained")
		.map((row) => row.metadata as Record<string, unknown>);
}

/**
 * Let a fire-and-forget sidecar write land. The save is deliberately not
 * awaited by its hook (#2523), so the test yields the event loop — no timer —
 * until the atomic rename is visible.
 */
async function sidecarSettled(sessionId: string): Promise<void> {
	const file = path.join(
		getProjectDataDir(cwd),
		"sessions",
		`${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`,
	);
	for (let i = 0; i < 5000 && !fs.existsSync(file); i++)
		await new Promise<void>((resolve) => setImmediate(resolve));
	expect(fs.existsSync(file), `sidecar ${file}`).toBe(true);
}

/** pi-lens persists its sidecar at turn_end; emit one the way pi does. */
async function turnEnd(runtime: AgentSessionRuntime): Promise<void> {
	await runtime.session.extensionRunner.emit({
		type: "turn_end",
		turnIndex: 0,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "x",
			provider: "x",
			model: "x",
			usage,
			stopReason: "stop",
			timestamp: Date.now(),
		},
		toolResults: [],
	} as never);
	await sidecarSettled(runtime.session.sessionManager.getSessionId());
}

describe("#3521 /tree keeps only the reads on the new branch", () => {
	it("blocks an edit backed only by a read on the abandoned branch (A1)", async () => {
		const c = conversation(await startRuntime(SessionManager.inMemory(cwd)));
		const b = fixture("b.conf", 6);
		c.user("prompt 1");
		c.done();
		const u2 = c.user("prompt 2");
		await c.read("call_read_b", b);
		c.done();

		await c.S().navigateTree(u2);

		expect(await c.editLine("post_b", b, 2, "Y", false)).toEqual(ZERO_READ);
		expect((await branchRetainedRows()).at(-1)).toMatchObject({
			trigger: "tree",
			source: "live",
			kept: 0,
			dropped: 1,
			branchReadable: true,
		});
	});

	it("blocks an edit of a file written only on the abandoned branch (A2)", async () => {
		const c = conversation(await startRuntime(SessionManager.inMemory(cwd)));
		const file = path.join(cwd, "c.conf");
		c.user("prompt 1");
		c.done();
		const u2 = c.user("prompt 2");
		expect(await c.write("call_write_c", file, "c1\nc2\nc3\nc4")).toBe("ALLOW");
		c.done();

		await c.S().navigateTree(u2);

		// pi never reverts files: the write is still on disk, the conversation
		// no longer shows it.
		expect(fs.existsSync(file)).toBe(true);
		expect(await c.editLine("post_c", file, 2, "Y", false)).toEqual(ZERO_READ);
	});

	it("keeps a file overwritten on the kept branch editable through its creation read (A2 inverse)", async () => {
		const c = conversation(await startRuntime(SessionManager.inMemory(cwd)));
		const file = fixture("c.conf", 4);
		c.user("prompt 1");
		expect(await c.write("call_write_c", file, "c1\nc2\nc3\nc4")).toBe("ALLOW");
		c.done();
		const u2 = c.user("prompt 2");
		c.done();

		await c.S().navigateTree(u2);

		expect(await c.editLine("post_c", file, 2, "Y", false)).toBe("ALLOW");
	});

	it("needs a re-read of a brand-new file created on the kept branch (writtenThisSession is cleared)", async () => {
		// A write that CREATES a file returns from tool_call before
		// noteCreatedFile (`targetMissing`), so no creation read carries its
		// tool call; only `writtenThisSession` vouched for it, and a move clears
		// that. The safe direction: one re-read, never an allow.
		const c = conversation(await startRuntime(SessionManager.inMemory(cwd)));
		const file = path.join(cwd, "new.conf");
		c.user("prompt 1");
		await c.write("call_write_new", file, "n1\nn2\nn3");
		c.done();
		const u2 = c.user("prompt 2");
		c.done();

		await c.S().navigateTree(u2);

		expect(await c.editLine("post_new", file, 2, "Y", false)).toEqual(
			ZERO_READ,
		);
	});

	it("blocks an edit of a line only the abandoned branch rewrote (A3)", async () => {
		const c = conversation(await startRuntime(SessionManager.inMemory(cwd)));
		const b = fixture("b.conf", 6);
		c.user("prompt 1");
		await c.read("call_read_b1", b);
		c.done();
		const u2 = c.user("prompt 2");
		expect(
			await c.editLine("call_edit_b", b, 2, "EDITED-ON-ABANDONED-BRANCH"),
		).toBe("ALLOW");
		c.done();

		await c.S().navigateTree(u2);

		// The conversation shows line 2 as `b.conf-line2`; disk holds the
		// abandoned branch's edit. Neither its own-edit record nor its FileTime
		// stamp may vouch for that line (NoStaleAllow).
		expect(fs.readFileSync(b, "utf8").split("\n")[1]).toBe(
			"EDITED-ON-ABANDONED-BRANCH",
		);
		expect(await c.editLine("post_b2", b, 2, "Y", false)).toMatch(/^BLOCK: /);
		// The kept read stays whole: a line the abandoned branch left alone is
		// still editable (NoFalseBlock, A11).
		expect(await c.editLine("post_b4", b, 4, "Y", false)).toBe("ALLOW");
	});

	it("keeps a read when /tree lands on its toolResult, drops it on the call alone (A4)", async () => {
		const c = conversation(await startRuntime(SessionManager.inMemory(cwd)));
		const b = fixture("b.conf", 6);
		c.user("prompt 1");
		const { callEntry, resultEntry } = await c.read("call_read_b", b);
		c.done();

		await c.S().navigateTree(resultEntry);
		expect(await c.editLine("post_b_result", b, 2, "Y", false)).toBe("ALLOW");

		// Mid-turn: the assistant entry that issued the call, without its
		// result. The agent never saw the bytes.
		await c.S().navigateTree(callEntry);
		expect(await c.editLine("post_b_call", b, 2, "Y", false)).toEqual(
			ZERO_READ,
		);
	});

	it("needs a re-read after a /tree round trip back to a branch (A5: records are deleted, not parked)", async () => {
		const c = conversation(await startRuntime(SessionManager.inMemory(cwd)));
		const a = fixture("a.conf", 6);
		c.user("prompt 1");
		c.done();
		const u2 = c.user("prompt 2");
		await c.read("call_read_a", a);
		const leafA = c.done();

		await c.S().navigateTree(u2);
		c.user("prompt 2 on branch B");
		c.done();
		await c.S().navigateTree(leafA);

		// The read is back in the conversation, but the guard deleted it when it
		// left branch A. Deferred parking (#3521): one re-read, never an allow.
		expect(await c.editLine("post_a", a, 2, "Y", false)).toEqual(ZERO_READ);
	});

	it("blocks an edit of a large (unhashed) file after a move until it is re-read (A10)", async () => {
		const c = conversation(await startRuntime(SessionManager.inMemory(cwd)));
		// Past PI_LENS_READ_GUARD_HASH_MAX_LINES (3000): the read has no hashes.
		const big = fixture("big.conf", 3100);
		c.user("prompt 1");
		await c.read("call_read_big", big);
		c.done();
		const u2 = c.user("prompt 2");
		expect(await c.editLine("call_edit_big", big, 2, "EDITED")).toBe("ALLOW");
		c.done();

		await c.S().navigateTree(u2);

		expect(await c.editLine("post_big", big, 2, "Y", false)).toMatch(
			/^BLOCK: .*File modified since read/,
		);
	});

	it("drops a read whose tool result carried no tool-call id", async () => {
		const c = conversation(await startRuntime(SessionManager.inMemory(cwd)));
		const b = fixture("b.conf", 6);
		c.user("prompt 1");
		// OpenAI-compatible servers can send no id; pi stores `""`.
		const { resultEntry } = await c.read("", b);
		c.done();

		// The read's result stays on the branch; only its id is missing.
		await c.S().navigateTree(resultEntry);

		expect(await c.editLine("post_b", b, 2, "Y", false)).toEqual(ZERO_READ);
	});

	it("credits a sibling branch's read that reuses the same tool-call id (accepted residual, #3521 D1)", async () => {
		// Pinned so the residual is visible, not fixed: pi stores provider ids
		// verbatim, and Mistral's fallback (`toolcall:<index>`), OpenAI-
		// compatible index ids, and Google's per-message ids can repeat across
		// responses. Matching on the id alone cannot tell the two calls apart.
		const c = conversation(await startRuntime(SessionManager.inMemory(cwd)));
		const a = fixture("a.conf", 6);
		const b = fixture("b.conf", 6);
		c.user("prompt 1");
		c.done();
		const u2 = c.user("prompt 2 on branch X");
		await c.read("call_0", b);
		const leafX = c.done();

		await c.S().navigateTree(u2);
		c.user("prompt 2 on branch Y");
		await c.read("call_0", a);
		c.done();
		await c.S().navigateTree(leafX);

		// Branch X never read a.conf; Y's record rides X's `call_0` result.
		expect(await c.editLine("post_a", a, 2, "Y", false)).toBe("ALLOW");
	});

	it("leaves the primary's guard alone when a concurrent secondary moves its own tree (A12)", async () => {
		const primary = conversation(
			await startRuntime(SessionManager.inMemory(cwd)),
		);
		const b = fixture("b.conf", 6);
		primary.user("prompt 1");
		await primary.read("call_read_b", b);
		primary.done();

		// An in-process subagent: a second live runtime in the same process,
		// classified concurrent-secondary. Its branch has no tool results.
		const secondary = conversation(
			await startRuntime(SessionManager.inMemory(cwd)),
		);
		const s1 = secondary.user("subagent prompt");
		secondary.done();
		await secondary.S().navigateTree(s1);

		expect(await primary.editLine("post_b", b, 2, "Y", false)).toBe("ALLOW");
	});
});

describe("#3521 every read producer carries its tool call across a move", () => {
	// Keep-side witnesses: each record below is on the kept branch, so a
	// producer that stops stamping its tool call would turn a read the
	// conversation still shows into a false block.
	async function keptAfterTree(
		produce: (c: ReturnType<typeof conversation>) => Promise<unknown>,
		file: string,
		line: number,
	): Promise<string> {
		const c = conversation(await startRuntime(SessionManager.inMemory(cwd)));
		c.user("prompt 1");
		await produce(c);
		c.done();
		const u2 = c.user("prompt 2");
		c.done();
		await c.S().navigateTree(u2);
		return c.editLine("post", file, line, "Y", false);
	}

	it("keeps an own-edit record, so the agent can re-edit the line it wrote", async () => {
		const b = fixture("b.conf", 6);
		expect(
			await keptAfterTree(
				async (c) => {
					await c.read("call_read_b", b);
					expect(await c.editLine("call_edit_b", b, 2, "OWN")).toBe("ALLOW");
				},
				b,
				2,
			),
		).toBe("ALLOW");
	});

	it("keeps a bash view span", async () => {
		const b = fixture("b.conf", 6);
		expect(
			await keptAfterTree(
				(c) =>
					c.bash(
						"call_sed_b",
						`sed -n '1,6p' ${b}`,
						fs.readFileSync(b, "utf8"),
					),
				b,
				2,
			),
		).toBe("ALLOW");
	});

	it("keeps a grep search credit", async () => {
		const b = fixture("b.conf", 6);
		expect(
			await keptAfterTree(
				(c) => c.bash("call_grep_b", `grep -n line2 ${b}`, "2:b.conf-line2"),
				b,
				2,
			),
		).toBe("ALLOW");
	});

	it("keeps a read_symbol body", async () => {
		const file = path.join(cwd, "sym.ts");
		fs.writeFileSync(
			file,
			"export function target(n: number): number {\n\treturn n * 2;\n}\n",
		);
		const old = (Date.now() - 3_600_000) / 1000;
		fs.utimesSync(file, old, old);
		expect(
			await keptAfterTree(
				(c) =>
					c.ownTool("call_sym", "read_symbol", {
						path: file,
						symbol: "target",
					}),
				file,
				2,
			),
		).toBe("ALLOW");
	});
});

describe("#3521 /fork and /clone carry the reads on the fork's branch", () => {
	it("credits a read before the fork point and not one after it (A6)", async () => {
		const runtime = await startRuntime(SessionManager.create(cwd, sessionsDir));
		const c = conversation(runtime);
		const a = fixture("a.conf", 6);
		const b = fixture("b.conf", 6);
		c.user("prompt 1");
		await c.read("call_read_a", a);
		c.done();
		const u2 = c.user("prompt 2");
		await c.read("call_read_b", b);
		c.done();

		await runtime.fork(u2);

		expect(await c.editLine("post_a", a, 2, "Y", false)).toBe("ALLOW");
		expect(await c.editLine("post_b", b, 2, "Y", false)).toEqual(ZERO_READ);
		const rows = await branchRetainedRows();
		expect(rows.at(-1)).toMatchObject({
			trigger: "fork",
			source: "fork-slot",
			kept: 1,
			dropped: 1,
		});
	});

	it("falls back to the parent's sidecar that session_before_fork saved when the slot is gone", async () => {
		// A second extension empties the process slot between the parent's
		// session_before_fork and the fork's session_start, the way a module
		// graph of another build would miss it. No turn_end ran, so only the
		// sidecar session_before_fork saved can carry the read.
		const loseSlot = (pi: ExtensionAPI) => {
			pi.on("session_shutdown", (event) => {
				if ((event as { reason?: string }).reason === "fork") takeForkHandoff();
			});
		};
		const runtime = await startRuntime(
			SessionManager.create(cwd, sessionsDir),
			[loseSlot],
		);
		const c = conversation(runtime);
		const a = fixture("a.conf", 6);
		c.user("prompt 1");
		await c.read("call_read_a", a);
		c.done();
		const u2 = c.user("prompt 2");
		c.done();

		await runtime.fork(u2);

		expect(await c.editLine("post_a", a, 2, "Y", false)).toBe("ALLOW");
		expect((await branchRetainedRows()).at(-1)).toMatchObject({
			trigger: "fork",
			source: "parent-sidecar",
			kept: 1,
		});
	});

	it("carries the reads of an in-memory session through the process slot", async () => {
		const runtime = await startRuntime(SessionManager.inMemory(cwd));
		const c = conversation(runtime);
		const a = fixture("a.conf", 6);
		const b = fixture("b.conf", 6);
		c.user("prompt 1");
		await c.read("call_read_a", a);
		c.done();
		const u2 = c.user("prompt 2");
		await c.read("call_read_b", b);
		c.done();

		await runtime.fork(u2);

		expect(await c.editLine("post_a", a, 2, "Y", false)).toBe("ALLOW");
		expect(await c.editLine("post_b", b, 2, "Y", false)).toEqual(ZERO_READ);
	});

	it("/clone keeps every read; a clone at an earlier entry keeps only what precedes it (A7)", async () => {
		const runtime = await startRuntime(SessionManager.create(cwd, sessionsDir));
		const c = conversation(runtime);
		const a = fixture("a.conf", 6);
		const b = fixture("b.conf", 6);
		c.user("prompt 1");
		const { resultEntry: afterA } = await c.read("call_read_a", a);
		c.done();
		c.user("prompt 2");
		await c.read("call_read_b", b);
		c.done();

		await runtime.fork(c.S().sessionManager.getLeafId()!, { position: "at" });
		expect(await c.editLine("clone_a", a, 2, "Y", false)).toBe("ALLOW");
		expect(await c.editLine("clone_b", b, 2, "Y", false)).toBe("ALLOW");

		await runtime.fork(afterA, { position: "at" });
		expect(await c.editLine("at_a", a, 2, "Y", false)).toBe("ALLOW");
		expect(await c.editLine("at_b", b, 2, "Y", false)).toEqual(ZERO_READ);
	});

	it("credits only a sibling branch's own reads when forking from it (A8)", async () => {
		const runtime = await startRuntime(SessionManager.create(cwd, sessionsDir));
		const c = conversation(runtime);
		const a = fixture("a.conf", 6);
		const b = fixture("b.conf", 6);
		const d = fixture("d.conf", 6);
		c.user("prompt 1");
		await c.read("call_read_a", a);
		const p1Done = c.done();
		c.user("prompt 2 on branch X");
		await c.read("call_read_b", b);
		const leafX = c.done();
		await c.S().navigateTree(p1Done);
		c.user("prompt 2 on branch Y");
		await c.read("call_read_d", d);
		c.done();

		// The fork point is on branch X, which the guard left at the /tree.
		await runtime.fork(leafX, { position: "at" });

		expect(await c.editLine("post_a", a, 2, "Y", false)).toBe("ALLOW");
		expect(await c.editLine("post_d", d, 2, "Y", false)).toEqual(ZERO_READ);
		// X's read was deleted when the guard left X, so it is not handed on:
		// the A5 re-read, never a blind allow.
		expect(await c.editLine("post_b", b, 2, "Y", false)).toEqual(ZERO_READ);
	});
});

describe("#3521 a resumed session keeps only its branch's reads", () => {
	it("drops a persisted read that is not on the branch the resume lands on (A9)", async () => {
		const runtime = await startRuntime(SessionManager.create(cwd, sessionsDir));
		const c = conversation(runtime);
		const a = fixture("a.conf", 6);
		const b = fixture("b.conf", 6);
		c.user("prompt 1");
		await c.read("call_read_a", a);
		const p1Done = c.done();
		c.user("prompt 2");
		await c.read("call_read_b", b);
		c.done();
		// The sidecar is saved while both reads are live.
		await turnEnd(runtime);
		// /tree without a summary appends nothing; the sibling prompt below is
		// the last appended entry, which is where a resume lands.
		await c.S().navigateTree(p1Done);
		c.user("prompt 2 on branch Y");
		c.done();
		const sessionFile = c.S().sessionManager.getSessionFile()!;

		await runtime.switchSession(sessionFile);

		expect(await c.editLine("post_a", a, 2, "Y", false)).toBe("ALLOW");
		expect(await c.editLine("post_b", b, 2, "Y", false)).toEqual(ZERO_READ);
		expect((await branchRetainedRows()).at(-1)).toMatchObject({
			trigger: "resume",
			source: "own-sidecar",
			kept: 1,
			dropped: 1,
		});
	});

	it("loads the parent's sidecar for `pi --fork <path>`, filtered to the copied branch", async () => {
		const parentRuntime = await startRuntime(
			SessionManager.create(cwd, sessionsDir),
		);
		const parent = conversation(parentRuntime);
		const a = fixture("a.conf", 6);
		const b = fixture("b.conf", 6);
		parent.user("prompt 1");
		await parent.read("call_read_a", a);
		const p1Done = parent.done();
		parent.user("prompt 2");
		await parent.read("call_read_b", b);
		parent.done();
		await turnEnd(parentRuntime);
		// Leave the parent on branch Y so the copied tree's leaf is not the read.
		await parent.S().navigateTree(p1Done);
		parent.user("prompt 2 on branch Y");
		parent.done();
		const parentFile = parent.S().sessionManager.getSessionFile()!;
		await parentRuntime.dispose();
		runtimes.splice(runtimes.indexOf(parentRuntime), 1);

		// `pi --fork <path>`: a new process, a `startup` with
		// `header.parentSession` set and no sidecar of its own.
		const child = conversation(
			await startRuntime(SessionManager.forkFrom(parentFile, cwd, sessionsDir)),
		);

		expect(await child.editLine("post_a", a, 2, "Y", false)).toBe("ALLOW");
		expect(await child.editLine("post_b", b, 2, "Y", false)).toEqual(ZERO_READ);
		expect((await branchRetainedRows()).at(-1)).toMatchObject({
			trigger: "startup",
			source: "parent-sidecar",
			kept: 1,
			dropped: 1,
		});
	});
});
