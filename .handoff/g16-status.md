# G16 (#3587) status at pause: `wip/3587-registry-root-hold` = 5c8950151

## Done (committed through hooks)

- **ce8fc7d61:** reverts the exit listener (b91754357) and its fragment. `instance-registry-lock` passes 21/21.
- **4ffae2719:** drops the stale settle in the #1892 witness. With the 400 ms seam:
  - Head: green.
  - Head plus G1m: red.
  - Pre-fix da04c5a64: red.
- **5c8950151:** merges master 327cc3a22 cleanly.
  - Registry and lock suites: 139/139.
  - index-wiring: 60/60.
  - Witness: 1/1.
  - Governance: 111/114. The 3 failures are load timeouts and pass when run alone.

## Remaining (PR body only; the code is ready for verify)

`.handoff/pr-bodies/fix-3587.md` is partly updated. It still needs these edits:

- **Scope addition 1 paragraph:** "settle left in place" → deleted.
- **Scope addition 2:** replace with a short "Scope addition 2 (reverted)" section. Cite review F1 and ce8fc7d61.
- **Exit-listener references:** remove them from Blast radius, Observability, Class sweep and Checklist.
- **Lint:** re-run `check-pr-body --lint-local`.

## Then

- Run a narrow verify of round 2 against `.handoff/reviews/rv3587.md`.
- Push and open the PR.
