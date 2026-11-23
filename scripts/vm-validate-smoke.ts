/**
 * The KVM-host acceptance run for the microVM validation mode
 * (docs/specs/microvm-validation-mode.md, "Acceptance checks", item 3): one validation
 * job whose probe tries to reach the network, write to the target, and read the
 * environment, then a fork bomb that must stop at the job's pids cap (OTTR-1225).
 * Every attempt is printed with its verdict, and the exit is non-zero when one
 * attempt is not blocked, so a host script can gate on the exit code alone.
 *
 * Run it where bun, the checkout and the vm-runner's compose network meet, for example
 * in a one-off container from the branch's vm-runner image (see docs/WORKERS.md,
 * "Validation mode"):
 *
 *   bun /workspace/ottr/scripts/vm-validate-smoke.ts
 *
 * No secret enters the VM: the runner request carries the shared worker token on the
 * wire only, exactly as the sandbox_run tool does.
 */
import { join } from "node:path";
import { runSandboxJob } from "../src/sandboxRun.ts";
import { type ValidateResponse, VM_VALIDATE } from "../src/vmValidateShared.ts";

export interface ProbeOptions {
	/** The connect target; the real run uses the public resolver. */
	connectHost?: string;
	connectPort?: number;
	/** The path the target-write attempt touches. */
	targetPath?: string;
}

const CONNECT_HOST = /^[A-Za-z0-9.-]+$/;

/** The job that attempts the three harness controls and reports each one. */
export function probeArgv(opts: ProbeOptions = {}): string[] {
	const host = opts.connectHost ?? "1.1.1.1";
	const port = opts.connectPort ?? 53;
	const target = opts.targetPath ?? "/target/.ottr-smoke";
	if (!CONNECT_HOST.test(host)) throw new Error(`bad probe host: ${host}`);
	// The connect attempt distinguishes the verdicts the kernel can prove: connected,
	// refused (with the errno), and everything else is inconclusive — a missing
	// interpreter or a crash must read as probe-failed, never as a false "blocked".
	// The env names drop the variables the shell itself adds (PWD, OLDPWD, _), so the
	// line reports the spawn env, which is what the allowlist controls.
	const script = [
		`v=$(bun -e 'const net=require("node:net");const s=net.connect({host:"${host}",port:${port}},()=>{console.log("allowed");process.exit(0)});s.on("error",(e)=>{console.log("blocked:"+(e.code||e.name||"unknown"));process.exit(2)});' 2>/dev/null)`,
		'case "$v" in',
		`allowed) echo "ATTEMPT network allowed tcp/${host}:${port}";;`,
		'blocked:*) echo "ATTEMPT network blocked tcp/' +
			host +
			":" +
			port +
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell parameter expansion, not a TS template
			' reason=${v#blocked:}";;',
		'*) echo "ATTEMPT network probe-failed tcp/' +
			host +
			":" +
			port +
			' out=$v";;',
		"esac",
		`if touch ${target} 2>/dev/null; then`,
		`echo "ATTEMPT target-write allowed ${target}";`,
		"else",
		`echo "ATTEMPT target-write blocked ${target}";`,
		"fi",
		"echo \"ATTEMPT env $(env | sort | sed 's/=.*//' | grep -v -x -e PWD -e OLDPWD -e _ | tr '\\n' ' ' | sed 's/ $//')\"",
	].join("\n");
	return ["sh", "-c", script];
}

export interface Attempt {
	name: string;
	/** The probe's own verdict: blocked or allowed — for env, the variable list. */
	verdict: string;
	detail: string;
}

/** The ATTEMPT lines the probe wrote to the job's stdout. */
export function parseAttempts(stdoutTail: string): Attempt[] {
	const out: Attempt[] = [];
	for (const line of stdoutTail.split("\n")) {
		const m = /^ATTEMPT ([a-z-]+) (.*)$/.exec(line.trim());
		if (!m) continue;
		const name = m[1] ?? "";
		const rest = (m[2] ?? "").trim();
		// env's value is the whole variable list, not a verdict-plus-detail split.
		if (name === "env") out.push({ name, verdict: rest, detail: "" });
		else {
			const space = rest.indexOf(" ");
			out.push(
				space === -1
					? { name, verdict: rest, detail: "" }
					: {
							name,
							verdict: rest.slice(0, space),
							detail: rest.slice(space + 1),
						},
			);
		}
	}
	return out;
}

/** The env names the allowlist produces, in sorted order. */
export const expectedEnvNames = Object.keys(VM_VALIDATE.envAllowlist)
	.sort()
	.join(" ");

/**
 * The fork-bomb job (OTTR-1225's live proof): an inner shell forks detached sleeps
 * in a loop and records each success in a scratch file. When the job cgroup's pids
 * cap refuses a fork, dash's "Cannot fork" kills the inner shell; the outer shell
 * then reports the last recorded count, so the count lands even at the cap. With no
 * live cap the loop reaches its own 2000 bound, which the verdict reads as a leak.
 */
export function bombArgv(): string[] {
	return [
		"sh",
		"-c",
		`sh -c 'i=0; : > /tmp/ottr-bomb-count; while [ "$i" -lt 2000 ]; do sleep 30 </dev/null >/dev/null 2>&1 & echo $((i+1)) > /tmp/ottr-bomb-count; i=$((i+1)); done'; echo "FORKED=$(cat /tmp/ottr-bomb-count 2>/dev/null)"; exit 0`,
	];
}

/** The fork count the bomb reported, null when it never reported one. */
export function parseBomb(stdoutTail: string): number | null {
	const m = /^FORKED=(\d+)$/m.exec(stdoutTail);
	return m === null ? null : Number(m[1]);
}

/** Every way the bomb result fails the pids-cap proof: empty means the cap held. */
export function bombViolations(result: ValidateResponse): string[] {
	const bad: string[] = [];
	if (result.selfCheck?.ok !== true)
		bad.push("the guest self-check did not pass");
	if (result.missingControl !== null && result.missingControl !== undefined)
		bad.push(`missing control: ${result.missingControl}`);
	if (!result.job) {
		bad.push("the fork bomb did not run");
		return bad;
	}
	if (result.job.exitCode !== 0)
		bad.push(`the fork bomb exited ${result.job.exitCode ?? "on signal"}`);
	const forked = parseBomb(result.job.stdoutTail);
	if (forked === null) bad.push("the fork bomb never reported its count");
	else if (forked > VM_VALIDATE.maxProcesses)
		bad.push(
			`the job forked ${forked} times past the ${VM_VALIDATE.maxProcesses} cap: the pids limit is not live`,
		);
	return bad;
}

/** Every way the result fails the acceptance: empty means the sandbox held. */
export function acceptanceViolations(result: ValidateResponse): string[] {
	const bad: string[] = [];
	if (result.resultSource !== "guest")
		bad.push(
			`no guest result (${result.resultSource}): ${result.error ?? "no error line"}`,
		);
	if (result.selfCheck?.ok !== true)
		bad.push("the guest self-check did not pass");
	if (result.missingControl !== null && result.missingControl !== undefined)
		bad.push(`missing control: ${result.missingControl}`);
	const job = result.job;
	if (!job) {
		bad.push("the job did not run");
		return bad;
	}
	const attempts = parseAttempts(job.stdoutTail);
	const byName = new Map(attempts.map((a) => [a.name, a]));
	for (const name of ["network", "target-write"] as const) {
		const a = byName.get(name);
		if (!a) bad.push(`the ${name} attempt never ran`);
		else if (a.verdict === "probe-failed")
			bad.push(`the ${name} probe failed: inconclusive (${a.detail})`);
		else if (a.verdict !== "blocked")
			bad.push(
				`the ${name} attempt was ${a.verdict}, not blocked (${a.detail})`,
			);
	}
	const env = byName.get("env");
	if (!env) bad.push("the env attempt never ran");
	else if (env.verdict !== expectedEnvNames)
		bad.push(
			`the job env was "${env.verdict}", not the allowlist "${expectedEnvNames}"`,
		);
	return bad;
}

export interface SmokeDeps {
	/** Defaults to the real runSandboxJob. */
	runner?: typeof runSandboxJob;
	/** Defaults to process stdout. */
	print?: (line: string) => void;
}

/** Runs the acceptance job and returns the process exit code: 0 only when it held. */
export async function main(
	argv: string[],
	deps: SmokeDeps = {},
): Promise<number> {
	const print = deps.print ?? ((line: string) => console.log(line));
	const runner = deps.runner ?? runSandboxJob;
	const flag = (name: string): string | undefined => {
		const i = argv.indexOf(`--${name}`);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const project = flag("project") ?? "ottr";
	const url =
		flag("url") ?? process.env.OTTR_VM_RUNNER_URL ?? "http://vm-runner:8787";
	const token = flag("token") ?? process.env.OTTR_WORKER_TOKEN ?? "";
	const checkout = flag("checkout") ?? join("/workspace", project);
	const ref = flag("ref");
	print(
		`vm-validate-smoke: project ${project}, ref ${ref ?? "HEAD"}, runner ${url}`,
	);
	const result = await runner({
		project,
		checkout,
		argv: probeArgv(),
		cwd: "/target",
		...(ref !== undefined && ref !== "" ? { ref } : {}),
		env: {
			OTTR_VM_RUNNER_URL: url,
			...(token !== "" ? { OTTR_WORKER_TOKEN: token } : {}),
		},
	});
	if (!result.ok) {
		print(`FAIL: ${result.error}`);
		return 1;
	}
	const response = result.result;
	for (const check of response.selfCheck?.checks ?? []) {
		print(
			`self-check ${check.ok ? "ok  " : "FAIL"} ${check.name}: ${check.detail}`,
		);
	}
	if (!response.job) {
		print(`FAIL: the job did not run (${response.error ?? "no error line"})`);
		return 1;
	}
	for (const a of parseAttempts(response.job.stdoutTail)) {
		print(
			a.name === "env"
				? `ATTEMPT env: ${a.verdict === expectedEnvNames ? "exactly the allowlist" : `read back "${a.verdict}" instead of the allowlist "${expectedEnvNames}"`}`
				: `ATTEMPT ${a.name}: ${a.verdict}${a.detail ? ` (${a.detail})` : ""} — ${a.verdict === "blocked" ? "blocked as required" : "NOT BLOCKED"}`,
		);
	}
	const violations = acceptanceViolations(response);
	if (violations.length > 0) {
		for (const v of violations) print(`FAIL: ${v}`);
		print(
			`totalMs ${response.totalMs}, logTail: ${response.logTail.slice(-400)}`,
		);
		return 1;
	}
	// Second job: the fork bomb must stop at the job's pids cap (OTTR-1225).
	print(`fork-bomb: forking past the ${VM_VALIDATE.maxProcesses} pids cap ...`);
	const bomb = await runner({
		project,
		checkout,
		argv: bombArgv(),
		cwd: "/target",
		...(ref !== undefined && ref !== "" ? { ref } : {}),
		env: {
			OTTR_VM_RUNNER_URL: url,
			...(token !== "" ? { OTTR_WORKER_TOKEN: token } : {}),
		},
	});
	if (!bomb.ok) {
		print(`FAIL: ${bomb.error}`);
		return 1;
	}
	const bombResponse = bomb.result;
	if (!bombResponse.job) {
		print(
			`FAIL: the fork bomb did not run (${bombResponse.error ?? "no error line"})`,
		);
		return 1;
	}
	const forked = parseBomb(bombResponse.job.stdoutTail);
	print(
		`fork-bomb: stopped after ${forked ?? "no recorded"} forks (cap ${VM_VALIDATE.maxProcesses})`,
	);
	const bombBad = bombViolations(bombResponse);
	if (bombBad.length > 0) {
		for (const v of bombBad) print(`FAIL: ${v}`);
		print(`logTail: ${bombResponse.logTail.slice(-400)}`);
		return 1;
	}
	print(
		`PASS: every control held and the fork bomb stopped at the cap (boot+run ${response.totalMs} ms, limits ${JSON.stringify(response.limits)})`,
	);
	return 0;
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2)));
}
