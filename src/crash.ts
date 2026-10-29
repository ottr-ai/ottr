// Last-resort error net: a throw in a timer callback or a forgotten rejection must log and keep
// the server up, not kill the board. Recovery comes from the loops themselves: schedule() re-runs
// every 5 s, quota/behind refresh on their next windows, and a request that failed returns 500.

/** Logs `scope: err` (stack when available) to stderr with a timestamp. */
export function logError(scope: string, err: unknown): void {
	console.error(
		`[${new Date().toISOString()}] ${scope}:`,
		err instanceof Error ? (err.stack ?? err.message) : err,
	);
}

const onUncaught = (err: Error): void => logError("uncaught", err);
const onRejection = (err: unknown): void =>
	logError("unhandled rejection", err);

/** Registers the process-level net: log uncaught errors and keep running. Repeat calls are no-ops. */
export function trapCrashes(): void {
	// EventEmitter registers a listener again on each on() call (Node, and Bun since 1.4.4).
	if (process.listeners("uncaughtException").includes(onUncaught)) return;
	process.on("uncaughtException", onUncaught);
	process.on("unhandledRejection", onRejection);
}
