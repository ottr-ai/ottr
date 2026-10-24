// Live progress of a Stryker run inside a turn, read from outside the agent. The worker daemon
// and the local spawn poll it and stream it as one extra event line; the board shows it on the
// running card, so a run of several hours does not look dead. A Node Stryker run whose stdout
// is a pipe still gives its numbers: the image's tap (stryker-tap.cjs) keeps a copy in /tmp.
import {
	closeSync,
	fstatSync,
	openSync,
	readFileSync,
	readSync,
	statSync,
} from "node:fs";
import { descendants } from "./platform/unix.ts";

/** Event type of the progress line in a run's stdout stream; omp never emits it. */
export const PROGRESS_EVENT = "ottr_progress";

// Stryker's progress-append-only line: off a TTY the progress reporter downgrades to it, every 10 s.
const STRYKER_LINE =
	/Mutation testing (\d+)% \(elapsed: (~?\d+h \d+m|~?\d+m|<1m), remaining: (~?\d+h \d+m|~?\d+m|<1m|n\/a)\) (\d+)\/(\d+) tested \((\d+) survived(?:, (\d+) timed out)?\)/g;

/**
 * The card text for the last Stryker progress line in `text`, else null:
 * `Stryker {pct}% · {tested}/{total} · {survived} survived ({rate}%){ · {timedOut} timed out}{ · {elapsed} elapsed}{ · {left} left}`
 * with the rate = survived/tested*100 to one decimal, omitted when tested === 0;
 * the timed-out segment only when timedOut > 0 and the left segment only when remaining !== n/a.
 */
export function strykerStatus(text: string): string | null {
	const m = [...text.matchAll(STRYKER_LINE)].at(-1);
	if (!m) return null;
	const [, pct, elapsed, left, tested, total, survived, timedOut] = m;
	let status = `Stryker ${pct}% · ${tested}/${total}`;
	const t = Number(tested);
	if (t > 0)
		status += ` · ${survived} survived (${((Number(survived) / t) * 100).toFixed(1)}%)`;
	if (timedOut !== undefined && Number(timedOut) > 0)
		status += ` · ${timedOut} timed out`;
	return `${status} · ${elapsed} elapsed${left === "n/a" ? "" : ` · ${left} left`}`;
}

// A Python mutate.py runner's line: `[{n}/{total}] {rel}:{lineno} {label} {status} {dt}s[ ({count} survived)]`.
const MUTATE_LINE =
	/\[(\d+)\/(\d+)\] \S+:\d+ \S+ (?:KILLED|SURVIVED|TIMEOUT) [\d.]+s(?: \((\d+) survived\))?/g;

/**
 * The card text for the last mutate.py progress line in `text`, else null:
 * `mutate.py {pct}% · {n}/{total}` plus ` · {count} survived ({rate}%)` when the line carries a
 * count, with the rate = count/n*100 to one decimal.
 */
export function mutateStatus(text: string): string | null {
	const m = [...text.matchAll(MUTATE_LINE)].at(-1);
	if (!m) return null;
	const [, n, total, count] = m;
	let status = `mutate.py ${Math.floor((Number(n) * 100) / Number(total))}% · ${n}/${total}`;
	if (count !== undefined)
		status += ` · ${count} survived (${((Number(count) / Number(n)) * 100).toFixed(1)}%)`;
	return status;
}

function isStryker(pid: number): boolean {
	try {
		const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
		// Stryker's bin sets process.title = "stryker". Under Node that rewrites the cmdline
		// to the bare name, so the "run" argument is gone (Bun keeps the cmdline).
		return (
			argv[0] === "stryker" ||
			argv.some(
				(a, i) => /(^|\/)stryker(\.js)?$/.test(a) && argv[i + 1] === "run",
			)
		);
	} catch {
		return false; // exited meanwhile
	}
}

function isMutate(pid: number): boolean {
	try {
		return readFileSync(`/proc/${pid}/cmdline`, "utf8")
			.split("\0")
			.some((a) => /(^|\/)mutate\.py$/.test(a));
	} catch {
		return false; // exited meanwhile
	}
}

/** The last 1 MiB of `pid`'s stdout: the file behind it, else the copy that stryker-tap.cjs
 * keeps of a Stryker run's stdout. A pipe itself gives nothing: its reader (rtk, the agent's
 * shell) would lose every byte read here. The window must hold the last progress line even
 * after the run appends its final clear-text summary, which once pushed it out of a 16 KiB
 * tail and the card fell back to bare "Stryker running".
 * ponytail: a trailing summary over 1 MiB still hides the line; the tap's own 1 MiB cap is
 * the hard bound for the copy path. */
function stdoutTail(pid: number): string | null {
	for (const path of [`/proc/${pid}/fd/1`, `/tmp/ottr-stryker-${pid}.log`]) {
		try {
			if (!statSync(path).isFile()) continue;
			const fd = openSync(path, "r");
			try {
				const size = fstatSync(fd).size;
				const len = Math.min(size, 1 << 20);
				const buf = Buffer.alloc(len);
				readSync(fd, buf, 0, len, size - len);
				return buf.toString("utf8");
			} finally {
				closeSync(fd);
			}
		} catch {
			// exited meanwhile, or no copy
		}
	}
	return null;
}

/** Status of a Stryker or a Python mutate.py run in the process tree of `root` (Linux /proc),
 * null when none runs.
 * ponytail: a mutate.py run whose stdout is a pipe shows "mutate.py running" without numbers:
 * the tap covers Node only. A Python tap (sitecustomize on PYTHONPATH) is the upgrade path. */
export function runProgress(root: number): string | null {
	let running: string | null = null;
	for (const pid of [root, ...(descendants(root) ?? [])]) {
		if (isStryker(pid)) {
			running ??= "Stryker running";
			const status = strykerStatus(stdoutTail(pid) ?? "");
			if (status !== null) return status;
		}
		if (isMutate(pid)) {
			running ??= "mutate.py running";
			const status = mutateStatus(stdoutTail(pid) ?? "");
			if (status !== null) return status;
		}
	}
	return running;
}

/** Polls the run under `pid` every 15 s and emits a PROGRESS_EVENT line when its status changes
 * (text null once Stryker ends). Linux only; returns the stop function. */
export function watchProgress(
	pid: number | undefined,
	emit: (line: string) => void,
): () => void {
	if (pid === undefined || process.platform !== "linux") return () => {};
	let last: string | null = null;
	const timer = setInterval(() => {
		const text = runProgress(pid);
		if (text === last) return;
		last = text;
		emit(`${JSON.stringify({ type: PROGRESS_EVENT, text })}\n`);
	}, 15_000);
	timer.unref();
	return () => clearInterval(timer);
}
