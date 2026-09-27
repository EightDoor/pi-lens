# #3609: one session-scoped state store: design

Investigator: G25. Base: `origin/master` at `7101a6766`. In-flight refs read:
G5 `origin/fix/3576-session-straddle` (head `4b5bce0d2`) and G10 `fix/3521-fork-tree`
(head `4b3708832`). Host: `@earendil-works/pi-coding-agent` 0.85.1 in
`/home/user/pi-lens/node_modules` (abbreviated `pi/` below; paths are under `dist/`).
This is a design only. No source was edited.

Evidence tags: **[V]** means verified by reading the code at the cited line or by the
loader probe in §1.3. **[I]** means inferred and not replayed. **[G5]** and **[G10]**
mean the fact holds on that branch, not on master.

---

## 0. Verdict and what is new

**Root cause.** pi re-runs the pi-lens extension factory on every session transition
except `/tree` [V, §1]. So one *activation* (one factory closure) serves exactly one
session, and that activation is the natural unit of session state. pi-lens keeps
nearly all session state *above* the activation, though:

- the module-level `runtime` (`index.ts:570`), which the file says is deliberate
  (`index.ts:571-578`);
- `clients/` module maps;
- process singletons.

Each such store then decides its own transition behaviour, and late writers from the
dead activation reach the live one. Three state residences behave differently per
transition (§1.3), and nothing in the code names which residence a store lives in.
Every G2/G5/G10/G18/G21 defect is one of three things:

- a store at the wrong residence;
- a writer without a lineage capture;
- a transition that has no policy for the store.

**The design, in one paragraph.** Each activation gets a `SessionScope`, a process-unique
ticket held in a process-singleton registry. The scope carries a branch epoch, which
`/tree` bumps. Session state is declared once with `defineSessionStore(spec)`, and the
spec gives three things:

- a per-transition action: `reset`, `carry`, `filter-by-branch`, `import-parent`,
  `rehydrate` or `none`;
- a secondary policy: `own`, `shared` or `primary-only`;
- a fence: `session`, `branch` or `none`.

Cells live in the registry, not at module scope, so a module re-evaluation cannot fork
them. Writers get a `LineageHandle` at hook entry. The handle is a `GenerationHandle`,
so the existing `guardedWrite` sites keep working. Transitions run in one engine that
is called at four host seams: `session_start`, `session_tree`, `session_shutdown` and
the secondary start and stop. The fork hand-off generalises G10's slot. It snapshots
at `session_shutdown`, where pi passes `targetSessionFile`, and the successor adopts the
snapshot by file match. Sidecar-backed stores share one versioned envelope in
`clients/session-state-store.ts`. The existing `tests/support/session-state-registry.ts`
sweep is extended into the governance ratchet.

**Newly found. None of these is replayed on the real runtime unless it is marked [V].**

| # | Finding | Evidence | Severity (proposed) |
|---|---|---|---|
| N1 | `/reload` empties the read guard. `handleSessionStart` runs `runtime.resetForSession()` for every primary `session_start` reason, reload included (`clients/runtime-session.ts:2463`, `runtime-coordinator.ts:545` `_readGuard = null`). Reload maps to `keep` (`session-state-store.ts:58`), which imports nothing (`index.ts:2556-2557`). G10 keeps this ("reload does not load its own sidecar", G10 `index.ts` session_start comment). The conversation is unchanged after a reload, so every read in it is lost: a `NoFalseBlock` violation. | [V] code path; [I] no real-runtime replay | p2 |
| N2 | A concurrent secondary's `turn_start` advances the **primary's** turn. `onTurnStart` calls `runtime.beginTurn()` with no role gate (`index.ts:2817-2829`). `beginTurn` clears `_actionableWarningsThisTurn`, `_codeQualityWarningsThisTurn`, `_reportedThisTurn`, `_writtenThisTurn` and `_autofixDemotedThisTurn`, and resets `_writeIndex` (`runtime-coordinator.ts:667-712`). A subagent turn in the middle of a primary turn therefore wipes the primary's per-turn maps and restarts its write tokens. #999 (closed) guarded only `turn_end`. | [V] code; [I] not replayed | p2 |
| N3 | Module residence is not the same for all state. When a cache miss makes the loader re-import the entry module (`/reload`, or a cwd change, per `loader.js:118-129` and `resource-loader.js:264-266`), a **fresh** `index.ts` module (`runtime`, `cacheManager`, the bridge latches) is evaluated. `clients/` modules that import natively stay shared (probe, §1.3). Consequences: the `keep` policy on reload keeps the widget (a `clients` module) but not the coordinator. G5's "never restarts" `_writeOrderTurn` is a coordinator field (G5 `runtime-coordinator.ts:446`), so it restarts at 0 after such a reload while the widget's write guards keep their turn-N tokens. That brings back #3540 comment case A. This depends on whether jiti's native import of pi-lens fails in production, which `AGENTS.md:667-670` says it does. | [V] probe on pi's loader; [I] production residence | p2 (G5 follow-up) |
| N4 | Session generations are **per-evaluation counters**. `createGenerationSource("runtime-session")` is a field of each `RuntimeCoordinator` (`runtime-coordinator.ts:384-385`), and each counter starts at 0. The process-singleton observed-mutation net stores and compares the plain number (`observed-mutation.ts:267`, `:1012`; armed at `runtime-tool-call.ts:646`). Two evaluations can hold equal numbers. | [V] code; [I] impact (needs a toolCallId collision) | p3 |
| N5 | Quiet-window deliveries after `/tree` land on the new branch. The turn summary is sent from the `agent_settled` quiet window (`index.ts:3480-3485`), which can still be running when `/tree` is accepted (§1.4, I1). The summary describes a run on the abandoned branch. The same holds for the test-runner delivery. | [I] | p3 |
| N6 | The `/lens-toggle`, `/lens-context-toggle` and `/lens-widget-toggle` states ("for the current session") are activation-closure `let`s (`index.ts:1011`, `:1070-1071`, flipped at `:1186`, `:1201`, `:1241`). They reset on `/fork`, `/clone`, `/reload` and resume, and carry across `/tree`. A disabled pi-lens silently comes back after `/reload`. | [V] code | p3 (policy decision D6) |
| N7 | `sessionWorstRealBlockMs` and `sessionSuspectedStalls` are printed as "(session)" and "this session" (`index.ts:1437-1446`) but are never reset. They are evaluation-lifetime values. | [V] | p3 cosmetic |
| N8 | **#3604's premise does not hold for an in-process `/fork`.** `rememberedLazyToolsBySessionFile` is a `clients/` module map (`tool-set-policy.ts:21`), not closure state, and the fork's `session_start` explicitly calls `inheritRememberedLazyTools(previousSessionFile, sessionFile)` (`index.ts:2323`). The map survives the factory re-run (probe: dependency modules evaluate once). The real residuals: it is never persisted, so a process restart and `pi --fork` lose it; it is inert for in-memory sessions (no session file); and `/tree` or `/fork before` keep activations whose `pi_lens_activate_tools` result is off-branch. | [V] code and probe; [I] no real-runtime witness | re-scope #3604 |

**Known and still open (new instances are mapped in §2):** #3521 [G10], #3540, #3559,
#3568 and #3576 [G5], #3587, #3589, #3596, #3603, #3607, #3581.
**Known and fixed:** #3498 (PR #3593), #3512 (PR #3571), #3528 (PR #3583).

**The brief names `formal/session-lifecycle`, which does not exist** on master, G5 or G10:
`git log --all -- 'formal/session-lifecycle*'` is empty. The #3498 lifecycle model
landed as `formal/session-registry/`. §6 proposes creating `formal/session-lifecycle/`
as the composition layer over `session-straddle`, `read-guard`, `format-drain` and
`session-registry`.

---

## 1. Host contract (pi 0.85.1)

### 1.1 Transition table

"Factory re-run" means pi calls the extension's default export again, which gives a new
closure (`activateExtension`). "Module re-eval" means the `index.ts` module body is
evaluated again (§1.3).

| Transition | Event order pi emits (old runner, then new) | Factory re-run | Module re-eval (entry) | ctx / sessionManager at the new `session_start` |
|---|---|---|---|---|
| `/new` | 1. `session_before_switch{reason:"new"}` (cancellable; `agent-session-runtime.js:148`, `:78-89`).<br>2. `teardownCurrent`: `abort()`, which calls `waitForIdle` (`agent-session.js:1222-1233`).<br>3. `session_shutdown{reason:"new", targetSessionFile}` (`agent-session-runtime.js:102-113`).<br>4. `beforeSessionInvalidate`, then `dispose()`, which invalidates the old ctx (`agent-session.js:584-599`).<br>5. `createRuntime`, then `createAgentSessionServices`, then `resourceLoader.reload` (`agent-session-services.js:63-69`).<br>6. `rebindSession`, then `bindExtensions`, then `session_start{reason:"new", previousSessionFile}` (`agent-session-runtime.js:120-126`, `agent-session.js:1906-1927`), then `resources_discover`. | yes [V] | only if the cached cwd changed [V, §1.3] | a fresh `SessionManager`. `getSessionId`/`getSessionFile` return the new ones; `getHeader().parentSession` is set only when `newSession({parentSession})` was used (`agent-session-runtime.js:157-159`). |
| resume (`/resume`, `switchSession`, `importFromJsonl`) | 1. `session_before_switch{reason:"resume", targetSessionFile}`.<br>2. Teardown as for `/new`, with `session_shutdown{reason:"resume", targetSessionFile}`.<br>3. `createRuntime` with **the resumed session's cwd** (`agent-session-runtime.js:128-146`, `:258-295`).<br>4. `session_start{reason:"resume", previousSessionFile}`. | yes [V] | yes when the resumed cwd ≠ the cached cwd (`loader.js:123-129`) [V] | the opened file. `getBranch()` is the persisted leaf path; ids are as stored. |
| launch `pi --session <id>` / `pi` | `session_start{reason:"startup"}` (the default, `agent-session.js:152`) | first run | first evaluation | the persisted session, if any |
| `/fork` (position `before`, the default) | 1. `session_before_fork{entryId, position}` (cancellable; `agent-session-runtime.js:90-101`, `:176-179`).<br>2. Persisted: `SessionManager.open(cur).createBranchedSession(parentOf(entry))` writes a new file whose header has `parentSession = cur` (`agent-session-runtime.js:219-223`, `session-manager.js:1093-1130`).<br>3. `teardownCurrent("fork", newFile)`, then `createRuntime`.<br>4. `session_start{reason:"fork", previousSessionFile}` (`:224-232`).<br>Forking at the first message goes through `newSession({parentSession})` instead (`:203-214`). In memory, the **same** SessionManager is torn down first and then mutated in place (`:234-249`), and its header `parentSession` is `undefined` (`session-manager.js` `createBranchedSession`, `persist ? previous : undefined`). | yes [V] | as `/new` | the new file. `getBranch()` holds the entries up to the fork point, with **the same entry ids and tool-call ids** (the entries are copied). The fork selector offers user messages from every branch (#3521 investigation, `agent-session.js:2636-2650 `getUserMessagesForForking``). |
| `/clone` | `interactive-mode.js:4338-4345` calls `fork(leafId, {position:"at"})`, which is the same sequence with the whole current branch | yes | as `/new` | a full branch copy |
| `pi --fork <path>` | New process: `main.js:271` calls `SessionManager.forkFrom(src, cwd, dir)` (`session-manager.js:1264-1300`), then `session_start{reason:"startup"}` | first run | first evaluation | the header has `parentSession = src path`; entries are copied with their ids. **No in-memory hand-off is possible.** |
| `/tree` | 1. Refused if `isStreaming` (`agent-session.js:2472-2474`).<br>2. `session_before_tree{preparation, signal}` (cancellable, `:2510-2533`).<br>3. An optional branch summary, which is an LLM call.<br>4. `branch()`/`branchWithSummary()`/`resetLeaf()`, and `agent.state.messages` is rebuilt (`:2586-2616`).<br>5. `session_tree{newLeafId, oldLeafId, summaryEntry, fromExtension}` (`:2618-2624`). | **no** [V] | no | the same live ctx. `getBranch()` is the new leaf path; `getEntries()` still holds every branch (`session-manager.js:958-968`, `:995`). |
| `/reload` | 1. Interactive refuses while `isStreaming`/`isCompacting` (`interactive-mode.js:4974-4981`).<br>2. `session_shutdown{reason:"reload"}` (no `targetSessionFile`), then `oldRunner.invalidate()`.<br>3. `resourceLoader.reload()` calls `clearExtensionCache()` (`resource-loader.js:264-266`).<br>4. `_buildRuntime` builds a new `ExtensionRunner` and the factory re-runs.<br>5. `session_start{reason:"reload"}` (`agent-session.js:2217-2239`).<br>**No `abort()`/`waitForIdle`.** | yes [V] | **yes**, when jiti's native import of the entry fails (§1.3) | the **same** `AgentSession`, SessionManager, session id and branch |
| quit / shutdown | `AgentSessionRuntime.dispose()`: `session_shutdown{reason:"quit"}`, then invalidate (`agent-session-runtime.js:296-303`). Replacement shutdowns carry `targetSessionFile`; `reload` and `quit` do not. | no | no | stale after invalidate (`runner.js:396-399`; the ctx getters call `assertActive`, `runner.js:503-530`) |
| LSP idle reset | **Not a host event.** pi-lens arms its own timer (`runtime-turn.ts:485-492`) that calls `resetLSPService({reason:"idle"})` (`index.ts:3321-3324`). It does not bump the session generation (#3576). G5 adds a service-generation retire (`captureLspServiceGeneration`, G5 `lsp/server.ts:528-537`). | n/a | n/a | n/a |
| concurrent secondary (subagent) | A third-party runner builds a `DefaultResourceLoader` and an `AgentSession` in the **same process** and calls `bindExtensions()`, which emits `session_start{reason:"startup"}` while the primary is live (`docs/subagent-compat.md` contracts 2a/2b/3; `agent-session.js:1926`). pi-lens classifies it with `decideSessionStart`, and the secondary skips `handleSessionStart` (`index.ts:2180-2233`). Its later `turn_start`/`tool_call`/`tool_result`/`turn_end` go through the **same module state** as the primary's when the module is shared. | yes (a new runner) [V] | yes if its cwd ≠ the cached cwd; this also clears the cache for the primary's next load (`loader.js:125-126`) [V] | its own SessionManager |

### 1.2 Event delivery semantics

- `ExtensionRunner.emit` awaits every handler in order (`runner.js:623-650`). A
  `session_before_*` result carrying `cancel` from **any** extension stops the
  transition after pi-lens's handler has already run (`runner.js:632-637`).
- The ctx getters (`sessionManager`, `cwd`, `ui`) throw once the runner is invalidated
  (`runner.js:503-530`, `:396-399`). A late writer therefore cannot read the old
  session's branch after teardown.
- `session_before_fork` has a 0 ms may-not-await budget in pi-lens
  (`clients/hook-budgets.ts:90-91`, #2523). `session_shutdown` also has 0 ms (`:86-87`).
- The ids pi-lens can use: `getSessionId()` (`session-manager.js:733`),
  `getSessionFile()` (`:736`), `getLeafId()` (`:898`), `getEntry(id)` (`:904`),
  `getBranch(fromId?)` (`:958`, root to leaf, all entry types), `getEntries()` (`:995`),
  `getTree()` (`:1003`), `getHeader()` (`:986`: `{id, parentSession, cwd}`) and
  `isPersisted()` (`:721`). **No event carries a tool-call id.** A branch's tool-call
  ids come from `toolResult` message entries (G10 `read-guard-branch.ts`
  `branchToolResultIds`).

### 1.3 Module residence: the loader probe [V]

pi caches one factory per cwd (`loader.js:115-129`, `:404-434`) and re-imports with
`jiti({moduleCache:false})` (`loader.js:416-417`) on a cache miss. I drove pi 0.85.1's
own `loadExtensionsCached`/`clearExtensionCache` against scratch extensions
(`scratchpad/design-3609/probe-ext/run.mjs`, `run2.mjs`; `PI_LENS_HOME` pinned; nothing
in pi-lens touched):

```text
ext.js (natively importable):
load2 same cwd (new/fork/clone/same-cwd resume) {"extEvals":1,"depEvals":1,"factoryRuns":2,"distinctDepMaps":1}
load5 after clearExtensionCache (/reload)       {"extEvals":1,"depEvals":1,"factoryRuns":5,"distinctDepMaps":1}
ext2.js (a host static import that fails natively -> jiti transpile fallback):
load2 same cwd                                   {"extEvals":1,"depEvals":1,"factoryRuns":2,"distinctDepMaps":1}
load3 other cwd (cwd-changing resume, subagent)  {"extEvals":2,"depEvals":1,"factoryRuns":3,"distinctDepMaps":1}
load5 after clearExtensionCache (/reload)        {"extEvals":4,"depEvals":1,"factoryRuns":5,"distinctDepMaps":1}
```

So there are four residences, and their lifetimes differ:

| Residence | Example | Survives factory re-run | Survives entry re-eval | Survives process |
|---|---|---|---|---|
| R1 activation closure | `pendingForkSnapshot` (`index.ts:1078`) | no | no | no |
| R2 entry module (`index.ts`) | `runtime` (`index.ts:570`) | yes | **no** when the fallback path is taken [I for production] | no |
| R3 `clients/` module | widget `files` (`widget-state.ts:302`) | yes | yes (dependencies evaluate once) [V probe]; **no** across distinct source and dist graphs (`process-singletons.ts:6-9`) | no |
| R4 process singleton | `session-lifecycle.ts:62` | yes | yes | no |
| R5 sidecar | `sessions/<id>.json` (`session-state-store.ts:68`) | yes | yes | yes |

Whether pi-lens's own entry takes the fallback path in production is **not verified**.
`AGENTS.md:667-670` asserts it does. The measurement that settles it: add
`evaluationOrdinal` and a coordinator instance id to the proposed
`session_scope_transition` record (§3.6), then count distinct coordinator ids per pid
across a `/reload`.

### 1.4 Interleavings pi allows

| Id | Interleaving | Why pi allows it | Bugs from it |
|---|---|---|---|
| I1 | `agent_settled` handlers still running after the run is marked inactive | `_emitAgentSettled` sets `_isAgentRunActive=false` **before** it awaits the handlers (`agent-session.js:347-355`). `isStreaming`/`isIdle` read that flag (`:616-622`), so `/tree` (`:2472`), `/reload` (`interactive-mode.js:4975`) and `abort()`/`waitForIdle` (`:1222-1233`, used by `/new`, resume and fork teardown) all go ahead. | #3528 (fixed), #3576, the G10 F1 drain/sweep race, N5 |
| I2 | A pi-lens-bounded handler is abandoned but keeps running | pi-lens wraps handlers in `bounded()` (`session-event-guard.ts:295-307`). pi's teardown aborts only the active run (`agent-session.js:1222-1226`). | #3568, #3596, #3559 |
| I3 | A `session_before_fork`/`_switch`/`_tree` handler runs and then another extension cancels | `runner.js:632-637` | an orphan fork stash. G10 matches the slot on the parent file. |
| I4 | Detached work holds an invalidated ctx | `dispose` calls `invalidate` (`agent-session.js:595`) | #1039, #2990 (closed); the stale-ctx guard (`session-event-guard.ts:254-265`) |
| I5 | A duplicate `session_start` for one replacement | RPC awaits `rebindSession` twice (#2890) | gated per activation (`index.ts:1842`, `:2071-2092`) |
| I6 | A secondary `session_start` and its turns interleave with the primary's | in-process subagent binds (§1.1) | #3607, N2, #999 |
| I7 | The old activation's timers or quiet window run after the new activation's `session_start` | there is no cancellation on teardown | #3499, #3512 (fixed) |
| I8 | `/reload` with no abort | `agent-session.js:2217-2239` | none known; it widens I1 |
| I9 | A heartbeat or queued registration after shutdown (registry) | async registry tail | #3498 (fixed), #3587 |
| I10 | A subagent in another cwd clears the process-global loader cache, so the primary's next same-cwd `/new` re-imports the entry | `loader.js:123-129` | N3 amplification [I] |

---

## 2. Inventory

### 2.1 How the population was enumerated

The scans ran over `clients/**/*.ts` (tests excluded), `mcp/**/*.ts` and `index.ts` on
`origin/master`. Their outputs are in `scratchpad/design-3609/scan-*.txt`.

| Scan | Pattern | Hits |
|---|---|---|
| module-level `let` | `^(export )?let ` | 212 |
| module-level containers | `^(export )?const X = new Ctor` | 307 |
| process singletons | `getProcessSingleton\s*[<(]` (callers) | 15 sites (14 families) |
| generation sources and captures | `createGenerationSource\|createGenerationMap\|captureSessionGeneration\|isCurrentSession` | 72 lines: 11 sources, 60 capture/check sites (51 in `runtime-session.ts`) |
| session resets | `resetForSession(` | 1 call (`runtime-session.ts:2463`) |
| sidecar and log writers | `writeFileAtomic*\|saveSessionState\|fs.*writeFile*\|appendFile*` | 80 lines |
| closure state | one-tab `let` in `activateExtension` (`index.ts:729-4040`) | 12 |
| coordinator fields | `RuntimeCoordinator` private and public fields (`runtime-coordinator.ts:383-508`) | 46 |

I then cross-checked against the existing mechanical registry:

- `tests/support/session-state-registry.ts` has 70 entries (`SESSION_STATE_REGISTRY`
  at `:238`, policies `session_start` / `turn_end` / `process_lifetime`) and an
  exemption list (`:1315`);
- `SESSION_STATE_SYMBOL_COUNTS` (`:1463`) has about 120 pinned files;
- the scanner is `tests/support/session-state-scan.ts:692`.

**Triage.** A hit is session-scoped when its content describes this conversation, this
session's turns, or a session-lifetime verdict. Frozen lookups, env or host memos and
per-cwd caches with their own invalidation were triaged by module and are not listed
one by one. **The limits of this triage** (after `SWEEP_HEURISTIC_LIMITS`,
`session-state-scan.ts:666`):

- instance fields on classes other than `RuntimeCoordinator` and `ReadGuard` were read
  by owner, not scanned (for example `CacheManager`, `LSPService`);
- state held in factory closures inside `clients/` is not scanned;
- the ~60 availability latches are handled as one class (row H), because the registry
  already proves their reset.

### 2.2 The rows

Status codes:

- **OK**: correct.
- **K#n**: known bug, with its issue.
- **N#**: newly found (§0).
- **G5/G10**: fixed on that branch, not on master.

Transition columns: N=`/new`, R=resume, F=`/fork`, C=`/clone`, T=`/tree`, L=`/reload`,
Q=shutdown, I=idle reset, S=secondary.

#### A. `RuntimeCoordinator` (residence R2; one per `index.ts` evaluation, `index.ts:570`)

| # | Store | file:line | Current behaviour per transition | Status |
|---|---|---|---|---|
| A1 | `_sessionGeneration` | `runtime-coordinator.ts:384-385`, bump `:511`, capture `:1048-1053` | Bumped only at a primary `session_start` (all reasons). Q and I do not bump it. T has nothing. S is not bumped (by design, #473). The counter is per evaluation. | K#3576 (Q/I, G5 adds an LSP retire); N4 |
| A2 | `_readGuard` → `ReadGuard` (`reads`, `edits`, `writtenThisSession`, `unchangedThisSession`, `pendingCreations`, `fileTime`, `exemptions`; `read-guard.ts:563-583`) | `runtime-coordinator.ts:456`, `:545`, getter `:1743-1746` | N: reset. R: reset, then rehydrate own sidecar (`index.ts:2588-2590`). F/C: reset, and the closure stash is dead → **no import** (K#3521; G10 import-parent + branch filter). T: no handler → stale reads kept (K#3521; G10 `retainBranch`). L: reset, not rehydrated (**N1**). S: shared object; the secondary's writes land in the primary's guard; a G10 primary `/tree` drops the secondary's records (K#3607). Late writers: the drain is fixed (#3528); `recordWritten` in `handleToolResult` is open (K#3596 D). | K#3521, K#3596, K#3603, K#3607, N1 |
| A3 | Turn counters `_turnIndex`, `_writeIndex`, `_turnStartProjectSeq` | `runtime-coordinator.ts:433-444`, `beginTurn` `:667-712` | Reset at every primary start. `beginTurn` runs on **every** activation's `turn_start` (`index.ts:2829`). | N2 |
| A3' | `_writeOrderTurn` (G5) | G5 `runtime-coordinator.ts:446`, `:723` | Never reset "so `/reload` keeps order", but it lives in R2 | N3 [G5] |
| A4 | Seq view: `_projectSeq`, `_fileSeq`, `_fileLastProjectSeq`, `_viewMissingThrough`, `_viewLogEntries`, `_mutationReceipts` | `:410-450` | Reset at start, then seeded from the change log (the duplicated `handleSessionStart` blocks, K#3581). A late `recordProjectChange` from `handleToolResult` lands in the next session (K#3596). The drain is fixed (#3528). | K#3596, K#3581 |
| A5 | Per-turn maps: `_fixedThisTurn`, `_writtenThisTurn`, `_autofixDemotedThisTurn`, `_reportedThisTurn`, `_actionableWarningsThisTurn`, `_codeQualityWarningsThisTurn` | `:404-409`, `:490-497` | Cleared at `beginTurn` and at reset. Warnings are guarded on G5 (K#3568 item 1). `fixedThisTurn` is handed to autofix (K#3576). S: cleared by the secondary's `turn_start` (N2). | K#3568/#3576 [G5]; N2 |
| A6 | `_pendingInlineBlockers`, `_inlineBlockerWriteOrder` | `:476-489` | Session-scoped, reset at start. Its order tokens compared across turns (K#3540, K#3559) [G5]. T: carry, which is correct because blockers describe disk. | [G5], then N3 |
| A7 | Cascade: `_cascadeRuns`, `_pendingCascadeRuns`, `_turnEndCascadeSettleStarts`, `_cascadeSessionStats` | `:391-402` | Reset at start; the admission and strays are guarded (#3499, #3512 fixed; `formal/session-straddle`) | OK |
| A8 | `_pendingDeferredMutations` | `:457-459` | Owner-tagged by stable session id (#791); the drain claims its own; fenced (#3528) | OK |
| A9 | `_toolCallAttributions`, `_readWidenings`, `_lspReadWarmState` | `:460-475` | Reset at start; keyed by tool-call id. T: carry (ids are stable) | OK |
| A10 | `_turnSummary` | `:503` | Per run; consumed at the quiet window | N5 |
| A11 | `partialApplyRecords` | `:508` | Reset at start. T: carry (content-keyed, describes disk) [I OK] | OK [I] |
| A12 | Identity: `_telemetrySessionId`, `_hasStableSessionId`, `_lifecycleReason`, telemetry model | `:416-432` | New random id at reset, then the stable id pinned (`index.ts:2505-2508`) | OK |
| A13 | `_gitGuardHasBlockers`, `_gitGuardSummary`, `_gitGuardCacheUnknownReason` | `:451-453` | Reset at start; a late write lands in the next session (K#3596) | K#3596 |
| A14 | Project caches: `_complexityBaselines`, `_pipelineCrashCounts`, `_cachedExports`, `_startupScansInFlight`, `wordIndex`; **not reset**: `callGraph`, `_errorDebtBaseline`, `_projectRulesScan`, `_projectRoot`, `_nextCascadeSettleToken` | `:383-455`, `:510-518` | These are project-scoped, not conversation-scoped. Policy `process` or `reset`. | OK (declare) |

#### B. Activation closure (R1, `index.ts` `activateExtension`)

| # | Store | file:line | Behaviour | Status |
|---|---|---|---|---|
| B1 | `pendingForkSnapshot` | `index.ts:1078`, set `:2646`, read `:2522-2530` | Dies on the fork's factory re-run, so the fork widget starts clean | K#3589 |
| B2 | `pendingForkReadGuard` | `index.ts:1082` | Dead the same way. G10 deletes it and uses the process slot. | K#3521 [G10] |
| B3 | `lastSessionStartIdentity` | `index.ts:1842` | Per activation: the duplicate-start gate (#2890) | OK |
| B4 | `ownedSessionRole`, `ownEventCtx`, `renderInvalidator`, `mountedLensWidgetUi`, `widgetMountFailureLogged` | `index.ts:748-779`, `:1072-1073` | Per activation, and correct: they describe the activation | OK |
| B5 | `lensEnabled`, `contextInjectionEnabled`, `lensWidgetVisible` | `index.ts:1011`, `:1070-1071` | Reset on every factory re-run; carried across T | N6 |
| B6 | `enabledLazyTools` | `index.ts:1812` | Derived from config at activation | OK |

#### C. Entry module (R2, `index.ts`)

| # | Store | file:line | Behaviour | Status |
|---|---|---|---|---|
| C1 | `latestEventCtx` | `index.ts:410`, `:415` | Last ctx of **any** activation (the documented H2 hazard, `index.ts:811-819`) | OK as a boot fallback only |
| C2 | Bridge latches and emit holders: `_readBridgeRegistered`, `_bridgeGetFlag`, `_mutationBridgeRegistered`, `_turnSummaryEmitRegistered`, `_turnSummaryEmitCtx`, `_testRunnerDeliveryRegistered` | `index.ts:586-628` | Once per evaluation. They resolve module `runtime` through getters. | OK, but they must resolve the **current scope** after migration |
| C3 | `cacheManager` → `turn-state.json` | `index.ts:579`; `cache-manager.ts:108`, `:433-440` | Project sidecar, owner-checked (`getTurnStateAccess`, `cache-manager.ts:443`). `addModifiedRange` from a late `handleToolResult` is open (K#3596). | K#3596 |
| C4 | `sessionWorstRealBlockMs`, `sessionSuspectedStalls`, `lastLoggedLoopWorstMs` | `index.ts:389-397` | Never reset | N7 |

#### D. `clients/` module state (R3)

| # | Store | file:line | Behaviour | Status |
|---|---|---|---|---|
| D1 | Widget: `files`, `diagnosticsWriteGuard`, `runnerWriteGuard`, `lspServers`, `sessionLanguages`, `renderedDependencyDriftFiles` | `widget-state.ts:302-349`, `:549`; `clearWidgetState` `:551-560` | N: clean. R: rehydrate own sidecar with the disk-staleness drop. F/C: clean (K#3589). T: carry (correct; widget diagnostics describe disk). L: keep. S: shared. Ordering tokens: K#3540 [G5]. | K#3589; [G5] then N3 |
| D2 | `rememberedLazyToolsBySessionFile` | `tool-set-policy.ts:21` | Keyed by session file. F inherits (`index.ts:2323`); fresh starts clear (`:2326`). Not persisted; the secondary is below the #473 gate. | N8 (re-scopes K#3604) |
| D3 | Pending runner findings `pending` | `dispatch/pending-runner-findings.ts:22` | Reset at start (`runtime-session.ts:2363`); a late push is K#3568 item 2 [G5 guards the push] | [G5] |
| D4 | `changeLogCursors` | `project-changes.ts:87` | Per log path, bounded; describes the file | OK (process) |
| D5 | FileTime `globalState` (reads keyed by the guard's session id) | `file-time.ts:30` | `clearAllSessions` at every primary start (`runtime-session.ts:2326`), which also clears a live secondary's stamps [I] | subsumed by A2 |
| D6 | `deferredThisSession` | `diagnostic-dispositions.ts:136` | Reset at start (registry) | OK |
| D7 | `_touched` (nudge accumulator) | `agent-nudge.ts:101` | Spans runs by design (registry exemption) | OK |
| D8 | Test-runner `pending` | `test-runner-delivery.ts:34` | Reset at primary start; delivered at settle | N5 [I] |
| D9 | Dispatch session caches: `sessionFacts`, `sessionSlopRuleCounts`, `sessionSlop*`, `cascadeSessionStats`, `cascadeTurnScope`, `primaryFilesThisTurn`, `recentlyCleanNeighborCache` | `dispatch/integration.ts:195`, `:254-256`, `:533`, `:567`, `:593-594` | Reset via `resetDispatchBaselines` (`:507`) | OK |
| D10 | `inFlightPipelines`, `lastAnalyzedStateByFile`, `debouncedPipelines` | `runtime-tool-result.ts:334`, `:337`, `:495` | `debouncedPipelines` drops the entry capture (K#3596 G) | K#3596 |
| D11 | `_outstandingTouches` | `lsp/cascade-tier.ts:189` | Reset at start; strays fenced (#3512) | OK |
| D12 | Quiet window `_inProgress`, task registry | `quiet-window.ts:116`, `:217` | One per evaluation | OK |
| D13 | Deferred LSP work | `deferred-lsp-work.ts:31-32` | Aborted by `resetLSPService` | OK |
| D14 | Latency: `sessionRecordId`, `sessionRecordSeq`, `oncePerSessionPhases`, `liveBrackets` | `latency-logger.ts:268`, `:668`, `:691-698` | Reset behind the #473 gate (`index.ts:2245-2268`) | OK |
| D15 | `lastStableSessionId`, `previousSessionId` | `message-end-attribution.ts:3-4` | Two-slot rotation (registry) | OK |
| D16 | `turnCounts` keyed by turn index | `bounded-telemetry.ts:258-260` | Reset at start; secondary turns collide (N2) | N2 |

#### E. Process singletons (R4)

| # | Family | file:line | Behaviour | Status |
|---|---|---|---|---|
| E1 | Primary registration | `session-lifecycle.ts:62` | Registered at start, released at Q | OK |
| E2 | Instance registry: entries, tail, registration epoch | `instance-registry.ts:694`, `:725`, `:749-752` | Epoch plus retry (#3498 fixed); `deregisterInstanceRoot` own-hold is open (K#3587) | K#3587 |
| E3 | Observed-mutation net | `observed-mutation.ts:335` | Reset at primary start; compares per-evaluation generation numbers | N4 |
| E4 | Mutation attribution | `mutation-attribution.ts:151` | Reset, then re-primed from disk | OK |
| E5 | Turn context: an ALS keyed by session id | `turn-context.ts:13` | Keyed by id, so correct by construction | OK (the precedent) |
| E6 | LSP service, server, client, sweep hold | `lsp/index.ts:10505`, `lsp/server.ts:1848`, `lsp/client.ts:1300`, `lsp/workspace-sweep-hold.ts:63` | `resetLSPService` at start, Q and I; a late `getLSPService()` spawns (K#3576; G5 adds `peekLSPService` plus the service generation) | [G5] |
| E7 | Telemetry: startup timing, bind rollups, path attribution, event-loop hold | `startup-timing.ts:49`, `session-start-observability.ts:34`, `path-attribution-telemetry.ts:20`, `event-loop-hold.ts:87` | Process- or primary-scoped | OK |
| E8 | Fork hand-off slot (G10) | G10 `read-guard-branch.ts` (`FORK_HANDOFF_FAMILY`) | Set at `session_before_fork`, taken at every primary start | [G10] |

#### F. Sidecars (R5)

| # | Sidecar | Writer | Keyed by | Status |
|---|---|---|---|---|
| F1 | `sessions/<id>.json` `{version:1, widget, readGuard?}` | `session-state-store.ts:77-106`; written at `turn_end` (`index.ts:3337`), at fork start (`:2543`), and [G10] at `session_before_fork` | stable session id | Not written at `/tree`, reload or Q [I: it is written at `turn_end` only] |
| F2 | `turn-state.json` | `cache-manager.ts:433-440` | project, with an owner field | K#3596 |
| F3 | Change log | `project-changes.ts:327`, `:387` | project | OK |
| F4 | Actionable and code-quality warning history | `actionable-warnings.ts:1952`, `code-quality-warnings.ts:356` | project, append-only | OK (history) |
| F5 | Mutation attribution | `mutation-attribution.ts:421` | project | OK |
| F6 | `recent-touches.json`, `instances.json` | `recent-touches.ts:118`; `instance-registry.ts:328`, `:356` | machine | OK / K#3587 |
| F7 | Worklog | `fix-worklog.ts:93` | project | OK |

#### G. Generation sources

`runtime-session` (A1); `lsp-launch-availability` (`lsp/server.ts:520`, the G5 LSP retire
signal); `dispatch-availability` (`runner-helpers.ts:581`); `toolchain-availability`
(`toolchain-availability.ts:93`); `formatter-cache` (`formatters.ts:1813`);
`package-manager` (`package-manager.ts:412`); `tool-cwd` and its log map
(`tool-cwd.ts:123-124`); `workspace-diagnostics-cache` (a map,
`workspace-diagnostics-cache.ts:257`); `installer-pep668-log` (`installer/index.ts:5728`);
`instance-registry-registration` (`instance-registry.ts:752`).

Two epochs are hand-rolled outside `generation-guard.ts`: G10's `ReadGuard.branchEpoch`
and G5's `_writeOrderTurn`. Both are session lineage and belong to the scope.

#### H. The availability-latch class

About 60 registry entries are reset in the `handleSessionStart` block
(`runtime-session.ts:2321-2463`), for example `resetDispatchAvailabilityState`,
`clearFormatterCache` and `resetInstallRetryLatches`. Their policy is uniform and
correct: reset at the primary start (every reason, reload included), `none` on T, and
shared with secondaries. They stay registry entries and do not become stores (§3.1).

---

## 3. Store API proposal

The new module is `clients/session-scope.ts`. `session-state-store.ts` is taken: it is
the sidecar module, and it stays as the persistence backend.

### 3.1 What is a store

A store is **conversation- or session-scoped state whose correct value depends on which
session, branch or activation is live**. Availability latches (§2 H), frozen lookups and
project caches with their own invalidation stay in the `SESSION_STATE_REGISTRY` with
`policy: "session_start" | "process_lifetime"`. They get one new column there:
`scope: "store" | "latch" | "process"` (§3.7).

### 3.2 Declaration and policy vocabulary

```ts
// clients/session-scope.ts
export type Transition =
  | "startup" | "new" | "resume" | "fork" | "clone" | "reload" | "tree"
  | "shutdown" | "idle-reset" | "secondary-start" | "secondary-shutdown";

export type Action =
  | "reset"            // fresh cell from create()
  | "carry"            // successor adopts the predecessor's cell (snapshot at shutdown)
  | "filter-by-branch" // carry or keep, then spec.filter(cell, branch)
  | "import-parent"    // cell from the parent's hand-off (slot → parent sidecar), then filter
  | "rehydrate"        // cell from this session's own sidecar, then filter
  | "none";            // this transition does not touch the store

export type SecondaryPolicy =
  | "own"          // each activation (primary or secondary) has its own cell
  | "shared"       // one cell per process; any live scope may write
  | "primary-only"; // secondaries read the primary's cell; their writes drop (recorded)

export type Fence = "session" | "branch" | "none";

export interface BranchView {
  readable: boolean;                    // false: stale ctx or a host without getBranch
  toolResultIds: ReadonlySet<string>;   // G10 branchToolResultIds, sanitized
  leafId: string | null;
}

export interface SessionStoreSpec<T, P = never> {
  name: string;                // ledger subject prefix; unique; appears in the sweep
  version: number;             // cell shape version (getProcessSingleton adopt rule)
  create(): T;
  policy: Readonly<Record<Transition, Action>>;
  secondary: SecondaryPolicy;
  fence: Fence;
  filter?(cell: T, branch: BranchView): { kept: number; dropped: number };
  snapshot?(cell: T): P;       // sync, bounded: runs in 0 ms hooks
  restore?(payload: P, branch: BranchView): T;
  persist?: { version: number; on: "turn_end" | "settled" | "shutdown" };
  reason: string;              // one sentence, as the registry requires
  issues?: readonly number[];
}

export interface SessionStore<T> {
  readonly name: string;
  /** The cell of `scope`, or of the ambient scope (§3.3). Reads are never fenced. */
  read(scope?: ScopeRef): T;
  /** The only mutation path. Drops, with one bounded record, when `h` is not current at the store's fence. */
  write<R>(h: LineageHandle, subject: string, fn: (cell: T) => R): R | undefined;
}

export function defineSessionStore<T, P = never>(spec: SessionStoreSpec<T, P>): SessionStore<T>;
export function listSessionStores(): readonly SessionStoreSpec<unknown, unknown>[]; // for the sweep
```

`defineSessionStore` works like `createGenerationSource` (`generation-guard.ts:215-230`):
a store exists only by being declared, which is what the sweep enumerates.

### 3.3 Scopes and the lineage handle

```ts
export interface ScopeRef { readonly scopeId: number }

export interface SessionScope extends ScopeRef {
  readonly role: "primary" | "secondary";
  readonly reason: Transition;
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly parentScopeId?: number;   // predecessor (carry) or fork parent
  readonly evaluationOrdinal: number; // PI_LENS_EVALUATION_ORDINAL (startup-timing.ts:62)
  branchEpoch(): number;
  isLive(): boolean;
  capture(): LineageHandle;
}

/** A GenerationHandle, so the existing guardedWrite call sites accept it unchanged. */
export interface LineageHandle extends GenerationHandle {
  readonly scopeId: number;
  readonly branchEpoch: number;
  /** "session": the scope is live. "branch": the scope is live and no /tree since capture. */
  isCurrent(level?: Fence): boolean;
  atBranch(): GenerationHandle; // same handle, fenced at branch level
}

// Engine: called only from the host seams in index.ts (and mcp/session.ts).
export function beginScope(a: {
  role: "primary" | "secondary"; reason: Transition;
  sessionId?: string; sessionFile?: string; previousSessionFile?: string;
  parentSessionFile?: string; branch: BranchView;
  loadSidecar(id: string): Promise<PersistedSessionStateV2 | undefined>;
}): Promise<SessionScope>;                                    // session_start
export function moveBranch(s: SessionScope, b: BranchView): void;   // session_tree
export function retireScope(s: SessionScope, a: {
  reason: string | undefined; targetSessionFile?: string;
}): void;                                                     // session_shutdown (sync, 0 ms)
export function currentLineage(): LineageHandle | undefined;  // ambient (ALS)
export function runWithLineage<T>(h: LineageHandle, fn: () => T): T;
export function nextOrderTurn(): number;                      // process-monotonic (replaces G5 _writeOrderTurn)
```

**The registry.** One process-singleton family, `session-scope.registry` v1 (reusing
`getProcessSingleton`):

```ts
{ nextTicket: number; scopes: Map<number, ScopeRecord>; primary?: number;
  handoff?: Handoff; orderTurn: number }
```

Scope ids are tickets drawn from one counter, like `createGenerationMap`
(`generation-guard.ts:278-295`). No two evaluations can hold the same id, which closes N4.

**The capture discipline.**

1. The activation closure holds `let scope: SessionScope | undefined`. It is set once by
   `beginScope` in `session_start`. Activation equals session (§1.1), so the closure
   never needs to re-point it. The duplicate start (I5) is already gated before this
   point.
2. `guardSessionEvent` (`session-event-guard.ts:289`) already wraps every handler in an
   ALS (`runWithTurnContext`). It gains an option, `scope: () => SessionScope | undefined`,
   and runs the handler inside `runWithLineage(scope.capture(), ...)`. The capture
   happens **at hook entry, before the handler's first await**, for every wrapped hook.
   This is G5's discipline, made structural. The unwrapped `tool_call` registration
   (`index.ts:2659`) must be wrapped; the governance sweep checks this.
3. `store.write(h, ...)` requires a handle. The two legal sources are the explicit
   `scope.capture()` and `currentLineage()`. **A fenced store write with neither is a
   recorded drop**, not a silent pass (catalog shape 54 is covered by the no-drop tests
   in each slice).
4. `RuntimeCoordinator.captureSessionGeneration()` and `isCurrentSession()`
   (`runtime-coordinator.ts:1040-1053`) become adapters over `currentLineage()` /
   `scope.capture()`. The ~60 existing capture sites, and `guardedWrite` consumers such
   as `appendCascadePromise`, `deferRunnerFindings` [G5] and the drain's `session`, work
   unchanged.
5. Long-lived process resources (LSP clients, watchers, timers of process scope) are
   created under `lineage.exit()` (`AsyncLocalStorage.exit`), so their callbacks carry
   no stale ambient handle. Stores those callbacks write, such as the widget, are
   `fence: "none"`. This is the one real hazard of the ALS choice (decision D2).

### 3.4 The fork hand-off channel (generalising G10's slot)

G10 set the slot at `session_before_fork` from a live export. This design moves the
snapshot to **`session_shutdown`**, for three reasons:

- pi passes `targetSessionFile` there on every replacement
  (`agent-session-runtime.js:106-110`), so the successor can be matched exactly:
  `handoff.targetSessionFile === successor.sessionFile`, and
  `handoff.sessionFile === event.previousSessionFile`;
- a fork that a later extension cancels (I3) never reaches shutdown, so there is no
  orphan slot;
- the snapshot is taken after pi's `abort()`, so it includes the aborted turn's last
  tool results, which pi persists into the outgoing file (`agent-session-runtime.js:103-105`).

```ts
interface Handoff {
  fromScopeId: number; reason: string | undefined;
  sessionFile?: string; targetSessionFile?: string;
  takenAt: number;
  snapshots: Record<string /* store name */, { version: number; payload: unknown }>;
}
```

- **`retireScope` (0 ms, sync).**
  1. For each store where some successor action is `carry`, `filter-by-branch` or
     `import-parent`, call `spec.snapshot(cell)`, which must be sync and bounded, and
     put the result in `registry.handoff` (one slot, replaced).
  2. Fire and forget `saveSessionState` for `persist`-backed stores. This is the
     fallback, and the only channel for `pi --fork` and for crash-resume.
  3. Mark the scope retired. Its cells stay reachable **only** by holders of its handles.
     Late writers therefore write into a dead scope, and fenced stores drop and count.
- **`beginScope` (session_start).** `takeHandoff()` once:
  - if the reason, previous file and target file match, the source is `slot`;
  - otherwise, when the header has `parentSession`, the parent sidecar
    (`readSessionHeaderId`, G10);
  - otherwise, for `rehydrate`, the own sidecar;
  - otherwise nothing.

  Each store's action then runs, and `filter(cell, branch)` runs where the action is
  `filter-by-branch`, `import-parent` or `rehydrate`. An unmatched slot is discarded with
  one `session-scope-handoff-unmatched` degradation.
- **In-memory sessions** have no files. The match falls back to "the slot was taken in
  this process by the immediately preceding primary retire" (the same rule as G10's
  undefined-equals-undefined).
- **Carry versus the live cell.** `carry` restores from the snapshot and never adopts the
  predecessor's live object. A late writer holding the old object then cannot reach the
  successor. This is what makes `/reload` carry safe (N1).

Where G10's D2 decision stands: the process slot is primary and the fire-and-forget
sidecar is the fallback, both unchanged. Only the moment of capture moves, which is
decision D3.

### 3.5 Subagents (concurrent secondaries)

- Each secondary activation calls `beginScope({role:"secondary"})`. The `#473` decline
  stays: no `handleSessionStart` and no shared resets.
- `own` stores get a fresh cell per secondary scope. The candidates are: read guard
  (A2, closes #3607 by construction), turn counters and per-turn maps (A3, A5, closes
  N2), inline blockers (A6), turn summary (A10) and `bounded-telemetry` turn counts (D16).
- `shared` stores take writes from any live scope: widget (D1), LSP (E6) and the
  change-log seq view (A4, a project fact).
- `primary-only`: tool-set policy (D2; `index.ts:2302-2306` already argues this),
  sidecar persistence, the registry root and the cascade quiet window.
- A primary transition runs only over the primary's own cells and the shared ones. A
  primary `/tree` never touches a secondary's `own` cells (#3607 AC1). The reverse probe
  (a primary record whose tool result never reached the tree must not survive) is the
  `filter` itself, unchanged from G10.
- A secondary's `session_shutdown` retires its scope. Its `own` cells are dropped, with
  no hand-off.

### 3.6 Persistence for sidecar-backed stores

`clients/session-state-store.ts` gains a v2 envelope. It reads v1 and never writes it.

```ts
interface PersistedSessionStateV2 {
  version: 2; sessionId: string; savedAt: number;
  scopeTicket: number;          // writer's scopeId: a stale scope must not overwrite a newer save
  parentSessionId?: string;
  stores: Record<string, { version: number; payload: unknown }>;
}
// v1 {widget, readGuard} maps to stores["widget"], stores["read-guard"]
```

- There is one writer, `persistScope(h: LineageHandle)`. It is coalesced per session id
  and does a `guardedWrite` at write time, so a retired scope's late save after a
  `/reload` (same id, new scope) is dropped.
- It is called on each store's `persist.on` and on `retireScope`.
- Loading stays best-effort, as today (`session-state-store.ts:142-155`).

### 3.7 Observability records

1. **`session_scope_transition`.** One latency phase row per transition:

   ```text
   {transition, reason, scopeId, parentScopeId, role, branchEpoch, sessionId,
    evaluationOrdinal, coordinatorId, handoffSource: "slot"|"parent-sidecar"|
    "own-sidecar"|"none", stores: {name: {action, kept, dropped}}}
   ```

   It subsumes G10's `read_guard_branch_retained` (G10 `read-guard-branch.ts`
   `logReadGuardBranchMove`); keep that phase as an alias for one release. It also
   answers N3's residence question.
2. **Stale writes.** These reuse `generation-guard-stale-write`
   (`generation-guard.ts:175-186`), with subject `session-scope:<store>:<subject>`.
   There is no new kind, so the existing ledger dashboards keep counting.
3. **`session-scope-handoff-unmatched`** (a degradation, once per process per reason):
   a slot that no start consumed, or a start that found a slot from a different parent.
4. **`session-scope-unscoped-write`** (a degradation, counted): a fenced store write
   with no handle.

### 3.8 The governance sweep

These extend the existing machinery; there is no new framework.

1. **`tests/support/session-state-registry.ts`.** Add
   `scope: "store" | "latch" | "process"`. Every `scope:"store"` entry must name a
   `defineSessionStore` (`listSessionStores()`), and every declared store must have an
   entry (a two-way diff, like `sessionStartResetNames()`).
2. **A new `tests/config/session-scope-sweep.test.ts`.**
   1. **Container ratchet.** Run `scanSessionStateCandidates({includeUnresetContainers:true})`
      (`session-state-scan.ts:692`) over the conversation-scoped files: `runtime-*.ts`,
      `read-guard*.ts`, `widget-state.ts`, `tool-set-policy.ts`, `pending-runner-findings.ts`,
      `test-runner-delivery.ts`, `turn-summary.ts`, `mutation-bridge.ts`,
      `quiet-window.ts` and `index.ts`. A new module-level container or `let` there reds
      unless it is a store, a `SESSION_STATE_SYMBOL_COUNTS` pin with reason, or an
      exemption. The allowlist starts at today's count and each migration slice shrinks
      it (a ratchet, like `SESSION_STATE_SYMBOL_COUNTS`).
   2. **Activation closure.** One-tab `let` declarations in `activateExtension` must be
      in `ACTIVATION_STATE_ALLOWLIST`: `ownEventCtx`, `ownedSessionRole`,
      `renderInvalidator`, `mountedLensWidgetUi`, `widgetMountFailureLogged`,
      `lastSessionStartIdentity`, `scope`, plus the B5 toggles until D6 is decided. A new
      `pendingFork*`-shaped closure `let` reds.
   3. **Coordinator fields.** Every `RuntimeCoordinator` field (regex over the class
      body) must be in `COORDINATOR_FIELD_POLICY: Record<field, StoreName | "process" | "identity">`.
   4. **Hook wrapping.** Every `pi.on(` in `index.ts` goes through
      `wrapSessionEventHandler*` with a `scope` option. This extends
      `tests/clients/session-event-guard-sweep.test.ts`; `tool_call` is the known
      exception today.
   5. **Sidecar writers.** A `writeFileAtomic*`/`saveSessionState` call in the files of
      item 1 must go through `persistScope`, or carry an exemption.
   6. **Hand-off budgets.** Every `spec.snapshot` is sync (it returns no thenable; a
      runtime assert in test mode), which keeps `session_shutdown` at its 0 ms pin
      (`hook-budgets.ts:86-87`; `tests/config/hook-await-bounds.test.ts`).
3. **The generation sweep.** G10's `branchEpoch` and G5's `_writeOrderTurn` are hand-rolled
   counters that the existing `tests/clients/generation-guard-sweep.test.ts` does not
   see. After S1 they live in the registry, and the sweep's exemption list gains nothing.

---

## 4. Policy table (target)

Legend:

- `R` reset, `C` carry, `F` filter-by-branch, `I` import-parent (then filter),
  `H` rehydrate (then filter), `–` none.
- `own`/`shr`/`pri` is the secondary policy.
- Fence `s`/`b`/`n` means session/branch/none.
- "startup" means a launch, including `pi --session <id>`. `pi --fork` also arrives as
  `startup`, and the header's `parentSession` selects `I`.

**Differences from today are in bold.** Where today's behaviour is a bug, the relevant
issue or N# is named in the last column.

| Store | startup | /new | resume | /fork | /clone | pi --fork | /tree | /reload | shutdown | idle | Sec | Fence | Today → issue |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| read-guard (A2) | H | R | H | **I** | **I** | **I** | **F** | **C+F** | snapshot+persist | – | **own** | b | #3521, **N1**, #3607 |
| read-guard authorship: `writtenThisSession`, edits, `pendingCreations`, FileTime (part of A2) | R | R | R | R | R | R | **R** (G10) | **C** (D5) | – | – | **own** | b | #3521, #3603 |
| turn counters (A3) | R | R | R | R | R | R | – | R | – | – | **own** | s | **N2** |
| order turn (A3') | process | process | process | process | process | process | – | **process** | – | – | process | – | **N3** |
| seq view (A4) | H(log) | H(log) | H(log) | H(log) | H(log) | H(log) | – | H(log) | – | – | shr | s | #3596, #3581 |
| per-turn maps (A5) | R | R | R | R | R | R | – | R | – | – | **own** | s | #3568, #3576, **N2** |
| inline blockers (A6) | R | R | R | R | R | R | C | **C** | – | – | **own** | s | #3540, #3559 |
| cascade runs (A7) | R | R | R | R | R | R | – | R | – | – | pri | s | OK (#3499, #3512) |
| deferred mutations (A8) | R | R | R | R | R | R | – | R | – | – | own (tagged) | s | OK (#791, #3528) |
| tool-call correlation (A9) | R | R | R | R | R | R | C | R | – | – | **own** | s | OK |
| turn summary (A10) | R | R | R | R | R | R | **R** | R | – | – | **own** | **b** | **N5** |
| partial-apply records (A11) | R | R | R | R | R | R | C | R | – | – | shr | s | OK |
| git-guard status (A13) | R | R | R | R | R | R | C | R | – | – | shr | s | #3596 |
| widget (D1) | H | R | H | **I** | **I** | **I** | C | C | persist | – | shr | n* | **#3589** |
| widget write-order guards (D1) | R | R | R | R | R | R | C | C | – | – | shr | – | #3540 (tokens use the process order turn) |
| lazy-tool memory (D2) | **H** | R | **H** | I | I | **I** | **D7** | C | persist | – | pri | – | **N8/#3604** |
| runner findings (D3) | R | R | R | R | R | R | – | R | – | – | pri | s | #3568 [G5] |
| test-runner delivery (D8) | R | R | R | R | R | R | **R** | R | – | – | pri | **b** | **N5** |
| debounced pipelines (D10) | R | R | R | R | R | R | – | R | – | – | own | s | #3596 G |
| lens toggles (B5) | R | R | **D6** | **D6** | **D6** | R | C | **D6** | – | – | per-act | – | **N6** |
| fork stash (B1, B2) | removed; replaced by the §3.4 hand-off | | | | | | | | | | | | #3521, #3589 |
| LSP fleet (E6) | process | R (reset) | R | R | R | – | – | R | R | R | shr | svc-gen | #3576 [G5] |
| registry entry (E2) | process: register at start, deregister at Q, epoch (#3498) | | | | | | | | | | root only | epoch | #3587 |
| latches (H) | registry `session_start` reset on every primary start; `–` on /tree; shr | | | | | | | | | | | | OK |

Notes:

- *Widget, fence `n*`: disk-truth writes (LSP publishes) are unfenced. The
  pipeline-verdict writes keep today's order tokens, with the turn half drawn from
  `nextOrderTurn()`.
- **C+F on /reload** for the read guard: the conversation and branch are unchanged, so
  the filter is a no-op except for records made in flight.

---

## 5. Migration plan

Every slice lands behind the §3.8 ratchet, which starts permissive. Each slice's issue
text follows the fixer contract: red-first, targeted runs, one changelog fragment.

| Slice | Content | Files owned | Issues | Depends on | Parallel with |
|---|---|---|---|---|---|
| **S0** | Finish G5 (#3602) and G10 as they are | their branches | #3540, #3559, #3568, #3576, #3521 | none | none |
| **S1** Scope registry and lineage (no behaviour change except N3/N4) | Add `clients/session-scope.ts` (registry, tickets, `SessionScope`, `LineageHandle`, `nextOrderTurn`, `session_scope_transition`). `beginScope`/`retireScope` wired in `index.ts` `session_start`/`session_shutdown`; `moveBranch` in the G10 `session_tree` handler. `captureSessionGeneration` adapts. G5 `_writeOrderTurn` moves to `nextOrderTurn()`; G10 `branchEpoch` moves to the scope. `observed-mutation` compares tickets. `guardSessionEvent` gets the `scope` option and ALS. `tool_call` gets wrapped. | `clients/session-scope.ts` (new), `clients/runtime-coordinator.ts` (generation, order turn), `clients/session-event-guard.ts`, `clients/read-guard.ts` (epoch source only), `clients/observed-mutation.ts`, `clients/runtime-tool-call.ts:646`, `index.ts` (lifecycle seams) | **new issue A** (§5.1), N3, N4 | S0 | S9, S6 |
| **S2** Hand-off and adoption | Snapshot at `retireScope`; `beginScope` adoption; the v2 sidecar envelope; the read guard on it (I/C/F; reload carry for N1); widget import on fork (#3589); `pendingForkSnapshot` and the G10 slot removed; lazy-tool memory persisted plus D7; toggles per D6 | `clients/session-scope.ts`, `clients/session-state-store.ts`, `clients/read-guard-branch.ts`, `clients/widget-state.ts` (snapshot and restore only), `clients/tool-set-policy.ts`, `index.ts` (session_start rehydrate block `:2513-2600`, before_fork) | #3589, #3604 (re-scoped per N8), **new issue B** (N1), N6 | S1 | S3, S6, S9 |
| **S3** Writer fencing (G21) | A per-writer verdict for `handleToolResult`'s post-await writers (`recordWritten`, turn-state ranges, `recordProjectChange`, `deferMutation`/`deferFormat`, `changedFiles`, turn summary, git-guard); correctness writers go through `store.write` or a lineage `guardedWrite`. `debouncedPipelines` carries the handle. The observed loop stops once the lineage is stale. | `clients/runtime-tool-result.ts`, `clients/mutation-bridge.ts`, `clients/cache-manager.ts` (the `addModifiedRange` seam), `clients/runtime-coordinator.ts` (`recordProjectMutation` guard only) | #3596 | S1 | S2, S6, S9 |
| **S4** Secondary scoping (G8/G9 session part) | `own` cells for the read guard, turn counters, per-turn maps, inline blockers and bounded-telemetry turns; `turn_start` of a secondary advances its own scope; the G10 pin test for #3607 flips | `clients/runtime-coordinator.ts` (cell accessors), `clients/read-guard.ts` (instance per scope), `clients/bounded-telemetry.ts`, `index.ts` `onTurnStart` (`:2817-2829`) | #3607, **new issue C** (N2) | S1, S3 (both touch the coordinator; S4 goes after S3) | S2 (`index.ts` hunks do not overlap: S2 owns session_start, S4 owns turn_start), S9 |
| **S5** Authorship residuals | A creation read at `tool_call` carrying `toolCallId`; ids for the autopatch, relocation, #3519-attachment and `session_authored` reads; the park-versus-delete decision (D8) | `clients/read-guard.ts`, `clients/runtime-tool-call.ts`, `clients/runtime-tool-result.ts` (read producers only) | #3603 | S3 (`runtime-tool-result.ts`), S4 (`read-guard.ts`) | S6, S9 |
| **S6** Session-start seed refactor | Extract "read sequence → seed → judge snapshot" (#3581). It becomes the seq-view store's `H(log)` restore. | `clients/runtime-session.ts` only | #3581 | S1 (S1 does not edit `runtime-session.ts`) | S2 to S5 |
| **S7** Branch-fenced deliveries | Turn summary and test-runner delivery capture the lineage at settle and drop at a stale branch | `index.ts` quiet-window emit (`:3438-3510`), `clients/test-runner-delivery.ts`, `clients/quiet-window.ts` | **new issue D** (N5) | S1 | S3, S5, S6 |
| **S8** Governance ratchet | §3.8 items 1-6; the allowlist starts at today's counts, and each slice shrinks it in its own PR | `tests/support/session-state-registry.ts`, `tests/support/session-state-scan.ts`, `tests/config/session-scope-sweep.test.ts` (new), `tests/clients/session-event-guard-sweep.test.ts` | part of new issue A | S1 | all |
| **S9** TLA+ | `formal/session-lifecycle/` (§6) | `formal/session-lifecycle/**`, `scripts/check-tla-models.mjs` registration if needed | new issue E | none (it can start now) | all |
| **S10** Registry residual | Unchanged, outside the store: process scope with its own epoch | `clients/instance-registry*.ts` | #3587 (G16 in flight) | none | all |
| (cosmetic) | N7: rename or reset the "session" event-loop counters | `index.ts:389-397`, `:1437-1446` | fold into S1 | none | none |

**Conflicts to watch in flight:**

- G6 (#3541, #3558) lands after G5 and re-pins, which touches write paths that S3 fences.
  Sequence S3 after G6.
- G8's #3520 and #3525, and G9's #3522 and #3588, touch `read-guard.ts`. Run them before
  S4 and S5, or rebase S4 and S5 onto them.

### 5.1 Proposed new issues (ready to post)

I checked that no open issue covers these. The searches were for:

- "read guard reads lost after /reload": hits #3528, #1041, #2990/#2992, #2622, #2505 and
  #2402, none on reload;
- "module re-evaluation reload RuntimeCoordinator": no hits;
- "subagent concurrent secondary turn_start beginTurn": only #999 (closed, `turn_end`);
- "turn summary delivered after /tree": only #1039 (closed, stale ctx) and #2678
  (unrelated).

**A. `refactor(session): session scope registry and lineage handle (store foundation, #3609 S1)`.**
Labels: `enhancement`, `area:session`, `priority:p2`.

Body: this is §3.2-§3.3 and §3.7-§3.8 of this design. It fixes N3 (the order turn moves
to a process-monotonic counter) and N4 (scope tickets).

Acceptance:
- `captureSessionGeneration()` returns a `LineageHandle`, and every existing capture site
  passes unchanged.
- A red-first test: after a simulated entry re-evaluation (two `RuntimeCoordinator`
  instances, one widget module), a turn-1 widget write in the second instance outranks a
  turn-5 token from the first.
- A red-first test: two coordinators' handles never compare equal in observed-mutation.
- One `session_scope_transition` row per transition, carrying `evaluationOrdinal`.
- The ratchet sweep (S8) lands with today's counts pinned.

**B. `bug(read-guard): /reload drops every read although the conversation is unchanged`.**
Labels: `bug`, `area:read-guard`, `area:session`, `priority:p2`.

Body: N1, with the evidence lines `runtime-session.ts:2463`, `runtime-coordinator.ts:545`,
`session-state-store.ts:58` and `index.ts:2556-2557`. On G10 the rehydrate block imports
nothing for reload.

Acceptance:
- A witness through the real `AgentSessionRuntime` (the G10 harness): read, `/reload`,
  edit → ALLOW. It is red on master and on G10.
- A no-drop sibling test.
- A reverse test: a read whose tool result is not on the branch is still dropped.

**C. `bug(session): a concurrent secondary's turn_start advances the primary's turn and clears its per-turn maps`.**
Labels: `bug`, `area:session`, `priority:p2`.

Body: N2 (`index.ts:2817-2829`, `runtime-coordinator.ts:667-712`).

Acceptance:
- A two-activation test: the primary records actionable warnings, the secondary runs
  `turn_start`, and the primary's `turn_end` still delivers them. Red on master.
- The primary's `turnIndex` and write tokens are unchanged by a secondary turn.
- A no-drop test for the secondary's own warnings.

**D. `bug(session): quiet-window deliveries after /tree land on the new branch`.**
Labels: `bug`, `area:session`, `priority:p3`.

Body: N5 (`index.ts:3480-3485`, I1).

Acceptance:
- A red-first real-runtime witness: a run ends, then `/tree` fires while the settle is
  awaiting, and the turn summary is not appended to the new branch.
- The same test for the test-runner delivery.
- A no-drop test without `/tree`.

**E. `test(formal): session-lifecycle composition model (#3609 S9)`.**
Labels: `test`, `area:session`, `priority:p3`.

Body: §6. The acceptance is every config's first-line verdict, checked by
`scripts/check-tla-models.mjs`.

**Re-scope #3604** (comment text): "Verdict: no loss on an in-process `/fork`. The map is
`clients/` module state (`tool-set-policy.ts:21`), and the fork inherits it
(`index.ts:2323`). Remaining: not persisted (restart and `pi --fork` lose it), inert for
in-memory sessions, and no branch filter on `/tree` and `/fork before`. Migrate as store
`lazy-tool-memory` in S2, with policy per D7. The witness acceptance stays."

---

## 6. TLA+ plan: `formal/session-lifecycle/SessionLifecycle.tla` (new directory)

This is the composition layer. Content-level truth stays in `ReadGuard.tla`,
`SessionStraddle.tla`, `FormatDrain.tla` and `SessionRegistry.tla`. This model abstracts
each store's content to **facts**: `[origin: ScopeId, epoch: Nat, entry: EntryId]`.

**Constants.**

- `Transitions` ⊆ {`New`, `Resume`, `Fork`, `Clone`, `Tree`, `Reload`, `Shutdown`,
  `IdleReset`, `SecStart`, `SecEnd`}.
- `Stores` (model values: `RG` read-guard, `TC` turn counters, `IB` inline blockers,
  `WG` widget, `TS` turn summary).
- `Policy ∈ [Stores × Transitions → Actions]` (§4 as a constant).
- `SecPolicy ∈ [Stores → {"own","shared","primaryOnly"}]` and
  `Fence ∈ [Stores → {"session","branch","none"}]`.
- `FixParts` ⊆ {"entryCapture", "branchEpoch", "tickets", "handoffAtShutdown",
  "secondaryOwn", "processOrderTurn", "reloadCarry", "deliveryFence"}.
- `MaxWriters`, `MaxTransitions` (small: 2 and 3).

**Variables.**

- `scopes`: id → [role, state ∈ {live, retired}, epoch, session].
- `cells`: (scope, store) → set of facts.
- `branch`: session → set of visible entry ids.
- `writers`: in flight, each with a captured handle or ⊥, a target store and a pending fact.
- `handoff`, `sidecar`, `runActive`, `settling` (models I1), `evals` (the module
  evaluation of each scope; models N3/N4).

**Transition table as actions.** `Start(reason)` splits into two steps: classify, then
reset/adopt. The others are `Shutdown(reason)` (snapshot iff `handoffAtShutdown`),
`BeforeFork` (the slot iff not `handoffAtShutdown`), `CancelFork` (I3), `Tree` (bump the
epoch, filter), `Reload` (a new evaluation), `SecStart`/`SecTurn`/`SecEnd`,
`SettleBegin` (sets `runActive = FALSE` **before** the handler: I1), `WriterBegin`
(capture iff `entryCapture`, otherwise capture at `WriterResume`), `WriterAwait` and
`WriterLand` (fenced per `Fence` and `FixParts`).

**Invariants.**

| Name | Meaning | Generalises |
|---|---|---|
| `NoCrossScopeWrite` | every fact in a live scope's `own` cell has `origin` = that scope, or was imported from an ancestor through the hand-off | #3528, #3568, #3596 |
| `NoOffBranchFact` | for branch-fenced stores, every fact's entry is on the scope's current branch | `NoBlindAllow` / `NoStaleAllow` (#3521) |
| `NoLostCarry` | after `Start` with `carry` or `import`, every predecessor fact whose entry is on the successor's branch is present (shape 54) | `NoFalseBlock`; N1, #3589 |
| `SecondaryIsolation` | a primary transition never removes a live secondary's `own` facts, and a secondary turn never changes a primary `own` cell | #3607, N2 |
| `HandoffOnce` | a hand-off is consumed by at most one `Start`, and only by the matching successor | the G10 slot, I3 |
| `OrderMonotone` | a write token drawn later in process time outranks every earlier token, across `Reload` and evaluations | #3540 r2, N3 |
| `OneResetPerScope` | kept from `SessionStraddle` | #2890 |

**Configs.** Each states its expected verdict on its first line, as in
`formal/file-locks/README.md`.

| Config | FixParts | Expect |
|---|---|---|
| `Fix` | all | pass, all invariants |
| `MutSettleDuringTree` (the G10 F1 race) | all − `branchEpoch` | violated `NoOffBranchFact` |
| `MutStalePipelineAfterNew` (#3568/#3596 D) | all − `entryCapture` | violated `NoCrossScopeWrite` |
| `MutDrainAfterNew` (#3528) | the drain without a capture | violated `NoCrossScopeWrite` |
| `MutClosureStash` (#3521 fork half, #3589: the slot lives in a scope-local variable) | all − `handoffAtShutdown`, slot per evaluation | violated `NoLostCarry` |
| `MutBeforeForkCancel` (the G10 design, plus a cancelled fork and a second fork from another parent) | all − `handoffAtShutdown` | pass iff the file match is modelled; `FixNoFileMatch` violates `HandoffOnce` |
| `MutTreeWipesSecondary` (#3607) | all − `secondaryOwn` | violated `SecondaryIsolation` |
| `MutSecondaryTurnStart` (N2) | all − `secondaryOwn` | violated `SecondaryIsolation` |
| `MutReloadReset` (N1) | all − `reloadCarry` | violated `NoLostCarry` |
| `MutOrderTurnPerEval` (N3) | all − `processOrderTurn` | violated `OrderMonotone` |
| `MutGenPerEval` (N4) | all − `tickets` | violated `NoCrossScopeWrite` (two evaluations share a generation number) |
| `MutDeliveryAfterTree` (N5) | all − `deliveryFence` | violated `NoOffBranchFact` (TS) |
| `Current` (master) | {} | violated (the first counterexample documents today) |
| `CurrentG5G10` | {entryCapture, branchEpoch} | violated `NoLostCarry` (N1) and `SecondaryIsolation` |

The heartbeat-before-registration interleaving stays in `formal/session-registry`
(`StaleIntent`, `Replacement*`). The new README cross-references it instead of
re-modelling the registry, which has its own epoch (E2) and is outside the store.

**Budget.** 1 secondary, 2 entries, 2 writers and 3 transitions should stay under
~10⁵ states [I]. Run each config once under the #3597 parallel pool, and record
states and seconds in the README table, as the sibling models do.

---

## 7. Risks and open decisions

**Decisions for the maintainer.**

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | Where cells live | (a) per-scope cells in the process registry, with the coordinator's getters resolving the ambient scope; (b) move `runtime` into the activation closure (one coordinator per activation), which overturns the deliberate choice at `index.ts:571-578` and makes every once-per-process bridge (`index.ts:586-628`) resolve the current scope | (a): incremental, survives module re-evaluation (N3), and S1 changes no call sites |
| D2 | The ambient lineage | ALS in `guardSessionEvent`, reusing the `turn-context.ts` precedent at `session-event-guard.ts:289`; or explicit threading only (the G5 style) | ALS plus required handles for fenced writes. The risk is that long-lived resources inherit a stale ambient handle; mitigate with `lineage.exit()` at resource creation and `fence: "none"` for disk-truth stores (§3.3 item 5). |
| D3 | When the fork snapshot is taken | at `session_before_fork` (G10 D2, live export, 0 ms) or at `session_shutdown` (after `abort()`, matched by `targetSessionFile`, no cancelled-fork orphans) | at shutdown; G10 lands as is and S2 moves it |
| D4 | Tool-call id reuse across branches (the G10 D1 residual) | carry it into the store's `filter` unchanged | unchanged; name it in the store's `reason` |
| D5 | Read-guard authorship on `/reload` | carry `writtenThisSession`/edits/FileTime, or reset them | carry: the branch is unchanged. This is not certain; a model check (`MutReloadReset`) decides it. |
| D6 | The `/lens-toggle` family | reset per activation (today), carry on reload only, or carry on reload, fork and clone | carry on reload, fork and clone; reset on `/new`. These are a user's choices for the conversation. |
| D7 | Lazy-tool memory on `/tree` and `/fork before` | keep (today), or filter by the branch via the `pi_lens_activate_tools` tool-result id | keep. Extra tools cost prompt bytes, never correctness; filtering changes the prompt-cache prefix. |
| D8 | Off-branch records on `/tree`: delete or park per branch (#3603 item 3) | delete (G10 default) or park keyed by leaf | delete now. Parking needs a bounded per-leaf store and an eviction policy; revisit after S4. |
| D9 | Store name and module | `clients/session-scope.ts` (new), with `session-state-store.ts` kept as the sidecar | as proposed |

**Risks.**

1. **ALS overhead and leakage.** Each wrapped hook adds an `AsyncLocalStorage.run`. The
   `turn-context` ALS already runs per hook, so this is one more store in the same
   frame [I negligible]. The leakage risk is D2.
2. **Unverified production residence (N3).** If pi-lens's entry does import natively in
   production, N3 does not fire. The S1 record settles this either way. The design is
   correct under both, because cells are never at module scope.
3. **The 0 ms snapshot at shutdown.** `ReadGuard.exportState` is O(records). It is
   bounded by the read-guard record caps, but it is not measured under a 0 ms budget.
   Measure it in S2 and fall back to a lazy snapshot (the retired cell copied on first
   successor access) if p99 > 5 ms.
4. **The MCP host.** `mcp/session.ts` has its own session model (its `turnEndQueue` is
   pinned in `SESSION_STATE_SYMBOL_COUNTS`). It must call `beginScope`/`retireScope`, or
   its fenced writes drop as unscoped. S1 needs an MCP audit [I].
5. **In-flight churn.** G5 and G10 each add a hand-rolled epoch that S1 moves. Land S1
   **after** both merge, as the issue already orders.
6. **Scope explosion with many subagents.** Secondaries' `own` cells are freed at their
   shutdown. A subagent killed without `session_shutdown` leaks its scope until process
   exit. Bound the registry, for example at 64 live secondaries, with oldest-retire and
   a degradation record.
7. **Test fidelity.** Every fork or reload acceptance must use two activations or the
   real `AgentSessionRuntime` (the G10 harness `tests/index-3521-fork-tree-witness.test.ts`
   uses `extensionFactories`). Note that inline factories **never** exercise module
   re-evaluation. N3's acceptance therefore needs either two coordinator instances or a
   path-based extension load through `loadExtensionsCached`.

---

## Appendix: evidence files

- `scratchpad/design-3609/scan-let.txt`, `scan-const-new.txt`, `scan-singleton.txt`,
  `scan-gen.txt`, `scan-reset.txt`, `scan-writers.txt`: the raw enumeration.
- `scratchpad/design-3609/probe-ext/`: the loader residence probe (`run.mjs`,
  `run2.mjs`). It runs pi's own `loader.js`. Its only writes are `globalThis` counters,
  and `PI_LENS_HOME` was pinned to `probe-ext/.probe-home`.
