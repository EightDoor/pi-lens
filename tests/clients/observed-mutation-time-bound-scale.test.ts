/**
 * #3496: the load-simulation seam on the observational net's wall-clock
 * bounds.
 *
 * Recurrence this prevents: #3493. A loaded runner let the 50 ms settle
 * deadline cut a directory target's 33rd entry, so the dispatch-cap case saw
 * 32 changes and wrote no cap record, on a tree identical to a green head.
 * Nothing in the test's source was a timer, so no source scan could see it.
 * `PI_LENS_TEST_TIME_BOUND_SCALE` is what lets `scripts/time-bound-scale-pass.mjs`
 * shrink those bounds on purpose; these cases pin that the scale reaches each
 * bound, reaches only the bound it names, loses to a test's own pin, and is
 * inert when unset.
 *
 * Fake timers, not a loaded host: `bounded()` arms its timer synchronously
 * inside the call, so advancing the fake clock by 20 ms before any I/O callback
 * can run decides the race deterministically. Every unscaled timer bound
 * (200 ms capture, 200 ms settle race, 400 ms sweep race) sits above 20 ms; at
 * the 0.01 scale below every one sits under it. The turn budget needs no clock
 * at all: the probe spends all but 3 ms of it, so any scale under 0.995 leaves
 * nothing and the arm reports `budget-exhausted`.
 *
 * Every case stubs both variables itself, so the pass's own environment cannot
 * reach them. The one exception is the canary, which reads the ambient
 * environment on purpose: the pass expects it to flip under each bound, and a
 * seam that ignores the scale leaves it green, which the pass reports.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetDegradationLedger } from "../../clients/degradation-ledger.js";
import { resetMutationAttribution } from "../../clients/mutation-attribution.js";
import {
	_setObservedTimeBoundsForTests,
	_setObservedTurnBudgetForTests,
	armObservedMutation,
	noteMutationHandled,
	OBSERVED_TURN_BUDGET_MS,
	refreshObservedMutationLedger,
	resetObservedMutationNet,
	runObservedSettledSweep,
	settleObservedMutation,
} from "../../clients/observed-mutation.js";
import { setupTestEnvironment } from "./test-utils.js";

const SOURCE = ["const a = 1;", "const b = 2;", "const c = 3;", ""].join("\n");
const NAMES = ["a1.ts", "a2.ts", "a3.ts", "a4.ts", "a5.ts"];
const BOUNDS = ["capture", "settle", "sweep", "turn"] as const;
type Bound = (typeof BOUNDS)[number];
/** Every scaled bound below lands under this; every unscaled one above it. */
const ADVANCE_MS = 20;
const SCALE = "0.01";
/**
 * The canary's advance per bound: 1 ms under that bound's unscaled race (the
 * 200 ms capture budget, the 4 x 50 ms settle race, the 2 x 200 ms sweep
 * race), so it passes unscaled and flips under ANY scale the pass can use
 * (below 0.995), not only under 0.01. The turn probe needs no clock.
 */
const CANARY_ADVANCE_MS: Record<Bound, number> = {
	capture: 199,
	settle: 199,
	sweep: 399,
	turn: 0,
};

let env: ReturnType<typeof setupTestEnvironment>;
let dir: string;

beforeEach(() => {
	resetObservedMutationNet();
	resetMutationAttribution();
	resetDegradationLedger();
	vi.stubEnv("PI_LENS_TEST_TIME_BOUND_SCALE", undefined);
	vi.stubEnv("PI_LENS_TEST_TIME_BOUND", undefined);
	env = setupTestEnvironment("pi-lens-3496-scale-");
	dir = path.join(env.tmpDir, "target");
	fs.mkdirSync(dir);
	for (const name of NAMES) fs.writeFileSync(path.join(dir, name), SOURCE);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	_setObservedTimeBoundsForTests({});
	env.cleanup();
});

/** Start `work` on the fake clock, advance it, and hand back the real one. */
function onFakeClock<T>(work: () => Promise<T>, advanceMs: number): Promise<T> {
	vi.useFakeTimers();
	const running = work();
	vi.advanceTimersByTime(advanceMs);
	vi.useRealTimers();
	return running;
}

function arm(toolCallId: string, advanceMs: number) {
	return onFakeClock(
		() =>
			armObservedMutation({
				toolCallId,
				toolName: "dir_codemod",
				targetPath: dir,
				cwd: env.tmpDir,
				sessionGeneration: 1,
				turnIndex: 1,
			}),
		advanceMs,
	);
}

/**
 * Arm with the clock never advanced (so no bound can cut the baseline, on any
 * host), change every entry, then settle and advance by `advanceMs`.
 */
async function settle(toolCallId: string, advanceMs: number) {
	expect(await arm(toolCallId, 0)).toMatchObject({ armed: true });
	for (const name of NAMES)
		fs.writeFileSync(path.join(dir, name), `${SOURCE}const d = 4;\n`);
	return onFakeClock(
		() =>
			settleObservedMutation({
				toolCallId,
				toolName: "dir_codemod",
				sessionGeneration: 1,
				turnIndex: 1,
				record: () => true,
			}),
		advanceMs,
	);
}

/** Whether the operation `bound` gates ran to completion. */
async function completes(
	bound: Bound,
	id: string,
	advanceMs = ADVANCE_MS,
): Promise<boolean> {
	if (bound === "capture") return (await arm(id, advanceMs)).armed;
	if (bound === "turn") {
		_setObservedTurnBudgetForTests(1, OBSERVED_TURN_BUDGET_MS - 3);
		return (await arm(id, 0)).armed;
	}
	if (bound === "settle") return !(await settle(id, advanceMs)).stoppedEarly;
	const files = NAMES.map((name) => path.join(dir, name));
	const swept = await onFakeClock(
		() =>
			runObservedSettledSweep({
				turnIndex: 1,
				getTrackedPaths: () => files,
				record: () => true,
			}),
		advanceMs,
	);
	// The post-drain refresh reads the same bound over the handled set.
	for (const file of files) noteMutationHandled(file);
	const refreshed = await onFakeClock(
		() => refreshObservedMutationLedger({ turnIndex: 1 }),
		advanceMs,
	);
	return (
		swept.reason === undefined &&
		swept.scanned === NAMES.length &&
		refreshed === NAMES.length
	);
}

describe("#3496 PI_LENS_TEST_TIME_BOUND_SCALE", () => {
	it("leaves every bound at its production value when the scale is unset or not a positive number", async () => {
		for (const value of [undefined, "", "0", "-1", "fast"]) {
			vi.stubEnv("PI_LENS_TEST_TIME_BOUND_SCALE", value);
			for (const bound of BOUNDS) {
				// A fresh net per probe: repeated arms in one turn would otherwise
				// spend the per-turn budget and read as the scale's doing.
				resetObservedMutationNet();
				resetMutationAttribution();
				expect(
					await completes(bound, `call-${bound}-${value ?? "unset"}`),
					`${bound} at scale=${value}`,
				).toBe(true);
			}
		}
	});

	it.each(BOUNDS)(
		"shrinks the %s bound when it or no bound is named, and only it",
		async (bound) => {
			vi.stubEnv("PI_LENS_TEST_TIME_BOUND_SCALE", SCALE);
			expect(await completes(bound, `call-${bound}-all`), "all named").toBe(
				false,
			);
			vi.stubEnv("PI_LENS_TEST_TIME_BOUND", bound);
			for (const probe of BOUNDS) {
				resetObservedMutationNet();
				resetMutationAttribution();
				// The arm's timeout is min(turn budget left, capture budget), as in
				// production, so a shrunk turn budget cuts the capture probe too.
				const cut =
					probe === bound || (bound === "turn" && probe === "capture");
				expect(
					await completes(probe, `call-${bound}-${probe}`),
					`${probe} with only ${bound} named`,
				).toBe(!cut);
			}
		},
	);

	it("loses to a bound the test pinned through _setObservedTimeBoundsForTests", async () => {
		// The #3494 seam is how a test says "my verdict is about WHAT was seen,
		// not how fast the host is"; the pass must not report such a test.
		vi.stubEnv("PI_LENS_TEST_TIME_BOUND_SCALE", SCALE);
		vi.stubEnv("PI_LENS_TEST_TIME_BOUND", undefined);
		_setObservedTimeBoundsForTests({
			captureMs: 200,
			settleMs: 50,
			sweepMs: 200,
		});
		for (const bound of ["capture", "settle", "sweep"] as const) {
			resetObservedMutationNet();
			resetMutationAttribution();
			// The turn budget has no pin, so name the pinned bound alone.
			vi.stubEnv("PI_LENS_TEST_TIME_BOUND", bound);
			expect(await completes(bound, `call-pinned-${bound}`), bound).toBe(true);
		}
	});

	it("canary: an unpinned observation completes under the ambient bounds", async () => {
		// The pass's liveness probe. Unscaled (every normal run) every
		// operation completes. Under the pass's scaled environment the named
		// bound cuts its own operation, so the pass expects THIS case to flip for
		// each bound; if it stays green the seam ignored the scale and the pass
		// says so.
		vi.unstubAllEnvs();
		for (const bound of BOUNDS) {
			resetObservedMutationNet();
			resetMutationAttribution();
			expect(
				await completes(
					bound,
					`call-canary-${bound}`,
					CANARY_ADVANCE_MS[bound],
				),
				bound,
			).toBe(true);
		}
	});
});
