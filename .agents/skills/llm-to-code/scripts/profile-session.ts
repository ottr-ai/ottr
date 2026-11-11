// Profile an omp session (.jsonl): what each step cost, and which tool calls it made.
// Usage: bun profile-session.ts <session.jsonl> [--steps]
//        bun profile-session.ts --self-test
// Read-only. Prints no tool arguments except the short intent, so secrets in commands stay out.

type Usage = { totalTokens?: number; output?: number; cost?: { total?: number } };
type Line = { type: string; message?: any; usage?: Usage; purpose?: string; model?: string };

export function profile(lines: Line[]) {
	const tools = new Map<string, { calls: number; tokens: number; cost: number; resultChars: number }>();
	const steps: string[] = [];
	const side = new Map<string, { calls: number; tokens: number; cost: number }>();
	let tokens = 0, cost = 0, turns = 0, userMsgs = 0;
	const row = (name: string) => tools.get(name) ?? tools.set(name, { calls: 0, tokens: 0, cost: 0, resultChars: 0 }).get(name)!;
	for (const l of lines) {
		const m = l.message;
		if (l.type === "model_usage") {
			// Side calls (titles, captions, memory): not agent turns, but still tokens.
			const k = `${l.purpose ?? "?"} (${l.model ?? "?"})`;
			const s = side.get(k) ?? side.set(k, { calls: 0, tokens: 0, cost: 0 }).get(k)!;
			s.calls++; s.tokens += l.usage?.totalTokens ?? 0; s.cost += l.usage?.cost?.total ?? 0;
			continue;
		}
		if (l.type !== "message" || !m) continue;
		if (m.role === "user") { userMsgs++; steps.push(`USER: ${text(m.content).slice(0, 100)}`); continue; }
		if (m.role === "toolResult") { row(m.toolName ?? "?").resultChars += text(m.content).length; continue; }
		if (m.role !== "assistant") continue;
		turns++;
		const t = m.usage?.totalTokens ?? 0, c = m.usage?.cost?.total ?? 0;
		tokens += t; cost += c;
		const calls = (m.content ?? []).filter((x: any) => x.type === "toolCall");
		// A turn's cost goes to the calls it made, split evenly; a turn with no call is the answer text.
		const names = calls.length ? calls.map((x: any) => x.name) : ["(answer text)"];
		for (const n of names) { const r = row(n); r.calls++; r.tokens += t / names.length; r.cost += c / names.length; }
		for (const x of calls) steps.push(`${x.name}: ${String(x.intent ?? x.arguments?.i ?? "").slice(0, 80)}`);
	}
	return { turns, userMsgs, tokens, cost, tools, side, steps };
}

function text(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((c: any) => (c.type === "text" ? c.text : "")).join("");
}

function report(p: ReturnType<typeof profile>, withSteps: boolean) {
	const f = (n: number) => Math.round(n).toLocaleString("en");
	console.log(`agent turns ${p.turns}, user messages ${p.userMsgs}, tokens ${f(p.tokens)}, cost $${p.cost.toFixed(2)}`);
	console.log("\n| tool | calls | tokens (share of turns) | cost $ | result chars |\n|---|---|---|---|---|");
	for (const [n, r] of [...p.tools].sort((a, b) => b[1].tokens - a[1].tokens))
		console.log(`| ${n} | ${r.calls} | ${f(r.tokens)} | ${r.cost.toFixed(2)} | ${f(r.resultChars)} |`);
	if (p.side.size) {
		console.log("\n| side call | calls | tokens | cost $ |\n|---|---|---|---|");
		for (const [n, s] of p.side) console.log(`| ${n} | ${s.calls} | ${f(s.tokens)} | ${s.cost.toFixed(2)} |`);
	}
	if (withSteps) { console.log("\nsteps:"); p.steps.forEach((s, i) => console.log(`${i + 1}. ${s}`)); }
}

function selfTest() {
	const a = (role: string, content: unknown, usage?: Usage) => ({ type: "message", message: { role, content, usage } });
	const p = profile([
		a("user", [{ type: "text", text: "find keywords" }]),
		a("assistant", [{ type: "toolCall", name: "read", intent: "Reading page" }, { type: "toolCall", name: "bash", intent: "Grep" }], { totalTokens: 100, cost: { total: 1 } }),
		a("toolResult", [{ type: "text", text: "abcd" }]),
		{ type: "message", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "xyz" }] } },
		a("assistant", [{ type: "text", text: "done" }], { totalTokens: 40, cost: { total: 0.5 } }),
		{ type: "model_usage", purpose: "title", model: "m", usage: { totalTokens: 7, cost: { total: 0.01 } } },
		{ type: "custom" },
	] as Line[]);
	const eq = (x: unknown, y: unknown, w: string) => { if (x !== y) throw new Error(`${w}: ${x} !== ${y}`); };
	eq(p.turns, 2, "turns"); eq(p.tokens, 140, "tokens"); eq(p.userMsgs, 1, "user");
	eq(p.tools.get("read")!.tokens, 50, "split read"); eq(p.tools.get("bash")!.calls, 1, "bash calls");
	eq(p.tools.get("read")!.resultChars, 3, "result chars"); eq(p.tools.get("(answer text)")!.tokens, 40, "answer");
	eq(p.side.get("title (m)")!.tokens, 7, "side"); eq(p.steps.length, 3, "steps");
	console.log("self-test ok");
}

if (import.meta.main) {
	const [file, flag] = Bun.argv.slice(2);
	if (file === "--self-test") selfTest();
	else if (!file) { console.error("usage: bun profile-session.ts <session.jsonl> [--steps]"); process.exit(2); }
	else {
		const lines: Line[] = [];
		for (const l of (await Bun.file(file).text()).split("\n")) {
			if (!l.trim()) continue;
			try { lines.push(JSON.parse(l)); } catch { console.error("skipped a line that is not JSON"); }
		}
		report(profile(lines), flag === "--steps");
	}
}
