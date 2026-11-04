type ScanOpts = { manual?: string };

/**
 * One scan at a time. A call joins the running scan when that scan covers its project
 * (an unscoped scan, or the same `manual` project); otherwise it waits and then scans.
 */
export function singleFlightTick(
	scan: (opts?: ScanOpts) => Promise<void>,
): (opts?: ScanOpts) => Promise<void> {
	// `running` is the running scan's project (undefined = all).
	let inFlight: Promise<void> | null = null;
	let running: string | undefined;

	function tick(opts?: ScanOpts): Promise<void> {
		const want = opts?.manual;
		if (inFlight !== null) {
			if (running === undefined || running === want) return inFlight;
			// The running scan skips the requested project: scan it next, whatever the first scan's outcome.
			const next = () => tick(opts);
			return inFlight.then(next, next);
		}
		running = want;
		inFlight = (async () => {
			try {
				await scan(opts);
			} finally {
				inFlight = null;
			}
		})();
		return inFlight;
	}

	return tick;
}
