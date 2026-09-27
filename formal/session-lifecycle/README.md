# Session lifecycle model

A TLA+ model of pi-lens' session-scoped stores across every pi session
transition. It is slice S9 of the #3609 design (one session-scoped state
store) and the composition layer over the sibling models: content-level truth
stays in `formal/read-guard`, `formal/session-straddle`, `formal/format-drain`
and `formal/session-registry`. Every config states its expected verdict on its
first line (see `formal/file-locks/README.md`), and the `TLA+ models` CI job
(`node scripts/check-tla-models.mjs`) checks them all.

The pass configs model the target design with the maintainer's decisions
D1-D8, plus one amendment this model found necessary (`forwardStale`, see
"Design findings"). The `Mut*` and `Current` configs model today's code, or
the code before a fix that has landed, and must violate.

## What the model covers

**Store content is abstracted to facts.** A fact `[e, o]` says "scope `o`
recorded something about the tool result at conversation entry `e`". The read
guard (`RG`: reads and authorship together) is the fact store. Beside it:

- the turn counter (`TC`);
- the widget's write-order guard (`WG`), which lives in a `clients/` module
  and so survives an entry-module re-evaluation;
- the LSP fleet (`LS`), fenced by the LSP service generation;
- the registry entry (`RE`) and its re-registration intent.

**Scopes.** Each activation gets a scope: a process-unique ticket with a role
(primary or secondary), a session file and a branch epoch (D1: cells are per
scope, not per entry-module evaluation). The module-level `runtime` is modelled
as `last`, the scope the most recent primary `session_start` served.

**Host transitions** (pi 0.85.1, design section 1.1):

| Transition | Modelled as |
|---|---|
| `/new`, resume, `/fork`, `/clone` | `session_before_fork` (fork and clone only), then `session_shutdown`, then the new activation's `session_start`. Shutdown and start are separate steps, so a writer can land between them. `/fork` copies the branch without its last entry; `/clone` copies all of it. |
| `/reload` | The same, on the same file. The start may re-evaluate the entry module (jiti fallback, design section 1.3), which restarts a per-evaluation order turn (N3). |
| cancelled fork | Another extension cancels after pi-lens' `session_before_fork` handler ran (I3). |
| quit, `pi --fork` | Quit ends the process, and in-flight work dies with it. `pi --fork` then starts a new process whose only channel is the parent's sidecar. |
| `/tree` | The same activation. The branch loses its last entry and the branch epoch bumps. |
| LSP idle reset | pi-lens' own timer. It resets the LSP service only. |
| secondary start/stop | An in-process subagent binds its own session while the primary is live (I6). It skips `handleSessionStart` (#473). |
| duplicate start | A second `session_start` for the same replacement (I5, #2890). |

**Writers.** Each writer begins once in a live scope and lands at any later
step. pi refuses `/tree` and `/reload` while streaming, but `agent_settled`
handlers run after the run is marked inactive (I1), and bounded handlers are
abandoned without being cancelled (I2). This over-approximation hides nothing
the host allows.

- `read`: a primary read-guard write. It stands for a `tool_result` handler's
  read record or `recordWritten` (#3596), and for the `agent_settled` drain's
  write (the G10 F1 race).
- `secRead`: the same in a subagent.
- `heartbeat`: the registry heartbeat's repair.
- `lsp`: LSP work that can spawn a server (#3576).
- `widget`: a pipeline verdict write to the widget in the current turn.

**Policies are constants** (design section 4). A config picks `TargetPolicy`
or `TodayPolicy`, `TargetFence` or `TodayFence`, and `TargetSec` or `TodaySec`.

| Store | startup | /new | resume | /fork, /clone, pi --fork | /tree | /reload | shutdown | idle | Secondary | Fence |
|---|---|---|---|---|---|---|---|---|---|---|
| `RG` target | rehydrate | reset | rehydrate | import-parent | filter-by-branch (D8) | filter-by-branch (D5) | none | none | own | branch |
| `RG` today | rehydrate | reset | rehydrate | reset | none | reset (N1) | none | none | shared (#3607) | session |
| `TC` | reset | reset | reset | reset | none | reset | none | none | own (today: shared, N2) | session |
| `WG` guards | reset | reset | reset | reset | carry | carry | none | none | shared | none |
| `LS` | none | none | none | none | none | none | reset | reset | shared | service |
| `LT` lens toggles | reset | reset | reset | reset | none | reset | none | none | shared | none |
| `LZ` lazy tools | rehydrate | reset | rehydrate | import-parent | none (D7) | carry | none | none | shared | none |

- `LT` follows D6, which was not approved: today's per-activation reset, on
  every transition that starts a new activation. `LT` and `LZ` carry no model
  state, because no invariant reads them; they are listed so that the table is
  whole.
- Today's `RG` fork and clone entries are `reset` in effect. The fork stash is
  an activation-closure `let` (`index.ts:1078`), and pi re-runs the factory on
  a fork, so the fork's new activation cannot see it.
- The target and today differ only in the `RG` row, the `TC` secondary
  policy, and the `RG` fence.

**`FixParts` selects the mechanisms:**

- `entryCapture` (D2): writers capture their lineage handle at hook entry.
  Without it, the handle is resolved when the write lands: from the
  module-level runtime, or, for the heartbeat, from the registry intent.
- `handoffAtShutdown` (D3): the hand-off slot is written at `session_shutdown`,
  with `targetSessionFile`. Without it, the slot is written at
  `session_before_fork`, as in the G10 design.
- `roleGatedHandoff`: only a primary `session_start` takes the slot.
- `processOrderTurn`: the write-order turn is a process counter (the design's
  `nextOrderTurn`). Without it, the turn is a field of each entry-module
  evaluation (G5's `_writeOrderTurn`).
- `dedupe`: the #2890 duplicate-start gate.
- `forwardStale`: the model's amendment. A read-guard write whose handle is no
  longer current is not dropped. Instead it is re-filtered against every live
  scope that descends from the writer's scope (the design's `parentScopeId`),
  and it joins a descendant's pending hand-off or unserved sidecar.

## Invariants

| Invariant | Meaning | Design section 6 name |
|---|---|---|
| `NoCrossSessionState` | A live scope's read-guard cell holds only its own facts and the facts it inherited. The registry entry holds only live roots. Every LSP server belongs to the current service generation. | `NoCrossScopeWrite` |
| `NoStaleBranchWrite` | A live scope's own-lineage facts name entries on its current branch. | `NoOffBranchFact` |
| `NoLostCarry` | Every fact that reached a cell in the live scope's conversation lineage, on an entry that conversation still holds, is in the cell the scope reads. | `NoLostCarry` |
| `NoFalseBlock` | The same, over every read-guard write that completed, whether it landed or a guard dropped it. It implies `NoLostCarry`. | (new) |
| `NoOwnDrop` | No guard drops a write whose own lineage is still current (catalog shape 54). | (new) |
| `SecondaryIsolation` | A primary transition never removes a live subagent's own facts, and a subagent's turn never moves the primary's turn. | `SecondaryIsolation` |
| `HandoffOnce` | The slot is consumed at most once, and only by the primary start that replaced the scope that wrote it. | `HandoffOnce` |
| `OrderMonotone` | A write-order token drawn later outranks every earlier one, across `/reload` and entry-module evaluations. | `OrderMonotone` |
| `OneResetPerScope` | One `session_start` mutation pass per scope. | `OneResetPerScope` |

The conversation lineage the invariants check is per file (`lin`), and
`/fork`, `/clone` and `pi --fork` copy it. It is the truth, and it is
independent of the policy under test, so a `reset` policy cannot hide the loss
it causes.

## Results

TLC 2.19 (`tla2tools.jar` v1.7.4). Every config ran through
`node scripts/check-tla-models.mjs --concurrency 1` with one TLC worker, on a
4-core machine at load average 23. The 24 configs took 54.2 s serial in total.
A violated config stops at its first counterexample.

| Config | Models | Expect | States | Seconds |
|---|---|---|---|---|
| `Fix` | target: every transition, a primary and a subagent reader, one turn | pass | 91236 | 8.6 |
| `FixProcess` | target: heartbeat and LSP work across `/new`, resume, `/reload`, idle reset, quit, `pi --fork` | pass | 24771 | 3.0 |
| `FixOrder` | target: widget tokens over three turns across `/new`, `/reload`, quit, `pi --fork` | pass | 319 | 1.5 |
| `DesignAsWritten` | the design as written (no `forwardStale`); every invariant except `NoFalseBlock` | pass | 72231 | 10.2 |
| `DesignLateReadTree` | design finding F1 on `/tree` | violated `NoFalseBlock` | 11 | 1.3 |
| `DesignLateReadReload` | F1 on `/reload` | violated `NoFalseBlock` | 20 | 1.3 |
| `DesignLateReadFork` | F1 on `/fork` | violated `NoFalseBlock` | 23 | 1.7 |
| `DesignLateReadResume` | F1 on `/new`, then resume | violated `NoFalseBlock` | 42 | 1.6 |
| `MutSettleDuringTree` | G10 F1: the drain writer races `/tree`, fenced at session level only | violated `NoStaleBranchWrite` | 12 | 1.5 |
| `MutTreeCarries` | master: no `session_tree` handler | violated `NoStaleBranchWrite` | 14 | 1.3 |
| `MutForkClosureStash` | master: the fork stash is per activation | violated `NoLostCarry` | 25 | 1.4 |
| `MutStalePipelineAfterNew` | a stale pipeline writes after `/new` | violated `NoCrossSessionState` | 18 | 1.7 |
| `MutLspAfterIdleReset` | LSP work spawns after the idle reset | violated `NoCrossSessionState` | 8 | 1.3 |
| `MutHeartbeatBeforeRegistration` | a heartbeat lands before the new registration | violated `NoCrossSessionState` | 10 | 1.3 |
| `MutSecondaryTurnStart` | a subagent's `turn_start` advances the primary's turn | violated `SecondaryIsolation` | 5 | 1.6 |
| `MutTreeWipesSecondary` | the primary's `/tree` filters the subagent's reads | violated `SecondaryIsolation` | 9 | 1.3 |
| `MutSecondaryReadShared` | a subagent's read lands in the primary's read guard | violated `NoCrossSessionState` | 4 | 1.7 |
| `MutReloadReset` | `/reload` resets the read guard | violated `NoLostCarry` | 22 | 1.3 |
| `MutOrderTurnPerEval` | a re-evaluation restarts the order turn | violated `OrderMonotone` | 19 | 1.3 |
| `MutWidgetDropAfterReEval` | the same; the widget guard drops the live verdict | violated `NoOwnDrop` | 70 | 1.3 |
| `MutSnapshotAtBeforeFork` | the G10 slot is filled at `session_before_fork` | violated `NoLostCarry` | 29 | 1.7 |
| `MutSecondaryTakesHandoff` | a subagent's start takes the slot | violated `HandoffOnce` | 7 | 1.9 |
| `MutDuplicateStart` | no #2890 gate | violated `OneResetPerScope` | 2 | 1.4 |
| `Current` | master: today's tables, no capture for the #3596 writers, per-evaluation order turn | violated `SecondaryIsolation` | 55 | 3.0 |

## Mut configs and their issues

| Config | Issue | Today's code | Shortest counterexample |
|---|---|---|---|
| `MutSettleDuringTree` | #3521 (the G10 F1 review race) | G5's handles fence at session level; no branch epoch | A read of entry 2 begins, `/tree` drops entry 2, and the read lands. |
| `MutTreeCarries` | #3521, tree half | master registers no `session_tree` handler | A read of entry 2 lands, then `/tree` drops entry 2 and the read stays. |
| `MutForkClosureStash` | #3521 fork half; the #3589 shape | `pendingForkSnapshot` and `pendingForkReadGuard` are closure `let`s (`index.ts:1078-1082`) | A read lands, then `/fork`: the fork starts clean. |
| `MutStalePipelineAfterNew` | #3596; also the #3528 drain shape | the remaining `handleToolResult` writers resolve the session when they land | A read begins, `/new` completes, and the read lands in session 2. |
| `MutLspAfterIdleReset` | #3576 (fixed by #3602; this is the pre-fix shape) | before G5's `captureLspServiceGeneration` | LSP work begins, the idle reset runs, and the work spawns a server. |
| `MutHeartbeatBeforeRegistration` | #3498 (fixed) and #3587, the registry family | the pre-#3498 heartbeat; the lock-level detail is `formal/session-registry` (`StaleIntent`, `Replacement*`) | A heartbeat begins, session 1 shuts down, and the heartbeat re-registers session 1's root from the intent before session 2's registration lands. |
| `MutSecondaryTurnStart` | N2 | `onTurnStart` calls `runtime.beginTurn()` with no role gate (`index.ts:2817-2829`) | The subagent starts, and its `turn_start` moves the primary's turn. |
| `MutTreeWipesSecondary` | #3607 | the subagent shares `runtime.readGuard` | The subagent's read lands, and the primary's `/tree` filters it away. |
| `MutReloadReset` | N1, under D5 | `resetForSession` on every primary start (`clients/runtime-session.ts:2463`); reload imports nothing | A read lands, and `/reload` starts clean. |
| `MutOrderTurnPerEval` | N3; #3540 case A | `_writeOrderTurn` is a coordinator field (`clients/runtime-coordinator.ts:446`) | A turn draws token 1, `/reload` re-evaluates the entry, and the next turn draws token 1 again. |
| `MutWidgetDropAfterReEval` | N3's harm; #3540 | as above | Two turns, and a widget write at token 2. After `/reload` with re-evaluation, a turn draws token 1, and the widget guard drops the live session's own write as older. |
| `MutSnapshotAtBeforeFork` | D3 check | the G10 design | `session_before_fork` fills the slot, a read lands, then shutdown and start: the fork lacks the read. |
| `MutSecondaryTakesHandoff` | design finding F2 | (design) | `/reload`'s shutdown fills the slot, and a subagent's `session_start` takes it. |
| `MutDuplicateStart` | #2890 (fixed; guard mutant) | | A duplicate start re-runs the reset. |
| `Current` | today's first counterexample | all of the above | N2, in three states. |

Before #3583 and #3602 merged, the same shape as `MutStalePipelineAfterNew`
also covered the `agent_settled` drain's writes after `/new` (#3528, #3576).

## Design findings

**F1. A dropped late read is a false block.** The design's `store.write` drops
a write whose handle is not current at the store's fence (design section 3.2),
and `retireScope` drops a retired scope's late writes (section 3.4). The host
lets a read-guard write stay in flight across all of these:

- `/tree`, through I1 and I2;
- `/reload`, which does not abort (I8);
- `/fork`, `/clone`, `/new` and resume, because a bounded `tool_result` handler
  is abandoned, not cancelled (I2).

The live conversation often still holds that write's tool result:

- the entry is still on the branch after `/tree`;
- `/reload` does not change the conversation;
- a `/fork` point after the entry keeps it;
- resuming the same session file brings it back.

Dropping the write loses a read that the conversation authorises, so the next
edit of that file is a false block (`DesignLateRead*`). `DesignAsWritten`
shows that the design holds every other invariant, including `NoLostCarry`:
nothing that had landed before the snapshot is lost. The design's own note on
the `/reload` row ("the filter is a no-op except for records made in flight")
reads as if in-flight records would be filtered, not dropped.

The amendment `forwardStale` makes `Fix` pass. A stale read-guard write is
re-filtered against every live descendant of its scope, not dropped. It uses
`parentScopeId`, set on every adoption: the slot's `fromScopeId`, or the
sidecar envelope's `scopeTicket` on a rehydrate. The write also joins a
descendant's pending hand-off, or the sidecar of a descendant's file that no
live scope serves.

A single successor pointer is not enough. After `/fork` and then a resume of
the parent, one scope has two descendants, the fork and the resumed parent,
and the late read belongs to both.

The cost of not amending is one re-read per lost read, the same impact class
as #3607. Stores whose action on the transition is `reset` are not affected:
they have no descendant to forward to.

**F2. A subagent's `beginScope` can take the hand-off.** Section 3.4 has
`beginScope` call `takeHandoff()` once, and section 3.5 has every secondary
call `beginScope`. A subagent that binds between a primary's
`session_shutdown` and its successor's `session_start` (I6, during the
replacement's async gap) takes the slot and discards it as unmatched.
`/reload`, whose `carry` has no sidecar fallback, then loses every read. The
fix is to role-gate the take (`roleGatedHandoff`). Whether a subagent binds in
that gap in practice has not been replayed [I].

**F3. The file match is redundant in-process under D3.** With the slot written
at `session_shutdown` and the take role-gated, every primary start directly
follows its predecessor's retire. A probe copy of the model with the match
reduced to `slot.has /\ slot.takenBy = 0` still passes `Fix` (91236 states).
The match stays useful as defence in depth, and for in-memory sessions, which
have no files; the model has no config that can make it red.

**F4. Today, a subagent's read authorises the primary's edit** [I]. The shared
read guard puts a subagent's read in the primary's cell
(`MutSecondaryReadShared`), so the primary may edit a file it never read. The
design's `own` secondary policy for the read guard removes this.

**Confirmations.**

- D3: `MutSnapshotAtBeforeFork` violates `NoLostCarry`. A read that lands
  between `session_before_fork` and `session_shutdown` is missing from a slot
  filled at `session_before_fork`.
- D5: `MutReloadReset` violates `NoLostCarry`. Carrying authorship on
  `/reload` is required, not merely safe.

## Scope

Not modelled:

- **Content.** Staleness, FileTime, hashes and ranges are covered by
  `formal/read-guard`; the quiet window's tasks by `formal/session-straddle`;
  the drain by `formal/format-drain`; the registry lock and tail by
  `formal/session-registry`.
- **N4** (per-evaluation generation numbers). Scope ids here are tickets, so
  two evaluations never share one.
- **N5** (the turn summary and test-runner delivery after `/tree`), and #3603
  (authorship on `/tree`: G10 resets it, and the table keeps that).
- **The ALS hazard of D2.** A long-lived resource that inherits a stale
  ambient handle (design section 3.3, item 5) is not modelled.
- **D4** (tool-call id reuse across branches). Entries are unique here.
- **Time**, the cwd-changing resume's re-evaluation, the MCP host, and more
  than one subagent.
