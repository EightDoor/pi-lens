---
section: Fixed
---

- A web-tree-sitter runtime trap (`table index is out of bounds`, `memory access out of bounds`, `null function or function signature mismatch`) while one file's symbols were being extracted no longer fails the whole review-graph build. That file degrades to not-parsed, so the existing zero-symbol LSP fallback applies, and the build completes with every other file's symbols. Each trap recycles the tree-sitter parsers and tree cache and is counted as a `wasm-trap` degradation. After three traps in one process, the next one is treated as a wasm abort: tree-sitter is disabled and a restart is required, as for any abort. If a trap still reaches the build's catch, `build_failed` carries `failureClass: "wasm-trap"`, and the per-edit cascade reports a degraded graph instead of a computation error (closes #3605).
