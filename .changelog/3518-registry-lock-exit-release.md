---
section: Fixed
---

- A registry lock generation this process still holds is now released from
  a synchronous process exit listener, so a forceful `process.exit()`
  mid-mutation no longer leaves the lock's top generation held by a now-dead
  pid. Not a correctness fix (the next acquirer already takes over a dead
  owner's generation cleanly) -- it saves every later acquirer in the same
  home the avoidable stale-takeover degradation (refs #3518).
