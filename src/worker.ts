import { ensureAllPackages } from "./apt.ts";
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
ensureAllPackages().then(
	(lines) => {
		for (const line of lines) console.log(line);
	},
	(err) => console.error(`apt: ${err instanceof Error ? err.message : err}`),
);

process.on("SIGINT", () => {
	server.stop(true);
	process.exit(0);
});
process.on("SIGTERM", () => {
	server.stop(true);
	process.exit(0);
});
