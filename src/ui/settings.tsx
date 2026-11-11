import type { KeyboardEvent, ReactNode } from "react";
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
import type { CommitIdentity } from "../gitIdentity.ts";
import { joinLevel, splitLevel, THINKING_LEVELS } from "../levels.ts";
import type { ModelOption } from "../models.ts";
import type { AlertClass, ClassPrefs } from "../notifications.ts";
import type { OmpStatsReport } from "../ompStats.ts";
import type { OmpStatsDashboardInfo } from "../ompStatsDashboard.ts";
import { orderBy } from "../projectOrder.ts";
import { forProvider } from "../quota.ts";
import { missingRequired } from "../requiredSkills.ts";
import { liveCardOf } from "../scheduler.ts";
import type {
	AppCheck,
	ArchReview,
	GitHubAppView,
	GithubFacts,
	JiraConnectionView,
	JiraType,
	ProjectView,
	ProvisioningResponse,
	QuotaState,
	TaskCard,
	TrendingStatus,
} from "../types.ts";
import {
	type Act,
	BusyButton,
	type BusyState,
	CloseButton,
	clamp,
	confirmDialog,
	copyText,
	Help,
	httpNextStep,
	httpProblem,
	httpStatusWords,
	Icon,
	type IconName,
	type InstantSave,
	interviewMsg,
	LiveElapsed,
	logOut,
	Mark,
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
	type ModelCatalog,
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

/** Projects A to Z by the name the user reads. Settings lists sort this way; only the
 *  Project order card keeps the board's own order, because it edits that order. */
const byLabel = (projects: readonly ProjectView[]): ProjectView[] =>
	[...projects].sort((a, b) =>
		projectLabel(a).localeCompare(projectLabel(b), undefined, {
			sensitivity: "base",
		}),
	);

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

/** Step 2's rules block: git init for a bare folder, align or interview, or open the queued card. */
function SetupRulesSection({
	gitless,
	hasRules,
	rulesTask,
	rulesQueued,
	openTask,
	onClose,
	initRepo,
	alignRules,
	discussRules,
}: {
	gitless: boolean;
	hasRules: boolean;
	rulesTask: string | null;
	rulesQueued: boolean;
	openTask?: (id: string) => void;
	onClose: () => void;
	initRepo: () => Promise<boolean>;
	alignRules: () => Promise<boolean>;
	discussRules: () => Promise<boolean>;
}) {
	return (
		<section className="setup-sec">
			<h3>Rules</h3>
			{gitless ? (
				<>
					<p className="hint">
						This folder is not a git repository yet, so every action waits until
						it is one.
					</p>
					<div>
						<BusyButton run={initRepo}>Create git repo</BusyButton>
					</div>
				</>
			) : hasRules ? (
				<>
					<p className="hint">
						AGENTS.md exists. Aligning re-reads it and files fixes where it
						contradicts the tracker's pipeline.
					</p>
					<div>
						<BusyButton run={alignRules}>Align rules</BusyButton>
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
					The rules interview is filed as a card — it starts shortly and asks
					its questions on the card.
				</p>
			) : (
				<>
					<p className="hint">
						No AGENTS.md yet, so tasks wait in Todo. The interview asks a few
						questions and writes the rules.
					</p>
					<div>
						<BusyButton run={discussRules}>Discuss rules</BusyButton>
					</div>
				</>
			)}
		</section>
	);
}

/** One GitHub facts fetch, as the fork panel shows it: null while loading. */
type GithubFactsState =
	| { kind: "error"; message: string }
	| { kind: "ok"; facts: GithubFacts }
	| null;

/** Step 3's fork-research panel: the checkbox, the GitHub facts, and the recent-forks table. */
function SetupForkSection({
	view,
	facts,
	forkEffective,
	forkTouched,
	onForkDraft,
}: {
	view: ProjectView;
	facts: GithubFactsState;
	forkEffective: boolean;
	forkTouched: boolean;
	onForkDraft: (checked: boolean) => void;
}) {
	return (
		<section className="setup-sec">
			<label className="add-check">
				<input
					type="checkbox"
					checked={forkEffective}
					onChange={(e) => {
						onForkDraft(e.target.checked);
					}}
				/>
				Fork research
				<span className="hint">
					{!forkTouched &&
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
										<td>{pushedAge(f.pushedAt, Date.now())} since last push</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</>
			)}
		</section>
	);
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
	const [facts, setFacts] = useState<GithubFactsState>(null);
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

	/** Step 2: create the missing git repository, then drop the gitless panel. */
	const initRepo = (): Promise<boolean> =>
		act(async () => {
			await post(`/api/projects/${encodeURIComponent(view.name)}/init`, {});
			setGitless(false);
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
				<SetupRulesSection
					gitless={gitless}
					hasRules={view.hasRules}
					rulesTask={rulesTask}
					rulesQueued={rulesQueued}
					openTask={openTask}
					onClose={onClose}
					initRepo={initRepo}
					alignRules={() => runInterview({ fix: true })}
					discussRules={() => runInterview({}, () => setRulesQueued(true))}
				/>
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
						<SetupForkSection
							view={view}
							facts={facts}
							forkEffective={forkEffective}
							forkTouched={forkTouched.current}
							onForkDraft={(checked) => {
								forkTouched.current = true;
								setForkDraft(checked);
							}}
						/>
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

/** A stepper's figure rolls in from the side it moves toward (the 400ms indicator ramp,
 *  DESIGN.md Motion); typing never rolls, and reduced motion keeps it still. */
function rollFigure(button: HTMLElement, dir: 1 | -1): void {
	const figure = button.parentElement?.querySelector("input");
	if (!figure || window.matchMedia("(prefers-reduced-motion: reduce)").matches)
		return;
	figure.animate(
		[
			{ transform: `translateY(${dir * 40}%)`, opacity: 0 },
			{ transform: "none", opacity: 1 },
		],
		{ duration: 400, easing: "cubic-bezier(0.2, 0.7, 0.3, 1)" },
	);
}

/** How many agent turns can run at once: the board cap, else what the project caps add up
 *  to; a project without its own cap lifts the project limit. `limit` null means no limit;
 *  `why` names what sets it. */
export function runCeiling(
	maxTotal: number | null,
	projects: readonly ProjectView[],
): { limit: number | null; why: string } {
	const uncapped = projects
		.filter((p) => p.settings.maxParallel === null)
		.map((p) => projectLabel(p));
	const projectLimit =
		projects.length === 0 || uncapped.length > 0
			? null
			: projects.reduce((sum, p) => sum + (p.settings.maxParallel ?? 0), 0);
	if (maxTotal !== null && (projectLimit === null || maxTotal <= projectLimit))
		return { limit: maxTotal, why: "The board cap sets it" };
	if (projectLimit !== null)
		return { limit: projectLimit, why: "The project caps add up to it" };
	return {
		limit: null,
		why:
			uncapped.length > 0
				? `No board cap, and ${uncapped.join(", ")} ${uncapped.length === 1 ? "has" : "have"} no project cap`
				: "No board cap and no projects",
	};
}

/** How long the runner cap waits after the last click or keystroke before it saves. */
const CAP_SAVE_DELAY_MS = 500;

function TotalRunnersForm({
	maxTotal,
	projects,
	act,
}: {
	maxTotal: number | null;
	projects: ProjectView[];
	act: Act;
}) {
	const [n, setN] = useState(maxTotal === null ? "" : String(maxTotal));
	const s = useInstantSave(act);
	// "below 1 = no cap": an empty field or a figure under 1 clears the cap.
	const typed = Math.trunc(Number(n));
	const next = n.trim() === "" || !(typed >= 1) ? null : typed;
	// The cap counts as edited only when the input moved off the server value: an
	// untouched input must not save its clamped form (a server cap below 1, e.g.
	// OMP_TRACKER_MAX_TOTAL=0, would otherwise jump to 1).
	const capEdited = n !== (maxTotal === null ? "" : String(maxTotal));
	const dirty = capEdited && next !== maxTotal;
	// Saves on its own, like a checkbox row: each click or keystroke restarts a short wait, so
	// a burst of steps sends one save. A save never overlaps a running one, and a value that
	// was already sent (even one that failed) waits for the next change instead of retrying.
	const sent = useRef<number | null | undefined>(undefined);
	// s.run is a new function each render; a board refresh must not restart the wait.
	const run = useRef(s.run);
	useEffect(() => {
		run.current = s.run;
	});
	useEffect(() => {
		if (!dirty || s.busy || next === sent.current) return;
		const t = setTimeout(() => {
			sent.current = next;
			run.current(() => post("/api/settings", { maxTotal: next }));
		}, CAP_SAVE_DELAY_MS);
		return () => clearTimeout(t);
	}, [dirty, next, s.busy]);
	const ceiling = runCeiling(maxTotal, projects);
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
					: `At most ${maxTotal} agents run at once across all projects; project caps can set a lower limit.`
			}
		>
			<form className="alate-def-rows" onSubmit={(e) => e.preventDefault()}>
				<div className="alate-def-row cap-row">
					<div className="alate-def-name">
						<b>
							Runner cap
							<Help
								label="Runner cap"
								text="The most agent turns that run at the same time on this board. Other tasks wait in Todo until a slot is free. Each project can also set its own cap."
							/>
							<SaveTick
								busy={s.busy}
								saved={s.saved}
								failed={s.failed}
								reason={s.reason}
							/>
						</b>
						<code>below 1 = no cap</code>
					</div>
					<div className="cap-ctl">
						<div className="cap-step">
							<button
								type="button"
								aria-label="One runner fewer"
								disabled={n === ""}
								onClick={(e) => {
									setN((v) => (Number(v) <= 1 ? "" : String(Number(v) - 1)));
									rollFigure(e.currentTarget, -1);
								}}
							>
								<Icon name="minus" size={14} />
							</button>
							<input
								type="number"
								min={1}
								value={n}
								placeholder="–"
								onChange={(e) => setN(e.target.value)}
								aria-label="Runner cap across all projects (empty = no cap)"
							/>
							<button
								type="button"
								aria-label="One runner more"
								onClick={(e) => {
									setN((v) => String(v === "" ? 1 : Number(v) + 1));
									rollFigure(e.currentTarget, 1);
								}}
							>
								<Icon name="plus" size={14} />
							</button>
						</div>
						{n === "" && <span className="cap-unlimited">unlimited</span>}
					</div>
				</div>
				<div className="alate-def-row">
					<div className="alate-def-name">
						<b>Runs at once</b>
						<span>{ceiling.why}</span>
					</div>
					<span
						className={ceiling.limit === null ? "runs-fig none" : "runs-fig"}
					>
						{ceiling.limit ?? "No limit"}
					</span>
				</div>
			</form>
		</SettingsCard>
	);
}

/** Board-wide switches that check an agent's work with a second model before it moves on. */
function ChecksSection({
	reviewCheck,
	workCheck,
	act,
}: {
	reviewCheck: boolean;
	workCheck: boolean;
	act: Act;
}) {
	const send = (body: Record<string, unknown>): Promise<unknown> =>
		post("/api/settings", body);
	return (
		<SettingsCard
			id="checks-section"
			title="Checks"
			status={onChip([reviewCheck, workCheck])}
		>
			<div className="alate-def-rows">
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
			</div>
		</SettingsCard>
	);
}

/** Board-wide jobs that start on their own: idle architecture reviews and the weekly
 *  trending scan (whose button runs a scan now, whether or not the schedule is on). */
function AutomationSection({
	idleReviews,
	trendingScan,
	trendingStatus,
	act,
}: {
	idleReviews: boolean;
	trendingScan: boolean;
	trendingStatus: TrendingStatus;
	act: Act;
}) {
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
			? `Failed: ${trendingStatus.lastError.reason} (${stamp(trendingStatus.lastError.at)})`
			: trendingStatus.lastRunAt !== null
				? stamp(trendingStatus.lastRunAt)
				: "Never";
	return (
		<SettingsCard
			id="automation-section"
			title="Automation"
			status={onChip([idleReviews, trendingScan])}
		>
			<div className="alate-def-rows">
				<CheckRow
					name="Run due reviews while idle"
					desc="After two hours without input, and while no turn runs, the board files the architecture review card of the first project whose review is due, by itself"
					checked={idleReviews}
					save={(v) => send({ idleReviews: v })}
					act={act}
				/>
				{/* The checkbox is the weekly schedule only; Scan trending now runs a scan
				    whether or not it is checked. */}
				<CheckRow
					name="Weekly trending scan"
					desc={
						<>
							Mondays at 06:00 (server time): up to 3 backlog proposals per
							project with Trending scout on.{" "}
							{trendingStatus.running
								? "A scan is running."
								: `Last scan: ${lastScan}.`}{" "}
							<span role="status">
								{scanResult?.ok === true ? "Scan started." : ""}
							</span>
						</>
					}
					checked={trendingScan}
					save={(v) => send({ trendingScan: v })}
					act={act}
					action={
						<BusyButton run={scanNow} disabled={trendingStatus.running}>
							Scan trending now
						</BusyButton>
					}
				/>
			</div>
			{scanResult?.ok === false && (
				<p className="auth-error" role="alert">
					{scanResult.error}
				</p>
			)}
		</SettingsCard>
	);
}

/** The Git identity card: who the board is to git hosts (the global SSH key block, passed in
 *  by the git hosts state) and on commits. OTTR-693: the name and email git commits with when
 *  the project or the home's own git config names none. Empty fields keep the built-in Ottr
 *  and ottr@localhost; a configured ~/.gitconfig identity wins over the default. */
function GitIdentitySection({
	commitIdentity,
	sshKey,
	keySet,
	act,
}: {
	commitIdentity: CommitIdentity | null;
	sshKey: ReactNode;
	/** The global SSH key exists; null while the git hosts state loads. */
	keySet: boolean | null;
	act: Act;
}) {
	const [name, setName] = useState(commitIdentity?.name ?? "");
	const [email, setEmail] = useState(commitIdentity?.email ?? "");
	const s = useInstantSave(act);
	const formId = useId();
	// Empty inputs count as null (the built-in default); either input off the server
	// value marks the form dirty. Both fields always go out together.
	const dirty =
		name.trim() !== (commitIdentity?.name ?? "") ||
		email.trim() !== (commitIdentity?.email ?? "");
	return (
		<SettingsCard
			id="commit-identity-section"
			title="Git identity"
			status={{
				label: [
					...(keySet === null ? [] : [keySet ? "SSH key" : "No SSH key"]),
					commitIdentity === null ? "Default author" : commitIdentity.name,
				].join(" · "),
				tone: keySet === true || commitIdentity !== null ? "ok" : "off",
			}}
		>
			{sshKey}
			<div className="sec-block" id="commit-identity-block" tabIndex={-1}>
				<h4>Commit identity</h4>
				<p className="hint">
					The name and email git commits with when the project or the home's own
					git config names none. Empty keeps the built-in Ottr and
					ottr@localhost; a configured ~/.gitconfig identity wins over the
					default.
				</p>
				<form
					id={formId}
					className="alate-def-rows"
					onSubmit={(e) => {
						e.preventDefault();
						if (!dirty) return;
						const n = name.trim();
						const m = email.trim();
						s.run(() =>
							post("/api/settings", {
								commitName: n === "" ? null : n,
								commitEmail: m === "" ? null : m,
							}),
						);
					}}
				>
					<div className="alate-def-row">
						<div className="alate-def-name">
							<b>
								Commit name
								<Help
									label="Commit name"
									text="Labels every commit a turn or the board makes when no other git config names an author."
								/>
							</b>
							<code>empty = Ottr</code>
						</div>
						<div className="alate-def-actions">
							<label>
								<input
									type="text"
									value={name}
									onChange={(e) => setName(e.target.value)}
									aria-label="Commit name (empty = Ottr)"
								/>
							</label>
						</div>
					</div>
					<div className="alate-def-row">
						<div className="alate-def-name">
							<b>
								Commit email
								<Help
									label="Commit email"
									text="The address on every commit a turn or the board makes when no other git config names one."
								/>
							</b>
							<code>empty = ottr@localhost</code>
						</div>
						<div className="alate-def-actions">
							<label>
								<input
									type="text"
									value={email}
									onChange={(e) => setEmail(e.target.value)}
									aria-label="Commit email (empty = ottr@localhost)"
								/>
							</label>
							<SaveButton form={formId} s={s} dirty={dirty} />
						</div>
					</div>
				</form>
			</div>
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
	// Ties each titled part (a fieldset) to its title for screen readers.
	const uid = useId();
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
	// Endpoints recovery already ran for: one pass per subscription, no loop.
	const recoveredRef = useRef<Set<string>>(new Set());
	// Queued completion work from a failed flow (ADR-0011): the next load
	// retries the whole completion — subscribe, classes transfer, old-row
	// drop — until every step succeeds. typeof guard: server-side render in tests.
	const PENDING_SUBSCRIBE_KEY = "ottr.push.pendingSubscribe";
	// One best-effort replay pass per load: no loop.
	const pendingRetriedRef = useRef(false);
	type PendingSubscribeRecord = {
		subscription: unknown;
		oldEndpoint: string | null;
		classes: ClassPrefs | null;
	};
	const queuePendingSubscribe = (
		sub: { toJSON(): unknown },
		oldEndpoint: string | null,
		classes: ClassPrefs | null,
	): void => {
		if (typeof localStorage === "undefined") return;
		try {
			const record: PendingSubscribeRecord = {
				subscription: sub.toJSON(),
				oldEndpoint,
				classes,
			};
			localStorage.setItem(PENDING_SUBSCRIBE_KEY, JSON.stringify(record));
		} catch {
			// No storage: nothing to queue; the kept-subscription state still reports.
		}
	};
	// The enable flow's core, shared with stale-sub recovery (ADR-0011): ready →
	// key → subscribe under the current public key → POST. No permission prompt here.
	// Returns the subscription so the caller can queue its context on a failure.
	const subscribeNew = async (): Promise<{
		endpoint: string;
		toJSON(): unknown;
	}> => {
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
		try {
			await post("/api/push/subscribe", sub.toJSON());
		} catch (err) {
			// ADR-0011 recovery: a subscription without a server row sends to a dead
			// address and never reports stale — undo it so the UI shows the truth.
			// When the browser refuses the undo, the caller queues the full
			// completion record for a retry on the next load.
			const failure = new Error(
				err instanceof Error ? err.message : String(err),
			);
			try {
				await sub.unsubscribe();
			} catch {
				const kept = failure as Error & {
					keptSubscription?: boolean;
					endpoint?: string;
					keptSub?: { toJSON(): unknown };
				};
				kept.keptSubscription = true;
				kept.endpoint = sub.endpoint;
				kept.keptSub = sub;
				throw kept;
			}
			throw failure;
		}
		return sub;
	};
	// A failed recovery must show the real state: no browser subscription, so
	// the section reports the failure and offers the "Turn on" control
	// (ADR-0011) instead of a dead endpoint.
	const markRecoveryFailed = (err: unknown): void => {
		setEnabled(false);
		setEndpoint(null);
		setClasses(null);
		setError(err instanceof Error ? err.message : String(err));
	};
	// Real state, not last-click: the flag reflects whether this device holds a subscription.
	// The browser's subscription is registered again before the prefs load: a board that lost
	// it (a new data folder, a restored backup) would answer "unknown endpoint" and hide the
	// event switches. A re-subscribe keeps the device's saved switches on the server.
	useEffect(() => {
		if (!supported) return;
		void navigator.serviceWorker
			.getRegistration()
			.then(async (reg) => {
				const sub = await reg?.pushManager.getSubscription();
				// The browser's subscription is registered again before the prefs load: a
				// board that lost its row (a new data folder, a restored backup) would
				// answer "unknown endpoint" and hide the event switches. A re-subscribe
				// keeps the device's saved switches on the server. The ADR-0011 kept
				// path below still queues a full completion when this POST fails.
				if (sub != null) await post("/api/push/subscribe", sub.toJSON());
				setEnabled(sub != null);
				setEndpoint(sub?.endpoint ?? null);
				// ADR-0011 recovery: a queued subscribe POST from a failed flow retries
				// once per load, before anything else touches the subscription.
				// Storage may be absent (test DOM): a missing store means nothing queued.
				const pendingRaw =
					typeof localStorage !== "undefined"
						? localStorage.getItem(PENDING_SUBSCRIBE_KEY)
						: null;
				if (!pendingRetriedRef.current && pendingRaw !== null) {
					pendingRetriedRef.current = true;
					try {
						const record = JSON.parse(
							localStorage.getItem(PENDING_SUBSCRIBE_KEY) ?? "null",
						) as PendingSubscribeRecord | null;
						if (record !== null && typeof record === "object") {
							// ADR-0011: replay the whole completion in order; every step
							// is idempotent, so any failure keeps the record for the next load.
							const queued = record.subscription as {
								endpoint?: string;
							};
							await post("/api/push/subscribe", record.subscription);
							if (
								record.oldEndpoint !== null &&
								record.oldEndpoint !== queued.endpoint
							) {
								if (record.classes !== null) {
									await post("/api/notifications/prefs", {
										endpoint: queued.endpoint,
										classes: record.classes,
									});
								}
								await post("/api/push/unsubscribe", {
									endpoint: record.oldEndpoint,
								});
							}
							localStorage.removeItem(PENDING_SUBSCRIBE_KEY);
						}
					} catch {
						// Silent: the next load retries the same queued record.
					}
				}
				if (sub == null) return;
				// ADR-0011 recovery: a subscription bound to a replaced VAPID key can
				// never receive. When the server reports it stale and permission was
				// already granted, re-subscribe under the new key without a prompt.
				const endpoint = sub.endpoint;
				const { stale } = await unwrap<{ stale: boolean }>(
					await fetch(
						`/api/push/config?endpoint=${encodeURIComponent(endpoint)}`,
					),
				);
				if (
					!stale ||
					Notification.permission !== "granted" ||
					recoveredRef.current.has(endpoint)
				)
					return;
				recoveredRef.current.add(endpoint);
				// ADR-0011 recovery: read the old row's classes first — a failed read
				// mutates nothing, so the browser subscription and the stale row both
				// stay and the whole recovery retries on the next load.
				let carried: ClassPrefs | null = null;
				try {
					const p = await unwrap<{
						classes: ClassPrefs | null;
					}>(
						await fetch(
							`/api/notifications/prefs?endpoint=${encodeURIComponent(endpoint)}`,
						),
					);
					carried = p.classes;
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
					return;
				}
				// A failed browser unsubscribe leaves the real subscription in place,
				// so "Turn off" stays and the kept stale row re-offers recovery.
				try {
					await sub.unsubscribe();
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
					return;
				}
				try {
					const fresh = await subscribeNew();
					if (fresh.endpoint !== endpoint) {
						// Same endpoint: the subscribe replaced the row in place, classes
						// kept server-side. A moved endpoint must carry the classes before
						// the old row drops: a failed transfer leaves the old row
						// stale-bound, so a later load can retry the whole recovery.
						if (carried !== null) {
							try {
								await post("/api/notifications/prefs", {
									endpoint: fresh.endpoint,
									classes: carried,
								});
							} catch (err) {
								// ADR-0011: queue the completion — the next load transfers
								// the classes and drops the old row. The switches show the
								// preferences the retry will restore.
								queuePendingSubscribe(fresh, endpoint, carried);
								setEnabled(true);
								setEndpoint(fresh.endpoint);
								setClasses(carried);
								setError(err instanceof Error ? err.message : String(err));
								return;
							}
						}
						// A leftover here is a dead row a later send-prune can drop.
						void post("/api/push/unsubscribe", { endpoint }).catch(() => {});
					}
					// Server truth last: the switches match the restored preferences
					// immediately; the prefs effect refetches and confirms.
					setEnabled(true);
					setEndpoint(fresh.endpoint);
					setClasses(carried);
				} catch (err) {
					const kept = err as Error & {
						keptSubscription?: boolean;
						endpoint?: string;
						keptSub?: { toJSON(): unknown };
					};
					if (kept.keptSubscription && kept.keptSub) {
						// ADR-0011: the browser holds the subscription and the server has
						// no row — queue the completion and report the truth: subscribed,
						// registration pending.
						queuePendingSubscribe(kept.keptSub, endpoint, carried);
						setEnabled(true);
						setEndpoint(kept.endpoint ?? null);
						setError(err instanceof Error ? err.message : String(err));
					} else {
						markRecoveryFailed(err);
					}
				}
			})
			.catch((err) => {
				setError(err instanceof Error ? err.message : String(err));
			});
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
				const endpoint = await subscribeNew();
				setEnabled(true);
				setEndpoint(endpoint.endpoint);
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
				<fieldset
					className="notify-group sec-block"
					aria-labelledby={`${uid}-events`}
				>
					<h4 id={`${uid}-events`}>This device</h4>
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
				<fieldset
					className="notify-group sec-block"
					aria-labelledby={`${uid}-muted`}
				>
					<h4 id={`${uid}-muted`}>Muted projects</h4>
					{byLabel(projects).map((p) => (
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

/** The reorder slot an Alt+Arrow requests on the row at index `i`: the name to land
 *  before, null for the end, or undefined when the key does not reorder the row. */
const arrowSlot = (
	key: string,
	view: readonly string[],
	i: number,
): string | null | undefined => {
	if (key === "ArrowUp" && i > 0) return view[i - 1];
	if (key === "ArrowDown" && i < view.length - 1) return view[i + 2] ?? null;
	return undefined;
};

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
	// Keyboard reorder: Alt+Arrow moves the focused row; blocked while a save runs.
	const onReorderKeyDown = (e: KeyboardEvent<HTMLUListElement>): void => {
		if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
		const id = (e.target as HTMLElement).closest<HTMLElement>("[data-name]")
			?.dataset.name;
		if (id === undefined) return;
		const i = view.indexOf(id);
		if (i < 0) return;
		const slot = arrowSlot(e.key, view, i);
		if (slot === undefined) return;
		e.preventDefault();
		save(moved(id, slot));
	};
	return (
		<SettingsCard
			id="projects-section"
			title="Projects"
			hint="Drag a project to move it. The new order saves at once."
			// The footer draws a border, so it only renders while it has a tick to show.
			footer={
				busy || s.saved || s.failed ? (
					<SaveTick
						busy={busy}
						saved={s.saved}
						failed={s.failed}
						reason={s.reason}
					/>
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
				onKeyDown={busy ? undefined : onReorderKeyDown}
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

/** Warn note for a stored secret the server cannot decrypt; same wording as the Jira connections. */
function UnreadableSecretNote() {
	return (
		<p className="hint">
			<span className="jira-conn-warn">
				<Mark kind="warn" />
				Token unreadable, enter it again
			</span>
		</p>
	);
}
/** Shared write-only secret form: loads whether it is set, saves a pasted value, flashes "Saved". */
function SecretTokenForm<
	T extends { tokenSet: boolean; tokenReadable?: boolean },
>({
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
	const [tokenReadable, setTokenReadable] = useState(true);
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
				setTokenReadable(cfg.tokenReadable !== false);
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
				setTokenReadable(cfg.tokenReadable !== false);
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
					{tokenSet === true && !tokenReadable && <UnreadableSecretNote />}
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
	/** The saved app as this view reports it: the fingerprint may be unknown and the key unreadable. */
	githubApp:
		| (Omit<GitHubAppView, "fingerprint"> & {
				fingerprint: string | null;
				keyReadable: boolean;
		  })
		| null;
	tokens: {
		host: string;
		username: string;
		tokenSet: boolean;
		/** false => the stored token cannot be decrypted; the user must enter it again. */
		tokenReadable: boolean;
	}[];
	globalKey: KeyInfo | null;
	githubHost: string | null;
	githubTokenSet: boolean;
	/** false => the stored GitHub token cannot be decrypted; the user must enter it again. */
	githubTokenReadable: boolean;
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
export const asError = (
	d: Record<string, unknown>,
	status: number,
	what: string,
): string =>
	typeof d.error === "string"
		? d.error
		: `${what} failed: the server answered ${status} (${httpStatusWords(status)}). ${httpNextStep(status)}`;
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
		: (asTrust(data) ?? { error: asError(data, status, "the SSH key test") });

/** The summary line for a clean install check: what the app covers. */
const installSummary = (check: AppCheck): string =>
	check.repos.length === 0
		? "No board project has a GitHub repo."
		: check.private.length === 0
			? `Installed on all ${check.repos.length} board repos.`
			: `Installed on all public board repos; ${check.private.length} private repo${check.private.length === 1 ? "" : "s"} skipped.`;

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
					<span>{installSummary(check)}</span>
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
					setError(asError(data, status, "saving the pasted key"));
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
	if (s.tokens.some((t) => t.tokenSet && !t.tokenReadable))
		return { label: "Token unreadable", tone: "warn" };
	const n = s.tokens.filter((t) => t.tokenSet).length;
	return n === 0
		? { label: "None", tone: "off" }
		: { label: `${n} token${n === 1 ? "" : "s"}`, tone: "ok" };
}

/** The GitHub card's chip: the board token, then the App when one is set. */
function githubChip(
	s: GitHostsView | null,
): { label: string; tone: ChipTone } | undefined {
	if (s === null) return undefined;
	return {
		label: [
			s.githubTokenSet ? "Token set" : "No token",
			...(s.githubApp !== null ? ["App"] : []),
		].join(" · "),
		tone: s.githubTokenSet ? "ok" : "off",
	};
}

/** The "GitHub App" block: the saved app's card, or the id and key form while it is open. */
/** The App block's chip: not set, still checking, the check failed, repos it does not
 *  reach, or working (the name lookup passed and every board repo has an install). */
export function appChip(app: GitHubAppView | null): {
	label: string;
	tone: ChipTone;
} {
	if (app === null) return { label: "Not set", tone: "off" };
	const c = app.check;
	if (c === null) return { label: "Checking", tone: "off" };
	if (c.error !== null) return { label: "Check failed", tone: "warn" };
	const gaps = c.missing.length + c.failed.length;
	if (gaps > 0)
		return {
			label: `Not on ${gaps} repo${gaps === 1 ? "" : "s"}`,
			tone: "warn",
		};
	return { label: "Working", tone: "ok" };
}

/** A state chip outside a card head (a block title), same look as the card's. */
function StateChip({ label, tone }: { label: string; tone: ChipTone }) {
	return <span className={`state-chip ${tone}`}>{label}</span>;
}

function GitHubAppBlock({
	state,
	formOpen,
	setFormOpen,
	appId,
	setAppId,
	appKey,
	setAppKey,
	busy,
	onSave,
	onRemove,
	heading,
}: {
	state: GitHostsView | null;
	formOpen: boolean;
	setFormOpen: (open: boolean) => void;
	appId: string;
	setAppId: (v: string) => void;
	appKey: string;
	setAppKey: (v: string) => void;
	busy: BusyState;
	onSave: () => void;
	onRemove: () => Promise<boolean>;
	/** The block title; null hides it where the card title or the row name already says it. */
	heading?: string | null;
}) {
	return (
		<div className="sec-block" id="github-app-block" tabIndex={-1}>
			{heading !== null && (
				<h4 className="block-head">
					{heading ?? "GitHub App"}
					{state !== null && <StateChip {...appChip(state.githubApp)} />}
				</h4>
			)}
			<p className="hint">
				Optional. When it is set, posted PR reviews show as the app (a bot
				account) instead of your own GitHub account.
			</p>
			{state !== null && state.githubApp !== null && !formOpen ? (
				<div>
					<div className="settings-field">
						App ID <code>{state.githubApp.id}</code>
					</div>
					<AppCheckLines check={state.githubApp.check} />
					{!state.githubApp.keyReadable ? (
						<p className="hint">
							<span className="jira-conn-warn">
								<Mark kind="warn" />
								Token unreadable, enter it again
							</span>
						</p>
					) : null}
					{state.githubApp.fingerprint !== null && (
						<p className="hint">
							Key set. Fingerprint <code>{state.githubApp.fingerprint}</code>
						</p>
					)}
					<button type="button" onClick={() => setFormOpen(true)}>
						Replace key
					</button>{" "}
					<BusyButton className="danger" run={onRemove}>
						Remove
					</BusyButton>
				</div>
			) : (
				<form
					className="settings-form"
					onSubmit={(e) => {
						e.preventDefault();
						onSave();
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
					{state?.githubApp != null && !state.githubApp.keyReadable && (
						<UnreadableSecretNote />
					)}
					<div className="alate-def-actions">
						{state !== null && state.githubApp !== null && (
							<button type="button" onClick={() => setFormOpen(false)}>
								Cancel
							</button>
						)}
						<button
							type="submit"
							disabled={busy.busy}
							aria-busy={busy.busy || undefined}
							className={busy.failed ? "failed" : ""}
						>
							{busy.busy && <span className="spinner" aria-hidden="true" />}
							Save
						</button>
					</div>
				</form>
			)}
		</div>
	);
}

/** The GitHub card's "Connection" block: where GitHub lives and the board token, saved
 *  together by one Save (a host change, a pasted token, or both). */
function GitHubConnectionBlock({
	state,
	draft,
	setDraft,
	token,
	setToken,
	tokenCfg,
	busy,
	saved,
	dirty,
	onSave,
}: {
	state: GitHostsView | null;
	draft: string | null;
	setDraft: (v: string) => void;
	token: string;
	setToken: (v: string) => void;
	/** The board token check; null while it loads or after it failed (never claim "Not set"). */
	tokenCfg: {
		tokenSet: boolean;
		tokenReadable?: boolean;
		expiresAt: string | null;
	} | null;
	busy: BusyState;
	saved: boolean;
	dirty: boolean;
	onSave: () => void;
}) {
	const expiry = tokenCfg === null ? null : expiryLine(tokenCfg.expiresAt);
	return (
		<div className="sec-block" id="github-host-block" tabIndex={-1}>
			<h4>Connection</h4>
			<form
				className="settings-form"
				onSubmit={(e) => {
					e.preventDefault();
					onSave();
				}}
			>
				<div className="alate-def-rows">
					<DefRow
						name="Host"
						help="Where GitHub lives for this board: github.com, a *.ghe.com Enterprise Cloud host, or an Enterprise Server host. It steers the API calls, gh, PR links, releases and fork research. A saved value wins over the OTTR_GITHUB_HOST env. Empty resets to the env value or github.com."
						shape="bare hostname"
					>
						<label>
							<input
								value={draft ?? state?.githubHost ?? ""}
								onChange={(e) => setDraft(e.target.value)}
								placeholder="github.com"
								spellCheck={false}
								aria-label="GitHub host"
							/>
						</label>
					</DefRow>
					<div id="github-token-block" tabIndex={-1}>
						<DefRow
							name="Token"
							help="The board uses this token for its own git fetches, pushes and GitHub releases. Agents on workers never get it."
							shape={`secret · stored, never shown${expiry === null ? "" : ` · ${expiry}`}`}
						>
							<label>
								<input
									type="password"
									value={token}
									onChange={(e) => setToken(e.target.value)}
									placeholder={
										tokenCfg === null
											? "Unknown: the check failed"
											: tokenCfg.tokenSet
												? "Set · paste a new token to replace it"
												: "Not set: fetch and push fail"
									}
									autoComplete="off"
									spellCheck={false}
									aria-label="GitHub token"
								/>
							</label>
						</DefRow>
						{tokenCfg?.tokenSet === true && tokenCfg.tokenReadable === false && (
							<UnreadableSecretNote />
						)}
					</div>
				</div>
				<div className="alate-def-actions">
					<button
						type="submit"
						disabled={busy.busy || !dirty}
						className={busy.failed ? "failed" : undefined}
					>
						{busy.busy && <span className="spinner" aria-hidden="true" />}
						<SaveLabel saved={saved} />
					</button>
				</div>
			</form>
			{state !== null && state.githubHost === null && (
				<p className="hint">
					OTTR_GITHUB_HOST is invalid — use a bare hostname, for example
					acme.ghe.com
				</p>
			)}
		</div>
	);
}

/** The "Global SSH key" block: the saved key's card or the empty hint, the pending key
 *  row, and the test and save prompts. */
function GlobalKeyBlock({
	state,
	pending,
	setPending,
	gUrl,
	setGUrl,
	gTest,
	gSave,
	onRemove,
	heading,
}: {
	state: GitHostsView | null;
	pending: PendingKeyInfo | null;
	setPending: (p: PendingKeyInfo | null) => void;
	gUrl: string;
	setGUrl: (v: string) => void;
	gTest: { button: ReactNode; result: ReactNode };
	gSave: { button: ReactNode; result: ReactNode };
	onRemove: () => Promise<boolean>;
	/** The block title; null hides it where the card title or the row name already says it. */
	heading?: string | null;
}) {
	return (
		<div className="sec-block" id="ssh-key-block" tabIndex={-1}>
			{heading !== null && <h4>{heading ?? "Global SSH key"}</h4>}
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
								onClick={() => void copyText(state.globalKey?.publicKey ?? "")}
							>
								Copy key
							</button>
							<BusyButton className="danger" run={onRemove}>
								Remove
							</BusyButton>
						</div>
					</div>
				))}
			<p className="hint">
				Save replaces the global key: every project without its own key uses the
				new one.
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
							inputMode="url"
							spellCheck={false}
							autoComplete="off"
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
	);
}

/** Settings "Git hosts" section: per-host HTTPS tokens and the server-side global SSH key.
 *  Token values are write-only: the server never returns them and the UI never shows one. */
/** The board's git credentials as three cards: GitHub (host, token, App), the HTTPS tokens of
 *  other git hosts, and the Git identity card (global SSH key and commit identity). */
export function GitHostsSection({
	commitIdentity,
	act,
}: {
	commitIdentity: CommitIdentity | null;
	act: Act;
}) {
	const [state, setState] = useState<GitHostsView | null>(null);
	const [error, setError] = useState<string | null>(null);
	// Add-token form; `replace` pre-fills it from a listed token.
	const [tHost, setTHost] = useState("");
	const [tUser, setTUser] = useState("oauth2");
	const [tUserEdited, setTUserEdited] = useState(false);
	const [tToken, setTToken] = useState("");
	const [tUrl, setTUrl] = useState("");
	// The reuse offer's own test URL and busy lane, so a save in the add form
	// never spins the offer's button.
	const [offerUrl, setOfferUrl] = useState("");
	const offerBusy = useBusy();
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
				if (status !== 200)
					throw new Error(asError(data, status, "testing the token"));
				setTToken("");
				setTUser(defaultGitUsername(tHost.trim(), state?.githubHost ?? null));
				await load();
				return true;
			}),
		);
	};
	// The proactive offer: the board token is set and the configured GitHub host is
	// neither github.com nor carrying a git-host entry yet, so a first clone on that
	// host would fail. On github.com the board token already serves git — the worker
	// image pins its credential helper for https://github.com and gitAuthEnv adds the
	// ambient helpers — so there is nothing to offer there. The offer names that one
	// host only, and applying stays the user's explicit click.
	const boardTokenOffer =
		state !== null &&
		state.githubTokenSet === true &&
		state.githubHost !== null &&
		state.githubHost.toLowerCase() !== "github.com" &&
		!state.tokens.some((t) => t.host === state.githubHost);
	const applyOfferBoardToken = (): void => {
		offerBusy.start(() =>
			run(async () => {
				const { status, data } = await gitReq(
					"POST",
					"/api/git-hosts/github-token",
					{ testUrl: offerUrl.trim() },
				);
				if (status !== 200)
					throw new Error(asError(data, status, "testing the token"));
				setOfferUrl("");
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
				if (status !== 200)
					throw new Error(asError(data, status, "saving the token"));
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
			if (status !== 200)
				throw new Error(
					asError(data, status, `removing the token for ${host}`),
				);
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
			if (status !== 200)
				throw new Error(asError(data, status, "removing the global SSH key"));
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
				if (status !== 200)
					throw new Error(asError(data, status, "saving the GitHub App"));
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
			if (status !== 200)
				throw new Error(asError(data, status, "removing the GitHub App"));
			await load();
			return true;
		});
	// The Connection block: a typed GitHub token (never shown back) and its check.
	const [ghToken, setGhToken] = useState("");
	const [ghTokenCfg, setGhTokenCfg] = useState<{
		tokenSet: boolean;
		tokenReadable?: boolean;
		expiresAt: string | null;
	} | null>(null);
	const [ghSaved, flashGhSaved] = useFlash(1500);
	useEffect(() => {
		let live = true;
		fetch("/api/settings/github-token")
			.then((res) =>
				unwrap<{
					tokenSet: boolean;
					tokenReadable?: boolean;
					expiresAt: string | null;
				}>(res),
			)
			.then((cfg) => {
				if (live) setGhTokenCfg(cfg);
			})
			.catch((err) => {
				if (live) setError(err instanceof Error ? err.message : String(err));
			});
		return () => {
			live = false;
		};
	}, []);
	const ghDirty = ghHostDraft !== null || ghToken.trim() !== "";
	// One Save for the Connection block: the host when edited (an empty field clears the saved
	// value), then the token when one is pasted. A failed host save stops before the token.
	const saveConnection = (): void => {
		ghBusy.start(() =>
			run(async () => {
				if (ghHostDraft !== null) {
					const { status, data } = await gitReq(
						"POST",
						"/api/settings/github-host",
						{ host: ghHostDraft.trim() },
					);
					if (status !== 200)
						throw new Error(asError(data, status, "saving the GitHub host"));
					setGhHostDraft(null);
				}
				if (ghToken.trim() !== "") {
					const cfg = await post<{
						tokenSet: boolean;
						tokenReadable?: boolean;
						expiresAt: string | null;
					}>("/api/settings/github-token", { token: ghToken.trim() });
					setGhTokenCfg(cfg);
					setGhToken("");
				}
				await load();
				flashGhSaved();
				return true;
			}),
		);
	};
	// The cards' blocks; a heading null drops a title the card or the row name already says.
	const connectionB = (
		<GitHubConnectionBlock
			state={state}
			draft={ghHostDraft}
			setDraft={setGhHostDraft}
			token={ghToken}
			setToken={setGhToken}
			tokenCfg={ghTokenCfg}
			busy={ghBusy}
			saved={ghSaved}
			dirty={ghDirty}
			onSave={saveConnection}
		/>
	);
	const appB = (h?: string | null) => (
		<GitHubAppBlock
			heading={h}
			state={state}
			formOpen={appFormOpen}
			setFormOpen={setAppFormOpen}
			appId={appId}
			setAppId={setAppId}
			appKey={appKey}
			setAppKey={setAppKey}
			busy={appBusy}
			onSave={saveApp}
			onRemove={removeApp}
		/>
	);
	const othersB = (h?: string | null) => (
		<div className="sec-block" id="host-tokens-block" tabIndex={-1}>
			{h !== null && <h4>{h ?? "Other host tokens"}</h4>}
			<p className="hint">
				HTTPS tokens for git hosts, one for each host. Ottr tests each token
				with git ls-remote before it saves the token.
			</p>
			{boardTokenOffer && state !== null && (
				<div className="board-token-offer">
					<p className="hint">
						The board GitHub token serves the API and gh. Git on{" "}
						<code>{state.githubHost}</code> needs its own entry here. Without
						one, a first clone fails with a login prompt. Applying stores the
						same token for git on <code>{state.githubHost}</code>. The token's
						scopes must also grant repository read there. Ottr tests that with
						git ls-remote before it saves.
					</p>
					<form
						className="settings-form"
						onSubmit={(e) => {
							e.preventDefault();
							applyOfferBoardToken();
						}}
					>
						<div className="alate-def-rows">
							<DefRow
								name="Test URL"
								help="A repository on the host that the token can read. Ottr runs git ls-remote against it before it saves."
								shape="https URL"
							>
								<label>
									<input
										value={offerUrl}
										onChange={(e) => setOfferUrl(e.target.value)}
										placeholder={`https://${state.githubHost}/org/repo.git`}
										inputMode="url"
										spellCheck={false}
										autoComplete="off"
										required
										aria-label="Test URL for the board token"
									/>
								</label>
							</DefRow>
						</div>
						<div className="alate-def-actions">
							<button
								type="submit"
								disabled={offerBusy.busy}
								className={`primary${offerBusy.failed ? " failed" : ""}`}
							>
								{offerBusy.busy && (
									<span className="spinner" aria-hidden="true" />
								)}
								Store the board token for this host
							</button>
						</div>
					</form>
				</div>
			)}
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
									{t.tokenSet && !t.tokenReadable ? (
										<span className="jira-conn-warn">
											<Mark kind="warn" />
											Token unreadable, enter it again
										</span>
									) : null}{" "}
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
								inputMode="url"
								spellCheck={false}
								autoComplete="off"
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
	);
	const sshB = (h?: string | null) => (
		<GlobalKeyBlock
			heading={h}
			state={state}
			pending={pending}
			setPending={setPending}
			gUrl={gUrl}
			setGUrl={setGUrl}
			gTest={gTest}
			gSave={gSave}
			onRemove={removeGlobal}
		/>
	);
	const errorEl = error !== null && (
		<p className="auth-error" role="alert">
			{error}
		</p>
	);
	return (
		<>
			<SettingsCard
				id="git-hosts-section"
				title="GitHub"
				status={githubChip(state)}
			>
				{connectionB}
				{appB("App")}
			</SettingsCard>
			<SettingsCard
				id="git-other-section"
				title="Other git hosts"
				status={gitHostsChip(state)}
			>
				{othersB(null)}
				{errorEl}
			</SettingsCard>
			<GitIdentitySection
				commitIdentity={commitIdentity}
				sshKey={sshB("SSH key")}
				keySet={state === null ? null : state.globalKey !== null}
				act={act}
			/>
		</>
	);
}

const JIRA_TYPE_LABEL: Record<JiraType, string> = {
	cloud: "Cloud",
	datacenter: "Data Center",
};

/** The site URL check under the field: a detected type, a reason with the manual pick, or a
 *  refused URL (`invalid`, which marks the field). `site` is the URL it answered for. */
type JiraDetect = { site: string; text: string; invalid: boolean };

/** Settings "Jira connections" (docs/specs/jira-import.md section 1): named board-level
 *  connections that projects pick in their own settings. The token is write-only: the
 *  API never returns it, so editing shows only whether one is set. */
export function JiraConnectionsSection() {
	const [list, setList] = useState<JiraConnectionView[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [note, setNote] = useState<string | null>(null);
	// The form; `editing` holds the saved name being edited, null while adding a new one.
	const [editing, setEditing] = useState<string | null>(null);
	const [name, setName] = useState("");
	const [site, setSite] = useState("");
	const [type, setType] = useState<JiraType>("cloud");
	const [email, setEmail] = useState("");
	const [token, setToken] = useState("");
	const [fields, setFields] = useState("");
	const [detect, setDetect] = useState<JiraDetect | null>(null);
	const saveBusy = useBusy();
	const detectBusy = useBusy();
	const ids = useId();
	const load = useCallback(async (): Promise<void> => {
		const { status, data } = await gitReq("GET", "/api/jira/connections");
		if (status !== 200)
			throw new Error(asError(data, status, "loading the Jira connections"));
		setList(data as unknown as JiraConnectionView[]); // server-shaped view; no token in it
	}, []);
	useEffect(() => {
		load().catch((err) =>
			setError(err instanceof Error ? err.message : String(err)),
		);
	}, [load]);
	// One guarded call: the error lands on the section's alert line, the answer tells the caller.
	const run = async (fn: () => Promise<boolean>): Promise<boolean> => {
		setError(null);
		setNote(null);
		try {
			return await fn();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			return false;
		}
	};
	const reset = (): void => {
		setEditing(null);
		setName("");
		setSite("");
		setType("cloud");
		setEmail("");
		setToken("");
		setFields("");
		setDetect(null);
	};
	const edit = (c: JiraConnectionView): void => {
		setEditing(c.name);
		setName(c.name);
		setSite(c.site);
		setType(c.type);
		setEmail(c.email ?? "");
		setToken("");
		setFields(c.customFields.join(", "));
		setDetect(null);
		setError(null);
		setNote(null);
	};
	const editingView = list?.find((c) => c.name === editing) ?? null;
	// Asks the server for the deployment type; the type select stays editable either way.
	const runDetect = (): void => {
		const s = site.trim();
		if (s === "") return;
		detectBusy.start(async () => {
			try {
				const { status, data } = await gitReq("POST", "/api/jira/detect", {
					site: s,
				});
				if (status !== 200) {
					setDetect({
						site: s,
						text: asError(data, status, "checking the site URL"),
						invalid: true,
					});
					return false;
				}
				if (data.type === "cloud" || data.type === "datacenter") {
					setType(data.type);
					setDetect({
						site: s,
						text: `Detected: ${JIRA_TYPE_LABEL[data.type]}`,
						invalid: false,
					});
					return true;
				}
				setDetect({
					site: s,
					text: `No type detected: ${typeof data.reason === "string" ? data.reason : "the site gave no deployment type"}. Pick Cloud or Data Center below.`,
					invalid: false,
				});
				return true;
			} catch (err) {
				setDetect({
					site: s,
					text: `Checking the site URL failed: ${err instanceof Error ? err.message : String(err)}. Pick Cloud or Data Center below.`,
					invalid: false,
				});
				return false;
			}
		});
	};
	const save = (): void => {
		const n = name.trim();
		saveBusy.start(() =>
			run(async () => {
				const { status, data } = await gitReq("POST", "/api/jira/connections", {
					name: n,
					site: site.trim(),
					type,
					email: type === "cloud" ? email.trim() : undefined,
					token: token === "" ? undefined : token,
					customFields: fields
						.split(",")
						.map((f) => f.trim())
						.filter((f) => f !== ""),
				});
				if (status !== 200)
					throw new Error(asError(data, status, `saving the connection ${n}`));
				reset();
				setNote(`Saved ${n}`);
				await load();
				return true;
			}),
		);
	};
	const test = (n: string): Promise<boolean> =>
		run(async () => {
			const { status, data } = await gitReq(
				"POST",
				`/api/jira/connections/${encodeURIComponent(n)}/test`,
			);
			if (status !== 200)
				throw new Error(asError(data, status, `testing the connection ${n}`));
			setNote(`${n}: signed in as ${String(data.displayName)}`);
			return true;
		});
	const remove = (n: string): Promise<boolean> =>
		run(async () => {
			if (
				!(await confirmDialog(`Delete the Jira connection ${n}?`, {
					ok: "Delete connection",
					danger: true,
				}))
			)
				return true;
			const { status, data } = await gitReq(
				"DELETE",
				`/api/jira/connections/${encodeURIComponent(n)}`,
			);
			if (status === 409 && Array.isArray(data.projects))
				throw new Error(
					`${n} is in use by ${data.projects.join(", ")}. Pick another Jira connection in the settings of these projects first.`,
				);
			if (status !== 200)
				throw new Error(asError(data, status, `deleting the connection ${n}`));
			if (editing === n) reset();
			setNote(`Deleted ${n}`);
			await load();
			return true;
		});
	const detectId = `${ids}-detect`;
	const tokenNoteId = `${ids}-token`;
	return (
		<SettingsCard
			id="jira-section"
			title="Jira connections"
			status={
				list === null
					? undefined
					: list.length === 0
						? { label: "None", tone: "off" }
						: list.some((c) => !c.tokenReadable)
							? { label: "Token unreadable", tone: "warn" }
							: {
									label: `${list.length} connection${list.length === 1 ? "" : "s"}`,
									tone: "ok",
								}
			}
			hint="Named Jira sites that projects import tickets from. Ottr reads from Jira only. It stores each token encrypted and never shows it again."
		>
			{list !== null && list.length > 0 && (
				<div className="sec-block">
					<h4>Connections</h4>
					<ul className="jira-conns">
						{list.map((c) => (
							<li key={c.name} className="jira-conn">
								<div className="jira-conn-text">
									<b>{c.name}</b>
									<span>
										<code>{c.site}</code> · {JIRA_TYPE_LABEL[c.type]}
										{c.email !== null && ` · ${c.email}`}
									</span>
									<span className="hint">
										{!c.tokenReadable ? (
											<span className="jira-conn-warn">
												<Mark kind="warn" />
												Token unreadable, enter it again
											</span>
										) : c.tokenSet ? (
											"Token set"
										) : (
											"No token"
										)}
										{" · "}
										{c.usedBy.length === 0
											? "Used by no project"
											: `Used by ${c.usedBy.join(", ")}`}
									</span>
								</div>
								<div className="jira-conn-actions">
									<button
										type="button"
										aria-label={`Edit ${c.name}`}
										onClick={() => edit(c)}
									>
										Edit
									</button>
									<BusyButton
										ariaLabel={`Test ${c.name}`}
										run={() => test(c.name)}
									>
										Test
									</BusyButton>
									<BusyButton
										className="danger"
										ariaLabel={`Delete ${c.name}`}
										run={() => remove(c.name)}
									>
										Delete
									</BusyButton>
								</div>
							</li>
						))}
					</ul>
				</div>
			)}
			<div className="sec-block">
				<h4>{editing === null ? "Add connection" : `Edit ${editing}`}</h4>
				<form
					className="settings-form"
					aria-label={
						editing === null
							? "Add a Jira connection"
							: `Edit the Jira connection ${editing}`
					}
					onSubmit={(e) => {
						e.preventDefault();
						save();
					}}
				>
					<div className="alate-def-rows">
						<DefRow
							name="Name"
							help="The name that projects pick in their settings, for example work. It cannot change after the save."
							shape="unique name"
						>
							<label>
								<input
									value={name}
									onChange={(e) => setName(e.target.value)}
									readOnly={editing !== null}
									required
									spellCheck={false}
									autoComplete="off"
									aria-label="Name"
								/>
							</label>
						</DefRow>
						<DefRow
							name="Site URL"
							help="The Jira address, with a context path when Jira has one. Ottr asks the site for its type when you leave the field."
							shape="https URL"
							action={
								<button
									type="button"
									disabled={detectBusy.busy || site.trim() === ""}
									aria-busy={detectBusy.busy || undefined}
									onClick={runDetect}
								>
									{detectBusy.busy && (
										<span className="spinner" aria-hidden="true" />
									)}
									Detect type
								</button>
							}
						>
							<div className="alate-field-stack jira-site-stack">
								<label>
									<input
										value={site}
										onChange={(e) => setSite(e.target.value)}
										onBlur={() => {
											if (site.trim() !== "" && detect?.site !== site.trim())
												runDetect();
										}}
										placeholder="https://acme.atlassian.net"
										inputMode="url"
										spellCheck={false}
										autoComplete="off"
										required
										aria-label="Site URL"
										aria-invalid={detect?.invalid === true || undefined}
										aria-describedby={detect === null ? undefined : detectId}
									/>
								</label>
								{detect !== null && (
									<p
										id={detectId}
										className={detect.invalid ? "auth-error" : "hint"}
										role={detect.invalid ? "alert" : "status"}
									>
										{detect.text}
									</p>
								)}
							</div>
						</DefRow>
						<DefRow
							name="Type"
							help="Cloud signs in with an email and an API token. Data Center signs in with a personal access token."
						>
							<label>
								<select
									value={type}
									onChange={(e) => setType(e.target.value as JiraType)}
									aria-label="Type"
								>
									<option value="cloud">Cloud</option>
									<option value="datacenter">Data Center</option>
								</select>
							</label>
						</DefRow>
						{type === "cloud" && (
							<DefRow
								name="Email"
								help="The email of the Atlassian account that owns the API token."
								shape="email"
							>
								<label>
									<input
										type="email"
										value={email}
										onChange={(e) => setEmail(e.target.value)}
										autoComplete="off"
										spellCheck={false}
										required
										aria-label="Email"
									/>
								</label>
							</DefRow>
						)}
						<DefRow
							name="Token"
							help={
								type === "cloud"
									? "An Atlassian API token. Ottr stores it encrypted and never shows it again."
									: "A personal access token. Ottr stores it encrypted and never shows it again."
							}
							shape="secret · stored, never shown"
						>
							<div className="alate-field-stack">
								<label>
									<input
										type="password"
										value={token}
										onChange={(e) => setToken(e.target.value)}
										autoComplete="off"
										spellCheck={false}
										required={editing === null}
										aria-label="Token"
										aria-describedby={
											editingView === null ? undefined : tokenNoteId
										}
									/>
								</label>
								{editingView !== null && (
									<p id={tokenNoteId} className="hint">
										{editingView.tokenReadable
											? editingView.tokenSet
												? "Token is set. Leave empty to keep it."
												: "No token is set. Enter one."
											: "Token unreadable, enter it again."}
									</p>
								)}
							</div>
						</DefRow>
						<DefRow
							name="Custom field IDs"
							help="Jira fields to copy into each card prompt, comma-separated, for example customfield_10042."
							shape="empty = none"
						>
							<label>
								<input
									value={fields}
									onChange={(e) => setFields(e.target.value)}
									placeholder="customfield_10042, customfield_10043"
									spellCheck={false}
									autoComplete="off"
									aria-label="Custom field IDs"
								/>
							</label>
						</DefRow>
					</div>
					<div className="alate-def-actions">
						<button
							type="submit"
							disabled={saveBusy.busy}
							aria-busy={saveBusy.busy || undefined}
							className={saveBusy.failed ? "failed" : ""}
						>
							{saveBusy.busy && <span className="spinner" aria-hidden="true" />}
							Save connection
						</button>{" "}
						{editing !== null && (
							<button type="button" onClick={reset}>
								Cancel
							</button>
						)}
					</div>
				</form>
			</div>
			<p className="hint" role="status">
				{note}
			</p>
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
					`Remove ${project.name}'s SSH key? The project then uses the global key.`,
					{ ok: "Use global key", danger: true },
				))
			)
				return true;
			try {
				const { status, data } = await gitReq(
					"DELETE",
					`/api/projects/${encodeURIComponent(project.name)}/ssh-key`,
				);
				if (status !== 200)
					throw new Error(
						asError(data, status, `removing ${project.name}'s SSH key`),
					);
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
							inputMode="url"
							spellCheck={false}
							autoComplete="off"
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
type EnvNameRow = {
	name: string;
	projects: string[];
	set: boolean;
	/** false => the stored value cannot be decrypted; the user must enter it again. */
	readable: boolean;
};

/** Settings "Env" section: one secret value per env.txt name; values never come back after save. */
export function EnvSection() {
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
					: rows.some((r) => r.set && !r.readable)
						? { label: "Value unreadable", tone: "warn" }
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
								{row.set && !row.readable && <UnreadableSecretNote />}
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

/** The section's status chip: who is signed in, or undefined while the state loads. */
const signinStatus = (
	state: SignInState | null,
	signedIn: number,
): { label: string; tone: ChipTone } | undefined =>
	state === null
		? undefined
		: signedIn > 0
			? { label: `${signedIn} signed in`, tone: "ok" }
			: { label: "None signed in", tone: "warn" };

/** The state words for one stored sign-in: expired ones lead, OAuth sign-ins read as
 *  signed in, anything else holds an API key. Grey is normal: only an expired sign-in
 *  carries a mark (the amber needs-you triangle) and the amber row box. */
const signinWords = (signIn: SignIn): string =>
	signIn.active
		? signIn.kind === "oauth"
			? "Signed in"
			: "API key stored"
		: "Sign-in expired";

/** The stored sign-ins, one row per provider: status words, quota meters, and the
 *  sign-in-again and sign-out actions. */
function SignInRows({
	signIns,
	quota,
	providerName,
	busy,
	waiting,
	onStart,
	onSignOut,
}: {
	signIns: SignIn[];
	quota: QuotaState | null;
	providerName: (id: string) => string;
	busy: boolean;
	waiting: boolean;
	onStart: (id: string) => void;
	onSignOut: (id: string) => void;
}) {
	return (
		<div className="alate-def-rows">
			{signIns.map((signIn) => {
				const id = signIn.provider;
				const limits = forProvider(quota?.limits ?? [], id);
				const plan = limits.find((l) => l.plan !== null)?.plan ?? null;
				const needs = !signIn.active;
				const words = signinWords(signIn);
				return (
					<div
						className={`alate-def-row providers-row${needs ? " expired" : ""}`}
						key={id}
					>
						<div className="alate-def-name">
							<b className="provider-name">
								{needs && <Mark kind="needs" />}
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
									onClick={() => onStart(id)}
									disabled={busy || waiting}
									aria-label={`Sign in again to ${providerName(id)}`}
								>
									Sign in again
								</button>
							)}
							<button
								type="button"
								className="danger"
								onClick={() => onSignOut(id)}
								disabled={busy}
								aria-label={
									needs
										? `Remove sign-in for ${providerName(id)}`
										: `Sign out of ${providerName(id)}`
								}
							>
								{needs ? "Remove" : "Sign out"}
							</button>
						</div>
					</div>
				);
			})}
		</div>
	);
}

/** The form shown while an omp sign-in waits for the provider's verdict: the open page
 *  link, the code-or-address field, and the cancel and send actions. */
function SignInFinishForm({
	pending,
	providerName,
	page,
	answer,
	setAnswer,
	busy,
	failed,
	onCancel,
	onFinish,
}: {
	pending: LoginView;
	providerName: (id: string) => string;
	page: string | null;
	answer: string;
	setAnswer: (v: string) => void;
	busy: boolean;
	failed: boolean;
	onCancel: () => void;
	onFinish: () => void;
}) {
	return (
		<form
			className="settings-form"
			onSubmit={(e) => {
				e.preventDefault();
				onFinish();
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
					<button type="button" onClick={onCancel} disabled={busy}>
						Cancel
					</button>
					<button
						type="submit"
						disabled={busy}
						className={failed ? "failed" : undefined}
					>
						{busy && <span className="spinner" aria-hidden="true" />}
						Send code
					</button>
				</div>
			</div>
			<pre className="log">{pending.output}</pre>
		</form>
	);
}

/** The start form: pick or type an omp provider id and sign in. */
function SignInStartForm({
	provider,
	setProvider,
	providers,
	busy,
	failed,
	onStart,
}: {
	provider: string;
	setProvider: (v: string) => void;
	providers: LoginProvider[];
	busy: boolean;
	failed: boolean;
	onStart: (id: string) => void;
}) {
	return (
		<form
			className="settings-form providers-form"
			onSubmit={(e) => {
				e.preventDefault();
				onStart(provider.trim());
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
					disabled={busy}
					className={failed ? "failed" : undefined}
				>
					{busy && <span className="spinner" aria-hidden="true" />}
					Sign in
				</button>
			</div>
		</form>
	);
}

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
		const expired = state?.signIns?.some(
			(signIn) => signIn.provider === id && !signIn.active,
		);
		if (
			!(await confirmDialog(
				expired
					? `Remove the expired sign-in for ${providerName(id)}? This also removes this provider's sign-in from the worker store.`
					: `Sign omp out of ${providerName(id)}? Turns that use it fail until you sign in again.`,
				{ ok: expired ? "Remove" : "Sign out", danger: true },
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
			status={signinStatus(state, signedIn)}
			hint="The board stores one sign-in per provider. Anthropic, ChatGPT (Codex), and Z.AI OAuth sign-ins share access tokens with worker turns automatically. Workers receive no refresh token. Other providers use worker credentials or a key under Settings, Env. From another device, complete the provider's page there. Paste its final address or code below."
		>
			{signIns.length > 0 && (
				<SignInRows
					signIns={signIns}
					quota={quota}
					providerName={providerName}
					busy={act.busy}
					waiting={waiting}
					onStart={start}
					onSignOut={signOutOf}
				/>
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
				<SignInFinishForm
					pending={pending}
					providerName={providerName}
					page={page}
					answer={answer}
					setAnswer={setAnswer}
					busy={act.busy}
					failed={act.failed}
					onCancel={cancel}
					onFinish={finish}
				/>
			) : (
				<SignInStartForm
					provider={provider}
					setProvider={setProvider}
					providers={providers}
					busy={act.busy}
					failed={act.failed}
					onStart={start}
				/>
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
export type ProvisionResult = {
	script: string;
	code: number;
	output: string;
	truncated: boolean;
};

/** A "<n> <verb>" count token a script prints in its summary line: "40 unchanged,
 *  0 deleted in /root/.omp/agent/rules". */
const PROVISION_COUNT_TOKEN =
	/(\d+) (added|updated|unchanged|installed|deleted|removed)\b/g;
/** A count line whose every count is zero apart from "unchanged": the run touched
 *  nothing there, so the short view drops it. Any other count line names a change and stays. */
function isQuietCountLine(line: string): boolean {
	const tokens = [...line.matchAll(PROVISION_COUNT_TOKEN)];
	if (tokens.length === 0) return false;
	return tokens.every(([, n, verb]) => verb === "unchanged" || n === "0");
}
/** Progress chatter a provision script prints while it works. Matched against the whole
 *  line, so a warning that merely contains the words still shows. */
const PROVISION_PROGRESS: RegExp[] = [
	/^Scanning \d+ of \d+ skill snapshots?\b/, // install-user.mjs SkillSpector banner
	/^bun install v\d/, // bun's installer banner
	/^Resolving dependencies$/,
	/^Checked \d+ installs across \d+ packages\b/, // bun's up-to-date summary
	/^plugins skipped$/,
];

/** The short view of a script's output: its change, warning and error lines. The filter
 *  may only drop a line it positively recognizes as noise — a quiet count line or a
 *  progress line. A line it does not understand always stays visible. */
export function shortProvisionLines(output: string): string[] {
	const short: string[] = [];
	for (const raw of output.split("\n")) {
		const line = raw.trim();
		if (line === "") continue;
		if (isQuietCountLine(line)) continue;
		if (PROVISION_PROGRESS.some((p) => p.test(line))) continue;
		short.push(line);
	}
	return short;
}
/** A per-file change line: "updated  coding-guideline.md", "added    user/x.md". */
const PROVISION_CHANGE_LINE = /^(added|updated|deleted|installed)\s+\S/;
/** bun's own added-package marker: "+ typescript@5.6.3". */
const PROVISION_BUN_ADD = /^\+ \S/;

/** One short line's totals contribution: count tokens, per-file change lines, and
 *  bun's added-package lines. */
const countProvisionLine = (
	line: string,
	bunCounted: boolean,
	bump: (verb: string, n: number) => void,
): void => {
	for (const [, n, verb] of line.matchAll(PROVISION_COUNT_TOKEN))
		if (verb !== undefined) bump(verb, Number(n));
	const change = PROVISION_CHANGE_LINE.exec(line);
	if (change !== null) bump(change[1] ?? "", 1);
	else if (PROVISION_BUN_ADD.test(line) && !bunCounted) bump("installed", 1);
	else countBunSummary(line, bump);
};

/** bun's own summary line: "2 packages installed [104.00ms]" — the verb sits behind
 *  "packages", so the count token above cannot see it; the count lands on "installed". */
const countBunSummary = (
	line: string,
	bump: (verb: string, n: number) => void,
): void => {
	const bunSummary = /^(\d+) packages? installed\b/.exec(line);
	if (bunSummary !== null) bump("installed", Number(bunSummary[1]));
};

/** A short total of what a provision changed, for example "1 updated, 2 installed";
 *  null when nothing changed. Counts the successful scripts' change lines and the
 *  non-quiet count lines, so it matches what the short view shows. */
export function provisionChangeSummary(
	results: ProvisionResult[],
): string | null {
	const totals = new Map<string, number>();
	const bump = (verb: string, n: number): void => {
		if (verb === "unchanged") return;
		totals.set(verb, (totals.get(verb) ?? 0) + n);
	};
	for (const r of results) {
		if (r.code !== 0) continue;
		const short = shortProvisionLines(r.output);
		// bun names the same installs twice: once per "+ package" line and once in its
		// "N packages installed" summary. Count the summary, and the per-package lines
		// only when the run printed no summary.
		const bunCounted = short.some((line) =>
			/^\d+ packages? installed\b/.test(line),
		);
		for (const line of short) {
			countProvisionLine(line, bunCounted, bump);
		}
	}
	const parts = ["added", "updated", "installed", "deleted", "removed"]
		.map((verb) => ({ verb, n: totals.get(verb) ?? 0 }))
		.filter((t) => t.n > 0)
		.map((t) => `${t.n} ${t.verb}`);
	return parts.length === 0 ? null : parts.join(", ");
}

/** One provision script's result: a failure shows its raw output open; a success shows
 *  only the changed lines, or "<script>: no changes", with the raw log behind a
 *  disclosure both keyboard and screen-reader users operate natively. */
function ProvisionScriptLog({ r }: { r: ProvisionResult }) {
	if (r.code !== 0) {
		return (
			<div>
				<p className="auth-error">
					{r.script} — exit {r.code}
				</p>
				<pre className="log">{r.output}</pre>
			</div>
		);
	}
	const short = shortProvisionLines(r.output);
	return (
		<div>
			{short.length === 0 ? (
				<p className="hint">{r.script}: no changes</p>
			) : (
				<>
					<p className="hint">
						{r.script} — exit {r.code}
					</p>
					<pre className="log">{short.join("\n")}</pre>
				</>
			)}
			<details className="prov-log">
				<summary>Show full log</summary>
				<pre className="log">{r.output}</pre>
			</details>
		</div>
	);
}

/** The provision result list: one shared renderer for the Alate section and the
 *  model-roles save flow, so both blocks read the same. */
export function ProvisionResults({ results }: { results: ProvisionResult[] }) {
	return (
		<>
			{results.map((r) => (
				<ProvisionScriptLog key={r.script} r={r} />
			))}
		</>
	);
}

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

/** The section's status chip: unavailable, the role count, or undefined while loading. */
const rolesStatus = (
	loadErr: string | null,
	state: RolesState | null,
): { label: string; tone: ChipTone } | undefined =>
	loadErr !== null
		? { label: "Unavailable", tone: "warn" }
		: state === null
			? undefined
			: {
					label: `${Object.keys(state.roles).length} roles`,
					tone: "ok",
				};

/** The card hint: where a save lands, with or without a GitHub remote for the data
    repo; a refused folder save replaces the flow with the fact. */
function ModelRolesHint({ state }: { state: RolesState | null }) {
	return (
		<>
			omp runs each role with its model, then with its fallbacks in order.{" "}
			{state?.ro ? (
				<>Alate serves the data folder, so the board cannot save roles here.</>
			) : state?.base === null ? (
				<>
					Save writes <code>user/omp/agent/config.yml</code> through Alate's
					file editor: Alate commits the folder itself when it is a git repo (no
					GitHub token), then Alate provisions the workers.
				</>
			) : (
				<>
					Save commits <code>user/omp/agent/config.yml</code> to Alate's data
					repo with the board's GitHub token, then Alate provisions the workers.
				</>
			)}
		</>
	);
}

/** One model-role row: the model and thinking pickers, the remove button, the notes,
 *  and the fallback chain editor. */
function RoleRow({
	name,
	value,
	index,
	uid,
	field,
	warnings,
	models,
	first,
	chain,
	fallbackError,
	locked,
	onSetValue,
	onRemove,
	onEditChain,
}: {
	name: string;
	value: string;
	index: number;
	uid: string;
	field: string | undefined;
	warnings: string[];
	models: ModelOption[];
	first: string | undefined;
	chain: string[] | undefined;
	fallbackError: string | undefined;
	locked: boolean;
	onSetValue: (name: string, value: string) => void;
	onRemove: (name: string) => void;
	onEditChain: (name: string, fn: (chain: string[]) => string[]) => void;
}) {
	const [base, level] = splitLevel(value);
	const notesId =
		field !== undefined || warnings.length > 0 ? `${uid}-${index}` : undefined;
	return (
		<div className="alate-def-row role-row">
			<b className="role-name">{name}</b>
			<RoleModelPicker
				label={`Model for ${name}`}
				base={base}
				level={level}
				models={models}
				setValue={(v) => onSetValue(name, v)}
				disabled={locked}
				invalid={field !== undefined}
				describedBy={notesId}
			/>
			<ThinkingSelect
				label={`Thinking for ${name}`}
				base={base}
				level={level}
				setValue={(v) => onSetValue(name, v)}
				disabled={locked}
				invalid={field !== undefined}
				describedBy={notesId}
			/>
			<button
				type="button"
				className="icon role-remove"
				aria-label={`Remove role ${name}`}
				title="Remove role"
				onClick={() => onRemove(name)}
				disabled={locked}
			>
				<Icon name="x" />
			</button>
			{notesId !== undefined && (
				<div className="role-notes" id={notesId}>
					{field !== undefined && <p className="auth-error">{field}</p>}
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
				chain={chain}
				models={models}
				first={first}
				edit={(fn) => onEditChain(name, fn)}
				disabled={locked}
				error={fallbackError}
				errorId={`${uid}-${index}-fallbacks`}
			/>
		</div>
	);
}

/** The role rows: one RoleRow per entry, keyed by role name. */
function RoleRows({
	rows,
	uid,
	models,
	first,
	chains,
	fields,
	fallbackFields,
	locked,
	signIns,
	onSetValue,
	onRemove,
	onEditChain,
}: {
	rows: Array<[string, string]>;
	uid: string;
	models: ModelOption[];
	first: string | undefined;
	chains: Record<string, string[]>;
	fields: Record<string, string>;
	fallbackFields: Record<string, string>;
	locked: boolean;
	signIns: string[] | null;
	onSetValue: (name: string, value: string) => void;
	onRemove: (name: string) => void;
	onEditChain: (name: string, fn: (chain: string[]) => string[]) => void;
}) {
	return (
		<div className="alate-def-rows">
			{rows.map(([name, value], i) => (
				<RoleRow
					key={name}
					name={name}
					value={value}
					index={i}
					uid={uid}
					field={ownField(fields, name)}
					warnings={roleWarnings(value, signIns)}
					models={models}
					first={first}
					chain={ownField(chains, name)}
					fallbackError={ownField(fallbackFields, name)}
					locked={locked}
					onSetValue={onSetValue}
					onRemove={onRemove}
					onEditChain={onEditChain}
				/>
			))}
		</div>
	);
}

/** The read-only note: why a save cannot commit, with the fix for each cause. */
function RoleReadonlyNote({
	ro,
	uid,
}: {
	ro: { path: string; cause: "plain" | "mount" };
	uid: string;
}) {
	return (
		<>
			<p className="auth-error" role="alert">
				read-only: folder source {ro.path}
			</p>
			<p className="hint" id={`${uid}-ro-hint`}>
				{ro.cause === "mount" ? (
					<>
						The data folder is mounted read-only into Alate. Make the mount
						writable, or edit <code>user/omp/agent/config.yml</code> in the
						folder, then run "Import now" and "Provision now" in Alate, and
						reload the settings.
					</>
				) : (
					<>
						Alate's data folder is not a git repo, so a save cannot commit. Make
						the folder a git repo or point Alate at a GitHub repo, or edit{" "}
						<code>user/omp/agent/config.yml</code> in the folder, then run
						"Import now" and "Provision now" in Alate, and reload the settings.
					</>
				)}
			</p>
		</>
	);
}

/** The provision line of the save steps: running with its elapsed timer, the handed-off
 *  "still" note, the success note, or the failure with its error or failed-script count. */
function ProvisionLine({
	prov,
	provSince,
	failed,
}: {
	prov: ProvisionStep | null;
	provSince: number | null;
	failed: ProvisionResult[];
}) {
	if (prov === null || prov.state === "running")
		return (
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
		);
	if (prov.state === "still")
		return (
			<>
				<Mark kind="queued" />
				The provision still runs on the Alate server. The Alate dashboard shows
				its result.
			</>
		);
	if (prov.ok && failed.length === 0)
		return (
			<>
				<Mark kind="done" />
				Provisioned the workers.
			</>
		);
	return (
		<>
			<Mark kind="crit" />
			The provision failed
			{prov.error !== null
				? `: ${prov.error}`
				: failed.length > 0
					? `: ${failed.length} of ${prov.results.length} scripts failed`
					: ""}
			. The commit stays in the data repo. Use Provision in the Alate section to
			try again.
		</>
	);
}

/** The seed line of the save steps: what the board copy holds after the hourly deploy. */
function SeedStepLine({
	step,
	commit,
	seed,
}: {
	step: "copy" | "done" | "wait" | "replaced" | null;
	commit: string;
	seed: RolesState["seed"] | null;
}) {
	if (step === null || step === "copy")
		return (
			<>
				<Mark kind="done" />
				The board reads the provisioned copy.
			</>
		);
	if (step === "done")
		return (
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
		);
	if (step === "replaced")
		return (
			<>
				<Mark kind="done" />
				The board copy has other roles: a later change replaced this save.
			</>
		);
	return (
		<>
			<Mark kind="queued" />
			Waiting for the hourly deploy to seed <code>{shortSha(commit)}</code>.
		</>
	);
}

/** The section's Save button: accent fill unless read-only, disabled while clean or
    busy; the read-only note's hint doubles as its screen-reader description. */
function ModelRolesSaveButton({
	ro,
	roHintId,
	save,
	dirty,
	locked,
	onClick,
}: {
	ro: { path: string; cause: "plain" | "mount" } | null;
	roHintId: string | null;
	save: BusyState;
	dirty: boolean;
	locked: boolean;
	onClick: () => void;
}) {
	return (
		<div className="alate-def-actions">
			<button
				type="button"
				// Stock grey like every settings Save: a settings page stacks cards, and the
				// steel fill marks one action per screen (DESIGN.md, One primary per surface).
				className={save.failed ? "failed" : undefined}
				onClick={onClick}
				disabled={!dirty || locked}
				// The note above the button explains the lock; the description
				// repeats it for a screen reader that lands on the button.
				aria-describedby={ro !== null ? (roHintId ?? undefined) : undefined}
			>
				{save.busy && <span className="spinner" aria-hidden="true" />}
				Save
			</button>
		</div>
	);
}

/** The model roles body while its data is available: the rows, the missing-role note,
 *  the read-only note, the add form, and the save button. */
function ModelRolesContent({
	loadErr,
	state,
	catalog,
	uid,
	rows,
	chains,
	models,
	first,
	missing,
	ro,
	fields,
	fallbackFields,
	addErr,
	newName,
	setNewName,
	setAddErr,
	locked,
	dirty,
	save,
	onSetValue,
	onRemoveRole,
	onEditChain,
	onAdd,
	onSubmit,
}: {
	loadErr: string | null;
	state: RolesState | null;
	catalog: ModelCatalog | null;
	uid: string;
	rows: Array<[string, string]>;
	chains: Record<string, string[]>;
	models: ModelOption[];
	first: string | undefined;
	missing: string[];
	ro: { path: string; cause: "plain" | "mount" } | null;
	fields: Record<string, string>;
	fallbackFields: Record<string, string>;
	addErr: string | null;
	newName: string;
	setNewName: (v: string) => void;
	setAddErr: (v: string | null) => void;
	locked: boolean;
	dirty: boolean;
	save: BusyState;
	onSetValue: (name: string, value: string) => void;
	onRemoveRole: (name: string) => void;
	onEditChain: (name: string, fn: (chain: string[]) => string[]) => void;
	/** Adds the typed name, or `name` (a missing check role's button). */
	onAdd: (name?: string) => void;
	onSubmit: () => void;
}) {
	return (
		<>
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
					<RoleRows
						rows={rows}
						uid={uid}
						models={models}
						first={first}
						chains={chains}
						fields={fields}
						fallbackFields={fallbackFields}
						locked={locked}
						signIns={state.signIns}
						onSetValue={onSetValue}
						onRemove={onRemoveRole}
						onEditChain={onEditChain}
					/>
					{missing.length > 0 && (
						<div className="role-warn" role="note">
							<Mark kind="needs" />
							<b>
								No {missing.join(" or ")} role
								{missing.length > 1 ? "s" : ""}
							</b>
							<p>
								Second-model checks fall back to the default model, which is
								often the model they check. critic checks Anthropic models,
								adversary the rest.
							</p>
							<div className="role-warn-actions">
								{missing.map((m) => (
									<button
										key={m}
										type="button"
										disabled={locked || first === undefined}
										onClick={() => onAdd(m)}
									>
										Add {m}
									</button>
								))}
							</div>
						</div>
					)}
					{ro !== null && <RoleReadonlyNote ro={ro} uid={uid} />}
					<form
						className="role-add"
						onSubmit={(e) => {
							e.preventDefault();
							onAdd();
						}}
					>
						<label className="sr" htmlFor={`${uid}-new`}>
							New role name
						</label>
						<input
							id={`${uid}-new`}
							type="text"
							placeholder="New role"
							value={newName}
							onChange={(e) => {
								setNewName(e.target.value);
								setAddErr(null);
							}}
							spellCheck={false}
							autoComplete="off"
							aria-invalid={addErr !== null}
							aria-describedby={addErr !== null ? `${uid}-add` : undefined}
							disabled={locked}
						/>
						<button type="submit" className="role-add-btn" disabled={locked}>
							<Icon name="plus" size={14} />
							Add role
						</button>
					</form>
					{addErr !== null && (
						<p className="auth-error" id={`${uid}-add`} role="alert">
							{addErr}
						</p>
					)}
					<ModelRolesSaveButton
						ro={ro}
						roHintId={`${uid}-ro-hint`}
						save={save}
						dirty={dirty}
						locked={locked}
						onClick={onSubmit}
					/>
				</>
			)}
		</>
	);
}

/** The save steps once a save committed: the commit line, the provision line, and the
 *  seed line; then the failed scripts' logs. */
function ModelRolesTail({
	commit,
	prov,
	provSince,
	failed,
	step,
	seed,
}: {
	commit: string | null;
	prov: ProvisionStep | null;
	provSince: number | null;
	failed: ProvisionResult[];
	step: "copy" | "done" | "wait" | "replaced" | null;
	seed: RolesState["seed"] | null;
}) {
	return (
		<>
			<div aria-live="polite">
				{commit !== null && (
					<ol className="hint role-steps">
						<li>
							<Mark kind="done" />
							Committed <code>{shortSha(commit)}</code> to the data repo.
						</li>
						<li>
							<ProvisionLine
								prov={prov}
								provSince={provSince}
								failed={failed}
							/>
						</li>
						<li>
							<SeedStepLine step={step} commit={commit} seed={seed} />
						</li>
					</ol>
				)}
			</div>
			{prov?.state === "done" && prov.results.length > 0 && (
				<ProvisionResults results={prov.results} />
			)}
		</>
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
	const [ro, setRo] = useState<RolesState["ro"]>(null);
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
				// A folder the board saw refuse a save locks the section before
				// any edit; `?? null` keeps stale payloads from arming `ro`.
				setRo(s.ro ?? null);
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
	// Every editor disables while a save runs or the source is read-only.
	const locked = save.busy || ro !== null;
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
	const add = (picked?: string): void => {
		const name = (picked ?? newName).trim();
		const err = addRoleError(name, rows, first);
		setAddErr(err);
		if (err === null && first !== undefined) {
			setRows((rs) => [...rs, [name, first]]);
			// A new role starts with the chain the file holds for its key.
			const loaded =
				state !== null ? ownField(state.fallbacks, name) : undefined;
			if (loaded !== undefined)
				setChains((c) => ({ ...c, [name]: [...loaded] }));
			if (picked === undefined) setNewName("");
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
	const runSave = async (): Promise<boolean> => {
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
	};
	const submit = (): void => save.start(runSave);
	const failed =
		prov?.state === "done" ? prov.results.filter((r) => r.code !== 0) : [];
	return (
		<SettingsCard
			id="model-roles-section"
			className="model-roles"
			title="Model roles"
			status={rolesStatus(loadErr, state)}
			hint={<ModelRolesHint state={state} />}
		>
			<ModelRolesContent
				loadErr={loadErr}
				state={state}
				catalog={catalog}
				uid={uid}
				rows={rows}
				chains={chains}
				models={models}
				first={first}
				missing={missing}
				ro={ro}
				fields={fields}
				fallbackFields={fallbackFields}
				addErr={addErr}
				newName={newName}
				setNewName={setNewName}
				setAddErr={setAddErr}
				locked={locked}
				dirty={dirty}
				save={save}
				onSetValue={setValue}
				onRemoveRole={removeRole}
				onEditChain={editChain}
				onAdd={add}
				onSubmit={submit}
			/>
			{error !== null && (
				<p className="auth-error" role="alert">
					{error}
				</p>
			)}
			<ModelRolesTail
				commit={commit}
				prov={prov}
				provSince={provSince}
				failed={failed}
				step={step}
				seed={seed}
			/>
		</SettingsCard>
	);
}

/** The board's Hindsight server, the active memory backend and why memory is off; the key itself is write-only. */
type HindsightView = {
	url: string | null;
	tokenSet: boolean;
	/** false => the stored key cannot be decrypted; the user must enter it again. */
	tokenReadable: boolean;
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

/** One line for the provisioned user layer: counts, then the MCP server names. */
export function userLayerLine(
	layer: ProvisioningResponse["userLayer"],
): string {
	const count = (n: number, word: string): string =>
		`${n} ${word}${n === 1 ? "" : "s"}`;
	const mcp = layer.mcp.length === 0 ? "none" : layer.mcp.join(", ");
	return `User layer: ${count(layer.skills.length, "skill")}, ${count(layer.plugins.length, "plugin")}, MCP servers: ${mcp}`;
}

/** True when the layer carries neither skill nor plugin: the workers got none of the user layer. */
export function userLayerEmpty(
	layer: ProvisioningResponse["userLayer"],
): boolean {
	return layer.skills.length === 0 && layer.plugins.length === 0;
}

/** The prompt-required skills and rules the workers lack, as one line: names in the shipped
 *  order. Null when the workers hold everything, so the caller renders nothing. */
export function missingRequiredLine(
	layer: ProvisioningResponse["userLayer"],
): string | null {
	const names = missingRequired(layer).map((entry) => entry.name);
	return names.length === 0 ? null : `Missing on workers: ${names.join(", ")}`;
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

/** The status line a finished provision reports: the script count and the change totals. */
const provisionStatus = (
	rows: ProvisionResult[],
	changed: string | null,
): string => {
	const failed = rows.filter((r) => r.code !== 0);
	return failed.length === 0
		? `Provisioned ${rows.length} script${rows.length === 1 ? "" : "s"} successfully.${changed === null ? "" : ` ${changed}.`}`
		: `Provisioning failed: ${failed.length} of ${rows.length} script${rows.length === 1 ? "" : "s"} exited non-zero.`;
};

/** The stored-key row: reveal or copy the board's alate API key, or rotate it on the server. */
function StoredKeyRow({
	storedKey,
	reveal,
	copied,
	keyError,
	keyBusy,
	onReveal,
	onCopy,
	onRegenerate,
}: {
	storedKey: string | null;
	reveal: boolean;
	copied: boolean;
	keyError: string | null;
	keyBusy: BusyState;
	onReveal: () => void;
	onCopy: () => void;
	onRegenerate: () => void;
}) {
	return (
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
						aria-label={reveal ? "Hide Alate API key" : "Reveal Alate API key"}
						title={reveal ? "Hide Alate API key" : "Reveal Alate API key"}
						onClick={onReveal}
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
					onClick={onCopy}
				>
					<Icon name={copied ? "check" : "copy"} />
				</button>
				<button
					type="button"
					className="icon danger"
					aria-label="Regenerate Alate API key"
					title="Regenerate Alate API key"
					onClick={onRegenerate}
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
	);
}

/** The form's action row: the connection Save and the Provision trigger. */
function AlateActions({
	saved,
	save,
	prov,
	awaiting,
	health,
	onProvision,
}: {
	saved: boolean;
	save: BusyState;
	prov: BusyState;
	awaiting: boolean;
	health: AlateHealthState | null;
	onProvision: () => void;
}) {
	return (
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
				onClick={onProvision}
				disabled={prov.busy || awaiting}
				// Stock grey like every settings action: a settings page stacks cards, and the steel
				// fill marks one action per screen (DESIGN.md, One primary per surface).
				className={
					health?.state === "ok" && health.pending ? "attention" : undefined
				}
			>
				{(prov.busy || awaiting) && (
					<span className="spinner" aria-hidden="true" />
				)}
				{awaiting ? "Provisioning…" : "Provision"}
			</button>
		</div>
	);
}

/** The user-layer note after a provision: why it is empty, the sync command that fills it,
 *  and the prompt-required skills or rules the workers still lack. */
function UserLayerNote({
	layer,
}: {
	layer: ProvisioningResponse["userLayer"] | null;
}) {
	if (layer === null) return null;
	const missing = missingRequiredLine(layer);
	if (userLayerEmpty(layer))
		return (
			<>
				{layer.mcp.length > 0 && <p className="hint">{userLayerLine(layer)}</p>}
				<div className="prov-callout" role="status">
					<Mark kind="needs" />
					<span className="prov-callout-text">
						<b>User layer is empty</b>
						<small>
							Workers get none of your skills or plugins. In a checkout of the
							alate repo run{" "}
							<code>node sync-user.mjs --data &lt;data-repo&gt;</code>, then
							provision again.
						</small>
					</span>
				</div>
				{missing !== null && (
					<p className="hint notif-line">
						<Mark kind="warn" />
						<span>{missing}</span>
					</p>
				)}
			</>
		);
	return (
		<>
			<p className="hint">{userLayerLine(layer)}</p>
			{missing !== null && (
				<p className="hint notif-line">
					<Mark kind="warn" />
					<span>{missing}</span>
				</p>
			)}
		</>
	);
}

/** Settings "Alate" section: provisioning config + one-shot provision trigger. */
export function AlateSection() {
	const [url, setUrl] = useState("");
	const [conn, setConn] = useState("");
	const [health, setHealth] = useState<AlateHealthState | null>(null);
	const [keySet, setKeySet] = useState(false);
	const [keyReadable, setKeyReadable] = useState(true);
	const [key, setKey] = useState("");
	const [lastErr, setLastErr] = useState<string | null>(null);
	const [saved, flashSaved] = useFlash(1500);
	const [error, setError] = useState<string | null>(null);
	const [status, setStatus] = useState<string | null>(null);
	const [results, setResults] = useState<ProvisionResult[]>([]);
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
	const rotateKeyRun = async (): Promise<boolean> => {
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
		keyBusy.start(rotateKeyRun);
	};
	const save = useBusy();
	const prov = useBusy();
	// Start time of the watch on a provision that alate reported running when the board's
	// HTTP wait ended at its transport bound; the health probe below, not the abandoned
	// wait, reports the outcome. `null` while no watch runs.
	const [watchSince, setWatchSince] = useState<number | null>(null);
	// False until GET /api/alate answers: the chip must not claim "Not configured" before it knows.
	const [loaded, setLoaded] = useState(false);
	const [layer, setLayer] = useState<ProvisioningResponse["userLayer"] | null>(
		null,
	);
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
	const loadLayer = useCallback(() => {
		// A failed read keeps the line hidden; the endpoint's health/state errors surface on the Setup tab and the section chip.
		fetch("/api/provisioning")
			.then((res) => unwrap<ProvisioningResponse>(res))
			.then((r) => setLayer(r.userLayer))
			.catch(() => {});
	}, []);
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
			loadLayer();
			return;
		}
		setStatus("Provisioning state unknown.");
		setError(
			step === "lost"
				? "The alate server stopped answering while it provisioned. Check the alate dashboard, then provision again."
				: `alate still reports a running provision after ${ALATE_WATCH_DEADLINE_MS / 60_000} minutes. Check the alate dashboard.`,
		);
	}, [loadLayer, watchSince, health]);
	useEffect(() => {
		let live = true;
		fetch("/api/alate")
			.then((res) =>
				unwrap<{
					url: string | null;
					keySet: boolean;
					keyReadable: boolean;
					lastProvisionError: string | null;
				}>(res),
			)
			.then((cfg) => {
				if (!live) return;
				setUrl(cfg.url ?? "");
				setConn(cfg.url ?? "");
				setKeySet(cfg.keySet);
				setKeyReadable(cfg.keyReadable);
				setLoaded(true);
				setLastErr(cfg.lastProvisionError);
				loadHealth(cfg.url ?? "", () => live);
				loadLayer();
			})
			.catch((err: unknown) => {
				if (live) setError(err instanceof Error ? err.message : String(err));
			});
		return () => {
			live = false;
		};
	}, [loadHealth, loadLayer]);
	const runSave = async (): Promise<boolean> => {
		setError(null);
		try {
			const body: Record<string, string> = {};
			if (url.trim() !== "") body.url = url.trim();
			const k = key.trim();
			if (k !== "") body.key = k;
			const cfg = await post<{
				url: string | null;
				keySet: boolean;
				keyReadable: boolean;
				lastProvisionError: string | null;
			}>("/api/alate", body);
			setUrl(cfg.url ?? "");
			setConn(cfg.url ?? "");
			setKeySet(cfg.keySet);
			setKeyReadable(cfg.keyReadable);
			setLastErr(cfg.lastProvisionError);
			loadHealth(cfg.url ?? "");
			setKey("");
			flashSaved();
			return true;
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			return false;
		}
	};
	const submit = (): void => save.start(runSave);
	const runProvision = async (): Promise<boolean> => {
		setError(null);
		setStatus(null);
		setResults([]);
		try {
			const res = await post<{
				ok: boolean;
				running?: boolean;
				results?: ProvisionResult[];
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
				loadLayer();
				return true;
			}
			const rows = res.results ?? [];
			setResults(rows);
			loadHealth(conn);
			loadLayer();
			if (res.ok) setLastErr(null);
			setStatus(provisionStatus(rows, provisionChangeSummary(rows)));
			return res.ok;
		} catch (err) {
			setStatus("Provisioning failed.");
			setError(err instanceof Error ? err.message : String(err));
			return false;
		}
	};
	const provision = (): void => prov.start(runProvision);
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
					{conn !== "" && keySet && !keyReadable && <UnreadableSecretNote />}
					{conn !== "" && keySet && keyReadable && (
						<StoredKeyRow
							storedKey={storedKey}
							reveal={reveal}
							copied={copied}
							keyError={keyError}
							keyBusy={keyBusy}
							onReveal={revealKey}
							onCopy={copyKey}
							onRegenerate={regenerateKey}
						/>
					)}
				</div>
				<AlateActions
					saved={saved}
					save={save}
					prov={prov}
					awaiting={awaiting}
					health={health}
					onProvision={provision}
				/>
			</form>
			{error !== null && (
				<p className="auth-error" role="alert">
					{error}
				</p>
			)}
			<p className="hint" aria-live="polite">
				{status}
			</p>
			<UserLayerNote layer={layer} />
			<ProvisionResults results={results} />
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
	reason,
}: {
	busy: boolean;
	saved: boolean;
	failed: boolean;
	/** The server's message from the last failed save; shown after "Not saved". */
	reason?: string | null;
}) {
	return (
		<span className="save-tick" role="status">
			{busy ? (
				<>
					<span className="spinner" aria-hidden="true" />
					<span className="sr">Saving</span>
				</>
			) : failed ? (
				<span className="save-tick-failed" role="alert">
					Not saved{reason ? `: ${reason}` : ""}
				</span>
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
	action,
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
	/** A button at the row's right end that acts without the checkbox (e.g. run it now). */
	action?: ReactNode;
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
					<SaveTick
						busy={s.busy}
						saved={s.saved}
						failed={s.failed}
						reason={s.reason}
					/>
				</b>
				<span id={`${id}-desc`}>{desc}</span>
			</div>
			{action !== undefined && (
				<div className="alate-def-actions">{action}</div>
			)}
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
	children: ReactNode | ((saveButton: ReactNode, s: InstantSave) => ReactNode);
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
				{inline ? children(button, s) : children}
			</form>
		</SettingsCard>
	);
}

/** A switch card's chip: how many of its checkboxes are on (saved values, not a draft).
 *  The caller passes a sub-switch as `parent && sub`, as it is disabled while its parent is off. */
export function onChip(flags: readonly boolean[]): {
	label: string;
	tone: ChipTone;
} {
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
			{ id: "projects-section", label: "Projects" },
			{ id: "notifications-section", label: "Notifications" },
		],
	},
	{
		id: "agents-group",
		label: "Agents",
		sections: [
			{ id: "signin-section", label: "Provider sign-in" },
			{ id: "model-roles-section", label: "Model roles" },
			{ id: "runners-section", label: "Runners" },
		],
	},
	{
		id: "workflow-group",
		label: "Workflow",
		sections: [
			{ id: "checks-section", label: "Checks" },
			{ id: "automation-section", label: "Automation" },
		],
	},
	{
		id: "environment-group",
		label: "Agent environment",
		sections: [
			{ id: "env-section", label: "Env" },
			{ id: "alate-section", label: "Alate" },
			{ id: "hindsight-section", label: "Hindsight" },
		],
	},
	{
		id: "git-group",
		label: "Git and integrations",
		sections: [
			{
				id: "git-hosts-section",
				label: "GitHub",
				blocks: [
					{ id: "github-host-block", label: "GitHub host" },
					{ id: "github-token-block", label: "GitHub token" },
					{ id: "github-app-block", label: "GitHub App" },
				],
			},
			{
				id: "git-other-section",
				label: "Other git hosts",
				blocks: [{ id: "host-tokens-block", label: "HTTPS tokens" }],
			},
			{
				id: "commit-identity-section",
				label: "Git identity",
				blocks: [
					{ id: "ssh-key-block", label: "SSH key" },
					{ id: "commit-identity-block", label: "Commit identity" },
				],
			},
			{ id: "jira-section", label: "Jira connections" },
		],
	},
	{
		id: "access-group",
		label: "Access and usage",
		sections: [
			{ id: "api-key-section", label: "API key" },
			{ id: "session-section", label: "Session" },
			{ id: "omp-stats-section", label: "omp usage" },
		],
	},
] as const;

/** One-project page: topic groups and their cards, in page order; the TOC and scroll-spy read it. */
const PROJECT_TOC = [
	{
		id: "project-group",
		label: "Project",
		sections: [
			{ id: "project-identity-section", label: "Identity" },
			{ id: "project-icon-section", label: "Icon" },
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
		id: "project-merging-group",
		label: "Merging",
		sections: [{ id: "project-merging-section", label: "Merging" }],
	},
	{
		id: "project-reviews-group",
		label: "Releases and reviews",
		sections: [
			{ id: "project-releases-section", label: "Releases" },
			{ id: "project-reviews-section", label: "Reviews" },
		],
	},
	{
		id: "project-cards-group",
		label: "New cards",
		sections: [
			{ id: "project-watches-section", label: "Watches" },
			{ id: "project-proposals-section", label: "Proposals" },
		],
	},
	{
		id: "project-integrations-group",
		label: "Integrations",
		sections: [
			{ id: "project-jira-section", label: "Jira" },
			{ id: "project-ssh-section", label: "SSH key" },
		],
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
	// The board-wide checks and automation switches sat on the runners card; the operator owns them.
	"checks-section",
	"automation-section",
	"projects-section",
	"api-key-section",
	"session-section",
	"omp-stats-section",
	// Hosted git uses per-project control-plane tokens only (section 6), so no host token,
	// GitHub setting or server SSH key on this card does anything there.
	"git-hosts-section",
	"git-other-section",
	"commit-identity-section",
	"signin-section",
	"model-roles-section",
	"alate-section",
	"hindsight-section",
	// The cards that split the old Updates card (watch, merge-hold and proposal switches).
	"project-merging-section",
	"project-watches-section",
	"project-proposals-section",
]);

/** Card ids a deep link may still name after a card moved or split: the new home. */
const MOVED_IDS: ReadonlyMap<string, string> = new Map([
	["project-updates-section", "project-merging-section"],
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

/** The settings map: the page as a lineage-style tree (groups, then their cards one indent in):
 *  hollow nodes on a 1px thread, an elbow into each level, and the current entry as the one
 *  steel node. One group (a project page) drops the group level. Sub-blocks are not on the
 *  map: a block's deep link still scrolls to it, and its card stands in as the current entry. */
function SettingsMap({
	groups,
	hash,
	active,
	onPick,
}: TocProps & { groups: readonly TocGroup[] }) {
	const named = groups.length > 1;
	const flat = groups.flatMap((g) =>
		g.sections.map((s) => ({ g, s, id: s.id, label: s.label, depth: 1 })),
	);
	const hi = Math.max(
		0,
		flat.findIndex(
			(x) => x.id === active || (x.s.blocks ?? []).some((b) => b.id === active),
		),
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
		g.sections.map((s) => node(s.id, s.label, 1, []));
	// A group with one card shows only the group row, which opens that card and carries its state.
	const tree: MapNode[] = named
		? groups.map((g) => {
				const only = g.sections.length === 1 ? g.sections[0] : undefined;
				return only === undefined
					? {
							id: g.sections[0]?.id ?? "",
							label: g.label,
							depth: 0,
							state: "group",
							kids: cards(g),
						}
					: { ...node(only.id, g.label, 0), kids: [] };
			})
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

/** The nearest ancestor whose overflowY scrolls: the scroller that hosts the TOC. */
const scrollerOf = (
	first: HTMLElement | null | undefined,
): HTMLElement | null => {
	let root = first ?? null;
	while (root !== null && !/auto|scroll/.test(getComputedStyle(root).overflowY))
		root = root.parentElement;
	return root;
};

/** The scroll position's active TOC id: the last section whose top crosses the watch
 *  line; the last id wins at the bottom of the scroller. */
const pickActiveToc = (
	ids: readonly string[],
	setActive: (id: string | null) => void,
): void => {
	const root = scrollerOf(document.getElementById(ids[0] ?? "")?.parentElement);
	const r = root ?? document.documentElement;
	const box = root?.getBoundingClientRect() ?? {
		top: 0,
		height: window.innerHeight,
	};
	if (r.scrollTop > 0 && r.scrollTop + r.clientHeight >= r.scrollHeight - 2) {
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

/** The machine-wide settings groups: Board, Agents, Workflow, Agent environment, Git and
 *  integrations, Access and usage. A group
 *  renders only while the TOC keeps it; hosted mode drops a group with no card left. */
function GeneralSettingsContent({
	map,
	general,
	host,
	projects,
	maxTotal,
	reviewCheck,
	workCheck,
	idleReviews,
	trendingScan,
	trendingStatus,
	commitIdentity,
	act,
}: {
	map: ReactNode;
	general: boolean;
	host: boolean;
	projects: ProjectView[];
	maxTotal: number | null;
	reviewCheck: boolean;
	workCheck: boolean;
	idleReviews: boolean;
	trendingScan: boolean;
	trendingStatus: TrendingStatus;
	commitIdentity: CommitIdentity | null;
	act: Act;
}) {
	const shown = (id: string): boolean => !hostedHidden(host, id);
	const groupShown = (id: string): boolean =>
		pageToc(general, host).some((g) => g.id === id);
	return (
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
					{shown("projects-section") && (
						<ProjectsOrderSection projects={projects} act={act} />
					)}
					<NotificationsSection projects={projects} act={act} />
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
					{shown("runners-section") && (
						<TotalRunnersForm
							maxTotal={maxTotal}
							projects={projects}
							act={act}
						/>
					)}
				</section>
			)}
			{groupShown("workflow-group") && (
				<section
					className="settings-group"
					id="workflow-group"
					aria-labelledby="workflow-group-title"
					tabIndex={-1}
				>
					<h2 className="settings-group-title" id="workflow-group-title">
						Workflow
					</h2>
					{shown("checks-section") && (
						<ChecksSection
							reviewCheck={reviewCheck}
							workCheck={workCheck}
							act={act}
						/>
					)}
					{shown("automation-section") && (
						<AutomationSection
							idleReviews={idleReviews}
							trendingScan={trendingScan}
							trendingStatus={trendingStatus}
							act={act}
						/>
					)}
				</section>
			)}
			{groupShown("environment-group") && (
				<section
					className="settings-group"
					id="environment-group"
					aria-labelledby="environment-group-title"
					tabIndex={-1}
				>
					<h2 className="settings-group-title" id="environment-group-title">
						Agent environment
					</h2>
					<EnvSection />
					{shown("alate-section") && <AlateSection />}
					{shown("hindsight-section") && <HindsightSection />}
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
						Git and integrations
					</h2>
					{shown("git-hosts-section") && (
						<GitHostsSection commitIdentity={commitIdentity} act={act} />
					)}
					<JiraConnectionsSection />
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
						Access and usage
					</h2>
					{shown("api-key-section") && <ApiKeySection />}
					{shown("session-section") && <SessionSection />}
					{shown("omp-stats-section") && <OmpStatsSection />}
				</section>
			)}
		</>
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
	commitIdentity,
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
	commitIdentity: CommitIdentity | null;
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
	const general = project === null;
	const host = hosted === true;
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
			pickActiveToc(ids, setActive);
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
			id = MOVED_IDS.get(id) ?? id;
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
				{byLabel(projects).map((p) => (
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
					<GeneralSettingsContent
						map={map}
						general={general}
						host={host}
						projects={projects}
						maxTotal={maxTotal}
						reviewCheck={reviewCheck}
						workCheck={workCheck}
						idleReviews={idleReviews}
						trendingScan={trendingScan}
						trendingStatus={trendingStatus}
						commitIdentity={commitIdentity}
						act={act}
					/>
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

/** The microVM switch's desc: why the switch may be off, then the Firecracker explainer. */
const microVmDesc = (project: ProjectView, on: boolean): string =>
	`${project.vmRunner.ok ? "" : project.vmRunner.configured ? `vm-runner is not ready (${project.vmRunner.reason ?? "no answer"})${on ? "; work turns wait until it is" : ""}. ` : "Needs OTTR_VM_RUNNER_URL (docker compose --profile vm). "}Each work turn runs in its own Firecracker microVM with a fresh clone; merge turns stay on the board.`;

/** The switch tag when the repo is known-private: the outside watch is not needed. */
const privateTagFor = (privateRepo: boolean | null): string | undefined =>
	privateRepo === true ? "Not needed: private repo" : undefined;

/** The desc prefix when the repo is known-private: nothing outside to watch. */
const privateNoteFor = (privateRepo: boolean | null, what: string): string =>
	privateRepo === true ? `Private repo: no outside ${what}. ` : "";

/** The Merging card: how a finished card reaches the target branch, and when the board waits for you. */
function ProjectMergingCard({
	project,
	st,
	send,
	act,
}: {
	project: ProjectView;
	st: ProjectView["settings"];
	send: (patch: Record<string, unknown>) => Promise<ProjectView>;
	act: Act;
}) {
	return (
		<SettingsCard
			id="project-merging-section"
			title="Merging"
			status={onChip([
				st.prMode,
				st.holdUpdateMerges,
				st.forkMergeHold,
				st.pushSyncCommits,
			])}
		>
			<div className="alate-def-rows">
				<CheckRow
					name="PR mode"
					desc={`${project.github === null ? "Needs a GitHub remote. " : ""}Push finished card branches and open a pull request to the target branch instead of merging; the card waits in Merging until the pull request merges on GitHub`}
					checked={st.prMode}
					disabled={project.github === null && !st.prMode}
					save={(v) => send({ prMode: v })}
					act={act}
				/>
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
					name="Push sync commits"
					desc="When the local target branch holds commits origin lacks, the board pushes it to origin on its own (OTTR-531); off needs the board's Push to origin button"
					checked={st.pushSyncCommits}
					save={(v) => send({ pushSyncCommits: v })}
					act={act}
				/>
			</div>
		</SettingsCard>
	);
}

/** The Watches card: hourly watches that turn outside activity into cards. */
function ProjectWatchesCard({
	project,
	st,
	send,
	privateTag,
	privateNote,
	act,
}: {
	project: ProjectView;
	st: ProjectView["settings"];
	send: (patch: Record<string, unknown>) => Promise<ProjectView>;
	privateTag: string | undefined;
	privateNote: (what: string) => string;
	act: Act;
}) {
	return (
		<SettingsCard
			id="project-watches-section"
			title="Watches"
			status={onChip([
				st.issueWatch,
				st.prReviews,
				st.prReviews && st.prReviewNotify,
				st.forkResearch,
				st.ompWatch,
			])}
		>
			<div className="alate-def-rows">
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
					name="PR reviews"
					desc={`${project.github === null ? "Needs a GitHub remote. " : ""}${privateNote("pull requests to review")}Hourly watch of open pull requests on GitHub; each new head gets a read-only review draft you can post as a comment`}
					tag={privateTag}
					checked={st.prReviews}
					disabled={project.github === null && !st.prReviews}
					save={(v) => send({ prReviews: v })}
					act={act}
				/>
				<CheckRow
					sub
					name="PR review notifications"
					desc="Bell and push when a review draft arrives or is rewritten, and when new comments land after a posted review; needs PR reviews"
					checked={st.prReviewNotify}
					disabled={!st.prReviews}
					save={(v) => send({ prReviewNotify: v })}
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
					name="omp watch"
					desc="Hourly, a model reads each new omp release's notes. A fail files a card and holds the pin. A pass files a card that bumps Dockerfile.worker."
					checked={st.ompWatch}
					save={(v) => send({ ompWatch: v })}
					act={act}
				/>
			</div>
		</SettingsCard>
	);
}

/** The Proposals card: agents that propose backlog cards (retro follow-ups, trending repos). */
function ProjectProposalsCard({
	st,
	send,
	trendingScan,
	act,
}: {
	st: ProjectView["settings"];
	send: (patch: Record<string, unknown>) => Promise<ProjectView>;
	trendingScan: boolean;
	act: Act;
}) {
	const retro = st.retroSince !== null;
	return (
		<SettingsCard
			id="project-proposals-section"
			title="Proposals"
			status={onChip([retro, retro && st.retroFilter, st.trendingScout])}
		>
			<div className="alate-def-rows">
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
					name="Trending scout"
					desc={
						!trendingScan ? (
							<>
								The general 'Weekly trending scan' switch is off, so the scout
								never runs — turn it on in{" "}
								<a
									href={`${settingsPath(null)}#automation-section`}
									onClick={(e) =>
										navClick(e, () => openSettingsSection("automation-section"))
									}
								>
									General settings
								</a>
								. Weekly: an agent judges GitHub trending repos for this project
								and files up to 3 backlog proposals
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
			</div>
		</SettingsCard>
	);
}

/** The project group: the icon card and the identity card (display name and task-id prefix). */
function ProjectIdentitySection({
	project,
	st,
	act,
	icon,
	markerSave,
	marker,
	setMarker,
	markerDirty,
	markerFormId,
	markerFieldId,
	label,
	setLabel,
	prefix,
	setPrefix,
	labelFieldId,
	prefixFieldId,
	send,
}: {
	project: ProjectView;
	st: ProjectView["settings"];
	act: Act;
	icon: InstantSave;
	markerSave: InstantSave;
	marker: string;
	setMarker: (v: string) => void;
	markerDirty: boolean;
	markerFormId: string;
	markerFieldId: string;
	label: string;
	setLabel: (v: string) => void;
	prefix: string;
	setPrefix: (v: string) => void;
	labelFieldId: string;
	prefixFieldId: string;
	send: (patch: Record<string, unknown>) => Promise<ProjectView>;
}) {
	return (
		<section
			className="settings-group"
			id="project-group"
			aria-labelledby="project-group-title"
			tabIndex={-1}
		>
			<h2 className="settings-group-title" id="project-group-title">
				Project
			</h2>
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
				{(save, ident) => (
					<>
						<DefRow
							name="Display name"
							optional
							help="A friendly name for the board. The folder and the repo keep their real names."
						>
							<div className="alate-field-stack">
								<label>
									<input
										id={labelFieldId}
										type="text"
										maxLength={60}
										value={label}
										onChange={(e) => setLabel(e.target.value)}
										placeholder={project.name}
										aria-label="Display name"
										aria-invalid={ident.failed || undefined}
										aria-describedby={
											ident.failed ? `${labelFieldId}-err` : undefined
										}
									/>
								</label>
								{ident.failed && (
									<p
										className="auth-error"
										id={`${labelFieldId}-err`}
										role="alert"
									>
										{ident.reason ?? "Not saved"}
									</p>
								)}
							</div>
						</DefRow>
						<DefRow
							name="Task ID prefix"
							help="The handle in task ids, like OTTR in OTTR-429. Empty uses the folder-derived handle. Cards that already exist keep their ids."
							shape="empty = from folder name"
						>
							<div className="alate-field-stack">
								<label>
									<input
										id={prefixFieldId}
										type="text"
										maxLength={8}
										value={prefix}
										onChange={(e) => setPrefix(e.target.value)}
										placeholder={project.taskPrefix}
										aria-label="Task ID prefix"
										aria-invalid={ident.failed || undefined}
										aria-describedby={
											ident.failed ? `${prefixFieldId}-err` : undefined
										}
									/>
								</label>
								{ident.failed && (
									<p
										className="auth-error"
										id={`${prefixFieldId}-err`}
										role="alert"
									>
										{ident.reason ?? "Not saved"}
									</p>
								)}
							</div>
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
						{/* One save for the card (OTTR-679): the action row closes the form. */}
						<div className="alate-def-actions">{save}</div>
					</>
				)}
			</SaveCard>
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
											if (!res.ok)
												throw new Error(
													await httpProblem(res, "the icon upload"),
												);
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
											if (!res.ok)
												throw new Error(
													await httpProblem(res, "the icon removal"),
												);
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
								reason={icon.reason}
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
							<div className="alate-field-stack">
								<label>
									<input
										id={markerFieldId}
										type="text"
										maxLength={4}
										value={marker}
										onChange={(e) => setMarker(e.target.value)}
										placeholder="e.g. OT"
										aria-label="Text marker"
										aria-invalid={markerSave.failed || undefined}
										aria-describedby={
											markerSave.failed ? `${markerFieldId}-err` : undefined
										}
									/>
								</label>
								{markerSave.failed && (
									<p
										className="auth-error"
										id={`${markerFieldId}-err`}
										role="alert"
									>
										{markerSave.reason ?? "Not saved"}
									</p>
								)}
							</div>
						</form>
					</DefRow>
				</div>
			</SettingsCard>
		</section>
	);
}

/** The slots group: runner slots, worktrees, and the images cap. */
function ProjectSlotsSection({
	project,
	st,
	act,
	send,
	mp,
	setMp,
	mi,
	setMi,
	kwd,
	setKwd,
	extra,
	setExtra,
	tb,
	setTb,
	paths,
	parallel,
	imagesMax,
	keepDays,
	branchFieldId,
	hosted,
}: {
	project: ProjectView;
	st: ProjectView["settings"];
	act: Act;
	send: (patch: Record<string, unknown>) => Promise<ProjectView>;
	mp: string;
	setMp: (v: string) => void;
	mi: string;
	setMi: (v: string) => void;
	kwd: string;
	setKwd: (v: string) => void;
	extra: string;
	setExtra: (v: string) => void;
	tb: string;
	setTb: (v: string) => void;
	paths: string[];
	parallel: number | null;
	imagesMax: number;
	keepDays: number;
	branchFieldId: string;
	/** Hosted mode runs no vm-runner switch (it sat on the hidden Updates card). */
	hosted: boolean;
}) {
	return (
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
						{!hosted && (
							<CheckRow
								name="Run work turns in microVMs"
								desc={microVmDesc(project, st.microVm)}
								checked={st.microVm}
								disabled={!project.vmRunner.ok && !st.microVm}
								save={(v) => send({ microVm: v })}
								act={act}
							/>
						)}
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
				{(_save, wtS) => (
					<>
						<DefRow
							name="Target branch"
							help="The branch on origin that finished cards merge into. Leave empty to use the repo's default branch (origin/HEAD), or the main checkout's upstream when origin/HEAD is missing."
							shape="branch name · empty = default"
						>
							<div className="alate-field-stack">
								<label>
									<input
										id={branchFieldId}
										type="text"
										maxLength={200}
										placeholder="main"
										aria-label="Target branch for merges"
										value={tb}
										onChange={(e) => setTb(e.target.value)}
										aria-invalid={wtS.failed || undefined}
										aria-describedby={
											wtS.failed ? `${branchFieldId}-err` : undefined
										}
									/>
								</label>
								{wtS.failed && (
									<p
										className="auth-error"
										id={`${branchFieldId}-err`}
										role="alert"
									>
										{wtS.reason ?? "Not saved"}
									</p>
								)}
							</div>
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
					</>
				)}
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
	);
}

/** Project settings "Jira": the board connection the Import from Jira dialog searches.
 *  A pick saves at once; None hides the board's Import from Jira button. */
function ProjectJiraSection({
	project,
	send,
	act,
}: {
	project: ProjectView;
	send: (patch: Record<string, unknown>) => Promise<ProjectView>;
	act: Act;
}) {
	const [names, setNames] = useState<string[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const pick = useOptimisticValue(project.settings.jiraConnection, act);
	useEffect(() => {
		let live = true;
		void (async () => {
			const { status, data } = await gitReq("GET", "/api/jira/connections");
			if (!live) return;
			if (status !== 200)
				setLoadError(asError(data, status, "loading the Jira connections"));
			else
				setNames((data as unknown as JiraConnectionView[]).map((c) => c.name));
		})().catch((err) => {
			if (live) setLoadError(err instanceof Error ? err.message : String(err));
		});
		return () => {
			live = false;
		};
	}, []);
	const current = pick.value;
	// A saved name the list no longer has still shows, so the select never lies about it.
	const options =
		names === null || current === null || names.includes(current)
			? (names ?? [])
			: [current, ...names];
	return (
		<SettingsCard
			id="project-jira-section"
			title="Jira"
			status={
				project.settings.jiraConnection === null
					? { label: "Off", tone: "off" }
					: { label: project.settings.jiraConnection, tone: "ok" }
			}
		>
			<div className="alate-def-rows">
				<DefRow
					name="Jira connection"
					help="The board connection that Import from Jira on this board searches. None hides the button."
					shape="empty = none"
					action={
						<SaveTick
							busy={pick.busy}
							saved={pick.saved}
							failed={pick.failed}
							reason={pick.reason}
						/>
					}
				>
					<label>
						<select
							value={current ?? ""}
							disabled={names === null}
							onChange={(e) => {
								const v = e.target.value === "" ? null : e.target.value;
								pick.set(v);
								pick.run(() => send({ jiraConnection: v }));
							}}
							aria-label="Jira connection"
						>
							<option value="">None</option>
							{options.map((n) => (
								<option key={n} value={n}>
									{n}
								</option>
							))}
						</select>
					</label>
				</DefRow>
			</div>
			{names !== null && names.length === 0 && (
				<p className="hint">
					No Jira connection exists yet. Add one in{" "}
					<a
						href={`${settingsPath(null)}#jira-section`}
						onClick={(e) =>
							navClick(e, () => openSettingsSection("jira-section"))
						}
					>
						General settings
					</a>
					.
				</p>
			)}
			{loadError !== null && (
				<p className="auth-error" role="alert">
					{loadError}
				</p>
			)}
		</SettingsCard>
	);
}

/** The releases and reviews cards: the release command and the review interval. */
function ProjectReviewsCards({
	project,
	st,
	act,
	send,
	relcmd,
	setRelcmd,
	cap,
	setCap,
	reviewCap,
	tasks,
	openTask,
}: {
	project: ProjectView;
	st: ProjectView["settings"];
	act: Act;
	send: (patch: Record<string, unknown>) => Promise<ProjectView>;
	relcmd: string;
	setRelcmd: (v: string) => void;
	cap: string;
	setCap: (v: string) => void;
	reviewCap: number;
	tasks: TaskCard[];
	openTask: (id: string) => void;
}) {
	return (
		<>
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
	/** Hosted mode (docs/specs/hosted-mode.md): the merge, watch and proposal cards are hidden. */
	hosted?: boolean;
}) {
	const shownP = (id: string): boolean => !hostedHidden(hosted === true, id);
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
	const privateTag = privateTagFor(privateRepo);
	const privateNote = (what: string): string =>
		privateNoteFor(privateRepo, what);
	const [prefix, setPrefix] = useState(st.taskIdPrefix ?? "");
	const icon = useInstantSave(act);
	const markerSave = useInstantSave(act);
	const markerFormId = useId();
	const markerFieldId = useId();
	const labelFieldId = useId();
	const prefixFieldId = useId();
	const branchFieldId = useId();
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
			<ProjectIdentitySection
				project={project}
				st={st}
				act={act}
				icon={icon}
				markerSave={markerSave}
				marker={marker}
				setMarker={setMarker}
				markerDirty={markerDirty}
				markerFormId={markerFormId}
				markerFieldId={markerFieldId}
				label={label}
				setLabel={setLabel}
				prefix={prefix}
				setPrefix={setPrefix}
				labelFieldId={labelFieldId}
				prefixFieldId={prefixFieldId}
				send={send}
			/>
			<ProjectSlotsSection
				project={project}
				st={st}
				act={act}
				send={send}
				mp={mp}
				setMp={setMp}
				mi={mi}
				setMi={setMi}
				kwd={kwd}
				setKwd={setKwd}
				extra={extra}
				setExtra={setExtra}
				tb={tb}
				setTb={setTb}
				paths={paths}
				parallel={parallel}
				imagesMax={imagesMax}
				keepDays={keepDays}
				branchFieldId={branchFieldId}
				hosted={hosted === true}
			/>
			{shownP("project-merging-section") && (
				<section
					className="settings-group"
					id="project-merging-group"
					aria-labelledby="project-merging-group-title"
					tabIndex={-1}
				>
					<h2 className="settings-group-title" id="project-merging-group-title">
						Merging
					</h2>
					<ProjectMergingCard project={project} st={st} send={send} act={act} />
				</section>
			)}
			<section
				className="settings-group"
				id="project-reviews-group"
				aria-labelledby="project-reviews-group-title"
				tabIndex={-1}
			>
				<h2 className="settings-group-title" id="project-reviews-group-title">
					Releases and reviews
				</h2>
				<ProjectReviewsCards
					project={project}
					st={st}
					act={act}
					send={send}
					relcmd={relcmd}
					setRelcmd={setRelcmd}
					cap={cap}
					setCap={setCap}
					reviewCap={reviewCap}
					tasks={tasks}
					openTask={openTask}
				/>
			</section>
			{shownP("project-watches-section") && (
				<section
					className="settings-group"
					id="project-cards-group"
					aria-labelledby="project-cards-group-title"
					tabIndex={-1}
				>
					<h2 className="settings-group-title" id="project-cards-group-title">
						New cards
					</h2>
					<ProjectWatchesCard
						project={project}
						st={st}
						send={send}
						privateTag={privateTag}
						privateNote={privateNote}
						act={act}
					/>
					<ProjectProposalsCard
						st={st}
						send={send}
						trendingScan={trendingScan}
						act={act}
					/>
				</section>
			)}
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
				id="project-integrations-group"
				aria-labelledby="project-integrations-group-title"
				tabIndex={-1}
			>
				<h2
					className="settings-group-title"
					id="project-integrations-group-title"
				>
					Integrations
				</h2>
				<ProjectJiraSection project={project} send={send} act={act} />
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
