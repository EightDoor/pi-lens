---
section: Fixed
---

- The read-before-edit guard now follows the conversation across `/tree`,
  `/fork`, `/clone` and resume. After each move it keeps exactly the reads
  whose tool result is still on the branch; an edit backed only by a read,
  write or own edit on an abandoned branch is refused until the file is read
  again. Each kept read is re-checked line by line against the file on disk.
  A fork or clone now keeps the reads made before its fork point instead of
  losing all of them, so those edits are no longer falsely refused. Two
  known limits: a provider that reuses tool-call ids across branches can let
  a sibling branch's read count, and a `/tree` round trip back to a branch
  needs one re-read (refs #3521).
