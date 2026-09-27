/**
 * #3521 review F1 (catalog shape 22): index.ts captures the read guard's
 * branch epoch when `agent_settled` starts, before its first await, and hands
 * that epoch to the deferred drain. pi marks the run inactive before it
 * awaits the agent_settled handlers, so a `/tree` can land while the settled
 * sweep awaits; the drain that runs after it must still carry the epoch from
 * before the move, or its writes are credited to the new branch.
 *
 * The drain itself (`handleAgentEnd`) is replaced by a spy on its argument:
 * the fence at its write sites is pinned in
 * `tests/clients/runtime-agent-end.test.ts`, and an end-to-end drain race is
 * masked by the pre-#3520 mtime fallback. This file pins the wiring only.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../clients/bootstrap.js", async () => {
	const { bootstrapSeamMock } = await import("./support/bootstrap-mock.js");
	return bootstrapSeamMock(async () => ({
		metricsClient: { reset: () => {} },
		todoScanner: {},
		biomeClient: { isAvailable: () => false },
		ruffClient: { isAvailable: () => false },
		knipClient: {
			isAvailable: () => false,
			analyze: async () => ({
				success: false,
				summary: "unavailable",
				issues: [],
			}),
		},
		jscpdClient: { isAvailable: () => false },
		depChecker: { isAvailable: () => false },
		testRunnerClient: { detectRunner: () => null },
		goClient: { isGoAvailableAsync: async () => false },
		rustClient: { isAvailableAsync: async () => false },
		agentBehaviorClient: {
			recordToolCall: () => {},
			formatWarnings: () => "",
		},
		complexityClient: {
			isSupportedFile: () => false,
			analyzeFile: () => null,
		},
	}));
});
vi.mock("../clients/runtime-session.js", () => ({
	handleSessionStart: async (deps: {
		runtime: { projectRoot: string };
		ctxCwd?: string;
	}) => {
		if (deps.ctxCwd) deps.runtime.projectRoot = deps.ctxCwd;
	},
}));
const drainCalls = vi.hoisted(
	() => [] as Array<{ readGuardBranchEpoch?: number }>,
);
vi.mock("../clients/runtime-agent-end.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../clients/runtime-agent-end.js")>()),
	handleAgentEnd: vi.fn(async (deps: { readGuardBranchEpoch?: number }) => {
		drainCalls.push({ readGuardBranchEpoch: deps.readGuardBranchEpoch });
		return undefined;
	}),
}));

import extension from "../index.js";
import { resetObservedMutationNet } from "../clients/observed-mutation.js";
import { _resetSessionLifecycleForTests } from "../clients/session-lifecycle.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "./clients/test-utils.js";

describe("#3521 agent_settled hands the drain the branch epoch from before a /tree", () => {
	let env: ReturnType<typeof setupTestEnvironment>;
	let prevDataDir: string | undefined;

	beforeEach(() => {
		_resetSessionLifecycleForTests();
		env = setupTestEnvironment("pi-lens-3521-settle-");
		prevDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		resetObservedMutationNet();
		drainCalls.length = 0;
	});

	afterEach(async () => {
		if (prevDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = prevDataDir;
		resetObservedMutationNet();
		_resetSessionLifecycleForTests();
		env.cleanup();
		await cleanupTestEnvironmentsDrained("pi-lens-3521-settle-");
	});

	it("keeps the pre-move epoch when a /tree lands while the settled sweep awaits", async () => {
		const pi = createPiMock({ "no-lsp": true });
		extension(pi.asExtensionAPI());
		const ctx = makeCtx({ cwd: env.tmpDir, sessionId: "s-3521-settle" });
		await pi.emit("session_start", { reason: "startup" }, ctx);
		const filePath = path.join(env.tmpDir, "tracked.ts");
		fs.writeFileSync(filePath, "export const a = 1;\n");
		await pi.emit(
			"tool_call",
			{ toolName: "read", input: { path: filePath } },
			ctx,
		);

		const settled = pi.emit("agent_settled", {}, ctx);
		await pi.emit("session_tree", { newLeafId: "x", oldLeafId: "y" }, ctx);
		await settled;
		// A later settle with no move carries the epoch the /tree produced.
		await pi.emit("agent_settled", {}, ctx);

		expect(drainCalls).toEqual([
			{ readGuardBranchEpoch: 0 },
			{ readGuardBranchEpoch: 1 },
		]);
	});
});
