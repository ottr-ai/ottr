export const SETTINGS_HASH = "settings";

/** "settings" opens General; "settings/<project>" opens that project's page; other views are not settings. */
export function settingsSub(view: string): {
	onSettings: boolean;
	project: string | null;
} {
	if (view === SETTINGS_HASH) return { onSettings: true, project: null };
	if (view.startsWith(`${SETTINGS_HASH}/`))
		// `view` is already percent-decoded once (readPath() or migrateHash()); decoding
		// again throws on names containing "%" and corrupts names containing "%2F".
		return { onSettings: true, project: view.slice(SETTINGS_HASH.length + 1) };
	return { onSettings: false, project: null };
}

export interface PathView {
	view: string;
	task: string | null;
}

/** The card a Back/Forward traversal opens: the entry's stored card id first (entries
 * pushed before the path scheme carry the card in history state alone), else the card
 * the pathname names — the first entry of a deep link has null state, and its URL is
 * the only record of the open card. */
export function historyTask(
	state: unknown,
	task: string | null,
): string | null {
	if (typeof state === "object" && state !== null && "ompTask" in state) {
		const id: unknown = state.ompTask;
		if (typeof id === "string") return id;
	}
	return task;
}

/** The view string and open card id from location.pathname: "/" is the overview,
 * "/projects/<project>" a project, "/projects/<project>/tasks/<id>" that project with the
 * card's drawer open, "/settings" and "/settings/<project>" Settings. Each segment is
 * percent-decoded exactly once. An unknown or malformed path falls back to the overview. */
export function readPath(): PathView {
	const segs = location.pathname
		.split("/")
		.filter((s) => s !== "")
		.map(dec);
	if (segs[0] === "projects") {
		if (segs.length === 2) return { view: segs[1]!, task: null };
		if (segs.length === 4 && segs[2] === "tasks")
			return { view: segs[1]!, task: segs[3]! };
		return { view: "", task: null };
	}
	if (segs[0] === SETTINGS_HASH) {
		if (segs.length === 1) return { view: SETTINGS_HASH, task: null };
		if (segs.length === 2)
			return { view: `${SETTINGS_HASH}/${segs[1]}`, task: null };
	}
	return { view: "", task: null };
}

/** Decodes once; a malformed escape decodes to the overview, like readHash() did. */
function dec(s: string): string {
	try {
		return decodeURIComponent(s);
	} catch {
		return "";
	}
}

/** The project's path. Every segment is percent-encoded exactly once. */
export function projectPath(name: string): string {
	return `/projects/${encodeURIComponent(name)}`;
}

/** The card's path: its project with the drawer open. */
export function taskPath(project: string, id: string): string {
	return `${projectPath(project)}/tasks/${encodeURIComponent(id)}`;
}

/** Settings' path: General, or the named project's page. */
export function settingsPath(project: string | null): string {
	return project === null
		? `/${SETTINGS_HASH}`
		: `/${SETTINGS_HASH}/${encodeURIComponent(project)}`;
}

/** The path that names a view string without a card: "" → "/", a project its project path,
 * "settings" and "settings/<project>" their settings paths. */
export function viewPath(view: string): string {
	if (view === SETTINGS_HASH) return settingsPath(null);
	const s = settingsSub(view);
	if (s.onSettings && s.project !== null) return settingsPath(s.project);
	return view === "" ? "/" : projectPath(view);
}

/** One-time client migration of the old hash URLs: "#p1" → "/projects/p1", "#settings/a"
 * → "/settings/a", "#settings" → "/settings". replaceState never adds a history entry.
 * The legacy scheme only ever produced URLs at pathname "/", so a fragment on any other
 * path is not a view name — it is a live deep link (settings sections) and stays. */
export function migrateHash(): void {
	if (location.pathname !== "/") return;
	const raw = location.hash.slice(1);
	if (raw === "") return;
	let view = "";
	try {
		view = decodeURIComponent(raw);
	} catch {
		// Malformed escape: viewPath("") sends the browser to the overview.
	}
	history.replaceState(null, "", viewPath(view));
}

/** Programmatic settings navigation: push the view's URL (plus the section fragment when
 * given) as a history entry, then dispatch popstate. The App's popstate listener owns the
 * view and drawer transitions, so a programmatic entry must walk the same path a Back or
 * Forward traversal walks. `view` speaks the app's decoded vocabulary: "settings" or
 * "settings/<project>", the strings settingsSub() parses. */
export function settingsNavigate(view: string, sectionId?: string): void {
	const url = `${viewPath(view)}${sectionId === undefined ? "" : `#${sectionId}`}`;
	history.pushState(null, "", url);
	window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
}

/** Shared anchor click handling: a middle click or a modifier click returns untouched so the
 * browser opens the href (new tab, new window); a plain click preventDefaults and hands the
 * anchor's pathname to navigate. */
export function navClick(
	e: {
		button?: number;
		metaKey?: boolean;
		ctrlKey?: boolean;
		shiftKey?: boolean;
		altKey?: boolean;
		preventDefault(): void;
		currentTarget: { pathname: string };
	},
	navigate: (path: string) => void,
): void {
	if (
		(e.button !== undefined && e.button !== 0) ||
		e.metaKey === true ||
		e.ctrlKey === true ||
		e.shiftKey === true ||
		e.altKey === true
	)
		return;
	e.preventDefault();
	navigate(e.currentTarget.pathname);
}
