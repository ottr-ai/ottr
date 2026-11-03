import type { ReactNode } from "react";
import {
	Fragment,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { joinLevel, splitLevel, THINKING_LEVELS } from "../levels.ts";
import { forProvider } from "../quota.ts";
import type {
	AppCheck,
	GitHubAppView,
	GithubFacts,
	Learning,
	ProjectView,
	TaskCard,
} from "../types.ts";
import {
	type Act,
	BusyButton,
	CloseButton,
	clamp,
	copyText,
	Help,
	Icon,
	interviewMsg,
	logOut,
	Mark,
	Meter,
	Modal,
	ProjectTag,
	post,
	projectLabel,
	QuotaRow,
	unwrap,
	useBusy,
	useFlash,
	useQuota,
} from "./kit.tsx";
import {
	addRoleError,
	classifyRolesSave,
	ownField,
	type RolesState,
	rolesDirty,
	roleWarnings,
	seedStep,
	useModels,
} from "./models.ts";
import { SETTINGS_HASH, settingsSub } from "./route.ts";
import { refreshState } from "./socket.ts";

/** Save-button body: the brief saved confirmation, else the plain label. */
function SaveLabel({ saved }: { saved: boolean }) {
	return saved ? (
		<span role="status">
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
	act,
	onNotice,
	onClose,
}: {
	project: ProjectView;
	/** Add response verdict for a fresh project: "queued" means the rules card is already filed. */
	interview?: string;
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

	/** One interview call; its verdict becomes a board notice. */
	const runInterview = (
		body: Record<string, unknown>,
		after?: () => void,
	): Promise<boolean> =>
		act(async () => {
			const r = await post<{ interview: string }>(
				`/api/projects/${encodeURIComponent(view.name)}/interview`,
				body,
			);
			onNotice?.(interviewMsg(r.interview));
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
									Init git repository
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
									Align rules now
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
									Start rules interview
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
								<p className="hint loading">
									<span className="spinner" aria-hidden="true" />
									Loading GitHub facts
								</p>
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
					</section>
				</>
			)}
			{step === 4 && (
				<section className="setup-sec">
					<h3>Runners</h3>
					<label className="settings-field">
						Max tasks of this project running at once (empty = no cap)
						<input
							type="number"
							min={1}
							max={8}
							value={mp}
							onChange={(e) => setMp(e.target.value)}
						/>
					</label>
					<label className="settings-field">
						Extra paths copied into new worktrees (one per line)
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

/** The wizard as its own dialog: Run setup again (settings page) and Open setup (checklist). */
export function SetupWizardModal({
	project,
	act,
	onNotice,
	onClose,
}: {
	project: ProjectView;
	act: Act;
	onNotice?: (message: string) => void;
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
					onClose={onClose}
				/>
			</div>
		</Modal>
	);
}

/** The save-state contract next to a settings Save button: what happened, or what will. */
function SaveStateChip({
	dirty,
	saving,
	failed,
	saved,
	dirtyNote,
}: {
	dirty: boolean;
	saving: boolean;
	failed: boolean;
	saved: boolean;
	dirtyNote?: string;
}) {
	if (failed)
		return (
			<span className="save-chip failed" role="status">
				Save failed — press Save
			</span>
		);
	if (saving)
		return (
			<span className="save-chip saving" role="status">
				<span className="spinner" aria-hidden="true" />
				Saving…
			</span>
		);
	if (saved)
		return (
			<span className="save-chip saved" role="status">
				<Mark kind="done" />
				Saved
			</span>
		);
	if (dirty)
		return (
			<span className="save-chip dirty" role="status">
				{dirtyNote ?? "Unsaved changes"}
			</span>
		);
	return null;
}

function TotalRunnersForm({
	maxTotal,
	reviewCheck,
	workCheck,
	allocated,
	act,
}: {
	maxTotal: number | null;
	reviewCheck: boolean;
	workCheck: boolean;
	allocated: number;
	act: Act;
}) {
	const [n, setN] = useState(maxTotal === null ? "" : String(maxTotal));
	const [chk, setChk] = useState(reviewCheck);
	const [wchk, setWchk] = useState(workCheck);
	const [saved, flashSaved] = useFlash(1500);
	const save = useBusy();
	const next =
		n.trim() === "" ? null : clamp(Math.trunc(Number(n)), 1, Infinity);
	// The cap counts as edited only when the input moved off the server value: an
	// untouched input must not save its clamped form (a server cap below 1, e.g.
	// OMP_TRACKER_MAX_TOTAL=0, would otherwise jump to 1 on a checkbox toggle).
	// An empty input means "no cap"; it saves only when it moved off the server's.
	const capEdited = n !== (maxTotal === null ? "" : String(maxTotal));
	const dirty =
		(capEdited && next !== maxTotal) ||
		chk !== reviewCheck ||
		wchk !== workCheck;
	const doSave = (): void =>
		save.start(() =>
			act(async () => {
				// Send only what changed: an untouched cap must not overwrite the server's.
				await post(
					"/api/settings",
					capEdited
						? { maxTotal: next, reviewCheck: chk, workCheck: wchk }
						: { reviewCheck: chk, workCheck: wchk },
				);
				flashSaved();
			}),
		);
	// Scalars are safe to auto-save: the debounce only fires after the last
	// keystroke, and the value is clamped before it goes out. Paths and secrets
	// never auto-save (a half-typed value must not reach the server).
	// biome-ignore lint/correctness/useExhaustiveDependencies: doSave closes over the current n and chk; these are the debounce key
	useEffect(() => {
		if (!dirty) return;
		const t = setTimeout(doSave, 900);
		return () => clearTimeout(t);
	}, [n, maxTotal, chk, reviewCheck, wchk, workCheck]);
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
			footer={
				<>
					<SaveStateChip
						dirty={dirty}
						saving={save.busy}
						failed={save.failed}
						saved={saved}
						dirtyNote="Autosaves in a moment"
					/>
					<button
						type="button"
						className={`settings-save${save.failed ? " failed" : ""}`}
						disabled={save.busy || !dirty}
						onClick={() => {
							void doSave();
						}}
					>
						{save.busy && <span className="spinner" aria-hidden="true" />}
						<SaveLabel saved={saved} />
					</button>
				</>
			}
		>
			<form
				className="settings-form"
				onSubmit={(e) => {
					e.preventDefault();
					void doSave();
				}}
			>
				<div className="alate-def-rows">
					<div className="alate-def-row">
						<div className="alate-def-name">
							<b>
								Runner cap
								<Help
									label="Runner cap"
									text="The most agent turns that run at the same time on this board. Other tasks wait in Todo until a slot is free. Each project can also set its own cap."
								/>
							</b>
							<span>How many agents may run at once, across all projects</span>
							<code>empty = no cap · autosaves</code>
						</div>
						<label>
							<input
								type="number"
								min={1}
								value={n}
								onChange={(e) => setN(e.target.value)}
								aria-label="Runner cap across all projects (empty = no cap)"
							/>
						</label>
					</div>
					<div className="alate-def-row">
						<div className="alate-def-name">
							<b>
								Review check
								<Help
									label="Review check"
									text="A second model reads each finding of a review before Ottr files it as a card, so weak findings do not reach the board."
								/>
							</b>
							<span>
								Check a review's findings with a second model before they become
								cards
							</span>
						</div>
						<label>
							<input
								type="checkbox"
								checked={chk}
								onChange={(e) => setChk(e.target.checked)}
								aria-label="Check a review's findings with a second model"
							/>
						</label>
					</div>
					<div className="alate-def-row">
						<div className="alate-def-name">
							<b>
								Work check
								<Help
									label="Work check"
									text="When a work turn reports ready, a second model without the turn's memory checks the result before the card enters the merge queue."
								/>
							</b>
							<span>
								Check a work card with a second model before it enters the merge
								queue
							</span>
						</div>
						<label>
							<input
								type="checkbox"
								checked={wchk}
								onChange={(e) => setWchk(e.target.checked)}
								aria-label="Check a work card with a second model before it enters the merge queue"
							/>
						</label>
					</div>
				</div>
			</form>
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

/** Settings "Push" section: one-button Web Push opt-in for closed-phone alerts. */
function PushSection() {
	const [enabled, setEnabled] = useState(false);
	const [sent, setSent] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const busy = useBusy();
	// Real state, not last-click: the flag reflects whether this device holds a subscription.
	useEffect(() => {
		void navigator.serviceWorker
			?.getRegistration()
			.then((reg) => reg?.pushManager.getSubscription())
			.then((sub) => setEnabled(sub != null))
			.catch(() => {});
	}, []);
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
				return true;
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				return false;
			}
		});
	const test = (): void =>
		busy.start(async () => {
			setError(null);
			setSent(false);
			try {
				await post("/api/push/test", {});
				setSent(true);
				return true;
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				return false;
			}
		});
	return (
		<SettingsCard
			id="push-section"
			title="Push"
			help="Sends a phone notification when a card needs you, also when the board is closed. Turn it on in each browser or phone. It needs HTTPS."
			status={
				enabled ? { label: "On", tone: "ok" } : { label: "Off", tone: "off" }
			}
			hint="Get a phone notification when a task needs you, even when the app is closed. Works over HTTPS (e.g. tailscale serve)."
		>
			<button type="button" onClick={enable} disabled={busy.busy || enabled}>
				{busy.busy && <span className="spinner" aria-hidden="true" />}
				{enabled ? "Push enabled" : "Enable push notifications"}
			</button>{" "}
			<button type="button" onClick={test} disabled={busy.busy}>
				{busy.busy && <span className="spinner" aria-hidden="true" />}
				{sent ? "Test push sent" : "Send test push"}
			</button>
			{error !== null && (
				<p className="auth-error" role="alert">
					{error}
				</p>
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
	const regenerate = (): void => {
		if (
			!window.confirm(
				"Regenerate the API key? Integrations using the old key stop working.",
			)
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
			help="Lets scripts and integrations call the board's API without a login. If the key leaks, regenerate it. Integrations with the old key then stop working."
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

/** Settings "Session" section: rotate the session secret, revoking every browser's login. */
function SessionSection() {
	const busy = useBusy();
	const signOutEverywhere = (): void => {
		if (
			!window.confirm(
				"Sign out everywhere? Every browser, including this one, must log in again.",
			)
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
			help="Sign out everywhere ends every login session on every device. Use it when you lose a device or a session cookie leaks."
			hint="Logout in the top bar signs out only this browser. If a device is lost or a cookie escaped, sign out everywhere: every login session is revoked."
		>
			<button
				type="button"
				className="icon danger"
				aria-label="Sign out everywhere"
				title="Sign out everywhere"
				onClick={signOutEverywhere}
				disabled={busy.busy}
			>
				{busy.busy ? (
					<span className="spinner" aria-hidden="true" />
				) : (
					<Icon name="log-out" />
				)}
			</button>
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
							<span>
								{tokenSet === true
									? captionSet
									: tokenSet === false
										? captionUnset
										: captionUnknown}
							</span>
							{expiryText !== null && <span>{expiryText}</span>}
							<code>secret · stored, never shown</code>
						</div>
						<label>
							<input
								type="password"
								value={token}
								onChange={(e) => setToken(e.target.value)}
								placeholder={tokenSet ? "••••••••••••" : undefined}
								autoComplete="off"
								spellCheck={false}
								aria-label={label}
								required
							/>
						</label>
					</div>
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
			{check.missing.length === 0 ? (
				<p className="hint notif-line">
					<Mark kind="done" />
					<span>
						{check.repos.length === 0
							? "No board project has a GitHub repo."
							: `Installed on all ${check.repos.length} board repos.`}
					</span>
				</p>
			) : (
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
		</>
	);
}

/** The one trust+test prompt, shared by the add form, the global key and a project key.
 *  `send` performs the call (with the confirmed fingerprints as `trust` on a retry); this
 *  component renders the action, an aria-live result, and on a 409 the host's fingerprints
 *  with a Trust-and-retry button. A changed host key takes the warning style. */
export function SshTestRow({
	send,
	label = "Test",
	success = "Test passed",
	onOk,
}: {
	send: (trust?: string[]) => Promise<TestAnswer>;
	label?: string;
	success?: string;
	onOk?: () => void;
}) {
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
	// "Save and test" retries as "Trust and test"; "Add" as "Trust and add".
	const retryLabel = `Trust and ${label.toLowerCase().replace(/^save and /, "")}`;
	return (
		<div>
			<button type="button" disabled={busy} onClick={() => run()}>
				{busy && <span className="spinner" aria-hidden="true" />}
				{label}
			</button>
			<div aria-live="polite">
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
			<button type="button" disabled={busy} onClick={() => make({})}>
				{busy && <span className="spinner" aria-hidden="true" />}
				Generate
			</button>
			<label>
				Paste private key
				<textarea
					rows={3}
					value={pasted}
					onChange={(e) => setPasted(e.target.value)}
					spellCheck={false}
					autoComplete="off"
				/>
			</label>
			<button
				type="button"
				disabled={busy || pasted.trim() === ""}
				onClick={() => make({ privateKey: pasted })}
			>
				Import
			</button>
			{error !== null && (
				<p className="auth-error" role="alert">
					{error}
				</p>
			)}
			{pending !== null && (
				<div className="pending-key">
					<label>
						Public key — add it as a deploy key with write access on your host
						<textarea
							readOnly
							rows={3}
							value={pending.publicKey}
							spellCheck={false}
							onFocus={(e) => e.currentTarget.select()}
						/>
					</label>
					<button
						type="button"
						onClick={() => void copyText(pending.publicKey)}
					>
						Copy
					</button>
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
function GitHostsSection() {
	const [state, setState] = useState<GitHostsView | null>(null);
	const [error, setError] = useState<string | null>(null);
	// Add-token form; `replace` pre-fills it from a listed token.
	const [tHost, setTHost] = useState("");
	const [tUser, setTUser] = useState("oauth2");
	const [tToken, setTToken] = useState("");
	const [tUrl, setTUrl] = useState("");
	const tBusy = useBusy();
	// GitHub App flow: the key is write-only, the server never returns it.
	const [appFormOpen, setAppFormOpen] = useState(false);
	const [appId, setAppId] = useState("");
	const [appKey, setAppKey] = useState("");
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
	const saveToken = (): void => {
		tBusy.start(() =>
			run(async () => {
				const { status, data } = await gitReq("POST", "/api/git-hosts/tokens", {
					host: tHost.trim(),
					username: tUser.trim() || "oauth2",
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
			if (!window.confirm(`Remove the stored token for ${host}?`)) return true;
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
				!window.confirm(
					"Remove the global SSH key? Projects then clone over https or fail.",
				)
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
	const saveApp = async (): Promise<boolean> => {
		const id = appId.trim();
		if (!/^\d+$/.test(id)) throw new Error("App ID must be numeric");
		if (appKey === "") throw new Error("Private key is required");
		const { status, data } = await gitReq("POST", "/api/git-hosts/github-app", {
			id,
			key: appKey,
		});
		if (status !== 200) throw new Error(asError(data, status));
		setAppId("");
		setAppKey("");
		setAppFormOpen(false);
		await load();
		return true;
	};
	const removeApp = (): Promise<boolean> =>
		run(async () => {
			if (
				!window.confirm(
					"Remove the GitHub App? Reviews then post under your own identity.",
				)
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
	return (
		<SettingsCard
			id="git-hosts-section"
			title="Git hosts"
			status={gitHostsChip(state)}
			hint="The GitHub token serves the board's own git and releases. Other HTTPS tokens and the server-side SSH key serve clones, fetches and pushes on any git host. Agents on workers never receive them."
		>
			<div className="sec-block" id="github-token-block" tabIndex={-1}>
				<h4>GitHub token</h4>
				<p className="hint">
					The board's git fetches, pushes and publishes releases with this
					token. Agents on workers never receive it.
				</p>
				<SecretTokenForm<{ tokenSet: boolean; expiresAt: string | null }>
					endpoint="/api/settings/github-token"
					title="GitHub token"
					help="The board uses this token for its own git fetches, pushes and GitHub releases. Agents on workers never get it."
					label="GitHub token"
					captionSet="Set. Paste a new token to replace it"
					captionUnset="Not set: fetch and push fail"
					captionUnknown="Unknown: the check failed"
					expiry={(cfg) => expiryLine(cfg.expiresAt)}
				/>
				{state !== null && (
					<p className="hint">
						{state.githubHost === null
							? "GitHub host: OTTR_GITHUB_HOST is invalid — use a bare hostname, for example acme.ghe.com"
							: state.githubHost === "github.com"
								? "GitHub host: github.com (default)"
								: `GitHub host: ${state.githubHost} (GitHub Enterprise)`}
					</p>
				)}
			</div>
			<div className="sec-block" id="github-app-block" tabIndex={-1}>
				<h4>
					GitHub App
					<Help
						label="GitHub App"
						text="Optional. When it is set, posted PR reviews show as the app (a bot account) instead of your own GitHub account."
					/>
				</h4>
				{state !== null && state.githubApp !== null && !appFormOpen ? (
					<div>
						<p className="hint">
							The app posts PR reviews as ottr[bot]; without it reviews post
							under your own identity.
						</p>
						<div className="settings-field">
							App ID <code>{state.githubApp.id}</code>
						</div>
						<AppCheckLines check={state.githubApp.check} />
						<p className="hint">
							Key set. Fingerprint <code>{state.githubApp.fingerprint}</code>
						</p>
						<button type="button" onClick={() => setAppFormOpen(true)}>
							Replace
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
							void saveApp();
						}}
					>
						<label className="settings-field">
							App ID
							<input
								value={appId}
								onChange={(e) => setAppId(e.target.value)}
								placeholder="123456"
								required
								pattern="\d+"
							/>
						</label>
						<label className="settings-field">
							Private key
							<textarea
								rows={8}
								value={appKey}
								onChange={(e) => setAppKey(e.target.value)}
								spellCheck={false}
								autoComplete="off"
								placeholder={"-----BEGIN RSA PRIVATE KEY-----\n…"}
								required
							/>
						</label>
						<BusyButton run={saveApp}>Save</BusyButton>
						{state !== null && state.githubApp !== null && (
							<>
								{" "}
								<button type="button" onClick={() => setAppFormOpen(false)}>
									Cancel
								</button>
							</>
						)}
					</form>
				)}
			</div>
			<div className="sec-block" id="host-tokens-block" tabIndex={-1}>
				<h4>
					Other host tokens
					<Help
						label="Other host tokens"
						text="HTTPS tokens for git hosts other than GitHub, one for each host. Ottr tests each token with git ls-remote before it saves the token."
					/>
				</h4>
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
											}}
										>
											Replace
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
					<label className="settings-field">
						Host
						<input
							value={tHost}
							onChange={(e) => setTHost(e.target.value)}
							placeholder="gitlab.com"
							required
						/>
					</label>
					<label className="settings-field">
						Username
						<input
							value={tUser}
							onChange={(e) => setTUser(e.target.value)}
							placeholder="oauth2"
						/>
					</label>
					<label className="settings-field">
						Token
						<input
							type="password"
							value={tToken}
							onChange={(e) => setTToken(e.target.value)}
							autoComplete="off"
							spellCheck={false}
							required
						/>
					</label>
					<label className="settings-field">
						Test URL (a repository the token can read)
						<input
							value={tUrl}
							onChange={(e) => setTUrl(e.target.value)}
							placeholder="https://gitlab.com/group/repo.git"
							required
						/>
					</label>
					<button
						type="submit"
						disabled={tBusy.busy}
						className={`primary${tBusy.failed ? " failed" : ""}`}
					>
						{tBusy.busy && <span className="spinner" aria-hidden="true" />}
						Save token
					</button>
				</form>
			</div>
			<div className="sec-block" id="ssh-key-block" tabIndex={-1}>
				<h4>
					Global SSH key
					<Help
						label="Global SSH key"
						text="The server-side SSH key for clones, fetches and pushes over SSH. Each project without its own key uses this key."
					/>
				</h4>
				{state !== null &&
					(state.globalKey === null ? (
						<p className="hint">No global key.</p>
					) : (
						<div>
							<p className="hint">
								Fingerprint <code>{state.globalKey.fingerprint}</code>
							</p>
							<label>
								Public key
								<textarea
									readOnly
									rows={3}
									value={state.globalKey.publicKey}
									spellCheck={false}
									onFocus={(e) => e.currentTarget.select()}
								/>
							</label>{" "}
							<button
								type="button"
								onClick={() => void copyText(state.globalKey?.publicKey ?? "")}
							>
								Copy
							</button>{" "}
							<BusyButton className="danger" run={removeGlobal}>
								Remove
							</BusyButton>
						</div>
					))}
				<p className="hint">
					Save replaces the global key: every project without its own key uses
					the new one.
				</p>
				<PendingKeyRow pending={pending} onPending={setPending} />
				<label className="settings-field">
					Test URL (a repository the key can read)
					<input
						value={gUrl}
						onChange={(e) => setGUrl(e.target.value)}
						placeholder="git@gitlab.com:group/repo.git"
					/>
				</label>
				{pending !== null && (
					<SshTestRow
						label="Save and test"
						success="Global key saved"
						send={(trust) =>
							gitReq("PUT", "/api/git-hosts/ssh/global", {
								pending: pending.id,
								testUrl: gUrl.trim(),
								trust,
							}).then(({ status, data }) => {
								if (status === 200) {
									setPending(null);
									void load();
									return { ok: true } as const;
								}
								const t = asTrust(data);
								return t !== null ? t : { error: asError(data, status) };
							})
						}
					/>
				)}
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
	const useGlobal = (): Promise<boolean> =>
		(async () => {
			setError(null);
			if (
				!window.confirm(
					"Remove this project's key? The project then uses the global key.",
				)
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
			help="This project's own SSH key for git over SSH. Without one, the project uses the global key from the General settings."
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
				<div>
					<BusyButton className="danger" run={useGlobal}>
						Use global key
					</BusyButton>
				</div>
			)}
			<p className="hint">Save an own key to replace the global key:</p>
			<PendingKeyRow pending={pending} onPending={setPending} />
			<label className="settings-field">
				Test URL (a repository this key can read)
				<input
					value={pUrl}
					onChange={(e) => setPUrl(e.target.value)}
					placeholder="git@host:group/repo.git"
				/>
			</label>
			{pending !== null && (
				<SshTestRow
					label="Save and test"
					success="Key saved for this project"
					send={(trust) =>
						gitReq(
							"PUT",
							`/api/projects/${encodeURIComponent(project.name)}/ssh-key`,
							{ pending: pending.id, testUrl: pUrl.trim(), trust },
						).then(({ status, data }) => {
							if (status === 200) {
								setPending(null);
								void load();
								return { ok: true } as const;
							}
							const t = asTrust(data);
							return t !== null ? t : { error: asError(data, status) };
						})
					}
				/>
			)}
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
			help="Secret values for the names in the data repo's env.txt files. Workers get each value as an environment variable. Ottr never shows a value again after you save it."
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
									</b>
									<span className="caption">{row.set ? "Set" : "Missing"}</span>
									<span>{row.projects.join(", ")}</span>
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
	const signOutOf = (id: string): void => {
		if (
			!window.confirm(
				`Sign omp out of ${providerName(id)}? Turns that use it fail until you sign in again.`,
			)
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
			help="The omp sign-ins on the board's machine, one for each provider. Each bar shows how much of a quota window is used. The thin line above it shows how much of the window's time has passed."
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
										text="After you finish the provider's sign-in page, paste the address that the page ends on or the code that it shows."
									/>
								</b>
								<span>
									Finish the provider's page. Copy the address it ends on (it
									starts with http://localhost), or the code it shows, and paste
									it here. Works the same from another machine or a phone.
								</span>
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
								Send to omp
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
							<span>Pick one, or type any id that omp login lists</span>
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

/** Settings "Model roles" section: edits omp's modelRoles in the data repo through Alate, then provisions. */
function ModelRolesSection() {
	const catalog = useModels();
	const [state, setState] = useState<RolesState | null>(null);
	const [loadErr, setLoadErr] = useState<string | null>(null);
	const [rows, setRows] = useState<Array<[string, string]>>([]);
	const [fields, setFields] = useState<Record<string, string>>({});
	const [error, setError] = useState<string | null>(null);
	const [newName, setNewName] = useState("");
	const [addErr, setAddErr] = useState<string | null>(null);
	const [commit, setCommit] = useState<string | null>(null);
	// The saved roles and the board's seed commit at the save: the seed step compares the board copy with both.
	const [saved, setSaved] = useState<{
		seedAtSave: string | null;
		after: Record<string, string>;
	} | null>(null);
	const [prov, setProv] = useState<ProvisionStep | null>(null);
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
			: seedStep(seed, saved.seedAtSave, saved.after);
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
	const dirty = state !== null && rolesDirty(rows, state.roles);
	const setValue = (name: string, value: string): void => {
		setRows((rs) => rs.map((r) => (r[0] === name ? [name, value] : r)));
		setFields((f) =>
			Object.fromEntries(Object.entries(f).filter(([k]) => k !== name)),
		);
	};
	const add = (): void => {
		const name = newName.trim();
		const first = models[0]?.selector;
		const err = addRoleError(name, rows, first);
		setAddErr(err);
		if (err === null && first !== undefined) {
			setRows((rs) => [...rs, [name, first]]);
			setNewName("");
		}
	};
	const provision = async (): Promise<void> => {
		setProv({ state: "running" });
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
		}
	};
	const submit = (): void =>
		save.start(async () => {
			if (state === null) return false;
			setError(null);
			setFields({});
			setCommit(null);
			setSaved(null);
			setProv(null);
			try {
				const res = await fetch("/api/model-roles", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						base: state.base,
						hash: state.hash,
						roles: Object.fromEntries(rows),
					}),
				});
				const r = classifyRolesSave(
					res.ok,
					res.status,
					await res.json().catch(() => ({})),
				);
				if (r.kind === "saved") {
					const { commit: sha, hash, roles, seed } = r;
					setState((old) => old && { ...old, base: sha, hash, roles, seed });
					setRows(Object.entries(roles));
					setSaved({ seedAtSave: seed.commit, after: roles });
					setCommit(sha);
					// The commit stands even when the provision fails; the steps list says so.
					await provision();
					return true;
				}
				if (r.kind === "conflict") {
					// The data repo moved: load its current values, so the next save starts from them.
					const { base, hash, roles } = r;
					setState((old) => old && { ...old, base, hash, roles });
					setRows(Object.entries(roles));
					setError(r.error);
					return false;
				}
				setFields(r.fields);
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
			help="The model and the thinking level that omp uses for each role. Save commits the change to Alate's data repo, and then Alate provisions the workers."
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
					omp runs each role with its model. Save commits{" "}
					<code>user/omp/agent/config.yml</code> to Alate's data repo with the
					board's GitHub token, then Alate provisions the workers.
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
				<p className="hint" role="status">
					<span className="spinner" aria-hidden="true" />
					Loading the model roles…
				</p>
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
									<select
										value={base}
										onChange={(e) =>
											setValue(name, joinLevel(e.target.value, level))
										}
										aria-label={`Model for ${name}`}
										aria-invalid={field !== undefined}
										aria-describedby={notesId}
										disabled={save.busy}
									>
										{!models.some((m) => m.selector === base) && (
											<option value={base}>{base} (not in the catalog)</option>
										)}
										{models.map((m) => (
											<option key={m.selector} value={m.selector}>
												{m.name} ({m.id})
											</option>
										))}
									</select>
									<select
										value={level}
										onChange={(e) =>
											setValue(name, joinLevel(base, e.target.value))
										}
										aria-label={`Thinking for ${name}`}
										aria-invalid={field !== undefined}
										aria-describedby={notesId}
										disabled={save.busy}
									>
										<option value="">Default</option>
										{THINKING_LEVELS.map((l) => (
											<option key={l} value={l}>
												{l}
											</option>
										))}
									</select>
									<button
										type="button"
										className="icon role-remove"
										aria-label={`Remove role ${name}`}
										title="Remove role"
										onClick={() =>
											setRows((rs) => rs.filter(([n]) => n !== name))
										}
										disabled={save.busy}
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
								</div>
							);
						})}
					</div>
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
								disabled={save.busy}
							/>
						</label>
						<button type="submit" disabled={save.busy}>
							Add
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
							className={`primary${save.failed ? " failed" : ""}`}
							onClick={submit}
							disabled={!dirty || save.busy}
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
									. The commit stays in the data repo. Use Provision now in the
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

/** The board's Hindsight server and whether a key is in effect; the key itself is write-only. */
type HindsightView = { url: string | null; tokenSet: boolean };

/** Settings "Hindsight" section: the server URL and the key every turn's omp sends to it. */
function HindsightSection() {
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
					: view.url !== null
						? { label: "On", tone: "ok" }
						: { label: "Off", tone: "off" }
			}
			hint={
				view === null ? undefined : view.url === null ? (
					<>
						This board's turns use omp's own memory settings:{" "}
						<code>HINDSIGHT_API_URL</code> is not set and no server URL is
						saved.
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
									text="The Hindsight memory server that the omp of each turn uses. Empty: turns use the HINDSIGHT_API_URL environment variable."
								/>
							</b>
							<span>
								{view?.url == null
									? "Not set: turns use HINDSIGHT_API_URL"
									: "Saved. Paste a new address to move the memory server"}
							</span>
							<code>http(s) address of the Hindsight server</code>
						</div>
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
					</div>
				</div>
				<div className="alate-def-actions">
					<button
						type="submit"
						disabled={urlSave.busy}
						className={urlSave.failed ? "failed" : undefined}
					>
						{urlSave.busy && <span className="spinner" aria-hidden="true" />}
						<SaveLabel saved={urlSaved} />
					</button>
				</div>
			</form>
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

/** Opens Settings and scrolls to the given section; the page remounts on the hash change, so the
 *  poll waits out the mount instead of racing it, and a second pass re-scrolls after the async
 *  sections above finish loading. Advisory link only — it never runs provisioning. */
export function openSettingsSection(
	sectionId: string,
	hash: string = SETTINGS_HASH,
): void {
	const scroll = () => {
		const el = document.getElementById(sectionId);
		el?.scrollIntoView({ block: "start" });
		el?.focus({ preventScroll: true });
	};
	location.hash = `#${hash}`;
	let tries = 0;
	const t = setInterval(() => {
		if (document.getElementById(sectionId) !== null) {
			clearInterval(t);
			scroll();
			setTimeout(scroll, 600);
		} else if (++tries > 40) {
			clearInterval(t);
		}
	}, 50);
}

/** Settings "Alate" section: provisioning config + one-shot provision trigger. */
function AlateSection() {
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
							</b>
							<span>Where the alate server runs</span>
							<code>http(s) URL</code>
						</div>
						<label>
							<input
								type="text"
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
							</b>
							<span>Printed by the alate server at first start</span>
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
						{awaiting ? "Provisioning…" : "Provision now"}
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
/** Review learnings: one row per standing review convention (text, glob, usage count),
 * a delete per row, and an add form. Loads on mount; errors surface like the other settings errors. */
function LearningsSection({
	project,
	act,
}: {
	project: ProjectView;
	act: Act;
}) {
	const [items, setItems] = useState<Learning[] | null>(null);
	const [text, setText] = useState("");
	const [glob, setGlob] = useState("");
	const [error, setError] = useState<string | null>(null);
	const save = useBusy();
	const url = `/api/projects/${encodeURIComponent(project.name)}/learnings`;
	const load = useCallback(async (): Promise<boolean> => {
		try {
			const v = (await unwrap(await fetch(url))) as {
				learnings: Learning[];
			};
			setItems(v.learnings);
			return true;
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			return false;
		}
	}, [url]);
	useEffect(() => {
		setItems(null);
		setError(null);
		void load();
	}, [load]);
	const add = (): void => {
		save.start(() =>
			act(async () => {
				const v = await post<{ learning: Learning }>(url, {
					text: text.trim(),
					glob: glob.trim() === "" ? null : glob.trim(),
				});
				setItems([...(items ?? []), v.learning]);
				setText("");
				setGlob("");
			}, setError),
		);
	};
	const remove = (id: number): void => {
		save.start(() =>
			act(async () => {
				await unwrap(await fetch(`${url}/${id}`, { method: "DELETE" }));
				setItems((cur) => (cur ?? []).filter((l) => l.id !== id));
			}, setError),
		);
	};
	return (
		<SettingsCard
			id="project-learnings-section"
			className="learnings-sec"
			title="Review learnings"
			help="Standing review rules. The prompt of each review card includes them, so a finding that only repeats a rule counts as noise."
			status={
				items === null
					? undefined
					: {
							label: `${items.length} learning${items.length === 1 ? "" : "s"}`,
							tone: items.length > 0 ? "ok" : "off",
						}
			}
			hint="Standing review conventions, stated once. Every Review card's prompt carries them, so a finding that only restates one is treated as noise."
		>
			{items !== null && items.length === 0 && (
				<p className="hint">No learnings yet.</p>
			)}
			{items !== null && items.length > 0 && (
				<ul className="learnings-list">
					{items.map((l) => (
						<li key={l.id}>
							<span className="learning-text">{l.text}</span>
							{l.glob !== null && (
								<code className="learning-glob">{l.glob}</code>
							)}
							<span className="learning-uses">
								used {l.usageCount === 1 ? "once" : `${l.usageCount} times`}
							</span>
							<button
								type="button"
								className="icon"
								aria-label={`Delete learning: ${l.text}`}
								title="Delete learning"
								disabled={save.busy}
								onClick={() => remove(l.id)}
							>
								<Icon name="x" />
							</button>
						</li>
					))}
				</ul>
			)}
			<form
				className="learnings-add"
				onSubmit={(e) => {
					e.preventDefault();
					add();
				}}
			>
				<label>
					<span>Convention</span>
					<textarea
						rows={2}
						maxLength={500}
						required
						value={text}
						placeholder="e.g. Never suggest adding JSDoc to internal helpers"
						onChange={(e) => setText(e.target.value)}
					/>
				</label>
				<label>
					<span>Path glob (optional)</span>
					<input
						maxLength={200}
						value={glob}
						placeholder="src/ui/**"
						autoComplete="off"
						spellCheck={false}
						onChange={(e) => setGlob(e.target.value)}
					/>
				</label>
				<button
					type="submit"
					disabled={save.busy}
					className={save.failed ? "failed" : undefined}
					aria-busy={save.busy || undefined}
				>
					{save.busy && <span className="spinner" aria-hidden="true" />}
					Add learning
				</button>
			</form>
			{error !== null && (
				<p className="auth-error" role="alert">
					{error}
				</p>
			)}
		</SettingsCard>
	);
}

type ChipTone = "ok" | "warn" | "off";

/** One definition row: name (with an optional "?" explanation), purpose and value shape on the left, the value on the right. */
function DefRow({
	name,
	desc,
	shape,
	help,
	children,
}: {
	name: string;
	desc?: string;
	shape?: string;
	help?: string;
	children: ReactNode;
}) {
	return (
		<div className="alate-def-row">
			<div className="alate-def-name">
				<b>
					{name}
					{help !== undefined && <Help label={name} text={help} />}
				</b>
				{desc !== undefined && <span>{desc}</span>}
				{shape !== undefined && <code>{shape}</code>}
			</div>
			{children}
		</div>
	);
}

/** Updates chip: how many of the project's four automations are on (saved values, not the draft). */
function updatesChip(s: ProjectView["settings"]): {
	label: string;
	tone: ChipTone;
} {
	const on = [
		s.holdUpdateMerges,
		s.retroSince !== null,
		s.forkResearch,
		s.prReviews,
	].filter(Boolean).length;
	return { label: `${on} of 4 on`, tone: on > 0 ? "ok" : "off" };
}

/** One settings card: title, optional state chip and hint, body, optional Save footer. */
function SettingsCard({
	id,
	title,
	hint,
	help,
	status,
	footer,
	className,
	children,
}: {
	id?: string;
	title: string;
	hint?: ReactNode;
	/** Short "?" explanation beside the title, for cards without their own setting rows. */
	help?: string;
	status?: { label: string; tone: ChipTone };
	footer?: ReactNode;
	className?: string;
	children: ReactNode;
}) {
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
					{help !== undefined && <Help label={title} text={help} />}
					{status !== undefined && (
						<span className={`state-chip ${status.tone}`}>{status.label}</span>
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
			{ id: "push-section", label: "Push" },
		],
	},
	{
		id: "access-group",
		label: "Access",
		sections: [
			{ id: "api-key-section", label: "API key" },
			{ id: "session-section", label: "Session" },
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

/** One-project page: its cards in page order. */
const PROJECT_TOC = [
	{ id: "project-icon-section", label: "Icon" },
	{ id: "project-identity-section", label: "Identity" },
	{ id: "project-runners-section", label: "Runners" },
	{ id: "project-worktrees-section", label: "Worktrees" },
	{ id: "project-releases-section", label: "Releases" },
	{ id: "project-reviews-section", label: "Reviews" },
	{ id: "project-messages-section", label: "Messages" },
	{ id: "project-updates-section", label: "Updates" },
	{ id: "project-learnings-section", label: "Review learnings" },
	{ id: "project-ssh-section", label: "SSH key" },
	{ id: "project-remove-section", label: "Remove project" },
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

type TocGroup = {
	readonly id: string;
	readonly label: string;
	readonly sections: readonly TocSection[];
};

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
	act,
	view,
}: {
	projects: ProjectView[];
	tasks: TaskCard[];
	maxTotal: number | null;
	reviewCheck: boolean;
	workCheck: boolean;
	act: Act;
	view: string;
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
			general
				? SETTINGS_TOC.flatMap((g): readonly TocSection[] => g.sections)
				: PROJECT_TOC,
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
	}, [general, view]);
	const map = (
		<SettingsMap
			groups={
				project === null
					? SETTINGS_TOC
					: [
							{
								id: "project-head",
								label: projectLabel(project),
								sections: PROJECT_TOC,
							},
						]
			}
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
					href={`#${SETTINGS_HASH}`}
					aria-current={general ? "page" : undefined}
				>
					General
				</a>
				{general && map}
				<p className="snb-label">Projects</p>
				{projects.map((p) => (
					<Fragment key={p.name}>
						<a
							className="snb"
							href={`#${SETTINGS_HASH}/${encodeURIComponent(p.name)}`}
							aria-current={project?.name === p.name ? "page" : undefined}
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
						<section
							className="settings-group"
							id="board-group"
							aria-labelledby="board-group-title"
							tabIndex={-1}
						>
							<h2 className="settings-group-title" id="board-group-title">
								Board
							</h2>
							<TotalRunnersForm
								maxTotal={maxTotal}
								reviewCheck={reviewCheck}
								workCheck={workCheck}
								allocated={allocated}
								act={act}
							/>
							<PushSection />
						</section>
						<section
							className="settings-group"
							id="access-group"
							aria-labelledby="access-group-title"
							tabIndex={-1}
						>
							<h2 className="settings-group-title" id="access-group-title">
								Access
							</h2>
							<ApiKeySection />
							<SessionSection />
						</section>
						<section
							className="settings-group"
							id="git-group"
							aria-labelledby="git-group-title"
							tabIndex={-1}
						>
							<h2 className="settings-group-title" id="git-group-title">
								Git and secrets
							</h2>
							<GitHostsSection />
							<EnvSection />
						</section>
						<section
							className="settings-group"
							id="agents-group"
							aria-labelledby="agents-group-title"
							tabIndex={-1}
						>
							<h2 className="settings-group-title" id="agents-group-title">
								Agents
							</h2>
							<ProviderLoginSection />
							<ModelRolesSection />
							<AlateSection />
							<HindsightSection />
						</section>
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
							act={act}
						/>
					</>
				)}
			</div>
		</div>
	);
}

/** One project's settings page: identity, slots, worktrees, releases, reviews, messages, removal. */
function ProjectSettingsForm({
	project,
	tasks,
	act,
}: {
	project: ProjectView;
	tasks: TaskCard[];
	act: Act;
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
	const [label, setLabel] = useState(project.settings.displayName ?? "");
	const [hold, setHold] = useState(project.settings.holdUpdateMerges);
	const [retro, setRetro] = useState(project.settings.retroSince !== null);
	const [retroFilter, setRetroFilter] = useState(project.settings.retroFilter);
	const [forkRes, setForkRes] = useState(project.settings.forkResearch);
	const [prRev, setPrRev] = useState(project.settings.prReviews);
	const [saved, flashSaved] = useFlash(1500);
	const save = useBusy();
	// The setup wizard, opened by Run setup again.
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
	const dirty =
		label.trim() !== (project.settings.displayName ?? "") ||
		parallel !== project.settings.maxParallel ||
		paths.join("\n") !== project.settings.copyExtra.join("\n") ||
		relcmd.trim() !== (project.settings.releaseCommand ?? "") ||
		reviewCap !== project.settings.archReviewCap ||
		imagesMax !== project.settings.maxImages ||
		keepDays !== project.settings.keptWorktreeDays ||
		hold !== project.settings.holdUpdateMerges ||
		retro !== (project.settings.retroSince !== null) ||
		retroFilter !== project.settings.retroFilter ||
		forkRes !== project.settings.forkResearch ||
		prRev !== project.settings.prReviews;
	return (
		<>
			<div className="settings-head" id="project-head" tabIndex={-1}>
				<h2>{projectLabel(project)}</h2>
				<SaveStateChip
					dirty={dirty}
					saving={save.busy}
					failed={save.failed}
					saved={saved}
				/>
				<button
					type="button"
					className="ghost"
					onClick={() => setSetupOpen(true)}
					title="Open the setup wizard at the Rules step for this project"
				>
					<Icon name="refresh-cw" size={13} />
					Run setup again
				</button>
				<button
					type="submit"
					form="project-settings"
					className={`settings-save${save.failed ? " failed" : ""}`}
					disabled={save.busy || !dirty}
				>
					{save.busy && <span className="spinner" aria-hidden="true" />}
					<SaveLabel saved={saved} />
				</button>
			</div>
			<form
				id="project-settings"
				onSubmit={(e) => {
					e.preventDefault();
					if (!dirty) return;
					save.start(() =>
						act(async () => {
							const response = await post<ProjectView>(
								`/api/projects/${encodeURIComponent(project.name)}/settings`,
								{
									displayName: label.trim() || null,
									maxParallel: parallel,
									copyExtra: paths,
									releaseCommand: relcmd.trim() || null,
									archReviewCap: reviewCap,
									maxImages: imagesMax,
									keptWorktreeDays: keepDays,
									holdUpdateMerges: hold,
									retro,
									retroFilter,
									forkResearch: forkRes,
									prReviews: prRev,
								},
							);
							if (response.name !== project.name)
								location.hash = `#${SETTINGS_HASH}/${encodeURIComponent(response.name)}`;
							flashSaved();
						}),
					);
				}}
			>
				<SettingsCard
					id="project-icon-section"
					title="Icon"
					status={
						project.icon !== null
							? { label: "Uploaded", tone: "ok" }
							: { label: "Default", tone: "off" }
					}
				>
					<div className="alate-def-rows">
						<DefRow
							name="Project icon"
							help="An image that replaces the project's letters on the board. Without one, Ottr uses the repo owner's avatar or the host's favicon, and then the letters."
							desc="Replaces the letters on the board"
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
											save.start(() =>
												act(async () => {
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
													flashSaved();
												}),
											);
										}}
									/>
								</label>
								{project.icon !== null && (
									<button
										type="button"
										className="ghost"
										disabled={save.busy}
										onClick={() =>
											save.start(() =>
												act(async () => {
													const res = await fetch(
														`/api/projects/${encodeURIComponent(project.name)}/icon`,
														{ method: "DELETE" },
													);
													if (!res.ok) throw new Error(`HTTP ${res.status}`);
													flashSaved();
												}),
											)
										}
									>
										Remove
									</button>
								)}
							</div>
						</DefRow>
					</div>
				</SettingsCard>
				<SettingsCard
					id="project-identity-section"
					title="Identity"
					status={
						project.github !== null
							? { label: "GitHub", tone: "ok" }
							: project.gitless
								? { label: "No git", tone: "off" }
								: { label: "Local git", tone: "off" }
					}
				>
					<div className="alate-def-rows">
						<DefRow
							name="Display name"
							help="A friendly name for the board. The folder and the repo keep their real names."
							desc="Shown on the board instead of the folder name"
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
						{/* Facts, not fields: the folder and the GitHub repo are fixed at add time. */}
						<DefRow
							name="Folder path"
							desc="Fixed when the project was added"
							help="Where the project lives on the board's machine. Ottr sets it when you add the project."
						>
							<code>{project.path}</code>
						</DefRow>
						{project.github !== null && (
							<DefRow
								name="GitHub"
								desc="Fixed when the project was added"
								help="The project's GitHub repository. GitHub-only features, such as PR reviews and fork research, use it."
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
					</div>
				</SettingsCard>
				<SettingsCard
					id="project-runners-section"
					title="Runners"
					status={
						project.settings.maxParallel === null
							? { label: "No cap", tone: "off" }
							: { label: `Cap ${project.settings.maxParallel}`, tone: "ok" }
					}
				>
					<div className="alate-def-rows">
						<DefRow
							name="Runner cap"
							help="The most tasks of this project that run at the same time. The board-wide runner cap still applies."
							desc="Tasks of this project that may run at once"
							shape="empty = no cap"
						>
							<label>
								<input
									type="number"
									min={1}
									value={mp}
									onChange={(e) => setMp(e.target.value)}
									aria-label="Max tasks of this project running at once (empty = no cap)"
								/>
							</label>
						</DefRow>
					</div>
				</SettingsCard>
				<SettingsCard
					id="project-worktrees-section"
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
					<div className="alate-def-rows">
						<DefRow
							name="Extra paths"
							help="Files that git ignores but agents need, for example local config. Ottr copies them into each new worktree."
							desc="Copied into each new worktree"
							shape="one path per line"
						>
							<label>
								<textarea
									rows={3}
									value={extra}
									onChange={(e) => setExtra(e.target.value)}
									placeholder="scripts/release.mjs"
									aria-label="Extra paths copied into new worktrees (one per line)"
								/>
							</label>
						</DefRow>
						<DefRow
							name="Quarantine after"
							help="How long a kept worktree can stay idle. Then Ottr moves its untracked files to .tasks/quarantine and removes the worktree, but only when no work would be lost."
							desc="Idle days before a kept worktree is quarantined"
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
					</div>
				</SettingsCard>
				<SettingsCard
					id="project-releases-section"
					title="Releases"
					status={
						project.settings.releaseCommand !== null
							? { label: "Own command", tone: "ok" }
							: { label: "Ottr publishes", tone: "off" }
					}
					hint="Runs in the release worktree after the review approves, instead of Ottr's tag and GitHub release. It gets OTTR_RELEASE_VERSION, OTTR_RELEASE_COMMIT, OTTR_RELEASE_NOTES_FILE and OTTR_ARCH_REVIEW (commits since the last review). Must push the tag. Empty: Ottr tags and publishes itself."
				>
					<div className="alate-def-rows">
						<DefRow
							name="Release command"
							help="A script that publishes the release after the review approves it. Empty: Ottr makes the git tag and the GitHub release itself."
							desc="Runs after the review approves"
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
					</div>
				</SettingsCard>
				<SettingsCard
					id="project-reviews-section"
					title="Reviews"
					status={{
						label: `Every ${project.settings.archReviewCap} commits`,
						tone: "off",
					}}
				>
					<div className="alate-def-rows">
						<DefRow
							name="Review interval"
							help="Ottr marks a review as due after this many new commits on the target branch."
							desc="Commits on the target before a review is due"
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
					</div>
				</SettingsCard>
				<SettingsCard
					id="project-messages-section"
					title="Messages"
					status={{
						label: `${project.settings.maxImages} image${project.settings.maxImages === 1 ? "" : "s"}`,
						tone: "off",
					}}
				>
					<div className="alate-def-rows">
						<DefRow
							name="Max images"
							help="The most images you can attach to one message: a new task, a reply, a follow-up or a steer."
							desc="Per message: new tasks, replies, follow-ups and steers"
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
					</div>
				</SettingsCard>
				<SettingsCard
					id="project-updates-section"
					title="Updates"
					status={updatesChip(project.settings)}
				>
					<div className="alate-def-rows">
						{/* U7: hold update-card merges at needs_you until a reply approves them. */}
						<DefRow
							name="Hold update merges"
							help="Update cards stop at needs-you after a ready turn. They merge only after your reply approves it."
							desc="Update cards wait at needs_you after a ready turn; your reply approves the merge"
						>
							<label>
								<input
									type="checkbox"
									checked={hold}
									onChange={(e) => setHold(e.target.checked)}
									aria-label="Hold merges of update cards until you approve"
								/>
							</label>
						</DefRow>
						<DefRow
							name="Retro"
							help="After each card lands in Done, Ottr files one retro card that proposes follow-up work."
							desc="After each done task the supervisor proposes follow-up cards from its retro"
						>
							<label>
								<input
									type="checkbox"
									checked={retro}
									onChange={(e) => setRetro(e.target.checked)}
									aria-label="Retro"
								/>
							</label>
						</DefRow>
						<DefRow
							name="Friction filter"
							help="Keeps only the retro proposals that fix a friction the task hit. It works only when Retro is on."
							desc="Keep only retro proposals that fix a friction the task hit; needs Retro"
						>
							<label>
								<input
									type="checkbox"
									checked={retroFilter}
									disabled={!retro}
									onChange={(e) => setRetroFilter(e.target.checked)}
									aria-label="Friction filter"
								/>
							</label>
						</DefRow>
						<DefRow
							name="Fork research"
							help="Every hour, Ottr checks the project's GitHub forks. Findings arrive as proposals that you accept or decline."
							desc="Hourly watch of the project's GitHub forks; analysis files held proposals; fork-born merges need approval"
						>
							<label>
								<input
									type="checkbox"
									checked={forkRes}
									onChange={(e) => setForkRes(e.target.checked)}
									aria-label="Fork research"
								/>
							</label>
						</DefRow>
						<DefRow
							name="PR reviews"
							help="Every hour, Ottr drafts a read-only review for each new head of an open pull request. You edit the draft and post it as a comment."
							desc={`${project.github === null ? "Needs a GitHub remote. " : ""}Hourly watch of open pull requests on GitHub; each new head gets a read-only review draft you can post as a comment`}
						>
							<label>
								<input
									type="checkbox"
									checked={prRev}
									disabled={project.github === null && !prRev}
									onChange={(e) => setPrRev(e.target.checked)}
									aria-label="PR reviews"
								/>
							</label>
						</DefRow>
					</div>
				</SettingsCard>
			</form>
			<LearningsSection project={project} act={act} />
			{setupOpen && (
				<SetupWizardModal
					project={project}
					act={act}
					onClose={() => setSetupOpen(false)}
				/>
			)}
			<SshKeySection project={project} />
			<SettingsCard
				id="project-remove-section"
				className="settings-danger"
				title="Remove project"
				help="Takes the project off this board. The folder, the repo and the task history stay on disk. Add the folder again to bring the project back."
				status={
					removable ? undefined : { label: "Tasks running", tone: "warn" }
				}
				hint={
					<>
						Removes the project {projectLabel(project)} from this Ottr board.
						Nothing is deleted: its folder, repo, and task history stay on disk.
						Adding the folder again brings the project back here.
					</>
				}
			>
				<div>
					<BusyButton
						className="danger"
						disabled={!removable}
						title={
							removable
								? undefined
								: "Cancel the queued and running tasks first."
						}
						run={() =>
							act(async () => {
								await post(
									`/api/projects/${encodeURIComponent(project.name)}/remove`,
									{},
								);
								location.hash = `#${SETTINGS_HASH}`;
							})
						}
					>
						Remove project
					</BusyButton>
				</div>
			</SettingsCard>
		</>
	);
}
