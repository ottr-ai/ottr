// Clone, fetch and push against any git host (GitLab, self-hosted, GitHub): URL intake at the
// trust boundary, per-host HTTPS tokens through a git credential helper, server-only SSH keys,
// and the host-key trust flow. GitHub-only extras stay out; this module is plain git + ssh.
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { git, redact } from "./worktree.ts";

export const GIT_URL_ERROR =
	"url must be a git repository URL (https://…, git@host:…, ssh://…)";

export type GitRemote = {
	scheme: "https" | "ssh";
	host: string; // lowercase
	port: number | null;
	hostKey: string; // host, or host:port when a port is given
	name: string; // last path segment without .git
};

/** One stored HTTPS token. `host` is the hostKey form (lowercase, with :port when named). */
export type GitToken = { host: string; username: string; token: string };

export type KeyInfo = { publicKey: string; fingerprint: string }; // fingerprint "SHA256:..."

export type SshPaths = {
	dir: string;
	global: string;
	knownHosts: string;
	/** Throws on a name with / \\ or a leading "." so no path can climb out of the ssh dir. */
	project(name: string): string;
	/** Throws unless id matches /^[0-9a-f]{32}$/, so only generated ids name a pending key. */
	pending(id: string): string;
};

export type TrustNeeded = {
	error: string;
	needsTrust: true;
	host: string;
	fingerprints: string[];
	changed: boolean;
};

/** known_hosts lines for one host: ssh-keyscan in production, an injected stub in tests. */
export type Keyscan = (
	host: string,
	port: number | null,
) => Promise<string[] | { error: string }>;

// One piped ssh-keygen/ssh-keyscan run; `stdin` feeds the child when given (key fingerprinting
// reads the key lines from stdin with `-f -`). Never throws for a non-zero exit.
async function runTool(
	argv: string[],
	stdin?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(argv, {
		stdin: stdin === undefined ? "ignore" : "pipe",
		stdout: "pipe",
		stderr: "pipe",
		// keyscan gets -T 10 per host; 30s bounds several addresses and keeps keygen instant runs safe.
		timeout: 30_000,
		windowsHide: true,
	});
	if (stdin !== undefined) {
		proc.stdin?.write(stdin);
		proc.stdin?.end();
	}
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { code: await proc.exited, stdout, stderr };
}

function lastLine(text: string): string {
	return (
		text
			.split("\n")
			.filter((l) => l.trim() !== "")
			.pop() ?? ""
	);
}

/** mkdir -p plus the 0700 rule for every ssh dir. */
function ensureDir(p: string): void {
	mkdirSync(p, { recursive: true });
	chmodSync(p, 0o700);
}

// host[:port] -> { host lowercased, port } | null. No brackets, no leading "-" or "." on the host.
function parseHostPort(
	s: string,
): { host: string; port: number | null } | null {
	const colon = s.lastIndexOf(":");
	const hostPart = colon === -1 ? s : s.slice(0, colon);
	const portText = colon === -1 ? null : s.slice(colon + 1);
	if (!/^[A-Za-z0-9.-]+$/.test(hostPart)) return null;
	if (hostPart.startsWith("-") || hostPart.startsWith(".")) return null;
	let port: number | null = null;
	if (portText !== null) {
		if (!/^[0-9]+$/.test(portText)) return null;
		port = Number(portText);
		if (port < 1 || port > 65535) return null;
	}
	return { host: hostPart.toLowerCase(), port };
}

// Path segments to name. A segment may hold [A-Za-z0-9_.-] but never start with "." (no "..",
// no dotfile); the URL reaches git after "--", so a leading "-" is safe here. Whether the name
// is a safe folder is the caller's check (app.ts isFolderName), not the URL's.
function parsePath(p: string): string | null {
	if (p.endsWith("/")) p = p.slice(0, -1);
	if (p === "") return null;
	let name = "";
	for (const seg of p.split("/")) {
		if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(seg)) return null;
		name = seg.endsWith(".git") ? seg.slice(0, -4) : seg;
	}
	return name === "" ? null : name;
}

/**
 * The trust boundary for every clone URL. Returns the shared GIT_URL_ERROR for every rejection;
 * never throws, on any input. Outer whitespace is trimmed; anything else is total.
 */
export function parseGitUrl(raw: unknown): GitRemote | { error: string } {
	if (typeof raw !== "string") return { error: GIT_URL_ERROR };
	const url = raw.trim();
	if (url === "" || url.startsWith("-")) return { error: GIT_URL_ERROR };
	// Outer whitespace was trimmed above; any whitespace or control char left is inside the value.
	if (/[\s\p{Cc}]/u.test(url)) return { error: GIT_URL_ERROR };
	const lower = url.toLowerCase();
	if (lower.startsWith("https://") || lower.startsWith("ssh://")) {
		const scheme = lower.startsWith("https://") ? "https" : "ssh";
		const rest = url.slice(scheme.length + 3);
		const slash = rest.indexOf("/");
		const authority = slash === -1 ? rest : rest.slice(0, slash);
		const pathPart = slash === -1 ? "" : rest.slice(slash + 1);
		let user = "";
		let hostPort = authority;
		const at = hostPort.lastIndexOf("@");
		if (at !== -1) {
			user = hostPort.slice(0, at);
			hostPort = hostPort.slice(at + 1);
		}
		// https carries no credentials in the URL, ever; ssh may name a user.
		if (user !== "" && (scheme === "https" || !/^[A-Za-z0-9_.-]+$/.test(user)))
			return { error: GIT_URL_ERROR };
		const host = parseHostPort(hostPort);
		if (host === null) return { error: GIT_URL_ERROR };
		const name = parsePath(pathPart);
		if (name === null) return { error: GIT_URL_ERROR };
		return {
			scheme,
			host: host.host,
			port: host.port,
			hostKey: host.port === null ? host.host : `${host.host}:${host.port}`,
			name,
		};
	}
	// scp form: user@host:path (no port; the first colon starts the path, which may not be absolute).
	const scp = /^([A-Za-z0-9_.-]+)@([A-Za-z0-9.-]+):(\S.*)$/.exec(url);
	if (scp === null || (scp[3]?.startsWith("/") ?? true))
		return { error: GIT_URL_ERROR };
	const host = parseHostPort(scp[2] ?? "");
	if (host === null) return { error: GIT_URL_ERROR };
	const name = parsePath(scp[3] ?? "");
	if (name === null) return { error: GIT_URL_ERROR };
	return {
		scheme: "ssh",
		host: host.host,
		port: host.port,
		hostKey: host.port === null ? host.host : `${host.host}:${host.port}`,
		name,
	};
}

export function parseGitToken(
	body: Record<string, unknown>,
): GitToken | { error: string } {
	const { host, username, token } = body;
	if (typeof host !== "string") return { error: "host is required" };
	const parsed = parseHostPort(host.trim());
	if (parsed === null)
		return {
			error:
				"host must be a hostname like git.example.com or git.example.com:8443",
		};
	if (
		username !== undefined &&
		(typeof username !== "string" || !/^[A-Za-z0-9_.@-]{1,100}$/.test(username))
	)
		return {
			error: "username must be 1-100 characters: letters, digits, _ . @ -",
		};
	// 8+ chars: git output is redacted for every stored token (worktree.ts git()), and a token
	// that short could match inside a sha or ref name. Real host tokens are 20+ chars.
	if (typeof token !== "string" || !/^[\x21-\x7e]{8,512}$/.test(token))
		return {
			error: "token must be 8-512 printable characters without whitespace",
		};
	return {
		host: parsed.port === null ? parsed.host : `${parsed.host}:${parsed.port}`,
		username: username ?? "oauth2",
		token,
	};
}

/**
 * Server-only ssh material lives in a data dir outside every checkout: OTTR_SSH_DIR when set
 * (compose sets it on the ottr-state volume, which no worker mounts), else <OTTR_STATE_DIR>/ssh
 * when a state dir is set (dev boards, scratch runs), else the user's data
 * dir (%LOCALAPPDATA%\\ottr\\ssh, or $XDG_DATA_HOME/ottr/ssh, default ~/.local/share/ottr/ssh).
 * Never the Ottr checkout or a project checkout: a key there would sit in a work tree.
 */
export function defaultSshDir(
	env: Record<string, string | undefined> = process.env,
	platform: string = process.platform,
	home: string = homedir(),
): string {
	const set = env.OTTR_SSH_DIR?.trim();
	if (set) return resolve(set);
	// The same isolation as the global store (src/server.ts STATE_DIR, src/dev.ts): a dev board
	// or a scratch run keeps its keys in its own state dir, never in the production one.
	const state = env.OTTR_STATE_DIR?.trim();
	if (state) return join(resolve(state), "ssh");
	const base =
		platform === "win32"
			? (env.LOCALAPPDATA ?? join(home, "AppData", "Local"))
			: (env.XDG_DATA_HOME ?? join(home, ".local", "share"));
	return join(base, "ottr", "ssh");
}

export function sshPaths(dir: string): SshPaths {
	return {
		dir,
		global: join(dir, "global"),
		knownHosts: join(dir, "known_hosts"),
		project(name: string): string {
			// Key paths reach a shell command (GIT_SSH_COMMAND): only plain names get an own key.
			if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name))
				throw new Error(`not a project name: ${name}`);
			return join(dir, "projects", name);
		},
		pending(id: string): string {
			if (!/^[0-9a-f]{32}$/.test(id))
				throw new Error(`not a pending key id: ${id}`);
			return join(dir, "pending", id);
		},
	};
}

// SHA256 fingerprints, one per input line, in input order (`ssh-keygen -l -E sha256 -f -`).
async function fingerprints(lines: readonly string[]): Promise<string[]> {
	if (lines.length === 0) return [];
	const stdin = lines.map((l) => `${l.trim()}\n`).join("");
	const r = await runTool(
		["ssh-keygen", "-l", "-E", "sha256", "-f", "-"],
		stdin,
	);
	return [...r.stdout.matchAll(/SHA256:[A-Za-z0-9+/=]+/g)].map(
		(m) => m[0] ?? "",
	);
}

/** Public key and fingerprint of a private key file; null when the file does not exist. */
export async function keyInfo(path: string): Promise<KeyInfo | null> {
	if (!existsSync(path)) return null;
	let pub: string;
	if (existsSync(`${path}.pub`))
		pub = readFileSync(`${path}.pub`, "utf8").trim();
	else {
		const r = await runTool(["ssh-keygen", "-y", "-P", "", "-f", path]);
		if (r.code !== 0)
			throw new Error(
				lastLine(r.stderr) || "ssh-keygen could not read the key",
			);
		pub = r.stdout.trim();
	}
	const fp = (await fingerprints([pub]))[0];
	if (fp === undefined)
		throw new Error("ssh-keygen could not fingerprint the public key");
	return { publicKey: `${pub}\n`, fingerprint: fp };
}

/** Makes an ed25519 key with no passphrase in dir/pending; returns its id and info. */
export async function generatePendingKey(
	dir: string,
): Promise<{ id: string } & KeyInfo> {
	const id = randomBytes(16).toString("hex");
	const keyPath = sshPaths(dir).pending(id);
	ensureDir(dir);
	ensureDir(join(dir, "pending"));
	const r = await runTool([
		"ssh-keygen",
		"-q",
		"-t",
		"ed25519",
		"-N",
		"",
		"-C",
		"ottr",
		"-f",
		keyPath,
	]);
	if (r.code !== 0) throw new Error(lastLine(r.stderr) || "ssh-keygen failed");
	chmodSync(keyPath, 0o600);
	chmodSync(`${keyPath}.pub`, 0o600);
	const info = await keyInfo(keyPath);
	if (info === null) throw new Error("ssh-keygen produced no key");
	return { id, ...info };
}

/** Writes a pasted private key to dir/pending and checks it; the file survives only unencrypted keys. */
export async function importPendingKey(
	dir: string,
	privateKey: string,
): Promise<({ id: string } & KeyInfo) | { error: string }> {
	if (Buffer.byteLength(privateKey, "utf8") > 16 * 1024)
		return { error: "the key is too large (max 16 KB)" };
	const text = `${privateKey.replaceAll("\r\n", "\n").trimEnd()}\n`;
	if (!text.includes("-----BEGIN"))
		return { error: "not a private key: no '-----BEGIN' line" };
	const id = randomBytes(16).toString("hex");
	const keyPath = sshPaths(dir).pending(id);
	ensureDir(dir);
	ensureDir(join(dir, "pending"));
	writeFileSync(keyPath, text, { mode: 0o600 });
	const r = await runTool(["ssh-keygen", "-y", "-P", "", "-f", keyPath]);
	if (r.code !== 0) {
		rmSync(keyPath, { force: true });
		return {
			error:
				"the key is malformed or has a passphrase: Ottr needs an unencrypted private key",
		};
	}
	writeFileSync(`${keyPath}.pub`, `${r.stdout.trimEnd()}\n`, { mode: 0o600 });
	const info = await keyInfo(keyPath);
	if (info === null) return { error: "the key was rejected" };
	return { id, ...info };
}

/** Moves a pending key into place (+ .pub when present), keeping the 0600/0700 rules. */
export function promoteKey(from: string, to: string): void {
	ensureDir(dirname(to));
	renameSync(from, to);
	chmodSync(to, 0o600);
	if (existsSync(`${from}.pub`)) {
		renameSync(`${from}.pub`, `${to}.pub`);
		chmodSync(`${to}.pub`, 0o600);
	}
}

/** Deletes a key and its .pub; a no-op when both are already absent. */
export function removeKey(path: string): void {
	rmSync(path, { force: true });
	rmSync(`${path}.pub`, { force: true });
}

// known_hosts names a non-standard port as [host]:port; entries Ottr writes are literal.
// ponytail: hashed known_hosts entries (@|1|…) never match, so they always re-ask for trust.
export const realKeyscan: Keyscan = async (host, port) => {
	const r = await runTool([
		"ssh-keyscan",
		"-T",
		"10",
		...(port === null ? [] : ["-p", String(port)]),
		"--",
		host,
	]);
	// keyscan exits 0 even for an unreachable host (comments only), so the lines are the verdict.
	const lines = r.stdout
		.split("\n")
		.filter((l) => l.trim() !== "" && !l.trimStart().startsWith("#"));
	if (lines.length === 0) return { error: `no host key received from ${host}` };
	return lines;
};

/**
 * null = the scanned keys are already in known_hosts, or trust equals their fingerprints and
 * they were written now. Never writes known_hosts before a matching trust.
 */
export async function checkHostKey(
	dir: string,
	remote: GitRemote,
	trust: unknown,
	scan: Keyscan = realKeyscan,
): Promise<null | TrustNeeded | { error: string }> {
	const raw = await scan(remote.host, remote.port);
	if (!Array.isArray(raw)) return raw;
	// A line needs host type key to become a known_hosts entry; anything else is noise.
	const scanned = raw.filter((l) => l.trim().split(/\s+/).length >= 3);
	if (scanned.length === 0)
		return { error: `no host key received from ${remote.host}` };
	const fresh = await fingerprints(scanned);
	if (fresh.length !== scanned.length)
		return {
			error: `ssh-keygen could not fingerprint the host keys of ${remote.host}`,
		};
	const paths = sshPaths(dir);
	const pattern =
		remote.port === null ? remote.host : `[${remote.host}]:${remote.port}`;
	const stored = existsSync(paths.knownHosts)
		? readFileSync(paths.knownHosts, "utf8")
		: "";
	const matching = stored.split("\n").filter((l) => {
		const f = l.trim().split(/\s+/);
		return (
			f.length >= 3 && f[0] !== undefined && f[0].split(",").includes(pattern)
		);
	});
	if (
		scanned.every((line) => {
			const f = line.trim().split(/\s+/);
			return matching.some((m) => {
				const g = m.trim().split(/\s+/);
				return g[1] === f[1] && g[2] === f[2];
			});
		})
	)
		return null;
	const trustList =
		Array.isArray(trust) && trust.every((t) => typeof t === "string")
			? (trust as string[])
			: null;
	// Set equality: same size, same members, in any order.
	const trusted =
		trustList !== null &&
		trustList.length === fresh.length &&
		new Set(trustList).size === fresh.length &&
		trustList.every((t) => fresh.includes(t));
	if (trusted) {
		const kept = stored
			.split("\n")
			.map((l) => {
				// Drop the pattern from a host list on the line; keep the rest of the line.
				const f = l.split(/\s+/);
				if (f.length < 3) return l;
				const hosts = (f[0] ?? "").split(",").filter((h) => h !== pattern);
				return hosts.length === 0
					? ""
					: [hosts.join(","), ...f.slice(1)].join(" ");
			})
			.filter((l) => l !== "")
			.concat(
				scanned.map((l) => {
					const f = l.trim().split(/\s+/);
					return [pattern, f[1], f[2]].join(" ");
				}),
			);
		ensureDir(dir);
		writeFileSync(paths.knownHosts, `${kept.join("\n")}\n`, { mode: 0o600 });
		return null;
	}
	return {
		error:
			matching.length > 0
				? `the host key of ${remote.hostKey} changed: confirm the new fingerprint`
				: `confirm the host key of ${remote.hostKey}`,
		needsTrust: true,
		host: remote.hostKey,
		fingerprints: fresh,
		changed: matching.length > 0,
	};
}

/**
 * The credential helpers of the global and system git config, in order, so gitAuthEnv can
 * re-add them after its reset (the GitHub GH_TOKEN helper of the image is a system one).
 * ponytail: read once per app start; a helper added to ~/.gitconfig later needs a restart.
 */
export function readAmbientHelpers(): [string, string][] {
	const out: [string, string][] = [];
	for (const scope of ["--system", "--global"]) {
		const r = Bun.spawnSync(
			["git", "config", scope, "--get-regexp", "^credential\\..*helper$"],
			{ stdout: "pipe", stderr: "pipe", windowsHide: true },
		);
		if (r.exitCode !== 0) continue;
		for (const line of r.stdout.toString().split("\n")) {
			if (line === "") continue;
			const i = line.indexOf(" ");
			out.push(i === -1 ? [line, ""] : [line.slice(0, i), line.slice(i + 1)]);
		}
	}
	return out;
}

/** A POSIX single-quoted word: a path with a quote can never end the quote early. */
const shq = (v: string): string =>
	`'${v.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;

/**
 * Credential env for one network git call on the server. A worker turn can write the shared
 * main checkout's .git/config (R5-1), and env config outranks it, so this env also neutralizes
 * the repo-config paths that could run a command while the call holds the tokens: credential
 * helpers (reset, then the ambient global/system ones and Ottr's re-added), ext:: transport,
 * signed pushes, askpass and core.sshCommand. Residual (R5-1, docs/WORKERS.md): a planted
 * remote.<name>.uploadpack/receivepack on a local-path remote is first-wins in git, so env
 * config cannot override it.
 */
export function gitAuthEnv(o: {
	tokens: readonly GitToken[];
	key: string | null;
	knownHosts: string;
	/** credential helpers from the global and system config (src/app.ts reads them once). */
	ambientHelpers?: readonly (readonly [string, string])[];
}): Record<string, string> {
	const env: Record<string, string> = {
		GIT_TERMINAL_PROMPT: "0",
		// Empty: git skips GIT_ASKPASS, core.askPass and SSH_ASKPASS alike.
		GIT_ASKPASS: "",
	};
	const config: (readonly [string, string])[] = [
		["protocol.ext.allow", "never"],
		["push.gpgSign", "false"],
	];
	// Always: an empty value clears every helper read so far (repo config included), so a
	// planted helper never runs next to GH_TOKEN or the key path, tokens stored or not.
	config.push(["credential.helper", ""], ...(o.ambientHelpers ?? []));
	o.tokens.forEach((t, i) => {
		// The helper reads the token from env, so the token never lands in argv or .git/config.
		// printf, not echo: dash's echo would read a backslash in a token as an escape.
		config.push([
			`credential.https://${t.host}.helper`,
			`!f() { test "$1" = get || exit 0; printf 'username=%s\\npassword=%s\\n' "$OTTR_GIT_USER_${i}" "$OTTR_GIT_TOKEN_${i}"; }; f`,
		]);
		env[`OTTR_GIT_USER_${i}`] = t.username;
		env[`OTTR_GIT_TOKEN_${i}`] = t.token;
	});
	config.forEach(([k, v], i) => {
		env[`GIT_CONFIG_KEY_${i}`] = k;
		env[`GIT_CONFIG_VALUE_${i}`] = v;
	});
	env.GIT_CONFIG_COUNT = String(config.length);
	// Always set (it beats core.sshCommand). Once Ottr holds a confirmed host (its known_hosts
	// exists), every ssh run keeps the strict host controls, also after the last key is removed.
	const strict = `-o UserKnownHostsFile=${shq(o.knownHosts)} -o StrictHostKeyChecking=yes -o BatchMode=yes`;
	env.GIT_SSH_COMMAND =
		o.key !== null
			? `ssh -i ${shq(o.key)} -o IdentitiesOnly=yes ${strict}`
			: existsSync(o.knownHosts)
				? `ssh ${strict}`
				: "ssh -o BatchMode=yes";
	return env;
}

export const GIT_AUTH_ENV_RE =
	/^(GIT_ASKPASS|GIT_SSH_COMMAND|GIT_CONFIG_COUNT|GIT_CONFIG_(KEY|VALUE)_\d+|OTTR_GIT_(USER|TOKEN)_\d+)$/;

// git names these when it cannot authenticate; " 401"/" 403" cover raw HTTP status text.
/** git's wording when it cannot authenticate (also for the merge push the server takes over). */
export const GIT_AUTH_FAILURE =
	/Authentication failed|could not read Username|terminal prompts disabled|HTTP Basic: Access denied| 401| 403|Permission denied/;

/** `git ls-remote` against the URL with the auth env; the error line is redacted. */
export async function testRemote(
	url: string,
	env: Record<string, string>,
	secrets: readonly string[],
): Promise<{ ok: true } | { error: string; auth: boolean }> {
	const r = await git(["ls-remote", "--", url], tmpdir(), 30_000, env);
	if (r.code === 0) return { ok: true };
	const last = lastLine(r.stderr) || "git ls-remote failed";
	return {
		error: redact(last, secrets),
		auth: GIT_AUTH_FAILURE.test(r.stderr),
	};
}

// The secret store and redaction live in worktree.ts, where git() redacts network output too.
export { gitSecrets, redact, setGitSecrets } from "./worktree.ts";
