---
section: Added
---

- **guard-bash refuses a `git commit`/`git push` chained after an ungated check (refs #3471)** — a check (`npm run lint`/`build`/`test`/`fmt:check`/`preflight`, `npx vitest`, `tsc`, `node scripts/check-*.mjs`) piped or `;`-separated from a following `git commit`/`git push`, rather than gated with `&&`, is denied — the check's exit code gates nothing that way, and a real failure can still get committed or pushed (three 2026-09-25 incidents this fixes). Auditing the real 2026-09-07..08 transcript corpus for this shape found 20 more historical instances of the exact same defect, now pinned as expected denies. A write gated through shell control flow (`if [ $vexit -eq 0 ]; then …; fi`, this repo's own convention for deciding from a saved exit code) is left alone rather than guessed at, and a write with no preceding check at all (the sanctioned `git commit -m x; git status` pattern) is never judged.
