/**
 * #3605: the one classification seam for failures thrown out of
 * web-tree-sitter, and what a trap costs. A wasm runtime trap (`memory access
 * out of bounds`, `table index is out of bounds`, ...) used to classify as
 * nothing, so a trap during a query escaped `parseFileAndUse` and rejected the
 * whole review-graph build. Now a trap degrades its file to not-parsed,
 * recycles the parsers and the tree cache, and is counted; past
 * `WASM_TRAP_BUDGET` the next one poisons the process like an abort, because
 * web-tree-sitter keeps one wasm heap per process and only a restart resets
 * it. The build-level witness lives in
 * tests/clients/review-graph/wasm-trap-containment.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	classifyTreeSitterWasmError,
	TreeSitterClient,
	WASM_TRAP_BUDGET,
} from "../../clients/tree-sitter-client.js";
import { TreeSitterSymbolExtractor } from "../../clients/tree-sitter-symbol-extractor.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

const { WebAssembly } = globalThis as unknown as {
	WebAssembly: { RuntimeError: new (message: string) => Error };
};
const trap = (message = "table index is out of bounds") =>
	new WebAssembly.RuntimeError(message);

const cleanups: Array<() => void> = [];
beforeEach(() => resetDegradationLedger());
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
	resetDegradationLedger();
});

function pythonFile(): string {
	const env = setupTestEnvironment("pi-lens-wasm-trap-unit-");
	cleanups.push(env.cleanup);
	return createTempFile(env.tmpDir, "m.py", "def f():\n    return 1\n");
}

async function liveClient(onAbort = vi.fn()) {
	const client = new TreeSitterClient(false, onAbort);
	expect(await client.init()).toBe(true);
	return { client, onAbort };
}

function kindCount(kind: string): number | undefined {
	return getDegradationSummary().find((group) => group.kind === kind)?.count;
}

describe("classifyTreeSitterWasmError (#3605)", () => {
	it.each([
		["a RuntimeError trap", trap(), "trap"],
		[
			"a trap on a plain Error",
			new Error("memory access out of bounds"),
			"trap",
		],
		[
			"a signature-mismatch trap on a plain Error",
			new Error("null function or function signature mismatch"),
			"trap",
		],
		[
			"a RuntimeError the message list does not name",
			trap("divide by zero"),
			"trap",
		],
		[
			"an Emscripten abort, itself a RuntimeError",
			trap("Aborted(native code called abort()). Build with -sASSERTIONS"),
			"abort",
		],
		["a thrown abort string", "abort()", "abort"],
		["a JavaScript bug", new TypeError("x is not a function"), undefined],
	])("classifies %s", (_label, error, expected) => {
		expect(classifyTreeSitterWasmError(error)).toBe(expected);
	});
});

describe("TreeSitterClient trap containment and budget (#3605)", () => {
	it("degrades a trapped consume to not-parsed and recycles the parser and tree cache", async () => {
		const { client, onAbort } = await liveClient();
		const file = pythonFile();
		expect(
			(await client.withParsedTree(file, "python", undefined, () => 1)).parsed,
		).toBe(true);
		expect(client.getRuntimeStats().parsersLoaded).toBe(1);
		const invocationsBefore = client.getParseCacheStats().parserInvocations;

		const outcome = await client.withParsedTree(
			file,
			"python",
			undefined,
			() => {
				throw trap();
			},
		);

		expect(outcome).toEqual({ parsed: false });
		expect(kindCount("wasm-trap")).toBe(1);
		expect(onAbort).not.toHaveBeenCalled();
		// The cached tree was a hit for the trapped call; recycling drops it,
		// so the same unchanged file is parsed again, by a new parser.
		expect(client.getParseCacheStats().parserInvocations).toBe(
			invocationsBefore,
		);
		expect(client.getRuntimeStats().parsersLoaded).toBe(0);
		expect(
			(await client.withParsedTree(file, "python", undefined, () => 2)).parsed,
		).toBe(true);
		expect(client.getParseCacheStats().parserInvocations).toBe(
			invocationsBefore + 1,
		);
	});

	it("rethrows an error that is not a wasm failure", async () => {
		const { client } = await liveClient();
		const bug = new TypeError("extractor bug");

		await expect(
			client.withParsedTree(pythonFile(), "python", undefined, () => {
				throw bug;
			}),
		).rejects.toBe(bug);
		expect(kindCount("wasm-trap")).toBeUndefined();
	});

	it("poisons the runtime on the first trap past the budget, and not before", async () => {
		const { client, onAbort } = await liveClient();
		for (let i = 0; i < WASM_TRAP_BUDGET; i++) {
			expect(client.reportWasmAbort(trap())).toBe(false);
		}
		expect(onAbort).not.toHaveBeenCalled();
		expect(kindCount("wasm-trap")).toBe(WASM_TRAP_BUDGET);

		const escalating = trap("memory access out of bounds");
		expect(client.reportWasmAbort(escalating)).toBe(true);
		// A second site reporting the same trap still hears "runtime dead".
		expect(client.reportWasmAbort(escalating)).toBe(true);

		expect(onAbort).toHaveBeenCalledTimes(1);
		const abort = getDegradationSummary().find((g) => g.kind === "wasm-abort");
		expect(abort?.latestReasons[0]?.reason).toBe(
			`${WASM_TRAP_BUDGET} wasm traps absorbed, next one: memory access out of bounds`,
		);
		expect(
			(await client.withParsedTree(pythonFile(), "python", undefined, () => 1))
				.parsed,
		).toBe(false);
	});

	it("counts one trap once when two report sites see it", async () => {
		const { client } = await liveClient();
		const error = trap();

		expect(client.reportWasmAbort(error)).toBe(false);
		expect(client.reportWasmAbort(error)).toBe(false);

		expect(kindCount("wasm-trap")).toBe(1);
	});

	it("counts a trap thrown as a bare string without throwing", async () => {
		// A primitive cannot be remembered for dedupe; reporting it must still
		// be total, or the report itself escapes the caller's catch.
		const { client } = await liveClient();

		expect(client.reportWasmAbort("memory access out of bounds")).toBe(false);

		expect(kindCount("wasm-trap")).toBe(1);
	});

	it("keeps the budget across a session reset", async () => {
		// The heap outlives the session, so a session boundary must not re-arm
		// the budget: that would make the bound unbounded across sessions.
		const { client, onAbort } = await liveClient();
		for (let i = 0; i < WASM_TRAP_BUDGET; i++) client.reportWasmAbort(trap());

		client.resetLoadStateForSession();
		resetDegradationLedger();

		expect(client.reportWasmAbort(trap())).toBe(true);
		expect(onAbort).toHaveBeenCalledTimes(1);
	});

	it("lets the symbol extractor skip only the query whose compile trapped", async () => {
		// `compileQuery` rethrows when `reportWasmAbort` says the runtime is
		// dead, which makes the whole extractor fail and the review graph
		// memoize that for the process. A trap within the budget must cost
		// this one query, as it did before #3605.
		const client = new TreeSitterClient();
		const extractor = new TreeSitterSymbolExtractor("python", client);
		const compileQuery = (
			extractor as unknown as {
				compileQuery: (
					Query: new () => never,
					language: unknown,
					src: string,
					label: string,
				) => unknown;
			}
		).compileQuery.bind(extractor);
		class TrappingQuery {
			constructor() {
				throw trap();
			}
		}

		expect(compileQuery(TrappingQuery as never, {}, "(x)", "defs")).toBeNull();
		expect(kindCount("wasm-trap")).toBe(1);
	});
});
