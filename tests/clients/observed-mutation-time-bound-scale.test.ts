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
 * can run decides the race deterministically. Every unscaled bound (200 ms
 * capture, 50 ms settle deadline, 200 ms sweep window) sits above 20 ms; at
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
/**
 * One probe per call site that reads a bound, keyed to the bound it reads:
 * the sweep bound is read by the settled sweep AND the post-drain refresh, so
 * a site that stopped reading it shows up as its own probe.
 */
const PROBES = {
	capture: "capture",
	settle: "settle",
	sweep: "sweep",
	refresh: "sweep",
	turn: "turn",
} as const satisfies Record<string, Bound>;
type Probe = keyof typeof PROBES;
const PROBE_NAMES = Object.keys(PROBES) as Probe[];
/** Every scaled bound below lands under this; every unscaled one above it. */
const ADVANCE_MS = 20;
const SCALE = "0.01";
/**
 * The canary's advance per probe: 1 ms under that site's unscaled bound (the
 * 200 ms capture budget, the 50 ms settle per-entry deadline, the 200 ms sweep
 * window), so it passes unscaled and flips under ANY scale the pass can use
 * (below 0.995), not only under 0.01. The turn probe needs no clock.
 */
const CANARY_ADVANCE_MS: Record<Probe, number> = {
	capture: 199,
	settle: 49,
	sweep: 199,
	refresh: 199,
	turn: 0,
};

let env: ReturnType<typeof setupTestEnvironment>;
let dir: string;
let files: string[];

beforeEach(() => {
	resetObservedMutationNet();
	resetMutationAttribution();
	resetDegradationLedger();
	vi.stubEnv("PI_LENS_TEST_TIME_BOUND_SCALE", undefined);
	vi.stubEnv("PI_LENS_TEST_TIME_BOUND", undefined);
	env = setupTestEnvironment("pi-lens-3496-scale-");
	dir = path.join(env.tmpDir, "target");
	fs.mkdirSync(dir);
	files = NAMES.map((name) => path.join(dir, name));
	for (const file of files) fs.writeFileSync(file, SOURCE);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	_setObservedTimeBoundsForTests({});
	env.cleanup();
});

/**
 * Start `work` on the fake clock, advance it, and keep the clock (timers AND
 * `Date`) fake until `work` settles. The settle and sweep deadlines are
 * `Date.now()` comparisons, so restoring the real clock mid-flight made every
 * "completes" expectation race host speed (review F2: 0/6 at 32 hogs).
 */
function onFakeClock<T>(work: () => Promise<T>, advanceMs: number): Promise<T> {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	const running = work();
	vi.advanceTimersByTime(advanceMs);
	return running.finally(() => vi.useRealTimers());
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
 * Whether the operation `probe` exercises ran to completion, on a fresh net
 * (repeated arms in one turn would otherwise spend the per-turn budget and
 * read as the scale's doing).
 */
async function completes(
	probe: Probe,
	id: string,
	advanceMs = ADVANCE_MS,
): Promise<boolean> {
	resetObservedMutationNet();
	resetMutationAttribution();
	switch (probe) {
		case "capture":
			return (await arm(id, advanceMs)).armed;
		case "turn":
			// All but 3 ms of the turn is spent: any scale under 0.995 leaves none.
			_setObservedTurnBudgetForTests(1, OBSERVED_TURN_BUDGET_MS - 3);
			return (await arm(id, 0)).armed;
		case "settle": {
			// The baseline is taken on a clock that never advances, so no bound
			// can cut it on any host; only the settle is timed.
			expect(await arm(id, 0)).toMatchObject({ armed: true });
			for (const file of files)
				fs.writeFileSync(file, `${SOURCE}const d = 4;\n`);
			const settled = await onFakeClock(
				() =>
					settleObservedMutation({
						toolCallId: id,
						toolName: "dir_codemod",
						sessionGeneration: 1,
						turnIndex: 1,
						record: () => true,
					}),
				advanceMs,
			);
			return !settled.stoppedEarly;
		}
		case "sweep": {
			const swept = await onFakeClock(
				() =>
					runObservedSettledSweep({
						turnIndex: 1,
						getTrackedPaths: () => files,
						record: () => true,
					}),
				advanceMs,
			);
			return swept.reason === undefined && swept.scanned === files.length;
		}
		case "refresh": {
			for (const file of files) noteMutationHandled(file);
			const refreshed = await onFakeClock(
				() => refreshObservedMutationLedger({ turnIndex: 1 }),
				advanceMs,
			);
			return refreshed === files.length;
		}
	}
}

describe("#3496 PI_LENS_TEST_TIME_BOUND_SCALE", () => {
	// Review F4: `Infinity` and `1e8` used to invert into an immediate timeout,
	// and `1` or more can only widen a bound. One case per value keeps each
	// case's work to five probes.
	it.each([undefined, "", "0", "-1", "fast", "1", "10", "1e8", "Infinity"])(
		"leaves every bound at its production value when the scale is %s (unset or outside (0, 1))",
		async (value) => {
			vi.stubEnv("PI_LENS_TEST_TIME_BOUND_SCALE", value);
			for (const probe of PROBE_NAMES)
				expect(
					await completes(probe, `call-${probe}-${value ?? "unset"}`),
					`${probe} at scale=${value}`,
				).toBe(true);
		},
	);

	it.each(BOUNDS)(
		"shrinks the %s bound when it or no bound is named, and only it",
		async (bound) => {
			vi.stubEnv("PI_LENS_TEST_TIME_BOUND_SCALE", SCALE);
			for (const probe of PROBE_NAMES.filter((name) => PROBES[name] === bound))
				expect(
					await completes(probe, `call-${bound}-all-${probe}`),
					`${probe} with every bound scaled`,
				).toBe(false);
			vi.stubEnv("PI_LENS_TEST_TIME_BOUND", bound);
			for (const probe of PROBE_NAMES) {
				// The arm's timeout is min(turn budget left, capture budget), as in
				// production, so a shrunk turn budget cuts the capture probe too.
				const cut =
					PROBES[probe] === bound || (bound === "turn" && probe === "capture");
				expect(
					await completes(probe, `call-${bound}-${probe}`),
					`${probe} with only ${bound} named`,
				).toBe(!cut);
			}
		},
	);

	it("is inert outside test mode", async () => {
		// Review F4: the seam reads a PI_LENS_TEST_* variable, so like its
		// siblings it answers only under isTestMode().
		vi.stubEnv("PI_LENS_TEST_MODE", "0");
		vi.stubEnv("PI_LENS_TEST_TIME_BOUND_SCALE", SCALE);
		for (const probe of PROBE_NAMES)
			expect(await completes(probe, `call-prod-${probe}`), probe).toBe(true);
	});

	it("loses to a bound the test pinned through _setObservedTimeBoundsForTests", async () => {
		// The #3494 seam is how a test says "my verdict is about WHAT was seen,
		// not how fast the host is"; the pass must not report such a test.
		vi.stubEnv("PI_LENS_TEST_TIME_BOUND_SCALE", SCALE);
		_setObservedTimeBoundsForTests({
			captureMs: 200,
			settleMs: 50,
			sweepMs: 200,
		});
		for (const probe of PROBE_NAMES) {
			// The turn budget has no pin, so name each pinned bound alone.
			if (probe === "turn") continue;
			vi.stubEnv("PI_LENS_TEST_TIME_BOUND", PROBES[probe]);
			expect(await completes(probe, `call-pinned-${probe}`), probe).toBe(true);
		}
	});

	it("canary: an unpinned observation completes under the ambient bounds", async () => {
		// The pass's liveness probe. Unscaled (every normal run) every
		// operation completes. Under the pass's scaled environment the named
		// bound cuts its own operation, so the pass expects THIS case to flip for
		// each bound; if it stays green the seam ignored the scale and the pass
		// says so.
		vi.unstubAllEnvs();
		for (const probe of PROBE_NAMES)
			expect(
				await completes(
					probe,
					`call-canary-${probe}`,
					CANARY_ADVANCE_MS[probe],
				),
				probe,
			).toBe(true);
	});
});
