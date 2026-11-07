import { afterAll, describe, expect, test } from "bun:test";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type VmGrant, VmTokens, vmTokenOf } from "./vmTokens.ts";

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function dir(): string {
	const d = mkdtempSync(join(tmpdir(), "ottr-vmtokens-"));
	dirs.push(d);
	return d;
}

const grant = (over: Partial<VmGrant> = {}): VmGrant => ({
	project: "alpha",
	taskId: "ALP-1",
	branch: "ott/alp-1-x",
	repoPath: "/workspace/alpha",
	worktree: "/workspace/alpha/.worktrees/ALP-1",
	...over,
});

describe("VmTokens", () => {
	test("a token maps to its grant until revoked; other tokens of the card stay until revokeTask", () => {
		const t = new VmTokens({ file: null });
		const a = t.issue(grant());
		const b = t.issue(grant());
		const other = t.issue(grant({ taskId: "ALP-2" }));
		const elsewhere = t.issue(grant({ project: "beta" }));
		expect(a).toMatch(/^[0-9a-f]{64}$/);
		expect(a).not.toBe(b);
		expect(t.check(a)).toEqual(grant());
		t.revoke(a);
		expect(t.check(a)).toBeNull();
		expect(t.check(b)).toEqual(grant());
		t.revokeTask("alpha", "ALP-1");
		expect(t.check(b)).toBeNull();
		// Same task id in another project, and another card of the project, survive.
		expect(t.check(other)?.taskId).toBe("ALP-2");
		expect(t.check(elsewhere)?.project).toBe("beta");
	});

	test("missing, empty, malformed and unknown tokens check as null", () => {
		const t = new VmTokens({ file: null });
		const raw = t.issue(grant());
		expect(t.check(null)).toBeNull();
		expect(t.check(undefined)).toBeNull();
		expect(t.check("")).toBeNull();
		expect(t.check(raw.toUpperCase())).toBeNull();
		expect(t.check(`${raw} `)).toBeNull();
		expect(t.check(raw.slice(1))).toBeNull();
		expect(t.check("0".repeat(64))).toBeNull();
	});

	test("a grant with an empty field is refused at issue", () => {
		const t = new VmTokens({ file: null });
		expect(() => t.issue(grant({ worktree: "" }))).toThrow();
	});

	test("the file keeps digests only, mode 0600, and a new instance loads them", () => {
		const file = join(dir(), "state", "vm-tokens.json");
		const t = new VmTokens({ file });
		const raw = t.issue(grant());
		const kept = t.issue(grant({ taskId: "ALP-2" }));
		const text = readFileSync(file, "utf8");
		expect(text).not.toContain(raw);
		expect(text).not.toContain(kept);
		if (process.platform !== "win32")
			expect(statSync(file).mode & 0o777).toBe(0o600);
		// A board restart keeps the live tokens.
		const reborn = new VmTokens({ file });
		expect(reborn.check(raw)).toEqual(grant());
		// A revoke persists too: the next restart does not resurrect it.
		reborn.revokeTask("alpha", "ALP-1");
		const third = new VmTokens({ file });
		expect(third.check(raw)).toBeNull();
		expect(third.check(kept)?.taskId).toBe("ALP-2");
		// No temp file is left beside it.
		expect(readdirSync(join(file, ".."))).toEqual(["vm-tokens.json"]);
	});

	test("a corrupt file or a bad entry starts without those tokens instead of throwing", () => {
		const d = dir();
		const file = join(d, "vm-tokens.json");
		writeFileSync(file, "{not json");
		expect(() => new VmTokens({ file })).not.toThrow();
		const t = new VmTokens({ file: join(d, "fresh.json") });
		const raw = t.issue(grant());
		const good = JSON.parse(readFileSync(join(d, "fresh.json"), "utf8"));
		writeFileSync(
			file,
			JSON.stringify({
				...good,
				["a".repeat(64)]: { ...grant(), branch: 7 },
				"not-a-digest": grant(),
			}),
		);
		const loaded = new VmTokens({ file });
		expect(loaded.check(raw)).toEqual(grant());
	});
});

describe("vmTokenOf", () => {
	const req = (authorization?: string) =>
		new Request("http://board/x", {
			headers: authorization === undefined ? {} : { authorization },
		});
	test("reads Bearer and the Basic password; anything else is no token", () => {
		expect(vmTokenOf(req("Bearer abc"))).toBe("abc");
		expect(vmTokenOf(req("bearer abc"))).toBe("abc");
		const basic = Buffer.from("x-token:s3cr:et").toString("base64");
		expect(vmTokenOf(req(`Basic ${basic}`))).toBe("s3cr:et");
		const userOnly = Buffer.from("only-user").toString("base64");
		expect(vmTokenOf(req(`Basic ${userOnly}`))).toBeNull();
		expect(vmTokenOf(req("Token abc"))).toBeNull();
		expect(vmTokenOf(req("Bearer a b"))).toBeNull();
		expect(vmTokenOf(req())).toBeNull();
	});
});
