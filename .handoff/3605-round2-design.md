# #3605 round 2: design worked out by the paused fixer (not implemented)

- **Branch:** `wip/3605-wasm-trap-containment`, at `c5693ac91`.
- **Already done:** `origin/master` `327cc3a22` (#3610) is merged in.
- **Not yet checked:** the merged tree has not been built or tested.

The review behind this is in `.handoff/reviews/rv3605.md`.

## Status per finding

| Finding | What it covers | Status |
|---|---|---|
| F1 | Key traps by the input that caused them | Not started |
| F2 | Re-extract a file after a one-off trap | Not started |
| F3 | Make a contained trap visible at turn end | Not started |
| F4 | PR body corrections | Not started |

## F1: key traps by input (`clients/tree-sitter-client.ts`)

- **Key.** Report as `reportWasmAbort(thrown, input = this.activeWasmInput?.())`, where the input key is `sha256(languageId + "\0" + content)`.
  - Hash only when a trap happens, or when `trappedInputs.size > 0`, so the healthy path costs nothing.
  - `parseFileAndUse` sets `activeWasmInput` across its synchronous parse and consume region; there is no await after `getParser`.
  - The extractor's `queryMatches` report therefore carries the same key as the consume catch's report, and dedupe still counts one trap once.
- **Map.** Keep `trappedInputs: Map<key, count>`.
  - The first trap on an input spends one unit of budget and recycles the parser.
  - A repeat trap on the same input is charged to that input only: no budget, no recycle.
- **Pre-skip.** `parseFileAndUse` returns `NOT_PARSED` before parsing a charged input (count ≥ 2).
- **Bound.** Every new input spends budget, so the map holds at most `WASM_TRAP_BUDGET + 1` entries.
- **Queries.** `compileQuery` and `compileRawQuery` use the key `query\0lang\0source`, with the same pre-skip.
  - The batch sites and the extractor's compile do not repeat, so they get no key. A null batch is cached, and the extractor is memoized.
- **API.** Expose `wasmInputState(lang, content): "retry" | "charged" | undefined`.

## F2 and F3: builder state (`clients/review-graph/builder.ts`)

- **State.** Keep a per-cwd map of degraded files, each marked `retry` or `charged`. Bound the outer map.
- **Writer.** Only `addFileToGraph` writes the map. After extraction it sets or deletes the entry from `wasmInputState`.
  - For JS/TS files, read the content from `file.content` before the `finally` block deletes it.
- **`setWorkspaceGraph`.** Poison the stored signature and hash of `retry` files, and recompute `signature`. The in-memory exact hit then misses, and `tryIncrementalFromCache` re-extracts the file.
- **`persistGraph`.** Poison both `retry` and `charged` files, so a restart re-extracts them.
- **`buildReviewGraphCheckpointData`.** Poison the same way.
- **`trySeqFastpath`.** Add `retry` files to `changedSet`. A poisoned hash then makes them `trulyChanged`.
  - The fastpath's in-place no-change branch cannot overwrite the poison, because a poisoned hash always marks the file as changed.

## F3: turn-end visibility (`clients/dispatch/integration.ts`, around line 1360)

- Set `indeterminate: graph_degraded` when the cwd's degraded-file count is greater than 0.
- **Scope call:** possibly do the same when `isTreeSitterWasmAborted()` is true. The silence after a real abort predates this PR.
- Export the detail string once and reuse it in `pipeline.ts`.

## F4: PR body only

- There are four `extract(` callers, not five.
- The red-first base is `df5fb8abb`.
- Either add `"unreachable"` to `WASM_TRAP_MESSAGES` with a test row, or drop the cross-realm claim.
- Name the `extractCallbacks` catch in `module-report` as out of scope.

## Red-first tests

Build these from the reviewer's `rv3605/probes/zzprobe3605.test.ts`:

1. **Deterministic trap:** after five rounds of an input that always traps, tree-sitter is still available.
2. **One-off trap:** after a single trap, the second build still has `trap_here_fn`.
3. **Degraded dependency:** when `c.py` traps, `b.py`'s cascade is `indeterminate`.
4. **Restart:** a persisted graph re-extracts the degraded file after a restart.

## Then

1. Rebuild.
2. Re-pin the glossary from the sweep output, since #3610 touched those pins.
3. Rerun both mutation tables. The mutation script's targets need updating.
4. Run the targeted and governance suites, then lint.
5. Rewrite the PR body (`.handoff/pr-bodies/fix-3605.md`) with a round-2 section.
