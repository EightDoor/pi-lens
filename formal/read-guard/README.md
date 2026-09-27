# Read-guard model

A TLA+ model of the read-before-edit guard (`clients/read-guard.ts`) for one
file. It covers the agent's reads and edits, pi-lens' own writes (the
immediate autofix, the deferred `agent_end` format), another writer, and
session boundaries. The `TLA+ models` CI job
(`node scripts/check-tla-models.mjs`) checks every config here against its
`\* expect:` line.

Issues: #3519, #3521, #3523 and #3524 are fixed in the code and modelled as
such. The configs for #3520, #3522 and #3525 still document their bugs
against the current code (`violated`).

## Scope

The model covers **positional** edits: `oldRange`, `edits[].range`, and the
hashline adapters. The guard fully enforces only this class. An `oldText` edit
is content-validated by the host, so `checkEdit` gets `skipSnapshotCheck` and
`oldTextResolved` (`runtime-tool-call.ts` ~1575). For such an edit, FileTime and
the snapshot are skipped and out-of-range is only a warning. The only checks
left are zero-read and the bridge content binding.

A file is a sequence of line tokens. Every write mints fresh tokens, so token
equality is `lineContentHash` equality. A whitespace-only rewrite counts as no
change.

## Actors

- **The agent**, one tool at a time (pi awaits each handler):
  - **read** (full or ranged): the tool_call provisional record, which takes
    a FileTime stamp (`runtime-tool-call.ts` ~1054), the host read, then the
    tool_result record that supersedes it (`runtime-tool-result.ts` ~1797).
    Since #3524, when the file moved after the tool_call's stamp, that record
    is hashed and sized from the delivered text and keeps the stamp;
  - **positional edit** of 1 or 2 lines: `checkEdit` at tool_call (~1572),
    optional relocation (~1585), the host apply, then `recordWritten` at
    tool_result (~2367). Since #3523, an edit the guard allowed unrelocated
    (`markToolCallEditInPlace`, ~1628) is recorded as a read of the lines it
    wrote, hashed from its `newText` (`runtime-tool-result.ts` ~2316);
  - **write**: `noteCreatedFile` at tool_call, the host write, and
    `recordWritten`, which injects the creation read from disk
    (`read-guard.ts` `injectCreationRead`, ~1568). The turn's first write then
    runs the immediate autofix (`pipeline.ts`), calls `recordWritten` again
    (`runtime-tool-result.ts` ~1107), and attaches the post-fix bytes as
    "authoritative" (~2871). Since #3519 the attachment, when delivered, is
    recorded as a whole-file read hashed from the attached bytes (~2934).
- **Another writer** (an external editor, a second pi-lens instance, git):
  changes the file between any two steps. With `ExtPhases` it can land inside
  a tool call.
- **The deferred `agent_end` format drain**: rewrites the file, then calls
  `recordWritten` (`runtime-agent-end.ts`). With `DrainMode = "atomic"` it
  runs inside the turn boundary. With `"unfenced"` or `"fenced"` it is queued
  at `Settle` (pi's `agent_settled`, when pi already accepts `/tree`) with
  the branch epoch it captured, and lands in `Drain`, possibly after a
  `/tree`. `"fenced"` (the code since #3521 review F1) refuses its
  `recordWritten` once a `/tree` bumped the epoch.
- **Boundaries**:
  - user turn;
  - `/new` (a fresh guard);
  - `/fork` (a fresh guard in a new activation; pi forks *before* a chosen
    user message, so the conversation loses everything after it);
  - `/tree` (the conversation moves inside the same activation).

  Since #3521 (`BranchFilter`), both keep exactly the records whose tool
  result is on the new branch, each whole, and clear the FileTime stamp,
  `writtenThisSession`, pending creations and the edit history, and
  re-anchor the mtime fallback (`read-guard.ts` `retainBranch` /
  `importBranch`, `index.ts` `session_tree` and `session_start`). Before it,
  `/fork` imported nothing (pi re-runs the extension factory, so the
  closure-local stash died) and `/tree` had no handler.

`know` is what the conversation has shown the agent: read results, its own
edits and writes, and the authoritative attachment.

## Switches

The current code is `HandlerEvidence = FALSE`, `CreationHandlerEvidence =
TRUE`, `RecordAuthoritative = TRUE`, `RecordOwnEdit = TRUE`,
`OwnEditSkipsReloc = TRUE`, `MtimeAuthored = TRUE`, `OwnEditRescue = TRUE`,
`BranchFilter = TRUE`, `SuppressByNewerContext = TRUE`, `FormatStamp = TRUE`,
`SpanSnapshot = FALSE`, `RelocFromLatest = FALSE`, `ForkAtBoundary = FALSE`,
`DrainMode = "fenced"` (every config before #3521 round 2 keeps `"atomic"`,
its old shape). `ForkImport` is read only when `BranchFilter = FALSE`; the code before #3521
was `ForkImport = FALSE` (the fork imported nothing), not `TRUE` as this file
used to say.
A config that turns one of these off either names the bug it isolates (for
example `MtimeAuthored = FALSE` in `Guarded`, so bug 2 does not mask the rest)
or is a mutant of this PR's fixes (`*NoRecord`, `EvidenceAtResultHandler`,
`OwnEditRelocRecorded`).

## Guard (as coded)

The model follows `checkEdit` step by step:

- **Zero-read.** `wasWrittenThisSession`: `writtenThisSession`, or
  `mtime >= sessionStartMs`.
- **FileTime.** Whole-file mtime/ctime/size. The rescues are
  `canTreatStalenessAsOwnPriorEdit` and `canIgnoreStalenessByHashes`.
- **Coverage.** `checkCoverage`: the union of non-provisional ranges, widened
  by `contextLines`.
- **Snapshot.** `validateRangeSnapshot`: context-widened candidates,
  checked/unavailable, and the "a newer unavailable candidate cancels the
  mismatch" rule.
- **Relocation.** `findRelocation`: the newest read with hashes for the whole
  range, which must match uniquely.

## Invariants

| Invariant | Promise |
|---|---|
| `NoStaleAllow` | An allowed or relocated edit of lines the agent was shown lands on lines that still hold what it was shown. `read-guard.ts` header items 2-3; `importBranch` never re-hashes a record from today's disk. |
| `NoBlindAllow` | An edit of lines this conversation never showed the agent is refused. Header item 1, "Read state from session 1 never authorises session 2". With `contextLines > 0` the guard admits ±contextLines by design (`ContextSlack`). |
| `NoFalseBlock` | With hashes, an edit whose target lines hold exactly what the agent was shown is never refused. The attachment is "authoritative for subsequent edits". `recordWritten` exists so an own write "doesn't trigger file_modified". |

`NoStaleAllow` and `NoFalseBlock` are the two directions of catalog shape 54:
a record built from the conversation's bytes must neither pass a stale edit
nor refuse an exact one.

## Results

TLC 2.19 (`tla2tools.jar` v1.7.4), `-workers auto`. Times were measured on a
loaded machine (load average about 6-8 on 4 cores): 80 s for the 30 configs
before #3521 (82 s wall at `-workers 2`), `NewSession` the slowest at 14 s.
With #3521's eight configs and the deterministic `-workers 1` (#3517), the
36 configs took 164 s one after another at load average about 4-6; the
#3521 configs were 56 s of that, `TreeFilterExt` the slowest at 21 s. The
three drain configs of #3521 round 2 took 13 s, 4 s and 4 s at load average
about 45.

`Guarded` runs at three agent ops to fit CI's `TLA+ models` budget (#3572).
At three ops, every mutant keeps its verdict and the #3523 flip still flips.
The four-op interleaving (for example two reads and two edits) was checked
only once, at the old bound: it passed with 969,664 distinct states on the
head that added this model. It is not checked in CI.

| Config | Models | Expect | Distinct states |
|---|---|---|---|
| `AutofixFalseBlock` | #3519 fixed: a one-line edit of the attached content | pass | 19 |
| `AutofixFalseBlockNoRecord` | the same without the attachment record (the code before #3519) | violated `NoFalseBlock` | 12 |
| `AutofixRelocate` | #3519 fixed: a two-line edit of the attached content | pass | 19 |
| `AutofixRelocateNoRecord` | the same without the attachment record | violated `NoStaleAllow` | 13 |
| `AutofixRecorded` | #3519 fixed, another writer anywhere, 1- and 2-line edits | pass | 334 |
| `AutofixRecordedNoRecord` | the same without the attachment record | violated `NoFalseBlock` | 105 |
| `AutofixPastEnd` | remainder (#3522 part 3): an older whole-file read still covers a line past the attachment's end | violated `NoBlindAllow` | 22 |
| `OwnReEdit` | #3523 fixed: the agent re-edits a line it just wrote | pass | 2,036 |
| `OwnReEditNoRecord` | the same without the own-edit record (the code before #3523) | violated `NoFalseBlock` | 327 |
| `OwnEditReloc` | #3523 fixed: a relocated edit is not recorded; write + autofix, an other-writer insert, a relocated edit, then an edit | pass | 1,608 |
| `OwnEditRelocRecorded` | the same with a relocated edit recorded | violated `NoStaleAllow` | 535 |
| `EvidenceAtResult` | #3524 fixed: another writer lands between the host read and the tool_result | pass | 23,571 |
| `EvidenceAtResultHandler` | the same with the read taken from disk at tool_result (the code before #3524) | violated `NoStaleAllow` | 316 |
| `EvidenceFromDelivered` | #3524 fixed, another writer anywhere, replace/delete/insert | pass | 93,904 |
| `CreationAtResult` | remainder of #3524: the injected creation read still hashes the disk | violated `NoStaleAllow` | 1,291 |
| `Guarded` | current code, reads, one-line edits, another writer between tool calls, three agent ops (#3572) | pass (all three invariants) | 69,531 |
| `GuardedNoCoverage` / `GuardedNoSnapshot` | `Guarded` without `checkCoverage` / `validateRangeSnapshot` | violated `NoBlindAllow` / `NoStaleAllow` | 100 / 3,830 |
| `NewSession` | current code across `/new` | pass | 316,790 |
| `Unhashed` / `UnhashedNoFileTime` | current code without line hashes / without FileTime | pass / violated `NoStaleAllow` | 13,370 / 243 |
| `ContextSlack` | the admitted `contextLines` slack | violated `NoBlindAllow` | 79 |
| `MtimeAuthored`, `MtimeAuthoredNew` | #3520 | violated `NoBlindAllow` | 9 / 36 |
| `TreeFilter` | #3521 fixed: `/tree` with reads, ranged reads, edits and writes | pass | 50,413 |
| `TreeFilterMtime` | the same with the #3520 mtime fallback on: the re-anchored `born` | pass | 50,413 |
| `TreeFilterExt` | #3521 fixed, another writer anywhere | pass | 344,765 |
| `TreeFilterUnhashed` | #3521 fixed without hashes (the #3525 rescue off, as in `Unhashed`) | pass | 1,174 |
| `TreeCarriesReads` | the same as `TreeFilter`'s base with `BranchFilter = FALSE` (the code before #3521: no handler) | violated `NoBlindAllow` | 337 |
| `ForkFilter` | #3521 fixed: `/fork` | pass | 50,036 |
| `ForkFilterUnhashed` | #3521 fixed at `/fork` without hashes | pass | 1,150 |
| `ForkDropsReads` | `BranchFilter = FALSE`, `ForkImport = FALSE` (the code before #3521: the fork imports nothing) | violated `NoFalseBlock` | 876 |
| `TreeDrainFenced` | #3521 review F1 fixed: the settle drain lands after a `/tree` and its stamp is refused | pass | 132,248 |
| `TreeDrainUnfenced` | the same, stamp credited (the code before round 2) | violated `NoBlindAllow` | 2,457 |
| `TreeDrainFencedMtime` | the fenced drain with the #3520 mtime fallback: the formatter write postdates the re-anchor (residual until #3520) | violated `NoBlindAllow` | 2,457 |
| `ContextSuppress`, `SpanAcrossReads` | #3522 | violated `NoStaleAllow` | 2,905 / 2,964 |
| `UnhashedOwnEditRescue`, `UnhashedFormatStamp` | #3525 | violated `NoStaleAllow` | 449 / 160 |

`OwnEditReloc` and `OwnEditRelocRecorded` set `CreationHandlerEvidence =
FALSE`, so the creation-read race `CreationAtResult` documents cannot mask the
relocation check.

The investigation's configs for the candidate fixes of #3520, #3522
and #3525 (`AllFixes`, `AllFixesCtx`, `SpanSnapshotFix*`, `UnhashedFix`,
`NoMtimeAuthored`, `ForkAtBoundary`, `ForkImportWholeRecord`,
`OwnEditRecorded*`, `OwnEditRescueContext`) are not here; each arrives with its
fix. All of them keep their verdicts under this version of the model.
`OwnEditRescueContext` (#3525's hashed case, a hybrid with the #3522 fix on)
passes once #3523's own-edit record is on.

## Replays

`tests/clients/read-guard-conversation-evidence.test.ts` replays the fixed
configs through the real `handleToolCall` / `handleToolResult`, with pi's real
`read` tool. The case names end with the config they replay, for example
"allows re-editing the line the agent just wrote (OwnReEdit)".

## Limits

- One file, one agent tool at a time. Parallel batches are not modelled (pi
  runs every `tool_call` of a batch before any tool executes), nor is #3506's
  autofix-versus-concurrent-edit race.
- FileTime detects every write. Real mtime/ctime/size can miss an equal-size
  rewrite inside one timestamp tick.
- No clock: `canTreatStalenessAsOwnPriorEdit`'s 120 s window is always open,
  and its `latest.timestamp < lastReadTimestamp` check is not modelled. In the
  code, an own-edit record made in the same millisecond as the edit's verdict
  leaves the rescue on, and the range-stale 60 s grace then warns instead of
  blocking (#3525).
- The attachment record and the `recordWritten` before it are one step here.
  In the code they are separated by the pipeline's analysis; the record
  leaves FileTime to `recordWritten`, which the replays pin.
- Symbol (LSP-expanded) coverage, search-hit credits, bash read spans, the
  bridge `contentBinding`, record and file caps, idle eviction, and
  exemptions are not modelled.
- The host rejects edits past EOF, so the model does not count them.
- The TOCTOU between `checkEdit` at tool_call and the host's positional apply
  is not modelled.
- `/fork` and `/tree` only reach "before the current prompt"
  (`BeforePrompt`, `r.g < turnNo`), and the model's records are matched to
  the branch exactly. The code matches a record to the branch by its tool
  call's `toolResult` on `getBranch()`, which also covers mid-turn targets,
  forward and sibling moves, `/clone` and resume; those are replayed through
  pi's real runtime in `tests/index-3521-fork-tree-witness.test.ts`. The
  accepted residual there, a provider that reuses tool-call ids across
  branches, is not modelled. Clearing the edit history at a move
  (`lastEditOk' = FALSE`) is inert in every config here, because the
  snapshot check already refuses a hashed stale edit and the unhashed
  configs turn the rescue off; `tests/clients/read-guard-branch.test.ts`
  pins it on the code.
- `SettleDue` keeps every boundary out until `Settle` has captured the
  branch epoch: pi marks the run inactive and then invokes the
  `agent_settled` handlers, so pi-lens's handler captures before any `/tree`
  can land. An extension whose `agent_settled` handler runs before
  pi-lens's and awaits long enough for a `/tree` breaks that ordering, and
  the drain's stamp is then credited (mutating the gate away violates
  `TreeDrainFenced`). The settled sweep is one more deferred writer with the
  same fence; the model's drain stands for both.
