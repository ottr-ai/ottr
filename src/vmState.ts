/**
 * Board-side state of the microVM runner (docs/adr/0009-microvm-workers.md): the last
 * /healthz probe of OTTR_VM_RUNNER_URL and the cards whose last dispatch vm-runner refused
 * as busy. The server's probe tick and the turn loop write it; boardCards and the project
 * settings route read it.
 */
export interface VmRunnerHealth {
	/** OTTR_VM_RUNNER_URL is set (with OTTR_WORKER_TOKEN). */
	configured: boolean;
	/** The last GET /healthz answered 200. */
	ok: boolean;
	/** Why the runner cannot take turns; null while ok. */
	reason: string | null;
}

export const VM_UNCONFIGURED = "OTTR_VM_RUNNER_URL is not set";

export const vmState: {
	health: VmRunnerHealth;
	/** "project/id" of cards whose last /run got the busy answer; cleared on the next dispatch. */
	busy: Set<string>;
} = {
	health: { configured: false, ok: false, reason: VM_UNCONFIGURED },
	busy: new Set(),
};

export const VM_BUSY_HOLD = "waiting for a free microVM";

/**
 * The queued-card hold text for a project with microVM mode on, or null when nothing holds
 * the card back on the microVM side.
 */
export function vmHoldFor(
	microVm: boolean,
	project: string,
	id: string,
	health: VmRunnerHealth = vmState.health,
	busy: ReadonlySet<string> = vmState.busy,
): string | null {
	if (!microVm) return null;
	if (!health.ok)
		return `waiting for the microVM runner: ${health.reason ?? "not reachable"}`;
	if (busy.has(`${project}/${id}`)) return VM_BUSY_HOLD;
	return null;
}
