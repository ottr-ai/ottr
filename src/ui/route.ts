export const SETTINGS_HASH = "settings";

/** "settings" opens General; "settings/<project>" opens that project's page; other hashes are not settings. */
export function settingsSub(view: string): {
	onSettings: boolean;
	project: string | null;
} {
	if (view === SETTINGS_HASH) return { onSettings: true, project: null };
	if (view.startsWith(`${SETTINGS_HASH}/`))
		// `view` is readHash()'s output, already percent-decoded once; decoding again
		// throws on names containing "%" and corrupts names containing "%2F".
		return { onSettings: true, project: view.slice(SETTINGS_HASH.length + 1) };
	return { onSettings: false, project: null };
}

/** The URL hash names the open project; empty means the overview. A malformed hash falls back to the overview. */
export function readHash(): string {
	try {
		return decodeURIComponent(location.hash.slice(1));
	} catch {
		return "";
	}
}
