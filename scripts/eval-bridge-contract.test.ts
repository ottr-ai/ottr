import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBundle, EVAL_BRIDGE_ID_PATTERN } from "./eval-bridge-contract.ts";

// The real minified form (variable names differ per build; the template survives).
const MINIFIED =
	// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal text pins omp's id template
	"let i=`js-${e}-${crypto.randomUUID()}`,o=bK(Oi(r)),s=U(t)?{...t}:t;";

describe("eval-bridge-contract", () => {
	test("a bundle that mints `js-<tool>-<uuid>` nested call ids passes", () => {
		expect(checkBundle(MINIFIED)).toBeNull();
	});

	test("a bundle that changed the id format fails with the tracker consequence", () => {
		const breach = checkBundle(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal text mimics omp's id template
			"let i=`eval-${e}-${crypto.randomUUID()}`,o=bK(Oi(r));",
		);
		expect(breach).toContain("extension/tracker.ts evalBridgeRefusal");
	});

	test("an empty bundle fails", () => {
		expect(checkBundle("")).toContain("js-");
	});

	test("the pattern stays anchored to the id template, not any js- text", () => {
		expect(EVAL_BRIDGE_ID_PATTERN.test("plain js- text")).toBe(false);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal text mimics omp's id template
		expect(EVAL_BRIDGE_ID_PATTERN.test("`js-${e}-${Date.now()}`")).toBe(false);
	});

	// The main path reads the real pinned omp through OMP_BIN (a PATH lookup in
	// production); a wrong bundle must exit non-zero so the check chain fails.
	test("the script main passes on the installed omp and fails on a wrong bundle", () => {
		const run = (bin: string) => {
			const child = Bun.spawnSync({
				cmd: [
					process.execPath,
					join(import.meta.dir, "eval-bridge-contract.ts"),
				],
				env: { ...process.env, OMP_BIN: bin },
				stdout: "pipe",
				stderr: "pipe",
			});
			return {
				code: child.exitCode,
				out: `${child.stdout.toString()}${child.stderr.toString()}`,
			};
		};
		const real = Bun.which("omp");
		if (real !== null) {
			const ok = run(real);
			expect(ok.code).toBe(0);
			expect(ok.out).toContain("eval-bridge-contract: ok");
		}
		const wrong = join(tmpdir(), `ottr-ebc-${crypto.randomUUID()}.js`);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal text mimics omp's id template
		writeFileSync(wrong, "let i=`eval-${e}`;");
		try {
			const bad = run(wrong);
			expect(bad.code).toBe(1);
			expect(bad.out).toContain("extension/tracker.ts evalBridgeRefusal");
		} finally {
			rmSync(wrong, { force: true });
		}
	});
});
