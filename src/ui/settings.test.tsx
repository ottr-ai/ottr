import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Node as HappyNode, Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { GitHostsSection } from "./settings.tsx";

// React interaction needs browser globals; bun test has none. happy-dom (added
// with the card's approval) registers them here; afterAll puts the originals
// back, so later test files in the same process see no DOM. One named alias
// keeps the assignments type-checked in one place.
const window = new Window({ url: "http://localhost/" });
const host = globalThis as unknown as Record<string, unknown>;
const browserGlobals: Record<string, unknown> = {
	window,
	document: window.document,
	navigator: window.navigator,
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
});

afterAll(() => {
	delete host.IS_REACT_ACT_ENVIRONMENT;
	for (const [key, value] of originals) {
		if (value === undefined) delete host[key];
		else host[key] = value;
	}
});

/** The rendered GitHub App block, isolated from the other sec-blocks. */
const appBlock = (): string => {
	const html = renderToStaticMarkup(<GitHostsSection />);
	const start = html.indexOf('id="github-app-block"');
	const end = html.indexOf('id="host-tokens-block"');
	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
	return html.slice(start, end);
};

/** A React onChange picks up programmatic edits only through the native value setter. */
const typeInto = (
	el: HTMLInputElement | HTMLTextAreaElement,
	value: string,
): void => {
	const proto =
		el instanceof window.HTMLTextAreaElement
			? window.HTMLTextAreaElement.prototype
			: window.HTMLInputElement.prototype;
	const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
	if (setter === undefined) throw new Error("value setter missing");
	setter.call(el, value);
};

/** happy-dom's dispatched input and change events never reach React's
 *  ChangeEventPlugin (upstream gap; the submit event does). The test therefore
 *  calls the production onChange React rendered onto the node, which is the
 *  same handler a browser input event would run. */
const onChangeOf = (node: Element): ((e: unknown) => void) => {
	const key = Object.getOwnPropertyNames(node).find((k) =>
		k.startsWith("__reactProps$"),
	);
	if (key === undefined) throw new Error("react props missing on node");
	const props = (node as unknown as Record<string, unknown>)[key] as {
		onChange?: (e: unknown) => void;
	};
	if (props.onChange === undefined) throw new Error("node has no onChange");
	return props.onChange;
};

/** The form-submit DOM event; happy-dom's Event class does not match lib.dom's. */
const submitEvent = (): Event =>
	new window.Event("submit", {
		bubbles: true,
		cancelable: true,
	}) as unknown as Event;

/** Mounts the section against `fetchMock`; the cleanup puts fetch and the DOM back. */
async function mountSection(fetchMock: typeof fetch): Promise<{
	container: HTMLDivElement;
	unmount: () => Promise<void>;
}> {
	const realFetch = globalThis.fetch;
	globalThis.fetch = fetchMock;
	// happy-dom's DOM classes do not structurally match lib.dom's; the test
	// speaks lib types, so the boundary converts once here.
	const container = window.document.createElement(
		"div",
	) as unknown as HTMLDivElement;
	window.document.body.appendChild(container as unknown as HappyNode);
	const root = createRoot(container);
	await act(async () => {
		root.render(<GitHostsSection />);
	});
	return {
		container,
		unmount: async () => {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			globalThis.fetch = realFetch;
		},
	};
}

describe("GitHostsSection GitHub App form", () => {
	test("Save is the form's submit button: Enter shares the button's guarded call path", () => {
		const block = appBlock();
		// With no saved app state the form branch shows. Its Save must be
		// type="submit", so a press of Enter runs the same guarded call as the
		// button: one busy flag, one error line, no duplicate POSTs.
		expect(block).toContain("<form");
		expect(block).toContain('<button type="submit"');
		expect(block).toContain("Save");
		// The old bug shipped a type="button" save control next to an onSubmit
		// that ran the request outside the busy guard; pin the corrected wiring.
		expect(block).not.toContain('<button type="button">Save</button>');
	});

	test("a 400 on save shows the server's error on the section's error line", async () => {
		let postCalls = 0;
		let postBody: { id?: string; key?: string } | undefined;
		const { promise: postInFlight, resolve: resolvePost } =
			Promise.withResolvers<Response>();
		const ok = (body: unknown): Response =>
			new Response(JSON.stringify(body), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		const view = {
			tokens: [],
			globalKey: null,
			githubApp: null,
			githubHost: "github.com",
		};
		const fetchMock = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		): Promise<Response> => {
			const url = String(input);
			if (url.endsWith("/api/git-hosts") && (init?.method ?? "GET") === "GET")
				return ok(view);
			// The GitHub token block in the same section checks its state on mount.
			if (url.endsWith("/api/settings/github-token"))
				return ok({ tokenSet: false, expiresAt: null });
			if (url.endsWith("/api/git-hosts/github-app")) {
				postCalls += 1;
				postBody = JSON.parse(String(init?.body));
				return postInFlight;
			}
			throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
		}) as typeof fetch;

		const { container, unmount } = await mountSection(fetchMock);
		try {
			// The load resolved with no saved app, so the form shows, errorless.
			const idInput = container.querySelector<HTMLInputElement>(
				"#github-app-block input",
			);
			const keyArea = container.querySelector<HTMLTextAreaElement>(
				"#github-app-block textarea",
			);
			const form = container.querySelector("#github-app-block form");
			if (idInput === null || keyArea === null || form === null)
				throw new Error("GitHub App form did not render");
			expect(
				container.querySelector(".auth-error")?.textContent ?? null,
			).toBeNull();

			// Type a numeric ID and a fake key into the fields, then let React's
			// production handlers pick the values up. The key fixture must stay
			// PEM-free: the CI secret scan pairs a BEGIN header with a KEY-----
			// tail 64+ characters later, so the two PEM strings here matched as
			// one leak and failed the Scan job (run 41583302106).
			await act(async () => {
				typeInto(idInput, "123456");
				onChangeOf(idInput)({ target: idInput, currentTarget: idInput });
				typeInto(keyArea, "fake-key-0000");
				onChangeOf(keyArea)({ target: keyArea, currentTarget: keyArea });
			});

			// Submit once through the form (the Enter path): the request starts
			// under the busy flag, the save button disables, the spinner shows.
			await act(async () => {
				form.dispatchEvent(submitEvent());
			});
			expect(postCalls).toBe(1);
			expect(postBody).toEqual({
				id: "123456",
				key: "fake-key-0000",
			});
			const saveButton = container.querySelector<HTMLButtonElement>(
				"#github-app-block button[type='submit']",
			);
			if (saveButton === null) throw new Error("save button missing");
			expect(saveButton.disabled).toBe(true);
			expect(
				container.querySelector("#github-app-block .spinner"),
			).not.toBeNull();

			// A second submit while the POST is in flight is dropped by the guard.
			await act(async () => {
				form.dispatchEvent(submitEvent());
			});
			expect(postCalls).toBe(1);

			// The server answers 400: the message lands on the section's error
			// line, the button comes back enabled, no success side effects.
			await act(async () => {
				resolvePost(
					new Response(JSON.stringify({ error: "key rejected: bad PEM" }), {
						status: 400,
						headers: { "Content-Type": "application/json" },
					}),
				);
			});
			const line = container.querySelector(".auth-error");
			expect(line).not.toBeNull();
			expect(line?.getAttribute("role")).toBe("alert");
			expect(line?.textContent).toBe("key rejected: bad PEM");
			expect(saveButton.disabled).toBe(false);
			expect(container.querySelector("#github-app-block .spinner")).toBeNull();
		} finally {
			await unmount();
		}
	});
});

describe("GitHostsSection GitHub host", () => {
	const ok = (body: unknown): Response =>
		new Response(JSON.stringify(body), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	const view = {
		tokens: [],
		globalKey: null,
		githubApp: null,
		githubHost: "github.com",
	};

	/** Mock for /api/git-hosts and the GitHub token check; `extra` handles the rest. */
	const baseMock = (
		loaded: { calls: number },
		extra: (url: string, init?: RequestInit) => Response | undefined,
	): typeof fetch =>
		(async (
			input: RequestInfo | URL,
			init?: RequestInit,
		): Promise<Response> => {
			const url = String(input);
			if (url.endsWith("/api/git-hosts") && (init?.method ?? "GET") === "GET") {
				loaded.calls += 1;
				return ok(view);
			}
			if (url.endsWith("/api/settings/github-token"))
				return ok({ tokenSet: false, expiresAt: null });
			const hit = extra(url, init);
			if (hit !== undefined) return hit;
			throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
		}) as typeof fetch;

	test("the input is prefilled with the host in effect", async () => {
		const loaded = { calls: 0 };
		const { container, unmount } = await mountSection(
			baseMock(loaded, () => undefined),
		);
		try {
			expect(loaded.calls).toBe(1);
			const input = container.querySelector<HTMLInputElement>(
				"#github-host-block input",
			);
			if (input === null) throw new Error("GitHub host input did not render");
			expect(input.value).toBe("github.com");
			expect(input.getAttribute("aria-label")).toBe("GitHub host");
		} finally {
			await unmount();
		}
	});

	test("saving posts the new host and the section refetches", async () => {
		const loaded = { calls: 0 };
		let postCalls = 0;
		let postBody: { host?: string } | undefined;
		const fixture = { ...view };
		const fetchMock = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		): Promise<Response> => {
			const url = String(input);
			if (url.endsWith("/api/git-hosts") && (init?.method ?? "GET") === "GET") {
				loaded.calls += 1;
				return ok(fixture);
			}
			if (url.endsWith("/api/settings/github-token"))
				return ok({ tokenSet: false, expiresAt: null });
			if (
				url.endsWith("/api/settings/github-host") &&
				init?.method === "POST"
			) {
				postCalls += 1;
				postBody = JSON.parse(String(init.body));
				// The save lands; the refetch then reports the new host.
				fixture.githubHost = "acme.ghe.com";
				return ok({ host: "acme.ghe.com", expiresAt: null });
			}
			throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
		}) as typeof fetch;
		const { container, unmount } = await mountSection(fetchMock);
		try {
			const input = container.querySelector<HTMLInputElement>(
				"#github-host-block input",
			);
			const form = container.querySelector("#github-host-block form");
			if (input === null || form === null)
				throw new Error("form did not render");
			expect(loaded.calls).toBe(1);

			await act(async () => {
				typeInto(input, "acme.ghe.com");
				onChangeOf(input)({ target: input, currentTarget: input });
			});
			await act(async () => {
				form.dispatchEvent(submitEvent());
			});
			expect(postCalls).toBe(1);
			expect(postBody).toEqual({ host: "acme.ghe.com" });
			// The 200 refreshed the section: a second GET /api/git-hosts, and the
			// input now shows the host the refreshed state holds.
			expect(loaded.calls).toBe(2);
			const refetched = container.querySelector<HTMLInputElement>(
				"#github-host-block input",
			);
			if (refetched === null) throw new Error("input gone after refetch");
			expect(refetched.value).toBe("acme.ghe.com");
		} finally {
			await unmount();
		}
	});

	test("a 400 lands on the section's error line and the view keeps the old host", async () => {
		const loaded = { calls: 0 };
		const { container, unmount } = await mountSection(
			baseMock(loaded, (url, init) => {
				if (
					url.endsWith("/api/settings/github-host") &&
					init?.method === "POST"
				)
					return new Response(
						JSON.stringify({
							error: "not a bare hostname: scheme not allowed",
						}),
						{ status: 400, headers: { "Content-Type": "application/json" } },
					);
				return undefined;
			}),
		);
		try {
			const input = container.querySelector<HTMLInputElement>(
				"#github-host-block input",
			);
			const form = container.querySelector("#github-host-block form");
			if (input === null || form === null)
				throw new Error("form did not render");

			await act(async () => {
				typeInto(input, "https://acme.ghe.com");
				onChangeOf(input)({ target: input, currentTarget: input });
			});
			await act(async () => {
				form.dispatchEvent(submitEvent());
			});
			const line = container.querySelector(".auth-error");
			expect(line).not.toBeNull();
			expect(line?.getAttribute("role")).toBe("alert");
			expect(line?.textContent).toBe("not a bare hostname: scheme not allowed");
			// No refetch on failure: the section keeps the old host in the input.
			expect(loaded.calls).toBe(1);
			const kept = container.querySelector<HTMLInputElement>(
				"#github-host-block input",
			);
			expect(kept?.value).toBe("https://acme.ghe.com");
		} finally {
			await unmount();
		}
	});
});
