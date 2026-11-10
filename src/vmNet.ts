/**
 * vm-runner networking (docs/adr/0009-microvm-workers.md): one tap per microVM (`ovm<n>`)
 * with a /30 out of 10.231.0.0/16, and iptables chains that let a VM reach the board's
 * ip:port and the internet (MASQUERADE) but no other private or compose address — not the
 * other VMs, not vm-runner's own API. The builders are pure argv lists so the rule set is
 * testable without NET_ADMIN; the executors run them through an injected exec.
 */
import { lookup } from "node:dns/promises";
import { isIPv4 } from "node:net";

export interface ExecResult {
	code: number | null;
	stdout: string;
	stderr: string;
}
/** Runs one argv to completion; never throws for a non-zero exit. */
export type Exec = (argv: string[]) => Promise<ExecResult>;

export const defaultExec: Exec = async (argv) => {
	try {
		const p = Bun.spawn(argv, {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(p.stdout).text(),
			new Response(p.stderr).text(),
			p.exited,
		]);
		return { code, stdout, stderr };
	} catch (err) {
		// A missing binary throws from spawn; callers treat it like a failed command.
		return {
			code: null,
			stdout: "",
			stderr: err instanceof Error ? err.message : String(err),
		};
	}
};

const VM_SUBNET = "10.231.0.0/16";
const TAP_PREFIX = "ovm";
/** Jumped to from FORWARD: what a VM may reach through vm-runner. */
const FORWARD_CHAIN = "OTTR-VM";
/** Jumped to from INPUT: a VM may not open connections to vm-runner itself. */
const INPUT_CHAIN = "OTTR-VM-IN";
/** Jumped to from nat POSTROUTING: internet egress. */
const NAT_CHAIN = "OTTR-VM-NAT";
/** Private, CGNAT, reserved, link-local (cloud metadata) and compose ranges a VM must never reach. */
export const PRIVATE_RANGES = [
	"10.0.0.0/8",
	"172.16.0.0/12",
	"192.168.0.0/16",
	"169.254.0.0/16",
	"100.64.0.0/10",
	"0.0.0.0/8",
	"192.0.0.0/24",
	"198.18.0.0/15",
] as const;
/** /30 blocks in a /16. */
const MAX_SLOTS = 16384;

export interface Slot {
	index: number;
	tap: string;
	hostIp: string;
	guestIp: string;
	mac: string;
}

export interface BoardAddr {
	ip: string;
	port: number;
}

/** Slot n owns 10.231.0.0 + 4n: .1 is the tap (host side), .2 the guest. */
export function slotFor(index: number): Slot {
	if (!Number.isInteger(index) || index < 0 || index >= MAX_SLOTS)
		throw new Error(`slot ${index} is outside 0..${MAX_SLOTS - 1}`);
	const base = index * 4;
	const hi = base >> 8;
	const lo = base & 0xff;
	return {
		index,
		tap: `${TAP_PREFIX}${index}`,
		hostIp: `10.231.${hi}.${lo + 1}`,
		guestIp: `10.231.${hi}.${lo + 2}`,
		// Locally administered unicast (06:...), unique per slot through the guest ip.
		mac: `06:00:0a:e7:${hi.toString(16).padStart(2, "0")}:${(lo + 2).toString(16).padStart(2, "0")}`,
	};
}

const ipt = (...args: string[]): string[] => ["iptables", "-w", ...args];

/**
 * Removes every chain and jump a previous vm-runner left; each command may fail (nothing
 * to remove) and is ignored. The jumps go first: iptables refuses to delete a chain that
 * is still referenced.
 */
function teardownCommands(): string[][] {
	return [
		ipt("-D", "FORWARD", "-j", FORWARD_CHAIN),
		ipt("-D", "INPUT", "-j", INPUT_CHAIN),
		ipt("-t", "nat", "-D", "POSTROUTING", "-j", NAT_CHAIN),
		ipt("-F", FORWARD_CHAIN),
		ipt("-X", FORWARD_CHAIN),
		ipt("-F", INPUT_CHAIN),
		ipt("-X", INPUT_CHAIN),
		ipt("-t", "nat", "-F", NAT_CHAIN),
		ipt("-t", "nat", "-X", NAT_CHAIN),
	];
}

/**
 * The fixed rule set. The per-run allow rule for the board's ip:port is inserted at
 * position 2 of FORWARD_CHAIN by slotUpCommands (the port comes from the request's
 * boardUrl), so it lands after the conntrack accept and before every drop.
 */
export function startupCommands(): string[][] {
	const taps = `${TAP_PREFIX}+`;
	return [
		["sysctl", "-w", "net.ipv4.ip_forward=1"],
		ipt("-N", FORWARD_CHAIN),
		ipt(
			"-A",
			FORWARD_CHAIN,
			"-m",
			"conntrack",
			"--ctstate",
			"ESTABLISHED,RELATED",
			"-j",
			"ACCEPT",
		),
		ipt("-A", FORWARD_CHAIN, "-i", taps, "-o", taps, "-j", "DROP"),
		...PRIVATE_RANGES.map((r) =>
			ipt("-A", FORWARD_CHAIN, "-i", taps, "-d", r, "-j", "DROP"),
		),
		// Nothing outside opens a connection to a VM; replies passed the conntrack accept.
		ipt("-A", FORWARD_CHAIN, "-o", taps, "-j", "DROP"),
		ipt("-I", "FORWARD", "1", "-j", FORWARD_CHAIN),
		ipt("-N", INPUT_CHAIN),
		ipt(
			"-A",
			INPUT_CHAIN,
			"-i",
			taps,
			"-m",
			"conntrack",
			"--ctstate",
			"ESTABLISHED,RELATED",
			"-j",
			"ACCEPT",
		),
		ipt("-A", INPUT_CHAIN, "-i", taps, "-j", "DROP"),
		ipt("-I", "INPUT", "1", "-j", INPUT_CHAIN),
		ipt("-t", "nat", "-N", NAT_CHAIN),
		ipt(
			"-t",
			"nat",
			"-A",
			NAT_CHAIN,
			"-s",
			VM_SUBNET,
			"!",
			"-o",
			taps,
			"-j",
			"MASQUERADE",
		),
		ipt("-t", "nat", "-I", "POSTROUTING", "1", "-j", NAT_CHAIN),
	];
}

function boardRule(slot: Slot, board: BoardAddr): string[] {
	return [
		"-i",
		slot.tap,
		"-s",
		slot.guestIp,
		"-d",
		`${board.ip}/32`,
		"-p",
		"tcp",
		"--dport",
		String(board.port),
		"-j",
		"ACCEPT",
	];
}

export function slotUpCommands(slot: Slot, board: BoardAddr): string[][] {
	return [
		["ip", "tuntap", "add", "dev", slot.tap, "mode", "tap"],
		["ip", "addr", "add", `${slot.hostIp}/30`, "dev", slot.tap],
		["ip", "link", "set", "dev", slot.tap, "up"],
		ipt("-I", FORWARD_CHAIN, "2", ...boardRule(slot, board)),
	];
}

export function slotDownCommands(slot: Slot, board: BoardAddr): string[][] {
	return [
		ipt("-D", FORWARD_CHAIN, ...boardRule(slot, board)),
		["ip", "link", "del", slot.tap],
	];
}

/** Tap names in `ip -o link show` output, e.g. "7: ovm3: <BROADCAST,...>". */
export function parseTaps(ipLinkOutput: string): string[] {
	const out: string[] = [];
	for (const line of ipLinkOutput.split("\n")) {
		const tap = /^\d+:\s+(ovm\d+)[:@]/.exec(line)?.[1];
		if (tap) out.push(tap);
	}
	return out;
}

const describe = (argv: string[], r: ExecResult): string =>
	`${argv.join(" ")}: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`;

/**
 * Startup: drop the previous process's taps and chains (a vm-runner restart kills its VMs
 * by design), then install the rule set. Returns null on success, else the one-line reason
 * /healthz reports.
 */
export async function netStartup(o: {
	exec: Exec;
	/** Reads /proc/sys/net/ipv4/ip_forward; injected for tests. */
	readIpForward: () => string | null;
}): Promise<string | null> {
	const links = await o.exec(["ip", "-o", "link", "show"]);
	if (links.code !== 0) return describe(["ip", "-o", "link", "show"], links);
	for (const tap of parseTaps(links.stdout))
		await o.exec(["ip", "link", "del", tap]);
	for (const argv of teardownCommands()) await o.exec(argv);
	for (const argv of startupCommands()) {
		const r = await o.exec(argv);
		if (r.code === 0) continue;
		// /proc/sys is read-only in an unprivileged container: compose sets the sysctl, and
		// an already-enabled forward is all the VMs need.
		if (argv[0] === "sysctl" && o.readIpForward()?.trim() === "1") continue;
		if (argv[0] === "sysctl")
			return "net.ipv4.ip_forward is 0 and cannot be set: give the vm-runner service sysctls net.ipv4.ip_forward=1";
		return describe(argv, r);
	}
	return null;
}

/** Brings a slot's tap and board allow rule up; on failure undoes what it did and throws. */
export async function slotUp(
	exec: Exec,
	slot: Slot,
	board: BoardAddr,
): Promise<void> {
	for (const argv of slotUpCommands(slot, board)) {
		const r = await exec(argv);
		if (r.code !== 0) {
			await slotDown(exec, slot, board);
			throw new Error(describe(argv, r));
		}
	}
}

/** Best effort: a missing rule or tap is already the goal state. */
export async function slotDown(
	exec: Exec,
	slot: Slot,
	board: BoardAddr,
): Promise<void> {
	for (const argv of slotDownCommands(slot, board)) await exec(argv);
}

/** OTTR_VM_BOARD_HOST to one IPv4 (the iptables allow rule and the guest's /etc/hosts). */
export async function resolveIpv4(host: string): Promise<string> {
	if (isIPv4(host)) return host;
	const r = await lookup(host, { family: 4 });
	return r.address;
}

/** The board's tcp port from the request's boardUrl. */
export function boardPort(boardUrl: string): number {
	const u = new URL(boardUrl);
	if (u.port) return Number(u.port);
	return u.protocol === "https:" ? 443 : 80;
}
