/**
 * OTTR-1244: a mutant under test can hang or hard-spin a spawned store child forever, and
 * a killed `bun test` run leaves that child (and its own children) reparented to pid 1 at
 * full CPU. The child runs detached in its own process group; a separate supervisor
 * process — outside the child, so a synchronous infinite loop in the child cannot starve
 * it — watches the spawning process and group-kills the child within one poll tick of the
 * parent's death. killGroup() tears the child's subtree and the supervisor down.
 */
export interface StoreChildHandle {
	child: Bun.Subprocess;
	pid: number;
	exited: Promise<number>; // resolves the child's exit code
	/** Resolves when the outside supervisor is gone; it self-exits once the child is. */
	supervisorExited: Promise<number>;
	/** The outside supervisor process; its death is the child's cleanup guarantee. */
	supervisor: Bun.Subprocess;
	/**
	 * SIGKILLs the child's whole process group (the child is its own group leader) and the
	 * supervisor. Never throws.
	 */
	killGroup(): void;
}

export function spawnStoreChild(options: {
	script: string;
	env?: Record<string, string | undefined>;
	cwd?: string;
	/** Supervisor baseline pid; defaults to this process's pid — the child's direct parent. */
	parentPid?: number;
	/** Supervisor poll interval in ms; default 500. */
	watchdogMs?: number;
	/** Bun stdio tuple for the child, default all "inherit". */
	stdio?: [
		"inherit" | "pipe" | "ignore",
		"inherit" | "pipe" | "ignore",
		"inherit" | "pipe" | "ignore",
	];
}): StoreChildHandle {
	// The spawned child's direct parent is THIS process (bun test runs each file in a
	// worker), so the supervisor's baseline is our own pid: when the worker dies, the
	// supervisor's `process.ppid` changes and it kills the child. A grandparent baseline
	// would mismatch at once and kill every child that lives past one tick.
	const parentPid = options.parentPid ?? process.pid;
	const watchdogMs = options.watchdogMs ?? 500;
	const child = Bun.spawn({
		cmd: [process.execPath, "-e", options.script],
		env: { ...process.env, ...options.env },
		cwd: options.cwd,
		stdio: options.stdio ?? ["inherit", "inherit", "inherit"],
		// detached makes the child its own group leader, so -pid reaches its whole subtree
		// and the child's own group survives a group kill aimed at the test run.
		detached: true,
	});
	const pid = child.pid;
	// The supervisor lives outside the child on purpose: code inside the child (even a
	// timer) dies with the child's event loop, and a synchronous infinite loop never lets
	// that loop turn. The supervisor is detached too, so a process-group kill aimed at the
	// test run cannot take it before it has fired. Its lifetime is bounded: it exits as
	// soon as the child is gone or it has killed the child after the parent's death.
	const supervisorScript = `;(() => {
	const __ppid0 = ${parentPid};
	const __kid = ${pid};
	const timer = setInterval(() => {
		let kidGone = false;
		try { process.kill(__kid, 0); } catch { kidGone = true; }
		if (kidGone) {
			clearInterval(timer);
			process.exit(0);
		}
		if (process.ppid !== __ppid0) {
			try { process.kill(-__kid, "SIGKILL"); } catch {}
			try { process.kill(__kid, "SIGKILL"); } catch {}
			clearInterval(timer);
			process.exit(0);
		}
	}, ${watchdogMs});
})();
`;
	const supervisor = Bun.spawn({
		cmd: [process.execPath, "-e", supervisorScript],
		env: { ...process.env },
		stdio: ["ignore", "ignore", "ignore"],
		detached: true,
	});
	return {
		child,
		pid,
		exited: child.exited,
		supervisorExited: supervisor.exited,
		supervisor,
		killGroup(): void {
			// The group id equals the child pid because detached makes it a leader. ESRCH
			// after death is normal; errors are swallowed.
			for (const t of [-pid, pid, supervisor.pid]) {
				try {
					process.kill(t, "SIGKILL");
				} catch {}
			}
		},
	};
}
