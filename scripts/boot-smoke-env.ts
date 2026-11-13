/** The env keys a smoke-booted server inherits from the caller; every other key
 * stays out. The worker container's runtime plumbing (OTTR_VM_RUNNER_URL,
 * OTTR_WORKER_TOKEN, OTTR_BOARD_URL, OTTR_BOARD_TOKEN, ...) must not reach the
 * boot: src/server.ts validates its env at boot and refuses to start when
 * OTTR_VM_RUNNER_URL arrives without OTTR_WORKER_TOKEN (OTTR-891). A smoke case
 * that needs a blocked key sets it in `overrides` — those land after the
 * allowlist and are never filtered, so a runner case sets both its keys there. */
export const INHERITED = [
	"PATH",
	"HOME",
	"NODE_ENV",
	"TMPDIR",
	// Windows needs SYSTEMROOT to start a process; COMSPEC and USERPROFILE back
	// shell and profile lookups; TEMP/TMP hold the temp dir there.
	"SYSTEMROOT",
	"COMSPEC",
	"USERPROFILE",
	"TEMP",
	"TMP",
] as const;

export function smokeEnv(
	overrides: Record<string, string>,
): Record<string, string> {
	const inherited: Record<string, string> = {};
	for (const key of INHERITED) {
		const value = process.env[key];
		if (value !== undefined) inherited[key] = value;
	}
	return { ...inherited, ...overrides };
}
