import type { ReactNode } from "react";
import {
	createContext,
	Fragment,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { defaultGitUsername } from "../githubHost.ts";
import { joinLevel, splitLevel, THINKING_LEVELS } from "../levels.ts";
import type { ModelOption } from "../models.ts";
import type { AlertClass, ClassPrefs } from "../notifications.ts";
import type { OmpStatsReport } from "../ompStats.ts";
import type { OmpStatsDashboardInfo } from "../ompStatsDashboard.ts";
import { orderBy } from "../projectOrder.ts";
import { forProvider } from "../quota.ts";
import { liveCardOf } from "../scheduler.ts";
import type {
	AppCheck,
	ArchReview,
	GitHubAppView,
	GithubFacts,
	ProjectView,
	TaskCard,
	TrendingStatus,
} from "../types.ts";
import {
	type Act,
	BusyButton,
	CloseButton,
	clamp,
	confirmDialog,
	copyText,
	Help,
	Icon,
	type IconName,
	type InstantSave,
	interviewMsg,
	LiveElapsed,
	logOut,
	Mark,
	Meter,
	Modal,
	ProjectTag,
	post,
	projectLabel,
	QuotaRow,
	Skeleton,
	unwrap,
	useBusy,
	useFlash,
	useInstantSave,
	useOptimisticValue,
	useQuota,
} from "./kit.tsx";
import {
	ModelMenuBody,
	ModelMenuTrigger,
	useModelMenu,
} from "./model-menu.tsx";
import {
	addRoleError,
	classifyRolesSave,
	fallbacksDirty,
	type ModelRow,
	missingCheckRoles,
	modelMatches,
	ownField,
	type RolesState,
	rolesDirty,
	roleWarnings,
	rowChains,
	seedStep,
	useModels,
} from "./models.ts";
import { dropBeforeId } from "./queue.ts";
import {
	navClick,
	SETTINGS_HASH,
	settingsNavigate,
	settingsPath,
	settingsSub,
} from "./route.ts";
import { refreshState } from "./socket.ts";
import { age, stamp } from "./time.ts";

/** Save-button body: the brief saved confirmation, else the plain label. */
function SaveLabel({ saved }: { saved: boolean }) {
	return saved ? (
		<span role="status" className="save-label">
			<Mark kind="done" />
			Saved
		</span>
	) : (
		"Save"
	);
}

/** The four wizard steps; the Source step lives in the Add project form, the rest here. */
const SETUP_STEPS = ["Source", "Rules", "Automation", "Runners"] as const;

/** Step strip styled like .add-tabs: steel underline on the current step, a check on done ones. */
function SetupStepsNav({ step }: { step: number }) {
	return (
		<ol className="setup-steps" aria-label="Setup steps">
			{SETUP_STEPS.map((name, i) => {
				const n = i + 1;
				return (
					<li
						key={name}
						aria-current={n === step ? "step" : undefined}
						className={n < step ? "done" : undefined}
					>
						{n < step && <Icon name="check" size={13} />}
						{name}
						{n === step && (
							<span className="step-n">
								{n} of {SETUP_STEPS.length}
							</span>
						)}
					</li>
				);
			})}
		</ol>
	);
}

/** Compact age of a fork's last push, for the recent-forks table. */
function pushedAge(pushedAt: number, now: number): string {
	const minutes = Math.max(0, Math.trunc((now - pushedAt) / 60000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.trunc(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.trunc(hours / 24)}d`;
}

/** The wizard body after the project exists: Rules, Automation, Runners. Saves land at once,
 *  so a closed dialog never loses a choice. Opens at step 2 both after Add and standalone. */
export function ProjectSetupSteps({
	project,
	interview = "standalone",
	rulesTask: rulesTaskProp = null,
	openTask,
	act,
	onNotice,
	onClose,
}: {
	project: ProjectView;
	/** Add response verdict for a fresh project: "queued" means the rules card is already filed. */
	interview?: string;
	/** The live rules interview card's id, when the caller knows one: the Rules section then
	 * offers "Open rules task" instead of a second "Discuss rules" that would only queue. */
	rulesTask?: string | null;
	/** Opens the rules card in the board drawer; the "Open rules task" button needs it. */
	openTask?: (id: string) => void;
	act: Act;
	onNotice?: (message: string) => void;
	onClose: () => void;
}) {
	const [step, setStep] = useState(2);
	// The latest ProjectView: every settings save returns one, so the checkboxes follow the server.
	const [view, setView] = useState(project);
	const [err, setErr] = useState<string | null>(null);
	const [gitless, setGitless] = useState(project.gitless);
	const [rulesQueued, setRulesQueued] = useState(interview === "queued");
	// The rules card the wizard can open: seeded from the caller, then set from every
	// interview answer's id, so a queued or running card turns the button into an open.
	const [rulesTask, setRulesTask] = useState<string | null>(rulesTaskProp);
	// Fork pre-check draft: shown before the user touches the checkbox, persisted only on Next.
	const [forkDraft, setForkDraft] = useState(false);
	const forkTouched = useRef(false);
	// GitHub facts for the fork panel, fetched once on entering step 3; null while loading.
	const [facts, setFacts] = useState<
		| { kind: "error"; message: string }
		| { kind: "ok"; facts: GithubFacts }
		| null
	>(null);
	// Step 4 drafts.
	const [mp, setMp] = useState(
		project.settings.maxParallel === null
			? ""
			: String(project.settings.maxParallel),
	);
	const [extra, setExtra] = useState(project.settings.copyExtra.join("\n"));

	/** Saves one settings patch, refreshes the board's project state, and shows errors inline. */
	const patch = (body: Record<string, unknown>): Promise<boolean> =>
		act(async () => {
			const r = await post<ProjectView>(
				`/api/projects/${encodeURIComponent(view.name)}/settings`,
				body,
			);
			setView(r);
			refreshState();
		}, setErr);

	/** One interview call; its verdict becomes a board notice and its card id an open affordance. */
	const runInterview = (
		body: Record<string, unknown>,
		after?: () => void,
	): Promise<boolean> =>
		act(async () => {
			const r = await post<{ interview: string; id: string | null }>(
				`/api/projects/${encodeURIComponent(view.name)}/interview`,
				body,
			);
			onNotice?.(interviewMsg(r.interview));
			if (r.id !== null) setRulesTask(r.id);
			after?.();
		}, setErr);

	useEffect(() => {
		if (step !== 3 || view.github === null || facts !== null) return;
		// No "loading" state write here: changing `facts` would rerun this effect and cancel the fetch.
		let live = true;
		const run = async (): Promise<void> => {
			try {
				const f = await unwrap<GithubFacts>(
					await fetch(`/api/projects/${encodeURIComponent(view.name)}/github`),
				);
				if (live) setFacts({ kind: "ok", facts: f });
			} catch (e: unknown) {
				if (live)
					setFacts({
						kind: "error",
						message: e instanceof Error ? e.message : String(e),
					});
			}
		};
		void run();
		return () => {
			live = false;
		};
	}, [step, view.github, view.name, facts]);

	// Pre-check: active forks make fork research worth a look, so it starts checked until touched.
	const forkEffective = forkTouched.current
		? forkDraft
		: view.settings.forkResearch ||
			(facts?.kind === "ok" && facts.facts.active > 0);

	/** Step 3's Next: persist the pre-check (only that) before moving on. */
	const next = (): void => {
		if (step === 3 && forkEffective !== view.settings.forkResearch) {
			void patch({ forkResearch: forkEffective }).then((ok) => {
				if (ok) setStep(4);
			});
		} else {
			setStep(step + 1);
		}
	};

	return (
		<>
			<SetupStepsNav step={step} />
			{err !== null && (
				<p className="auth-error" role="alert">
					{err}
				</p>
			)}
			{step === 2 && (
				<section className="setup-sec">
					<h3>Rules</h3>
					{gitless ? (
						<>
							<p className="hint">
								This folder is not a git repository yet, so every action waits
								until it is one.
							</p>
							<div>
								<BusyButton
									run={() =>
										act(async () => {
											await post(
												`/api/projects/${encodeURIComponent(view.name)}/init`,
												{},
											);
											setGitless(false);
										}, setErr)
									}
								>
									Create git repo
								</BusyButton>
							</div>
						</>
					) : view.hasRules ? (
						<>
							<p className="hint">
								AGENTS.md exists. Aligning re-reads it and files fixes where it
								contradicts the tracker's pipeline.
							</p>
							<div>
								<BusyButton run={() => runInterview({ fix: true })}>
									Align rules
								</BusyButton>
							</div>
						</>
					) : rulesTask !== null && openTask !== undefined ? (
						<>
							<p className="hint">
								The rules task is live — it asks its questions on the card.
							</p>
							<div>
								<BusyButton
									run={async () => {
										onClose();
										openTask(rulesTask);
										return true;
									}}
								>
									Open rules task
								</BusyButton>
							</div>
						</>
					) : rulesQueued ? (
						<p className="hint">
							The rules interview is filed as a card — it starts shortly and
							asks its questions on the card.
						</p>
					) : (
						<>
							<p className="hint">
								No AGENTS.md yet, so tasks wait in Todo. The interview asks a
								few questions and writes the rules.
							</p>
							<div>
								<BusyButton
									run={() => runInterview({}, () => setRulesQueued(true))}
								>
									Discuss rules
								</BusyButton>
							</div>
						</>
					)}
				</section>
			)}
			{step === 3 && (
				<>
					<section className="setup-sec">
						<label className="add-check">
							<input
								type="checkbox"
								checked={view.settings.retroSince !== null}
								onChange={(e) => {
									void patch({ retro: e.target.checked });
								}}
							/>
							Retro
							<span className="hint">
								After each done task the supervisor proposes follow-up cards
								from its retro.
							</span>
						</label>
						<label className="add-check setup-sub">
							<input
								type="checkbox"
								checked={view.settings.retroFilter}
								disabled={view.settings.retroSince === null}
								onChange={(e) => {
									void patch({ retroFilter: e.target.checked });
								}}
							/>
							Friction filter
							<span className="hint">
								Keep only retro proposals that fix a friction the task hit.
							</span>
						</label>
					</section>
					{view.github !== null && (
						<section className="setup-sec">
							<label className="add-check">
								<input
									type="checkbox"
									checked={forkEffective}
									onChange={(e) => {
										forkTouched.current = true;
										setForkDraft(e.target.checked);
									}}
								/>
								Fork research
								<span className="hint">
									{!forkTouched.current &&
									facts?.kind === "ok" &&
									facts.facts.active > 0 &&
									!view.settings.forkResearch
										? `${facts.facts.active} of ${facts.facts.forks} forks pushed in the last 90 days, so this starts checked.`
										: "Hourly watch of the project's GitHub forks; analysis files held proposals; fork-born merges need approval."}
								</span>
							</label>
							{facts === null ? (
								<Skeleton shape="stats" rows={2} label="Loading GitHub facts" />
							) : facts.kind === "error" ? (
								<p className="hint" role="alert">
									GitHub facts unavailable: {facts.message}
								</p>
							) : (
								<>
									<div className="setup-facts">
										<div>
											<b>{facts.facts.forks}</b>
											<span>forks</span>
										</div>
										<div>
											<b>{facts.facts.active}</b>
											<span>pushed in the last 90 days</span>
										</div>
									</div>
									{facts.facts.recent.length > 0 && (
										<table className="setup-forks">
											<tbody>
												{facts.facts.recent.map((f) => (
													<tr key={`${f.owner}/${f.name}`}>
														<td>
															{f.owner}/{f.name}
														</td>
														<td>
															{pushedAge(f.pushedAt, Date.now())} since last
															push
														</td>
													</tr>
												))}
											</tbody>
										</table>
									)}
								</>
							)}
						</section>
					)}
					<section className="setup-sec">
						<label className="add-check">
							<input
								type="checkbox"
								checked={view.settings.holdUpdateMerges}
								onChange={(e) => {
									void patch({ holdUpdateMerges: e.target.checked });
								}}
							/>
							Hold merges of update cards until you approve
							<span className="hint">
								Update cards wait at needs_you after a ready turn; your reply
								approves the merge.
							</span>
						</label>
						<label className="add-check">
							<input
								type="checkbox"
								checked={view.settings.forkMergeHold}
								onChange={(e) => {
									void patch({ forkMergeHold: e.target.checked });
								}}
							/>
							Hold merges of fork-born cards until you approve
							<span className="hint">
								Fork-born cards wait at needs_you after a ready turn; your reply
								approves the merge of the card's work.
							</span>
						</label>
					</section>
				</>
			)}
			{step === 4 && (
				<section className="setup-sec">
					<h3>Runners</h3>
					<label className="settings-field">
						Runner cap
						<span className="hint">empty = no cap</span>
						<input
							type="number"
							min={1}
							max={8}
							value={mp}
							onChange={(e) => setMp(e.target.value)}
						/>
					</label>
					<label className="settings-field">
						Extra paths
						<span className="hint">
							copied into new worktrees, one per line
						</span>
						<textarea
							rows={3}
							value={extra}
							onChange={(e) => setExtra(e.target.value)}
							placeholder="scripts/release.mjs"
						/>
					</label>
				</section>
			)}
			<div className="dialog-actions setup-actions">
				<BusyButton
					className="ghost"
					run={async () => {
						const ok = await patch({ setupChecklist: true });
						if (ok) onClose();
						return ok;
					}}
				>
					Finish later
				</BusyButton>
				{step > 2 && (
					<button type="button" onClick={() => setStep(step - 1)}>
						Back
					</button>
				)}
				{step < 4 ? (
					<button type="button" className="primary" onClick={next}>
						Next
					</button>
				) : (
					<BusyButton
						className="primary"
						run={async () => {
							const parallel =
								mp.trim() === ""
									? null
									: clamp(Math.trunc(Number(mp)) || 1, 1, 8);
							const paths = extra
								.split("\n")
								.map((s) => s.trim())
								.filter((s) => s.length > 0);
							const ok = await patch({
								maxParallel: parallel,
								copyExtra: paths,
								setupChecklist: false,
							});
							if (ok) onClose();
							return ok;
						}}
					>
						Done
					</BusyButton>
				)}
			</div>
		</>
	);
}

/** The wizard as its own dialog: Open setup, from the settings page or the checklist. */
export function SetupWizardModal({
	project,
	act,
	onNotice,
	rulesTask,
	openTask,
	onClose,
}: {
	project: ProjectView;
	act: Act;
	onNotice?: (message: string) => void;
	/** The live rules interview card's id, or null: a live card turns "Discuss rules" into "Open rules task". */
	rulesTask?: string | null;
	openTask?: (id: string) => void;
	onClose: () => void;
}) {
	return (
		<Modal open onClose={onClose} label="Project setup" className="dialog">
			<div className="dialog-body">
				<div className="dialog-head">
					<h2>Set up {projectLabel(project)}</h2>
					<CloseButton />
				</div>
				<ProjectSetupSteps
					project={project}
					act={act}
					onNotice={onNotice}
					rulesTask={rulesTask}
					openTask={openTask}
					onClose={onClose}
				/>
			</div>
		</Modal>
	);
}

/** A card's one Save: a native submit of the card's form (so required and min/max checks run
 *  first), live only while that form has unsaved changes; it shows "Saved" for a moment after. */
function SaveButton({
	form,
	s,
	dirty,
}: {
	form: string;
	s: InstantSave;
	dirty: boolean;
}) {
	return (
		<button
			type="submit"
			form={form}
			className={`settings-save${s.failed ? " failed" : ""}`}
			disabled={s.busy || !dirty}
			aria-busy={s.busy || undefined}
		>
			{s.busy && <span className="spinner" aria-hidden="true" />}
			<SaveLabel saved={s.saved} />
		</button>
	);
}

function TotalRunnersForm({
	maxTotal,
	reviewCheck,
	workCheck,
	idleReviews,
	trendingScan,
	trendingStatus,
	allocated,
	act,
}: {
	maxTotal: number | null;
	reviewCheck: boolean;
	workCheck: boolean;
	idleReviews: boolean;
	trendingScan: boolean;
	trendingStatus: TrendingStatus;
	allocated: number;
	act: Act;
}) {
	const [n, setN] = useState(maxTotal === null ? "" : String(maxTotal));
	const s = useInstantSave(act);
	const formId = useId();
	const next =
		n.trim() === "" ? null : clamp(Math.trunc(Number(n)), 1, Infinity);
	// The cap counts as edited only when the input moved off the server value: an
	// untouched input must not save its clamped form (a server cap below 1, e.g.
	// OMP_TRACKER_MAX_TOTAL=0, would otherwise jump to 1). An empty input means "no cap".
	const capEdited = n !== (maxTotal === null ? "" : String(maxTotal));
	const dirty = capEdited && next !== maxTotal;
	const send = (body: Record<string, unknown>): Promise<unknown> =>
		post("/api/settings", body);
	// Scan trending now: the reply lands inline, the server's error text as is.
	const [scanResult, setScanResult] = useState<
		{ ok: true } | { ok: false; error: string } | null
	>(null);
	const scanNow = async (): Promise<boolean> => {
		setScanResult(null);
		try {
			await post("/api/trending/scan", {});
			setScanResult({ ok: true });
			return true;
		} catch (err) {
			setScanResult({
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			});
			return false;
		}
	};
	const lastScan =
		trendingStatus.lastError !== null
			? `Last trending scan failed: ${trendingStatus.lastError.reason} (${stamp(trendingStatus.lastError.at)})`
			: trendingStatus.lastRunAt !== null
				? `Last scan: ${stamp(trendingStatus.lastRunAt)}`
				: "No scan yet";
	return (
		<SettingsCard
			id="runners-section"
			title="Runners"
			status={
				maxTotal === null
					? { label: "No cap", tone: "off" }
					: { label: `Cap ${maxTotal}`, tone: "ok" }
			}
			hint={
				maxTotal === null
					? "No cap: agents start whenever projects need them."
					: `At most ${maxTotal} agents run at once across all projects; configured slots beyond the cap wait.`
			}
		>
			<form
				id={formId}
				className="alate-def-rows"
				onSubmit={(e) => {
					e.preventDefault();
					if (dirty) s.run(() => send({ maxTotal: next }));
				}}
			>
				<div className="alate-def-row">
					<div className="alate-def-name">
						<b>
							Runner cap
							<Help
								label="Runner cap"
								text="The most agent turns that run at the same time on this board. Other tasks wait in Todo until a slot is free. Each project can also set its own cap."
							/>
						</b>
						<code>empty = no cap</code>
					</div>
					<div className="alate-def-actions">
						<label>
							<input
								type="number"
								min={1}
								value={n}
								onChange={(e) => setN(e.target.value)}
								aria-label="Runner cap across all projects (empty = no cap)"
							/>
						</label>
						<SaveButton form={formId} s={s} dirty={dirty} />
					</div>
				</div>
				<CheckRow
					name="Review check"
					desc="Check a review's findings with a second model before they become cards"
					checked={reviewCheck}
					save={(v) => send({ reviewCheck: v })}
					act={act}
				/>
				<CheckRow
					name="Work check"
					desc="Check a work card with a second model before it enters the merge queue"
					checked={workCheck}
					save={(v) => send({ workCheck: v })}
					act={act}
				/>
				<CheckRow
					name="Run due reviews while idle"
					desc="After two hours without input, and while no turn runs, the board files the architecture review card of the first project whose review is due, by itself"
					checked={idleReviews}
					save={(v) => send({ idleReviews: v })}
					act={act}
				/>
				<CheckRow
					name="Weekly trending scan"
					desc="Every Monday at 06:00 (server time), scan GitHub trending and file up to 3 backlog proposals per project with Trending scout on"
					checked={trendingScan}
					save={(v) => send({ trendingScan: v })}
					act={act}
				/>
				<div className="alate-def-row">
					<div className="alate-def-name">
						<b>Trending scan</b>
						<span>{lastScan}</span>
						{trendingStatus.running && <span>A scan is running.</span>}
						<span role="status">
							{scanResult?.ok === true ? "Scan started" : ""}
						</span>
					</div>
					<div className="alate-def-actions">
						<BusyButton run={scanNow} disabled={trendingStatus.running}>
							Scan trending now
						</BusyButton>
					</div>
				</div>
			</form>
			{scanResult?.ok === false && (
				<p className="auth-error" role="alert">
					{scanResult.error}
				</p>
			)}
			{/* ponytail: configured slots is informational, so the meter stays grey even when over cap — the cap binds, it is not an alarm */}
			<Meter
				label="Configured"
				pct={
					maxTotal === null || maxTotal === 0
						? null
						: Math.min(100, (allocated / maxTotal) * 100)
				}
				value={`${maxTotal === null ? "no cap" : `cap ${maxTotal}`} · ${allocated} configured`}
				band={false}
			/>
		</SettingsCard>
	);
}

/** The class switches of THIS device, in display order. */
const CLASS_ROWS: readonly { cls: AlertClass; name: string; desc: string }[] = [
	{
		cls: "request",
		name: "Request",
		desc: "A task needs you or asks a question",
	},
	{ cls: "error", name: "Error", desc: "A turn failed" },
	{ cls: "complete", name: "Complete", desc: "A task finished or answered" },
];

/** Settings "Notifications" section: Web Push opt-in for this device, which alert classes it
 *  gets, per-project mutes (shared by every device), plus a test. */
export function NotificationsSection({
	projects,
	act,
}: {
	projects: ProjectView[];
	act: Act;
}) {
	// Web Push needs a secure context, a service worker and PushManager; without them the
	// section explains why and disables every control (the in-app bell still works).
	// typeof guard: settings render server-side in tests, where window is absent.
	const supported =
		typeof window !== "undefined" &&
		window.isSecureContext &&
		"serviceWorker" in navigator &&
		"PushManager" in window;
	const [enabled, setEnabled] = useState(false);
	// The endpoint keys this device's class switches on the server; null while unsubscribed.
	const [endpoint, setEndpoint] = useState<string | null>(null);
	const [classes, setClasses] = useState<ClassPrefs | null>(null);
	const [muted, setMuted] = useState<string[]>([]);
	// "Test sent" is a short confirmation; the button reads "Send test" again after it.
	const [sent, flashSent] = useFlash(2000);
	const [error, setError] = useState<string | null>(null);
	const busy = useBusy();
	// Real state, not last-click: the flag reflects whether this device holds a subscription.
	useEffect(() => {
		if (!supported) return;
		void navigator.serviceWorker
			.getRegistration()
			.then((reg) => reg?.pushManager.getSubscription())
			.then((sub) => {
				setEnabled(sub != null);
				setEndpoint(sub?.endpoint ?? null);
			})
			.catch(() => {});
	}, [supported]);
	// Prefs follow the endpoint: without one only the shared mutes load.
	useEffect(() => {
		const q =
			endpoint === null ? "" : `?endpoint=${encodeURIComponent(endpoint)}`;
		let live = true;
		void fetch(`/api/notifications/prefs${q}`)
			.then((res) =>
				unwrap<{ classes: ClassPrefs | null; mutedProjects: string[] }>(res),
			)
			.then((p) => {
				if (!live) return;
				classesRef.current = p.classes;
				mutedRef.current = p.mutedProjects;
				savedClassesRef.current = p.classes;
				savedMutedRef.current = p.mutedProjects;
				setClasses(p.classes);
				setMuted(p.mutedProjects);
			})
			.catch((err) => {
				if (live) setError(err instanceof Error ? err.message : String(err));
			});
		return () => {
			live = false;
		};
	}, [endpoint]);
	const enable = (): void =>
		busy.start(async () => {
			setError(null);
			try {
				if ((await Notification.requestPermission()) !== "granted")
					throw new Error("Notification permission was denied.");
				await navigator.serviceWorker.register("/sw.js");
				// ready waits for the worker to be ACTIVE: subscribing on an installing
				// worker rejects with InvalidStateError on a first-run device.
				const reg = await navigator.serviceWorker.ready;
				const { publicKey } = await unwrap<{ publicKey: string }>(
					await fetch("/api/push/config"),
				);
				// The spec takes the key as a string; the old hand-decode duplicated it.
				const sub = await reg.pushManager.subscribe({
					userVisibleOnly: true,
					applicationServerKey: publicKey,
				});
				await post("/api/push/subscribe", sub.toJSON());
				setEnabled(true);
				setEndpoint(sub.endpoint);
				return true;
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				return false;
			}
		});
	// Turn off: the server drops this device first, so a failed call leaves push fully on;
	// then the browser's own subscription goes.
	const disable = (): void =>
		busy.start(async () => {
			setError(null);
			try {
				const reg = await navigator.serviceWorker?.getRegistration();
				const sub = await reg?.pushManager.getSubscription();
				if (sub != null) {
					await post("/api/push/unsubscribe", { endpoint: sub.endpoint });
					await sub.unsubscribe();
				}
				setEnabled(false);
				setEndpoint(null);
				setClasses(null);
				return true;
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				return false;
			}
		});
	const test = (): void =>
		busy.start(async () => {
			setError(null);
			try {
				await post("/api/push/test", {});
				flashSent();
				return true;
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				return false;
			}
		});
	// The spinner goes on the button that was pressed; off, only Turn on acts.
	const [doing, setDoing] = useState<"on" | "off" | "test" | null>(null);
	const run = (k: "on" | "off" | "test", fn: () => void) => (): void => {
		setDoing(k);
		fn();
	};
	const spin = (k: "on" | "off" | "test", icon: IconName) =>
		busy.busy && doing === k ? (
			<span className="spinner" aria-hidden="true" />
		) : (
			<Icon name={icon} />
		);
	// Saves run one at a time and each sends the latest wanted set, so two switches flipped
	// before the first answer both land: the second POST carries the first change too. A
	// failed save falls back to the last set the server confirmed (a load or a successful
	// POST), never to an assumed inverse: an earlier POST may already hold the change.
	const classesRef = useRef<ClassPrefs | null>(null);
	const mutedRef = useRef<string[]>([]);
	const savedClassesRef = useRef<ClassPrefs | null>(null);
	const savedMutedRef = useRef<string[]>([]);
	const queue = useRef<Promise<unknown>>(Promise.resolve());
	const serial = (fn: () => Promise<unknown>): Promise<unknown> => {
		const p = queue.current.then(fn, fn);
		queue.current = p.catch(() => {});
		return p;
	};
	const saveClass = async (cls: AlertClass, v: boolean): Promise<void> => {
		const current = classesRef.current;
		if (endpoint === null || current === null) return;
		classesRef.current = { ...current, [cls]: v };
		setClasses(classesRef.current);
		try {
			await serial(async () => {
				const sent = classesRef.current;
				await post("/api/notifications/prefs", { endpoint, classes: sent });
				savedClassesRef.current = sent;
			});
		} catch (err) {
			classesRef.current = savedClassesRef.current;
			setClasses(classesRef.current);
			throw err;
		}
	};
	const saveMute = async (name: string, v: boolean): Promise<void> => {
		mutedRef.current = v
			? [...mutedRef.current.filter((m) => m !== name), name]
			: mutedRef.current.filter((m) => m !== name);
		setMuted(mutedRef.current);
		try {
			await serial(async () => {
				const sent = mutedRef.current;
				await post("/api/notifications/prefs", { mutedProjects: sent });
				savedMutedRef.current = sent;
			});
		} catch (err) {
			mutedRef.current = savedMutedRef.current;
			setMuted(mutedRef.current);
			throw err;
		}
	};
	return (
		<SettingsCard
			id="notifications-section"
			title="Notifications"
			status={
				enabled
					? { label: "On", tone: "ok", icon: "bell" }
					: { label: "Off", tone: "off", icon: "bell-off" }
			}
			hint="A notification on this device when a task needs you, fails or finishes, also while the app is closed. Push pauses while a board tab is focused."
			footer={
				<>
					<button
						type="button"
						className="ghost"
						onClick={run("test", test)}
						disabled={!supported || busy.busy || !enabled}
						title={enabled ? undefined : "Turn on notifications first"}
					>
						{spin("test", sent ? "check" : "send")}
						{sent ? "Test sent" : "Send test"}
					</button>
					{enabled ? (
						<button
							type="button"
							onClick={run("off", disable)}
							disabled={!supported || busy.busy}
						>
							{spin("off", "bell-off")}
							Turn off
						</button>
					) : (
						<button
							type="button"
							className="primary"
							onClick={run("on", enable)}
							disabled={!supported || busy.busy}
						>
							{spin("on", "bell")}
							Turn on
						</button>
					)}
				</>
			}
		>
			{!supported && (
				<p className="notify-hint">
					OS notifications need HTTPS, for example tailscale serve. The bell
					still works.
				</p>
			)}
			{enabled && classes !== null && (
				<fieldset className="notify-group">
					<legend>This device</legend>
					{CLASS_ROWS.map((r) => (
						<CheckRow
							key={r.cls}
							name={r.name}
							desc={r.desc}
							checked={classes[r.cls]}
							disabled={!supported}
							save={(v) => saveClass(r.cls, v)}
							act={act}
						/>
					))}
				</fieldset>
			)}
			{projects.length > 0 && (
				<fieldset className="notify-group">
					<legend>Muted projects</legend>
					{projects.map((p) => (
						<CheckRow
							key={p.name}
							name={`Mute ${projectLabel(p)}`}
							desc="No push from this project; the bell still shows it"
							checked={muted.includes(p.name)}
							disabled={!supported}
							save={(v) => saveMute(p.name, v)}
							act={act}
						/>
					))}
				</fieldset>
			)}
			{error !== null && (
				<p className="auth-error" role="alert">
					{error}
				</p>
			)}
		</SettingsCard>
	);
}

/** Compact count: 12.3k / 2.1M; whole numbers stay whole. */
export const fmtCount = (n: number): string => {
	if (n < 10_000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
};

/** USD cost, always two decimals (omp's own precision). */
export const fmtCost = (usd: number): string => `$${usd.toFixed(2)}`;

/** One-decimal percent of a 0..1 rate; an em dash when omp has no basis for it. */
export const fmtPct = (rate: number | null): string =>
	rate === null ? "—" : `${(rate * 100).toFixed(1)}%`;

/** Where the omp stats dashboard link points: a loopback board gets the proxy URL;
 *  any other host gets a caption, because the proxy listens on loopback only. */
export function dashboardLink(
	hostname: string,
	info: OmpStatsDashboardInfo,
): { href: string } | { caption: string } {
	if (info.port === null)
		return { caption: `The omp stats dashboard is off: ${info.error}` };
	if (hostname !== "localhost" && hostname !== "127.0.0.1")
		return {
			caption:
				"The omp stats dashboard opens only from the board on localhost.",
		};
	return { href: `http://${hostname}:${info.port}/` };
}

/** Settings -> omp usage: turn usage summed from the board's session transcripts,
 *  fetched when the Settings page opens, plus a link to omp's own stats dashboard
 *  (started on demand behind a board proxy). The two fetches fail independently. */
export function OmpStatsSection() {
	const [report, setReport] = useState<OmpStatsReport | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);
	const [info, setInfo] = useState<OmpStatsDashboardInfo | null>(null);
	const [infoFailed, setInfoFailed] = useState(false);
	const load = useCallback(async (): Promise<void> => {
		const r = await unwrap<OmpStatsReport>(
			await fetch("/api/settings/omp-stats"),
		);
		setLoadFailed(false);
		setReport(r);
	}, []);
	useEffect(() => {
		load().catch(() => setLoadFailed(true));
	}, [load]);
	useEffect(() => {
		(async () =>
			setInfo(
				await unwrap<OmpStatsDashboardInfo>(
					await fetch("/api/settings/omp-stats/dashboard"),
				),
			))().catch(() => setInfoFailed(true));
	}, []);
	const link = info === null ? null : dashboardLink(location.hostname, info);
	return (
		<SettingsCard
			id="omp-stats-section"
			title="omp usage"
			hint="Turn usage summed from the session transcripts this board can read: each project's sessions dir, plus the board's and the workers' default omp stores, fetched when this page opens. omp's own stats command misses tracker turns (they run with --session-dir), so the board sums the usage records itself. A store that answers an error still lists below with its error."
		>
			{infoFailed ? (
				<p className="caption">
					The omp stats dashboard link could not be loaded.
				</p>
			) : link === null ? null : "href" in link ? (
				<div>
					<a href={link.href} target="_blank" rel="noopener noreferrer">
						Launch omp stats dashboard
					</a>
					<p className="caption">
						omp's own dashboard with charts and session traces. The board starts
						it on demand and stops it after 30 minutes without use.
					</p>
				</div>
			) : (
				<p className="caption">{link.caption}</p>
			)}
			{loadFailed ? (
				<p className="hint" role="alert">
					omp usage could not be loaded.
				</p>
			) : report === null ? (
				<Skeleton shape="stats" rows={3} label="Loading omp usage" />
			) : (
				<>
					<div className="setup-facts">
						<div>
							<b>{fmtCount(report.overall.totalRequests)}</b>
							<span>requests</span>
						</div>
						<div>
							<b>{fmtCount(report.overall.failedRequests)}</b>
							<span>failed</span>
						</div>
						<div>
							<b>{fmtCount(report.overall.totalInputTokens)}</b>
							<span>tokens in</span>
						</div>
						<div>
							<b>{fmtCount(report.overall.totalOutputTokens)}</b>
							<span>tokens out</span>
						</div>
						<div>
							<b>
								{fmtCount(
									report.overall.totalCacheReadTokens +
										report.overall.totalCacheWriteTokens,
								)}
							</b>
							<span>cached ({fmtPct(report.overall.cacheRate)})</span>
						</div>
						<div>
							<b>{fmtCost(report.overall.totalCost)}</b>
							<span>cost</span>
						</div>
					</div>
					<table className="ov">
						<thead>
							<tr>
								<th scope="col">Store</th>
								<th scope="col">Requests</th>
								<th scope="col">Tokens in / out</th>
								<th scope="col">Cost</th>
								<th scope="col">Status</th>
							</tr>
						</thead>
						<tbody>
							{report.sources.map((s) => (
								<tr key={s.name}>
									<th scope="row">{s.name}</th>
									<td>
										{s.answer.stats === null
											? "—"
											: fmtCount(s.answer.stats.overall.totalRequests)}
									</td>
									<td>
										{s.answer.stats === null
											? "—"
											: `${fmtCount(s.answer.stats.overall.totalInputTokens)} / ${fmtCount(s.answer.stats.overall.totalOutputTokens)}`}
									</td>
									<td>
										{s.answer.stats === null
											? "—"
											: fmtCost(s.answer.stats.overall.totalCost)}
									</td>
									<td>{s.answer.error ?? "ok"}</td>
								</tr>
							))}
						</tbody>
					</table>
					<table className="ov">
						<thead>
							<tr>
								<th scope="col">Model</th>
								<th scope="col">Requests</th>
								<th scope="col">Tokens in / out</th>
								<th scope="col">Cost</th>
							</tr>
						</thead>
						<tbody>
							{report.byModel.map((m) => (
								<tr key={m.model}>
									<th scope="row">{m.model}</th>
									<td>{fmtCount(m.totalRequests)}</td>
									<td>
										{`${fmtCount(m.totalInputTokens)} / ${fmtCount(m.totalOutputTokens)}`}
									</td>
									<td>{fmtCost(m.totalCost)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</>
			)}
		</SettingsCard>
	);
}

/** Settings "API key" section: reveal/copy/regenerate icons; logout lives in the top bar. */
function ApiKeySection() {
	const [key, setKey] = useState<string | null>(null);
	const [reveal, setReveal] = useState(false);
	const [copied, flashCopied] = useFlash(1500);
	// Failures were swallowed: a rotated key left the old one on screen with no message.
	const [error, setError] = useState<string | null>(null);
	const busy = useBusy();
	const load = (): void => {
		if (busy.busy) return;
		setError(null);
		if (key !== null) {
			setReveal(!reveal);
			return;
		}
		setReveal(true);
		busy.start(async () => {
			try {
				const res = await fetch("/api/settings/api-key");
				setKey((await unwrap<{ apiKey: string }>(res)).apiKey);
				return true;
			} catch (err) {
				setReveal(false);
				setError(err instanceof Error ? err.message : String(err));
				return false;
			}
		});
	};
	const copy = (): void => {
		if (busy.busy) return;
		setError(null);
		if (key !== null) {
			copyText(key).then(flashCopied, (err) =>
				setError(err instanceof Error ? err.message : String(err)),
			);
			return;
		}
		// Always available: fetch the key straight into the clipboard, never rendered.
		busy.start(async () => {
			try {
				const k = (
					await unwrap<{ apiKey: string }>(await fetch("/api/settings/api-key"))
				).apiKey;
				setKey(k);
				await copyText(k);
				flashCopied();
				return true;
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				return false;
			}
		});
	};
	const regenerate = async (): Promise<void> => {
		if (
			!(await confirmDialog(
				"Regenerate the API key? Integrations using the old key stop working.",
				{ ok: "Regenerate", danger: true },
			))
		)
			return;
		setError(null);
		busy.start(async () => {
			try {
				setKey(
					(await post<{ apiKey: string }>("/api/settings/api-key", {})).apiKey,
				);
				setReveal(true);
				return true;
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				return false;
			}
		});
	};
	return (
		<SettingsCard
			id="api-key-section"
			title="API key"
			hint="A public host or a board in Docker needs this API key or your login session. Direct local access needs neither."
		>
			<div className="access-row">
				<div className="access-key">
					<code>{reveal && key !== null ? key : "••••••••••••"}</code>
					<button
						type="button"
						className="icon"
						aria-pressed={reveal}
						aria-label={reveal ? "Hide API key" : "Reveal API key"}
						title={reveal ? "Hide API key" : "Reveal API key"}
						onClick={load}
						disabled={busy.busy}
					>
						{busy.busy && key === null ? (
							<span className="spinner" aria-hidden="true" />
						) : (
							<Icon name={reveal ? "eye-off" : "eye"} />
						)}
					</button>
				</div>
				<button
					type="button"
					className="icon"
					aria-label={copied ? "Copied" : "Copy API key"}
					title={copied ? "Copied" : "Copy API key"}
					onClick={copy}
				>
					<Icon name={copied ? "check" : "copy"} />
				</button>
				<button
					type="button"
					className="icon danger"
					aria-label="Regenerate API key"
					title="Regenerate API key"
					onClick={regenerate}
					disabled={busy.busy}
				>
					{busy.busy ? (
						<span className="spinner" aria-hidden="true" />
					) : (
						<Icon name="refresh-cw" />
					)}
				</button>
			</div>
			{error !== null && (
				<p className="auth-error" role="alert">
					{error}
				</p>
			)}
		</SettingsCard>
	);
}

/** Board group, "Projects" card: drag a row (or press Alt+Arrow on it) to reorder the
 *  projects on the board and in this page. The full order saves to /api/projects/order at
 *  once; a failed save rolls the optimistic order back. Drag state follows the board's
 *  queue: the same slot semantics, and both drag states clear before the save runs (bug
 *  1d1afc9: a sync re-render detaches onDragEnd, so a stale drop would repaint the slot). */
export function ProjectsOrderSection({
	projects,
	act,
}: {
	projects: ProjectView[];
	act: Act;
}) {
	const s = useInstantSave(act);
	// Optimistic saved order: null trusts the props order; cleared once props catch up.
	const [localOrder, setLocalOrder] = useState<string[] | null>(null);
	const [dragId, setDragId] = useState<string | null>(null);
	// undefined = no slot, null = end, string = insert before that project.
	const [drop, setDrop] = useState<string | null | undefined>(undefined);
	const listRef = useRef<HTMLUListElement | null>(null);

	const names = projects.map((p) => p.name);
	const byName = new Map(projects.map((p) => [p.name, p]));
	// The list the user sees: props order, with the optimistic order applied on top.
	const view = orderBy(names, localOrder ?? []);
	useEffect(() => {
		if (
			localOrder !== null &&
			names.length === localOrder.length &&
			names.every((name, i) => name === localOrder[i])
		)
			setLocalOrder(null);
	}, [localOrder, names]);

	const busy = s.busy;
	const clear = (): void => {
		setDragId(null);
		setDrop(undefined);
	};
	// Live row midpoints during the drag; dropBeforeId gives the slot under the pointer.
	const slotAt = (y: number): string | null | undefined => {
		const box = listRef.current;
		if (box === null || dragId === null) return undefined;
		const rows = Array.from(
			box.querySelectorAll<HTMLElement>("li[data-name]"),
			(el) => {
				const rect = el.getBoundingClientRect();
				return {
					id: el.dataset.name as string,
					middle: (rect.top + rect.bottom) / 2,
				};
			},
		);
		return dropBeforeId(rows, dragId, y);
	};
	// The full order with `id` moved to the `before` slot (null = the end).
	const moved = (id: string, before: string | null): string[] => {
		const rest = view.filter((name) => name !== id);
		const at = before === null ? rest.length : rest.indexOf(before);
		if (at < 0) return view;
		return [...rest.slice(0, at), id, ...rest.slice(at)];
	};
	// No change, no request: the drop that lands back at the old place saves nothing.
	const save = (next: string[]): void => {
		if (next.every((name, i) => name === view[i])) return;
		setLocalOrder(next);
		s.run(
			() => post("/api/projects/order", { order: next }),
			() => setLocalOrder(null),
		);
	};
	return (
		<SettingsCard
			id="projects-section"
			title="Projects"
			hint="Drag a project to move it. The new order saves at once."
			// The footer draws a border, so it only renders while it has a tick to show.
			footer={
				busy || s.saved || s.failed ? (
					<SaveTick busy={busy} saved={s.saved} failed={s.failed} />
				) : undefined
			}
		>
			<ul
				className="projects-order"
				ref={listRef}
				onDragOver={
					dragId !== null
						? (e) => {
								e.preventDefault();
								e.dataTransfer.dropEffect = "move";
								setDrop(slotAt(e.clientY));
							}
						: undefined
				}
				onDrop={
					dragId !== null
						? (e) => {
								e.preventDefault();
								const before = slotAt(e.clientY);
								// Clear both drag states before the save runs: the optimistic
								// reorder re-renders before the browser dispatches dragend, which
								// detaches the row's handler, so a stale drop would repaint the
								// slot after the order confirms.
								clear();
								if (before !== undefined) save(moved(dragId, before));
							}
						: undefined
				}
				onDragLeave={
					dragId !== null
						? (e) => {
								const rect = e.currentTarget.getBoundingClientRect();
								if (
									e.clientX < rect.left ||
									e.clientX > rect.right ||
									e.clientY < rect.top ||
									e.clientY > rect.bottom
								)
									setDrop(undefined);
							}
						: undefined
				}
				// Keyboard reorder: Alt+Arrow moves the focused row; blocked while a save runs.
				onKeyDown={
					busy
						? undefined
						: (e) => {
								if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown"))
									return;
								const id = (e.target as HTMLElement).closest<HTMLElement>(
									"[data-name]",
								)?.dataset.name;
								if (id === undefined) return;
								const i = view.indexOf(id);
								if (i < 0) return;
								if (e.key === "ArrowUp" && i > 0) {
									e.preventDefault();
									save(moved(id, view[i - 1]!));
								} else if (e.key === "ArrowDown" && i < view.length - 1) {
									e.preventDefault();
									save(moved(id, i + 2 < view.length ? view[i + 2]! : null));
								}
							}
				}
			>
				{view.map((name, i) => {
					const p = byName.get(name);
					if (p === undefined) return null;
					return (
						<li
							key={name}
							data-name={name}
							draggable={!busy}
							className={
								dragId === name
									? "dragging"
									: drop === name
										? "drop-before"
										: undefined
							}
							aria-label={`${projectLabel(p)}, position ${i + 1} of ${view.length}`}
							onDragStart={(e) => {
								// Firefox refuses to start a drag with an empty dataTransfer.
								e.dataTransfer.setData("text/plain", name);
								e.dataTransfer.effectAllowed = "move";
								// Dim the row only after the browser has captured it as the drag image.
								requestAnimationFrame(() => setDragId(name));
							}}
							onDragEnd={clear}
						>
							<ProjectTag project={p} />
							<span className="projects-order-name">{projectLabel(p)}</span>
							{/* The keyboard path: focus the handle, then Alt plus an arrow key moves the row. */}
							<button
								type="button"
								className="icon projects-order-handle"
								aria-label={`Reorder ${projectLabel(p)}: hold Alt and press ArrowUp or ArrowDown`}
								title="Hold Alt and press ArrowUp or ArrowDown"
							>
								<Icon name="grip-vertical" />
							</button>
						</li>
					);
				})}
			</ul>
		</SettingsCard>
	);
}

/** One listed login session, as the server returns it. */
type SessionEntry = {
	id: string;
	label: string;
	createdAt: number;
	lastSeen: number;
	current: boolean;
};

/** Settings "Session" section: the list of logins, per-row logout, and the footer's
 *  "Sign out everywhere", which rotates the session secret and revokes all. */
export function SessionSection() {
	const busy = useBusy();
	const revokeBusy = useBusy();
	const [sessions, setSessions] = useState<SessionEntry[] | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);
	// Which row's logout call is in flight, for that row's spinner.
	const [revokingId, setRevokingId] = useState<string | null>(null);
	const load = useCallback(async (): Promise<void> => {
		const { sessions: list } = await unwrap<{
			sessions: SessionEntry[];
		}>(await fetch("/api/settings/sessions"));
		setLoadFailed(false);
		setSessions(list);
	}, []);
	useEffect(() => {
		load().catch(() => setLoadFailed(true));
	}, [load]);
	const revoke = async (entry: SessionEntry): Promise<void> => {
		if (
			!(await confirmDialog(`Sign out ${entry.label}?`, {
				ok: "Sign out",
				danger: true,
			}))
		)
			return;
		setRevokingId(entry.id);
		revokeBusy.start(async () => {
			try {
				await unwrap(
					await fetch(
						`/api/settings/sessions/${encodeURIComponent(entry.id)}`,
						{ method: "DELETE" },
					),
				);
				// Revoking this browser's own session kills its cookie: land on the login gate.
				if (entry.current) await logOut();
				else await load();
				return true;
			} catch {
				return false;
			} finally {
				setRevokingId(null);
			}
		});
	};
	const logOutAll = async (): Promise<void> => {
		if (
			!(await confirmDialog(
				"Sign out everywhere? Every browser, including this one, must sign in again.",
				{ ok: "Sign out everywhere", danger: true },
			))
		)
			return;
		busy.start(async () => {
			try {
				await post("/api/settings/session-secret", {});
				// This browser's cookie just died with the old secret: land on the login gate.
				await logOut();
			} catch {
				return false;
			}
			return true;
		});
	};
	return (
		<SettingsCard
			id="session-section"
			title="Session"
			hint="Sign out in the account menu signs out only this browser. If a device is lost or a cookie escaped, sign out everywhere: every login session is revoked."
			footer={
				<button
					type="button"
					className="danger"
					onClick={logOutAll}
					disabled={busy.busy}
					aria-busy={busy.busy || undefined}
				>
					{busy.busy ? (
						<span className="spinner" aria-hidden="true" />
					) : (
						<Icon name="log-out" />
					)}
					Sign out everywhere
				</button>
			}
		>
			{loadFailed ? (
				<p className="session-failed">Sessions could not be loaded.</p>
			) : sessions === null ? (
				<Skeleton shape="list" rows={3} label="Loading the sessions" />
			) : (
				<div className="session-rows">
					{sessions.map((entry) => (
						<div key={entry.id} className="access-row session-row">
							<div className="session-info">
								<div className="session-label">
									{entry.label}
									{entry.current && (
										<span className="session-current">This browser</span>
									)}
								</div>
								<div className="session-times">
									{`Last seen ${age(entry.lastSeen)} · Signed in ${age(entry.createdAt)}`}
								</div>
							</div>
							<button
								type="button"
								className="icon danger"
								aria-label={`Sign out ${entry.label}`}
								title={`Sign out ${entry.label}`}
								onClick={() => void revoke(entry)}
								disabled={revokeBusy.busy}
							>
								{revokingId === entry.id ? (
									<span className="spinner" aria-hidden="true" />
								) : (
									<Icon name="log-out" />
								)}
							</button>
						</div>
					))}
				</div>
			)}
		</SettingsCard>
	);
}

/** Shared expiry line: whole UTC days left, or "No expiry" when the date is unknown. */
export function expiryLine(expiresAt: string | null): string | null {
	if (expiresAt === null) return "No expiry";
	const d = new Date(expiresAt);
	if (Number.isNaN(d.getTime())) return null;
	const utcMidnight = (t: number): number => {
		const x = new Date(t);
		return Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate());
	};
	const n = Math.floor(
		(utcMidnight(d.getTime()) - utcMidnight(Date.now())) / 86_400_000,
	);
	return `Expires on ${d.toISOString().slice(0, 10)} (in ${n} days)`;
}

/** Shared write-only secret form: loads whether it is set, saves a pasted value, flashes "Saved". */
function SecretTokenForm<T extends { tokenSet: boolean }>({
	endpoint,
	title,
	help,
	label,
	captionSet,
	captionUnset,
	captionUnknown,
	expiry,
	onLoaded,
}: {
	endpoint: string;
	/** Row name shown above the field. */
	title: string;
	/** Short "?" explanation beside the row name. */
	help?: string;
	/** Accessible name of the password input (may add the section, e.g. "Hindsight API key"). */
	label: string;
	captionSet: string;
	captionUnset: string;
	/** Shown while the check is pending or failed: never claim "Not set" then. */
	captionUnknown: string;
	/** Optional expiry line from the loaded/saved view; a string renders as plain text. */
	expiry?: (cfg: T) => string | null;
	/** Observes the loaded/saved view; pass a stable callback (a setState works). */
	onLoaded?: (data: T) => void;
}) {
	// null until the load answers: a failed check must not claim "Not set".
	const [tokenSet, setTokenSet] = useState<boolean | null>(null);
	const [expiryText, setExpiryText] = useState<string | null>(null);
	const [token, setToken] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [saved, flashSaved] = useFlash(1500);
	const save = useBusy();
	useEffect(() => {
		let live = true;
		fetch(endpoint)
			.then((res) => unwrap<T>(res))
			.then((cfg) => {
				if (!live) return;
				setTokenSet(cfg.tokenSet);
				setExpiryText(expiry?.(cfg) ?? null);
				onLoaded?.(cfg);
			})
			.catch((err) => {
				if (live) setError(err instanceof Error ? err.message : String(err));
			});
		return () => {
			live = false;
		};
	}, [endpoint, expiry, onLoaded]);
	const submit = (): void =>
		save.start(async () => {
			setError(null);
			try {
				const cfg = await post<T>(endpoint, { token: token.trim() });
				setTokenSet(cfg.tokenSet);
				setExpiryText(expiry?.(cfg) ?? null);
				setToken("");
				onLoaded?.(cfg);
				flashSaved();
				return true;
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				return false;
			}
		});
	return (
		<>
			<form
				className="settings-form"
				onSubmit={(e) => {
					e.preventDefault();
					submit();
				}}
			>
				<div className="alate-def-rows">
					<div className="alate-def-row">
						<div className="alate-def-name">
							<b>
								{title}
								{help !== undefined && <Help label={title} text={help} />}
							</b>
							<code>
								secret · stored, never shown
								{expiryText !== null && ` · ${expiryText}`}
							</code>
						</div>
						<div className="alate-def-actions">
							<label>
								<input
									type="password"
									value={token}
									onChange={(e) => setToken(e.target.value)}
									placeholder={
										tokenSet === true
											? captionSet
											: tokenSet === false
												? captionUnset
												: captionUnknown
									}
									autoComplete="off"
									spellCheck={false}
									aria-label={label}
									required
								/>
							</label>
							<button
								type="submit"
								disabled={save.busy}
								className={save.failed ? "failed" : undefined}
							>
								{save.busy && <span className="spinner" aria-hidden="true" />}
								<SaveLabel saved={saved} />
							</button>
						</div>
					</div>
				</div>
			</form>
			{error !== null && (
				<p className="auth-error" role="alert">
					{error}
				</p>
			)}
		</>
	);
}

// --- Git hosts: any git remote, not only GitHub. Shared types and the one trust prompt. ---

type KeyInfo = { publicKey: string; fingerprint: string };
/** The server's 409 answer: unknown host keys, shown for a confirm, written only when repeated as `trust`. */
export type TrustNeeded = {
	error: string;
	needsTrust: true;
	host: string;
	fingerprints: string[];
	changed: boolean;
};
/** A test-or-save call's answer: passed, a trust demand, or a plain error. */
export type TestAnswer = { ok: true } | TrustNeeded | { error: string };
export type PendingKeyInfo = {
	id: string;
	publicKey: string;
	fingerprint: string;
};
export type GitHostsView = {
	tokens: { host: string; username: string; tokenSet: boolean }[];
	globalKey: KeyInfo | null;
	githubApp: GitHubAppView | null;
	githubHost: string | null;
	githubTokenSet: boolean;
};

/** Fetch that keeps the status with the parsed body, so a caller can read a 409's trust data
 *  and a 400's needsToken host — which unwrap() drops when it throws. */
export async function gitReq(
	method: string,
	url: string,
	body?: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
	const res = await fetch(url, {
		method,
		headers:
			body === undefined ? undefined : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	try {
		return {
			status: res.status,
			data: (await res.json()) as Record<string, unknown>,
		};
	} catch {
		return { status: res.status, data: {} };
	}
}

export const asTrust = (d: Record<string, unknown>): TrustNeeded | null =>
	d.needsTrust === true ? (d as unknown as TrustNeeded) : null;
export const asError = (d: Record<string, unknown>, status: number): string =>
	typeof d.error === "string" ? d.error : `HTTP ${status}`;
/** One SSH test or key save as a TestAnswer: 200 passed, 409 asks to trust the host key. */
const toTestAnswer = ({
	status,
	data,
}: {
	status: number;
	data: Record<string, unknown>;
}): TestAnswer =>
	status === 200
		? { ok: true }
		: (asTrust(data) ?? { error: asError(data, status) });

/** The app's GitHub name and its installs on the board repos, from the server's last check. */
export function AppCheckLines({ check }: { check: AppCheck | null }) {
	if (check === null)
		return <p className="hint">Checking the app name and installs…</p>;
	if (check.error !== null)
		return (
			<p className="hint notif-line">
				<Mark kind="warn" />
				<span>Check failed: {check.error}.</span>
			</p>
		);
	return (
		<>
			<div className="settings-field">
				Name{" "}
				{check.url === null ? (
					<code>{check.name ?? "unknown"}</code>
				) : (
					<a href={check.url} target="_blank" rel="noopener noreferrer">
						{check.name ?? check.url}
					</a>
				)}
			</div>
			{check.missing.length === 0 && check.failed.length === 0 ? (
				<p className="hint notif-line">
					<Mark kind="done" />
					<span>
						{check.repos.length === 0
							? "No board project has a GitHub repo."
							: check.private.length === 0
								? `Installed on all ${check.repos.length} board repos.`
								: `Installed on all public board repos; ${check.private.length} private repo${check.private.length === 1 ? "" : "s"} skipped.`}
					</span>
				</p>
			) : null}
			{check.missing.length > 0 && (
				<p className="hint notif-line">
					<Mark kind="warn" />
					<span>
						Not installed on {check.missing.join(", ")}. Reviews there post
						under your own identity.
						{check.url !== null && (
							<>
								{" "}
								<a
									href={`${check.url}/installations/new`}
									target="_blank"
									rel="noopener noreferrer"
								>
									Install the app
								</a>
							</>
						)}
					</span>
				</p>
			)}
			{check.failed.length > 0 && (
				<p className="hint notif-line">
					<Mark kind="warn" />
					<span>
						Check failed for{" "}
						{check.failed.map((f) => `${f.repo} (${f.detail})`).join(", ")}.
					</span>
				</p>
			)}
		</>
	);
}

type SshTestOptions = {
	send: (trust?: string[]) => Promise<TestAnswer>;
	label?: string;
	success?: string;
	onOk?: () => void;
	/** When set, the button shows but stays disabled, with this reason as its tooltip. */
	disabledReason?: string;
};

/** The one trust+test prompt, shared by the add form, the global key and a project key.
 *  `send` performs the call (with the confirmed fingerprints as `trust` on a retry). It gives
 *  the action button and, apart from it, an aria-live result: on a 409 the host's fingerprints
 *  with a Trust-and-retry button. A changed host key takes the warning style. The parts are
 *  separate so a button can sit on a field's line while the result spans the card below. */
function useSshTest({
	send,
	label = "Test key",
	success = "Test passed",
	onOk,
	disabledReason,
}: SshTestOptions): { button: ReactNode; result: ReactNode } {
	const [busy, setBusy] = useState(false);
	const [ok, setOk] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [trust, setTrust] = useState<TrustNeeded | null>(null);
	const run = (fingerprints?: string[]): void => {
		if (busy) return;
		setBusy(true);
		setOk(false);
		setError(null);
		void send(fingerprints)
			.then((r) => {
				if ("ok" in r) {
					setTrust(null);
					setOk(true);
					onOk?.();
				} else if ("needsTrust" in r) {
					setTrust(r);
				} else {
					setTrust(null);
					setError(r.error);
				}
			})
			.finally(() => setBusy(false));
	};
	// "Test key" retries as "Trust and test key", "Save key" as "Trust and save key", "Add project" as "Trust and add project".
	const retryLabel = `Trust and ${label.toLowerCase()}`;
	const button = (
		<button
			type="button"
			disabled={busy || disabledReason !== undefined}
			title={disabledReason}
			onClick={() => run()}
		>
			{busy && <span className="spinner" aria-hidden="true" />}
			{label}
		</button>
	);
	const result = (
		<div className="ssh-test-result" aria-live="polite">
			{ok && (
				<p className="hint" role="status">
					{success}
				</p>
			)}
			{error !== null && (
				<p className="auth-error" role="alert">
					{error}
				</p>
			)}
			{trust !== null && (
				<div className={trust.changed ? "trust-warn" : undefined}>
					<p>
						{trust.changed
							? "Warning: the host key changed since the last test. "
							: ""}
						Check these fingerprints with your host admin for{" "}
						<code>{trust.host}</code>:
					</p>
					<ul>
						{trust.fingerprints.map((f) => (
							<li key={f}>
								<code>{f}</code>
							</li>
						))}
					</ul>
					<button
						type="button"
						disabled={busy}
						onClick={() => run(trust.fingerprints)}
					>
						{retryLabel}
					</button>
				</div>
			)}
		</div>
	);
	return { button, result };
}

/** The trust+test prompt as one block: the button, then its result under it. */
export function SshTestRow(props: SshTestOptions) {
	const { button, result } = useSshTest(props);
	return (
		<div className="ssh-test">
			{button}
			{result}
		</div>
	);
}

/** One pending SSH key: generated on the server, or pasted (the server rejects a
 *  passphrase-protected key). Shows the public key for the host's deploy-key page; the
 *  private key is never sent back and never shown. */
export function PendingKeyRow({
	pending,
	onPending,
}: {
	pending: PendingKeyInfo | null;
	onPending: (p: PendingKeyInfo | null) => void;
}) {
	const [pasted, setPasted] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const make = (body: Record<string, unknown>): void => {
		if (busy) return;
		setBusy(true);
		setError(null);
		void gitReq("POST", "/api/git-hosts/ssh/pending", body).then(
			({ status, data }) => {
				setBusy(false);
				if (status !== 200) {
					setError(asError(data, status));
					return;
				}
				setPasted("");
				const p = data as unknown as PendingKeyInfo; // unchecked cast: the server's documented answer shape
				onPending(p);
			},
		);
	};
	return (
		<div className="pending-key">
			<DefRow
				name="Private key"
				help="Paste a private key without a passphrase and press Import, or press Generate for a new key made on the server. Ottr never shows the private key again."
				shape="OpenSSH · no passphrase"
			>
				<label>
					<textarea
						rows={3}
						value={pasted}
						onChange={(e) => setPasted(e.target.value)}
						spellCheck={false}
						autoComplete="off"
						aria-label="Paste private key"
					/>
				</label>
			</DefRow>
			<div className="key-actions">
				<button type="button" disabled={busy} onClick={() => make({})}>
					{busy && <span className="spinner" aria-hidden="true" />}
					Generate
				</button>
				<button
					type="button"
					disabled={busy || pasted.trim() === ""}
					onClick={() => make({ privateKey: pasted })}
				>
					Import
				</button>
			</div>
			{error !== null && (
				<p className="auth-error" role="alert">
					{error}
				</p>
			)}
			{pending !== null && (
				<div className="pending-key">
					<DefRow
						name="Public key"
						help="Add this key as a deploy key with write access on your git host, then save it with the test below."
					>
						<label>
							<textarea
								readOnly
								rows={3}
								value={pending.publicKey}
								spellCheck={false}
								onFocus={(e) => e.currentTarget.select()}
								aria-label="Public key"
							/>
						</label>
					</DefRow>
					<div className="key-actions">
						<button
							type="button"
							onClick={() => void copyText(pending.publicKey)}
						>
							Copy key
						</button>
					</div>
					<p className="hint">
						Fingerprint <code>{pending.fingerprint}</code>
					</p>
				</div>
			)}
		</div>
	);
}

/** Git hosts chip: saved HTTPS tokens plus the global SSH key; none while loading. */
function gitHostsChip(
	s: GitHostsView | null,
): { label: string; tone: ChipTone } | undefined {
	if (s === null) return undefined;
	const n = s.tokens.filter((t) => t.tokenSet).length;
	const parts = [
		...(n > 0 ? [`${n} token${n === 1 ? "" : "s"}`] : []),
		...(s.globalKey !== null ? ["SSH key"] : []),
	];
	return parts.length === 0
		? { label: "None", tone: "off" }
		: { label: parts.join(" · "), tone: "ok" };
}

/** Settings "Git hosts" section: per-host HTTPS tokens and the server-side global SSH key.
 *  Token values are write-only: the server never returns them and the UI never shows one. */
export function GitHostsSection() {
	const [state, setState] = useState<GitHostsView | null>(null);
	const [error, setError] = useState<string | null>(null);
	// Add-token form; `replace` pre-fills it from a listed token.
	const [tHost, setTHost] = useState("");
	const [tUser, setTUser] = useState("oauth2");
	const [tUserEdited, setTUserEdited] = useState(false);
	const [tToken, setTToken] = useState("");
	const [tUrl, setTUrl] = useState("");
	const tBusy = useBusy();
	// GitHub App flow: the key is write-only, the server never returns it.
	const [appFormOpen, setAppFormOpen] = useState(false);
	const [appId, setAppId] = useState("");
	const [appKey, setAppKey] = useState("");
	const appBusy = useBusy();
	// GitHub host: a local draft so typing does not fight the reload; null = show
	// the value from state (or empty while state is still loading).
	const [ghHostDraft, setGhHostDraft] = useState<string | null>(null);
	const ghBusy = useBusy();
	// Global-key flow: a pending key, then the save call that also runs the test.
	const [pending, setPending] = useState<PendingKeyInfo | null>(null);
	const [gUrl, setGUrl] = useState("");
	const load = useCallback(async (): Promise<void> => {
		const { data } = await gitReq("GET", "/api/git-hosts");
		setState(data as unknown as GitHostsView); // server-shaped view; no token value in it
	}, []);
	useEffect(() => {
		load().catch((err) =>
			setError(err instanceof Error ? err.message : String(err)),
		);
	}, [load]);
	// Test only checks access and saves nothing: the new key when one is pending, else the
	// global key. Save key stores the pending key; the server tests it first and refuses a failure.
	const gTest = useSshTest({
		label: "Test key",
		disabledReason:
			gUrl.trim() === ""
				? "Enter a test URL first"
				: pending === null && state?.globalKey == null
					? "Generate or import a key first"
					: undefined,
		send: (trust) =>
			gitReq("POST", "/api/git-hosts/ssh/test", {
				url: gUrl.trim(),
				key: pending === null ? "global" : `pending:${pending.id}`,
				trust,
			}).then(toTestAnswer),
	});
	const gSave = useSshTest({
		label: "Save key",
		success: "Global key saved",
		disabledReason:
			pending === null
				? "Generate or import a key first"
				: gUrl.trim() === ""
					? "Enter a test URL first: the key saves only after it passes"
					: undefined,
		send: (trust) =>
			pending === null
				? Promise.resolve({ error: "Generate or import a key first" })
				: gitReq("PUT", "/api/git-hosts/ssh/global", {
						pending: `pending:${pending.id}`,
						testUrl: gUrl.trim(),
						trust,
					}).then((r) => {
						if (r.status === 200) {
							setPending(null);
							void load();
						}
						return toTestAnswer(r);
					}),
	});
	// One guarded call: the error lands on the section's error line, the answer tells the caller.
	const run = (fn: () => Promise<boolean>): Promise<boolean> =>
		(async () => {
			setError(null);
			try {
				return await fn();
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				return false;
			}
		})();
	// The form submit keeps its busy spinner through tBusy; the BusyButton actions track their own.
	// The board's GitHub token can stand in for the configured GitHub host: the server resolves
	// the host itself, so the request carries only the test URL.
	const boardTokenUsable =
		tHost.trim().toLowerCase() !== "" &&
		state?.githubTokenSet === true &&
		state.githubHost !== null &&
		tHost.trim().toLowerCase() === state.githubHost;
	const useBoardToken = (): void => {
		tBusy.start(() =>
			run(async () => {
				const { status, data } = await gitReq(
					"POST",
					"/api/git-hosts/github-token",
					{ testUrl: tUrl.trim() },
				);
				if (status !== 200) throw new Error(asError(data, status));
				setTToken("");
				setTUser(defaultGitUsername(tHost.trim(), state?.githubHost ?? null));
				await load();
				return true;
			}),
		);
	};
	const saveToken = (): void => {
		tBusy.start(() =>
			run(async () => {
				const { status, data } = await gitReq("POST", "/api/git-hosts/tokens", {
					host: tHost.trim(),
					username:
						tUser.trim() ||
						defaultGitUsername(tHost.trim(), state?.githubHost ?? null),
					token: tToken,
					testUrl: tUrl.trim(),
				});
				if (status !== 200) throw new Error(asError(data, status));
				setTToken("");
				await load();
				return true;
			}),
		);
	};
	const removeToken = (host: string): Promise<boolean> =>
		run(async () => {
			if (
				!(await confirmDialog(`Remove the stored token for ${host}?`, {
					ok: "Remove",
					danger: true,
				}))
			)
				return true;
			const { status, data } = await gitReq(
				"DELETE",
				`/api/git-hosts/tokens/${encodeURIComponent(host)}`,
			);
			if (status !== 200) throw new Error(asError(data, status));
			await load();
			return true;
		});
	const removeGlobal = (): Promise<boolean> =>
		run(async () => {
			if (
				!(await confirmDialog(
					"Remove the global SSH key? Projects then clone over https or fail.",
					{ ok: "Remove", danger: true },
				))
			)
				return true;
			const { status, data } = await gitReq(
				"DELETE",
				"/api/git-hosts/ssh/global",
			);
			if (status !== 200) throw new Error(asError(data, status));
			await load();
			return true;
		});
	// One guarded call for the Save button and the form's Enter: `start` blocks a
	// second POST while busy, `run` lands every failure on the section's error line.
	const saveApp = (): void => {
		appBusy.start(() =>
			run(async () => {
				const id = appId.trim();
				if (!/^\d+$/.test(id)) throw new Error("App ID must be numeric");
				if (appKey === "") throw new Error("Private key is required");
				const { status, data } = await gitReq(
					"POST",
					"/api/git-hosts/github-app",
					{ id, key: appKey },
				);
				if (status !== 200) throw new Error(asError(data, status));
				setAppId("");
				setAppKey("");
				setAppFormOpen(false);
				await load();
				return true;
			}),
		);
	};
	const removeApp = (): Promise<boolean> =>
		run(async () => {
			if (
				!(await confirmDialog(
					"Remove the GitHub App? Reviews then post under your own identity.",
					{ ok: "Remove", danger: true },
				))
			)
				return true;
			const { status, data } = await gitReq(
				"DELETE",
				"/api/git-hosts/github-app",
			);
			if (status !== 200) throw new Error(asError(data, status));
			await load();
			return true;
		});
	// Guarded save for the GitHub host; an empty field clears the saved value.
	const saveHost = (): void => {
		ghBusy.start(() =>
			run(async () => {
				const { status, data } = await gitReq(
					"POST",
					"/api/settings/github-host",
					{ host: (ghHostDraft ?? state?.githubHost ?? "").trim() },
				);
				if (status !== 200) throw new Error(asError(data, status));
				setGhHostDraft(null);
				await load();
				return true;
			}),
		);
	};
	return (
		<SettingsCard
			id="git-hosts-section"
			title="Git hosts"
			status={gitHostsChip(state)}
			hint="The GitHub token serves the board's own git and releases. Other HTTPS tokens and the server-side SSH key serve clones, fetches and pushes on any git host. Agents on workers never receive them."
		>
			<div className="sec-block" id="github-host-block" tabIndex={-1}>
				<h4>GitHub host</h4>
				<form
					className="settings-form"
					onSubmit={(e) => {
						e.preventDefault();
						saveHost();
					}}
				>
					<div className="alate-def-rows">
						<DefRow
							name="GitHub host"
							help="Where GitHub lives for this board: github.com, a *.ghe.com Enterprise Cloud host, or an Enterprise Server host. It steers the API calls, gh, PR links, releases and fork research. A saved value wins over the OTTR_GITHUB_HOST env. Empty resets to the env value or github.com."
							shape="bare hostname"
							action={
								<button
									type="submit"
									disabled={ghBusy.busy}
									className={`primary${ghBusy.failed ? " failed" : ""}`}
								>
									{ghBusy.busy && (
										<span className="spinner" aria-hidden="true" />
									)}
									Save
								</button>
							}
						>
							<label>
								<input
									value={ghHostDraft ?? state?.githubHost ?? ""}
									onChange={(e) => setGhHostDraft(e.target.value)}
									placeholder="github.com"
									spellCheck={false}
									aria-label="GitHub host"
								/>
							</label>
						</DefRow>
					</div>
				</form>
				{state !== null && state.githubHost === null && (
					<p className="hint">
						OTTR_GITHUB_HOST is invalid — use a bare hostname, for example
						acme.ghe.com
					</p>
				)}
			</div>
			<div className="sec-block" id="github-token-block" tabIndex={-1}>
				<h4>GitHub token</h4>
				<SecretTokenForm<{ tokenSet: boolean; expiresAt: string | null }>
					endpoint="/api/settings/github-token"
					title="GitHub token"
					help="The board uses this token for its own git fetches, pushes and GitHub releases. Agents on workers never get it."
					label="GitHub token"
					captionSet="Set · paste a new token to replace it"
					captionUnset="Not set: fetch and push fail"
					captionUnknown="Unknown: the check failed"
					expiry={(cfg) => expiryLine(cfg.expiresAt)}
				/>
			</div>
			<div className="sec-block" id="github-app-block" tabIndex={-1}>
				<h4>GitHub App</h4>
				<p className="hint">
					Optional. When it is set, posted PR reviews show as the app (a bot
					account) instead of your own GitHub account.
				</p>
				{state !== null && state.githubApp !== null && !appFormOpen ? (
					<div>
						<div className="settings-field">
							App ID <code>{state.githubApp.id}</code>
						</div>
						<AppCheckLines check={state.githubApp.check} />
						<p className="hint">
							Key set. Fingerprint <code>{state.githubApp.fingerprint}</code>
						</p>
						<button type="button" onClick={() => setAppFormOpen(true)}>
							Replace key
						</button>{" "}
						<BusyButton className="danger" run={removeApp}>
							Remove
						</BusyButton>
					</div>
				) : (
					<form
						className="settings-form"
						onSubmit={(e) => {
							e.preventDefault();
							saveApp();
						}}
					>
						<div className="alate-def-rows">
							<DefRow
								name="App ID"
								help="The numeric ID on the GitHub App's settings page."
								shape="digits"
							>
								<label>
									<input
										value={appId}
										onChange={(e) => setAppId(e.target.value)}
										placeholder="123456"
										required
										pattern="\d+"
										inputMode="numeric"
										aria-label="App ID"
									/>
								</label>
							</DefRow>
							<DefRow
								name="Private key"
								help="The app's private key, in PEM form, from the app's settings page. Ottr stores it and never shows it again."
								shape="PEM · stored, never shown"
							>
								<label>
									<textarea
										rows={8}
										value={appKey}
										onChange={(e) => setAppKey(e.target.value)}
										spellCheck={false}
										autoComplete="off"
										placeholder={"-----BEGIN RSA PRIVATE KEY-----\n…"}
										required
										aria-label="GitHub App private key"
									/>
								</label>
							</DefRow>
						</div>
						<div className="alate-def-actions">
							{state !== null && state.githubApp !== null && (
								<button type="button" onClick={() => setAppFormOpen(false)}>
									Cancel
								</button>
							)}
							<button
								type="submit"
								disabled={appBusy.busy}
								aria-busy={appBusy.busy || undefined}
								className={appBusy.failed ? "failed" : ""}
							>
								{appBusy.busy && (
									<span className="spinner" aria-hidden="true" />
								)}
								Save
							</button>
						</div>
					</form>
				)}
			</div>
			<div className="sec-block" id="host-tokens-block" tabIndex={-1}>
				<h4>Other host tokens</h4>
				<p className="hint">
					HTTPS tokens for git hosts, one for each host. Ottr tests each token
					with git ls-remote before it saves the token.
				</p>
				{state !== null && state.tokens.length > 0 && (
					<table>
						<tbody>
							{state.tokens.map((t) => (
								<tr key={t.host}>
									<td>
										<code>{t.host}</code>
									</td>
									<td>{t.username}</td>
									<td>
										<button
											type="button"
											onClick={() => {
												setTHost(t.host);
												setTUser(t.username);
												setTUserEdited(true);
											}}
										>
											Replace token
										</button>{" "}
										<BusyButton
											className="danger"
											run={() => removeToken(t.host)}
										>
											Remove
										</BusyButton>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
				<form
					className="settings-form"
					onSubmit={(e) => {
						e.preventDefault();
						saveToken();
					}}
				>
					<div className="alate-def-rows">
						<DefRow
							name="Host"
							help="The git host this token is for. Ottr keeps one token for each host."
							shape="hostname"
						>
							<label>
								<input
									value={tHost}
									onChange={(e) => {
										const v = e.target.value;
										setTHost(v);
										if (!tUserEdited)
											setTUser(
												defaultGitUsername(v.trim(), state?.githubHost ?? null),
											);
									}}
									placeholder="gitlab.com"
									required
									aria-label="Host"
								/>
							</label>
						</DefRow>
						<DefRow
							name="Username"
							optional
							help="The username that git sends with the token. GitHub hosts use x-access-token; most other hosts accept oauth2."
						>
							<label>
								<input
									value={tUser}
									onChange={(e) => {
										setTUser(e.target.value);
										setTUserEdited(true);
									}}
									placeholder={defaultGitUsername(
										tHost.trim(),
										state?.githubHost ?? null,
									)}
									aria-label="Username"
								/>
							</label>
						</DefRow>
						<DefRow
							name="Token"
							help="An HTTPS access token for the host. Ottr stores it and never shows it again."
							shape="secret · stored, never shown"
						>
							<label>
								<input
									type="password"
									value={tToken}
									onChange={(e) => setTToken(e.target.value)}
									autoComplete="off"
									spellCheck={false}
									required
									aria-label="Token"
								/>
							</label>
						</DefRow>
						<DefRow
							name="Test URL"
							help="A repository that the token can read. Ottr runs git ls-remote against it before it saves the token."
							shape="https URL"
						>
							<label>
								<input
									value={tUrl}
									onChange={(e) => setTUrl(e.target.value)}
									placeholder="https://gitlab.com/group/repo.git"
									required
									aria-label="Test URL (a repository the token can read)"
								/>
							</label>
						</DefRow>
					</div>
					<div className="alate-def-actions">
						<button
							type="submit"
							disabled={tBusy.busy}
							className={tBusy.failed ? "failed" : ""}
						>
							{tBusy.busy && <span className="spinner" aria-hidden="true" />}
							Save token
						</button>{" "}
						{boardTokenUsable && (
							<button type="button" onClick={useBoardToken}>
								Use the board GitHub token
							</button>
						)}
					</div>
				</form>
			</div>
			<div className="sec-block" id="ssh-key-block" tabIndex={-1}>
				<h4>Global SSH key</h4>
				<p className="hint">
					The server-side SSH key for clones, fetches and pushes over SSH. Each
					project without its own key uses this key.
				</p>
				{state !== null &&
					(state.globalKey === null ? (
						<p className="hint">No global key.</p>
					) : (
						<div>
							<p className="hint">
								Fingerprint <code>{state.globalKey.fingerprint}</code>
							</p>
							<DefRow
								name="Public key"
								help="The public half of the global key. Add it as a deploy key with write access on each git host that the projects use."
							>
								<label>
									<textarea
										readOnly
										rows={3}
										value={state.globalKey.publicKey}
										spellCheck={false}
										onFocus={(e) => e.currentTarget.select()}
										aria-label="Global public key"
									/>
								</label>
							</DefRow>
							<div className="key-actions">
								<button
									type="button"
									onClick={() =>
										void copyText(state.globalKey?.publicKey ?? "")
									}
								>
									Copy key
								</button>
								<BusyButton className="danger" run={removeGlobal}>
									Remove
								</BusyButton>
							</div>
						</div>
					))}
				<p className="hint">
					Save replaces the global key: every project without its own key uses
					the new one.
				</p>
				<PendingKeyRow pending={pending} onPending={setPending} />
				<div className="alate-def-rows">
					<DefRow
						name="Test URL"
						help="A repository that this key can read over SSH. Test checks access with the new key, or with the key in use, and saves nothing. Save key runs the same test and stores the new key only when it passes."
						shape="SSH git URL"
						action={gTest.button}
					>
						<label>
							<input
								value={gUrl}
								onChange={(e) => setGUrl(e.target.value)}
								placeholder="git@gitlab.com:group/repo.git"
								aria-label="Test URL (a repository the key can read)"
							/>
						</label>
					</DefRow>
				</div>
				{gTest.result}
				<div className="ssh-test">
					{gSave.button}
					{gSave.result}
				</div>
			</div>
			{error !== null && (
				<p className="auth-error" role="alert">
					{error}
				</p>
			)}
		</SettingsCard>
	);
}

/** Project settings "SSH key" row: which server-side key git uses for this project.
 *  After the load, `own === null` means the global key applies. */
function SshKeySection({ project }: { project: ProjectView }) {
	const [own, setOwn] = useState<KeyInfo | null | undefined>(undefined);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState<PendingKeyInfo | null>(null);
	const [pUrl, setPUrl] = useState("");
	const load = useCallback(async (): Promise<void> => {
		const { data } = await gitReq(
			"GET",
			`/api/projects/${encodeURIComponent(project.name)}/ssh-key`,
		);
		const v = data as unknown as { own: KeyInfo | null }; // unchecked cast: the server's documented answer shape
		setOwn(v.own);
	}, [project.name]);
	useEffect(() => {
		load().catch((err) =>
			setError(err instanceof Error ? err.message : String(err)),
		);
	}, [load]);
	const keySel =
		pending !== null
			? `pending:${pending.id}`
			: own != null
				? `project:${project.name}`
				: "global";
	const pTest = useSshTest({
		label: "Test key",
		disabledReason: pUrl.trim() === "" ? "Enter a test URL first" : undefined,
		send: (trust) =>
			gitReq("POST", "/api/git-hosts/ssh/test", {
				url: pUrl.trim(),
				key: keySel,
				trust,
			}).then(toTestAnswer),
	});
	const pSave = useSshTest({
		label: "Save key",
		success: "Key saved for this project",
		disabledReason:
			pending === null
				? "Generate or import a key first"
				: pUrl.trim() === ""
					? "Enter a test URL first: the key saves only after it passes"
					: undefined,
		send: (trust) =>
			pending === null
				? Promise.resolve({ error: "Generate or import a key first" })
				: gitReq(
						"PUT",
						`/api/projects/${encodeURIComponent(project.name)}/ssh-key`,
						{ pending: `pending:${pending.id}`, testUrl: pUrl.trim(), trust },
					).then((r) => {
						if (r.status === 200) {
							setPending(null);
							void load();
						}
						return toTestAnswer(r);
					}),
	});
	const useGlobal = (): Promise<boolean> =>
		(async () => {
			setError(null);
			if (
				!(await confirmDialog(
					"Remove this project's key? The project then uses the global key.",
					{ ok: "Use global key", danger: true },
				))
			)
				return true;
			try {
				const { status, data } = await gitReq(
					"DELETE",
					`/api/projects/${encodeURIComponent(project.name)}/ssh-key`,
				);
				if (status !== 200) throw new Error(asError(data, status));
				await load();
				return true;
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				return false;
			}
		})();
	return (
		<SettingsCard
			id="project-ssh-section"
			title="SSH key"
			status={
				own === undefined
					? undefined
					: own === null
						? { label: "Global key", tone: "off" }
						: { label: "Own key", tone: "ok" }
			}
			hint={
				own === undefined ? (
					"Loading…"
				) : own === null ? (
					"Global key"
				) : (
					<>
						Own key, fingerprint <code>{own.fingerprint}</code>
					</>
				)
			}
		>
			{own !== null && own !== undefined && (
				<div className="key-actions">
					<BusyButton className="danger" run={useGlobal}>
						Use global key
					</BusyButton>
				</div>
			)}
			<p className="hint">Save an own key to replace the global key:</p>
			<PendingKeyRow pending={pending} onPending={setPending} />
			<div className="alate-def-rows">
				<DefRow
					name="Test URL"
					help="A repository that this key can read over SSH. Test checks access with the new key, or with the key in use, and saves nothing. Save key runs the same test and stores the new key only when it passes."
					shape="SSH git URL"
					action={pTest.button}
				>
					<label>
						<input
							value={pUrl}
							onChange={(e) => setPUrl(e.target.value)}
							placeholder="git@host:group/repo.git"
							aria-label="Test URL (a repository this key can read)"
						/>
					</label>
				</DefRow>
			</div>
			{pTest.result}
			<div className="ssh-test">
				{pSave.button}
				{pSave.result}
			</div>

			{error !== null && (
				<p className="auth-error" role="alert">
					{error}
				</p>
			)}
		</SettingsCard>
	);
}

/** One env name as GET /api/settings/env reports it. */
type EnvNameRow = { name: string; projects: string[]; set: boolean };

/** Settings "Env" section: one secret value per env.txt name; values never come back after save. */
function EnvSection() {
	const [rows, setRows] = useState<EnvNameRow[] | null>(null);
	const [values, setValues] = useState<Record<string, string>>({});
	const [error, setError] = useState<string | null>(null);
	const saveState = useBusy();
	const load = useCallback(async (): Promise<void> => {
		setRows(
			(await unwrap<{ names: EnvNameRow[] }>(await fetch("/api/settings/env")))
				.names,
		);
	}, []);
	useEffect(() => {
		load().catch((err) =>
			setError(err instanceof Error ? err.message : String(err)),
		);
	}, [load]);
	const save = (name: string): void =>
		saveState.start(async () => {
			setError(null);
			try {
				await post("/api/settings/env", { name, value: values[name] ?? "" });
				setValues((v) => ({ ...v, [name]: "" }));
				await load();
				return true;
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				return false;
			}
		});
	return (
		<SettingsCard
			id="env-section"
			title="Env"
			status={
				rows === null || rows.length === 0
					? undefined
					: {
							label: `${rows.filter((r) => r.set).length} of ${rows.length} set`,
							tone: rows.every((r) => r.set) ? "ok" : "warn",
						}
			}
			hint={
				<>
					Names come from the data repo's{" "}
					<code>workers/&lt;project&gt;/env.txt</code> files (alate provisions
					them into the home volume). One secret value per name serves every
					project that lists it. Values are never shown after save.
				</>
			}
		>
			{rows !== null && rows.length === 0 && (
				<p className="hint">No env.txt file declares a name yet.</p>
			)}
			{rows !== null && rows.length > 0 && (
				<form
					className="settings-form"
					onSubmit={(e) => {
						e.preventDefault();
					}}
				>
					<div className="alate-def-rows">
						{rows.map((row) => (
							<div className="alate-def-row" key={row.name}>
								<div className="alate-def-name">
									<b>
										<code>{row.name}</code>
										<Help
											label={row.name}
											text={`A secret value that workers get as the environment variable ${row.name}. Used by ${row.projects.map((p) => (p === "_all" ? "every project" : p)).join(", ")}.`}
										/>
									</b>
									<code>secret · {row.set ? "set" : "missing"}</code>
								</div>
								<div className="alate-def-actions">
									<input
										type="password"
										value={values[row.name] ?? ""}
										onChange={(e) =>
											setValues((v) => ({ ...v, [row.name]: e.target.value }))
										}
										placeholder={
											row.set
												? "Paste a new value to replace it"
												: "Secret value"
										}
										autoComplete="off"
										spellCheck={false}
										aria-label={`Env value for ${row.name}`}
										required
									/>
									<button
										type="button"
										disabled={saveState.busy}
										className={saveState.failed ? "failed" : undefined}
										onClick={() => save(row.name)}
									>
										{saveState.busy && (
											<span className="spinner" aria-hidden="true" />
										)}
										Save
									</button>
								</div>
							</div>
						))}
					</div>
				</form>
			)}
			{error !== null && (
				<p className="auth-error" role="alert">
					{error}
				</p>
			)}
		</SettingsCard>
	);
}

/** A running or finished `omp login` flow as the server reports it; `ok` stays null until omp exits. */
type LoginView = { provider: string; output: string; ok: boolean | null };
/** One provider's sign-in; inactive: omp disabled it, e.g. after a failed refresh. */
type SignIn = {
	provider: string;
	kind: string;
	active: boolean;
	cause: string | null;
	/** Worker turns get this sign-in as a lent env token; else they use their own credential. */
	lent: boolean;
};
/** One provider omp's `/login` picker offers, as the server reads it from the installed omp. */
type LoginProvider = { id: string; name: string };
type SignInState = {
	/** The board store's sign-ins, one per provider; null when the board cannot read the store. */
	signIns: SignIn[] | null;
	/** Why the board cannot read its store; null when it can. */
	error: string | null;
	pending: LoginView | null;
	/** Empty when the machine has no omp install to read; the field then takes typed ids. */
	providers: LoginProvider[];
};

/** The provider's sign-in page: the first https URL omp prints; later ones are its local shortcuts. */
const signInPage = (output: string): string | null =>
	output.match(/https:\/\/\S+/)?.[0] ?? null;

/** Settings "Provider sign-in" section: omp's sign-ins on the machine that runs the board. */
function ProviderLoginSection() {
	const [state, setState] = useState<SignInState | null>(null);
	const [provider, setProvider] = useState("");
	const [answer, setAnswer] = useState("");
	const [error, setError] = useState<string | null>(null);
	const act = useBusy();
	const quota = useQuota();
	const providers = state?.providers ?? [];
	const providerName = (id: string): string =>
		providers.find((p) => p.id === id)?.name ?? id;
	const pending = state?.pending ?? null;
	const waiting = pending !== null && pending.ok === null;
	const load = useCallback(async (): Promise<void> => {
		setState(await unwrap<SignInState>(await fetch("/api/provider-login")));
	}, []);
	useEffect(() => {
		load().catch((err) =>
			setError(err instanceof Error ? err.message : String(err)),
		);
	}, [load]);
	// The provider's page returns to the board in its own tab; this one learns the verdict by polling.
	useEffect(() => {
		if (!waiting) return;
		const t = setInterval(() => {
			load().catch(() => {});
		}, 2000);
		return () => clearInterval(t);
	}, [waiting, load]);
	const run = (fn: () => Promise<boolean>): void =>
		act.start(async () => {
			setError(null);
			try {
				return await fn();
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				return false;
			}
		});
	const start = (id: string): void => {
		if (act.busy) return;
		// Opened inside the click, so popup blockers let it through; the address follows the reply.
		const tab = window.open("", "_blank");
		if (tab !== null) tab.opener = null;
		run(async () => {
			try {
				const v = await post<LoginView>("/api/provider-login", {
					provider: id,
				});
				const page = v.ok === null ? signInPage(v.output) : null;
				if (page !== null && tab !== null) tab.location.href = page;
				else tab?.close();
				await load();
				return v.ok !== false;
			} catch (err) {
				tab?.close();
				throw err;
			}
		});
	};
	const finish = (): void =>
		run(async () => {
			const v = await post<LoginView>("/api/provider-login/answer", {
				line: answer,
			});
			setAnswer("");
			await load();
			return v.ok !== false;
		});
	const cancel = (): void =>
		run(async () => {
			await post("/api/provider-login/cancel", {});
			await load();
			return true;
		});
	const signOutOf = async (id: string): Promise<void> => {
		if (
			!(await confirmDialog(
				`Sign omp out of ${providerName(id)}? Turns that use it fail until you sign in again.`,
				{ ok: "Sign out", danger: true },
			))
		)
			return;
		run(async () => {
			await post("/api/provider-login/logout", { provider: id });
			await load();
			return true;
		});
	};
	const page = pending === null ? null : signInPage(pending.output);
	const signIns = state?.signIns ?? [];
	const signedIn = signIns.filter((i) => i.active).length;
	return (
		<SettingsCard
			id="signin-section"
			className="providers"
			title="Provider sign-in"
			status={
				state === null
					? undefined
					: signedIn > 0
						? { label: `${signedIn} signed in`, tone: "ok" }
						: { label: "None signed in", tone: "warn" }
			}
			hint="One sign-in per provider, stored on the board's machine. For OAuth sign-ins of Anthropic, ChatGPT (Codex) and Z.AI, worker turns get a short-lived token in their env. Other providers are not lent: workers use their own sign-in, or the provider's key under Settings, Env. A sign-in works the same from a phone or another machine: finish the provider's page there, copy the address it ends on, or the code it shows, and paste it below."
		>
			{signIns.length > 0 && (
				<div className="alate-def-rows">
					{signIns.map((signIn) => {
						const id = signIn.provider;
						const limits = forProvider(quota?.limits ?? [], id);
						const plan = limits.find((l) => l.plan !== null)?.plan ?? null;
						const needs = !signIn.active;
						const led = needs ? "crit" : signIn.kind === "oauth" ? "ok" : "";
						const words = needs
							? "Sign-in expired: sign in again"
							: signIn.kind === "oauth"
								? "Signed in"
								: "API key stored";
						return (
							<div className="alate-def-row providers-row" key={id}>
								<div className="alate-def-name">
									<b className="provider-name">
										<i className={`status-dot ${led}`} aria-hidden="true" />
										{providerName(id)}
									</b>
									<span>
										{words}
										{signIn.active &&
											(signIn.lent
												? " · Lent to workers"
												: " · Not lent to workers")}
										{plan !== null &&
											` · ${plan.charAt(0).toUpperCase()}${plan.slice(1)} plan`}
									</span>
									<code>{id}</code>
								</div>
								<div className="providers-meters">
									{limits.map((l) => (
										<QuotaRow key={l.label} limit={l} />
									))}
								</div>
								<div className="alate-def-actions">
									{needs && (
										<button
											type="button"
											onClick={() => start(id)}
											disabled={act.busy || waiting}
											aria-label={`Sign in again to ${providerName(id)}`}
										>
											Sign in again
										</button>
									)}
									<button
										type="button"
										className="danger"
										onClick={() => signOutOf(id)}
										disabled={act.busy}
										aria-label={`Sign out of ${providerName(id)}`}
									>
										Sign out
									</button>
								</div>
							</div>
						);
					})}
				</div>
			)}
			{state?.signIns?.length === 0 && (
				<p className="hint">omp has no sign-ins on this machine yet.</p>
			)}
			{state?.error && (
				<p className="auth-error" role="alert">
					{state.error}
				</p>
			)}
			{waiting ? (
				<form
					className="settings-form"
					onSubmit={(e) => {
						e.preventDefault();
						finish();
					}}
				>
					<p className="hint">
						<b>Finish signing in to {providerName(pending.provider)}</b>
					</p>
					<p className="hint">
						{page !== null && (
							<a href={page} target="_blank" rel="noreferrer">
								Open the sign-in page
							</a>
						)}
					</p>
					<div className="providers-finish">
						<div className="alate-def-row">
							<div className="alate-def-name">
								<b>
									Code or address
									<Help
										label="Code or address"
										text="After you finish the provider's sign-in page, paste the address that the page ends on (it starts with http://localhost) or the code that it shows. This works the same from another machine or a phone."
									/>
								</b>
								<code>sent to omp once, never stored</code>
							</div>
							<label>
								<input
									type="text"
									value={answer}
									onChange={(e) => setAnswer(e.target.value)}
									autoComplete="off"
									spellCheck={false}
									aria-label="Code or address"
								/>
							</label>
						</div>
						<div className="alate-def-actions">
							<button type="button" onClick={cancel} disabled={act.busy}>
								Cancel
							</button>
							<button
								type="submit"
								disabled={act.busy}
								className={act.failed ? "failed" : undefined}
							>
								{act.busy && <span className="spinner" aria-hidden="true" />}
								Send code
							</button>
						</div>
					</div>
					<pre className="log">{pending.output}</pre>
				</form>
			) : (
				<form
					className="settings-form providers-form"
					onSubmit={(e) => {
						e.preventDefault();
						start(provider.trim());
					}}
				>
					<div className="alate-def-row">
						<div className="alate-def-name">
							<b>
								Provider
								<Help
									label="Provider"
									text="The omp provider to sign in to. Pick one from the list, or type any id that omp login shows."
								/>
							</b>
							<code>omp provider id</code>
						</div>
						<label>
							<input
								type="text"
								list="login-providers"
								value={provider}
								onChange={(e) => setProvider(e.target.value)}
								autoComplete="off"
								spellCheck={false}
								aria-label="Provider"
								required
							/>
							<datalist id="login-providers">
								{providers.map((p) => (
									<option key={p.id} value={p.id}>
										{p.name}
									</option>
								))}
							</datalist>
						</label>
						<button
							type="submit"
							disabled={act.busy}
							className={act.failed ? "failed" : "primary"}
						>
							{act.busy && <span className="spinner" aria-hidden="true" />}
							Sign in
						</button>
					</div>
				</form>
			)}
			<p className="hint" role="status">
				{pending?.ok === true
					? `Signed in to ${providerName(pending.provider)}.`
					: null}
			</p>
			{pending?.ok === false && (
				<div role="alert">
					<p className="auth-error">
						Sign-in to {providerName(pending.provider)} failed. omp reported:
					</p>
					<pre className="log">{pending.output}</pre>
				</div>
			)}
			{error !== null && (
				<p className="auth-error" role="alert">
					{error}
				</p>
			)}
		</SettingsCard>
	);
}

/** One script result of POST /api/alate/provision. */
type ProvisionResult = {
	script: string;
	code: number;
	output: string;
	truncated: boolean;
};
/** The provision after a commit: running, still running on Alate (202), or its result. */
type ProvisionStep =
	| { state: "running" }
	| { state: "still" }
	| {
			state: "done";
			ok: boolean;
			results: ProvisionResult[];
			error: string | null;
	  };

const shortSha = (sha: string): string => sha.slice(0, 7);

/** One Model roles value's model picker: the shared search popover over the catalogue.
    The picker sets the value's base model; the row keeps its own thinking select.
    `label` names the picker ("Model for plan", "plan fallback 2 model"). */
function RoleModelPicker({
	label: name,
	base,
	level,
	models,
	setValue,
	disabled,
	invalid,
	describedBy,
}: {
	label: string;
	base: string;
	level: string;
	models: readonly ModelOption[];
	setValue: (value: string) => void;
	disabled: boolean;
	invalid: boolean;
	describedBy?: string;
}) {
	const menu = useModelMenu();
	const [query, setQuery] = useState("");
	// The saved value names itself like the old select's option did; a value the
	// catalogue does not list keeps its selector and the not-in-catalog note.
	const known = models.find((m) => m.selector === base);
	const label =
		known !== undefined
			? `${known.name} (${known.id})`
			: `${base} (not in the catalog)`;
	const filtered = models.filter((m) => modelMatches(m, query));
	return (
		<>
			<ModelMenuTrigger
				menu={menu}
				label={name}
				invalid={invalid}
				describedBy={describedBy}
				disabled={disabled}
			>
				<span className="model-name">{label}</span>
			</ModelMenuTrigger>
			<ModelMenuBody
				menu={menu}
				query={query}
				setQuery={setQuery}
				rows={filtered.map(
					(m): ModelRow => ({
						key: m.selector,
						label: `${m.name} (${m.id})`,
						selector: m.selector,
						pressed: m.selector === base,
					}),
				)}
				shown={filtered.length}
				total={models.length}
				onPick={(selector) => {
					setValue(joinLevel(selector, level));
					menu.close();
				}}
			/>
		</>
	);
}

/** A Model roles value's thinking select: Default (no level), then each level. */
function ThinkingSelect({
	label,
	base,
	level,
	setValue,
	disabled,
	invalid,
	describedBy,
}: {
	label: string;
	base: string;
	level: string;
	setValue: (value: string) => void;
	disabled: boolean;
	invalid: boolean;
	describedBy?: string;
}) {
	return (
		<select
			value={level}
			onChange={(e) => setValue(joinLevel(base, e.target.value))}
			aria-label={label}
			aria-invalid={invalid}
			aria-describedby={describedBy}
			disabled={disabled}
		>
			<option value="">Default</option>
			{THINKING_LEVELS.map((l) => (
				<option key={l} value={l}>
					{l}
				</option>
			))}
		</select>
	);
}

/** `map` without `key`; fromEntries keeps every other key an own key. */
function withoutKey<T>(
	map: Readonly<Record<string, T>>,
	key: string,
): Record<string, T> {
	return Object.fromEntries(Object.entries(map).filter(([k]) => k !== key));
}

/** A role's fallback chain under its row: one model and thinking pair per entry in chain
    order, Move up (not on the first), remove, and Add fallback with the first catalog model.
    `chain` is undefined when the role has no chain key; `edit` maps the current chain. */
function RoleFallbacks({
	role,
	chain,
	models,
	first,
	edit,
	disabled,
	error,
	errorId,
}: {
	role: string;
	chain: readonly string[] | undefined;
	models: readonly ModelOption[];
	first: string | undefined;
	edit: (fn: (chain: string[]) => string[]) => void;
	disabled: boolean;
	error: string | undefined;
	errorId: string;
}) {
	const list = useRef<HTMLOListElement>(null);
	const addButton = useRef<HTMLButtonElement>(null);
	// Entries render by position, so after a move or a removal of the last entry the focus
	// goes where the moved entry or the nearest control now is.
	const [focusAt, setFocusAt] = useState<number | null>(null);
	useEffect(() => {
		if (focusAt === null) return;
		setFocusAt(null);
		const row = list.current?.children[focusAt];
		const target =
			row?.querySelector<HTMLElement>(".fallback-up") ??
			row?.querySelector<HTMLElement>(".fallback-remove") ??
			addButton.current;
		target?.focus();
	}, [focusAt]);
	const entries = chain ?? [];
	const describedBy = error !== undefined ? errorId : undefined;
	return (
		<fieldset className="role-fallbacks">
			<legend className="role-fallbacks-head">
				Fallbacks<span className="sr"> for {role}</span>
			</legend>
			{entries.length === 0 ? (
				<p className="hint">No fallback models.</p>
			) : (
				<ol className="fallback-list" ref={list}>
					{entries.map((value, i) => {
						const [base, level] = splitLevel(value);
						const n = i + 1;
						const setEntry = (next: string): void =>
							edit((c) => c.map((v, j) => (j === i ? next : v)));
						return (
							// biome-ignore lint/suspicious/noArrayIndexKey: a chain can hold one selector twice; entries are positions
							<li className="fallback-row" key={i}>
								<span className="fallback-num" aria-hidden="true">
									{n}
								</span>
								{i > 0 && (
									<button
										type="button"
										className="icon fallback-up"
										aria-label={`Move up ${role} fallback ${n}`}
										title="Move up"
										onClick={() => {
											edit((c) => {
												const moved = [...c];
												moved.splice(i - 1, 0, ...moved.splice(i, 1));
												return moved;
											});
											setFocusAt(i - 1);
										}}
										disabled={disabled}
									>
										<Icon name="chevron-up" />
									</button>
								)}
								<RoleModelPicker
									label={`${role} fallback ${n} model`}
									base={base}
									level={level}
									models={models}
									setValue={setEntry}
									disabled={disabled}
									invalid={error !== undefined}
									describedBy={describedBy}
								/>
								<ThinkingSelect
									label={`${role} fallback ${n} thinking`}
									base={base}
									level={level}
									setValue={setEntry}
									disabled={disabled}
									invalid={error !== undefined}
									describedBy={describedBy}
								/>
								<button
									type="button"
									className="icon fallback-remove"
									aria-label={`Remove ${role} fallback ${n}`}
									title="Remove fallback"
									onClick={() => {
										edit((c) => c.filter((_, j) => j !== i));
										// The entry below takes this position and keeps the focus;
										// the last entry hands it up, or to Add fallback.
										if (i === entries.length - 1) setFocusAt(i - 1);
									}}
									disabled={disabled}
								>
									<Icon name="x" />
								</button>
							</li>
						);
					})}
				</ol>
			)}
			{error !== undefined && (
				<p className="auth-error" id={errorId}>
					{error}
				</p>
			)}
			<button
				type="button"
				className="fallback-add"
				ref={addButton}
				aria-label={`Add fallback for ${role}`}
				aria-describedby={describedBy}
				onClick={() => {
					if (first !== undefined) edit((c) => [...c, first]);
				}}
				disabled={disabled || first === undefined}
			>
				<Icon name="plus" />
				Add fallback
			</button>
		</fieldset>
	);
}

/** Settings "Model roles" section: edits omp's modelRoles and each role's fallback chain in the
    data repo through Alate, then provisions. */
export function ModelRolesSection() {
	const catalog = useModels();
	const [state, setState] = useState<RolesState | null>(null);
	const [loadErr, setLoadErr] = useState<string | null>(null);
	const [rows, setRows] = useState<Array<[string, string]>>([]);
	const [fields, setFields] = useState<Record<string, string>>({});
	// The rows' fallback chains; a role without a chain has no key.
	const [chains, setChains] = useState<Record<string, string[]>>({});
	const [fallbackFields, setFallbackFields] = useState<Record<string, string>>(
		{},
	);
	const [error, setError] = useState<string | null>(null);
	const [ro, setRo] = useState<{
		path: string;
		cause: "plain" | "mount";
	} | null>(null);
	const [newName, setNewName] = useState("");
	const [addErr, setAddErr] = useState<string | null>(null);
	const [commit, setCommit] = useState<string | null>(null);
	// The saved roles and chains and the board's seed commit at the save: the seed step
	// compares the board copy with them.
	const [saved, setSaved] = useState<{
		seedAtSave: string | null;
		after: Record<string, string>;
		afterFallbacks: Record<string, string[]>;
	} | null>(null);
	const [prov, setProv] = useState<ProvisionStep | null>(null);
	/** When this page's provision call started; the running line ticks its elapsed time. */
	const [provSince, setProvSince] = useState<number | null>(null);
	const save = useBusy();
	const uid = useId();
	const load = useCallback(
		async (): Promise<RolesState> =>
			unwrap<RolesState>(await fetch("/api/model-roles")),
		[],
	);
	useEffect(() => {
		let live = true;
		load().then(
			(s) => {
				if (!live) return;
				setState(s);
				setRows(Object.entries(s.roles));
				setChains(rowChains(Object.keys(s.roles), s.fallbacks));
			},
			(err: unknown) => {
				if (live) setLoadErr(err instanceof Error ? err.message : String(err));
			},
		);
		return () => {
			live = false;
		};
	}, [load]);
	const seed = state?.seed ?? null;
	const step =
		seed === null || saved === null
			? null
			: seedStep(seed, saved.seedAtSave, saved.after, saved.afterFallbacks);
	const seedWaits = commit !== null && step === "wait";
	// The hourly deploy seeds the board copy: read the seed state each minute until it holds the save.
	useEffect(() => {
		if (!seedWaits) return;
		const t = setInterval(() => {
			// A failed read keeps the line waiting; the next tick reads again. Only the seed
			// state is taken: the rows, base and hash stay the saved commit's, so a later
			// commit on main reaches the next save as a conflict, not as silently swapped rows.
			load().then(
				(s) => setState((old) => old && { ...old, seed: s.seed }),
				() => {},
			);
		}, 60_000);
		return () => clearInterval(t);
	}, [seedWaits, load]);
	const models = [...(catalog?.models ?? [])].sort((a, b) =>
		a.name.localeCompare(b.name),
	);
	const first = models[0]?.selector;
	const dirty =
		state !== null &&
		(rolesDirty(rows, state.roles) ||
			fallbacksDirty(
				rows.map(([name]) => name),
				chains,
				state.fallbacks,
			));
	// The check roles the board would fall back from: without them a check runs on the
	// default model, which is often the model it checks.
	const missing = missingCheckRoles(rows.map(([name]) => name));
	const setValue = (name: string, value: string): void => {
		setRows((rs) => rs.map((r) => (r[0] === name ? [name, value] : r)));
		setFields((f) => withoutKey(f, name));
	};
	const editChain = (name: string, fn: (chain: string[]) => string[]): void => {
		setChains((c) => {
			const next = fn(ownField(c, name) ?? []);
			// Removing the last entry drops the key, so the save sends no explicit empty chain.
			return next.length === 0
				? withoutKey(c, name)
				: { ...withoutKey(c, name), [name]: next };
		});
		setFallbackFields((f) => withoutKey(f, name));
	};
	const removeRole = (name: string): void => {
		setRows((rs) => rs.filter(([n]) => n !== name));
		setChains((c) => withoutKey(c, name));
		setFallbackFields((f) => withoutKey(f, name));
	};
	const add = (): void => {
		const name = newName.trim();
		const err = addRoleError(name, rows, first);
		setAddErr(err);
		if (err === null && first !== undefined) {
			setRows((rs) => [...rs, [name, first]]);
			// A new role starts with the chain the file holds for its key.
			const loaded =
				state !== null ? ownField(state.fallbacks, name) : undefined;
			if (loaded !== undefined)
				setChains((c) => ({ ...c, [name]: [...loaded] }));
			setNewName("");
		}
	};
	const provision = async (): Promise<void> => {
		setProv({ state: "running" });
		setProvSince(Date.now());
		try {
			const res = await post<{
				ok: boolean;
				running?: boolean;
				results?: ProvisionResult[];
			}>("/api/alate/provision", {});
			setProv(
				res.running === true
					? { state: "still" }
					: {
							state: "done",
							ok: res.ok,
							results: res.results ?? [],
							error: null,
						},
			);
		} catch (err) {
			setProv({
				state: "done",
				ok: false,
				results: [],
				error: err instanceof Error ? err.message : String(err),
			});
		} finally {
			// "still" hands the watch to the Alate section: this line stops counting.
			setProvSince(null);
		}
	};
	const submit = (): void =>
		save.start(async () => {
			if (state === null) return false;
			setError(null);
			setFields({});
			setFallbackFields({});
			setCommit(null);
			setSaved(null);
			setProv(null);
			setProvSince(null);
			try {
				const res = await fetch("/api/model-roles", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						base: state.base,
						hash: state.hash,
						roles: Object.fromEntries(rows),
						fallbacks: rowChains(
							rows.map(([name]) => name),
							chains,
						),
					}),
				});
				const r = classifyRolesSave(
					res.ok,
					res.status,
					await res.json().catch(() => ({})),
				);
				if (r.kind === "readonly") {
					setRo({ path: r.path, cause: r.cause });
					setRows(Object.entries(state.roles));
					setChains(rowChains(Object.keys(state.roles), state.fallbacks));
					setError(null);
					setFields({});
					setFallbackFields({});
					return false;
				}
				if (r.kind === "saved") {
					const { commit: sha, base, hash, roles, fallbacks, seed } = r;
					setState(
						(old) => old && { ...old, base, hash, roles, fallbacks, seed },
					);
					setRows(Object.entries(roles));
					setChains(rowChains(Object.keys(roles), fallbacks));
					setSaved({
						seedAtSave: seed.commit,
						after: roles,
						afterFallbacks: fallbacks,
					});
					setCommit(sha);
					// The commit stands even when the provision fails; the steps list says so.
					await provision();
					return true;
				}
				if (r.kind === "conflict") {
					// The data repo moved: load its current values, so the next save starts from them.
					const { base, hash, roles, fallbacks } = r;
					setState((old) => old && { ...old, base, hash, roles, fallbacks });
					setRows(Object.entries(roles));
					setChains(rowChains(Object.keys(roles), fallbacks));
					setError(r.error);
					return false;
				}
				setFields(r.fields);
				setFallbackFields(r.fallbackFields);
				setError(r.error);
				return false;
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				return false;
			}
		});
	const failed =
		prov?.state === "done" ? prov.results.filter((r) => r.code !== 0) : [];
	return (
		<SettingsCard
			id="model-roles-section"
			className="model-roles"
			title="Model roles"
			status={
				loadErr !== null
					? { label: "Unavailable", tone: "warn" }
					: state === null
						? undefined
						: {
								label: `${Object.keys(state.roles).length} roles`,
								tone: "ok",
							}
			}
			hint={
				<>
					omp runs each role with its model, then with its fallbacks in order.{" "}
					{state?.base === null ? (
						<>
							Save writes <code>user/omp/agent/config.yml</code> through Alate's
							file editor: Alate commits the folder itself when it is a git repo
							(no GitHub token), then Alate provisions the workers.
						</>
					) : (
						<>
							Save commits <code>user/omp/agent/config.yml</code> to Alate's
							data repo with the board's GitHub token, then Alate provisions the
							workers.
						</>
					)}
				</>
			}
		>
			{loadErr !== null ? (
				<p className="hint" role="status">
					Cannot load the model roles: {loadErr}.{" "}
					<button
						type="button"
						className="notif-link"
						onClick={() => openSettingsSection("alate-section")}
					>
						Open the Alate settings
					</button>
				</p>
			) : state === null || catalog === null ? (
				<Skeleton shape="rows" rows={4} label="Loading the model roles" />
			) : (
				<>
					<div className="alate-def-rows">
						{rows.map(([name, value], i) => {
							const [base, level] = splitLevel(value);
							const field = ownField(fields, name);
							const warnings = roleWarnings(value, state.signIns);
							const notesId =
								field !== undefined || warnings.length > 0
									? `${uid}-${i}`
									: undefined;
							return (
								<div className="alate-def-row role-row" key={name}>
									<b className="role-name">{name}</b>
									<RoleModelPicker
										label={`Model for ${name}`}
										base={base}
										level={level}
										models={models}
										setValue={(v) => setValue(name, v)}
										disabled={save.busy || ro !== null}
										invalid={field !== undefined}
										describedBy={notesId}
									/>
									<ThinkingSelect
										label={`Thinking for ${name}`}
										base={base}
										level={level}
										setValue={(v) => setValue(name, v)}
										disabled={save.busy || ro !== null}
										invalid={field !== undefined}
										describedBy={notesId}
									/>
									<button
										type="button"
										className="icon role-remove"
										aria-label={`Remove role ${name}`}
										title="Remove role"
										onClick={() => removeRole(name)}
										disabled={save.busy || ro !== null}
									>
										<Icon name="x" />
									</button>
									{notesId !== undefined && (
										<div className="role-notes" id={notesId}>
											{field !== undefined && (
												<p className="auth-error">{field}</p>
											)}
											{warnings.map((w) => (
												<p className="hint" key={w}>
													<Mark kind="warn" />
													{w}
												</p>
											))}
										</div>
									)}
									<RoleFallbacks
										role={name}
										chain={ownField(chains, name)}
										models={models}
										first={first}
										edit={(fn) => editChain(name, fn)}
										disabled={save.busy || ro !== null}
										error={ownField(fallbackFields, name)}
										errorId={`${uid}-${i}-fallbacks`}
									/>
								</div>
							);
						})}
					</div>
					{missing.length > 0 && (
						<p className="hint">
							<Mark kind="warn" /> No {missing.join(" or ")} role
							{missing.length > 1 ? "s" : ""}: second-model checks fall back to
							the default model, which is often the model they check. critic
							checks Anthropic models, adversary the rest.
						</p>
					)}
					{ro !== null && (
						<>
							<p className="auth-error" role="alert">
								read-only: folder source {ro.path}
							</p>
							<p className="hint">
								{ro.cause === "mount" ? (
									<>
										The data folder is mounted read-only into Alate. Make the
										mount writable, or edit{" "}
										<code>user/omp/agent/config.yml</code> in the folder, then
										run Import and Provision in Alate, and reload the settings.
									</>
								) : (
									"Alate's data folder is not a git repo, so a save cannot commit. Make the folder a git repo or point Alate at a GitHub repo, then reload the settings."
								)}
							</p>
						</>
					)}
					<form
						className="role-add"
						onSubmit={(e) => {
							e.preventDefault();
							add();
						}}
					>
						<label className="field">
							New role name
							<input
								type="text"
								value={newName}
								onChange={(e) => {
									setNewName(e.target.value);
									setAddErr(null);
								}}
								spellCheck={false}
								autoComplete="off"
								aria-invalid={addErr !== null}
								aria-describedby={addErr !== null ? `${uid}-add` : undefined}
								disabled={save.busy || ro !== null}
							/>
						</label>
						<button type="submit" disabled={save.busy || ro !== null}>
							Add role
						</button>
					</form>
					{addErr !== null && (
						<p className="auth-error" id={`${uid}-add`} role="alert">
							{addErr}
						</p>
					)}
					<div className="alate-def-actions">
						<button
							type="button"
							// Plain button while read-only: the accent fill reads clickable even at
							// the disabled opacity, and the editor must read locked.
							className={
								ro !== null
									? undefined
									: `primary${save.failed ? " failed" : ""}`
							}
							onClick={submit}
							disabled={!dirty || save.busy || ro !== null}
						>
							{save.busy && <span className="spinner" aria-hidden="true" />}
							Save
						</button>
					</div>
				</>
			)}
			{error !== null && (
				<p className="auth-error" role="alert">
					{error}
				</p>
			)}
			<div aria-live="polite">
				{commit !== null && (
					<ol className="hint role-steps">
						<li>
							<Mark kind="done" />
							Committed <code>{shortSha(commit)}</code> to the data repo.
						</li>
						<li>
							{prov === null || prov.state === "running" ? (
								<>
									<span className="spinner" aria-hidden="true" />
									Provisioning the workers…
									{provSince !== null && (
										<>
											{" · "}
											<LiveElapsed since={provSince} />
										</>
									)}
								</>
							) : prov.state === "still" ? (
								<>
									<Mark kind="queued" />
									The provision still runs on the Alate server. The Alate
									dashboard shows its result.
								</>
							) : prov.ok && failed.length === 0 ? (
								<>
									<Mark kind="done" />
									Provisioned the workers.
								</>
							) : (
								<>
									<Mark kind="crit" />
									The provision failed
									{prov.error !== null
										? `: ${prov.error}`
										: failed.length > 0
											? `: ${failed.length} of ${prov.results.length} scripts failed`
											: ""}
									. The commit stays in the data repo. Use Provision in the
									Alate section to try again.
								</>
							)}
						</li>
						<li>
							{step === null || step === "copy" ? (
								<>
									<Mark kind="done" />
									The board reads the provisioned copy.
								</>
							) : step === "done" ? (
								<>
									<Mark kind="done" />
									The board copy has the saved roles
									{seed?.commit ? (
										<>
											{" "}
											(seed <code>{shortSha(seed.commit)}</code>)
										</>
									) : null}
									{seed?.expiresAt !== undefined ? (
										<> · {expiryLine(seed.expiresAt)}</>
									) : null}
									.
								</>
							) : step === "replaced" ? (
								<>
									<Mark kind="done" />
									The board copy has other roles: a later change replaced this
									save.
								</>
							) : (
								<>
									<Mark kind="queued" />
									Waiting for the hourly deploy to seed{" "}
									<code>{shortSha(commit)}</code>.
								</>
							)}
						</li>
					</ol>
				)}
			</div>
			{failed.map((r) => (
				<div key={r.script}>
					<p className="auth-error">
						{r.script} — exit {r.code}
					</p>
					<pre className="log">{r.output}</pre>
				</div>
			))}
		</SettingsCard>
	);
}

/** The board's Hindsight server, the active memory backend and why memory is off; the key itself is write-only. */
type HindsightView = {
	url: string | null;
	tokenSet: boolean;
	backend: "hindsight" | "mnemopi";
	memoryReason: string | null;
};

/** Settings "Hindsight" section: the server URL and the key every turn's omp sends to it. */
export function HindsightSection() {
	const [view, setView] = useState<HindsightView | null>(null);
	const [url, setUrl] = useState("");
	const [urlError, setUrlError] = useState<string | null>(null);
	const [urlSaved, flashUrlSaved] = useFlash(1500);
	const urlSave = useBusy();
	const saveUrl = (): void =>
		urlSave.start(async () => {
			setUrlError(null);
			try {
				const cfg = await post<HindsightView>("/api/settings/hindsight", {
					url: url.trim(),
				});
				setView(cfg);
				setUrl("");
				flashUrlSaved();
				return true;
			} catch (err) {
				setUrlError(err instanceof Error ? err.message : String(err));
				return false;
			}
		});
	return (
		<SettingsCard
			id="hindsight-section"
			title="Hindsight"
			status={
				view === null
					? undefined
					: view.backend === "hindsight"
						? { label: "Memory backend: hindsight", tone: "ok" }
						: { label: "Memory backend: mnemopi (the default)", tone: "off" }
			}
			hint={
				view === null ? undefined : view.backend === "mnemopi" ? (
					<>
						This board's turns keep their memory with mnemopi, omp's default.
						The backend follows the deployment: a set{" "}
						<code>HINDSIGHT_API_URL</code> or a URL saved here switches the
						board to the Hindsight server at the next boot — never config.yml.
					</>
				) : (
					<>
						Every turn keeps its memory on the Hindsight server at{" "}
						<code>{view.url}</code>. The board saves a new key only when that
						server accepts it. Turns that start after the save use the new key
						and URL. A saved URL beats the <code>HINDSIGHT_API_URL</code> env
						seed at the next boot.
					</>
				)
			}
		>
			<form
				className="settings-form"
				onSubmit={(e) => {
					e.preventDefault();
					saveUrl();
				}}
			>
				<div className="alate-def-rows">
					<div className="alate-def-row">
						<div className="alate-def-name">
							<b>
								Server URL
								<Help
									label="Server URL"
									text="The Hindsight memory server that the omp of each turn uses. Empty: turns use the HINDSIGHT_API_URL environment variable; when that is empty too, the board runs mnemopi (omp's default)."
								/>
							</b>
							<code>
								http(s) URL ·{" "}
								{view?.url == null
									? "not set, turns use HINDSIGHT_API_URL"
									: "saved"}
							</code>
						</div>
						<div className="alate-def-actions">
							<label>
								<input
									type="url"
									value={url}
									onChange={(e) => setUrl(e.target.value)}
									placeholder={view?.url ?? "http://hindsight.local:8888"}
									autoComplete="off"
									spellCheck={false}
									aria-label="Hindsight server URL"
									required
								/>
							</label>
							<button
								type="submit"
								disabled={urlSave.busy}
								className={urlSave.failed ? "failed" : undefined}
							>
								{urlSave.busy && (
									<span className="spinner" aria-hidden="true" />
								)}
								<SaveLabel saved={urlSaved} />
							</button>
						</div>
					</div>
				</div>
			</form>
			{view?.memoryReason != null && (
				<p className="hint notif-line" role="alert">
					<Mark kind="warn" />
					<span>omp runs with no memory: {view.memoryReason}</span>
				</p>
			)}
			{urlError !== null && (
				<p className="auth-error" role="alert">
					{urlError}
				</p>
			)}
			{/* Mounted while the view loads so its fetch resolves it; unmounted when no server is configured. */}
			{(view === null || view.url !== null) && (
				<SecretTokenForm<HindsightView>
					endpoint="/api/settings/hindsight"
					title="API key"
					help="The key that the omp of each turn sends to the Hindsight server. Without a key, turns have no memory."
					label="Hindsight API key"
					captionSet="Set. Paste a new key to replace it"
					captionUnset="Not set: turns have no memory"
					captionUnknown="Unknown: the check failed"
					onLoaded={setView}
				/>
			)}
		</SettingsCard>
	);
}

/** Alate /health passthrough (proxied by /api/alate/health); only the fields the hint and the provision button read. */
type AlateHealth = {
	version?: unknown;
	update?: { behind?: unknown } | undefined;
	pending?: unknown;
	running?: unknown;
};
/** Probe outcome for the connected alate instance. */
type AlateHealthState =
	| {
			state: "ok";
			version: string | null;
			behind: boolean;
			pending: boolean;
			running?: boolean;
	  }
	| { state: "down" };

/** Alate state chip: configuration first (URL, API key), then the health probe, then the last provision. */
export function alateChip(
	conn: string,
	keySet: boolean,
	health: AlateHealthState | null,
	lastErr: string | null,
): { label: string; tone: ChipTone } {
	if (conn === "") return { label: "Not configured", tone: "off" };
	if (!keySet) return { label: "No API key", tone: "warn" };
	if (health === null) return { label: "Checking…", tone: "off" };
	if (health.state === "down") return { label: "Unreachable", tone: "warn" };
	if (lastErr !== null) return { label: "Provision failed", tone: "warn" };
	return { label: "Connected", tone: "ok" };
}

/** One-line hint for the connected alate instance: its version when the server reports one, else its data-repo update state; names a pending import or a running provision. */
export function alateHint(h: AlateHealthState): string {
	if (h.state === "down") return "server unreachable";
	const flags = [
		h.running === true ? "provision running" : null,
		h.behind ? "update available" : null,
		// While the provision consumes the import, "pending" adds nothing.
		h.pending && h.running !== true ? "import pending" : null,
	].filter((f) => f !== null);
	if (h.version !== null)
		return `version ${h.version}${flags.length > 0 ? ` · ${flags.join(" · ")}` : ""}`;
	return flags.length > 0 ? flags.join(" · ") : "up to date";
}

/** Consecutive `down` health probes (15 s apart) after which Settings stops following a provision. */
export const ALATE_WATCH_MAX_DOWN = 4;
/** Longest time Settings follows a provision that alate keeps reporting as running. */
export const ALATE_WATCH_DEADLINE_MS = 30 * 60_000;

/** Next step of the Settings watch on a provision that outlived the board's wait: keep
 *  waiting, or stop because the run finished, alate stopped answering (`downs` counts the
 *  consecutive `down` probes including this one), or the deadline passed. */
export function provisionWatchStep(
	h: AlateHealthState,
	downs: number,
	elapsedMs: number,
): "wait" | "finished" | "lost" | "expired" {
	if (h.state === "ok" && h.running !== true) return "finished";
	if (h.state === "down" && downs >= ALATE_WATCH_MAX_DOWN) return "lost";
	return elapsedMs >= ALATE_WATCH_DEADLINE_MS ? "expired" : "wait";
}

/** Scrolls to the section once it exists: the page remounts on a settings navigation, so the
 *  poll waits out the mount instead of racing it, and a second pass re-scrolls after the async
 *  sections above finish loading. Returns the cancel — a caller with a lifecycle (the
 *  deep-link effect, a test) stops the wait instead of leaving timers behind. */
function scrollToSectionWhenPresent(sectionId: string): () => void {
	const scroll = () => {
		const el = document.getElementById(sectionId);
		el?.scrollIntoView({ block: "start" });
		el?.focus({ preventScroll: true });
	};
	let tries = 0;
	let re: ReturnType<typeof setTimeout> | undefined;
	const t = setInterval(() => {
		if (document.getElementById(sectionId) !== null) {
			clearInterval(t);
			scroll();
			re = setTimeout(scroll, 600);
		} else if (++tries > 40) {
			clearInterval(t);
		}
	}, 50);
	return () => {
		clearInterval(t);
		clearTimeout(re);
	};
}

/** Opens Settings at the given section: navigate like a history entry, then wait the
 *  scroll out. Advisory link only — it never runs provisioning. The returned cancel
 *  stops the scroll wait; fire-and-forget callers may drop it. */
export function openSettingsSection(
	sectionId: string,
	view: string = SETTINGS_HASH,
): () => void {
	settingsNavigate(view, sectionId);
	return scrollToSectionWhenPresent(sectionId);
}

/** Settings "Alate" section: provisioning config + one-shot provision trigger. */
export function AlateSection() {
	const [url, setUrl] = useState("");
	const [conn, setConn] = useState("");
	const [health, setHealth] = useState<AlateHealthState | null>(null);
	const [keySet, setKeySet] = useState(false);
	const [key, setKey] = useState("");
	const [lastErr, setLastErr] = useState<string | null>(null);
	const [saved, flashSaved] = useFlash(1500);
	const [error, setError] = useState<string | null>(null);
	const [status, setStatus] = useState<string | null>(null);
	const [results, setResults] = useState<
		Array<{ script: string; code: number; output: string; truncated: boolean }>
	>([]);
	const [storedKey, setStoredKey] = useState<string | null>(null);
	const [reveal, setReveal] = useState(false);
	const [copied, flashCopied] = useFlash(1500);
	// The row's own error state: the section-level error paragraph would print a
	// key failure twice (here and below the form).
	const [keyError, setKeyError] = useState<string | null>(null);
	const keyBusy = useBusy();
	const revealKey = (): void => {
		if (keyBusy.busy) return;
		setKeyError(null);
		if (storedKey !== null) {
			setReveal(!reveal);
			return;
		}
		setReveal(true);
		keyBusy.start(async () => {
			try {
				setStoredKey(
					(
						await unwrap<{ apiKey: string }>(
							await fetch("/api/settings/alate-key"),
						)
					).apiKey,
				);
				return true;
			} catch (err) {
				setReveal(false);
				setKeyError(err instanceof Error ? err.message : String(err));
				return false;
			}
		});
	};
	const copyKey = (): void => {
		if (keyBusy.busy) return;
		setKeyError(null);
		if (storedKey !== null) {
			copyText(storedKey).then(flashCopied, (err) =>
				setKeyError(err instanceof Error ? err.message : String(err)),
			);
			return;
		}
		keyBusy.start(async () => {
			try {
				const k = (
					await unwrap<{ apiKey: string }>(
						await fetch("/api/settings/alate-key"),
					)
				).apiKey;
				setStoredKey(k);
				await copyText(k);
				flashCopied();
				return true;
			} catch (err) {
				setKeyError(err instanceof Error ? err.message : String(err));
				return false;
			}
		});
	};
	const regenerateKey = async (): Promise<void> => {
		if (
			!(await confirmDialog(
				"Regenerate the Alate API key? The board switches to the new key and alate dashboard sessions end.",
				{ ok: "Regenerate", danger: true },
			))
		)
			return;
		setKeyError(null);
		keyBusy.start(async () => {
			// Raw read: a failed rotate may still carry the new key in the body.
			try {
				const res = await fetch("/api/settings/alate-key", { method: "POST" });
				const body = await res.json().catch(() => ({}));
				if (typeof body.apiKey === "string" && body.apiKey !== "") {
					setStoredKey(body.apiKey);
					setReveal(true);
				}
				if (!res.ok) {
					setKeyError(
						typeof body.error === "string"
							? body.error
							: `Regenerate failed (HTTP ${res.status}).`,
					);
					return false;
				}
				return true;
			} catch (err) {
				setKeyError(err instanceof Error ? err.message : String(err));
				return false;
			}
		});
	};
	const save = useBusy();
	const prov = useBusy();
	// Start time of the watch on a provision that alate reported running when the board's
	// HTTP wait ended at its transport bound; the health probe below, not the abandoned
	// wait, reports the outcome. `null` while no watch runs.
	const [watchSince, setWatchSince] = useState<number | null>(null);
	// False until GET /api/alate answers: the chip must not claim "Not configured" before it knows.
	const [loaded, setLoaded] = useState(false);
	const awaiting = watchSince !== null;
	// Consecutive `down` probes during the watch.
	const watchDowns = useRef(0);
	const loadHealth = useCallback(
		(u: string, isLive: () => boolean = () => true) => {
			if (u === "") {
				setHealth(null);
				return;
			}
			fetch("/api/alate/health")
				.then((res) => unwrap<AlateHealth>(res))
				.then((h) => {
					if (!isLive()) return;
					setHealth({
						state: "ok",
						version: typeof h.version === "string" ? h.version : null,
						behind: h.update?.behind === true,
						pending: h.pending === true,
						running: h.running === true,
					});
				})
				.catch(() => {
					if (isLive()) setHealth({ state: "down" });
				});
		},
		[],
	);
	// Follow a known in-flight provision with the health probe until it converges.
	useEffect(() => {
		if (!awaiting) return;
		const iv = setInterval(() => loadHealth(conn), 15_000);
		return () => clearInterval(iv);
	}, [awaiting, conn, loadHealth]);
	useEffect(() => {
		if (watchSince === null || health === null) return;
		watchDowns.current = health.state === "down" ? watchDowns.current + 1 : 0;
		const step = provisionWatchStep(
			health,
			watchDowns.current,
			Date.now() - watchSince,
		);
		if (step === "wait") return;
		setWatchSince(null);
		if (step === "finished") {
			setStatus(
				health.state === "ok" && health.pending
					? "Provisioning ended, but alate still holds an unprovisioned import — check the alate dashboard for script output."
					: "Provisioning finished successfully.",
			);
			return;
		}
		setStatus("Provisioning state unknown.");
		setError(
			step === "lost"
				? "The alate server stopped answering while it provisioned. Check the alate dashboard, then provision again."
				: `alate still reports a running provision after ${ALATE_WATCH_DEADLINE_MS / 60_000} minutes. Check the alate dashboard.`,
		);
	}, [watchSince, health]);
	useEffect(() => {
		let live = true;
		fetch("/api/alate")
			.then((res) =>
				unwrap<{
					url: string | null;
					keySet: boolean;
					lastProvisionError: string | null;
				}>(res),
			)
			.then((cfg) => {
				if (!live) return;
				setUrl(cfg.url ?? "");
				setConn(cfg.url ?? "");
				setKeySet(cfg.keySet);
				setLoaded(true);
				setLastErr(cfg.lastProvisionError);
				loadHealth(cfg.url ?? "", () => live);
			})
			.catch((err: unknown) => {
				if (live) setError(err instanceof Error ? err.message : String(err));
			});
		return () => {
			live = false;
		};
	}, [loadHealth]);
	const submit = (): void =>
		save.start(async () => {
			setError(null);
			try {
				const body: Record<string, string> = {};
				if (url.trim() !== "") body.url = url.trim();
				const k = key.trim();
				if (k !== "") body.key = k;
				const cfg = await post<{
					url: string | null;
					keySet: boolean;
					lastProvisionError: string | null;
				}>("/api/alate", body);
				setUrl(cfg.url ?? "");
				setConn(cfg.url ?? "");
				setKeySet(cfg.keySet);
				setLastErr(cfg.lastProvisionError);
				loadHealth(cfg.url ?? "");
				setKey("");
				flashSaved();
				return true;
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				return false;
			}
		});
	const provision = (): void =>
		prov.start(async () => {
			setError(null);
			setStatus(null);
			setResults([]);
			try {
				const res = await post<{
					ok: boolean;
					running?: boolean;
					results?: Array<{
						script: string;
						code: number;
						output: string;
						truncated: boolean;
					}>;
				}>("/api/alate/provision", {});
				if (res.running === true) {
					// 202 from the board: its wait hit the transport bound, and alate's
					// health reported the run as still running. Not a failure — the
					// health probe follows the run until it converges, alate stops
					// answering, or the deadline passes. Drop the probe snapshot taken
					// before the click: it predates the run, so the convergence effect
					// must wait for the fresh read below.
					setHealth(null);
					setStatus(
						"Provisioning is still running on the alate server; the hint above follows it.",
					);
					watchDowns.current = 0;
					setWatchSince(Date.now());
					loadHealth(conn);
					return true;
				}
				const rows = res.results ?? [];
				setResults(rows);
				loadHealth(conn);
				if (res.ok) setLastErr(null);
				const failed = rows.filter((r) => r.code !== 0);
				setStatus(
					failed.length === 0
						? `Provisioned ${rows.length} script${rows.length === 1 ? "" : "s"} successfully.`
						: `Provisioning failed: ${failed.length} of ${rows.length} script${rows.length === 1 ? "" : "s"} exited non-zero.`,
				);
				return res.ok;
			} catch (err) {
				setStatus("Provisioning failed.");
				setError(err instanceof Error ? err.message : String(err));
				return false;
			}
		});
	return (
		<SettingsCard
			id="alate-section"
			title="Alate"
			status={loaded ? alateChip(conn, keySet, health, lastErr) : undefined}
			hint="alate provisions omp rules, settings, skills and plugins from the data repo it is configured with; provisioning asks the alate server API, so the server must be running."
		>
			{conn !== "" && (
				<p className="hint">
					<a href={conn} target="_blank" rel="noreferrer">
						Open the alate dashboard
					</a>
					{health !== null && <> · {alateHint(health)}</>}
				</p>
			)}
			{lastErr !== null && (
				<p className="auth-error" role="alert">
					Last automatic provision failed: {lastErr}
				</p>
			)}
			<form
				className="settings-form"
				onSubmit={(e) => {
					e.preventDefault();
					submit();
				}}
			>
				<div className="alate-def-rows">
					<div className="alate-def-row">
						<div className="alate-def-name">
							<b>
								Alate server URL
								<Help
									label="Alate server URL"
									text="Where the alate server runs. The board asks this server to provision rules, settings, skills and plugins to the workers."
								/>
								<span className="opt-mark">(optional)</span>
							</b>
							<code>http(s) URL</code>
						</div>
						<label>
							<input
								type="url"
								value={url}
								onChange={(e) => setUrl(e.target.value)}
								spellCheck={false}
								placeholder="http://127.0.0.1:4570"
								aria-label="Alate server URL"
							/>
						</label>
					</div>
					<div className="alate-def-row">
						<div className="alate-def-name">
							<b>
								Alate API key
								<Help
									label="Alate API key"
									text="The key that the alate server prints at its first start. The board sends it with each provisioning request."
								/>
								<span className="opt-mark">(optional)</span>
							</b>
							<code>secret · stored, never shown</code>
						</div>
						<label>
							<input
								type="password"
								value={key}
								onChange={(e) => setKey(e.target.value)}
								placeholder={keySet ? "••••••••••••" : undefined}
								autoComplete="off"
								aria-label="Alate API key"
							/>
						</label>
					</div>
					{conn !== "" && keySet && (
						<div className="alate-def-row">
							<div className="alate-def-name">
								<b>
									Stored API key
									<Help
										label="Stored API key"
										text="This is the key the board stores for alate. Reveal or copy it to sign in to the alate dashboard. Regenerate rotates it on the alate server, and dashboard sessions end."
									/>
								</b>
								<code>secret · hidden until revealed</code>
							</div>
							<div className="access-row">
								<div className="access-key">
									<code>
										{reveal && storedKey !== null ? storedKey : "••••••••••••"}
									</code>
									<button
										type="button"
										className="icon"
										aria-pressed={reveal}
										aria-label={
											reveal ? "Hide Alate API key" : "Reveal Alate API key"
										}
										title={
											reveal ? "Hide Alate API key" : "Reveal Alate API key"
										}
										onClick={revealKey}
										disabled={keyBusy.busy}
									>
										{keyBusy.busy && storedKey === null ? (
											<span className="spinner" aria-hidden="true" />
										) : (
											<Icon name={reveal ? "eye-off" : "eye"} />
										)}
									</button>
								</div>
								<button
									type="button"
									className="icon"
									aria-label={copied ? "Copied" : "Copy Alate API key"}
									title={copied ? "Copied" : "Copy Alate API key"}
									onClick={copyKey}
								>
									<Icon name={copied ? "check" : "copy"} />
								</button>
								<button
									type="button"
									className="icon danger"
									aria-label="Regenerate Alate API key"
									title="Regenerate Alate API key"
									onClick={regenerateKey}
									disabled={keyBusy.busy}
								>
									{keyBusy.busy ? (
										<span className="spinner" aria-hidden="true" />
									) : (
										<Icon name="refresh-cw" />
									)}
								</button>
							</div>
							{keyError !== null && (
								<p className="auth-error" role="alert">
									{keyError}
								</p>
							)}
						</div>
					)}
				</div>
				<div className="alate-def-actions">
					<button
						type="submit"
						disabled={save.busy}
						className={save.failed ? "failed" : undefined}
					>
						{save.busy && <span className="spinner" aria-hidden="true" />}
						<SaveLabel saved={saved} />
					</button>
					<button
						type="button"
						onClick={provision}
						disabled={prov.busy || awaiting}
						className={`primary${health?.state === "ok" && health.pending ? " attention" : ""}`}
					>
						{(prov.busy || awaiting) && (
							<span className="spinner" aria-hidden="true" />
						)}
						{awaiting ? "Provisioning…" : "Provision"}
					</button>
				</div>
			</form>
			{error !== null && (
				<p className="auth-error" role="alert">
					{error}
				</p>
			)}
			<p className="hint" aria-live="polite">
				{status}
			</p>
			{results.map((r) => (
				<div key={r.script}>
					<p className={r.code === 0 ? "hint" : "auth-error"}>
						{r.script} — exit {r.code}
					</p>
					<pre className="log">{r.output}</pre>
				</div>
			))}
		</SettingsCard>
	);
}

/** The settings page: General for machine-wide knobs, one page per project, at #settings. */

type ChipTone = "ok" | "warn" | "off";

/** One definition row: name and value shape on the left, the value on the right. An input row
 *  explains itself only in its "?" popover (`help`); a read-only fact shows `desc` instead.
 *  `action` sits on the value's line at the right (the Save of a card's one typed field).
 *  DefRow, CheckRow and SaveCard implement DESIGN.md's Settings-Row Rule: follow it for new settings. */
function DefRow({
	name,
	desc,
	shape,
	help,
	optional,
	action,
	children,
}: {
	name: string;
	desc?: string;
	shape?: string;
	help?: string;
	/** Marks an optional field with a dim "(optional)" after the name (rows with an
	 *  `empty = …` shape line already say it and skip the mark). */
	optional?: boolean;
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="alate-def-row">
			<div className="alate-def-name">
				<b>
					{name}
					{help !== undefined && <Help label={name} text={help} />}
					{optional === true && <span className="opt-mark">(optional)</span>}
				</b>
				{desc !== undefined && <span>{desc}</span>}
				{shape !== undefined && <code>{shape}</code>}
			</div>
			{action === undefined ? (
				children
			) : (
				<div className="alate-def-actions">
					{children}
					{action}
				</div>
			)}
		</div>
	);
}

/** Save status beside a control that saves on its own. The live region stays mounted so each
 *  change is announced: a spinner while a slow save runs (CSS delays it, so a quick save shows
 *  none), then a check that draws itself and fades; a failed save says so. */
function SaveTick({
	busy,
	saved,
	failed,
}: {
	busy: boolean;
	saved: boolean;
	failed: boolean;
}) {
	return (
		<span className="save-tick" role="status">
			{busy ? (
				<>
					<span className="spinner" aria-hidden="true" />
					<span className="sr">Saving</span>
				</>
			) : failed ? (
				<span className="save-tick-failed">Not saved</span>
			) : saved ? (
				<svg viewBox="0 0 16 16" role="img" aria-label="Saved">
					<path d="M3 8.5l3.2 3.1L13 4.6" />
				</svg>
			) : null}
		</span>
	);
}

/** One on/off setting, GitHub style: the checkbox leads, the bold name and the description
 *  sit to its right. A change saves at once; the box shows the new value until the board
 *  state catches up, and rolls back if the save fails. `sub` indents a dependent option. */
function CheckRow({
	name,
	tag,
	desc,
	checked,
	disabled,
	sub,
	save,
	act,
}: {
	name: string;
	/** Text or nodes; a dependent row puts its link to the master switch here. */
	desc: ReactNode;
	/** A short muted pill after the name, e.g. "Not needed: private repo". Put the same fact
	 *  in `desc` too: the pill is hidden from screen readers. */
	tag?: string;
	/** The saved value. */
	checked: boolean;
	disabled?: boolean;
	sub?: boolean;
	save: (checked: boolean) => Promise<unknown>;
	act: Act;
}) {
	const id = useId();
	const s = useOptimisticValue(checked, act);
	return (
		<div
			className={`alate-def-row check-row${sub === true ? " check-sub" : ""}`}
		>
			<input
				id={id}
				type="checkbox"
				checked={s.value}
				disabled={disabled || s.busy}
				onChange={(e) => {
					const v = e.target.checked;
					s.set(v);
					s.run(() => save(v));
				}}
				aria-describedby={`${id}-desc`}
			/>
			<div className="alate-def-name">
				<b>
					<label htmlFor={id}>{name}</label>
					{tag !== undefined && (
						<span className="state-chip off" aria-hidden="true">
							{tag}
						</span>
					)}
					<SaveTick busy={s.busy} saved={s.saved} failed={s.failed} />
				</b>
				<span id={`${id}-desc`}>{desc}</span>
			</div>
		</div>
	);
}

/** A settings card whose typed fields save together: the rows sit in one form with one Save
 *  button. The button submits natively, so required and min/max checks run before anything is
 *  sent; Enter in a field saves the same way. With several typed fields the Save sits in the
 *  footer; a card with one typed field passes a function as children and puts the Save it gets
 *  on that field's line (DefRow `action`). */
function SaveCard({
	dirty,
	save,
	act,
	children,
	...card
}: Omit<SettingsCardProps, "footer" | "children"> & {
	dirty: boolean;
	save: () => Promise<unknown>;
	act: Act;
	children: ReactNode | ((saveButton: ReactNode) => ReactNode);
}) {
	const s = useInstantSave(act);
	const formId = useId();
	const button = <SaveButton form={formId} s={s} dirty={dirty} />;
	const inline = typeof children === "function";
	return (
		<SettingsCard {...card} footer={inline ? undefined : button}>
			<form
				id={formId}
				className="alate-def-rows"
				onSubmit={(e) => {
					e.preventDefault();
					if (dirty) s.run(save);
				}}
			>
				{inline ? children(button) : children}
			</form>
		</SettingsCard>
	);
}

/** Updates chip: how many of the Updates card's checkboxes are on (saved values, not the
 *  draft). Friction filter counts only while Retro is on, as it is disabled otherwise. */
export function updatesChip(s: ProjectView["settings"]): {
	label: string;
	tone: ChipTone;
} {
	const retro = s.retroSince !== null;
	const flags = [
		s.holdUpdateMerges,
		s.forkMergeHold,
		retro,
		retro && s.retroFilter,
		s.forkResearch,
		s.trendingScout,
		s.prReviews,
		s.prMode,
		s.issueWatch,
		s.microVm,
		s.pushSyncCommits,
	];
	const on = flags.filter(Boolean).length;
	return {
		label: `${on} of ${flags.length} on`,
		tone: on > 0 ? "ok" : "off",
	};
}

type SettingsCardProps = {
	id?: string;
	title: string;
	hint?: ReactNode;
	/** The card's state chip; `icon` leads the label (e.g. a crossed-out bell for off). */
	status?: { label: string; tone: ChipTone; icon?: IconName };
	footer?: ReactNode;
	className?: string;
	children: ReactNode;
};

/** One settings card: title, optional state chip and hint, body, optional Save footer. */
function SettingsCard({
	id,
	title,
	hint,
	status,
	footer,
	className,
	children,
}: SettingsCardProps) {
	const titleId = id === undefined ? undefined : `${id}-title`;
	return (
		<section
			className={
				className === undefined ? "settings-sec" : `settings-sec ${className}`
			}
			id={id}
			aria-labelledby={titleId}
			tabIndex={-1}
		>
			<div className="sec-head">
				<div className="sec-title">
					<h3 id={titleId}>{title}</h3>
					{status !== undefined && (
						<span className={`state-chip ${status.tone}`}>
							{status.icon !== undefined && (
								<Icon name={status.icon} size={12} />
							)}
							{status.label}
						</span>
					)}
				</div>
				{hint != null && <p className="hint">{hint}</p>}
			</div>
			{children}
			{footer != null && <div className="sec-foot">{footer}</div>}
		</section>
	);
}

/** General settings: topic groups, their cards and a card's sub-blocks, in page order; the TOC and scroll-spy read it. */
export const SETTINGS_TOC = [
	{
		id: "board-group",
		label: "Board",
		sections: [
			{ id: "runners-section", label: "Runners" },
			{ id: "projects-section", label: "Projects" },
			{ id: "notifications-section", label: "Notifications" },
		],
	},
	{
		id: "access-group",
		label: "Access",
		sections: [
			{ id: "api-key-section", label: "API key" },
			{ id: "session-section", label: "Session" },
			{ id: "omp-stats-section", label: "omp usage" },
		],
	},
	{
		id: "git-group",
		label: "Git and secrets",
		sections: [
			{
				id: "git-hosts-section",
				label: "Git hosts",
				blocks: [
					{ id: "github-host-block", label: "GitHub host" },
					{ id: "github-token-block", label: "GitHub token" },
					{ id: "github-app-block", label: "GitHub App" },
					{ id: "host-tokens-block", label: "Other host tokens" },
					{ id: "ssh-key-block", label: "Global SSH key" },
				],
			},
			{ id: "env-section", label: "Env" },
		],
	},
	{
		id: "agents-group",
		label: "Agents",
		sections: [
			{ id: "signin-section", label: "Provider sign-in" },
			{ id: "model-roles-section", label: "Model roles" },
			{ id: "alate-section", label: "Alate" },
			{ id: "hindsight-section", label: "Hindsight" },
		],
	},
] as const;

/** One-project page: topic groups and their cards, in page order; the TOC and scroll-spy read it. */
const PROJECT_TOC = [
	{
		id: "project-group",
		label: "Project",
		sections: [
			{ id: "project-icon-section", label: "Icon" },
			{ id: "project-identity-section", label: "Identity" },
		],
	},
	{
		id: "project-work-group",
		label: "Work",
		sections: [
			{ id: "project-runners-section", label: "Runners" },
			{ id: "project-worktrees-section", label: "Worktrees" },
			{ id: "project-messages-section", label: "Messages" },
		],
	},
	{
		id: "project-reviews-group",
		label: "Releases and reviews",
		sections: [
			{ id: "project-releases-section", label: "Releases" },
			{ id: "project-reviews-section", label: "Reviews" },
			{ id: "project-updates-section", label: "Updates" },
		],
	},
	{
		id: "project-git-group",
		label: "Git",
		sections: [{ id: "project-ssh-section", label: "SSH key" }],
	},
	{
		id: "project-danger-group",
		label: "Danger zone",
		sections: [{ id: "project-remove-section", label: "Remove project" }],
	},
] as const;

type TocSection = {
	readonly id: string;
	readonly label: string;
	readonly blocks?: readonly { readonly id: string; readonly label: string }[];
};

/** Every TOC target in page order: each card, then its sub-blocks. */
const tocIds = (sections: readonly TocSection[]): string[] =>
	sections.flatMap((s) => [s.id, ...(s.blocks ?? []).map((b) => b.id)]);

type TocProps = {
	/** The page's hash, so a pick scrolls without leaving the page. */
	hash: string;
	active: string | null;
	onPick: (id: string) => void;
};

export type TocGroup = {
	readonly id: string;
	readonly label: string;
	readonly sections: readonly TocSection[];
};

/** Host-level cards and blocks that hosted mode hides (docs/specs/hosted-mode.md section 7):
 *  the control plane and the operator own them, so the tenant never sees them. */
const HOSTED_HIDDEN: ReadonlySet<string> = new Set([
	"runners-section",
	"projects-section",
	"api-key-section",
	"session-section",
	"omp-stats-section",
	// Hosted git uses per-project control-plane tokens only (section 6), so no host token,
	// GitHub setting or server SSH key on this card does anything there.
	"git-hosts-section",
	"signin-section",
	"model-roles-section",
	"alate-section",
	"hindsight-section",
	"project-updates-section",
]);

/** The card that holds each sub-block: a block hides with its card. */
const BLOCK_CARD: ReadonlyMap<string, string> = new Map(
	SETTINGS_TOC.flatMap((g): readonly TocSection[] => g.sections).flatMap((s) =>
		(s.blocks ?? []).map((b) => [b.id, s.id] as const),
	),
);

/** True when the page must not render the card or block with this TOC id. */
export const hostedHidden = (hosted: boolean, id: string): boolean =>
	hosted && HOSTED_HIDDEN.has(BLOCK_CARD.get(id) ?? id);

/** Hosted mode for the board's components; App provides it, and every other render reads
 *  false. A link to a settings card checks `hostedHidden` with it, so no link targets a
 *  hidden card. */
export const HostedContext = createContext(false);

/** The page's TOC: the general or the one-project page. Hosted mode drops the hidden cards
 *  and blocks, then every group left without a card, so no TOC link dangles. */
export function pageToc(
	general: boolean,
	hosted: boolean,
): readonly TocGroup[] {
	const groups: readonly TocGroup[] = general ? SETTINGS_TOC : PROJECT_TOC;
	if (!hosted) return groups;
	return groups
		.map((g) => ({
			...g,
			sections: g.sections
				.filter((s) => !hostedHidden(hosted, s.id))
				.map((s) =>
					s.blocks === undefined
						? s
						: {
								...s,
								blocks: s.blocks.filter((b) => !hostedHidden(hosted, b.id)),
							},
				),
		}))
		.filter((g) => g.sections.length > 0);
}

/** The settings map: the page as a lineage-style tree (groups, their cards one indent in,
 *  sub-blocks one more): hollow nodes on a 1px thread, an elbow into each level, and the
 *  current entry as the one steel node. One group (a project page) drops the group level. */
function SettingsMap({
	groups,
	hash,
	active,
	onPick,
}: TocProps & { groups: readonly TocGroup[] }) {
	const named = groups.length > 1;
	const flat = groups.flatMap((g) =>
		g.sections.flatMap((s) => [
			{ g, s, id: s.id, label: s.label, depth: 1 },
			...(s.blocks ?? []).map((b) => ({
				g,
				s,
				id: b.id,
				label: b.label,
				depth: 2,
			})),
		]),
	);
	const hi = Math.max(
		0,
		flat.findIndex((x) => x.id === active),
	);
	if (flat.length === 0) return null;
	const state = (i: number) => (i < hi ? "past" : i === hi ? "here" : "ahead");
	type MapNode = {
		id: string;
		label: string;
		depth: number;
		state: string;
		kids: MapNode[];
	};
	const node = (
		id: string,
		label: string,
		depth: number,
		kids: MapNode[] = [],
	): MapNode => ({
		id,
		label,
		depth,
		state: state(flat.findIndex((x) => x.id === id)),
		kids,
	});
	const cards = (g: TocGroup): MapNode[] =>
		g.sections.map((s) =>
			node(
				s.id,
				s.label,
				1,
				(s.blocks ?? []).map((b) => node(b.id, b.label, 2)),
			),
		);
	const tree: MapNode[] = named
		? groups.map((g) => ({
				id: g.sections[0]?.id ?? "",
				label: g.label,
				depth: 0,
				state: "group",
				kids: cards(g),
			}))
		: groups.flatMap(cards);
	const branch = (nodes: MapNode[]) =>
		nodes.map((n) => (
			<li
				key={`${n.depth}-${n.label}`}
				data-depth={n.depth}
				data-state={n.state}
			>
				<button
					type="button"
					className="smap-row"
					aria-current={n.state === "here" ? "location" : undefined}
					onClick={() => {
						onPick(n.id);
						openSettingsSection(n.id, hash);
					}}
				>
					{n.label}
				</button>
				{n.kids.length > 0 && <ol>{branch(n.kids)}</ol>}
			</li>
		));
	return (
		<div className="smap">
			<ol className="smap-tree" aria-label="On this page">
				{branch(tree)}
			</ol>
		</div>
	);
}

export function SettingsPage({
	projects,
	tasks,
	maxTotal,
	reviewCheck,
	workCheck,
	idleReviews,
	trendingScan,
	trendingStatus,
	act,
	view,
	openTask,
	hosted,
}: {
	projects: ProjectView[];
	tasks: TaskCard[];
	maxTotal: number | null;
	reviewCheck: boolean;
	workCheck: boolean;
	idleReviews: boolean;
	trendingScan: boolean;
	trendingStatus: TrendingStatus;
	act: Act;
	view: string;
	/** Opens a card in the board drawer: the Reviews card's counter links its review card. */
	openTask: (id: string) => void;
	/** Hosted mode (docs/specs/hosted-mode.md): the host-level cards are hidden. */
	hosted?: boolean;
}) {
	const sub = settingsSub(view);
	const project =
		sub.project === null
			? null
			: (projects.find((p) => p.name === sub.project) ?? null);
	const allocated = projects.reduce(
		(sum, p) => sum + (p.settings.maxParallel ?? 0),
		0,
	);
	const general = project === null;
	const host = hosted === true;
	const shown = (id: string): boolean => !hostedHidden(host, id);
	// A group renders only while the TOC keeps it: hosted mode drops a group with no card left.
	const groupShown = (id: string): boolean =>
		pageToc(general, host).some((g) => g.id === id);
	const [active, setActive] = useState<string | null>(null);
	// The clicked entry stays current until the user scrolls, because the end of the page can show several cards.
	const pinned = useRef<string | null>(null);
	const onPick = (id: string) => {
		pinned.current = id;
		setActive(id);
	};
	// Scroll-spy: the last card whose top passed a reading line near the scroll root's top is current; at the bottom, the last card.
	// The line stays above the shortest card's height, so a short card scrolled to the top never hands over to the next one.
	useEffect(() => {
		pinned.current = null;
		const ids = tocIds(
			pageToc(general, host).flatMap((g): readonly TocSection[] => g.sections),
		);
		const pick = () => {
			if (pinned.current !== null) return;
			let root = document.getElementById(ids[0] ?? "")?.parentElement ?? null;
			while (
				root !== null &&
				!/auto|scroll/.test(getComputedStyle(root).overflowY)
			)
				root = root.parentElement;
			const r = root ?? document.documentElement;
			const box = root?.getBoundingClientRect() ?? {
				top: 0,
				height: window.innerHeight,
			};
			if (
				r.scrollTop > 0 &&
				r.scrollTop + r.clientHeight >= r.scrollHeight - 2
			) {
				setActive(ids[ids.length - 1] ?? null);
				return;
			}
			const line = box.top + Math.min(120, box.height * 0.3);
			let cur = ids[0] ?? null;
			for (const id of ids) {
				const top = document.getElementById(id)?.getBoundingClientRect().top;
				if (top !== undefined && top <= line) cur = id;
			}
			setActive(cur);
		};
		// ponytail: capture-phase scroll listener instead of an observer; it sees scrolls of any container and fires for tall cards crossing the line.
		const unpin = () => {
			pinned.current = null;
			pick();
		};
		const opts = { capture: true, passive: true };
		document.addEventListener("scroll", pick, opts);
		for (const t of ["wheel", "touchstart", "keydown"])
			document.addEventListener(t, unpin, opts);
		pick();
		return () => {
			document.removeEventListener("scroll", pick, { capture: true });
			for (const t of ["wheel", "touchstart", "keydown"])
				document.removeEventListener(t, unpin, { capture: true });
		};
	}, [general, host, view]);
	// Deep links: the URL's fragment names a TOC id of this page. Read it on mount and on
	// Back/Forward, pin it like a TOC pick, and wait the scroll out like a TOC click. An
	// unknown or malformed fragment opens the page normally, without scrolling.
	useEffect(() => {
		let cancel: (() => void) | null = null;
		const apply = () => {
			cancel?.();
			cancel = null;
			let id = location.hash.slice(1);
			try {
				id = decodeURIComponent(id);
			} catch {
				// A malformed escape names nothing; give up.
				return;
			}
			if (
				!tocIds(
					pageToc(general, host).flatMap(
						(g): readonly TocSection[] => g.sections,
					),
				).includes(id)
			)
				return;
			pinned.current = id;
			setActive(id);
			cancel = scrollToSectionWhenPresent(id);
		};
		apply();
		window.addEventListener("popstate", apply);
		return () => {
			window.removeEventListener("popstate", apply);
			cancel?.();
		};
	}, [general, host, view]);
	const map = (
		<SettingsMap
			groups={pageToc(general, host)}
			hash={general ? SETTINGS_HASH : view}
			active={active}
			onPick={onPick}
		/>
	);
	return (
		<div className="settings-page">
			<nav className="settings-nav" aria-label="Settings sections">
				{/* Own grammar, not the main rail's boxed rows: a text index, the current page on the steel edge. */}
				<a
					className="snb"
					href={settingsPath(null)}
					aria-current={general ? "page" : undefined}
					onClick={(e) => navClick(e, () => settingsNavigate(SETTINGS_HASH))}
				>
					General
				</a>
				{general && map}
				<p className="snb-label">Projects</p>
				{projects.map((p) => (
					<Fragment key={p.name}>
						<a
							className="snb"
							href={settingsPath(p.name)}
							aria-current={project?.name === p.name ? "page" : undefined}
							onClick={(e) =>
								navClick(e, () =>
									settingsNavigate(`${SETTINGS_HASH}/${p.name}`),
								)
							}
						>
							{projectLabel(p)}
						</a>
						{project?.name === p.name && map}
					</Fragment>
				))}
			</nav>
			<div className="settings-content" key={view}>
				<h1>Settings</h1>
				{project === null ? (
					<>
						<details className="settings-toc-mobile">
							<summary>
								On this page
								<Icon name="chevron-right" size={16} />
							</summary>
							{map}
						</details>
						{groupShown("board-group") && (
							<section
								className="settings-group"
								id="board-group"
								aria-labelledby="board-group-title"
								tabIndex={-1}
							>
								<h2 className="settings-group-title" id="board-group-title">
									Board
								</h2>
								{shown("runners-section") && (
									<TotalRunnersForm
										maxTotal={maxTotal}
										reviewCheck={reviewCheck}
										workCheck={workCheck}
										idleReviews={idleReviews}
										trendingScan={trendingScan}
										trendingStatus={trendingStatus}
										allocated={allocated}
										act={act}
									/>
								)}
								{shown("projects-section") && (
									<ProjectsOrderSection projects={projects} act={act} />
								)}
								<NotificationsSection projects={projects} act={act} />
							</section>
						)}
						{groupShown("access-group") && (
							<section
								className="settings-group"
								id="access-group"
								aria-labelledby="access-group-title"
								tabIndex={-1}
							>
								<h2 className="settings-group-title" id="access-group-title">
									Access
								</h2>
								{shown("api-key-section") && <ApiKeySection />}
								{shown("session-section") && <SessionSection />}
								{shown("omp-stats-section") && <OmpStatsSection />}
							</section>
						)}
						{groupShown("git-group") && (
							<section
								className="settings-group"
								id="git-group"
								aria-labelledby="git-group-title"
								tabIndex={-1}
							>
								<h2 className="settings-group-title" id="git-group-title">
									Git and secrets
								</h2>
								{shown("git-hosts-section") && <GitHostsSection />}
								<EnvSection />
							</section>
						)}
						{groupShown("agents-group") && (
							<section
								className="settings-group"
								id="agents-group"
								aria-labelledby="agents-group-title"
								tabIndex={-1}
							>
								<h2 className="settings-group-title" id="agents-group-title">
									Agents
								</h2>
								{shown("signin-section") && <ProviderLoginSection />}
								{shown("model-roles-section") && <ModelRolesSection />}
								{shown("alate-section") && <AlateSection />}
								{shown("hindsight-section") && <HindsightSection />}
							</section>
						)}
					</>
				) : (
					<>
						<details className="settings-toc-mobile">
							<summary>
								On this page
								<Icon name="chevron-right" size={16} />
							</summary>
							{map}
						</details>
						<ProjectSettingsForm
							key={project.name}
							project={project}
							tasks={tasks}
							trendingScan={trendingScan}
							act={act}
							openTask={openTask}
							hosted={host}
						/>
					</>
				)}
			</div>
		</div>
	);
}

/** The Reviews card's counter line. Three forms: counted from a review's frozen base (the sha
 * links to the commit when the project has a GitHub remote), no full review yet, and a review
 * open on top of either. The card id opens the review card that set the base. */
function ReviewCounter({
	review,
	github,
	tasks,
	openTask,
}: {
	review: ArchReview;
	github: string | null;
	tasks: TaskCard[];
	openTask: (id: string) => void;
}) {
	const cardId = review.reviewCardId;
	const card =
		cardId === null ? null : (tasks.find((t) => t.id === cardId) ?? null);
	return (
		<>
			{review.base === null ? (
				<>No full review yet: all {review.delta} commits count</>
			) : (
				<>
					{review.delta} of {review.cap} commits since{" "}
					{github !== null ? (
						<a
							href={`${github}/commit/${review.base}`}
							target="_blank"
							rel="noopener noreferrer"
							title={`Commit ${review.base}`}
						>
							<code>{review.base.slice(0, 7)}</code>
						</a>
					) : (
						<code>{review.base.slice(0, 7)}</code>
					)}
				</>
			)}
			{cardId !== null && (
				<>
					{" · "}
					<button
						type="button"
						className="ghost"
						onClick={() => openTask(cardId)}
						aria-label={`Open review card #${cardId}`}
					>
						#{cardId}
					</button>
					{card?.doneAt != null && <> done {stamp(card.doneAt)}</>}
				</>
			)}
			{review.running && <> · review open</>}
		</>
	);
}

/** One project's settings page: identity, slots, worktrees, releases, reviews, messages, removal. */
export function ProjectSettingsForm({
	project,
	tasks,
	trendingScan,
	act,
	openTask,
	hosted,
}: {
	project: ProjectView;
	tasks: TaskCard[];
	/** The board's general "Weekly trending scan" switch: a project's Trending scout
	 *  never runs while it is off, so the row shows that state. */
	trendingScan: boolean;
	act: Act;
	/** Opens a card in the board drawer: the Reviews card's counter links its review card. */
	openTask: (id: string) => void;
	/** Hosted mode (docs/specs/hosted-mode.md): the Updates card is hidden. */
	hosted?: boolean;
}) {
	const [mp, setMp] = useState(
		project.settings.maxParallel === null
			? ""
			: String(project.settings.maxParallel),
	);
	const [cap, setCap] = useState(String(project.settings.archReviewCap));
	const [mi, setMi] = useState(String(project.settings.maxImages));
	const [kwd, setKwd] = useState(String(project.settings.keptWorktreeDays));
	const [extra, setExtra] = useState(project.settings.copyExtra.join("\n"));
	const [relcmd, setRelcmd] = useState(project.settings.releaseCommand ?? "");
	const [tb, setTb] = useState(project.settings.targetBranch ?? "");
	const [label, setLabel] = useState(project.settings.displayName ?? "");
	const [marker, setMarker] = useState(project.settings.iconText ?? "");
	const st = project.settings;
	// Private repo: fork research, PR reviews and issue watch have no outside activity to watch.
	// null = unknown (no remote, still loading, or the check failed); then no mark shows.
	const [privateRepo, setPrivateRepo] = useState<boolean | null>(null);
	useEffect(() => {
		setPrivateRepo(null);
		if (project.github === null) return;
		let live = true;
		const run = async (): Promise<void> => {
			try {
				const r = await unwrap<{ private: boolean }>(
					await fetch(
						`/api/projects/${encodeURIComponent(project.name)}/github/visibility`,
					),
				);
				if (live) setPrivateRepo(r.private);
			} catch {
				// The mark is a hint only: an unknown visibility shows no mark.
			}
		};
		void run();
		return () => {
			live = false;
		};
	}, [project.name, project.github]);
	const privateTag =
		privateRepo === true ? "Not needed: private repo" : undefined;
	const privateNote = (what: string): string =>
		privateRepo === true ? `Private repo: no outside ${what}. ` : "";
	const [prefix, setPrefix] = useState(st.taskIdPrefix ?? "");
	const icon = useInstantSave(act);
	const markerSave = useInstantSave(act);
	const markerFormId = useId();
	const markerDirty = marker.trim() !== (st.iconText ?? "");
	// The setup wizard, opened by Open setup.
	const [setupOpen, setSetupOpen] = useState(false);
	const removable = !tasks.some(
		(t) =>
			t.project === project.name &&
			(t.state === "queued" ||
				t.state === "preparing" ||
				t.state === "running"),
	);
	const paths = extra
		.split("\n")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	const parallel =
		mp.trim() === "" ? null : clamp(Math.trunc(Number(mp)) || 1, 1, Infinity);
	const reviewCap = clamp(Math.trunc(Number(cap)) || 1, 1, 10000);
	const imagesMax = Math.max(1, Math.trunc(Number(mi)) || 1);
	// A blank field is caught by the input's required on submit, never clamped to min.
	const keepDays = clamp(Math.trunc(Number(kwd)), 0, 365);
	/** One settings patch; the server takes any subset of the fields. */
	const send = (patch: Record<string, unknown>): Promise<ProjectView> =>
		post<ProjectView>(
			`/api/projects/${encodeURIComponent(project.name)}/settings`,
			patch,
		);
	return (
		<>
			<div className="settings-head" id="project-head" tabIndex={-1}>
				<h2>{projectLabel(project)}</h2>
				<button
					type="button"
					className="ghost"
					onClick={() => setSetupOpen(true)}
					title="Open the setup wizard at the Rules step for this project"
				>
					<Icon name="list-checks" size={13} />
					Open setup
				</button>
			</div>
			<section
				className="settings-group"
				id="project-group"
				aria-labelledby="project-group-title"
				tabIndex={-1}
			>
				<h2 className="settings-group-title" id="project-group-title">
					Project
				</h2>
				<SettingsCard
					id="project-icon-section"
					title="Icon"
					status={
						st.iconText
							? { label: "Text", tone: "ok" }
							: project.icon !== null
								? { label: "Uploaded", tone: "ok" }
								: { label: "Default", tone: "off" }
					}
				>
					<div className="alate-def-rows">
						<DefRow
							name="Project icon"
							help="An image that replaces the project's letters on the board. Without one, Ottr uses the repo owner's avatar or the host's favicon, and then the letters."
							shape="PNG, JPEG, WebP or GIF"
						>
							<div className="icon-row">
								<span className="icon-preview">
									<ProjectTag project={project} />
								</span>
								{/* The label keeps the hidden input keyboard-operable: tab to it, Enter opens the picker. */}
								<label className="icon-upload ghost">
									Upload
									<input
										type="file"
										accept="image/png,image/jpeg,image/webp,image/gif"
										onChange={(e) => {
											const file = e.target.files?.[0];
											e.target.value = "";
											if (!file) return;
											icon.run(async () => {
												const res = await fetch(
													`/api/projects/${encodeURIComponent(project.name)}/icon`,
													{ method: "POST", body: file },
												);
												if (!res.ok) {
													let error = `HTTP ${res.status}`;
													try {
														const data = (await res.json()) as {
															error?: string;
														};
														if (typeof data.error === "string")
															error = data.error;
													} catch {
														// non-JSON error body; keep the HTTP status text
													}
													throw new Error(error);
												}
											});
										}}
									/>
								</label>
								{project.icon !== null && (
									<button
										type="button"
										className="danger"
										disabled={icon.busy}
										onClick={async () => {
											if (
												!(await confirmDialog(
													"Delete the uploaded icon? The project falls back to its source icon or letters.",
													{ ok: "Delete icon", danger: true },
												))
											)
												return;
											icon.run(async () => {
												const res = await fetch(
													`/api/projects/${encodeURIComponent(project.name)}/icon`,
													{ method: "DELETE" },
												);
												if (!res.ok) throw new Error(`HTTP ${res.status}`);
											});
										}}
									>
										Delete icon
									</button>
								)}
								<SaveTick
									busy={icon.busy}
									saved={icon.saved}
									failed={icon.failed}
								/>
							</div>
						</DefRow>
						<DefRow
							name="Text marker"
							action={
								<SaveButton
									form={markerFormId}
									s={markerSave}
									dirty={markerDirty}
								/>
							}
							help="Up to 4 characters shown on the plate instead of any icon: this upload, the owner's avatar or the host's favicon. Empty shows the images again."
							shape="Up to 4 characters"
							optional
						>
							<form
								id={markerFormId}
								onSubmit={(e) => {
									e.preventDefault();
									if (markerDirty)
										markerSave.run(() =>
											send({ iconText: marker.trim() || null }),
										);
								}}
							>
								<label>
									<input
										type="text"
										maxLength={4}
										value={marker}
										onChange={(e) => setMarker(e.target.value)}
										placeholder="e.g. OT"
										aria-label="Text marker"
									/>
								</label>
							</form>
						</DefRow>
					</div>
				</SettingsCard>
				{/* Both typed fields save through one footer Save: a prefix change renames the
					project route, so one deliberate save for the card fits. */}
				<SaveCard
					id="project-identity-section"
					act={act}
					dirty={
						label.trim() !== (st.displayName ?? "") ||
						prefix.trim().toUpperCase() !== (st.taskIdPrefix ?? "")
					}
					save={async () => {
						const r = await send({
							displayName: label.trim() || null,
							taskIdPrefix: prefix.trim() || null,
						});
						if (r.name !== project.name)
							settingsNavigate(`${SETTINGS_HASH}/${r.name}`);
					}}
					title="Identity"
					status={
						project.github !== null
							? { label: "GitHub", tone: "ok" }
							: project.gitless
								? { label: "No git", tone: "off" }
								: { label: "Local git", tone: "off" }
					}
				>
					<DefRow
						name="Display name"
						optional
						help="A friendly name for the board. The folder and the repo keep their real names."
					>
						<label>
							<input
								type="text"
								maxLength={60}
								value={label}
								onChange={(e) => setLabel(e.target.value)}
								placeholder={project.name}
								aria-label="Display name"
							/>
						</label>
					</DefRow>
					<DefRow
						name="Task ID prefix"
						help="The handle in task ids, like OTTR in OTTR-429. Empty uses the folder-derived handle."
						shape="empty = from folder name"
					>
						<label>
							<input
								type="text"
								maxLength={8}
								value={prefix}
								onChange={(e) => setPrefix(e.target.value)}
								placeholder={project.taskPrefix}
								aria-label="Task ID prefix"
							/>
						</label>
					</DefRow>
					{/* Facts, not fields: the folder and the GitHub repo are fixed at add time. */}
					<DefRow
						name="Folder path"
						desc="Where the project lives on the board's machine. Ottr sets it when you add the project."
					>
						<code>{project.path}</code>
					</DefRow>
					{project.github !== null && (
						<DefRow
							name="GitHub"
							desc="The project's GitHub repository. GitHub-only features, such as PR reviews and fork research, use it."
						>
							<a
								href={project.github}
								target="_blank"
								rel="noopener noreferrer"
							>
								{project.github}
							</a>
						</DefRow>
					)}
				</SaveCard>
			</section>
			<section
				className="settings-group"
				id="project-work-group"
				aria-labelledby="project-work-group-title"
				tabIndex={-1}
			>
				<h2 className="settings-group-title" id="project-work-group-title">
					Work
				</h2>
				<SaveCard
					id="project-runners-section"
					act={act}
					dirty={parallel !== st.maxParallel}
					save={() => send({ maxParallel: parallel })}
					title="Runners"
					status={
						project.settings.maxParallel === null
							? { label: "No cap", tone: "off" }
							: { label: `Cap ${project.settings.maxParallel}`, tone: "ok" }
					}
				>
					{(save) => (
						<>
							<DefRow
								name="Runner cap"
								action={save}
								help="The most tasks of this project that run at the same time. The board-wide runner cap still applies."
								shape="empty = no cap"
							>
								<label>
									<input
										type="number"
										min={1}
										value={mp}
										onChange={(e) => setMp(e.target.value)}
										aria-label="Runner cap"
									/>
								</label>
							</DefRow>
						</>
					)}
				</SaveCard>
				<SaveCard
					id="project-worktrees-section"
					act={act}
					dirty={
						tb.trim() !== (st.targetBranch ?? "") ||
						paths.join("\n") !== st.copyExtra.join("\n") ||
						keepDays !== st.keptWorktreeDays
					}
					save={() =>
						send({
							targetBranch: tb.trim() || null,
							copyExtra: paths,
							keptWorktreeDays: keepDays,
						})
					}
					title="Worktrees"
					status={
						project.settings.copyExtra.length > 0
							? {
									label: `${project.settings.copyExtra.length} extra path${project.settings.copyExtra.length === 1 ? "" : "s"}`,
									tone: "ok",
								}
							: { label: "No extra paths", tone: "off" }
					}
					hint={
						'A card that kept its worktree ("Kept the worktree: …" after a turn, "Cancel kept the worktree: …" after a cancel) sits until you answer it. After the idle days below (0 = immediately) the supervisor quarantines its untracked files into .tasks/quarantine and removes the worktree — but only when no tracked change or unpushed commit would be lost.'
					}
				>
					<DefRow
						name="Target branch"
						help="The branch on origin that finished cards merge into. Leave empty to use the repo's default branch (origin/HEAD), or the main checkout's upstream when origin/HEAD is missing."
						shape="branch name · empty = default"
					>
						<label>
							<input
								type="text"
								maxLength={200}
								placeholder="main"
								aria-label="Target branch for merges"
								value={tb}
								onChange={(e) => setTb(e.target.value)}
							/>
						</label>
					</DefRow>
					<DefRow
						name="Extra paths"
						help="Files that git ignores but agents need, for example local config. Ottr copies them into each new worktree."
						shape="one path per line"
					>
						<label>
							<textarea
								rows={3}
								value={extra}
								onChange={(e) => setExtra(e.target.value)}
								placeholder="scripts/release.mjs"
								aria-label="Extra paths"
							/>
						</label>
					</DefRow>
					<DefRow
						name="Quarantine after"
						help="How long a kept worktree can stay idle. Then Ottr moves its untracked files to .tasks/quarantine and removes the worktree, but only when no work would be lost."
						shape="days · 0 = immediately"
					>
						<label>
							<input
								type="number"
								min={0}
								max={365}
								required
								value={kwd}
								onChange={(e) => setKwd(e.target.value)}
								aria-label="Quarantine kept worktrees after this many idle days"
							/>
						</label>
					</DefRow>
				</SaveCard>
				<SaveCard
					id="project-messages-section"
					act={act}
					dirty={imagesMax !== st.maxImages}
					save={() => send({ maxImages: imagesMax })}
					title="Messages"
					status={{
						label: `${project.settings.maxImages} image${project.settings.maxImages === 1 ? "" : "s"}`,
						tone: "off",
					}}
				>
					{(save) => (
						<>
							<DefRow
								name="Max images"
								action={save}
								help="The most images you can attach to one message: a new task, a reply, a follow-up or a steer."
								shape="1 or more"
							>
								<label>
									<input
										type="number"
										min={1}
										required
										value={mi}
										onChange={(e) => setMi(e.target.value)}
										aria-label="Max images per message"
									/>
								</label>
							</DefRow>
						</>
					)}
				</SaveCard>
			</section>
			<section
				className="settings-group"
				id="project-reviews-group"
				aria-labelledby="project-reviews-group-title"
				tabIndex={-1}
			>
				<h2 className="settings-group-title" id="project-reviews-group-title">
					Releases and reviews
				</h2>
				<SaveCard
					id="project-releases-section"
					act={act}
					dirty={relcmd.trim() !== (st.releaseCommand ?? "")}
					save={() => send({ releaseCommand: relcmd.trim() || null })}
					title="Releases"
					status={
						project.settings.releaseCommand !== null
							? { label: "Own command", tone: "ok" }
							: { label: "Ottr publishes", tone: "off" }
					}
					hint="Runs in the release worktree after the review approves, instead of Ottr's tag and GitHub release. It gets OTTR_RELEASE_VERSION, OTTR_RELEASE_COMMIT, OTTR_RELEASE_NOTES_FILE and OTTR_ARCH_REVIEW (commits since the last review). Must push the tag. Empty: Ottr tags and publishes itself."
				>
					{(save) => (
						<>
							<DefRow
								name="Release command"
								action={save}
								help="A script that publishes the release after the review approves it. Empty: Ottr makes the git tag and the GitHub release itself."
								shape="empty = Ottr tags and publishes"
							>
								<label>
									<input
										type="text"
										maxLength={300}
										value={relcmd}
										onChange={(e) => setRelcmd(e.target.value)}
										placeholder="node scripts/release.mjs --ottr"
										aria-label="Release command"
									/>
								</label>
							</DefRow>
						</>
					)}
				</SaveCard>
				<SaveCard
					id="project-reviews-section"
					act={act}
					dirty={reviewCap !== st.archReviewCap}
					save={() => send({ archReviewCap: reviewCap })}
					title="Reviews"
					status={{
						label: `Every ${project.settings.archReviewCap} commits`,
						tone: "off",
					}}
				>
					{(save) => (
						<>
							<DefRow
								name="Review interval"
								action={save}
								help="Ottr marks a review as due after this many new commits on the target branch."
								shape="1 to 10000"
							>
								<label>
									<input
										type="number"
										min={1}
										max={10000}
										required
										value={cap}
										onChange={(e) => setCap(e.target.value)}
										aria-label="Review due after this many commits on the target"
									/>
								</label>
							</DefRow>
							{project.archReview != null && (
								<p className="hint">
									<ReviewCounter
										review={project.archReview}
										github={project.github}
										tasks={tasks}
										openTask={openTask}
									/>
								</p>
							)}
						</>
					)}
				</SaveCard>
				{!hostedHidden(hosted === true, "project-updates-section") && (
					<SettingsCard
						id="project-updates-section"
						title="Updates"
						status={updatesChip(project.settings)}
					>
						<div className="alate-def-rows">
							{/* U7: hold update-card merges at needs_you until a reply approves them. */}
							<CheckRow
								name="Hold update merges"
								desc="Update cards wait at needs_you after a ready turn; your reply approves the merge"
								checked={st.holdUpdateMerges}
								save={(v) => send({ holdUpdateMerges: v })}
								act={act}
							/>
							{/* OTTR-689: hold fork-born card merges at needs_you until a reply approves them. */}
							<CheckRow
								name="Hold fork-born merges"
								desc="Fork-born cards wait at needs_you; your reply approves the merge of the card's work before it reaches the target branch. Turning this off does not release parked cards"
								checked={st.forkMergeHold}
								save={(v) => send({ forkMergeHold: v })}
								act={act}
							/>
							<CheckRow
								name="Retro"
								desc="After each done task the supervisor proposes follow-up cards from its retro"
								checked={st.retroSince !== null}
								save={(v) => send({ retro: v })}
								act={act}
							/>
							<CheckRow
								sub
								name="Friction filter"
								desc="Keep only retro proposals that fix a friction the task hit; needs Retro"
								checked={st.retroFilter}
								disabled={st.retroSince === null}
								save={(v) => send({ retroFilter: v })}
								act={act}
							/>
							<CheckRow
								name="Fork research"
								desc={`${privateNote("forks to watch")}Hourly watch of the project's GitHub forks; analysis files held proposals; fork-born merges need approval`}
								tag={privateTag}
								checked={st.forkResearch}
								save={(v) => send({ forkResearch: v })}
								act={act}
							/>
							<CheckRow
								name="Trending scout"
								desc={
									!trendingScan ? (
										<>
											The general 'Weekly trending scan' switch is off, so the
											scout never runs — turn it on in{" "}
											<a
												href={`${settingsPath(null)}#runners-section`}
												onClick={(e) =>
													navClick(e, () =>
														openSettingsSection("runners-section"),
													)
												}
											>
												General settings
											</a>
											. Weekly: an agent judges GitHub trending repos for this
											project and files up to 3 backlog proposals
										</>
									) : (
										"Weekly, when the general 'Weekly trending scan' is on: an agent judges GitHub trending repos for this project and files up to 3 backlog proposals"
									)
								}
								checked={st.trendingScout}
								disabled={!trendingScan && !st.trendingScout}
								save={(v) => send({ trendingScout: v })}
								act={act}
							/>
							<CheckRow
								name="PR reviews"
								desc={`${project.github === null ? "Needs a GitHub remote. " : ""}${privateNote("pull requests to review")}Hourly watch of open pull requests on GitHub; each new head gets a read-only review draft you can post as a comment`}
								tag={privateTag}
								checked={st.prReviews}
								disabled={project.github === null && !st.prReviews}
								save={(v) => send({ prReviews: v })}
								act={act}
							/>
							<CheckRow
								name="PR mode"
								desc={`${project.github === null ? "Needs a GitHub remote. " : ""}Push finished card branches and open a pull request to the target branch instead of merging; the card waits in Merging until the pull request merges on GitHub`}
								checked={st.prMode}
								disabled={project.github === null && !st.prMode}
								save={(v) => send({ prMode: v })}
								act={act}
							/>
							<CheckRow
								name="Issue watch"
								desc={`${project.github === null ? "Needs a GitHub remote. " : ""}${privateNote("issues to watch")}Hourly watch of GitHub issues opened after you turn this on; each new issue becomes a backlog card and gets the ottr-tracked label`}
								tag={privateTag}
								checked={st.issueWatch}
								disabled={project.github === null && !st.issueWatch}
								save={(v) => send({ issueWatch: v })}
								act={act}
							/>
							<CheckRow
								name="Run work turns in microVMs"
								desc={`${project.vmRunner.ok ? "" : project.vmRunner.configured ? `vm-runner is not ready (${project.vmRunner.reason ?? "no answer"})${st.microVm ? "; work turns wait until it is" : ""}. ` : "Needs OTTR_VM_RUNNER_URL (docker compose --profile vm). "}Each work turn runs in its own Firecracker microVM with a fresh clone; merge turns stay on the board.`}
								checked={st.microVm}
								disabled={!project.vmRunner.ok && !st.microVm}
								save={(v) => send({ microVm: v })}
								act={act}
							/>
							<CheckRow
								name="Push sync commits"
								desc="When the local target branch holds commits origin lacks, the board pushes it to origin on its own (OTTR-531); off needs the board's Push to origin button"
								checked={st.pushSyncCommits}
								save={(v) => send({ pushSyncCommits: v })}
								act={act}
							/>
						</div>
					</SettingsCard>
				)}
			</section>
			{setupOpen && (
				<SetupWizardModal
					project={project}
					act={act}
					rulesTask={
						liveCardOf(
							tasks.filter((t) => t.project === project.name),
							"interview",
						)?.id ?? null
					}
					openTask={openTask}
					onClose={() => setSetupOpen(false)}
				/>
			)}
			<section
				className="settings-group"
				id="project-git-group"
				aria-labelledby="project-git-group-title"
				tabIndex={-1}
			>
				<h2 className="settings-group-title" id="project-git-group-title">
					Git
				</h2>
				<SshKeySection project={project} />
			</section>
			<section
				className="settings-group"
				id="project-danger-group"
				aria-labelledby="project-danger-group-title"
				tabIndex={-1}
			>
				<h2 className="settings-group-title" id="project-danger-group-title">
					Danger zone
				</h2>
				<SettingsCard
					id="project-remove-section"
					className="settings-danger"
					title="Remove project"
					hint={
						<>
							Removes the project {projectLabel(project)} from this Ottr board.
							Nothing is deleted: its folder, repo, and task history stay on
							disk. Adding the folder again brings the project back here.
						</>
					}
					footer={
						<BusyButton
							className="danger"
							disabled={!removable}
							title={
								removable
									? undefined
									: "Cancel the queued and running tasks first."
							}
							run={async () =>
								(await confirmDialog(
									`Remove ${projectLabel(project)} from this board? The folder, the repo and the task history stay on disk.`,
									{ ok: "Remove project", danger: true },
								))
									? act(async () => {
											await post(
												`/api/projects/${encodeURIComponent(project.name)}/remove`,
												{},
											);
											settingsNavigate(SETTINGS_HASH);
										})
									: Promise.resolve(true)
							}
						>
							Remove project
						</BusyButton>
					}
				>
					{null}
				</SettingsCard>
			</section>
		</>
	);
}
