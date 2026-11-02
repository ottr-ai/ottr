import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GitHostsSection } from "./settings.tsx";

/** The rendered GitHub App block, isolated from the other sec-blocks. */
const appBlock = (): string => {
	const html = renderToStaticMarkup(<GitHostsSection />);
	const start = html.indexOf('id="github-app-block"');
	const end = html.indexOf('id="host-tokens-block"');
	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
	return html.slice(start, end);
};

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
});
