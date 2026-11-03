export function mutationConcurrency(
	env?: Record<string, string | undefined>,
	parallelism?: number,
): number;

export function isStrykerRun(argv?: unknown[]): boolean;

export function acquireMutationLock(
	tempDirName: string,
	options?: { timeoutMs?: number; log?: (message: string) => void },
): () => void;
