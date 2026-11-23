export function mutationConcurrency(
	env?: Record<string, string | undefined>,
	parallelism?: number,
	cgroup?: { max: string; current: string },
): number;

export function cappedConcurrency(
	cap: number,
	env?: Record<string, string | undefined>,
	parallelism?: number,
	cgroup?: { max: string; current: string },
): number;

export function concurrencyLogLine(
	cap: number,
	env?: Record<string, string | undefined>,
	parallelism?: number,
	cgroup?: { max: string; current: string },
): string;

export function isStrykerRun(argv?: unknown[]): boolean;

export function sandboxTempDirName(repoRoot?: string, tmp?: string): string;

export function acquireMutationLock(
	tempDirName: string,
	options?: { timeoutMs?: number; log?: (message: string) => void },
): () => void;

export function sweepSandboxProcesses(
	sandboxDir: string,
	options?: {
		procRoot?: string;
		kill?: (pid: number, signal: string) => void;
		selfPid?: number;
	},
): { killed: number; failed: number };
