import { afterEach, expect, test } from "bun:test";
import {
	historyTask,
	migrateHash,
	navClick,
	projectPath,
	readPath,
	SETTINGS_HASH,
	settingsPath,
	settingsSub,
	taskPath,
	viewPath,
} from "./route.ts";

// readPath()/migrateHash() read location and history; bun test has neither.
const g = globalThis as unknown as Record<string, unknown>;
const originals = {
	location: g.location,
	history: g.history,
};
let pathname = "/";
let replaced: string | null = null;
function install(path: string, hash = ""): void {
	pathname = path;
	replaced = null;
	g.location = { pathname, hash };
	g.history = {
		replaceState: (_s: unknown, _t: unknown, url: string) => {
			replaced = url;
		},
	};
}
afterEach(() => {
	g.location = originals.location;
	g.history = originals.history;
});

// Regression (R6-3): a project name containing "%" must survive the route round-trip.
// settingsSub receives already-decoded text (readPath()'s or migrateHash()'s output); a
// second decode threw a URLError during render and blanked the board.
test("settings route decodes the project name exactly once", () => {
	const view = decodeURIComponent(`#${SETTINGS_HASH}/50%25off`.slice(1)); // decode-once output
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

test("readPath reads all five path shapes", () => {
	install("/");
	expect(readPath()).toEqual({ view: "", task: null });
	install("/projects/p1");
	expect(readPath()).toEqual({ view: "p1", task: null });
	install("/projects/p1/tasks/X");
	expect(readPath()).toEqual({ view: "p1", task: "X" });
	install("/settings");
	expect(readPath()).toEqual({ view: SETTINGS_HASH, task: null });
	install("/settings/p1");
	expect(readPath()).toEqual({ view: `${SETTINGS_HASH}/p1`, task: null });
});

test("readPath decodes each segment exactly once", () => {
	install("/projects/50%25off");
	expect(readPath()).toEqual({ view: "50%off", task: null });
	install("/projects/50%25off/tasks/a%252Fb");
	expect(readPath()).toEqual({ view: "50%off", task: "a%2Fb" });
	install(`/${SETTINGS_HASH}/50%25off`);
	expect(readPath()).toEqual({
		view: `${SETTINGS_HASH}/50%off`,
		task: null,
	});
});

test("readPath falls back to the overview on unknown or malformed paths", () => {
	install("/projects");
	expect(readPath()).toEqual({ view: "", task: null });
	install("/projects/a/tasks");
	expect(readPath()).toEqual({ view: "", task: null });
	install(`/${SETTINGS_HASH}/a/b`);
	expect(readPath()).toEqual({ view: "", task: null });
	install("/elsewhere/50%zz");
	expect(readPath()).toEqual({ view: "", task: null });
});

test("path builders encode every segment exactly once", () => {
	expect(projectPath("50%off")).toBe("/projects/50%25off");
	expect(taskPath("50%off", "a/b")).toBe("/projects/50%25off/tasks/a%2Fb");
	expect(settingsPath(null)).toBe("/settings");
	expect(settingsPath("50%off")).toBe("/settings/50%25off");
	expect(viewPath("")).toBe("/");
	expect(viewPath("50%off")).toBe("/projects/50%25off");
	expect(viewPath(SETTINGS_HASH)).toBe("/settings");
	expect(viewPath(`${SETTINGS_HASH}/50%off`)).toBe("/settings/50%25off");
});

test("migrateHash rewrites the old hash URLs to paths", () => {
	install("/ignored", "#p1");
	migrateHash();
	expect(replaced).toBe("/projects/p1");
	install("/ignored", "#settings/a");
	migrateHash();
	expect(replaced).toBe("/settings/a");
	install("/ignored", "#settings");
	migrateHash();
	expect(replaced).toBe("/settings");
	install("/projects/p1", "");
	migrateHash();
	expect(replaced).toBeNull();
});

test("navClick leaves middle and modifier clicks to the browser", () => {
	let prevented = 0;
	let navigated: string | null = null;
	const base = {
		button: 0,
		preventDefault: () => {
			prevented++;
		},
		currentTarget: { pathname: "/projects/p1" },
	};
	navClick({ ...base, button: 1 }, (path) => {
		navigated = path;
	});
	expect(prevented).toBe(0);
	expect(navigated).toBeNull();
	navClick({ ...base, ctrlKey: true }, (path) => {
		navigated = path;
	});
	expect(prevented).toBe(0);
	expect(navigated).toBeNull();
});

test("navClick preventDefaults a plain click and navigates to the anchor's path", () => {
	let prevented = 0;
	let navigated: string | null = null;
	navClick(
		{
			button: 0,
			preventDefault: () => {
				prevented++;
			},
			currentTarget: { pathname: "/projects/p1/tasks/X" },
		},
		(path) => {
			navigated = path;
		},
	);
	expect(prevented).toBe(1);
	// The closure assigns navigated, but TS keeps the initializer's null narrowing here;
	// widen X or the string argument cannot match.
	expect(navigated).toBe<string | null>("/projects/p1/tasks/X");
});

test("historyTask takes the entry's card id first, then the path's card", () => {
	// A deep link's first entry carries no state: the path names the open card.
	expect(historyTask(null, "X")).toBe("X");
	// An entry pushed by openTask carries the card in state.
	expect(historyTask({ ompTask: "Y" }, "X")).toBe("Y");
	// Entries pushed before the path scheme carry the card in state alone.
	expect(historyTask({ ompTask: "Y" }, null)).toBe("Y");
	// Junk state falls through to the path.
	expect(historyTask({ ompTask: 5 }, "X")).toBe("X");
	expect(historyTask("card", "X")).toBe("X");
	// Neither source names a card: the drawer closes.
	expect(historyTask(null, null)).toBeNull();
});
