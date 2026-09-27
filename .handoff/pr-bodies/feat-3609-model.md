## Why

Maintainers get one TLA+ model that checks the approved #3609 store design against pi's session transitions, and that pins today's session straddles as violations.

## Notes for the reviewer

- **The model found two design gaps (F1, F2), and one guard it cannot make red (F3).** They are in "Design findings" below, and in `formal/session-lifecycle/README.md`. The pass configs model the design **plus one amendment** (`forwardStale`). The design exactly as written is pinned by `DesignAsWritten` (pass, without `NoFalseBlock`) and by the four `DesignLateRead*` configs (violated `NoFalseBlock`).
- `formal/`-only. No runtime code changes. No changelog fragment: this is internal-only, and earlier model-only PRs (`1c2878f22`, `0ebbe7d5d`) shipped none.
- CI cost: 24 configs, 54.2 s serial (`--concurrency 1`, one TLC worker), which is about 14 s wall on the 4-vCPU pool.
- Merge order: none. No open PR touches `formal/session-lifecycle/`, and the branch merges cleanly onto `origin/master` `327cc3a22`.

## Change outline

```text
- scripts/check-tla-models.mjs (unchanged; discovers formal/*/*.cfg)
  + formal/session-lifecycle/SessionLifecycle.tla   (new module)
    + 24 *.cfg, each with a `\* expect:` / `\* module:` header
  + formal/session-lifecycle/README.md
```

## Summary

Slice S9 of the #3609 design (tracked as #3615): a new composition model at `formal/session-lifecycle/`.

**What it covers.**

- **Transitions.** `/new`, resume, `/fork`, `/clone`, a cancelled fork, `pi --fork`, `/tree`, `/reload` (with or without an entry-module re-evaluation), quit, the LSP idle reset, a duplicate start, and a concurrent subagent's start and stop.
- **Stores.** The read guard (reads and authorship; D5), turn counters, the widget's write-order guard, the LSP fleet and the registry entry.
- **Lineage fence.** A process-unique scope ticket plus a branch epoch.

Writers begin in a live scope and land at any later step. I1 and I2 allow exactly that, so the model hides nothing the host allows.

**Store policies are constants,** substituted per config:

- `formal/session-lifecycle/SessionLifecycle.tla:89` `TargetPolicy(s, r) ==`
- `formal/session-lifecycle/SessionLifecycle.tla:110` `TodayPolicy(s, r) ==`
- `formal/session-lifecycle/SessionLifecycle.tla:123` `TodayFence(s) == IF s = "RG" THEN "session" ELSE TargetFence(s)`
- `formal/session-lifecycle/SessionLifecycle.tla:130` `TodaySec(s) == "shared"`

The decisions are encoded as follows: D1 (per-scope cells), D2 (`entryCapture`), D3 (`handoffAtShutdown`), D5 (the read guard is `filter-by-branch` on `/reload`), D6 (lens toggles `reset` on every new activation), D7 (lazy-tool memory `none` on `/tree`), D8 (`filter-by-branch` on `/tree`). D4 is a stated residual: entries are unique in the model.

**The invariants** use the brief's names and map to the names in design section 6:

- `NoCrossSessionState` (section 6's `NoCrossScopeWrite`)
- `NoStaleBranchWrite` (`NoOffBranchFact`)
- `NoLostCarry`
- `NoFalseBlock` (new; it implies `NoLostCarry`)
- `NoOwnDrop` (new; shape 54)
- `SecondaryIsolation`
- `HandoffOnce`
- `OrderMonotone`
- `OneResetPerScope`

Each invariant is violated by at least one config. The conversation lineage the invariants check (`lin`) is per file and independent of the policy under test, so a `reset` policy cannot hide the loss it causes.

**The `Mut*` configs model today's code, or the code before a fix that has landed:**

| Config | Maps to |
|---|---|
| `MutSettleDuringTree`, `MutTreeCarries`, `MutForkClosureStash` | #3521 |
| `MutStalePipelineAfterNew` | #3596 |
| `MutLspAfterIdleReset` | #3576 |
| `MutTreeWipesSecondary` | #3607 |
| `MutReloadReset` | N1 |
| `MutSecondaryTurnStart` | N2 |
| `MutOrderTurnPerEval`, `MutWidgetDropAfterReEval` | N3 and #3540 |
| `MutHeartbeatBeforeRegistration` | the #3498/#3587 registry family (cross-references `formal/session-registry`) |
| `MutDuplicateStart` | #2890 |

**Acceptance.** Refs #3609 (the tracking issue; S9 is one slice of it) and #3615. The acceptance on #3615 is "every config's first-line verdict, checked by `scripts/check-tla-models.mjs`", and all 24 match locally. CI has not run yet: this branch has not been pushed.

### Design findings (for #3609)

**F1. A dropped late read is a false block.**

- The design drops any write whose handle is not current at the store's fence (design sections 3.2 and 3.4).
- The host lets a read-guard write stay in flight across `/tree` (I1, I2), `/reload` (I8, no abort), and across `/fork`, `/clone`, `/new` and resume, because a bounded handler is abandoned without being cancelled (I2).
- The live conversation often still holds that write's tool result.
- So the drop loses a read the conversation authorises, and the next edit of that file is a false block (`DesignLateReadTree`, `DesignLateReadReload`, `DesignLateReadFork` and `DesignLateReadResume`, each violating `NoFalseBlock`).
- `DesignAsWritten` passes every other invariant, `NoLostCarry` included.

The amendment `forwardStale` makes `Fix` pass:

- A stale read-guard write is re-filtered against every live descendant of the writer's scope, found through `parentScopeId`.
- It also joins a descendant's pending hand-off, or the sidecar of a descendant's file that no live scope serves.
- It needs the descendant *set*, not one successor pointer: after `/fork` and then a resume of the parent, one scope has two descendants.
- Otherwise the cost is one re-read per lost read, the same impact class as #3607.

`formal/session-lifecycle/SessionLifecycle.tla:609`

```text
          ELSE IF Has("forwardStale") /\ (liveT # {} \/ toSlot \/ sideT # {})
```

**F2. A subagent's `beginScope` can take the hand-off.**

- Section 3.4 has `beginScope` call `takeHandoff()` once, and section 3.5 has every secondary call `beginScope`.
- A subagent that binds between a primary's `session_shutdown` and its successor's `session_start` therefore takes the slot and discards it as unmatched.
- `/reload` has no sidecar fallback for `carry`, so it then loses every read.
- `MutSecondaryTakesHandoff` violates `HandoffOnce`. The fix is to role-gate the take:

`formal/session-lifecycle/SessionLifecycle.tla:473`

```text
       /\ slot' = IF ~Has("roleGatedHandoff") /\ slot.has /\ slot.takenBy = 0
```

Whether a subagent binds in that gap in practice has not been replayed [I].

**F3. The file match cannot be made red in-process under D3.** A scratch copy of the model with `match` reduced to `slot.has /\ slot.takenBy = 0` still passes `Fix`:

```text
Model checking completed. No error has been found.
167212 states generated, 91236 distinct states found, 0 states left on queue.
```

It stays as defence in depth, and for in-memory sessions.

**F4. Today, a subagent's read authorises the primary's edit** [I] (`MutSecondaryReadShared`). The design's `own` secondary policy removes this.

**Confirmed:**

- D3: `MutSnapshotAtBeforeFork` violates `NoLostCarry`.
- D5: `MutReloadReset` violates `NoLostCarry`.
- Master's shortest counterexample is N2 (`Current`, three states).

## Type of change

- [ ] Bug fix
- [x] New feature (net-new capability)
- [ ] Enhancement (improvement to existing capability)
- [ ] Documentation

## Area

- [ ] area:lsp
- [ ] area:dispatch
- [ ] area:installer
- [ ] area:diagnostics
- [x] area:read-guard
- [ ] area:project-intelligence
- [ ] area:perf
- [ ] area:observability
- [x] area:session
- [ ] area:config
- [ ] area:security
- [x] area:tests

## Checklist

- [x] I have read [CONTRIBUTING.md](../CONTRIBUTING.md) and [AGENTS.md](../AGENTS.md)
- [x] The change has tests (happy path, edge cases, regression test for bugs)
- [x] Targeted test files for the touched seams pass locally after `npm run build`; the full suite is CI's job.
- [x] Every NEW regression test is proven RED on pre-fix code; the red output is quoted in this PR
- [x] Every new guard/branch/filter is mutation-proof: deleting or neutering it reds at least one test
- [x] PR title carries the conventional prefix and the issue ref
- [x] `npm run lint` passes
- [ ] `npm run build:dist` succeeds if I changed code under `clients/`, `commands/`, `tools/`, or `index.ts`
- [x] `package-lock.json` is in sync with `package.json` (regenerate with the exact npm pin in `package.json`'s `packageManager` field)
- [ ] `AGENTS.md` is updated if this PR changes behavior, commands, conventions, or invariants documented there
- [ ] `.changelog/<branch-or-slug>-<short-desc>.md` has one valid entry **in this PR** for any user-facing change (Added/Changed/Deprecated/Removed/Fixed/Security) — see [.changelog/README.md](../.changelog/README.md); internal-only test/refactor PRs may skip it
- [x] Commit subject includes the issue number: `(closes #NNN)` or `(refs #NNN)`

Unticked boxes, and ticked ones that need explaining:

- `build:dist`: no code was touched.
- `AGENTS.md`: no behaviour or convention changes.
- Changelog: internal-only.
- `npm run lint` and the lockfile check ran in the pre-commit hook on both commits.
- The commit bodies carry `Refs #3609`.

## Tests

- **No vitest file is added or edited.** The "tests" are the 24 new `formal/session-lifecycle/*.cfg`. Each one's first line is its expected verdict, and `scripts/check-tla-models.mjs` checks them in CI.
- **Red proof.** Each `Mut*` config *is* a red run on today's code or on a named mechanism removed. The pass configs are the green.
- **Every mechanism reds when removed:**

  | Removed or changed | Config that reds |
  |---|---|
  | `entryCapture` | `MutStalePipelineAfterNew`, `MutLspAfterIdleReset`, `MutHeartbeatBeforeRegistration` |
  | `handoffAtShutdown` | `MutSnapshotAtBeforeFork` |
  | `roleGatedHandoff` | `MutSecondaryTakesHandoff` |
  | `processOrderTurn` | `MutOrderTurnPerEval`, `MutWidgetDropAfterReEval` |
  | `dedupe` | `MutDuplicateStart` |
  | `forwardStale` | `DesignLateRead*` |
  | `TodayFence` | `MutSettleDuringTree` |
  | `TodayPolicy` | `MutTreeCarries`, `MutForkClosureStash`, `MutReloadReset` |
  | `TodaySec` | `MutSecondaryTurnStart`, `MutTreeWipesSecondary`, `MutSecondaryReadShared` |

  The one guard that cannot be made red (the file match, F3) is reported, not asserted.

- **Counterexamples were read, not assumed.** Every violated config's trace was printed and checked against the intended interleaving; the README records each one's shortest trace. Two fidelity fixes came out of that:
  - the lineage the invariants check was first derived from the policy, so a `reset` hid its own loss;
  - widget writes now require a turn in the current activation.

The runner's serial output: `node scripts/check-tla-models.mjs --concurrency 1`, run from a scratch root holding only this directory and the pinned jar. It printed `ok` for all 24 configs, then:

```text
ok   formal/session-lifecycle/Fix.cfg: expected pass, got pass (8.6s)
ok   formal/session-lifecycle/MutSettleDuringTree.cfg: expected violated NoStaleBranchWrite, got violated NoStaleBranchWrite (1.5s)
ok   formal/session-lifecycle/MutStalePipelineAfterNew.cfg: expected violated NoCrossSessionState, got violated NoCrossSessionState (1.7s)
ok   formal/session-lifecycle/MutHeartbeatBeforeRegistration.cfg: expected violated NoCrossSessionState, got violated NoCrossSessionState (1.3s)
ok   formal/session-lifecycle/MutSecondaryTurnStart.cfg: expected violated SecondaryIsolation, got violated SecondaryIsolation (1.6s)
ok   formal/session-lifecycle/MutReloadReset.cfg: expected violated NoLostCarry, got violated NoLostCarry (1.3s)
ok   formal/session-lifecycle/MutOrderTurnPerEval.cfg: expected violated OrderMonotone, got violated OrderMonotone (1.3s)
24 configs, 54.2s wall (concurrency=1, 1 TLC worker/config).
```

The full table (states and seconds for all 24 configs) is in the README.

**Vitest.**

- `tests/scripts/check-tla-models.test.ts`: 30 passed. It includes "every config names its expectation and an existing module".
- All 78 `tests/config/*.test.ts` files: 77 passed, 1 failed. The failure is `tests/config/result-contract-governance.test.ts`, and it is environmental. The same three cases fail on `origin/master` `327cc3a22` in the same tree, where test setup cannot fetch the tree-sitter grammars:

```text
 FAIL  |default| tests/config/result-contract-governance.test.ts > result contract across registered tool surfaces > keeps every paired registry tool's real rendered text identical
 Test Files  1 failed (1)
      Tests  3 failed | 2 passed (5)
```

### Test assessment

- `formal/session-lifecycle/*.cfg`: new. Each pins one invariant under one policy or mechanism; none duplicates a sibling model's config.
- The sibling models keep the content-level truth. This model abstracts content to facts.
- No test file is edited, and no removal candidates.

## Blast radius

None at runtime: no production module is touched. The only consumer is the `TLA+ models` CI job, which gains 24 configs, about 54 s serial and about 14 s wall on its pool.

## Observability

No new failure path; no record added.

## Class sweep

**Class:** session-scoped state across pi session transitions: catalog shapes 17, 19 and 54, and the straddle family in #3609.

**Sweep:** `ls formal/` and `git log --all -- 'formal/session-lifecycle*'` (empty before this branch) show no existing composition model. The four sibling models (`read-guard`, `session-straddle`, `format-drain` and `session-registry`) each model one store or seam. This model composes them and cross-references them in its README rather than re-modelling their content.

**Population:** the stores in design section 4. Modelled:

- read guard
- turn counters
- widget write-order guards
- LSP fleet
- registry entry
- lens toggles and lazy-tool memory, as table rows only

Not modelled, with reasons in the README's Scope section: turn summary and test-runner delivery (N5), per-evaluation generation numbers (N4), and the ALS leak of D2.

**Consolidation verdict:** stays distributed. Content truth remains in the sibling models by design (section 6).

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01GpuMYnAosBztLRYHDcGN3W
