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

export function isStrykerRun(argv?: unknown[]): boolean;

export function sandboxTempDirName(repoRoot?: string, tmp?: string): string;

export function acquireMutationLock(
	tempDirName: string,
	options?: { timeoutMs?: number; log?: (message: string) => void },
): () => void;
