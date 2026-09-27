# G12 (#3556, #3526, refs #3471) at pause: `wip/3556-guard-bash-rules` = 311af2707

## Round 2: code done and ready for verify

| Finding | Status |
|---|---|
| F1 | Done |
| F2 | Done |
| F3 | Done |
| F4 | Done |
| F5 | Done |
| F6 | Done |
| S1 | Done |
| S2 | Done |
| S3 | Done |
| F7 | Partly done: the opt-out ask is noted in the #3471 remainder, but no mechanism is implemented (maintainer's call: env var or inline marker?) |

- **guard-bash-hook tests:** 434/434 pass. 14 of them fail on the pre-round-2 source (red-first).
- **Mutation table:** corrected, including M12 = 16 failures when run unfiltered.
- **Master merge:** past df5fb8abb.
- **Checks:** build, lint and body lint are clean.
- **PR body:** `.handoff/pr-bodies/fix-3556.md`.

## Open item

The governance sweep showed 2 `beforeAll` timeouts: `result-contract-governance` and `availability-policy-coverage`. They look like load. The fixer could not run the same files against master because the sandbox refused the checkout.

## Next

1. Run a narrow verify against `.handoff/reviews/rv3556.md`. Include that master comparison and a merge with current master.
2. Push and open the PR.

After merge, the hook denies `;`-separated build-then-push chains. Use `&&`.
