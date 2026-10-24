import { ensureAllPackages } from "./apt.ts";
import { ensureAllTools } from "./tools.ts";
import { serveWorker } from "./workers.ts";

// Fail closed: without the token the 0.0.0.0 /run endpoint lets any client run argv.
const token = process.env.OTTR_WORKER_TOKEN;
if (!token) {
	console.error("OTTR_WORKER_TOKEN is required");
	process.exit(1);
}

const server = serveWorker({
	port: Number(process.env.WORKER_PORT) || 8787,
	token,
});

// Serving starts at once: a turn that arrives during the install queues behind it (src/apt.ts).
Promise.all([
	ensureAllPackages().then(
		(lines) => lines,
		(err) => {
			throw new Error(`apt: ${err instanceof Error ? err.message : err}`);
		},
	),
	ensureAllTools().then(
		(lines) => lines,
		(err) => {
			throw new Error(`tools: ${err instanceof Error ? err.message : err}`);
		},
	),
]).then(
	(results) => {
		for (const line of results.flat()) console.log(line);
	},
	(err) => console.error(err instanceof Error ? err.message : String(err)),
);

process.on("SIGINT", () => {
	server.stop(true);
	process.exit(0);
});
process.on("SIGTERM", () => {
	server.stop(true);
	process.exit(0);
});
