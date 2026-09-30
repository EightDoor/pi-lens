---
section: Fixed
---

- **Git hooks now run from linked worktrees (refs #3674)** — husky wrote the relative `core.hooksPath=.husky/_`, which git resolves per worktree against a gitignored directory that exists in one tree only, so a linked worktree ran no pre-commit or pre-push at all. `scripts/setup-git-hooks.mjs` now runs husky in the main worktree and pins `core.hooksPath` to its absolute `.husky/_`, including when `npm install` runs inside a linked worktree, and treats `HUSKY=0` as a skip.
