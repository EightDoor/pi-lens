/**
 * #3674: `scripts/setup-git-hooks.mjs` must leave hooks that run from EVERY
 * worktree of the clone, not only the checkout `prepare` ran in.
 *
 * Recurrence this pins: husky writes the RELATIVE `core.hooksPath=.husky/_`,
 * git resolves it against each worktree's root, and `.husky/_` is gitignored
 * so it exists in one tree only. Every linked worktree then ran no
 * pre-commit or pre-push, and two PRs reached CI with oxfmt and tsc failures
 * the hooks would have refused. The subject is a real git worktree layout
 * and the real script; an in-process double cannot resolve a hooksPath.
 */
// flake-shape: real-process-spawn — the subject is git's own resolution of
// core.hooksPath per worktree plus the real script and husky binary; a stub
// would only restate the path the test itself wrote.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitExecFileSync, gitFixtureEnv } from "../support/git-fixture-env.js";

const repoRoot = path.resolve(__dirname, "..", "..");
const script = path.join(repoRoot, "scripts", "setup-git-hooks.mjs");
const huskyDir = fs.realpathSync(path.join(repoRoot, "node_modules", "husky"));

let fixtureDir: string | undefined;

afterEach(() => {
	if (fixtureDir) {
		fs.rmSync(fixtureDir, { recursive: true, force: true });
		fixtureDir = undefined;
	}
});

function fixtureEnv(dir: string, overrides: Record<string, string> = {}) {
	const env: Record<string, string> = {
		...gitFixtureEnv(dir),
		HOME: dir,
		...overrides,
	};
	// The script skips under CI / opt-outs; the suite may run under any.
	for (const name of ["CI", "PI_LENS_SKIP_HOOKS", "HUSKY", "XDG_CONFIG_HOME"])
		if (!(name in overrides)) delete env[name];
	return env;
}

/** A real repo (or bare repo) with a tracked sentinel hook, and a linked worktree. */
function makeClone(options: { bareMain?: boolean } = {}) {
	fixtureDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-setup-hooks-")),
	);
	const dir = fixtureDir;
	const env = fixtureEnv(dir);
	const git = (cwd: string, ...args: string[]) =>
		gitExecFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
	const main = path.join(dir, "main");
	const linked = path.join(dir, "linked");
	fs.mkdirSync(main);
	git(main, "init", "-q", "-b", "master");
	git(main, "config", "user.email", "test@example.com");
	git(main, "config", "user.name", "pi-lens test");
	fs.mkdirSync(path.join(main, ".husky"));
	// Relative to the committing worktree's cwd: proves WHERE the hook ran.
	fs.writeFileSync(
		path.join(main, ".husky", "pre-commit"),
		"pwd -P > .hook-ran\n",
	);
	git(main, "add", ".husky/pre-commit");
	git(main, "commit", "-qm", "init");
	let origin = main;
	if (options.bareMain) {
		origin = path.join(dir, "bare.git");
		git(dir, "clone", "-q", "--bare", main, origin);
		git(origin, "worktree", "add", "-q", linked, "master");
	} else {
		git(main, "worktree", "add", "-q", "-b", "linked-branch", linked);
	}
	for (const tree of options.bareMain ? [linked] : [main, linked]) {
		fs.mkdirSync(path.join(tree, "node_modules"), { recursive: true });
		fs.symlinkSync(huskyDir, path.join(tree, "node_modules", "husky"), "dir");
	}
	const prepare = (cwd: string, overrides: Record<string, string> = {}) =>
		spawnSync(process.execPath, [script], {
			cwd,
			env: fixtureEnv(dir, overrides),
			encoding: "utf8",
		});
	const hookRan = (cwd: string) => {
		fs.rmSync(path.join(cwd, ".hook-ran"), { force: true });
		let status = 0;
		try {
			gitExecFileSync("git", ["hook", "run", "pre-commit"], {
				cwd,
				env,
				stdio: "pipe",
			});
		} catch (error) {
			status = (error as { status: number }).status;
		}
		const sentinel = path.join(cwd, ".hook-ran");
		return {
			status,
			cwd: fs.existsSync(sentinel)
				? fs.readFileSync(sentinel, "utf8").trim()
				: undefined,
		};
	};
	return { main, linked, origin, git, prepare, hookRan };
}

// POSIX shell stubs and symlinks; the authoritative Unit tests lane is ubuntu.
describe.skipIf(process.platform === "win32")(
	"setup-git-hooks: hooks run from every worktree (#3674)",
	() => {
		it("prepare in the main checkout: the linked worktree runs the hook in its own cwd", () => {
			const { main, linked, git, prepare, hookRan } = makeClone();
			const result = prepare(main);
			expect(result.status).toBe(0);
			expect(hookRan(main)).toMatchObject({ status: 0, cwd: main });
			expect(hookRan(linked)).toMatchObject({ status: 0, cwd: linked });
			expect(git(linked, "config", "core.hooksPath")).toBe(
				path.join(main, ".husky", "_"),
			);
		});

		it("prepare inside the linked worktree: hooks are generated in and pinned to the main checkout", () => {
			const { main, linked, git, prepare, hookRan } = makeClone();
			const result = prepare(linked);
			expect(result.status).toBe(0);
			expect(git(main, "config", "core.hooksPath")).toBe(
				path.join(main, ".husky", "_"),
			);
			// A linked worktree can be deleted; the pinned stubs must not live in it.
			expect(fs.existsSync(path.join(linked, ".husky", "_"))).toBe(false);
			expect(hookRan(linked)).toMatchObject({ status: 0, cwd: linked });
			expect(hookRan(main)).toMatchObject({ status: 0, cwd: main });
		});

		it("prepare inside a linked worktree of a bare main repo falls back to that worktree", () => {
			const { linked, origin, git, prepare, hookRan } = makeClone({
				bareMain: true,
			});
			const result = prepare(linked);
			expect(result.status).toBe(0);
			expect(git(origin, "config", "core.hooksPath")).toBe(
				path.join(linked, ".husky", "_"),
			);
			expect(hookRan(linked)).toMatchObject({ status: 0, cwd: linked });
		});

		it("HUSKY=0 installs nothing and leaves core.hooksPath unset", () => {
			const { main, git, prepare } = makeClone();
			const result = prepare(main, { HUSKY: "0" });
			expect(result.status).toBe(0);
			expect(result.stdout).toContain("skipped (HUSKY=0)");
			expect(() => git(main, "config", "core.hooksPath")).toThrow();
			expect(fs.existsSync(path.join(main, ".husky", "_"))).toBe(false);
		});
	},
);
