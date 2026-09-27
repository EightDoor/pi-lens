/**
 * #3496: the load-simulation pass's judgement, on hand-built verdict maps.
 *
 * Recurrence this prevents: #3493, a test whose verdict flipped when a loaded
 * runner cut a production deadline short. The pass exists to find the next
 * one; these cases pin that it reports a flip with its bound, never reads a
 * run it could not judge as clean, and cannot go vacuous (a canary that stays
 * green, an admission that no longer flips).
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	ADMITTED,
	CANARY,
	comparePassRuns,
	passExitCode,
	summaryLines,
	testPopulation,
	type Verdict,
	verdicts,
} from "../../scripts/time-bound-scale-pass.mjs";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const STEADY = "tests/a.test.ts > suite > steady";
const SENSITIVE = "tests/a.test.ts > suite > sensitive";

function run(entries: Record<string, Verdict>): Map<string, Verdict> {
	return new Map(Object.entries(entries));
}

/** Both bounds scaled, the canary flipping under each, plus `extra`. */
function scaledRuns(
	extra: Partial<Record<"capture" | "settle", Record<string, Verdict>>> = {},
) {
	return new Map([
		[
			"capture",
			run({
				[STEADY]: "passed",
				[SENSITIVE]: "passed",
				[CANARY]: "failed",
				...extra.capture,
			}),
		],
		[
			"settle",
			run({
				[STEADY]: "passed",
				[SENSITIVE]: "passed",
				[CANARY]: "failed",
				...extra.settle,
			}),
		],
	]);
}

const baseline = run({
	[STEADY]: "passed",
	[SENSITIVE]: "passed",
	[CANARY]: "passed",
});

describe("#3496 time-bound scale pass", () => {
	it("is clean when only the canary flips", () => {
		const result = comparePassRuns({
			baseline,
			scaled: scaledRuns(),
			admitted: {},
		});
		expect(result.findings).toEqual([]);
		expect(result.unjudgeable).toEqual([]);
		expect(passExitCode(result)).toBe(0);
	});

	it("reports a test that passes unscaled and fails scaled, with the bound that flipped it", () => {
		const result = comparePassRuns({
			baseline,
			scaled: scaledRuns({ settle: { [SENSITIVE]: "failed" } }),
			admitted: {},
		});
		expect(result.flips).toContainEqual({ key: SENSITIVE, bound: "settle" });
		expect(result.flips).not.toContainEqual({
			key: SENSITIVE,
			bound: "capture",
		});
		expect(result.findings).toEqual([
			`${SENSITIVE}: flips when the settle bound is scaled. Pin its bounds with _setObservedTimeBoundsForTests, or admit it in scripts/time-bound-scale-pass.mjs with a reason naming an issue`,
		]);
		expect(passExitCode(result)).toBe(1);
		expect(summaryLines(result, 0.2)).toContain(
			`FLIPPED ${SENSITIVE} [bound: settle]`,
		);
	});

	it("lists an admitted flip without a finding, and reds an admission that no longer flips", () => {
		const admitted = {
			[SENSITIVE]: "#3496: flips on the stub clock, not the host",
		};
		const flipping = comparePassRuns({
			baseline,
			scaled: scaledRuns({ capture: { [SENSITIVE]: "failed" } }),
			admitted,
		});
		expect(flipping.flips).toContainEqual({ key: SENSITIVE, bound: "capture" });
		expect(flipping.findings).toEqual([]);

		const dead = comparePassRuns({ baseline, scaled: scaledRuns(), admitted });
		expect(dead.findings).toEqual([
			`${SENSITIVE}: admitted but no longer flips; delete the dead admission`,
		]);
	});

	it("reds when the canary stays green under a bound: the seam ignored the scale", () => {
		const result = comparePassRuns({
			baseline,
			scaled: scaledRuns({ settle: { [CANARY]: "passed" } }),
			admitted: {},
		});
		expect(result.findings).toEqual([
			"canary did not flip under settle: the seam in clients/observed-mutation.ts ignored PI_LENS_TEST_TIME_BOUND_SCALE, so no other verdict here means anything",
		]);
		expect(passExitCode(result)).toBe(1);
	});

	it("cannot judge a test that is red unscaled or missing from a scaled run", () => {
		const redBaseline = comparePassRuns({
			baseline: run({ ...Object.fromEntries(baseline), [STEADY]: "failed" }),
			scaled: scaledRuns({ settle: { [STEADY]: "failed" } }),
			admitted: {},
		});
		// Red before any scaling is not a flip, and not clean either.
		expect(redBaseline.flips.map((flip) => flip.key)).not.toContain(STEADY);
		expect(redBaseline.unjudgeable).toEqual([
			`${STEADY}: failed without any scaling`,
		]);
		expect(passExitCode(redBaseline)).toBe(2);

		const capture = run({ [SENSITIVE]: "passed", [CANARY]: "failed" });
		const missing = comparePassRuns({
			baseline,
			scaled: new Map([
				["capture", capture],
				[
					"settle",
					run({
						[STEADY]: "passed",
						[SENSITIVE]: "passed",
						[CANARY]: "failed",
					}),
				],
			]),
			admitted: {},
		});
		expect(missing.unjudgeable).toEqual([
			`${STEADY}: missing from the capture-scaled run`,
		]);
		expect(passExitCode(missing)).toBe(2);
	});

	it("keys verdicts by file and titles, and leaves skipped and todo cases out", () => {
		const report = {
			testResults: [
				{
					name: path.join(REPO_ROOT, "tests/a.test.ts"),
					assertionResults: [
						{ ancestorTitles: ["suite"], title: "steady", status: "passed" },
						{ ancestorTitles: ["suite"], title: "sensitive", status: "failed" },
						{ ancestorTitles: ["suite"], title: "later", status: "skipped" },
						{ ancestorTitles: ["suite"], title: "someday", status: "todo" },
					],
				},
			],
		};
		expect(verdicts(report, REPO_ROOT)).toEqual(
			run({ [STEADY]: "passed", [SENSITIVE]: "failed" }),
		);
		expect(() => verdicts({}, REPO_ROOT)).toThrow("not a Vitest JSON report");
	});

	it("derives its population from the tree, and every name it trusts is in it", () => {
		const population = testPopulation(REPO_ROOT);
		expect(population).toContain(
			"tests/clients/observed-mutation-integration.test.ts",
		);
		expect(population).not.toContain(
			"tests/scripts/time-bound-scale-pass.test.ts",
		);
		// A canary or admission outside the population can never flip, so the
		// pass would red on it forever rather than on the thing it names.
		for (const key of [CANARY, ...Object.keys(ADMITTED)])
			expect(population, key).toContain(key.split(" > ")[0]);
	});
});
