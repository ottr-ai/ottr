import { errmsg } from "./errmsg.ts";

/** Rate-limit window: a sampler tick is 30 s, so a continuing failure writes one
 *  line per 10 minutes instead of one per tick (OTTR-793). */
export const SAMPLE_LOG_INTERVAL_MS = 600_000;

/** Rate-limited logging for one sampler's failed and recovered sample ticks. */
export interface SystemSampleLog {
	/** One failed tick: the first failure logs at once; while the failure
	 *  continues, at most one line per SAMPLE_LOG_INTERVAL_MS, carrying the
	 *  failed-tick count since the last line. */
	failure(err: unknown): void;
	/** One passed tick: one recovery line after a failure; a pass with no
	 *  earlier failure logs nothing. */
	success(): void;
}

/** The log policy for the 30 s system sampler (OTTR-793): a broken monitor must
 *  not stay silent, and a permanent failure must not write a line per tick.
 *  Clock and log are injected; src/app.ts keeps only the wiring. Lines carry the
 *  error message only — never secrets or env values. */
export function createSystemSampleLog(
	clock: () => number,
	log: (line: string) => void,
): SystemSampleLog {
	let failing = false;
	let failedSinceLine = 0;
	let failedStreak = 0;
	let lastLineAt = 0;
	return {
		failure(err: unknown): void {
			failedSinceLine += 1;
			failedStreak += 1;
			const now = clock();
			if (!failing) {
				failing = true;
				lastLineAt = now;
				log(`system sampler failed: ${errmsg(err)}`);
				failedSinceLine = 0; // that failure was the line, not since it
				return;
			}
			if (now - lastLineAt < SAMPLE_LOG_INTERVAL_MS) return;
			log(
				`system sampler failed ${failedSinceLine} times since the last line: ${errmsg(err)}`,
			);
			lastLineAt = now;
			failedSinceLine = 0;
		},
		success(): void {
			if (!failing) return;
			const failed = failedStreak;
			failing = false;
			failedSinceLine = 0;
			failedStreak = 0;
			log(`system sampler recovered after ${failed} failed samples`);
		},
	};
}
