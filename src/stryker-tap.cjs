// Preloaded into every Node process of the Ottr image (NODE_OPTIONS in Dockerfile.worker).
// In a `stryker run` process it copies stdout into /tmp/ottr-stryker-<pid>.log. When that
// stdout is a pipe (rtk, the agent's shell), src/stryker.ts reads the progress from the copy,
// so the running card shows it whatever the agent's command does with the output. Every other
// process returns at once. CommonJS: NODE_OPTIONS --require loads it before the main module.
"use strict";

const [, script = "", ...args] = process.argv;
if (/(^|[\\/])stryker(\.js)?$/.test(script) && args.includes("run")) {
	try {
		const fs = require("node:fs");
		const file = `/tmp/ottr-stryker-${process.pid}.log`;
		const fd = fs.openSync(file, "w", 0o600);
		const write = process.stdout.write;
		let size = 0;
		process.stdout.write = function (chunk, ...rest) {
			try {
				const bytes = Buffer.from(chunk);
				// ponytail: start over at 1 MiB; the board reads only the last 16 KiB.
				if (size + bytes.length > 1 << 20) {
					fs.ftruncateSync(fd, 0);
					size = 0;
				}
				size += fs.writeSync(fd, bytes, 0, bytes.length, size);
			} catch {
				// The copy is best effort: it must never break the run's own output.
			}
			return write.apply(this, [chunk, ...rest]);
		};
		process.once("exit", () => {
			try {
				fs.rmSync(file);
			} catch {
				// Gone already.
			}
		});
	} catch {
		// No copy (for example a read-only /tmp): the card shows "Stryker running" only.
	}
}
