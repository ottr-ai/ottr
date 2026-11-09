import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { type Node as HappyNode, Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
	clampPan,
	interviewMsg,
	LiveElapsed,
	Skeleton,
	ZoomableImage,
	zoomAt,
} from "./kit.tsx";

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

const contentPoint = (
	z: { scale: number; x: number; y: number },
	rect: { left: number; top: number },
	clientX: number,
	clientY: number,
): { x: number; y: number } => ({
	x: (clientX - rect.left - z.x) / z.scale,
	y: (clientY - rect.top - z.y) / z.scale,
});

describe("zoomAt", () => {
	test("keeps the anchored content point fixed", () => {
		const z = { scale: 2, x: -40, y: -60 };
		const rect = { left: 100, top: 50 };
		const before = contentPoint(z, rect, 300, 200);
		const after = zoomAt(z, rect, 300, 200, 3);
		expect(contentPoint(after, rect, 300, 200)).toEqual(before);
		expect(after.scale).toBe(3);
	});

	test("clamps nextScale into [1, 8]", () => {
		const z = { scale: 1, x: 0, y: 0 };
		const rect = { left: 0, top: 0 };
		expect(zoomAt(z, rect, 0, 0, 0.5).scale).toBe(1);
		expect(zoomAt(z, rect, 0, 0, 99).scale).toBe(8);
	});

	test("property: anchored point is invariant and scale stays in [1, 8]", () => {
		const stateArb = fc.record({
			scale: fc.float({ min: 1, max: 8, noNaN: true }),
			x: fc.float({ min: -2000, max: 0, noNaN: true }),
			y: fc.float({ min: -2000, max: 0, noNaN: true }),
		});
		const rectArb = fc.record({
			left: fc.float({ min: -500, max: 500, noNaN: true }),
			top: fc.float({ min: -500, max: 500, noNaN: true }),
		});
		const pointArb = fc.record({
			clientX: fc.float({ min: -1000, max: 2000, noNaN: true }),
			clientY: fc.float({ min: -1000, max: 2000, noNaN: true }),
		});
		const props = fc.property(
			stateArb,
			rectArb,
			pointArb,
			fc.double({ min: 1, max: 8, noNaN: true }),
			(z, rect, p, nextScale) => {
				const before = contentPoint(z, rect, p.clientX, p.clientY);
				const after = zoomAt(z, rect, p.clientX, p.clientY, nextScale);
				const afterPoint = contentPoint(after, rect, p.clientX, p.clientY);
				expect(Math.abs(afterPoint.x - before.x)).toBeLessThan(1e-6);
				expect(Math.abs(afterPoint.y - before.y)).toBeLessThan(1e-6);
				expect(after.scale).toBeGreaterThanOrEqual(1);
				expect(after.scale).toBeLessThanOrEqual(8);
			},
		);
		fc.assert(props, { seed: 424242, numRuns: 200 });
	});
});

describe("clampPan", () => {
	test("clamps translate to keep the image covering its box", () => {
		const out = clampPan({ scale: 3, x: -1500, y: 500 }, 500, 400);
		expect(out.scale).toBe(3);
		expect(out.x).toBe(-1000);
		expect(out.y).toBe(0);
		expect(out.x).toBeGreaterThanOrEqual(-1000);
		expect(out.x).toBeLessThanOrEqual(0);
		expect(out.y).toBeGreaterThanOrEqual(-800);
		expect(out.y).toBeLessThanOrEqual(0);
	});

	test("snaps to identity at scale 1 and below", () => {
		expect(clampPan({ scale: 1, x: -30, y: -5 }, 500, 400)).toEqual({
			scale: 1,
			x: 0,
			y: 0,
		});
		expect(clampPan({ scale: 0.5, x: 20, y: 20 }, 500, 400)).toEqual({
			scale: 1,
			x: 0,
			y: 0,
		});
	});
});

describe("ZoomableImage", () => {
	function render(src = "/img.png"): {
		container: HTMLElement;
		root: Root;
	} {
		// happy-dom's DOM classes do not structurally match lib.dom's; the test
		// speaks lib types, so the boundary converts once here.
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.append(container as unknown as HappyNode);
		const root = createRoot(container);
		act(() => {
			root.render(<ZoomableImage src={src} alt="Attachment, full size" />);
		});
		return { container, root };
	}

	test("renders the image and the zoom buttons", () => {
		const { container, root } = render();
		const img = container.querySelector("img");
		expect(img?.getAttribute("alt")).toBe("Attachment, full size");
		expect(img?.getAttribute("src")).toBe("/img.png");
		const buttons = [...container.querySelectorAll("button")];
		expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
			"Zoom in",
			"Zoom out",
		]);
		act(() => root.unmount());
		container.remove();
	});

	test("wheel up zooms in", () => {
		const { container, root } = render();
		const wrap = container.querySelector(".zoomable") as HTMLElement;
		const img = container.querySelector("img") as HTMLElement;
		// happy-dom's WheelEvent and preventDefault are limited; a plain Event
		// with wheel fields assigned still drives the listener under test.
		const e = new window.Event("wheel", {
			bubbles: true,
		}) as unknown as Event;
		Object.assign(e, { deltaY: -240, clientX: 0, clientY: 0, deltaMode: 0 });
		act(() => {
			wrap.dispatchEvent(e);
		});
		const match = /scale\(([\d.]+)\)/.exec(img.style.transform);
		expect(match).not.toBeNull();
		expect(Number(match?.[1] ?? 0)).toBeGreaterThan(1);
		act(() => root.unmount());
		container.remove();
	});

	test("zoom in raises scale, zoom out returns to identity", () => {
		const { container, root } = render();
		const img = container.querySelector("img") as HTMLElement;
		const [zoomIn, zoomOut] = [...container.querySelectorAll("button")];
		if (zoomIn === undefined || zoomOut === undefined)
			throw new Error("zoom buttons missing");
		act(() => {
			zoomIn.dispatchEvent(
				new window.Event("click", { bubbles: true }) as unknown as Event,
			);
		});
		expect(/scale\(([\d.]+)\)/.exec(img.style.transform)?.[1]).not.toBe("1");
		act(() => {
			zoomOut.dispatchEvent(
				new window.Event("click", { bubbles: true }) as unknown as Event,
			);
		});
		expect(img.style.transform).toBe("translate(0px, 0px) scale(1)");
		act(() => root.unmount());
		container.remove();
	});

	test("a new src resets the transform", () => {
		// happy-dom's DOM classes do not structurally match lib.dom's; the test
		// speaks lib types, so the boundary converts once here.
		const container = window.document.createElement(
			"div",
		) as unknown as HTMLDivElement;
		window.document.body.append(container as unknown as HappyNode);
		const root = createRoot(container);
		act(() => {
			root.render(<ZoomableImage src="/a.png" alt="Attachment, full size" />);
		});
		const img = container.querySelector("img") as HTMLElement;
		const [zoomIn] = [...container.querySelectorAll("button")];
		if (zoomIn === undefined) throw new Error("zoom button missing");
		act(() => {
			zoomIn.dispatchEvent(
				new window.Event("click", { bubbles: true }) as unknown as Event,
			);
		});
		expect(img.style.transform).not.toBe("translate(0px, 0px) scale(1)");
		act(() => {
			root.render(<ZoomableImage src="/b.png" alt="Attachment, full size" />);
		});
		expect(img.style.transform).toBe("translate(0px, 0px) scale(1)");
		act(() => root.unmount());
		container.remove();
	});
});

test("Skeleton renders a labelled status region in the asked shape", () => {
	const html = renderToStaticMarkup(
		<Skeleton rows={2} shape="list" label="Loading the model list" />,
	);
	expect(html).toContain('role="status"');
	expect(html).toContain('aria-label="Loading the model list"');
	expect(html).toContain('data-shape="list"');
	// Two list rows: two bones, no label/field pairs.
	expect(html.match(/skeleton-bone/g)).toHaveLength(2);
	const pairs = renderToStaticMarkup(
		<Skeleton rows={2} shape="rows" label="Loading the model roles" />,
	);
	// Each definition row is a label stub plus a field stub.
	expect(pairs.match(/skeleton-bone/g)).toHaveLength(4);
});

test("LiveElapsed ticks the elapsed duration, then the status words and the estimate", () => {
	const now = Date.now();
	// 65s in: one unit, floored. The static render needs no timer.
	expect(renderToStaticMarkup(<LiveElapsed since={now - 65_000} />)).toContain(
		"1m",
	);
	// The status words and the median estimate ride the same line, mutation-run style.
	expect(
		renderToStaticMarkup(
			<LiveElapsed
				since={now - 65_000}
				status="running"
				etaMs={65_000 + 4 * 60_000 + 30_000}
			/>,
		),
	).toContain("1m · running · about 4m left");
	// No etaMs (thin history): elapsed and status only.
	expect(
		renderToStaticMarkup(<LiveElapsed since={now - 65_000} status="running" />),
	).toContain("1m · running");
	// A spent median renders no estimate, and an empty status no separator.
	expect(
		renderToStaticMarkup(
			<LiveElapsed since={now - 65_000} status="" etaMs={60_000} />,
		),
	).toContain("1m");
	expect(
		renderToStaticMarkup(
			<LiveElapsed since={now - 65_000} status="" etaMs={60_000} />,
		),
	).not.toContain("·");
});

describe("interviewMsg", () => {
	test("each route verdict maps to its notice; unknown text passes through", () => {
		expect(interviewMsg("queued")).toBe(
			"Rules interview queued as a card - it starts shortly and asks its questions on the card.",
		);
		expect(interviewMsg("running")).toBe(
			"A rules task is already live - it asks its questions on the card.",
		);
		expect(interviewMsg("not-needed")).toBe(
			"AGENTS.md found - no interview needed.",
		);
		expect(interviewMsg("gitless")).toBe(
			"Init a git repository first - actions wait until then.",
		);
		expect(interviewMsg("standalone")).toBe("standalone");
	});
});
