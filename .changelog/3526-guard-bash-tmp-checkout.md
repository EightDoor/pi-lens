---
section: Added
---

- **guard-bash refuses a checkout or scratch directory under /tmp (closes #3526)** — `/tmp` on the maintainer host is tmpfs (RAM + swap); ~20 accumulated review/merge scratch checkouts filled it to 8/8 GB swap on 2026-09-26. `git worktree add`, `git clone`, and `mktemp -d` (including its bare default, `-p`/`--tmpdir=`, and a literal `$TMPDIR` reference) are denied when the destination resolves under `/tmp`; `mktemp` for a plain file, and a checkout under `.claude/worktrees/`, `~/.cache/pi-lens-orchestrator/worktrees`, `~/.local/share/pi-lens-orchestrator/tmp/`, or `~/.plegma/work`, stay allowed. The reviewer playbook and merge-train skill's "throwaway worktree" rows now name `~/.local/share/pi-lens-orchestrator/tmp/<lane>` instead of "the scratchpad" (which is `/tmp` on the Claude Code launcher).
