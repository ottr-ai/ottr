import { expect, test } from "bun:test";
import { SETTINGS_HASH, settingsSub } from "./route.ts";

// Regression (R6-3): a project name containing "%" must survive the hash round-trip.
// settingsSub receives readHash()'s already-decoded text; a second decode threw a
// URLError during render and blanked the board.
test("settings route decodes the project name exactly once", () => {
	const view = decodeURIComponent(`#${SETTINGS_HASH}/50%25off`.slice(1)); // readHash()'s output
	expect(settingsSub(view)).toEqual({ onSettings: true, project: "50%off" });
	const escaped = decodeURIComponent(`#${SETTINGS_HASH}/a%252Fb`.slice(1));
	expect(settingsSub(escaped)).toEqual({
		onSettings: true,
		project: "a%2Fb",
	});
});

test("settingsSub routes General and non-settings hashes", () => {
	expect(settingsSub("settings")).toEqual({ onSettings: true, project: null });
	expect(settingsSub("50%off")).toEqual({ onSettings: false, project: null });
	expect(settingsSub("")).toEqual({ onSettings: false, project: null });
});
