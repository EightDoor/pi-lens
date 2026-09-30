#!/usr/bin/env node
// scripts/setup-git-hooks.mjs (#1804)
//
// Wires Husky-managed hooks (.husky/pre-commit, .husky/pre-push) into this
// clone's `core.hooksPath`, as a step inside the `prepare` npm lifecycle
// script. `prepare` also runs `build:dist` + grammar download — steps that
// consumers who install pi-lens as a dependency (`npm install --omit=dev`,
// no .git present, no devDependencies) depend on and that MUST fail loudly
// on error. Hook wiring must never share that failure path with them: it is
// dev-only and best-effort, so it lives in its own script, invoked last, and
// swallows its own errors instead of `|| true`-ing the whole `prepare` chain
// (which would also mask a real build failure).
//
// Skipped, not attempted, when:
//   - PI_LENS_SKIP_HOOKS is set   explicit opt-out (agents/CI set this) —
//                                  any non-empty value, same rule the
//                                  hooks themselves use (.husky/pre-commit,
//                                  .husky/pre-push)
//   - CI is set (not "false")     GitHub Actions sets CI=true, but other CI
//                                  runners set other truthy spellings; treat
//                                  any non-empty value other than "false" as
//                                  CI. CI never commits, hooks buy nothing.
//   - no .git here                consumer install (dependency, tarball) —
//                                  there is no repo to attach hooks to
//   - no node_modules/husky       devDependencies weren't installed
//                                  (production/consumer install)
//   - HUSKY=0                     husky's own opt-out; husky would install
//                                  nothing, so the path must not be rewritten
//
// Linked worktrees (#3674): husky writes `core.hooksPath=.husky/_`, a
// RELATIVE path, and git resolves it against each worktree's root. `.husky/_`
// (the generated stubs) is gitignored, so it only exists where husky ran, and
// every other linked worktree ran no pre-commit or pre-push at all (two PRs
// reached CI with oxfmt and tsc failures). `core.hooksPath` lives in the
// shared config, so one value serves every worktree: husky is run in, and the
// path pinned absolute to, the MAIN worktree's `.husky/_` even when `prepare`
// runs inside a linked worktree (which may be deleted later; the main
// checkout is the one tree that outlives them). Hook scripts therefore come
// from the main checkout's `.husky/`, and run in the committing worktree's
// cwd. A moved repo leaves a dangling absolute path until the next `prepare`
// rewrites it.
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

function isSet(value) {
	return typeof value === "string" && value.length > 0;
}

function isCi() {
	const value = process.env.CI;
	return isSet(value) && value.trim().toLowerCase() !== "false";
}

function skipReason() {
	if (isSet(process.env.PI_LENS_SKIP_HOOKS)) return "PI_LENS_SKIP_HOOKS is set";
	if (isCi()) return "CI is set";
	if (process.env.HUSKY === "0") return "HUSKY=0";
	if (!existsSync(".git")) return "no .git (not a clone)";
	if (!existsSync("node_modules/husky/bin.js"))
		return "husky not installed (production install)";
	return null;
}

const reason = skipReason();
if (reason) {
	console.log(`[setup-git-hooks] skipped (${reason}).`);
	process.exit(0);
}

// First `worktree` entry of `git worktree list` is always the main worktree;
// a bare main repo has no working tree to hold `.husky/_`, so fall back to
// the checkout running `prepare`.
function mainWorktreeRoot() {
	const listing = execFileSync(
		"git",
		["worktree", "list", "--porcelain", "-z"],
		{
			encoding: "utf8",
		},
	);
	const [first, second] = listing.split("\0");
	if (!first?.startsWith("worktree ") || second === "bare")
		return process.cwd();
	return first.slice("worktree ".length);
}

try {
	const huskyBin = path.resolve("node_modules/husky/bin.js");
	const root = mainWorktreeRoot();
	execFileSync(process.execPath, [huskyBin], { cwd: root, stdio: "inherit" });
	// husky reports its own refusals on stdout with exit 0; only pin the
	// absolute path when the stubs actually exist.
	const hooksDir = path.join(root, ".husky", "_");
	if (existsSync(path.join(hooksDir, "h"))) {
		execFileSync(
			"git",
			["-C", root, "config", "core.hooksPath", hooksDir.replaceAll("\\", "/")],
			{ stdio: "inherit" },
		);
	}
} catch (error) {
	// Best-effort: a broken git-hooks install must never fail `npm install`.
	console.warn(
		`[setup-git-hooks] husky install failed, continuing without local hooks: ${error instanceof Error ? error.message : error}`,
	);
}
