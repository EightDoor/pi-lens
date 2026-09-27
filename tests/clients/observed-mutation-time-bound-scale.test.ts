/**
 * #3496: the load-simulation seam on the observational net's two wall-clock
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
 * can run decides the race deterministically. The unscaled bounds (200 ms
 * capture, 50 ms settle, 200 ms settle race) all sit above 20 ms; every scaled
 * one below sits under it.
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
	armObservedMutation,
	resetObservedMutationNet,
	settleObservedMutation,
} from "../../clients/observed-mutation.js";
import { setupTestEnvironment } from "./test-utils.js";

const SOURCE = ["const a = 1;", "const b = 2;", "const c = 3;", ""].join("\n");
const NAMES = ["a1.ts", "a2.ts", "a3.ts", "a4.ts", "a5.ts"];
/** Every scaled bound below lands under this; every unscaled one above it. */
const ADVANCE_MS = 20;
/**
 * The canary's advance: 1 ms under the unscaled capture budget (200 ms) and
 * settle race (4 x 50 ms), so it passes unscaled and flips under ANY scale the
 * pass can use (below 0.995), not only under the 0.05 the cases above pick.
 */
const CANARY_ADVANCE_MS = 199;

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

function arm(toolCallId: string) {
	return armObservedMutation({
		toolCallId,
		toolName: "dir_codemod",
		targetPath: dir,
		cwd: env.tmpDir,
		sessionGeneration: 1,
		turnIndex: 1,
	});
}

/**
 * Arm with the clock never advanced (so no bound can cut the baseline, on any
 * host), change every entry, then settle and advance by `advanceMs`.
 */
async function settleAfterEveryEntryChanged(
	toolCallId: string,
	advanceMs = ADVANCE_MS,
) {
	expect(await armOnFakeClock(toolCallId, 0)).toMatchObject({ armed: true });
	for (const name of NAMES)
		fs.writeFileSync(path.join(dir, name), `${SOURCE}const d = 4;\n`);
	vi.useFakeTimers();
	const settling = settleObservedMutation({
		toolCallId,
		toolName: "dir_codemod",
		sessionGeneration: 1,
		turnIndex: 1,
		record: () => true,
	});
	vi.advanceTimersByTime(advanceMs);
	vi.useRealTimers();
	return settling;
}

async function armOnFakeClock(toolCallId: string, advanceMs = ADVANCE_MS) {
	vi.useFakeTimers();
	const arming = arm(toolCallId);
	vi.advanceTimersByTime(advanceMs);
	vi.useRealTimers();
	return arming;
}

describe("#3496 PI_LENS_TEST_TIME_BOUND_SCALE", () => {
	it("leaves both bounds at their production values when the scale is unset or not a positive number", async () => {
		for (const value of [undefined, "", "0", "-1", "fast"]) {
			// A fresh net per value: five arms in one turn would otherwise spend
			// the per-turn budget and read as the scale's doing.
			resetObservedMutationNet();
			resetMutationAttribution();
			vi.stubEnv("PI_LENS_TEST_TIME_BOUND_SCALE", value);
			const id = `call-unset-${value ?? "none"}`;
			const settled = await settleAfterEveryEntryChanged(id);
			expect(settled, `scale=${value}`).toMatchObject({
				settled: true,
				replayed: NAMES.length,
				stoppedEarly: false,
			});
			expect(await armOnFakeClock(`${id}-arm`), `scale=${value}`).toMatchObject(
				{ armed: true },
			);
		}
	});

	it("shrinks the settle deadline, and only it when the settle is named", async () => {
		vi.stubEnv("PI_LENS_TEST_TIME_BOUND_SCALE", "0.05");
		vi.stubEnv("PI_LENS_TEST_TIME_BOUND", "settle");
		expect(await armOnFakeClock("call-settle-only-arm")).toMatchObject({
			armed: true,
		});
		const settleOnly = await settleAfterEveryEntryChanged("call-settle-only");
		expect(settleOnly.stoppedEarly).toBe(true);

		// Every bound now.
		vi.stubEnv("PI_LENS_TEST_TIME_BOUND", undefined);
		const settled = await settleAfterEveryEntryChanged("call-scaled-settle");
		expect(settled.stoppedEarly).toBe(true);
		expect(settled.replayed).toBeLessThan(NAMES.length);
	});

	it("shrinks the capture budget, and only it when the capture is named", async () => {
		vi.stubEnv("PI_LENS_TEST_TIME_BOUND_SCALE", "0.05");
		expect(await armOnFakeClock("call-scaled-capture")).toEqual({
			armed: false,
			reason: "timeout",
		});

		vi.stubEnv("PI_LENS_TEST_TIME_BOUND", "capture");
		expect(await armOnFakeClock("call-capture-only")).toEqual({
			armed: false,
			reason: "timeout",
		});
		const settled = await settleAfterEveryEntryChanged(
			"call-capture-only-settle",
		);
		expect(settled).toMatchObject({
			settled: true,
			replayed: NAMES.length,
			stoppedEarly: false,
		});
	});

	it("loses to a bound the test pinned through _setObservedTimeBoundsForTests", async () => {
		// The #3494 seam is how a test says "my verdict is about WHAT was seen,
		// not how fast the host is"; the pass must not report such a test.
		vi.stubEnv("PI_LENS_TEST_TIME_BOUND_SCALE", "0.05");
		_setObservedTimeBoundsForTests({ captureMs: 200, settleMs: 50 });
		expect(await armOnFakeClock("call-pinned-arm")).toMatchObject({
			armed: true,
		});
		const settled = await settleAfterEveryEntryChanged("call-pinned");
		expect(settled).toMatchObject({
			settled: true,
			replayed: NAMES.length,
			stoppedEarly: false,
		});
	});

	it("canary: an unpinned observation completes under the ambient bounds", async () => {
		// The pass's liveness probe. Unscaled (every normal run) both halves
		// complete. Under the pass's scaled environment the named bound cuts
		// one of them, so the pass expects THIS case to flip for each bound; if
		// it stays green the seam ignored the scale and the pass says so.
		vi.unstubAllEnvs();
		expect(
			await armOnFakeClock("call-canary-arm", CANARY_ADVANCE_MS),
		).toMatchObject({ armed: true });
		const settled = await settleAfterEveryEntryChanged(
			"call-canary",
			CANARY_ADVANCE_MS,
		);
		expect(settled.stoppedEarly).toBe(false);
	});
});
