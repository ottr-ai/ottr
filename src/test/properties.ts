import fc from "fast-check";

// Gate: 200 runs, fixed seed. Deep tier (FC_RUNS set): random seed. fast-check prints the seed and path on failure.
const runs = Number(process.env.FC_RUNS ?? 200);
if (!Number.isSafeInteger(runs) || runs < 1)
	throw new Error(`bad FC_RUNS: ${process.env.FC_RUNS}`);
fc.configureGlobal({
	numRuns: runs,
	seed: process.env.FC_RUNS === undefined ? 42 : undefined,
});

export default fc;
