# Orchestrator handoff: TLA+ follow-up queue (#3518)

Written 2026-09-27, around 09:30 UTC, by the outgoing orchestrator session (session_01GpuMYnAosBztLRYHDcGN3W).

Durable copies live on the branch `orchestrator/handoff-2026-09-27` on origin, under `.handoff/`: this file, the #3609 design, every review report and every pending PR body. The same handoff is summarised in a comment on #3518. The scratchpad paths below will not exist in a new container. Use the branch copies instead.

---

## 0. Maintainer directives in force (read these first)

1. **No new fixers.** Do not start any "Next wave" group or #3609 store slice until the maintainer lifts this.
   - Fixers already in flight may finish their current and requested fix rounds.
   - Reviews, verifies and investigators may still run.
   - The hourly routine prompt encodes this (see §6).
2. **Session-lifecycle work goes through one session-state store (#3609).** The design is **APPROVED**, with these decisions (recorded on #3609):
   - D1: per-scope cells in the process registry.
   - D2: ambient ALS lineage plus required handles for fenced writes.
   - D3: fork snapshot at `session_shutdown`.
   - D4: tool-call id reuse is an accepted residual.
   - D5: read-guard authorship carries on `/reload`.
   - **D6 NOT approved:** the `/lens-toggle` family keeps its per-activation reset.
   - D7: keep lazy-tool memory.
   - D8: delete off-branch records now.
   - D9: `clients/session-scope.ts`.

   S1 (#3611) starts after G10 merges, but only once the fixer freeze is lifted.
3. **The standing contract** in AGENTS.md / CLAUDE.md:
   - Each agent works in its own worktree.
   - Push only from a dedicated push worktree, by exact SHA, and gate with `&&`: `npm run build >log 2>&1 && test "$(git rev-parse HEAD)" = SHA && git push origin SHA:refs/heads/B`. A `;`-separated build is a #3471 case 1, and once G12 lands the guard-bash hook will deny it.
   - Never `git stash`, `pkill` or `git reset --hard`; the hook enforces all three.
   - Review, then verify, then push. Every branch gets its own PR with squash auto-merge on, and you subscribe to it.
   - Lint every PR body with `node scripts/check-pr-body.mjs --lint-local <file>` before creating or updating it.
   - **Also put `Closes #N` lines in the body** for every issue the title closes. The "Close-keyword syntax" check fails otherwise; this happened on #3619.
   - `closes` only when every acceptance criterion is met; otherwise use `refs` plus an issue comment naming the remainder.
   - Every new issue gets a type label (`bug`/`feature`/`enhancement`/`documentation`) plus `priority:pN` plus an area label. The #3563 daily check fails on any open issue missing type or priority.
   - File every follow-up, label it and group it in #3518. Session-lifecycle follow-ups go under #3609.
4. **Test-infra facts for this sandbox:**
   - tree-sitter grammars cannot be fetched. Copy them from any worktree that has them (for example, a lockfile-pinned set was installed in `agent-a2bd1fc6fd09ed1c1/grammars/`), or reinstall from the npm tarball. Without them, `result-contract-governance`, `module-report`, `reverse-deps`, `complexity-client` and the dependency-demotion freshness tests fail environmentally.
   - Node's bare `fetch` ignores `HTTPS_PROXY`. Use `NODE_USE_ENV_PROXY=1` (Node ≥ 22.21) for GitHub REST from scripts. Downloading CI logs via blob URLs is sometimes proxy-blocked, so read logs through the `get_job_logs` MCP tool (a haiku subagent can extract failures from a big log).

---

## 1. Open PRs (auto-merge on unless noted)

| PR | Group | Head | State / next action |
|---|---|---|---|
| **(no PR yet)** | G20 lock-wait (refs #3594) | `f07d73f1c`, **pushed** to `fix/3594-lock-wait` | Items 1 and 3 are verified. Item 2 is withdrawn (see §4). The self-check on a merge with current master passed 154/154. **Next:** open the PR from `.handoff/pr-bodies/fix-3594.md`, title `fix(locks): remembered-holder skip for acquireBoundedPidFileLock (refs #3594)`. The body has no Closes line, which is correct because it is `refs`. Enable auto-merge and subscribe. |

Merged this session:
- #3602 (G5)
- #3606 (G7)
- #3608 (G19)
- #3610 (G6)
- #3619 (G13): closes #3497 and #3563; merged 09:29

Earlier merges are in #3518's Done list.

---

## 2. In-flight branches, not pushed as PRs

Each branch below also has a WIP backup ref pushed to origin as `wip/<name>`. The fixer or reviewer named in each row was a subagent of the old session. It is gone, so a new session must spawn fresh agents with the brief from that row.

| Group | Branch (backup ref) | Last known head | Where it stands | What remains |
|---|---|---|---|---|
| **#3605 (G24, external, priority)** review-graph wasm trap containment | `fix/3605-wasm-trap-containment` (`wip/3605-wasm-trap-containment`) | `c5693ac91` (mid round 2) | Round 1 at `72ccc7122`: the review found the containment works, but F1–F3 are behaviour findings (`.handoff/reviews/rv3605.md`). | Round 2 was in progress when the session ended. It needs to:<br>(F1) key traps by input, file stamp or query source, so one always-trapping input does not burn the process budget of 3;<br>(F2) mark a wasm-degraded file dirty so the next build re-extracts it, bounded;<br>(F3) record the degraded-file count on the build and have the cascade set `indeterminate: graph_degraded`;<br>(F4) fix the body.<br>Then merge master, verify and push. The #3605 reporter has been told the three points. |
| **G10** read-guard fork/tree (#3521) | `fix/3521-fork-tree` (`wip/3521-fork-tree`) | `bfefa1c3c` | Round 2 is done: a branch epoch fences the `agent_settled` sweep, drain and quick-fix against `/tree`. F2 is accepted as #3607. **The round-2 verify says NOT READY** (`.handoff/reviews/rv3521.md`). There is one open finding, **R2-F1**: a deferred record requeued (on abort, autofix-failed, format-failed, clients-unavailable or a stale-orphan claim) is drained on the next settle with the new branch's epoch, and is credited after `/tree`. The common trigger is `/tree` during streaming, because pi calls abort() first. The probe is `.handoff/rv3521/probe-requeue.test.ts.txt`. C1: a stale hook-await line in the body. **The resolved master merge is pushed as `wip/3521-fork-tree-merged-master` (`9fffe30cc`).** Resolution diff: `.handoff/rv3521/merge-resolution.diff`. 507/507 targeted tests pass on the merge. | Round 3:<br>- stamp the branch epoch on each deferred record at queue time (`deferMutation`/`deferFormat`);<br>- the drain uses the record's epoch, falling back to the settle's;<br>- keep the newer epoch when records coalesce (shape 55);<br>- list every `DeferredMutationRecord` creation and merge site;<br>- add a `Requeue` action to `ReadGuard.tla`, with a before-fix config;<br>- fix the C1 body line;<br>- list the foreign-bridge-entry gap under named gaps.<br>Start from `wip/3521-fork-tree-merged-master`. Then verify, push and open the PR (body: `.handoff/pr-bodies/fix-3521.md`, about 59 KB). The pre-existing sweep-straddling-`/new` gap is filed under #3609. Once G10 merges, S1 (#3611) is unblocked, but only once the freeze lifts. |
| **G12** guard-bash rules (#3556, #3526, refs #3471) | `fix/3556-guard-bash-rules` (`wip/…`) | `311af2707` (mid round 2) | The round-1 review (`.handoff/reviews/rv3556.md`) found gaps in every rule. | The round-2 brief:<br>(F1) expand known `$VAR` destinations (the 14 corpus `/tmp` worktree-adds);<br>(F2) handle bundled mktemp flags and `-t`;<br>(F3) replace the whole-region control-flow skip with an unmatched-opener walk;<br>(F4) recognise vitest by name, including `timeout N` and `npm test`;<br>(F5) add the gated push idiom to a merge-train mistake row and to AGENTS.md;<br>(F6) allow the scoped `pkill -f` only from a linked worktree;<br>(F7) note the opt-out ask in the #3471 remainder;<br>(S1) expand `~` and pin the test cwd outside /tmp;<br>(S2) dedupe `splitSegments`;<br>(S3) fix the doc claims.<br>After that, verify, push and open the PR. |
| **G16** registry follow-up (#3587) | `fix/3587-registry-root-hold` (`wip/…`) | `5c8950151` (mid round 2) | Review (`.handoff/reviews/rv3587.md`): #3587 and the heartbeat-on-queue fix hold. The exit listener does not work, because vitest SIGTERMs its workers and Node emits no `exit` on a signal. | Round 2:<br>- revert commit `b91754357` (exit listener), its tests and the fragment `3518-registry-lock-exit-release.md`;<br>- delete the now-stale settle in `tests/index-1892-scanner-freshness-witness.test.ts:158-164` and show the red/green through the 400 ms seam;<br>- fix the body and cite #3617 and #3618.<br>After that, verify, push and open the PR. |
| **G11** load-bound tests (#3565, #3567, #3570, #3546) | `fix/3565-load-bound-tests` (`wip/…`) | `54cbef51f` (round 2 partly done: #3496 F2/F3/F4 applied, split not started; see `.handoff/g11-status.md`) | Review (`.handoff/reviews/rv3565.md`): the #3565/#3567/#3570/#3546/#1383 fixes hold. The #3496 part failed. | Round 2 brief:<br>- **split #3496 out**: restore `clients/observed-mutation.ts` to master and remove the time-bound pass, workflow, canary and admissions; save it as a patch;<br>- refresh the body: the 8-hog bar, MCP child start as the remaining cost, and cite #3602 for the RSS fixes already on master;<br>- merge master;<br>- confirm `git diff origin/master -- clients/` is empty.<br>After that, verify, push and open the PR. The #3496 remedies are in the review and in the #3496 comment. |
| **S9** session-lifecycle TLA+ model (#3615, refs #3609) | `feat/3609-session-lifecycle-model` (`wip/…`) | `4e8b53705` (in progress) | Started before the freeze. | Finish the model per DESIGN.md §6, review, then push. A pass config models the target design; the Mut configs (N1, N2, N3, #3521, #3540, #3576, #3596, #3607) must violate. Keep the TLC budget under about 2 minutes. |

---

## 3. Queue state (#3518 is the source of truth; its body was updated 08:55 UTC)

- **Next wave (frozen):**
  - G17 (#3585)
  - G23 (#3600)
  - G22 (#3598, #3599, #3601), unblocked now that G6 has merged
  - the non-session parts of G8 (#3520, #3525) and G9 (#3522, #3588), after G10
- **#3609 store slices:**
  - S1 #3611 (after G10)
  - S2 #3612 plus #3589 and #3604 (re-scoped)
  - S3 #3596
  - S4 #3613 plus #3607
  - S5 #3603
  - S6 #3581
  - S7 #3614
  - S8 (governance ratchet, in #3611)
  - S9 #3615 (running)

  The design is `.handoff/design-3609/DESIGN.md`. The order: S1 first; then S2 ∥ S3; S4 after S3; S5 after S3+S4; S6/S8/S9 anytime.
- **New follow-ups filed this session:**

  | Issue | Scope | Group |
  |---|---|---|
  | #3601 | lsp_navigation rename staleness | G22 |
  | #3603, #3607 | read-guard | store S5/S4 |
  | #3604 | tool-set-policy, re-scoped by N8 | S2 |
  | #3605 | external | G24 |
  | #3609, #3611–#3615 | store | — |
  | #3616 | mutation lane: MCP stdio smoke test fails in Stryker's dry run → 0 mutants | G19 area |
  | #3617 | SIGTERM'd vitest worker leaves the registry lock held by a dead pid; test-side fix | G16 follow-up |
  | #3618 | collapse `deregisterInstanceRootNow`'s sync-then-fallback lock | G16 follow-up |
  | #3620 | settled-sweep bridge replay has no session fence; a sweep straddling `/new` credits writes (p2, reproduces on master) | #3609 S3 |

- **Not batched:**
  - #3552
  - #3489
  - the #3405 remainder
  - `LSPService.updateFile` removal
  - #3532, #3533, #3469, #3470
  - external PRs #3454 and #3455 from AngriestBird (not triaged; the maintainer asked only about the external *issue* #3605)

---

## 4. Decisions waiting on the maintainer

1. **#3594 item 2** (the ~1 s first change-log read). Option 3, a tail scan, was **withdrawn**: it is unsound on logs that allow disorder (pre-#3511 writers; review R2-F1/F2). The choices are:
   - (a) accept the cost;
   - (b) design a high-water sidecar, lock-written and invalidated by any unlocked append.

   The comment on #3594 explains this.
2. **#3605 budget**: `WASM_TRAP_BUDGET = 3` is a judgement call. Revisit it after the per-input keying in round 2.
3. **Lifting the fixer freeze**, and in what order: G17, G23, G22, the G8/G9 non-session parts, S1.
4. **Whether to triage external PRs #3454 and #3455.**

---

## 5. Agent roster at handoff (all old-session subagents; not resumable from a new session)

**All fixers are PAUSED** on the maintainer's order: #3605 round 2, G12 round 2, G16 round 2, G11 round 2 and S9. Each was told to commit its progress, including a WIP commit whose body lists what is done and what remains, and to push it to its `wip/<name>` ref. **Read each `wip/*` branch's tip commit message first:** it is the authoritative progress note and supersedes the "last known head" column above. The G10 verifier has finished.

To resume, start fresh agents from the `wip/` refs, using each row's "What remains" plus that tip commit message as the brief. The role playbooks are in `.claude/agents/pi-lens-{fixer,reviewer,investigator}.md`.

---

## 6. Hourly routine

Routine `trig_01MUZ9yybcCCrs27t3DPFVif` ("Process TLA follow-up queue (#3518)", cron `31 * * * *`) is bound to the **old** session. It encodes the directives in §0. **It is DISABLED (09:36, at the maintainer's request).** The next orchestrator should create its own routine bound to its own session instead of re-enabling this one.
- **To continue:** create a new routine bound to the new session, with the same prompt (retrieve it via `get_trigger`).
- **Otherwise:** disable the old one so it does not fire into a dead session.

---

## 7. Worktree hygiene

`.claude/worktrees/` holds about 45 agent and push worktrees from this session. None hold uncommitted work that matters: every live branch head is pushed as a real branch or a `wip/` ref.
- **To clean up:** for each worktree, `rm <wt>/node_modules`, which is a symlink. Never `rm -rf` through it.
- **Then:** `git worktree remove <wt>`, without `--force` unless it is clean.
