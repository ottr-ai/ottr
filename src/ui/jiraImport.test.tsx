import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Node as HappyNode, Window } from "happy-dom";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type {
	JiraBoardRow,
	JiraConnectionView,
	JiraRow,
	ProjectView,
} from "../types.ts";
import {
	JiraBoardImportButton,
	JiraBoardImportDialog,
	JiraImportButton,
	JiraImportDialog,
} from "./jiraImport.tsx";
import { JiraConnectionsSection } from "./settings.tsx";

// React interaction needs browser globals; bun test has none. happy-dom registers them
// here and afterAll puts the originals back (the settings.test.tsx pattern).
const window = new Window({ url: "http://localhost/" });
const host = globalThis as unknown as Record<string, unknown>;
const browserGlobals: Record<string, unknown> = {
	window,
	document: window.document,
	navigator: window.navigator,
	location: window.location,
	history: window.history,
	PopStateEvent: window.PopStateEvent,
	Event: window.Event,
	HTMLElement: window.HTMLElement,
	HTMLInputElement: window.HTMLInputElement,
	HTMLTextAreaElement: window.HTMLTextAreaElement,
	Node: window.Node,
	getComputedStyle: window.getComputedStyle,
	requestAnimationFrame: window.requestAnimationFrame,
	cancelAnimationFrame: window.cancelAnimationFrame,
};
const originals = new Map<string, unknown>();

beforeAll(() => {
	host.IS_REACT_ACT_ENVIRONMENT = true;
	for (const [key, value] of Object.entries(browserGlobals)) {
		originals.set(key, host[key]);
		host[key] = value;
	}
	// happy-dom has no popover API; the settings "?" help calls it. Per-Window classes,
	// so this never reaches another test file.
	const proto = window.HTMLElement.prototype as unknown as Record<
		string,
		unknown
	>;
	for (const method of ["showPopover", "hidePopover", "togglePopover"])
		if (proto[method] === undefined) proto[method] = () => {};
});

afterAll(() => {
	delete host.IS_REACT_ACT_ENVIRONMENT;
	for (const [key, value] of originals) {
		if (value === undefined) delete host[key];
		else host[key] = value;
	}
});

/** The production React handler `prop` on the node. happy-dom's input and change events
 *  never reach React's ChangeEventPlugin, so tests call the rendered handler directly.
 *  happy-dom's <select> is a proxy that hides its own expando keys, so the props key
 *  (one random suffix per React root) is read off the nearest node that lists it. */
const handlerOf = (node: Element, prop: string): ((e: unknown) => void) => {
	let probe: Element | null = node;
	let key: string | undefined;
	while (probe !== null && key === undefined) {
		key = Object.getOwnPropertyNames(probe).find((k) =>
			k.startsWith("__reactProps$"),
		);
		probe = probe.parentElement;
	}
	if (key === undefined) throw new Error("react props missing on node");
	const props = (node as unknown as Record<string, unknown>)[key] as Record<
		string,
		((e: unknown) => void) | undefined
	>;
	const handler = props[prop];
	if (handler === undefined) throw new Error(`node has no ${prop}`);
	return handler;
};

/** Lets the fetch chains and the state updates they start settle inside act. */
const settle = async (): Promise<void> => {
	await act(async () => {
		await Bun.sleep(5);
	});
};

const fire = async (node: Element, prop: string, e: unknown = {}) => {
	await act(async () => {
		handlerOf(node, prop)(e);
	});
	await settle();
};

const submit = async (form: Element): Promise<void> => {
	await act(async () => {
		form.dispatchEvent(
			new window.Event("submit", {
				bubbles: true,
				cancelable: true,
			}) as unknown as Event,
		);
	});
	await settle();
};

type Call = { method: string; url: string; body: unknown };
type Route = (call: Call) => Response;

const json = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

/** Mounts `node` against `route`; every request lands in `calls`. */
async function mount(
	node: ReactNode,
	route: Route,
): Promise<{
	container: HTMLDivElement;
	calls: Call[];
	unmount: () => Promise<void>;
}> {
	const calls: Call[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const call = {
			method: init?.method ?? "GET",
			url: String(input),
			body:
				init?.body === undefined ? undefined : JSON.parse(String(init.body)),
		};
		calls.push(call);
		return route(call);
	}) as typeof fetch;
	const container = window.document.createElement(
		"div",
	) as unknown as HTMLDivElement;
	window.document.body.appendChild(container as unknown as HappyNode);
	const root = createRoot(container);
	await act(async () => {
		root.render(node);
	});
	await settle();
	return {
		container,
		calls,
		unmount: async () => {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			globalThis.fetch = realFetch;
		},
	};
}

const project = (jiraConnection: string | null = "work"): ProjectView =>
	({
		name: "proj",
		settings: {
			displayName: null,
			jiraConnection,
			jiraLastJql: "project = PROJ ORDER BY key",
		},
	}) as unknown as ProjectView;

const row = (key: string, importedCard: string | null = null): JiraRow => ({
	key,
	url: `https://acme.atlassian.net/browse/${key}`,
	summary: `Summary of ${key}`,
	issueType: "Story",
	status: "To Do",
	priority: "Medium",
	importedCard,
});

const SEARCH = "/api/projects/proj/jira/search";
const IMPORT = "/api/projects/proj/jira/import";

const dialog = (route: Route) =>
	mount(
		<JiraImportDialog
			project={project()}
			onClose={() => {}}
			openTask={() => {}}
		/>,
		route,
	);

const q = <T extends Element>(root: Element, sel: string): T => {
	const el = root.querySelector<T>(sel);
	if (el === null) throw new Error(`missing ${sel}`);
	return el;
};

const boxOf = (root: Element, key: string): HTMLInputElement =>
	q(root, `input[aria-label^="${key}:"]`);

const importButton = (root: Element): HTMLButtonElement => {
	const b = [...root.querySelectorAll("button")].find((x) =>
		x.textContent?.startsWith("Import "),
	);
	if (b === undefined) throw new Error("import button missing");
	return b as HTMLButtonElement;
};

const loadMore = (root: Element): HTMLButtonElement | undefined =>
	[...root.querySelectorAll("button")].find(
		(x) => x.textContent === "Load more",
	) as HTMLButtonElement | undefined;

const status = (root: Element): string =>
	q(root, "p.jira-status").textContent ?? "";

describe("JiraImportDialog", () => {
	test("opens with the project's last JQL and searches it", async () => {
		const { container, calls, unmount } = await dialog(() =>
			json(200, {
				rows: [row("PROJ-1"), row("PROJ-2", "OTTR-7")],
				next: null,
				total: 2,
			}),
		);
		try {
			const area = q<HTMLTextAreaElement>(container, "textarea");
			expect(area.value).toBe("project = PROJ ORDER BY key");
			const label = q(container, `label[for="${area.id}"]`);
			expect(label.textContent).toBe("JQL");
			await submit(q(container, "form.jira-search"));
			expect(calls).toEqual([
				{
					method: "POST",
					url: SEARCH,
					body: { jql: "project = PROJ ORDER BY key", cursor: null },
				},
			]);
			expect(container.querySelectorAll("li.jira-row")).toHaveLength(2);
			const link = q<HTMLAnchorElement>(container, "li.jira-row a");
			expect(link.getAttribute("href")).toBe(
				"https://acme.atlassian.net/browse/PROJ-1",
			);
			expect(link.getAttribute("target")).toBe("_blank");
			expect(link.getAttribute("rel")).toContain("noopener");
			expect(boxOf(container, "PROJ-1").disabled).toBe(false);
			// An imported ticket: disabled box, "already imported" and a link to its card.
			const imported = boxOf(container, "PROJ-2");
			expect(imported.disabled).toBe(true);
			const li = imported.closest("li");
			expect(li?.textContent).toContain("already imported");
			expect(
				li?.querySelector('a[href="/projects/proj/tasks/OTTR-7"]'),
			).not.toBeNull();
			// Load more shows only while the server has a next page.
			expect(loadMore(container)).toBeUndefined();
		} finally {
			await unmount();
		}
	});

	test("Ctrl+Enter in the JQL field searches", async () => {
		const { container, calls, unmount } = await dialog(() =>
			json(200, { rows: [], next: null, total: 0 }),
		);
		try {
			const area = q(container, "textarea");
			await fire(area, "onKeyDown", {
				key: "Enter",
				ctrlKey: true,
				metaKey: false,
				preventDefault() {},
			});
			expect(calls.map((c) => c.url)).toEqual([SEARCH]);
		} finally {
			await unmount();
		}
	});

	test("select all picks only importable rows; Load more appends unselected rows", async () => {
		const { container, calls, unmount } = await dialog(({ body }) => {
			const cursor =
				typeof body === "object" && body !== null && "cursor" in body
					? body.cursor
					: null;
			return cursor === null
				? json(200, {
						rows: [row("PROJ-1"), row("PROJ-2", "OTTR-7"), row("PROJ-3")],
						next: "50",
						total: 4,
					})
				: json(200, { rows: [row("PROJ-4")], next: null, total: 4 });
		});
		try {
			await submit(q(container, "form.jira-search"));
			expect(importButton(container).disabled).toBe(true);
			expect(importButton(container).textContent).toBe("Import 0");
			const all = q<HTMLInputElement>(container, ".jira-all input");
			await fire(all, "onChange");
			expect(boxOf(container, "PROJ-1").checked).toBe(true);
			expect(boxOf(container, "PROJ-3").checked).toBe(true);
			expect(boxOf(container, "PROJ-2").checked).toBe(false);
			expect(all.checked).toBe(true);
			expect(importButton(container).textContent).toBe("Import 2");
			const more = loadMore(container);
			if (more === undefined) throw new Error("load more missing");
			await fire(more, "onClick");
			expect(calls[1]).toEqual({
				method: "POST",
				url: SEARCH,
				body: { jql: "project = PROJ ORDER BY key", cursor: "50" },
			});
			expect(container.querySelectorAll("li.jira-row")).toHaveLength(4);
			expect(boxOf(container, "PROJ-4").checked).toBe(false);
			expect(importButton(container).textContent).toBe("Import 2");
			// Partial selection: the select-all box shows the mixed state.
			expect(all.checked).toBe(false);
			expect(all.indeterminate).toBe(true);
			expect(loadMore(container)).toBeUndefined();
		} finally {
			await unmount();
		}
	});

	test("a new search clears the selection", async () => {
		const { container, unmount } = await dialog(() =>
			json(200, { rows: [row("PROJ-1")], next: null, total: 1 }),
		);
		try {
			const form = q(container, "form.jira-search");
			await submit(form);
			await fire(boxOf(container, "PROJ-1"), "onChange", {
				target: { checked: true },
			});
			expect(importButton(container).textContent).toBe("Import 1");
			await submit(form);
			expect(boxOf(container, "PROJ-1").checked).toBe(false);
			expect(importButton(container).disabled).toBe(true);
		} finally {
			await unmount();
		}
	});

	test("Import posts the keys into Backlog, reports the count and marks the rows imported", async () => {
		let filed = false;
		const { container, calls, unmount } = await dialog(({ url }) => {
			if (url === IMPORT) {
				filed = true;
				return json(200, {
					filed: ["OTTR-10", "OTTR-11"],
					skipped: [],
					unavailable: [],
				});
			}
			return json(200, {
				rows: [
					row("PROJ-1", filed ? "OTTR-10" : null),
					row("PROJ-2", filed ? "OTTR-11" : null),
					row("PROJ-3"),
				],
				next: null,
				total: 3,
			});
		});
		try {
			await submit(q(container, "form.jira-search"));
			for (const key of ["PROJ-1", "PROJ-2"])
				await fire(boxOf(container, key), "onChange", {
					target: { checked: true },
				});
			await fire(importButton(container), "onClick");
			expect(calls.find((c) => c.url === IMPORT)?.body).toEqual({
				keys: ["PROJ-1", "PROJ-2"],
				stage: "backlog",
			});
			expect(status(container)).toBe("Filed 2 cards");
			// The loaded page re-ran: the filed tickets now show as imported.
			expect(calls.at(-1)?.url).toBe(SEARCH);
			expect(boxOf(container, "PROJ-1").disabled).toBe(true);
			expect(boxOf(container, "PROJ-2").disabled).toBe(true);
			expect(boxOf(container, "PROJ-3").disabled).toBe(false);
			expect(importButton(container).textContent).toBe("Import 0");
		} finally {
			await unmount();
		}
	});

	test("Import into Todo sends stage todo and names race-skipped tickets", async () => {
		const { container, calls, unmount } = await dialog(({ url }) =>
			url === IMPORT
				? json(200, {
						filed: ["OTTR-10"],
						skipped: ["PROJ-2"],
						unavailable: [],
					})
				: json(200, {
						rows: [row("PROJ-1"), row("PROJ-2")],
						next: null,
						total: 2,
					}),
		);
		try {
			await submit(q(container, "form.jira-search"));
			await fire(q(container, ".jira-all input"), "onChange");
			await fire(q(container, 'input[type="radio"][value="todo"]'), "onChange");
			expect(
				q<HTMLInputElement>(container, 'input[type="radio"][value="todo"]')
					.checked,
			).toBe(true);
			await fire(importButton(container), "onClick");
			expect(calls.find((c) => c.url === IMPORT)?.body).toEqual({
				keys: ["PROJ-1", "PROJ-2"],
				stage: "todo",
			});
			expect(status(container)).toBe(
				"Filed 1 card. 1 skipped: already imported",
			);
		} finally {
			await unmount();
		}
	});

	test("a ticket Jira no longer returns is named as unavailable, not as imported", async () => {
		const { container, unmount } = await dialog(({ url }) =>
			url === IMPORT
				? json(200, {
						filed: ["OTTR-10"],
						skipped: [],
						unavailable: ["PROJ-2"],
					})
				: json(200, {
						rows: [row("PROJ-1"), row("PROJ-2")],
						next: null,
						total: 2,
					}),
		);
		try {
			await submit(q(container, "form.jira-search"));
			await fire(q(container, ".jira-all input"), "onChange");
			await fire(importButton(container), "onClick");
			expect(status(container)).toBe(
				"Filed 1 card. 1 not available in Jira (deleted or no access): PROJ-2",
			);
		} finally {
			await unmount();
		}
	});

	test("the import result stays shown when the refresh after it matches nothing", async () => {
		let imported = false;
		const { container, unmount } = await dialog(({ url }) => {
			if (url === IMPORT) {
				imported = true;
				return json(200, {
					filed: [],
					skipped: [],
					unavailable: ["PROJ-1", "PROJ-2"],
				});
			}
			// Both tickets vanished from Jira: the refresh after the import is empty.
			return json(200, {
				rows: imported ? [] : [row("PROJ-1"), row("PROJ-2")],
				next: null,
				total: imported ? 0 : 2,
			});
		});
		try {
			await submit(q(container, "form.jira-search"));
			await fire(q(container, ".jira-all input"), "onChange");
			await fire(importButton(container), "onClick");
			expect(imported).toBe(true);
			expect(status(container)).toBe(
				"Filed 0 cards. 2 not available in Jira (deleted or no access): PROJ-1, PROJ-2",
			);
			// A new search clears the import result, and an empty result says so again.
			await submit(q(container, "form.jira-search"));
			expect(status(container)).toBe("No tickets match.");
		} finally {
			await unmount();
		}
	});

	test("Backlog is the default stage", async () => {
		const { container, unmount } = await dialog(() =>
			json(200, { rows: [], next: null, total: 0 }),
		);
		try {
			const backlog = q<HTMLInputElement>(
				container,
				'input[type="radio"][value="backlog"]',
			);
			expect(backlog.checked).toBe(true);
		} finally {
			await unmount();
		}
	});

	test("Jira's JQL error from a 400 shows in an alert", async () => {
		const message =
			"Error in the JQL Query: Expecting either a value, list or function but got 'AND'.";
		const { container, unmount } = await dialog(() =>
			json(400, { error: message }),
		);
		try {
			await submit(q(container, "form.jira-search"));
			expect(q(container, 'p[role="alert"]').textContent).toBe(message);
			expect(container.querySelector("li.jira-row")).toBeNull();
		} finally {
			await unmount();
		}
	});

	test("zero hits says no tickets match", async () => {
		const { container, unmount } = await dialog(() =>
			json(200, { rows: [], next: null, total: 0 }),
		);
		try {
			expect(status(container)).toBe("");
			await submit(q(container, "form.jira-search"));
			expect(status(container)).toBe("No tickets match.");
			expect(q(container, "p.jira-status").getAttribute("role")).toBe("status");
		} finally {
			await unmount();
		}
	});
});

describe("JiraImportButton", () => {
	test("renders only when the project has a Jira connection", () => {
		expect(
			renderToStaticMarkup(
				<JiraImportButton project={project(null)} onOpen={() => {}} />,
			),
		).toBe("");
		expect(
			renderToStaticMarkup(
				<JiraImportButton project={project("work")} onOpen={() => {}} />,
			),
		).toContain("Import from Jira");
	});
});

describe("JiraConnectionsSection", () => {
	const conn = (over: Partial<JiraConnectionView>): JiraConnectionView => ({
		name: "work",
		site: "https://acme.atlassian.net",
		type: "cloud",
		email: "me@acme.test",
		customFields: [],
		tokenSet: true,
		tokenReadable: true,
		usedBy: [],
		...over,
	});
	const LIST = "/api/jira/connections";

	test("lists connections with token state and the projects that use them", async () => {
		const { container, unmount } = await mount(<JiraConnectionsSection />, () =>
			json(200, [
				conn({ usedBy: ["proj", "web"] }),
				conn({
					name: "old",
					site: "https://jira.corp/jira",
					type: "datacenter",
					email: null,
					tokenReadable: false,
				}),
			]),
		);
		try {
			const rows = [...container.querySelectorAll("li.jira-conn")];
			expect(rows).toHaveLength(2);
			expect(rows[0]?.textContent).toContain("Token set");
			expect(rows[0]?.textContent).toContain("Used by proj, web");
			expect(rows[1]?.textContent).toContain("Data Center");
			expect(rows[1]?.textContent).toContain(
				"Token unreadable, enter it again",
			);
			// The token never reaches the page: no field holds a value after the load.
			const token = q<HTMLInputElement>(container, 'input[aria-label="Token"]');
			expect(token.type).toBe("password");
			expect(token.value).toBe("");
			expect(token.getAttribute("placeholder")).toBeNull();
		} finally {
			await unmount();
		}
	});

	test("a failed type check shows the reason and keeps the type select; Data Center hides Email", async () => {
		const { container, calls, unmount } = await mount(
			<JiraConnectionsSection />,
			({ url }) =>
				url === "/api/jira/detect"
					? json(200, { type: null, reason: "serverInfo answered 403" })
					: json(200, []),
		);
		try {
			const site = q<HTMLInputElement>(
				container,
				'input[aria-label="Site URL"]',
			);
			await fire(site, "onChange", {
				target: { value: "https://jira.corp/jira" },
			});
			await fire(site, "onBlur");
			expect(calls.at(-1)).toEqual({
				method: "POST",
				url: "/api/jira/detect",
				body: { site: "https://jira.corp/jira" },
			});
			expect(container.textContent).toContain("serverInfo answered 403");
			const select = q<HTMLSelectElement>(
				container,
				'select[aria-label="Type"]',
			);
			expect(select.disabled).toBe(false);
			expect(
				container.querySelector('input[aria-label="Email"]'),
			).not.toBeNull();
			await fire(select, "onChange", { target: { value: "datacenter" } });
			expect(container.querySelector('input[aria-label="Email"]')).toBeNull();
		} finally {
			await unmount();
		}
	});

	test("a detected type sets the select", async () => {
		const { container, unmount } = await mount(
			<JiraConnectionsSection />,
			({ url }) =>
				url === "/api/jira/detect"
					? json(200, { type: "datacenter" })
					: json(200, []),
		);
		try {
			const site = q<HTMLInputElement>(
				container,
				'input[aria-label="Site URL"]',
			);
			await fire(site, "onChange", { target: { value: "https://jira.corp" } });
			await fire(site, "onBlur");
			expect(
				q<HTMLSelectElement>(container, 'select[aria-label="Type"]').value,
			).toBe("datacenter");
			expect(container.textContent).toContain("Detected: Data Center");
		} finally {
			await unmount();
		}
	});

	test("editing keeps the name fixed and an empty token field sends no token", async () => {
		const { container, calls, unmount } = await mount(
			<JiraConnectionsSection />,
			({ method }) =>
				method === "POST" ? json(200, conn({})) : json(200, [conn({})]),
		);
		try {
			await fire(q(container, 'button[aria-label="Edit work"]'), "onClick");
			const name = q<HTMLInputElement>(container, 'input[aria-label="Name"]');
			expect(name.readOnly).toBe(true);
			expect(container.textContent).toContain(
				"Token is set. Leave empty to keep it.",
			);
			await fire(
				q(container, 'input[aria-label="Custom field IDs"]'),
				"onChange",
				{
					target: { value: " customfield_1, ,customfield_2 " },
				},
			);
			await submit(q(container, "form.settings-form"));
			expect(calls.find((c) => c.method === "POST")).toEqual({
				method: "POST",
				url: LIST,
				body: {
					name: "work",
					site: "https://acme.atlassian.net",
					type: "cloud",
					email: "me@acme.test",
					customFields: ["customfield_1", "customfield_2"],
				},
			});
			expect(q(container, 'p.hint[role="status"]').textContent).toBe(
				"Saved work",
			);
		} finally {
			await unmount();
		}
	});

	test("Test shows the signed-in name", async () => {
		const { container, unmount } = await mount(
			<JiraConnectionsSection />,
			({ url }) =>
				url.endsWith("/test")
					? json(200, { displayName: "Jane Doe" })
					: json(200, [conn({})]),
		);
		try {
			await fire(q(container, 'button[aria-label="Test work"]'), "onClick");
			expect(q(container, 'p.hint[role="status"]').textContent).toBe(
				"work: signed in as Jane Doe",
			);
		} finally {
			await unmount();
		}
	});

	test("a refused delete names the projects that use the connection", async () => {
		const { container, unmount } = await mount(
			<JiraConnectionsSection />,
			({ method }) =>
				method === "DELETE"
					? json(409, {
							error: "in use by: proj, web",
							projects: ["proj", "web"],
						})
					: json(200, [conn({ usedBy: ["proj", "web"] })]),
		);
		try {
			await fire(q(container, 'button[aria-label="Delete work"]'), "onClick");
			const ok = [...window.document.querySelectorAll("button")].find(
				(b) => b.textContent === "Delete connection",
			);
			if (ok === undefined) throw new Error("confirm dialog missing");
			await act(async () => {
				ok.click();
			});
			await settle();
			const alert = q(container, 'p[role="alert"]');
			expect(alert.textContent).toContain("proj, web");
			expect(alert.textContent).toContain("Pick another Jira connection");
			await act(async () => {
				await Bun.sleep(50);
			});
		} finally {
			await unmount();
		}
	});
});

const CONNS = "/api/jira/connections";
const BSEARCH = "/api/jira/search";
const BIMPORT = "/api/jira/import";

const boardRow = (
	key: string,
	importedIn: { project: string; task: string }[] = [],
): JiraBoardRow => ({
	key,
	url: `https://acme.atlassian.net/browse/${key}`,
	summary: `Summary of ${key}`,
	issueType: "Story",
	status: "To Do",
	priority: "Medium",
	importedIn,
});

const boardDialog = (route: Route) =>
	mount(
		<JiraBoardImportDialog
			projects={[{ name: "p1" }, { name: "p2" }] as unknown as ProjectView[]}
			onClose={() => {}}
			navigate={() => {}}
		/>,
		route,
	);

const boardSearch = (root: Element): HTMLTextAreaElement => {
	const area = q<HTMLTextAreaElement>(root, "form.jira-search textarea");
	return area;
};

const rowSelects = (root: Element): HTMLSelectElement[] =>
	[...root.querySelectorAll("li.jira-row select")] as HTMLSelectElement[];

const boardImportButton = importButton;

describe("JiraBoardImportButton", () => {
	test("renders the entry and opens on click", async () => {
		let opened = 0;
		const { container, unmount } = await mount(
			<JiraBoardImportButton onOpen={() => (opened += 1)} />,
			() => json(200, {}),
		);
		try {
			const b = [...container.querySelectorAll("button")].find(
				(x) => x.textContent === "Import from Jira",
			);
			if (b === undefined) throw new Error("button missing");
			expect(b.getAttribute("title")).toContain("whole board");
			await fire(b, "onClick");
			expect(opened).toBe(1);
		} finally {
			await unmount();
		}
	});
});

describe("JiraBoardImportDialog", () => {
	test("with no connections it points at Settings", async () => {
		const { container, calls, unmount } = await boardDialog(
			({ url, method }) =>
				url.endsWith(CONNS) && method === "GET"
					? json(200, [])
					: json(500, { error: "unexpected" }),
		);
		try {
			expect(calls.map((c) => c.url)).toEqual([CONNS]);
			expect(container.textContent).toContain("No Jira connection yet.");
			const link = q<HTMLAnchorElement>(container, "a");
			expect(link.getAttribute("href")).toBe("/settings");
			expect(link.textContent).toContain("Open Settings to add one");
		} finally {
			await unmount();
		}
	});

	test("searches the chosen connection and renders rows with picks at 0", async () => {
		const { container, calls, unmount } = await boardDialog(
			({ url, method }) =>
				url.endsWith(CONNS) && method === "GET"
					? json(200, [
							{
								name: "work",
								site: "https://acme.atlassian.net",
								type: "cloud",
								email: "me@acme.test",
								customFields: [],
								tokenSet: true,
								tokenReadable: true,
								usedBy: [],
							},
						])
					: json(200, {
							rows: [
								boardRow("BRD-1"),
								boardRow("BRD-2", [{ project: "p1", task: "t1" }]),
							],
							next: null,
							total: 2,
						}),
		);
		try {
			expect(calls.map((c) => c.url)).toEqual([CONNS]);
			const conn = q<HTMLSelectElement>(container, "form.jira-search select");
			expect(conn.value).toBe("work");
			const area = boardSearch(container);
			expect(area.value).toBe("");
			expect(area.getAttribute("placeholder")).toContain("project = PROJ");
			await fire(area, "onChange", { target: { value: "order by key" } });
			await submit(q(container, "form.jira-search"));
			expect(calls[1]).toEqual({
				method: "POST",
				url: BSEARCH,
				body: { connection: "work", jql: "order by key", cursor: null },
			});
			expect(container.querySelectorAll("li.jira-row")).toHaveLength(2);
			// Every row starts unpicked.
			for (const sel of rowSelects(container)) expect(sel.value).toBe("");
			const sel0 = rowSelects(container)[0];
			if (sel0 === undefined) throw new Error("row select missing");
			expect(sel0.getAttribute("aria-label")).toBe("BRD-1: choose project");
			// The already-imported row names the project and links to its card.
			const li = rowSelects(container)[1]?.closest("li");
			expect(li?.textContent).toContain("already in");
			expect(
				li?.querySelector('a[href="/projects/p1/tasks/t1"]'),
			).not.toBeNull();
			expect(loadMore(container)).toBeUndefined();
			expect(boardImportButton(container).disabled).toBe(true);
			expect(boardImportButton(container).textContent).toBe("Import 0");
		} finally {
			await unmount();
		}
	});

	test("a project pick arms the import and files into that project", async () => {
		const { container, calls, unmount } = await boardDialog(
			({ url, method, body }) => {
				if (url.endsWith(CONNS) && method === "GET")
					return json(200, [
						{
							name: "work",
							site: "https://acme.atlassian.net",
							type: "cloud",
							email: "me@acme.test",
							customFields: [],
							tokenSet: true,
							tokenReadable: true,
							usedBy: [],
						},
					]);
				if (url.endsWith(BIMPORT))
					return json(200, {
						filed: [{ project: "p2", key: "BRD-1", task: "t9" }],
						skipped: [],
						unavailable: [],
					});
				const cursor =
					typeof body === "object" && body !== null && "cursor" in body
						? body.cursor
						: null;
				return cursor === null
					? json(200, { rows: [boardRow("BRD-1")], next: null, total: 1 })
					: json(200, { rows: [], next: null, total: 1 });
			},
		);
		try {
			const area = boardSearch(container);
			await fire(area, "onChange", { target: { value: "order by key" } });
			await submit(q(container, "form.jira-search"));
			const sel0 = rowSelects(container)[0];
			if (sel0 === undefined) throw new Error("row select missing");
			await fire(sel0, "onChange", {
				target: { value: "p2" },
			});
			expect(boardImportButton(container).textContent).toBe("Import 1");
			await fire(boardImportButton(container), "onClick");
			const imp = calls.find((c) => c.url === BIMPORT);
			if (imp === undefined) throw new Error("import call missing");
			expect(imp.body).toEqual({
				connection: "work",
				stage: "backlog",
				assignments: [{ key: "BRD-1", project: "p2" }],
			});
			expect(status(container)).toBe("Filed 1 card");
			// The refresh re-ran the search so importedIn updates.
			expect(calls.filter((c) => c.url === BSEARCH)).toHaveLength(2);
			expect(boardImportButton(container).disabled).toBe(true);
		} finally {
			await unmount();
		}
	});

	test("switching the connection drops the loaded rows and their cursor", async () => {
		const { container, calls, unmount } = await boardDialog(
			({ url, method, body }) => {
				if (url.endsWith(CONNS) && method === "GET")
					return json(200, [
						{
							name: "work",
							site: "https://acme.atlassian.net",
							type: "cloud",
							email: "me@acme.test",
							customFields: [],
							tokenSet: true,
							tokenReadable: true,
							usedBy: [],
						},
						{
							name: "other",
							site: "https://jira.corp.test",
							type: "datacenter",
							email: null,
							customFields: [],
							tokenSet: true,
							tokenReadable: true,
							usedBy: [],
						},
					]);
				const cursor =
					typeof body === "object" && body !== null && "cursor" in body
						? body.cursor
						: null;
				const conn =
					typeof body === "object" && body !== null && "connection" in body
						? String(body.connection)
						: "";
				return cursor === null
					? json(200, {
							rows: [boardRow(conn === "work" ? "BRD-1" : "BRD-9")],
							next: "page-2",
							total: 2,
						})
					: json(200, { rows: [], next: null, total: 2 });
			},
		);
		try {
			const area = boardSearch(container);
			await fire(area, "onChange", { target: { value: "order by key" } });
			await submit(q(container, "form.jira-search"));
			expect(container.querySelectorAll("li.jira-row")).toHaveLength(1);
			expect(loadMore(container)).toBeDefined();
			// A switch starts over: the old rows and their cursor belong to the old
			// site, so Load more can never send them to the other connection.
			const conn = q<HTMLSelectElement>(container, "form.jira-search select");
			await fire(conn, "onChange", { target: { value: "other" } });
			expect(container.querySelectorAll("li.jira-row")).toHaveLength(0);
			expect(loadMore(container)).toBeUndefined();
			expect(boardImportButton(container).disabled).toBe(true);
			// The next search goes to the new connection with no stale cursor.
			await fire(area, "onChange", { target: { value: "order by key" } });
			await submit(q(container, "form.jira-search"));
			expect(calls[1]?.body).toEqual({
				connection: "work",
				jql: "order by key",
				cursor: null,
			});
			expect(calls[2]?.body).toEqual({
				connection: "other",
				jql: "order by key",
				cursor: null,
			});
			expect(container.querySelectorAll("li.jira-row")).toHaveLength(1);
		} finally {
			await unmount();
		}
	});

	test("skip keeps the row out of the assignments", async () => {
		const { container, calls, unmount } = await boardDialog(
			({ url, method, body }) => {
				if (url.endsWith(CONNS) && method === "GET")
					return json(200, [
						{
							name: "work",
							site: "https://acme.atlassian.net",
							type: "cloud",
							email: "me@acme.test",
							customFields: [],
							tokenSet: true,
							tokenReadable: true,
							usedBy: [],
						},
					]);
				if (url.endsWith(BIMPORT))
					return json(200, {
						filed: [{ project: "p2", key: "BRD-1", task: "t9" }],
						skipped: [],
						unavailable: [],
					});
				const cursor =
					typeof body === "object" && body !== null && "cursor" in body
						? body.cursor
						: null;
				return cursor === null
					? json(200, {
							rows: [boardRow("BRD-1"), boardRow("BRD-2")],
							next: null,
							total: 2,
						})
					: json(200, { rows: [], next: null, total: 2 });
			},
		);
		try {
			const area = boardSearch(container);
			await fire(area, "onChange", { target: { value: "order by key" } });
			await submit(q(container, "form.jira-search"));
			const sel0 = rowSelects(container)[0];
			if (sel0 === undefined) throw new Error("row select missing");
			await fire(sel0, "onChange", {
				target: { value: "p2" },
			});
			const sel1 = rowSelects(container)[1];
			if (sel1 === undefined) throw new Error("row select missing");
			await fire(sel1, "onChange", {
				target: { value: "/" },
			});
			expect(boardImportButton(container).textContent).toBe("Import 1");
			await fire(boardImportButton(container), "onClick");
			const imp = calls.find((c) => c.url === BIMPORT);
			if (imp === undefined) throw new Error("import call missing");
			expect((imp.body as { assignments: unknown[] }).assignments).toEqual([
				{ key: "BRD-1", project: "p2" },
			]);
		} finally {
			await unmount();
		}
	});
});
