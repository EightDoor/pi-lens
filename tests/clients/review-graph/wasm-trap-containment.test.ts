/**
 * #3605: a web-tree-sitter runtime trap while one file's symbols were being
 * extracted rejected the whole review-graph build (`build_failed`, reason
 * `table index is out of bounds`), and the per-edit cascade became
 * `cascade_indeterminate` / `error`. The trap is injected where production
 * raises it, `Query.prototype.matches` on the real web-tree-sitter module
 * (`queryMatches` in the symbol extractor), and the build is the real
 * `buildOrUpdateGraph` over real python files and real grammars.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDegradationSummary } from "../../../clients/degradation-ledger.js";
import { loadWebTreeSitter } from "../../../clients/deps/web-tree-sitter.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import { getOpenDocumentSymbols } from "../../../clients/lsp-document-symbols.js";
import {
	buildOrUpdateGraph,
	clearReviewGraphWorkspaceCache,
	flushReviewGraphPersistsForTests,
} from "../../../clients/review-graph/builder.js";
import { logReviewGraph } from "../../../clients/review-graph-logger.js";
import { getSharedTreeSitterClient } from "../../../clients/tree-sitter-shared.js";
import { createTempFile, setupTestEnvironment } from "../test-utils.js";

vi.mock("../../../clients/lsp-document-symbols.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../clients/lsp-document-symbols.js")
	>()),
	getOpenDocumentSymbols: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../../clients/review-graph-logger.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../clients/review-graph-logger.js")
	>()),
	logReviewGraph: vi.fn(),
	flushReviewGraphLogSync: vi.fn(),
}));

const { WebAssembly } = globalThis as unknown as {
	WebAssembly: { RuntimeError: new (message: string) => Error };
};

const cleanups: Array<() => void> = [];
afterEach(() => {
	vi.restoreAllMocks();
	flushReviewGraphPersistsForTests();
	clearReviewGraphWorkspaceCache();
	while (cleanups.length) cleanups.pop()?.();
});

function pythonProject(): { tmpDir: string; files: string[] } {
	const env = setupTestEnvironment("pi-lens-wasm-trap-");
	cleanups.push(env.cleanup);
	const files = [
		createTempFile(env.tmpDir, "a.py", "def alpha_fn():\n    return 1\n"),
		createTempFile(env.tmpDir, "b.py", "def trap_here_fn():\n    return 2\n"),
		createTempFile(env.tmpDir, "c.py", "def gamma_fn():\n    return 3\n"),
	];
	return { tmpDir: env.tmpDir, files };
}

function symbolNames(graph: Awaited<ReturnType<typeof buildOrUpdateGraph>>) {
	return [...graph.nodes.values()]
		.map((node) => node.symbolName)
		.filter((name): name is string => name !== undefined);
}

function wasmTrapCount(): number | undefined {
	return getDegradationSummary().find((group) => group.kind === "wasm-trap")
		?.count;
}

function buildFailedRows() {
	return vi
		.mocked(logReviewGraph)
		.mock.calls.map(([entry]) => entry)
		.filter((entry) => entry.phase === "build_failed");
}

describe("review-graph build contains a web-tree-sitter trap to its file (#3605)", () => {
	it("completes the build with the other files' symbols when one file's query traps", async () => {
		const { tmpDir, files } = pythonProject();
		const trappedBefore = wasmTrapCount() ?? 0;
		const { Query } = await loadWebTreeSitter();
		const realMatches = Query.prototype.matches;
		vi.spyOn(Query.prototype, "matches").mockImplementation(function (
			this: InstanceType<typeof Query>,
			...args: Parameters<typeof realMatches>
		) {
			if (args[0].text.includes("trap_here")) {
				throw new WebAssembly.RuntimeError("table index is out of bounds");
			}
			return realMatches.apply(this, args);
		});

		const graph = await buildOrUpdateGraph(tmpDir, files, new FactStore());

		const names = symbolNames(graph);
		expect(names).toContain("alpha_fn");
		expect(names).toContain("gamma_fn");
		expect(names).not.toContain("trap_here_fn");
		// The trapped file is NOT_PARSED-equivalent: zero tree-sitter symbols, so
		// the existing LSP fallback is consulted for it.
		expect(getOpenDocumentSymbols).toHaveBeenCalledWith(files[1]);
		// One trap, reported by both `queryMatches` and `parseFileAndUse`,
		// costs one unit of the budget.
		expect(wasmTrapCount()).toBe(trappedBefore + 1);
		expect(buildFailedRows()).toEqual([]);
	});

	it("classifies a trap that escapes to the build's catch as wasm-trap, not a build error", async () => {
		const { tmpDir, files } = pythonProject();
		const client = getSharedTreeSitterClient()!;
		// A trap from a path the per-file containment does not cover.
		vi.spyOn(client, "withParsedTree").mockRejectedValue(
			new WebAssembly.RuntimeError("memory access out of bounds"),
		);

		await expect(
			buildOrUpdateGraph(tmpDir, files, new FactStore()),
		).rejects.toThrow("memory access out of bounds");

		expect(buildFailedRows()).toEqual([
			expect.objectContaining({
				failureClass: "wasm-trap",
				reason: "memory access out of bounds",
			}),
		]);
	});

	it("classifies any other build rejection as error", async () => {
		const { tmpDir, files } = pythonProject();
		const client = getSharedTreeSitterClient()!;
		vi.spyOn(client, "withParsedTree").mockRejectedValue(
			new TypeError("extractor bug"),
		);

		await expect(
			buildOrUpdateGraph(tmpDir, files, new FactStore()),
		).rejects.toThrow("extractor bug");

		expect(buildFailedRows()).toEqual([
			expect.objectContaining({
				failureClass: "error",
				reason: "extractor bug",
			}),
		]);
	});
});
