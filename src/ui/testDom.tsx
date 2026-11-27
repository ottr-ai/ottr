// Shared happy-dom + React test helpers for the UI test files.
//
// happy-dom's dispatched events never reach React's event plugin, so tests
// call the production event props React rendered onto a node instead
// (onClickOf / onChangeOf). The browser-globals install mirrors what each
// describe block used to do inline: happy-dom registers the globals for the
// describe, and afterAll puts the originals back, so later test files in the
// same process see no DOM.
import { afterAll, beforeAll } from "bun:test";
import { type Node as HappyNode, Window as HappyWindow } from "happy-dom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

export type Post = { url: string; body: unknown };

type Host = Record<string, unknown>;

/**
 * Create a Window and install its browser globals on `globalThis` for the
 * enclosing suite (describe or file). `keys` names happy-dom members to
 * install (each resolved from the window, unknown name throws). `extra`
 * installs values as given and wins over `keys`. Registers beforeAll and
 * afterAll; call it synchronously where the globals block used to sit.
 */
export const installBrowserGlobals = (
	keys: string[] = [],
	extra: Record<string, unknown> = {},
): { window: HappyWindow } => {
	const window = new HappyWindow({ url: "http://localhost/" });
	const host = globalThis as unknown as Host;
	const globals: Record<string, unknown> = {
		window,
		document: window.document,
		navigator: window.navigator,
	};
	for (const key of keys) {
		const value = (window as unknown as Record<string, unknown>)[key];
		if (value === undefined) throw new Error(`happy-dom has no ${key}`);
		globals[key] = value;
	}
	Object.assign(globals, extra);
	const originals = new Map<string, unknown>();
	beforeAll(() => {
		host.IS_REACT_ACT_ENVIRONMENT = true;
		for (const [key, value] of Object.entries(globals)) {
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
	return { window };
};

const reactPropOf = (node: Element, name: string): ((e?: unknown) => void) => {
	const key = Object.getOwnPropertyNames(node).find((k) =>
		k.startsWith("__reactProps$"),
	);
	if (key === undefined) throw new Error("react props missing on node");
	const props = (node as unknown as Record<string, unknown>)[key] as Record<
		string,
		((e?: unknown) => void) | undefined
	>;
	const prop = props[name];
	if (prop === undefined) throw new Error(`node has no ${name}`);
	return prop;
};

export const onClickOf = (node: Element): ((e?: unknown) => void) =>
	reactPropOf(node, "onClick");

export const onChangeOf = (node: Element): ((e?: unknown) => void) =>
	reactPropOf(node, "onChange");

export const onSubmitOf = (node: Element): ((e?: unknown) => void) =>
	reactPropOf(node, "onSubmit");

export const onKeyDownOf = (node: Element): ((e?: unknown) => void) =>
	reactPropOf(node, "onKeyDown");

export interface Mounted {
	container: HTMLDivElement;
	root: Root;
	unmount: () => Promise<void>;
}

/** Render `element` into a fresh container under the installed globals. */
export const mount = async (element: ReactElement): Promise<Mounted> => {
	const document = globalThis.document as unknown as HappyWindow["document"];
	const container = document.createElement("div") as unknown as HTMLDivElement;
	document.body.appendChild(container as unknown as HappyNode);
	const root = createRoot(container);
	await act(async () => {
		root.render(element);
	});
	return {
		container,
		root,
		unmount: async () => {
			await act(async () => {
				root.unmount();
			});
			container.remove();
		},
	};
};

/**
 * Replace `globalThis.fetch` with `handler` and return the restore function.
 * The handler receives the URL as a string; route matching, POST capture and
 * fallback responses stay at the call site.
 */
export const stubFetch = (
	handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { restore: () => void } => {
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) =>
		handler(String(url), init)) as unknown as typeof fetch;
	return {
		restore: () => {
			globalThis.fetch = realFetch;
		},
	};
};
