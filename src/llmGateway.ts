import { spawnPiped, stripGitAuthEnv } from "./worktree.ts";

/**
 * The board's local credential gateway for microVM turns (OTTR-532). VMs hold no provider
 * secret: their omp sends pi-native requests to the board's /llm proxy, which forwards them
 * here. Two loopback children on the board store:
 *
 *   omp auth-broker serve   reads the board's agent.db (PI_CODING_AGENT_DIR), refreshes OAuth
 *   omp auth-gateway serve  a broker client that dispatches provider requests
 *
 * Both bearer tokens live in `<home>/.omp/` (the omp config dir); `omp <cmd> token --json`
 * creates one on first use and prints it, and serve loads the same file, so a restarted child
 * keeps the token and the port, and the url/token handed out stay valid.
 */

export interface GatewayChild {
	exited: Promise<number>;
	kill(): void;
}
/** Starts one long-lived child; `onLine` gets its stdout and stderr lines. */
export type GatewaySpawn = (
	argv: string[],
	env: Record<string, string | undefined>,
	onLine: (line: string) => void,
) => GatewayChild;
/** Runs one short omp command to its end. */
export type GatewayRun = (
	argv: string[],
	env: Record<string, string | undefined>,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface LlmGateway {
	url: string;
	token: string;
	stop(): void;
}

export interface LlmGatewayOptions {
	/** The board's agent dir (agent.db with the provider credentials). */
	agentDir: string;
	/** HOME for both children: the omp config dir with the token files is `<home>/.omp`. */
	home: string;
	log: (line: string) => void;
	omp?: string;
	spawn?: GatewaySpawn;
	run?: GatewayRun;
	fetch?: (url: string, init?: RequestInit) => Promise<Response>;
	freePort?: () => number;
	/** Wait before restarting an exited child; default 5 s. */
	restartDelayMs?: number;
	/** Ceiling for both children to answer their health check at start; default 60 s. */
	readyTimeoutMs?: number;
}

const TAIL_LINES = 10;
const POLL_MS = 100;

async function pumpLines(
	stream: ReadableStream<Uint8Array>,
	onLine: (line: string) => void,
): Promise<void> {
	const dec = new TextDecoder();
	let buf = "";
	for await (const chunk of stream) {
		buf += dec.decode(chunk, { stream: true });
		let nl = buf.indexOf("\n");
		while (nl >= 0) {
			onLine(buf.slice(0, nl));
			buf = buf.slice(nl + 1);
			nl = buf.indexOf("\n");
		}
	}
	if (buf !== "") onLine(buf);
}

const realSpawn: GatewaySpawn = (argv, env, onLine) => {
	const proc = Bun.spawn(argv, {
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	void pumpLines(proc.stdout, onLine);
	void pumpLines(proc.stderr, onLine);
	return {
		exited: proc.exited,
		kill: () => {
			if (proc.exitCode === null) proc.kill();
		},
	};
};

/** A loopback port free right now: bind port 0, read it, release it. */
function loopbackPort(): number {
	const s = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(null, { status: 404 }),
	});
	const port = s.port;
	void s.stop(true);
	if (port === undefined) throw new Error("no free loopback port");
	return port;
}

export async function startLlmGateway(
	o: LlmGatewayOptions,
): Promise<LlmGateway> {
	const omp = o.omp ?? Bun.which("omp") ?? "omp";
	const spawn = o.spawn ?? realSpawn;
	const run: GatewayRun =
		o.run ?? ((argv, env) => spawnPiped(argv, undefined, 60_000, env));
	const probe = o.fetch ?? fetch;
	const freePort = o.freePort ?? loopbackPort;
	const delay = o.restartDelayMs ?? 5_000;
	const deadline = Date.now() + (o.readyTimeoutMs ?? 60_000);

	// The children need provider keys and proxy settings, but not git host credentials or the
	// production database URL. An inherited broker URL would make the broker's own store
	// remote, so both children get only the broker settings set here.
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: o.home,
		PI_CODING_AGENT_DIR: o.agentDir,
	};
	stripGitAuthEnv(env);
	delete env.OTTR_DATABASE_URL;
	delete env.OMP_AUTH_BROKER_URL;
	delete env.OMP_AUTH_BROKER_TOKEN;

	const tokenOf = async (cmd: "auth-broker" | "auth-gateway") => {
		const r = await run([omp, cmd, "token", "--json"], env);
		let token: unknown;
		try {
			const parsed: unknown = JSON.parse(r.stdout);
			if (typeof parsed === "object" && parsed !== null && "token" in parsed)
				token = parsed.token;
		} catch {
			// not JSON: reported as a failure below
		}
		if (r.code !== 0 || typeof token !== "string" || token === "")
			throw new Error(
				`omp ${cmd} token failed: ${r.stderr.trim() || `exit ${r.code}`}`,
			);
		return token;
	};
	const brokerToken = await tokenOf("auth-broker");
	const gatewayToken = await tokenOf("auth-gateway");
	const brokerUrl = `http://127.0.0.1:${freePort()}`;
	const gatewayUrl = `http://127.0.0.1:${freePort()}`;
	const bind = (url: string) => url.slice("http://".length);
	const children = {
		broker: {
			name: "auth-broker",
			argv: [omp, "auth-broker", "serve", "--bind", bind(brokerUrl)],
			env,
			health: `${brokerUrl}/v1/healthz`,
		},
		gateway: {
			name: "auth-gateway",
			argv: [omp, "auth-gateway", "serve", "--bind", bind(gatewayUrl)],
			env: {
				...env,
				OMP_AUTH_BROKER_URL: brokerUrl,
				OMP_AUTH_BROKER_TOKEN: brokerToken,
			},
			health: `${gatewayUrl}/healthz`,
		},
	};
	type Spec = (typeof children)["broker"];

	let stopped = false;
	const live = new Set<GatewayChild>();
	const timers = new Set<ReturnType<typeof setTimeout>>();
	const stop = () => {
		stopped = true;
		for (const t of timers) clearTimeout(t);
		timers.clear();
		for (const c of live) c.kill();
		live.clear();
	};

	/** Runs `spec` and restarts it `delay` after every exit until stop(). */
	const supervise = (spec: Spec) => {
		if (stopped) return;
		const tail: string[] = [];
		const child = spawn(spec.argv, spec.env, (line) => {
			tail.push(line);
			if (tail.length > TAIL_LINES) tail.shift();
		});
		live.add(child);
		void child.exited.then((code) => {
			live.delete(child);
			if (stopped) return;
			o.log(
				`[llm-gateway] ${spec.name} exited with code ${code}; restarting in ${delay / 1000} s${tail.length > 0 ? `: ${tail.join(" | ")}` : ""}`,
			);
			const t = setTimeout(() => {
				timers.delete(t);
				supervise(spec);
			}, delay);
			timers.add(t);
		});
	};

	/** Polls `spec`'s health URL until it answers 2xx; an exit before that is restarted meanwhile. */
	const ready = async (spec: Spec) => {
		for (;;) {
			if (stopped) throw new Error("the LLM gateway was stopped");
			try {
				const res = await probe(spec.health, {
					signal: AbortSignal.timeout(2_000),
				});
				if (res.ok) return;
			} catch {
				// not listening yet
			}
			if (Date.now() >= deadline)
				throw new Error(`${spec.name} did not answer ${spec.health} in time`);
			await Bun.sleep(POLL_MS);
		}
	};

	try {
		supervise(children.broker);
		await ready(children.broker);
		// The gateway fetches a live broker snapshot at start: it starts once the broker answers.
		supervise(children.gateway);
		await ready(children.gateway);
	} catch (err) {
		stop();
		throw err;
	}
	o.log(`[llm-gateway] ready at ${gatewayUrl} (broker ${brokerUrl})`);
	return { url: gatewayUrl, token: gatewayToken, stop };
}
