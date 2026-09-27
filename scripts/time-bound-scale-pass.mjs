#!/usr/bin/env node
/**
 * #3496: the load-simulation pass. Finds tests whose verdict depends on a
 * production wall-clock bound, before a loaded runner does.
 *
 * Recurrence: #3493. The observed-mutation dispatch-cap case went red on a
 * tree identical to a green head, because a loaded runner let the 50 ms settle
 * deadline in `clients/observed-mutation.ts` cut a directory's 33rd entry. The
 * test had no timer, spawn or elapsed-time assertion, so the flake-shape
 * ratchet (a source scan) could not see it. Whether an assertion flips when a
 * production deadline expires early is a runtime property, so this checks it at
 * runtime: it runs the suites that reach those bounds once as they are, then
 * once per bound with that bound shrunk through `PI_LENS_TEST_TIME_BOUND_SCALE`
 * and `PI_LENS_TEST_TIME_BOUND`, and reports every test that passed unscaled
 * and failed scaled, with the bound that flipped it.
 *
 * A flip is a finding unless `ADMITTED` names it with a reason. The canary in
 * `tests/clients/observed-mutation-time-bound-scale.test.ts` must flip under
 * every bound: if it stays green, the seam ignored the scale and every other
 * "no flip" is vacuous, so the pass fails.
 *
 * Exit codes: 0 clean, 1 findings (unadmitted flip, dead admission, canary
 * that did not flip), 2 the pass could not judge (a report is missing, or a
 * test is already red or absent unscaled).
 *
 * Usage: node scripts/time-bound-scale-pass.mjs [--scale 0.2]
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The bounds `scaledBoundMs` in clients/observed-mutation.ts accepts by name. */
export const TIME_BOUNDS = Object.freeze(["capture", "settle"]);

export const DEFAULT_SCALE = 0.2;

/** Expected to flip under every bound; see the module doc. */
export const CANARY =
	"tests/clients/observed-mutation-time-bound-scale.test.ts > #3496 PI_LENS_TEST_TIME_BOUND_SCALE > canary: an unpinned observation completes under the ambient bounds";

/**
 * Known flips, keyed like `verdicts` keys, each with a reason that names the
 * issue tracking it. A flip admitted here is sensitive to the bound's VALUE
 * but not to host speed, so pinning it would hide what it asserts.
 */
export const ADMITTED = Object.freeze({
	"tests/clients/observed-mutation-net.test.ts > #2449 review round 2 — the settle is not budget-gated > completes for EVERY watched entry with the per-turn budget already spent":
		"#3496: its clock is a 2 ms-per-read Date.now stub, so the settle deadline is spent on stub ticks, not host time, and a loaded runner cannot move it; it asserts the real 50 ms deadline against a 1 ms clamp, so a 0.2x scale flipping it is the case working",
});

/**
 * The suites that reach the scaled bounds: every test file that imports the
 * module holding them. Derived from the tree, not listed, so a new suite that
 * reaches the net joins the pass without an edit here.
 */
export function testPopulation(repoRoot) {
	const found = [];
	const walk = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const absolute = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(absolute);
			else if (
				entry.name.endsWith(".test.ts") &&
				fs
					.readFileSync(absolute, "utf8")
					.includes("clients/observed-mutation.js")
			) {
				found.push(path.relative(repoRoot, absolute).split(path.sep).join("/"));
			}
		}
	};
	walk(path.join(repoRoot, "tests"));
	return found.sort();
}

/**
 * `<file> > <describe> > ... > <test>` -> "passed" | "failed" from a Vitest
 * JSON report. Skipped and todo cases carry no verdict and are left out.
 */
export function verdicts(report, repoRoot) {
	if (!report || !Array.isArray(report.testResults))
		throw new Error("not a Vitest JSON report (no testResults array)");
	const out = new Map();
	for (const file of report.testResults) {
		const relative = path
			.relative(repoRoot, file.name)
			.split(path.sep)
			.join("/");
		for (const result of file.assertionResults ?? []) {
			if (result.status !== "passed" && result.status !== "failed") continue;
			const name = [...(result.ancestorTitles ?? []), result.title].join(" > ");
			out.set(`${relative} > ${name}`, result.status);
		}
	}
	return out;
}

/**
 * Judge one unscaled run against one scaled run per bound.
 * `scaled` maps a bound name to its verdicts.
 */
export function comparePassRuns({
	baseline,
	scaled,
	admitted = ADMITTED,
	canary = CANARY,
}) {
	const flips = [];
	const unjudgeable = [];
	for (const [key, status] of baseline)
		if (status !== "passed")
			unjudgeable.push(`${key}: failed without any scaling`);
	for (const [bound, run] of scaled) {
		for (const [key, status] of baseline) {
			if (status !== "passed") continue;
			const after = run.get(key);
			if (after === undefined)
				unjudgeable.push(`${key}: missing from the ${bound}-scaled run`);
			else if (after === "failed") flips.push({ key, bound });
		}
	}
	const findings = [];
	for (const bound of scaled.keys())
		if (!flips.some((flip) => flip.key === canary && flip.bound === bound))
			findings.push(
				`canary did not flip under ${bound}: the seam in clients/observed-mutation.ts ignored PI_LENS_TEST_TIME_BOUND_SCALE, so no other verdict here means anything`,
			);
	for (const flip of flips) {
		if (flip.key === canary || flip.key in admitted) continue;
		findings.push(
			`${flip.key}: flips when the ${flip.bound} bound is scaled. Pin its bounds with _setObservedTimeBoundsForTests, or admit it in scripts/time-bound-scale-pass.mjs with a reason naming an issue`,
		);
	}
	for (const key of Object.keys(admitted))
		if (!flips.some((flip) => flip.key === key))
			findings.push(
				`${key}: admitted but no longer flips; delete the dead admission`,
			);
	return { flips, findings, unjudgeable };
}

/** 2 when the pass could not judge, 1 on findings, 0 clean. */
export function passExitCode({ findings, unjudgeable }) {
	if (unjudgeable.length > 0) return 2;
	return findings.length > 0 ? 1 : 0;
}

/** The summary lines: one per flip, with the bound that flipped it. */
export function summaryLines({ flips, findings, unjudgeable }, scale) {
	return [
		`time-bound scale pass (scale ${scale})`,
		...flips.map((flip) => `FLIPPED ${flip.key} [bound: ${flip.bound}]`),
		...findings.map((finding) => `FINDING ${finding}`),
		...unjudgeable.map((line) => `UNJUDGEABLE ${line}`),
	];
}

function runVitest(repoRoot, files, extraEnv, outFile) {
	// The unscaled run must not inherit a scale from the caller's shell.
	const env = { ...process.env };
	delete env.PI_LENS_TEST_TIME_BOUND_SCALE;
	delete env.PI_LENS_TEST_TIME_BOUND;
	Object.assign(env, extraEnv);
	spawnSync(
		process.execPath,
		[
			path.join(repoRoot, "node_modules/vitest/vitest.mjs"),
			"run",
			...files,
			"--reporter=json",
			`--outputFile=${outFile}`,
		],
		{ cwd: repoRoot, env, stdio: ["ignore", "ignore", "inherit"] },
	);
	if (!fs.existsSync(outFile))
		throw new Error(`vitest wrote no report to ${outFile}`);
	return verdicts(JSON.parse(fs.readFileSync(outFile, "utf8")), repoRoot);
}

function main() {
	const repoRoot = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"..",
	);
	const scaleIndex = process.argv.indexOf("--scale");
	const scale =
		scaleIndex === -1 ? DEFAULT_SCALE : Number(process.argv[scaleIndex + 1]);
	if (!(scale > 0 && scale < 1)) {
		console.error(
			`--scale must be a number between 0 and 1, got ${process.argv[scaleIndex + 1]}`,
		);
		return 2;
	}
	const files = testPopulation(repoRoot);
	const work = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-time-bound-scale-"),
	);
	try {
		const baseline = runVitest(
			repoRoot,
			files,
			{},
			path.join(work, "baseline.json"),
		);
		const scaled = new Map();
		for (const bound of TIME_BOUNDS)
			scaled.set(
				bound,
				runVitest(
					repoRoot,
					files,
					{
						PI_LENS_TEST_TIME_BOUND_SCALE: String(scale),
						PI_LENS_TEST_TIME_BOUND: bound,
					},
					path.join(work, `${bound}.json`),
				),
			);
		const result = comparePassRuns({ baseline, scaled });
		const lines = summaryLines(result, scale);
		console.log(`population: ${files.length} file(s)\n${files.join("\n")}`);
		console.log(lines.join("\n"));
		if (process.env.GITHUB_STEP_SUMMARY)
			fs.appendFileSync(
				process.env.GITHUB_STEP_SUMMARY,
				`${lines.join("\n")}\n`,
			);
		return passExitCode(result);
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	process.exitCode = main();
}
