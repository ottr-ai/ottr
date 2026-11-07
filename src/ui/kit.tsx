import type { ReactNode } from "react";
import {
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createRoot } from "react-dom/client";
import type { ProjectView, QuotaLimit, QuotaState } from "../types.ts";
import { latestQuota, liveEvents } from "./socket.ts";
import { etaLeft } from "./status.ts";
import { duration, stamp, until } from "./time.ts";

export function clamp(n: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, n));
}

/** "?" badge: one short explanation in a native popover. Click, Enter or Space opens it; Esc or a click outside closes it. */
export function Help({ label, text }: { label: string; text: ReactNode }) {
	const id = useId();
	return (
		<>
			<button
				type="button"
				className="help-badge"
				popoverTarget={id}
				aria-label={`About ${label}`}
				title={`About ${label}`}
			>
				<Icon name="help" size={13} />
			</button>
			<span id={id} popover="auto" className="help-pop">
				{text}
			</span>
		</>
	);
}

// ponytail: inline Feather (MIT) paths instead of @phosphor-icons/react; swap to the library if this set grows
// satisfies keeps `keyof typeof ICON_PATHS` a literal union: an unknown <Icon name> fails tsc.
const ICON_PATHS = {
	plus: <path d="M12 5v14M5 12h14" />,
	// feather edit-2 (MIT): Edit actions (release notes, task prompt)
	edit: <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />,
	star: (
		<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
	),
	x: <path d="M18 6L6 18M6 6l12 12" />,
	stop: <rect x="6" y="6" width="12" height="12" rx="1.5" />,
	folder: (
		<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
	),
	image: (
		<>
			<rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
			<circle cx="8.5" cy="8.5" r="1.5" />
			<polyline points="21 15 16 10 5 21" />
		</>
	),
	send: <path d="M22 2L11 13M22 2l-7 20-4-9-9-4z" />,
	"corner-up-left": (
		<>
			<polyline points="9 14 4 9 9 4" />
			<path d="M20 20v-7a4 4 0 0 0-4-4H4" />
		</>
	),
	gear: (
		<>
			<circle cx="12" cy="12" r="3" />
			<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
		</>
	),
	"chevron-left": <path d="M15 18l-6-6 6-6" />,
	"chevron-right": <path d="M9 18l6-6-6-6" />,
	clock: (
		<>
			<circle cx="12" cy="12" r="10" />
			<polyline points="12 6 12 12 16 14" />
		</>
	),
	"git-merge": (
		<>
			<circle cx="18" cy="18" r="3" />
			<circle cx="6" cy="6" r="3" />
			<path d="M6 21V9a9 9 0 0 0 9 9" />
		</>
	),
	bell: (
		<>
			<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
			<path d="M13.73 21a2 2 0 0 1-3.46 0" />
		</>
	),
	"bell-off": (
		<>
			<path d="M13.73 21a2 2 0 0 1-3.46 0" />
			<path d="M18.63 13A17.89 17.89 0 0 1 18 8" />
			<path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14" />
			<path d="M18 8a6 6 0 0 0-9.33-5" />
			<path d="M1 1l22 22" />
		</>
	),
	check: <path d="M20 6L9 17l-5-5" />,
	trash: (
		<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
	),
	branch: (
		<path d="M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9" />
	),
	grid: <path d="M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z" />,
	// A tall stem with a clear gap under the dot keeps the "i" legible at 14-16px.
	info: (
		<path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 17v-5.5M12 7h.01" />
	),
	monitor: (
		<>
			<rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
			<path d="M8 21h8M12 17v4" />
		</>
	),
	sun: (
		<>
			<circle cx="12" cy="12" r="5" />
			<path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
		</>
	),
	// lucide user (ISC): placeholder avatar until Ottr has user accounts
	user: (
		<>
			<circle cx="12" cy="8" r="4" />
			<path d="M4 21a8 8 0 0 1 16 0" />
		</>
	),
	moon: <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />,
	tag: (
		<>
			<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.83z" />
			<path d="M7 7h.01" />
		</>
	),
	play: <path d="M5 3l14 9-14 9V3z" />,
	"log-out": (
		<>
			<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
			<path d="M16 17l5-5-5-5" />
			<path d="M21 12H9" />
		</>
	),
	eye: (
		<>
			<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
			<circle cx="12" cy="12" r="3" />
		</>
	),
	"eye-off": (
		<>
			<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
			<path d="M1 1l22 22" />
		</>
	),
	copy: (
		<>
			<rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
			<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
		</>
	),
	// lucide download (ISC): save a report file locally
	download: (
		<>
			<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
			<polyline points="7 10 12 15 17 10" />
			<line x1="12" x2="12" y1="15" y2="3" />
		</>
	),
	"refresh-cw": (
		<>
			<polyline points="23 4 23 10 17 10" />
			<polyline points="1 20 1 14 7 14" />
			<path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
		</>
	),
	// lucide ship-wheel (ISC): Steer is course-correction, not message-send
	helm: (
		<>
			<circle cx="12" cy="12" r="8" />
			<path d="M12 2v7.5" />
			<path d="m19 5-5.23 5.23" />
			<path d="M22 12h-7.5" />
			<path d="m19 19-5.23-5.23" />
			<path d="M12 14.5V22" />
			<path d="m10.23 13.77-5.23 5.23" />
			<path d="M9.5 12H2" />
			<path d="m10.23 10.23-5.23-5.23" />
			<circle cx="12" cy="12" r="2.5" />
		</>
	),
	// lucide container (ISC): a tracked repo's published image
	container: (
		<>
			<path d="M22 7.7c0-.6-.4-1.2-.8-1.5l-6.3-3.9a1.72 1.72 0 0 0-1.7 0l-10.3 6c-.5.2-.9.8-.9 1.4v6.6c0 .5.4 1.2.8 1.5l6.3 3.9a1.72 1.72 0 0 0 1.7 0l10.3-6c.5-.3.9-1 .9-1.5Z" />
			<path d="M10 21.9V14L2.1 9.1" />
			<path d="m10 14 11.9-6.9" />
			<path d="M14 19.8v-8.1" />
			<path d="M18 17.5V9.4" />
		</>
	),
	// lucide panel-left (ISC): the app bar's sidebar toggle
	"panel-left": (
		<>
			<rect x="3" y="3" width="18" height="18" rx="2" />
			<path d="M9 3v18" />
		</>
	),
	// lucide shield-check (ISC): Start review
	"shield-check": (
		<>
			<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
			<path d="m9 12 2 2 4-4" />
		</>
	),
	// lucide package (ISC): Create release
	package: (
		<>
			<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z" />
			<path d="M12 22V12" />
			<path d="m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7" />
			<path d="m7.5 4.27 9 5.15" />
		</>
	),
	// lucide workflow (ISC): Show diagrams
	workflow: (
		<>
			<rect x="3" y="3" width="8" height="8" rx="2" />
			<path d="M7 11v4a2 2 0 0 0 2 2h4" />
			<rect x="13" y="13" width="8" height="8" rx="2" />
		</>
	),
	// lucide ellipsis (ISC): the project header's menu of actions
	more: (
		<>
			<circle cx="12" cy="12" r="1" />
			<circle cx="19" cy="12" r="1" />
			<circle cx="5" cy="12" r="1" />
		</>
	),
	// lucide list-checks (ISC): Open setup, a wizard of steps
	"list-checks": (
		<>
			<path d="m3 17 2 2 4-4" />
			<path d="m3 7 2 2 4-4" />
			<path d="M13 6h8" />
			<path d="M13 12h8" />
			<path d="M13 18h8" />
		</>
	),
	// lucide route (ISC): the drawer's workflow overview, one card's path through the stages
	route: (
		<>
			<circle cx="6" cy="19" r="3" />
			<path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" />
			<circle cx="18" cy="5" r="3" />
		</>
	),
	// lucide chevrons-up / chevrons-down (ISC): collapse-all / expand-all lane tools
	"chevrons-up": (
		<>
			<polyline points="17 11 12 6 7 11" />
			<polyline points="17 18 12 13 7 18" />
		</>
	),
	"chevrons-down": (
		<>
			<polyline points="7 13 12 18 17 13" />
			<polyline points="7 6 12 11 17 6" />
		</>
	),
	// lucide grip-vertical (ISC): the drag handle of a settings reorder row
	"grip-vertical": (
		<>
			<circle cx="9" cy="5" r="1" />
			<circle cx="9" cy="12" r="1" />
			<circle cx="9" cy="19" r="1" />
			<circle cx="15" cy="5" r="1" />
			<circle cx="15" cy="12" r="1" />
			<circle cx="15" cy="19" r="1" />
		</>
	),
	// lucide circle-help (ISC): opens the projects-line mark legend
	help: (
		<>
			<circle cx="12" cy="12" r="10" />
			<path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
			<path d="M12 17h.01" />
		</>
	),
	// lucide activity (ISC): the dev-only Check the board button
	activity: <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />,
	// feather zoom-in / zoom-out (MIT): lightbox image zoom buttons
	"zoom-in": (
		<>
			<circle cx="11" cy="11" r="8" />
			<line x1="21" y1="21" x2="16.65" y2="16.65" />
			<line x1="11" y1="8" x2="11" y2="14" />
			<line x1="8" y1="11" x2="14" y2="11" />
		</>
	),
	"zoom-out": (
		<>
			<circle cx="11" cy="11" r="8" />
			<line x1="21" y1="21" x2="16.65" y2="16.65" />
		</>
	),
} satisfies Record<string, ReactNode>;

/** Every glyph name the board's Icon set knows. */
export type IconName = keyof typeof ICON_PATHS;

export function Icon({ name, size = 15 }: { name: IconName; size?: number }) {
	return (
		<svg
			className="icon-svg"
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.8"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{ICON_PATHS[name]}
		</svg>
	);
}

export type Act = (
	fn: () => Promise<void>,
	/** Also told inline surfaces (dialogs) so they can show the message at their bottom. */
	onError?: (message: string) => void,
) => Promise<boolean>;

/** Body-or-error unwrapper shared by the REST helpers; the server's `{ error }` shape wins over the status line. */
export async function unwrap<T>(res: Response): Promise<T> {
	if (!res.ok) {
		let error = `HTTP ${res.status}`;
		try {
			const data = (await res.json()) as { error?: string };
			if (typeof data.error === "string") error = data.error;
		} catch {
			// non-JSON error body; keep the HTTP status text
		}
		throw new Error(error);
	}
	return (await res.json()) as T;
}

export async function post<T>(url: string, body: unknown): Promise<T> {
	return unwrap(
		await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
}

/** Clipboard write that rejects with a user-ready message; browsers refuse it on insecure origins or without permission. */
export async function copyText(text: string): Promise<void> {
	if (navigator.clipboard === undefined)
		throw new Error(
			"Copy failed: the clipboard is not available here (needs HTTPS or localhost)",
		);
	try {
		await navigator.clipboard.writeText(text);
	} catch (err) {
		throw new Error(
			`Copy failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/** Set by logOut; keeps the login gate up after reload on hosts that don't enforce sessions (loopback). */
export const LOGOUT_KEY = "ottr.loggedout";

/** Ends the session and reloads into the login gate, even where the server never returns 401 (loopback).
 * Runs through App's act(): a failed POST shows the error and leaves the button usable, and the
 * gate flag is only set once the server confirmed the session is gone. */
export async function logOut(): Promise<void> {
	await post("/api/logout", {});
	localStorage.setItem(LOGOUT_KEY, "1");
	location.reload();
}

/** Busy + failed state for one server-triggering control; `start` runs the action and tracks it. */
export interface BusyState {
	busy: boolean;
	failed: boolean;
	start: (run: () => Promise<boolean>) => void;
}

export function useBusy(): BusyState {
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		if (!failed) return;
		const t = setTimeout(() => setFailed(false), 3000);
		return () => clearTimeout(t);
	}, [failed]);
	const start = useCallback(
		(run: () => Promise<boolean>): void => {
			if (busy) return;
			setBusy(true);
			setFailed(false);
			void run()
				.then((ok) => {
					if (!ok) setFailed(true);
				})
				.finally(() => setBusy(false));
		},
		[busy],
	);
	return { busy, failed, start };
}

/** One-shot flag that clears itself after `ms`; backs the 1.5 s "Saved"/"Copied" flashes. */
export function useFlash(ms: number): [boolean, () => void] {
	const [on, setOn] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	const flash = (): void => {
		setOn(true);
		clearTimeout(timer.current);
		timer.current = setTimeout(() => setOn(false), ms);
	};
	return [on, flash];
}

/** State of one save that runs on its own; `run` sends, `onFail` rolls an optimistic value back. */
export type InstantSave = {
	run: (
		send: () => Promise<unknown>,
		onFail?: () => void,
		onError?: (message: string) => void,
	) => void;
	busy: boolean;
	failed: boolean;
	saved: boolean;
};

/** One save that runs on its own (a toggle, an upload, a card's Save): busy while it runs,
 *  then a short "saved" flash. */
export function useInstantSave(act: Act): InstantSave {
	const busy = useBusy();
	const [saved, flash] = useFlash(1600);
	const run = (
		send: () => Promise<unknown>,
		onFail?: () => void,
		onError?: (message: string) => void,
	): void =>
		busy.start(async () => {
			const ok = await act(async () => {
				await send();
			}, onError);
			if (ok) flash();
			else onFail?.();
			return ok;
		});
	return { run, busy: busy.busy, failed: busy.failed, saved };
}

/** The optimistic-value pattern: a row's checkbox (or similar) leads, the server state trails.
 *  `set` adopts the new value at once so the UI responds before anything is sent; `run` then
 *  sends it, rolling the shown value back if the save fails, and the local value clears itself
 *  once the server state catches up and matches. */
export interface OptimisticValue<T> {
	/** The shown value: the optimistic value while one is held, else the server's. */
	value: T;
	/** Adopts v at once; a server frame settles it or a failed run rolls it back. */
	set: (v: T) => void;
	run: (
		send: () => Promise<unknown>,
		onFail?: () => void,
		onError?: (message: string) => void,
	) => void;
	busy: boolean;
	failed: boolean;
	saved: boolean;
}

export function useOptimisticValue<T>(
	server: T,
	act: Act,
	eq: (a: T, b: T) => boolean = Object.is,
): OptimisticValue<T> {
	const s = useInstantSave(act);
	const [local, setLocal] = useState<T | undefined>(undefined);
	useEffect(() => {
		if (local !== undefined && eq(local, server)) setLocal(undefined);
	}, [local, server, eq]);
	return {
		value: local === undefined ? server : local,
		set: setLocal,
		run: (send, onFail, onError): void =>
			s.run(
				send,
				() => {
					setLocal(undefined);
					onFail?.();
				},
				onError,
			),
		busy: s.busy,
		failed: s.failed,
		saved: s.saved,
	};
}

/** State that trails its setter by `ms`: each call resets the wait, the value lands
 *  once the calls pause. Backs the board search: the box takes every keystroke, the
 *  lanes re-filter after the pause, so swift typing on a big board renders once. */
export function useDelayedState(ms: number): [string, (value: string) => void] {
	const [delayed, setDelayed] = useState("");
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	const set = (value: string): void => {
		clearTimeout(timer.current);
		timer.current = setTimeout(() => setDelayed(value), ms);
	};
	return [delayed, set];
}

/** Server-touching button: disabled with a spinner until the response arrives, error styling when it failed. */
export function BusyButton({
	run,
	className,
	disabled,
	title,
	ariaLabel,
	children,
}: {
	run: () => Promise<boolean>;
	className?: string;
	disabled?: boolean;
	title?: string;
	ariaLabel?: string;
	children: ReactNode;
}) {
	const { busy, failed, start } = useBusy();
	return (
		<button
			type="button"
			className={`${className ?? ""}${busy ? " busy" : ""}${failed ? " failed" : ""}`}
			disabled={disabled === true || busy}
			title={title}
			aria-label={ariaLabel}
			aria-busy={busy || undefined}
			onClick={() => start(run)}
		>
			{busy && <span className="spinner" aria-hidden="true" />}
			{children}
		</button>
	);
}

type MarkKind =
	| "needs"
	| "asked"
	| "warn"
	| "crit"
	| "running"
	| "preparing"
	| "queued"
	| "done"
	| "cancelled"
	| "star"
	| "unread";

// Redundant state coding (ISA-101): shape carries the state; colour is spent only on alarms (amber, red).
// Ask rounds are the exception: the question mark rides the steel accent — input requested, not a stall.
const MARK_SHAPES: Record<MarkKind, ReactNode> = {
	// Steel accent dot = a finished task not opened yet (OTTR-566); same dot as running, the colour tells them apart.
	unread: <circle cx="8" cy="8" r="4.5" />,
	needs: (
		<>
			<path d="M8 1.4 15.4 14.6H.6z" />
			<path className="mark-ink" d="M8 6.2v3.8M8 12.1v.1" />
		</>
	),
	asked: (
		<>
			<circle cx="8" cy="8" r="6.6" />
			<path
				className="mark-ink"
				d="M6.1 6.1a1.9 1.9 0 1 1 2.9 1.6c-.55.35-.8.7-.8 1.4M7.9 11.7v.1"
			/>
		</>
	),
	// Project warnings ride the needs triangle as a grey outline: attention without alarm.
	warn: (
		<>
			<path d="M8 1.4 15.4 14.6H.6z" />
			<path className="mark-ink" d="M8 6.2v3.8M8 12.1v.1" />
		</>
	),
	crit: (
		<>
			<rect x="1.5" y="1.5" width="13" height="13" rx="1.5" />
			<path className="mark-ink" d="M8 4.6v4.4M8 11.4v.1" />
		</>
	),
	running: <circle cx="8" cy="8" r="4.5" />,
	// A preparing task has been started (the tracker is provisioning): full dot like running, not the queued ring.
	preparing: <circle cx="8" cy="8" r="4.5" />,
	queued: <circle cx="8" cy="8" r="4" />,
	done: <path d="M3.2 8.4l3.1 3.1 6.5-7" />,
	// A cancelled card: the x closes the story; the "Cancelled" chip beside it carries the word.
	cancelled: <path d="M4.6 4.6l6.8 6.8M11.4 4.6l-6.8 6.8" />,
	// A starred report: the feather star scaled into the 16 box; the card-head sizing applies.
	star: (
		<polygon
			transform="scale(0.6667)"
			points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"
		/>
	),
};

/** Skeleton: neutral grey blocks in the rough shape of content still loading, for
 *  remote loads that can outlast 1s (model list, provisioning, fork facts). The block
 *  holds opacity 0 through the shared wait-show delay, so a fast load shows nothing.
 *  role="status" plus a label: grey blocks say nothing to a screen reader. The bones
 *  shimmer gently; reduced motion collapses the shimmer to a static fill. */
export function Skeleton({
	rows = 3,
	shape = "lines",
	label,
}: {
	/** How many blocks to draw: lines, list rows, label/field pairs, or stat cells. */
	rows?: number;
	/** Rough shape of the incoming content. */
	shape?: "lines" | "list" | "rows" | "stats";
	/** Accessible name announced while the blocks show. */
	label: string;
}) {
	return (
		<div
			className="skeleton"
			data-shape={shape}
			role="status"
			aria-label={label}
		>
			{Array.from({ length: rows }, (_, i) =>
				shape === "rows" || shape === "stats" ? (
					<span
						key={i}
						className={shape === "rows" ? "skeleton-row" : "skeleton-stat"}
						aria-hidden="true"
					>
						<span className="skeleton-bone" />
						<span className="skeleton-bone" />
					</span>
				) : (
					<span key={i} className="skeleton-bone" aria-hidden="true" />
				),
			)}
		</div>
	);
}

/** A live turn's ticking clock: elapsed time, then "about X left" while the median estimate
 * (etaMs) still has room, then the status words. Re-renders once a second while mounted; pure
 * text with no animation, so reduced motion is unaffected. Long-wait lines reuse it for the
 * elapsed part alone ("Consolidating the notes… · 2m", "Provisioning the workers… · 4m"). */
export function LiveElapsed({
	since,
	status,
	etaMs,
}: {
	since: number;
	status?: string | null;
	etaMs?: number;
}) {
	const [, setTick] = useState(0);
	useEffect(() => {
		const t = setInterval(() => setTick((x) => x + 1), 1000);
		return () => clearInterval(t);
	}, []);
	const eta = etaMs !== undefined ? etaLeft(etaMs, since) : null;
	return (
		<>
			{duration(Math.max(0, Date.now() - since))}
			{status != null && status !== "" && <> · {status}</>}
			{eta !== null && <> · {eta}</>}
		</>
	);
}

export function Mark({ kind }: { kind: MarkKind }) {
	return (
		<svg className={`mark mark-${kind}`} viewBox="0 0 16 16" aria-hidden="true">
			{MARK_SHAPES[kind]}
		</svg>
	);
}

/** Upper edge of the normal band on every load indicator, in percent. */
export const BAND_LIMIT = 85;

/** Level against the normal band: normal below the limit, high up to 95 %, critical above. */
export function loadLevel(pct: number | null): "na" | "ok" | "high" | "crit" {
	return pct === null
		? "na"
		: pct >= 95
			? "crit"
			: pct >= BAND_LIMIT
				? "high"
				: "ok";
}

/** Analog bar indicator: grey inside the normal band, alarm-coloured (plus mark) outside it. */
export function Meter({
	label,
	pct,
	value,
	band = true,
	title,
}: {
	label: string;
	pct: number | null;
	value?: string;
	band?: boolean;
	title?: string;
}) {
	const level = band ? loadLevel(pct) : pct === null ? "na" : "ok";
	return (
		<span className="meter" data-level={level} title={title}>
			<span className="meter-label">{label}</span>
			<span className="meter-track" aria-hidden="true">
				<span
					className="meter-fill"
					style={{ transform: `scaleX(${clamp(pct ?? 0, 0, 100) / 100})` }}
				/>
				{band && (
					<span className="meter-limit" style={{ left: `${BAND_LIMIT}%` }} />
				)}
			</span>
			<span className="meter-value">
				{level === "high" && <Mark kind="needs" />}
				{level === "crit" && <Mark kind="crit" />}
				{value ?? (pct === null ? "n/a" : `${Math.round(pct)}%`)}
			</span>
		</span>
	);
}

const WINDOW_UNIT_MS = {
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
	w: 604_800_000,
} as const;

/** Epoch ms one calendar month before `at`, in UTC; the day clamps to the shorter month
 *  (Mar 31 -> Feb 28), so a monthly window's length follows the month it covers. */
function monthBefore(at: number): number {
	const t = new Date(at);
	const y = t.getUTCFullYear();
	const m = t.getUTCMonth() - 1; // Date.UTC rolls -1 over to December of the year before
	const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
	return Date.UTC(
		y,
		m,
		Math.min(t.getUTCDate(), last),
		t.getUTCHours(),
		t.getUTCMinutes(),
		t.getUTCSeconds(),
		t.getUTCMilliseconds(),
	);
}

/** Share of a quota window that has passed, 0-100: from omp's window id ("5h", "7d", or the
 *  named "daily", "weekly", "monthly" ids), or, when omp names no id, the window label and the
 *  limit label ("5 Hours", "7 Day", "Weekly", "Monthly"). A named monthly window is one calendar
 *  month: it starts one month before resetsAt in UTC. Null when the length or the reset is unknown. */
export function windowGone(l: QuotaLimit, now: number): number | null {
	if (l.resetsAt === null) return null;
	const id = /^(\d+)([mhdw])$/.exec(l.window ?? "");
	const named = /(\d+)\s*(hour|day|week)/i.exec(l.label);
	const calendar = /(daily|weekly|monthly)/i
		.exec(`${l.window ?? ""} ${l.windowLabel ?? ""} ${l.label}`)?.[1]
		?.toLowerCase();
	const ms = id
		? Number(id[1]) * WINDOW_UNIT_MS[id[2] as keyof typeof WINDOW_UNIT_MS]
		: named
			? Number(named[1]) *
				WINDOW_UNIT_MS[named[2]![0]!.toLowerCase() as "h" | "d" | "w"]
			: calendar === "monthly"
				? l.resetsAt - monthBefore(l.resetsAt)
				: calendar !== undefined
					? WINDOW_UNIT_MS[calendar === "daily" ? "d" : "w"]
					: null;
	if (ms === null || ms <= 0) return null;
	return clamp(100 - ((l.resetsAt - now) / ms) * 100, 0, 100);
}

/** One usage window in Settings: label, percent, the app bar's time-over-quota twin bar, reset countdown. */
export function QuotaRow({ limit }: { limit: QuotaLimit }) {
	const level = loadLevel(limit.usedPct);
	const gone = windowGone(limit, Date.now());
	return (
		<div className="quota-row">
			<span className="meter" data-level={level} title={limit.label}>
				<span className="meter-label">{limit.label}</span>
				<span
					className="qt-bars"
					role="img"
					aria-label={`${Math.round(limit.usedPct)} % used${gone === null ? "" : `, ${Math.round(gone)} % of the window gone`}`}
				>
					{gone !== null && (
						<span className="qt-time">
							<i style={{ width: `${gone}%` }} />
						</span>
					)}
					<span className="qt-used">
						<i
							style={{
								transform: `scaleX(${clamp(limit.usedPct, 0, 100) / 100})`,
							}}
						/>
					</span>
				</span>
				<span className="meter-value">
					{level === "high" && <Mark kind="needs" />}
					{level === "crit" && <Mark kind="crit" />}
					{Math.round(limit.usedPct)}%
				</span>
			</span>
			<span
				className="quota-reset"
				title={
					limit.resetsAt === null
						? undefined
						: `Resets ${stamp(limit.resetsAt)}`
				}
			>
				{limit.resetsAt === null ? "" : `resets in ${until(limit.resetsAt)}`}
			</span>
		</div>
	);
}

/** Usage quota pushed with every state frame, for the model picker's per-model budget chip. */
export function useQuota(): QuotaState | null {
	const [quota, setQuota] = useState<QuotaState | null>(latestQuota());
	useEffect(() => {
		const onQuota = (): void => setQuota(latestQuota());
		liveEvents.addEventListener("quota", onQuota);
		return () => liveEvents.removeEventListener("quota", onQuota);
	}, []);
	return quota;
}

/** Native modal dialog: top layer, inert page, Esc and backdrop close, focus return to the opener. */
export function Modal({
	open = true,
	onClose,
	label,
	className,
	children,
}: {
	open?: boolean;
	onClose: () => void;
	label: string;
	className?: string;
	children: ReactNode;
}) {
	const ref = useRef<HTMLDialogElement | null>(null);
	useLayoutEffect(() => {
		const d = ref.current;
		if (d === null) return;
		if (open && !d.open) {
			d.showModal();
			d.querySelector<HTMLElement>("[data-autofocus]")?.focus();
		} else if (!open && d.open) d.close();
	}, [open]);
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: native <dialog> Escape already closes; this onClick is backdrop-only
		<dialog
			ref={ref}
			className={className}
			aria-label={label}
			onClose={onClose}
			onClick={(e) => {
				if (e.target === e.currentTarget) e.currentTarget.close(); // the backdrop; content sits in an inner wrapper
			}}
		>
			{children}
		</dialog>
	);
}

/** Closes the enclosing dialog natively, so its close event and focus return run. */
export function CloseButton() {
	return (
		<button
			type="button"
			className="icon"
			aria-label="Close"
			onClick={(e) => e.currentTarget.closest("dialog")?.close()}
		>
			<Icon name="x" />
		</button>
	);
}

/**
 * Board-styled stand-in for window.confirm. The text up to the first "?" is the title, the
 * rest the detail (line breaks kept). Resolves true only on the confirm button; Cancel, Esc,
 * the close button and the backdrop all resolve false. A danger confirm starts on Cancel.
 * `cancel` renames the safe button when "Cancel" would collide with the action itself
 * (for example "Cancel task" pairs with "Keep task"). `field` adds one optional labelled
 * text box above the buttons; each keystroke reaches `onInput`, the caller reads it on yes.
 */
export function confirmDialog(
	message: string,
	{
		ok = "Confirm",
		cancel = "Cancel",
		danger = false,
		field,
	}: {
		ok?: string;
		cancel?: string;
		danger?: boolean;
		field?: {
			label: string;
			help: string;
			maxLength: number;
			onInput: (value: string) => void;
		};
	} = {},
): Promise<boolean> {
	const cut = message.search(/\?(\s|$)/);
	const title = cut < 0 ? message : message.slice(0, cut + 1);
	const detail = cut < 0 ? "" : message.slice(cut + 1).trim();
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const host = document.body.appendChild(document.createElement("div"));
	const root = createRoot(host);
	let yes = false;
	const close = (e: { currentTarget: Element }): void =>
		e.currentTarget.closest("dialog")?.close();
	const done = (): void => {
		resolve(yes);
		// Unmount after the close event's dispatch, never inside it.
		setTimeout(() => {
			root.unmount();
			host.remove();
		});
	};
	root.render(
		<Modal label={title} className="dialog confirm-dialog" onClose={done}>
			<div className="dialog-body">
				<div className="dialog-head">
					<h2>{title}</h2>
					<CloseButton />
				</div>
				{detail !== "" && <p className="confirm-detail">{detail}</p>}
				{field !== undefined && (
					<div className="field">
						<label htmlFor="confirm-field">{field.label}</label>
						<textarea
							id="confirm-field"
							rows={3}
							maxLength={field.maxLength}
							aria-describedby="confirm-field-help"
							onChange={(e) => field.onInput(e.target.value)}
						/>
						<p id="confirm-field-help" className="hint">
							{field.help}
						</p>
					</div>
				)}
				<div className="dialog-actions">
					<button
						type="button"
						data-autofocus={danger || undefined}
						onClick={close}
					>
						{cancel}
					</button>
					<button
						type="button"
						className={danger ? "danger" : "primary"}
						data-autofocus={!danger || undefined}
						onClick={(e) => {
							yes = true;
							close(e);
						}}
					>
						{ok}
					</button>
				</div>
			</div>
		</Modal>,
	);
	return promise;
}

export const interviewMsg = (interview: string): string =>
	interview === "queued"
		? "Rules interview queued as a card - it starts shortly and asks its questions on the card."
		: interview === "not-needed"
			? "AGENTS.md found - no interview needed."
			: interview === "gitless"
				? "Init a git repository first - actions wait until then."
				: interview;

/** The name the board shows; the folder name stays the project's id in URLs and filters. */
export function projectLabel(p: ProjectView): string {
	return p.settings.displayName ?? p.name;
}

/**
 * Two-letter tag that tells projects apart by letter shape, not hue: DESIGN.md keeps hue for
 * alarms. Initials of the first two words, else the first two characters. Characters are
 * grapheme clusters, so astral letters and combining marks never split into broken halves.
 * ponytail: two projects can share a tag (ottr / omp-task-tracker); the name beside it decides.
 */
export function monogram(label: string): string {
	const graphemes = new Intl.Segmenter();
	const words = label.split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
	const [a = [], b] = (words.length > 0 ? words : [label]).map((w) =>
		Array.from(graphemes.segment(w), (g) => g.segment),
	);
	return (b === undefined ? a.slice(0, 2) : [a[0], b[0]])
		.join("")
		.toUpperCase();
}

/**
 * Icon adopted from the project's source: the GitHub owner's avatar, else the host's
 * favicon. Reads the raw `remote` (any host); null = nothing to adopt from.
 */
export function sourceIconUrl(p: ProjectView): string | null {
	if (p.remote === null) return null;
	let u: URL;
	try {
		u = new URL(p.remote);
	} catch {
		return null;
	}
	if (u.hostname === "github.com" || u.hostname === "www.github.com") {
		const owner = u.pathname.split("/")[1];
		return owner ? `https://github.com/${owner}.png?size=64` : null;
	}
	return `${u.origin}/favicon.ico`;
}

export function ProjectTag({ project }: { project: ProjectView }) {
	// The text marker wins over every image: its purpose is to replace whatever icon
	// would otherwise show (docs/specs/project-icon-text.md). Then the custom upload,
	// then the source's icon. A load failure falls back to the monogram; a re-upload
	// gets a new ?v, so a new src retries the img.
	const [failedSrc, setFailedSrc] = useState<string | null>(null);
	const marker = project.settings.iconText;
	if (marker)
		return (
			<span className="ptag tag-text" aria-hidden="true">
				{marker}
			</span>
		);
	const src =
		project.icon !== null
			? `/api/projects/${encodeURIComponent(project.name)}/icon?v=${project.icon}`
			: sourceIconUrl(project);
	const showImg = src !== null && failedSrc !== src;
	return (
		<span className={showImg ? "ptag tag-img" : "ptag"} aria-hidden="true">
			{showImg ? (
				<img
					src={src}
					alt=""
					loading="lazy"
					referrerPolicy="no-referrer"
					onError={() => setFailedSrc(src)}
				/>
			) : (
				monogram(projectLabel(project))
			)}
		</span>
	);
}

/** The board header's logo, linked to the git(hub) origin: the GitHub view first, else the
 * HTTPS origin remote; plain tag when the project has neither. */
export function ProjectLogo({ project }: { project: ProjectView }) {
	const url = project.github ?? project.remote;
	return url === null ? (
		<ProjectTag project={project} />
	) : (
		<a
			href={url}
			target="_blank"
			rel="noopener noreferrer"
			title="Repository origin"
			aria-label="Repository origin"
		>
			<ProjectTag project={project} />
		</a>
	);
}

export type ZoomState = { scale: number; x: number; y: number };

const ZOOM_MIN = 1;
const ZOOM_MAX = 8;
const ZOOM_STEP = 1.25;
const ZOOM_TAP_TARGET = 2.5;
const ZOOM_TAP_MS = 300;
const ZOOM_TAP_PX = 20;

/** Anchor-preserving zoom: the image point under the cursor stays under it after the scale change. */
export function zoomAt(
	z: ZoomState,
	rect: { left: number; top: number },
	clientX: number,
	clientY: number,
	nextScale: number,
): ZoomState {
	const s = clamp(nextScale, ZOOM_MIN, ZOOM_MAX);
	const px = (clientX - rect.left - z.x) / z.scale;
	const py = (clientY - rect.top - z.y) / z.scale;
	return {
		scale: s,
		x: clientX - rect.left - px * s,
		y: clientY - rect.top - py * s,
	};
}

/** Keeps the zoomed image covering its box: translate is clamped, scale 1 snaps back to identity. */
export function clampPan(z: ZoomState, w: number, h: number): ZoomState {
	if (z.scale <= 1) return { scale: 1, x: 0, y: 0 };
	return {
		scale: z.scale,
		x: clamp(z.x, w * (1 - z.scale), 0),
		y: clamp(z.y, h * (1 - z.scale), 0),
	};
}

/** Wheel zoom factor from a wheel event's deltaY, per the shared lightbox zoom constants. */
function wheelFactor(dy: number, deltaMode: number): number {
	const y = deltaMode === 1 ? dy * 16 : dy;
	return Math.exp(-y * 0.002);
}

/**
 * Zoom-able lightbox image: mouse wheel, trackpad pinch, touch pinch, drag pan,
 * double-click/double-tap, plus keyboard-reachable zoom buttons. Pure hand-rolled,
 * no dependencies; reset to identity whenever the source changes.
 */
export function ZoomableImage({ src, alt }: { src: string; alt: string }) {
	const wrapRef = useRef<HTMLDivElement>(null);
	const imgRef = useRef<HTMLImageElement>(null);
	const [zoom, setZoom] = useState<ZoomState>({ scale: 1, x: 0, y: 0 });
	const [panning, setPanning] = useState(false);
	const pointers = useRef(new Map<number, { x: number; y: number }>());
	const pinch = useRef<{
		dist: number;
		mid: { x: number; y: number };
		zoom: ZoomState;
	} | null>(null);
	const pan = useRef<{ px: number; py: number; zoom: ZoomState } | null>(null);
	const lastTap = useRef<{
		t: number;
		x: number;
		y: number;
		type: string;
	} | null>(null);

	useEffect(() => {
		setZoom({ scale: 1, x: 0, y: 0 });
	}, [src]);

	const applyZoom = useCallback((next: ZoomState) => {
		const img = imgRef.current;
		if (img === null) return;
		setZoom(clampPan(next, img.offsetWidth || 1, img.offsetHeight || 1));
	}, []);

	const zoomBy = useCallback(
		(factor: number) => {
			const img = imgRef.current;
			if (img === null) return;
			const rect = img.getBoundingClientRect();
			applyZoom(
				zoomAt(
					zoom,
					rect,
					rect.left + rect.width / 2,
					rect.top + rect.height / 2,
					zoom.scale * factor,
				),
			);
		},
		[applyZoom, zoom],
	);

	useEffect(() => {
		const wrap = wrapRef.current;
		if (wrap === null) return;
		const onWheel = (e: WheelEvent) => {
			const img = imgRef.current;
			if (img === null) return;
			// Trackpad pinch arrives as ctrl+wheel; always stop the browser page zoom.
			e.preventDefault();
			const rect = img.getBoundingClientRect();
			applyZoom(
				zoomAt(
					zoom,
					rect,
					e.clientX,
					e.clientY,
					zoom.scale * wheelFactor(e.deltaY, e.deltaMode),
				),
			);
		};
		wrap.addEventListener("wheel", onWheel, { passive: false });
		return () => wrap.removeEventListener("wheel", onWheel);
	}, [applyZoom, zoom]);

	const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
		if (e.target !== imgRef.current) return;
		pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
		wrapRef.current?.setPointerCapture(e.pointerId);
		const prev = lastTap.current;
		if (
			prev !== null &&
			prev.type === e.pointerType &&
			e.timeStamp - prev.t < ZOOM_TAP_MS &&
			Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < ZOOM_TAP_PX
		) {
			lastTap.current = null;
			if (zoom.scale > 1) {
				setZoom({ scale: 1, x: 0, y: 0 });
			} else {
				const img = imgRef.current;
				if (img !== null) {
					const rect = img.getBoundingClientRect();
					applyZoom(zoomAt(zoom, rect, e.clientX, e.clientY, ZOOM_TAP_TARGET));
				}
			}
			return;
		}
		lastTap.current = {
			t: e.timeStamp,
			x: e.clientX,
			y: e.clientY,
			type: e.pointerType,
		};
		if (pointers.current.size === 1 && zoom.scale > 1) {
			pan.current = { px: e.clientX, py: e.clientY, zoom };
			setPanning(true);
		} else if (pointers.current.size === 2) {
			const [a, b] = [...pointers.current.values()];
			if (a === undefined || b === undefined) return;
			pinch.current = {
				dist: Math.hypot(a.x - b.x, a.y - b.y),
				mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
				zoom,
			};
			pan.current = null;
		}
	};

	const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
		if (!pointers.current.has(e.pointerId)) return;
		pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
		const pts = [...pointers.current.values()];
		if (pinch.current !== null && pts.length >= 2) {
			const [a, b] = pts;
			if (a === undefined || b === undefined) return;
			const dist = Math.hypot(a.x - b.x, a.y - b.y);
			const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
			const img = imgRef.current;
			if (img === null || pinch.current.dist === 0) return;
			const rect = img.getBoundingClientRect();
			const next = zoomAt(
				pinch.current.zoom,
				rect,
				mid.x,
				mid.y,
				pinch.current.zoom.scale * (dist / pinch.current.dist),
			);
			applyZoom({
				...next,
				x: next.x + mid.x - pinch.current.mid.x,
				y: next.y + mid.y - pinch.current.mid.y,
			});
			pinch.current = { dist, mid, zoom: pinch.current.zoom };
		} else if (pan.current !== null && pts.length === 1) {
			applyZoom({
				...pan.current.zoom,
				x: pan.current.zoom.x + e.clientX - pan.current.px,
				y: pan.current.zoom.y + e.clientY - pan.current.py,
			});
			pan.current = {
				px: e.clientX,
				py: e.clientY,
				zoom: pan.current.zoom,
			};
		}
	};

	const settle = () => {
		if (pointers.current.size === 0) {
			pan.current = null;
			pinch.current = null;
			setPanning(false);
			setZoom((z) => (z.scale <= 1.001 ? { scale: 1, x: 0, y: 0 } : z));
		}
	};

	const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
		pointers.current.delete(e.pointerId);
		settle();
	};

	const cursor = panning ? "grabbing" : zoom.scale > 1 ? "grab" : "zoom-in";

	return (
		<div
			className="zoomable"
			ref={wrapRef}
			style={{ cursor }}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerUp}
		>
			<img
				ref={imgRef}
				src={src}
				alt={alt}
				draggable={false}
				style={{
					transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`,
					transformOrigin: "0 0",
					touchAction: "none",
				}}
			/>
			<button
				type="button"
				className="zoom-btn zoom-in"
				aria-label="Zoom in"
				onPointerDown={(e) => e.stopPropagation()}
				onClick={() => zoomBy(ZOOM_STEP)}
			>
				<Icon name="zoom-in" />
			</button>
			<button
				type="button"
				className="zoom-btn zoom-out"
				aria-label="Zoom out"
				onPointerDown={(e) => e.stopPropagation()}
				onClick={() => zoomBy(1 / ZOOM_STEP)}
			>
				<Icon name="zoom-out" />
			</button>
		</div>
	);
}
