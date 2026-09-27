# S9 (#3609 / #3615): session-lifecycle TLA+ model, complete

- **Branch:** `wip/3609-session-lifecycle-model` at `2fab1f206`, 2 commits on `df5fb8abb`. It merges cleanly onto master `327cc3a22`.
- **PR:** title and body are in `.handoff/pr-bodies/feat-3609-model.{title.txt,md}` and pass `--lint-local`. The title is `refs #3609`.
- **TLC:** 24 of 24 configs match expectation, 54 s serial. `tests/scripts/check-tla-models.test.ts` passes (30 tests). The one failure in `tests/config` (`result-contract-governance`) also fails on master in this sandbox because the grammar fetch is offline.
- **Changelog:** no fragment, since this is formal-only, like `1c2878f22` and `0ebbe7d5d`.
- **Next:** adversarial review, then verify, then push to a `feat/` branch and open the PR.

## Findings against the #3609 design: maintainer decisions needed

- **F1 (decision).** The design drops every stale write (§3.2, `retireScope`). This loses authorised read-guard writes that are still in flight across `/tree`, `/reload`, `/fork` and resume, which is a false block. Four `DesignLateRead*` configs pin it.
  - The proposed amendment is `forwardStale`: re-filter the stale write against every live descendant scope, found through `parentScopeId`.
  - `Fix` passes with the amendment.
  - Without it, each lost read costs one re-read.
- **F2 (design fix).** A subagent's `beginScope` can take the primary's hand-off during `/reload`, losing every read. `MutSecondaryTakesHandoff` pins it. The fix is to role-gate `takeHandoff`. This has not been replayed on the real runtime.
- **F3.** The slot's file match can't be made red in-process under D3. Keep it as defence in depth.
- **F4.** Today a subagent's read authorises the primary's edit. The design's `own` policy fixes this.
- **Confirmed:** D3 (the snapshot must be taken at `session_shutdown`) and D5 (`/reload` must carry the read-guard).
