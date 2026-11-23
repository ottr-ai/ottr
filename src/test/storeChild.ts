/**
 * OTTR-1244: a mutant under test can hang a spawned store child forever, and a hard-killed
 * `bun test` run leaves that child (and its own children) spinning for hours. Spawning with
 * `detached: true` puts the child in its own process group, a parent-death watchdog
 * group-kills it when the test runner dies, and killGroup() tears the whole subtree down,
 * so no orphan survives a run.
 */
export interface StoreChildHandle {
	child: Bun.Subprocess;
	pid: number;
	exited: Promise<number>; // resolves the child's exit code
	/** SIGKILLs the child's whole process group (the child is its own group leader). Never throws. */
	killGroup(): void;
}

export function spawnStoreChild(options: {
	script: string;
	env?: Record<string, string | undefined>;
	cwd?: string;
	/** Watchdog baseline pid; defaults to this process's pid — the child's direct parent. */
	parentPid?: number;
	/** Watchdog poll interval in ms; default 500. */
	watchdogMs?: number;
	/** Bun stdio tuple, default all "inherit". */
	stdio?: [
		"inherit" | "pipe" | "ignore",
		"inherit" | "pipe" | "ignore",
		"inherit" | "pipe" | "ignore",
	];
}): StoreChildHandle {
	// The spawned child's direct parent is THIS process (bun test runs each file in a
	// worker), so the baseline is our own pid: when the worker dies, the child's
	// `process.ppid` changes and the watchdog fires. A grandparent baseline would
	// mismatch at once and kill every child that lives past one tick.
	const parentPid = options.parentPid ?? process.pid;
	const watchdogMs = options.watchdogMs ?? 500;
	// Prepend, not append: ESM import hoisting keeps placement before the script's own
	// imports safe. When the parent run dies, Linux reparents the child to pid 1,
	// `process.ppid` changes, the child group-kills itself then exits. The negative pid
	// fails harmlessly when the child is somehow not a group leader; the catch falls
	// through to the single exit.
	const watchdog = `;(() => {
	const __ppid0 = ${parentPid};
	setInterval(() => {
		if (process.ppid !== __ppid0) {
			try { process.kill(-process.pid, "SIGKILL"); } catch {}
			process.exit(0);
		}
	}, ${watchdogMs}).unref();
})();
`;
	const child = Bun.spawn({
		cmd: [process.execPath, "-e", watchdog + options.script],
		env: { ...process.env, ...options.env },
		cwd: options.cwd,
		stdio: options.stdio ?? ["inherit", "inherit", "inherit"],
		// detached makes the child its own group leader, so -pid reaches its whole subtree.
		detached: true,
	});
	const pid = child.pid;
	return {
		child,
		pid,
		exited: child.exited,
		killGroup(): void {
			// The group id equals the child pid because detached makes it a leader. ESRCH
			// after death is normal; no idempotence guard needed, errors are swallowed.
			for (const t of [-pid, pid]) {
				try {
					process.kill(t, "SIGKILL");
				} catch {}
			}
		},
	};
}
