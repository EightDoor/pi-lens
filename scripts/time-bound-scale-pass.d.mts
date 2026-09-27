export declare const TIME_BOUNDS: readonly string[];
export declare const DEFAULT_SCALE: number;
export declare const CANARY: string;
export declare const ADMITTED: Readonly<Record<string, string>>;
export type Verdict = "passed" | "failed";
export interface PassFlip {
	key: string;
	bound: string;
}
export interface PassResult {
	flips: PassFlip[];
	findings: string[];
	unjudgeable: string[];
}
export declare function testPopulation(repoRoot: string): string[];
export declare function verdicts(
	report: unknown,
	repoRoot: string,
): Map<string, Verdict>;
export declare function comparePassRuns(input: {
	baseline: Map<string, Verdict>;
	scaled: Map<string, Map<string, Verdict>>;
	admitted?: Readonly<Record<string, string>>;
	canary?: string;
}): PassResult;
export declare function passExitCode(result: PassResult): 0 | 1 | 2;
export declare function summaryLines(
	result: PassResult,
	scale: number,
): string[];
