# G11 round 2 (#3565): paused

- **Branch:** `wip/3565-load-bound-tests` at `54cbef51f`, a fast-forward from `f48886e26`.
- **Worktree:** `.claude/worktrees/agent-a2bd1fc6fd09ed1c1`, on `fix/3565-load-bound-tests`, clean. Run `rm node_modules` to remove its symlink.

## Done: the #3496 fixes the split must carry

- **F2:** Applied `F2-remedy.patch`.
  - The fake clock is held until each operation settles; the canary advances are 49/199/199.
  - The unset/invalid-value loop is split into one case per value. The seam test passes 4/4 at 32 hogs.
- **F4:** `scaledBoundMs` returns the production value unless test mode is on and the scale is finite and inside (0, 1).
  - One case per value.
  - The mutations M9a and M9b are each killed.
- **F3:** The pass now runs its scaled runs one file at a time.
  - Each flip is re-run alone 3 times, scaled and unscaled. A flip that doesn't reproduce is reported as `UNCONFIRMED`.
  - Turn-bound findings say to admit the test.
  - Unit-tested (17 tests). There has been **no full pass run** with F3.

## Not started

1. **Split out #3496.** Restore `clients/observed-mutation.ts` from master byte-for-byte. Remove:
   - the pass script and its type file;
   - the workflow;
   - the seam and pass tests;
   - the admissions table and the header in the net test;
   - the npm script.

   All of it is recoverable from `54cbef51f`. No split patch was written.
2. **Decide which pins stay.** The directory-cap and line-hash charge cases stay in the PR. The 400-file sweep case needs `sweepMs`, so it moves out with #3496.
3. **Merge current `origin/master`,** which includes #3602 and #3610.
4. **Refresh the body:**
   - the 8-hog bar for #3567 and #3570;
   - the MCP child start (10–19 s at 16 hogs) as the remaining cost;
   - cite #3602 for the RSS fixes;
   - drop "refs #3496" from the title.
5. **Run `tests/scripts/ci-verdict.test.ts`.** F1 goes away with the split.
6. **Mirror the split decision** in comments on #3565 and #3496. Neither has one yet.
