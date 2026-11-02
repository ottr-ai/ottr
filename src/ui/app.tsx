import type { Mermaid } from "mermaid";
import type {
	CSSProperties,
	ClipboardEvent as ReactClipboardEvent,
	DragEvent as ReactDragEvent,
	MouseEvent as ReactMouseEvent,
	ReactNode,
} from "react";
import {
	Fragment,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createRoot } from "react-dom/client";
import { joinLevel, splitLevel, THINKING_LEVELS } from "../levels.ts";
import type { ModelOption } from "../models.ts";
import { commitDeltas } from "../progress.ts";
import {
	FORK_PROPOSED_REASON_PREFIX,
	PROPOSED_REASON_PREFIX,
} from "../prompts.ts";
import { forModel, tightest, tightestFor } from "../quota.ts";
import { queueOrder, waitingOn } from "../scheduler.ts";
import { groupTopics } from "../topics.ts";
import type {
	AddProjectResponse,
	AskQuestion,
	GhStatus,
	KeptChoice,
	MachineStats,
	PerfMetrics,
	PerfRange,
	PerfResponse,
	PerfStat,
	ProjectView,
	ProvisioningResponse,
	PrReviewView,
	QuotaState,
	ReleasePlan,
	Stage,
	StateResponse,
	TaskCard,
	TaskView,
	UpdateRow,
	UpdatesView,
} from "../types.ts";
import { PERF_RANGES, PRIORITIES, VERSION_RE } from "../types.ts";
import { mapRepo } from "../updates.ts";
import {
	type AttachedImage,
	type AttachedImages,
	readPicks,
} from "./attach.ts";
import { diffFileSlice, diffLineClass, diffLinkParts } from "./diff.ts";
import type { CardPos } from "./flight.ts";
import { freshTaskIds, listSlides, stageFlights } from "./flight.ts";
import logo from "./icon-192.png";
import {
	type Act,
	BAND_LIMIT,
	BusyButton,
	CloseButton,
	clamp,
	copyText,
	Icon,
	interviewMsg,
	LOGOUT_KEY,
	loadLevel,
	logOut,
	Mark,
	Meter,
	Modal,
	ProjectLogo,
	ProjectTag,
	post,
	projectLabel,
	unwrap,
	useBusy,
	useFlash,
	useQuota,
} from "./kit.tsx";
import { Markdown } from "./markdown.tsx";
import {
	type ModelCatalog,
	modelMatches,
	modelRows,
	reviewModel,
	stepIndex,
	useModels,
} from "./models.ts";
import {
	alatePendingEntry,
	clearAskDraft,
	clearComposeDraft,
	freshAlerts,
	type InboxEntry,
	inboxView,
	loadAskDrafts,
	loadComposeDraft,
	loadInboxSeen,
	loadSeenAnswers,
	NOTIFY_KEY,
	notificationsOn,
	notificationsSupported,
	pruneAskDrafts,
	pruneSeen,
	requestNotifyPermission,
	SEEN_KEY,
	saveAskDraft,
	saveComposeDraft,
	saveInboxSeen,
	showAlerts,
	taskEntryKey,
} from "./notify.ts";
import {
	donePage,
	dropBeforeId,
	isUnread,
	laneCounts,
	laneOrder,
	laneStage,
	reorderIds,
	SLOT_STAGES,
	type SlotCounts,
	seenable,
	slotUse,
} from "./queue.ts";
import { readHash, SETTINGS_HASH, settingsSub } from "./route.ts";
import {
	alateHint,
	asError,
	asTrust,
	type GitHostsView,
	gitReq,
	openSettingsSection,
	type PendingKeyInfo,
	PendingKeyRow,
	ProjectSetupSteps,
	SettingsPage,
	SetupWizardModal,
	SshTestRow,
	type TestAnswer,
	type TrustNeeded,
} from "./settings.tsx";
import {
	connectLive,
	connectPolling,
	latestStats,
	liveEvents,
	refreshState,
} from "./socket.ts";
import {
	alarmLabel,
	cardMark,
	holdFor,
	splitAlarms,
	statusLine,
	strykerProgress,
	strykerStats,
} from "./status.ts";
import { age, duration, landed, stamp, turnDuration, until } from "./time.ts";
import { decideReload, RELOAD_GUARD_KEY, SEEN_VERSION_KEY } from "./version.ts";
import {
	type WorkflowKind,
	withLiveSlots,
	workflowKind,
	workflowLive,
} from "./workflow.ts";

/** The Ottr repo itself, shown in the menu footer. */
const REPO = "https://github.com/ottr-ai/ottr";

const COLUMNS: readonly { key: Stage; label: string }[] = [
	{ key: "todo", label: "Todo" },
	{ key: "in_progress", label: "In progress" },
	{ key: "merging", label: "Merging" },
	{ key: "done", label: "Done" },
];
/** Tab order for the mobile stage tabs (roving-tabindex keyboard model). */
const STAGE_KEYS = COLUMNS.map((c) => c.key);

/* GitHub mark, octicons (MIT) — fill glyph, so it sits outside the stroke Icon set */
function GhMark() {
	return (
		<svg
			className="gh-mark"
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="currentColor"
			aria-hidden="true"
		>
			<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
		</svg>
	);
}

/** 401 (no or expired session) and 403 (refused) both mean the board needs a fresh login. */
const sessionLost = (status: number): boolean =>
	status === 401 || status === 403;

/** Version the task released, e.g. "v0.28.2": stamped onto the row by the tracker when the merge integrated; release cards carry theirs from creation. */
function releaseOf(t: TaskCard): string | null {
	return t.stage === "done" ? t.releaseVersion : null;
}

/** A drag carrying files (from the file explorer); plain text drags stay out of the way. */
const isFileDrag = (e: ReactDragEvent<HTMLTextAreaElement>): boolean =>
	e.dataTransfer.types.includes("Files");

/** Image attachments for one input: paste, drop from a file explorer, or the browse button. */
function useAttachedImages(): AttachedImages {
	const [images, setImages] = useState<AttachedImage[]>([]);
	const [dropping, setDropping] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const current = useRef(images);
	current.current = images;
	useEffect(
		() => () => {
			for (const i of current.current) URL.revokeObjectURL(i.url);
		},
		[],
	);
	const addFiles = useCallback((files: Iterable<File>): void => {
		const picks = Array.from(files).filter((f) => f.type.startsWith("image/"));
		if (picks.length === 0) return;
		// Read now, not at send: an unreadable file is refused here, with its message.
		readPicks(picks)
			.then(({ ok, failed }) => {
				setError(failed);
				if (ok.length === 0) return;
				setImages((prev) => [
					...prev,
					...ok.map(({ file, data }) => ({
						file,
						data,
						url: URL.createObjectURL(file),
					})),
				]);
			})
			.catch((err: unknown) =>
				setError(err instanceof Error ? err.message : String(err)),
			);
	}, []);
	const onPaste = useCallback(
		(e: ReactClipboardEvent<HTMLTextAreaElement>): void =>
			addFiles(e.clipboardData.files),
		[addFiles],
	);
	const onDragOver = useCallback(
		(e: ReactDragEvent<HTMLTextAreaElement>): void => {
			if (!isFileDrag(e)) return;
			e.preventDefault(); // signal a valid drop target, else the browser navigates to the file
			setDropping(true);
		},
		[],
	);
	const onDragLeave = useCallback((): void => setDropping(false), []);
	const onDrop = useCallback(
		(e: ReactDragEvent<HTMLTextAreaElement>): void => {
			if (!isFileDrag(e)) return;
			e.preventDefault();
			setDropping(false);
			addFiles(e.dataTransfer.files);
		},
		[addFiles],
	);
	const remove = useCallback((index: number): void => {
		const gone = current.current[index];
		if (gone !== undefined) URL.revokeObjectURL(gone.url);
		setImages((prev) => prev.filter((_, i) => i !== index));
	}, []);
	const clear = useCallback((): void => {
		for (const i of current.current) URL.revokeObjectURL(i.url);
		setImages([]);
	}, []);
	return {
		images,
		dropping,
		error,
		dismissError: useCallback((): void => setError(null), []),
		onPaste,
		onDragOver,
		onDragLeave,
		onDrop,
		addFiles,
		remove,
		clear,
	};
}

function ImageThumbs({
	images,
	onRemove,
	onOpen,
}: {
	images: AttachedImage[];
	onRemove: (index: number) => void;
	onOpen: (index: number) => void;
}) {
	if (images.length === 0) return null;
	return (
		<div className="thumbs">
			{images.map((img, i) => (
				<span key={img.url} className="thumb">
					<button
						type="button"
						className="thumb-open"
						title="Open full size"
						onClick={() => onOpen(i)}
					>
						<img src={img.url} alt={`Attached ${i + 1}`} />
					</button>
					<button
						type="button"
						className="thumb-x"
						aria-label={`Remove image ${i + 1}`}
						onClick={() => onRemove(i)}
					>
						<Icon name="x" size={11} />
					</button>
				</span>
			))}
		</div>
	);
}

/** Hidden-file-input picker behind the Add image button; the ref survives re-picking the same file. */
function ImageBrowseButton({
	onAdd,
}: {
	onAdd: (files: Iterable<File>) => void;
}) {
	const input = useRef<HTMLInputElement>(null);
	return (
		<>
			<button
				type="button"
				className="browse"
				title="Attach images from disk"
				onClick={() => input.current?.click()}
			>
				<Icon name="image" />
				Add image…
			</button>
			<input
				ref={input}
				className="sr"
				type="file"
				accept="image/*"
				multiple
				// Opened only through the browse button above; focusable it would be an
				// invisible tab stop, and its a11y name would fight the button's label.
				tabIndex={-1}
				aria-hidden="true"
				onChange={(e) => {
					onAdd(e.target.files ?? []);
					e.target.value = ""; // picking the same file again must still fire change
				}}
			/>
		</>
	);
}

/** The action row under Reply and Steer: the run settings (model, thinking) over one button
 * bar with Add image at its left edge; `primary` is the form's submit. */
function ComposerActions({
	onAddImages,
	catalog,
	model,
	setModel,
	modelQuery,
	setModelQuery,
	secondary,
	primary,
}: {
	onAddImages: (files: Iterable<File>) => void;
	catalog: ModelCatalog | null;
	model: string;
	setModel: (m: string) => void;
	modelQuery: string;
	setModelQuery: (q: string) => void;
	secondary?: ReactNode;
	primary: ReactNode;
}) {
	return (
		<div className="composer-actions">
			<ModelField
				catalog={catalog}
				model={model}
				setModel={setModel}
				modelQuery={modelQuery}
				setModelQuery={setModelQuery}
			/>
			<div className="composer-bar">
				<ImageBrowseButton onAdd={onAddImages} />
				{secondary}
				{primary}
			</div>
		</div>
	);
}

/** The shared text+image input behind New task, Reply/follow-up and Steer: paste, drop or browse images. */
function PromptInput({
	label,
	value,
	placeholder,
	rows = 3,
	autoFocus,
	onChange,
	onEnter,
	images,
	onView,
}: {
	label: string;
	value: string;
	placeholder: string;
	rows?: number;
	autoFocus?: boolean;
	onChange: (value: string) => void;
	onEnter: () => void;
	images: AttachedImages;
	onView: (index: number) => void;
}) {
	// Several of these stay mounted at once (one New task dialog per project), so the
	// label/textarea pair needs a generated id: fixed strings collided.
	const id = useId();
	return (
		<div className="prompt-field">
			<label htmlFor={id}>{label}</label>
			<textarea
				id={id}
				rows={rows}
				value={value}
				placeholder={placeholder}
				data-autofocus={autoFocus || undefined}
				className={images.dropping ? "drop-target" : undefined}
				onChange={(e) => onChange(e.target.value)}
				onPaste={images.onPaste}
				onDragOver={images.onDragOver}
				onDragLeave={images.onDragLeave}
				onDrop={images.onDrop}
				onKeyDown={(e) => {
					if (
						e.key !== "Enter" ||
						e.shiftKey ||
						e.altKey ||
						e.nativeEvent.isComposing
					)
						return;
					e.preventDefault();
					onEnter();
				}}
			/>
			{images.error !== null && (
				<p className="attach-error" role="alert">
					<Mark kind="crit" />
					<span>{images.error}</span>
					<button
						type="button"
						className="icon"
						aria-label="Dismiss error"
						onClick={images.dismissError}
					>
						<Icon name="x" />
					</button>
				</p>
			)}
			{images.images.length > 0 && (
				<div className="attach-row">
					<ImageThumbs
						images={images.images}
						onRemove={images.remove}
						onOpen={onView}
					/>
				</div>
			)}
		</div>
	);
}

/** Native HTML5 drag wiring for a queued card; absent when the column has no DnD or the card is not queued. */
type CardDrag = {
	draggable: boolean;
	dragging: boolean;
	dropBefore: boolean;
	onDragStart: (e: React.DragEvent<HTMLDivElement>) => void;
	onDragEnd: () => void;
};

/** Rank and close-candidate chips, shared by the board card and the overview triage row.
 * Text labels, never color alone; the close badge's tooltip carries the reason. */
function RankBadges({
	task,
}: {
	task: Pick<TaskCard, "priority" | "closeCandidate">;
}) {
	return (
		<span className="rank-badges">
			{task.priority !== null && (
				<span className="rank-badge" title={`Triage rank ${task.priority}`}>
					{task.priority}
				</span>
			)}
			{task.closeCandidate !== null && (
				<span className="close-badge" title={task.closeCandidate}>
					Close
				</span>
			)}
		</span>
	);
}

/** Triage wait order: rank first (P0 before P3, unrated last), then the existing
 * updatedAt wait order breaking ties. */
export function triageWait(a: TaskCard, b: TaskCard): number {
	const ra =
		a.priority == null ? PRIORITIES.length : PRIORITIES.indexOf(a.priority);
	const rb =
		b.priority == null ? PRIORITIES.length : PRIORITIES.indexOf(b.priority);
	return ra - rb || a.updatedAt - b.updatedAt;
}

function Card({
	task,
	hasRules,
	github,
	onOpen,
	unread,
	delta,
	fuOf,
	drag,
	hold,
	drain,
	locked,
	onStar,
}: {
	task: TaskCard;
	hasRules: boolean;
	github: string | null;
	onOpen: () => void;
	unread: boolean;
	delta?: number;
	fuOf?: string | null;
	drag?: CardDrag;
	/** Why the tracker holds this queued card (a merge: a live review or its findings; a todo: its
	 * unfinished dependencies); null or undefined otherwise. */
	hold?: string | null;
	/** True while an update holds new turns (POST /api/drain): queued cards wait for the restart. */
	drain?: boolean;
	/** A reorder request for this card is in flight; the card dims and cannot start another drag. */
	locked?: boolean;
	/** Done research cards only: renders the star toggle; the handler posts and never opens the drawer. */
	onStar?: () => void;
}) {
	const release = releaseOf(task);
	const commits = task.stage === "done" ? task.commits : null;
	const sp = task.state === "running" ? strykerProgress(task.progress) : null;
	const silent =
		task.silentSince !== undefined
			? `No log output for ${duration(Date.now() - task.silentSince)}: the agent may wait on a hung command. Steer, stop or cancel the card.`
			: null;
	return (
		// A stretched button opens the card; the release link sits beside it, never nested in it.
		// biome-ignore lint/a11y/noStaticElementInteractions: HTML5 drag-and-drop on the card shell; keyboard users act through the stretched button inside
		<div
			className={`card${drag?.dragging ? " dragging" : ""}${drag?.dropBefore ? " drop-before" : ""}${locked ? " reorder-lock" : ""}`}
			data-state={task.state}
			data-task-id={task.id}
			data-stage={task.stage}
			data-cancelled={task.cancelledAt !== null ? "" : undefined}
			data-asked={
				task.state === "needs_you" && task.asked !== null ? "" : undefined
			}
			data-unread={unread ? "" : undefined}
			data-held={hold ? "" : undefined}
			draggable={drag?.draggable}
			onDragStart={drag?.onDragStart}
			onDragEnd={drag?.onDragEnd}
		>
			<button
				type="button"
				className="card-open"
				title={
					task.state === "needs_you"
						? (task.needsReason ?? "Action required")
						: undefined
				}
				onClick={onOpen}
			>
				<span className="card-head">
					<Mark kind={cardMark(task)} />
					<span className="card-key" title={`Task ${task.id}`}>
						{task.id}
					</span>
					{unread && (
						<span
							className="unread"
							title={
								task.kind === "pr_review"
									? "New PR review"
									: "Answered; not opened yet"
							}
						>
							new
						</span>
					)}
					{task.research && (
						<span
							className="research"
							title="Research task: answers with a report, nothing to merge"
						>
							research
						</span>
					)}
					{task.cancelledAt !== null && (
						<span
							className="cancelled"
							title={`Cancelled ${stamp(task.cancelledAt)}`}
						>
							Cancelled · {landed(task.cancelledAt)}
						</span>
					)}
					<RankBadges task={task} />
				</span>
				<span className="card-title">{task.sessionTitle ?? task.title}</span>
				{/* Needs attention: the error takes the prompt line until the state clears; the
				    card-open title also carries it. Ask rounds keep the prompt: their reason just
				    echoes the first question the drawer's ask panel shows in full. A live turn
				    whose log went silent past the board's limit takes the same line. */}
				{task.state === "needs_you" &&
				task.asked === null &&
				task.needsReason !== null ? (
					<span className="card-error" title={task.needsReason}>
						{task.needsReason}
					</span>
				) : silent !== null ? (
					<span className="card-error" title={silent}>
						{silent}
					</span>
				) : (
					task.sessionTitle !== task.title && (
						<span className="card-original" title={task.title}>
							{task.title}
						</span>
					)
				)}
				{/* The two-way follow-up link names its parent on the card itself, like the
				    drawer's "Follow-up of" chip; a bare glyph made the name hover-only. */}
				{fuOf != null && (
					<span className="card-fu" title={`Follow-up of ${fuOf}`}>
						<Icon name="corner-up-left" size={12} />
						<span className="card-fu-title">{fuOf}</span>
					</span>
				)}
				<span
					className="card-meta"
					title={stamp(
						task.cancelledAt ??
							(task.stage === "done" && task.doneAt !== null
								? task.doneAt
								: task.createdAt),
					)}
				>
					{task.cancelledAt !== null
						? landed(task.cancelledAt)
						: task.stage === "done" && task.doneAt !== null
							? landed(task.doneAt)
							: age(task.createdAt)}{" "}
					{sp === null && <>· {statusLine(task, hasRules, hold, drain)}</>}
					{task.stage !== "done" && (
						<span
							className="model"
							title={`Main loop model: ${task.model ?? task.lastModel ?? "default"}${task.model === null && task.lastModel ? " (last run)" : ""}`}
						>
							{task.model ?? task.lastModel ?? "default"}
						</span>
					)}
					{commits !== null && (
						<span
							className="commits"
							title={
								delta !== undefined
									? `Commits on target: ${commits} (+${delta} since the previous task)`
									: `Commits on target: ${commits}`
							}
						>
							{delta !== undefined ? `+${delta} → ${commits}` : `→ ${commits}`}
						</span>
					)}
				</span>
				{sp !== null && (
					<span className="card-stryker" title={task.progress ?? undefined}>
						<Meter
							label={sp.tool}
							pct={sp.pct}
							value={`${sp.tested}/${sp.total}`}
							band={false}
						/>
						<span className="stryker-stats">{sp.rest}</span>
					</span>
				)}
			</button>
			{(release !== null ||
				(task.stage === "done" && task.research && onStar)) && (
				<span className="card-tags">
					{release !== null &&
						(github !== null ? (
							<a
								className="release"
								href={`${github}/releases/tag/${release}`}
								target="_blank"
								rel="noopener noreferrer"
								title={`GitHub release ${release}`}
							>
								{release}
							</a>
						) : (
							<span className="release" title={`Released ${release}`}>
								{release}
							</span>
						))}
					{task.stage === "done" && task.research && onStar && (
						<button
							type="button"
							className="card-star"
							aria-pressed={task.starred}
							title={task.starred ? "Starred" : "Star this report"}
							onClick={(e) => {
								// The card body is a stretched open button: keep the click off it.
								e.preventDefault();
								e.stopPropagation();
								onStar();
							}}
						>
							<Icon name="star" size={12} />
						</button>
					)}
				</span>
			)}
		</div>
	);
}

/** Machine stats pushed every 30 s over the board socket; cpu and ram are 15-minute averages, no trend. */
function useStats(): MachineStats | null {
	const [stats, setStats] = useState<MachineStats | null>(latestStats);
	useEffect(() => {
		const onStats = (e: Event): void => {
			setStats((e as CustomEvent<MachineStats>).detail);
		};
		liveEvents.addEventListener("stats", onStats);
		return () => liveEvents.removeEventListener("stats", onStats);
	}, []);
	return stats;
}

const WINDOW_UNIT_MS = {
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
	w: 604_800_000,
} as const;

/** Share of a quota window that has passed, 0-100, from omp's window id ("5h", "7d") or, when omp
 *  names none, the label ("5 Hours", "7 Day", "Weekly"). Null when the length or the reset is unknown. */
export function windowGone(
	l: QuotaState["limits"][number],
	now: number,
): number | null {
	if (l.resetsAt === null) return null;
	const id = /^(\d+)([mhdw])$/.exec(l.window ?? "");
	const named = /(\d+)\s*(hour|day|week)/i.exec(l.label);
	const ms = id
		? Number(id[1]) * WINDOW_UNIT_MS[id[2] as keyof typeof WINDOW_UNIT_MS]
		: named
			? Number(named[1]) *
				WINDOW_UNIT_MS[named[2]![0]!.toLowerCase() as "h" | "d" | "w"]
			: /weekly/i.test(l.label)
				? WINDOW_UNIT_MS.w
				: null;
	if (ms === null || ms <= 0) return null;
	return clamp(100 - ((l.resetsAt - now) / ms) * 100, 0, 100);
}

/** Overview indicators in the app bar; the button opens the detail popover (15-minute machine averages, quota, agents). */
function SystemBar({
	tasks,
	maxTotal,
	quota,
}: {
	tasks: TaskCard[];
	maxTotal: number | null;
	quota: QuotaState | null;
}) {
	const stats = useStats();
	const catalog = useModels();
	const slots = slotUse(tasks);
	const used = SLOT_STAGES.reduce((n, s) => n + slots[s], 0);
	const waiting = queueOrder(tasks).length;
	// The bar tracks the default model's provider: that is the quota that stops agents first.
	const tightest = tightestFor(
		quota?.limits ?? [],
		catalog?.defaultModel ?? null,
	);
	return (
		<>
			<button
				type="button"
				className="meters"
				popoverTarget="system-detail"
				aria-label={
					waiting > 0
						? `${waiting} waiting, all projects. Machine, quota and agent details`
						: "Machine, quota and agent details"
				}
				title="Machine, quota and agent details"
			>
				<Meter label="CPU" pct={stats?.cpu ?? null} />
				<Meter label="RAM" pct={stats?.ram.pct ?? null} />
				{(tightest !== null || quota === null || quota.error !== null) && (
					<Meter
						label="Quota"
						pct={tightest?.usedPct ?? null}
						title={
							tightest === null
								? undefined
								: `Tightest limit: ${tightest.provider} ${tightest.label}, ${tightest.usedPct}% used`
						}
					/>
				)}
				<Meter
					label="Agents"
					pct={
						maxTotal !== null && maxTotal > 0 ? (used / maxTotal) * 100 : null
					}
					value={maxTotal === null ? `${used}/∞` : `${used}/${maxTotal}`}
					band={false}
				/>
				{/* Mobile: the bar hides every meter but the quota, so the running count
				    rides the mark icon instead of the Agents meter's text. */}
				<span className="agents-count">
					<Mark kind="running" />
					{used}
					<span className="sr"> running</span>
				</span>
				{/* role=status, mounted even at zero: a live region must exist before a change
				    for screen readers to announce the 0→1 step. */}
				<span className="meter-note" role="status">
					{waiting > 0 ? `${waiting} waiting · all projects` : ""}
				</span>
			</button>
			<div id="system-detail" popover="auto" className="popover">
				{/* Order by urgency: agents first (big figures, no table to read), quota second,
				    the machine averages last on one line. Running counts preparing todo slots too. */}
				<section>
					<h2>Agents</h2>
					<dl className="ag-nums">
						<div data-zero={slots.in_progress + slots.todo === 0 || undefined}>
							<dt>
								<Mark kind="running" />
								Running
							</dt>
							<dd>{slots.in_progress + slots.todo}</dd>
						</div>
						<div data-zero={slots.merging === 0 || undefined}>
							<dt>
								<Icon name="git-merge" size={13} />
								Merging
							</dt>
							<dd>{slots.merging}</dd>
						</div>
						<div data-zero={waiting === 0 || undefined}>
							<dt>
								<Icon name="clock" size={13} />
								Waiting
							</dt>
							<dd>{waiting}</dd>
						</div>
					</dl>
					<div className="ag-cap">
						{maxTotal === null ? (
							<span className="caption">No cap on agents across projects.</span>
						) : (
							<Meter
								label="Slots"
								pct={maxTotal > 0 ? (used / maxTotal) * 100 : null}
								value={`${used}/${maxTotal}`}
								band={false}
							/>
						)}
					</div>
				</section>
				<section>
					<h2>Provider quota</h2>
					{quota === null ? (
						<p className="caption">Checking omp usage…</p>
					) : quota.error !== null ? (
						<p className="caption">omp usage failed: {quota.error}</p>
					) : quota.limits.length === 0 ? (
						<p className="caption">
							omp reports no usage limits for your accounts.
						</p>
					) : (
						<>
							{/* One row per window: a thin time line over the quota bar, so a quota bar
							    longer than its time line means the window burns faster than it runs. */}
							<div className="qt">
								<div className="qt-head" aria-hidden="true">
									<span />
									<span className="qt-key">
										<span>
											<span className="qt-time">
												<i />
											</span>
											time
										</span>
										<span>
											<span className="qt-used">
												<i />
											</span>
											quota
										</span>
									</span>
									<span className="qt-num">used</span>
									<span className="qt-num">resets</span>
								</div>
								{[...Map.groupBy(quota.limits, (l) => l.provider)].map(
									([provider, limits]) => (
										<Fragment key={provider}>
											<h3>{provider}</h3>
											{limits.map((l) => {
												const gone = windowGone(l, Date.now());
												return (
													<div
														key={l.label}
														className="qt-row"
														data-level={loadLevel(l.usedPct)}
													>
														<span className="qt-label" title={l.label}>
															{l.label}
														</span>
														<span
															className="qt-bars"
															role="img"
															aria-label={`${Math.round(l.usedPct)} % used${gone === null ? "" : `, ${Math.round(gone)} % of the window gone`}`}
														>
															{gone !== null && (
																<span className="qt-time">
																	<i style={{ width: `${gone}%` }} />
																</span>
															)}
															<span className="qt-used">
																<i
																	style={{
																		transform: `scaleX(${clamp(l.usedPct, 0, 100) / 100})`,
																	}}
																/>
															</span>
														</span>
														<span className="qt-val">
															{Math.round(l.usedPct)} %
														</span>
														<span
															className="qt-reset"
															title={
																l.resetsAt === null
																	? undefined
																	: `Resets ${stamp(l.resetsAt)}`
															}
														>
															{l.resetsAt === null ? "–" : until(l.resetsAt)}
														</span>
													</div>
												);
											})}
										</Fragment>
									),
								)}
							</div>
							<p className="caption">
								Checked {age(quota.at)}. Amber from {BAND_LIMIT} % used.
							</p>
						</>
					)}
				</section>
				<section>
					<p className="mach">
						Machine, 15-min average · CPU{" "}
						<b>{stats === null ? "n/a" : `${stats.cpu} %`}</b> · RAM{" "}
						<b>
							{stats === null
								? "n/a"
								: `${stats.ram.usedGiB} / ${stats.ram.totalGiB} GiB`}
						</b>
					</p>
				</section>
			</div>
		</>
	);
}

/** The workflow overview behind the drawer's diagram button: the README diagram of this card's
 *  workflow with the card's current stage highlighted, plus the board's live slot data painted
 *  over the diagram's default numbers. The SVG scopes its styles under its own .wf root class,
 *  so embedding it cannot touch the app's own rules. */
function WorkflowModal({
	kind,
	stage,
	label,
	live,
	onClose,
}: {
	kind: WorkflowKind;
	/** The card's current stage; null (a cancelled card) gets no highlight. */
	stage: Stage | null;
	/** The name the board shows for the card's project. */
	label: string;
	/** Live slot facts: this project's use and queue, the machine cap, and the drain flag. */
	live: {
		slots: SlotCounts;
		waiting: number;
		maxParallel: number | null;
		maxTotal: number | null;
		usedTotal: number;
		draining: boolean;
	};
	onClose: () => void;
}) {
	const [result, setResult] = useState<
		{ text: string } | { failed: true } | null
	>(null);
	useEffect(() => {
		let alive = true;
		setResult(null);
		fetch(`/workflow-${kind}.svg`)
			.then(async (res) => {
				if (!alive) return;
				if (!res.ok) throw new Error(String(res.status));
				setResult({ text: await res.text() });
			})
			.catch(() => {
				if (alive) setResult({ failed: true });
			});
		return () => {
			alive = false;
		};
	}, [kind]);
	return (
		<Modal
			open
			onClose={onClose}
			label="Workflow overview"
			className="wf-modal"
		>
			<div className="wf-head">
				<h3>Workflow</h3>
				<CloseButton />
			</div>
			{result === null ? (
				<p className="hint">Loading…</p>
			) : "failed" in result ? (
				<p className="hint" role="alert">
					The diagram failed to load.
				</p>
			) : (
				<div
					className={`wf-view${stage !== null ? ` wf-cur-${stage}` : ""}`}
					dangerouslySetInnerHTML={{
						__html: withLiveSlots(result.text, live.maxParallel, live.maxTotal),
					}}
				/>
			)}
			<p className="wf-live">{workflowLive({ label, ...live })}</p>
			<p className="wf-here">
				{stage === null
					? "This card was cancelled."
					: `You are here: ${COLUMNS.find((c) => c.key === stage)?.label ?? stage}`}
			</p>
		</Modal>
	);
}

declare global {
	interface Window {
		/** Set by /mermaid.min.js; see loadMermaid. */
		mermaid?: Mermaid;
	}
}
let mermaidLoad: Promise<Mermaid> | null = null;
/** mermaid's prebuilt bundle, served by the server at /mermaid.min.js and loaded once on first
 *  use: Bun's HTML bundler would inline a dynamic import into the board bundle. A failed load
 *  clears the promise, so the next open retries. */
function loadMermaid(): Promise<Mermaid> {
	if (mermaidLoad !== null) return mermaidLoad;
	const { promise, resolve, reject } = Promise.withResolvers<Mermaid>();
	const fail = () => {
		mermaidLoad = null;
		s.remove();
		reject(new Error("mermaid failed to load"));
	};
	const s = document.createElement("script");
	s.src = "/mermaid.min.js";
	s.onload = () => (window.mermaid ? resolve(window.mermaid) : fail());
	s.onerror = fail;
	document.head.append(s);
	mermaidLoad = promise;
	return promise;
}

/** One Mermaid block drawn as SVG. mermaid's default securityLevel "strict" sanitizes the SVG
 *  before it reaches the DOM. */
function MermaidDiagram({ code }: { code: string }) {
	const [svg, setSvg] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	const id = useId().replace(/[^a-zA-Z0-9]/g, "");
	useEffect(() => {
		let alive = true;
		loadMermaid()
			.then(async (mermaid) => {
				mermaid.initialize({
					startOnLoad: false,
					theme:
						document.documentElement.dataset.theme === "light"
							? "default"
							: "dark",
				});
				const r = await mermaid.render(`mmd${id}`, code);
				if (alive) setSvg(r.svg);
			})
			.catch(() => {
				if (alive) setFailed(true);
			});
		return () => {
			alive = false;
		};
	}, [code, id]);
	if (failed)
		return (
			<>
				<p className="hint" role="alert">
					This diagram failed to render.
				</p>
				<pre>
					<code>{code}</code>
				</pre>
			</>
		);
	if (svg === null) return <p className="hint">Drawing…</p>;
	// biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid's strict mode sanitizes the SVG
	return (
		<div className="hiw-diagram" dangerouslySetInnerHTML={{ __html: svg }} />
	);
}

/** The board's Diagrams button: the project's docs/how-it-works.md as committed on its target,
 *  with each ```mermaid block drawn, plus a Create/update diagrams button that creates the
 *  task which writes that file. */
function HowItWorksModal({
	project,
	onClose,
	act,
	open,
}: {
	project: string;
	onClose: () => void;
	act: Act;
	open: (id: string) => void;
}) {
	const [result, setResult] = useState<
		{ text: string } | { missing: true } | { failed: true } | null
	>(null);
	useEffect(() => {
		let alive = true;
		fetch(`/api/projects/${encodeURIComponent(project)}/how-it-works`)
			.then(async (res) => {
				if (!alive) return;
				if (res.status === 404) return setResult({ missing: true });
				if (!res.ok) throw new Error(String(res.status));
				setResult({ text: await res.text() });
			})
			.catch(() => {
				if (alive) setResult({ failed: true });
			});
		return () => {
			alive = false;
		};
	}, [project]);
	return (
		<Modal
			open
			onClose={onClose}
			label="Project diagrams"
			className="hiw-modal"
		>
			<div className="wf-head">
				<h3>docs/how-it-works.md</h3>
				<span className="hiw-actions">
					<button
						type="button"
						className="ghost"
						onClick={() =>
							window.confirm(
								"Create/update diagrams? This creates a task that writes docs/how-it-works.md with Mermaid diagrams.",
							) &&
							act(async () => {
								const t = await post<TaskView>(
									`/api/projects/${encodeURIComponent(project)}/tasks`,
									{ prompt: EXPLAIN_PROJECT },
								);
								onClose();
								open(t.id);
							})
						}
						title="Create a task that writes docs/how-it-works.md with Mermaid diagrams of this project"
					>
						<Icon name="grid" />
						Create/update diagrams
					</button>
					<CloseButton />
				</span>
			</div>
			{result === null ? (
				<p className="hint">Loading…</p>
			) : "missing" in result ? (
				<p className="hint">
					The target branch has no docs/how-it-works.md yet. Use Create/update
					diagrams to create it.
				</p>
			) : "failed" in result ? (
				<p className="hint" role="alert">
					The file failed to load.
				</p>
			) : (
				<Markdown
					text={result.text}
					fence={(lang, code) =>
						lang === "mermaid" ? <MermaidDiagram code={code} /> : null
					}
				/>
			)}
		</Modal>
	);
}

/** The task diff in a lightbox: the whole diff for file=null, one file's section otherwise.
 *  Fetched live per open; done cards serve the text captured at merge. */
function DiffModal({
	task,
	files,
	onClose,
}: {
	task: TaskView;
	/** The files whose sections to show, or null for all files. */
	files: string[] | null;
	onClose: () => void;
}) {
	const [result, setResult] = useState<
		{ text: string } | { failed: true } | null
	>(null);
	useEffect(() => {
		let alive = true;
		setResult(null);
		fetch(
			`/api/projects/${encodeURIComponent(task.project)}/tasks/${task.id}/diff`,
		)
			.then(async (res) => {
				if (!alive) return;
				if (!res.ok) throw new Error(String(res.status));
				setResult({ text: await res.text() });
			})
			.catch(() => {
				if (alive) setResult({ failed: true });
			});
		return () => {
			alive = false;
		};
	}, [task.project, task.id]);
	const head =
		files === null
			? "All changed files"
			: files.length === 1
				? (files[0] ?? "")
				: `${files.length} files`;
	const section =
		result !== null && "text" in result
			? files === null
				? result.text
				: files
						.map((f) => diffFileSlice(result.text, f))
						.filter((s) => s !== null)
						.join("\n")
			: null;
	return (
		<Modal
			open
			onClose={onClose}
			label={files === null ? "Task diff" : `Diff of ${head}`}
			className="diff-view"
		>
			<div className="diff-head">
				<span className="diff-head-path">{head}</span>
				<CloseButton />
			</div>
			{result === null ? (
				<p className="hint diff-empty">Loading…</p>
			) : "failed" in result ? (
				<p className="hint diff-empty">Diff unavailable.</p>
			) : section === null ? (
				<p className="hint diff-empty">No diff for this file.</p>
			) : (
				<pre className="diff-code">
					{section
						.replace(/\n$/, "")
						.split("\n")
						.map((line, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: static split of fetched text; lines are positional
							<div key={i} className={`dl-${diffLineClass(line)}`}>
								{line === "" ? " " : line}
							</div>
						))}
				</pre>
			)}
		</Modal>
	);
}

/** Model state for the review and release dialogs: opening preselects the role model, closing drops the pick. */
function useReviewModel(
	open: boolean,
	catalog: ModelCatalog | null,
): {
	model: string;
	setModel: (m: string) => void;
	modelQuery: string;
	setModelQuery: (q: string) => void;
	roleModel: { role: string; model: string } | null;
} {
	const [model, setModel] = useState("");
	const [modelQuery, setModelQuery] = useState("");
	useEffect(() => {
		const rm = reviewModel(catalog);
		// Review dialogs preselect the role's own selector, level included
		// (e.g. the plan role's `:medium`); no forced max thinking.
		setModel(open ? (rm !== null ? rm.model : "") : "");
		if (!open) setModelQuery("");
	}, [open, catalog]);
	return {
		model,
		setModel,
		modelQuery,
		setModelQuery,
		roleModel: reviewModel(catalog),
	};
}

/** The shared model picker behind New task and Follow up: a trigger button opening a searchable popover. */
function ModelField({
	catalog,
	model,
	setModel,
	modelQuery,
	setModelQuery,
}: {
	catalog: ModelCatalog | null;
	model: string;
	setModel: (m: string) => void;
	modelQuery: string;
	setModelQuery: (q: string) => void;
}) {
	// One picker per dialog instance; several New task dialogs (one per project) stay mounted at once.
	const popId = useId();
	const allModels = catalog?.models ?? [];
	// model is a joined omp selector "provider/model:level"; "" level means omp default.
	const [base, level] = splitLevel(model);
	const models = allModels.filter((m) => modelMatches(m, modelQuery));
	const modelSearch = useRef<HTMLInputElement | null>(null);
	const trigger = useRef<HTMLButtonElement | null>(null);
	// Set when the trigger opened the popover with an arrow key: the toggle then lands the
	// focus on the first role row instead of the search box.
	const arrowOpen = useRef(false);
	// Native light-dismiss misses pointerdowns on the dialog backdrop / inert page behind the
	// popover (both sit in the top layer), so some engines never close on "click somewhere else".
	const [modelOpen, setModelOpen] = useState(false);
	useEffect(() => {
		if (!modelOpen) return;
		const pop = document.getElementById(popId);
		if (pop === null) return;
		const onDown = (e: PointerEvent): void => {
			if (!(e.target instanceof Element) || pop.contains(e.target)) return;
			// The invoker's click is native toggle coordination; hiding here would make it reopen.
			const invoker = e.target.closest("button");
			if (invoker !== null && invoker.getAttribute("popovertarget") === popId)
				return;
			pop.hidePopover();
		};
		document.addEventListener("pointerdown", onDown);
		return () => document.removeEventListener("pointerdown", onDown);
	}, [modelOpen, popId]);
	const selectedModel = allModels.find((m) => m.selector === base);
	const modelLabel =
		base === ""
			? `Default${catalog?.defaultModel ? ` (${catalog.defaultModel})` : ""}`
			: selectedModel !== undefined
				? `${selectedModel.name} (${selectedModel.id})`
				: base;
	const quota = useQuota();
	// The budget of the model that would actually run: the pick, else the catalog default.
	const limits = forModel(
		quota?.limits ?? [],
		base || catalog?.defaultModel || null,
	);
	// The chip's color tracks the window that runs out first.
	const worst = tightest(limits);
	const pickModel = (selector: string): void => {
		setModel(selector);
		document.getElementById(popId)?.hidePopover();
	};
	// Arrow keys walk the role/catalog rows from wherever the focus sits inside the open
	// popover; Escape closes and hands the focus back to the trigger.
	const popKeys = (e: React.KeyboardEvent<HTMLElement>): void => {
		if (e.key === "Escape") {
			// Cancel the native light dismiss: its deferred focus fixup would override the
			// trigger focus below and drop the focus on the page behind the dialog.
			e.preventDefault();
			document.getElementById(popId)?.hidePopover();
			trigger.current?.focus();
			return;
		}
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
		const opts = [
			...(document
				.getElementById(popId)
				?.querySelectorAll<HTMLElement>(".model-option") ?? []),
		];
		const idx = stepIndex(
			opts.length,
			opts.indexOf(document.activeElement as HTMLElement),
			e.key === "ArrowDown",
		);
		if (idx < 0) return;
		e.preventDefault();
		opts[idx]?.focus();
	};
	return (
		<>
			<div className="model-fields">
				<label className="field">
					<span className="field-head">
						Model
						{/* Each window paints itself: only the one under the threshold turns amber. */}
						{worst !== null && (
							<span
								className="model-quota"
								aria-hidden="true"
								title={limits
									.map(
										(l) =>
											`${l.label}: ${l.usedPct}% used${
												l.resetsAt === null
													? ""
													: `, resets in ${until(l.resetsAt)}`
											}`,
									)
									.join("; ")}
							>
								{limits.map((l, i) => (
									<Fragment key={l.window ?? l.label}>
										{i > 0 && " · "}
										<span data-level={loadLevel(l.usedPct)}>
											{`${l.window ?? l.label} ${Math.max(0, Math.round(100 - l.usedPct))}% left`}
										</span>
									</Fragment>
								))}
							</span>
						)}
					</span>
					<button
						type="button"
						className="model-trigger"
						popoverTarget={popId}
						ref={trigger}
						onKeyDown={(e) => {
							if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
							if (modelOpen) return;
							arrowOpen.current = true;
							document.getElementById(popId)?.showPopover();
						}}
					>
						<span>{modelLabel}</span>
						<Icon name="chevron-right" size={14} />
					</button>
				</label>
				<label className="field">
					<span className="field-head">Thinking</span>
					{/* Empty base = run on the omp default model; a manual level needs an explicit model anchor. */}
					<select
						aria-label="Thinking level"
						value={level}
						disabled={base === ""}
						title={base === "" ? "Pick a model first" : undefined}
						onChange={(e) => setModel(joinLevel(base, e.target.value))}
					>
						<option value="">Default</option>
						{THINKING_LEVELS.map((l) => (
							<option key={l} value={l}>
								{l}
							</option>
						))}
					</select>
				</label>
			</div>
			{/* Sibling, not child: label click-forwarding must not fight the popover's focus. */}
			<div
				id={popId}
				popover="auto"
				className="popover model-pop"
				onToggle={(e) => {
					setModelOpen(e.newState === "open");
					if (e.newState !== "open") return;
					if (arrowOpen.current) {
						document
							.getElementById(popId)
							?.querySelector<HTMLElement>(".model-option")
							?.focus();
					} else {
						modelSearch.current?.focus();
					}
					arrowOpen.current = false;
				}}
			>
				<input
					ref={modelSearch}
					type="search"
					className="search"
					placeholder="Search models"
					aria-label="Search models"
					value={modelQuery}
					onKeyDown={(e) => {
						// Enter in the search box must not submit a surrounding form (steer, New task).
						if (e.key === "Enter") e.preventDefault();
						popKeys(e);
					}}
					onChange={(e) => {
						// Search filters the list only; clearing the pick here would silently
						// send the default model if the user closes without re-picking.
						setModelQuery(e.target.value);
					}}
				/>
				{modelQuery !== "" && (
					<span
						className="filter-note"
						role="status"
						title="Matching of total models"
					>
						{models.length}/{allModels.length}
					</span>
				)}
				<div className="model-list">
					{modelRows(models, catalog?.roles ?? null, model, modelQuery).map(
						(r) => (
							<Fragment key={r.key}>
								{r.divider && <hr className="model-divider" />}
								<button
									type="button"
									className="model-option"
									aria-pressed={r.pressed}
									onClick={() => pickModel(r.selector)}
									onKeyDown={popKeys}
								>
									<span>{r.label}</span>
									{r.pressed && <Icon name="check" size={14} />}
								</button>
							</Fragment>
						),
					)}
				</div>
			</div>
		</>
	);
}

/** The shared compose dialog behind New task and Follow up: same hooks, draft reset and
    submit flow; callers pass the copy, the icon and a `send` that does the POST. */
function ComposeDialog({
	open,
	onClose,
	act,
	draftKey,
	label,
	heading,
	sub,
	inputLabel,
	placeholder,
	hint,
	icon,
	submitLabel,
	send,
	/** Show the model picker; the draft mask hides it because a draft runs no agent. */
	showModel,
}: {
	open: boolean;
	onClose: () => void;
	act: Act;
	/** Cache key of this dialog's draft; a failed send (server down) keeps the text across close and reload. */
	draftKey: string;
	/** The Modal's accessible name. */
	label: string;
	heading: string;
	sub: ReactNode;
	inputLabel: string;
	placeholder: string;
	hint: string;
	icon: React.ComponentProps<typeof Icon>["name"];
	submitLabel: string;
	/** Does the POST; once it resolves the cached draft is cleared and the dialog closes. */
	send: (args: {
		text: string;
		images: string[];
		model: string;
	}) => Promise<void>;
	showModel?: boolean;
}) {
	const [text, setText] = useState("");
	const [model, setModel] = useState("");
	const [modelQuery, setModelQuery] = useState("");
	const catalog = useModels();
	const images = useAttachedImages();
	const sendState = useBusy();
	/** Full-size URL of a pasted image shown in the lightbox; null while closed. */
	const [viewing, setViewing] = useState<string | null>(null);
	const [err, setErr] = useState<string | null>(null);
	// Closing via X, Cancel or Esc drops the in-memory copy; the on-device draft cache keeps the
	// text for the next open, so a failed send (server down, offline) is never lost. A successful
	// send clears the cache, so an added task cannot read as a stuck dialog.
	useEffect(() => {
		if (open) return;
		setText("");
		setModel("");
		setModelQuery("");
		setViewing(null);
		images.clear();
		setErr(null);
	}, [open, images.clear]);
	// Opening restores the cached draft. Images are not cached: pasted base64 can exceed quota.
	useEffect(() => {
		if (!open) return;
		const saved = loadComposeDraft(draftKey);
		if (saved !== null) {
			setText(saved.text);
			setModel(saved.model);
		}
	}, [open, draftKey]);
	// Keystrokes and model picks mirror into the cache.
	const editText = (t: string): void => {
		setText(t);
		if (open) saveComposeDraft(draftKey, { text: t, model });
	};
	const editModel = (m: string): void => {
		setModel(m);
		if (open) saveComposeDraft(draftKey, { text, model: m });
	};
	const submit = (): void => {
		if (text.trim().length === 0) return;
		sendState.start(() =>
			act(
				async () => {
					await send({
						text,
						images: images.images.map((i) => i.data),
						model,
					});
					clearComposeDraft(draftKey);
					setText("");
					setModel("");
					images.clear();
					onClose();
				},
				(message) =>
					setErr(
						`Not added: ${message} The draft is kept on this device — try again once the server is back.`,
					),
			),
		);
	};
	return (
		<>
			<Modal open={open} onClose={onClose} label={label} className="dialog">
				<form
					className="dialog-body"
					onSubmit={(e) => {
						e.preventDefault();
						submit();
					}}
				>
					<div className="dialog-head">
						<h2>
							{heading}
							<span className="dialog-sub">{sub}</span>
						</h2>
						<CloseButton />
					</div>
					<PromptInput
						label={inputLabel}
						value={text}
						rows={4}
						autoFocus
						placeholder={placeholder}
						onChange={editText}
						onEnter={submit}
						images={images}
						onView={(i) => setViewing(images.images[i]?.url ?? null)}
					/>
					{showModel !== false && (
						<ModelField
							catalog={catalog}
							model={model}
							setModel={editModel}
							modelQuery={modelQuery}
							setModelQuery={setModelQuery}
						/>
					)}
					<p className="hint">{hint}</p>
					{err !== null && (
						<p className="auth-error" role="alert">
							{err}
						</p>
					)}
					<div className="dialog-actions">
						<ImageBrowseButton onAdd={images.addFiles} />
						<button
							type="button"
							onClick={(e) => e.currentTarget.closest("dialog")?.close()}
						>
							Cancel
						</button>
						<button
							type="submit"
							className={"primary" + (sendState.failed ? " failed" : "")}
							disabled={sendState.busy || text.trim().length === 0}
							aria-busy={sendState.busy || undefined}
						>
							{sendState.busy && (
								<span className="spinner" aria-hidden="true" />
							)}
							<Icon name={icon} />
							{submitLabel}
						</button>
					</div>
				</form>
			</Modal>
			{/* Sibling, not child: a nested dialog's close event would propagate to the compose dialog and close both. */}
			<Modal
				open={viewing !== null}
				onClose={() => setViewing(null)}
				label="Attached image"
				className="lightbox"
			>
				{viewing !== null && <img src={viewing} alt="Attachment, full size" />}
			</Modal>
		</>
	);
}

/** One per project and always mounted, so open/close just toggles the native dialog. Drafts drop on close. */
function NewTaskDialog({
	project,
	open,
	onClose,
	act,
}: {
	project: ProjectView;
	open: boolean;
	onClose: () => void;
	act: Act;
}) {
	const label = projectLabel(project);
	return (
		<ComposeDialog
			open={open}
			onClose={onClose}
			act={act}
			draftKey={`new:${project.name}`}
			label={`New task for ${label}`}
			heading="New task"
			sub={<ProjectSub project={project} />}
			inputLabel="What should the agent do?"
			placeholder="Describe the task in plain language"
			hint="Enter adds the task. Shift+Enter starts a new line. Images: paste, drop or browse."
			icon="plus"
			submitLabel="Add task"
			send={async ({ text, images, model }) => {
				await post(`/api/projects/${encodeURIComponent(project.name)}/tasks`, {
					prompt: text,
					images,
					model: model || undefined,
				});
			}}
		/>
	);
}

/** Draft mask: parks an idea in the backlog without a model pick — a draft runs no agent. */
function BacklogDialog({
	project,
	open,
	onClose,
	act,
}: {
	project: ProjectView;
	open: boolean;
	onClose: () => void;
	act: Act;
}) {
	const label = projectLabel(project);
	return (
		<ComposeDialog
			open={open}
			onClose={onClose}
			act={act}
			draftKey={`backlog:${project.name}`}
			showModel={false}
			label={`Add draft for ${label}`}
			heading="Add draft"
			sub={<ProjectSub project={project} />}
			inputLabel="What is the idea?"
			placeholder="Describe the idea in plain language"
			hint="Enter parks the draft in the backlog. Shift+Enter starts a new line. Images: paste, drop or browse. No model pick: a draft runs no agent."
			icon="plus"
			submitLabel="Add draft"
			send={async ({ text, images }) => {
				await post(`/api/projects/${encodeURIComponent(project.name)}/tasks`, {
					prompt: text,
					images,
					backlog: true,
				});
			}}
		/>
	);
}

/** Model pick at action time for a parked card: grill it or promote it to todo. */
function BacklogModelDialog({
	project,
	taskTitle,
	taskId,
	currentModel,
	mode,
	open,
	onClose,
	act,
}: {
	project: string;
	taskTitle: string;
	taskId: string;
	currentModel: string | null;
	mode: "grill" | "todo";
	open: boolean;
	onClose: () => void;
	act: Act;
}) {
	const [model, setModel] = useState("");
	const [modelQuery, setModelQuery] = useState("");
	const [err, setErr] = useState<string | null>(null);
	const catalog = useModels();
	const send = useBusy();
	useEffect(() => {
		if (open) {
			setModel(currentModel ?? "");
		} else {
			setModel("");
			setModelQuery("");
			setErr(null);
		}
	}, [open, currentModel]);
	return (
		<Modal
			open={open}
			onClose={onClose}
			label={mode === "grill" ? "Grill with the agent" : "Move to todo"}
			className="dialog"
		>
			<div className="dialog-body">
				<div className="dialog-head">
					<h2>
						{mode === "grill" ? "Grill with the agent" : "Move to todo"}
						<span className="dialog-sub">{taskTitle}</span>
					</h2>
					<CloseButton />
				</div>
				<ModelField
					catalog={catalog}
					model={model}
					setModel={setModel}
					modelQuery={modelQuery}
					setModelQuery={setModelQuery}
				/>
				<p className="hint">
					A model pick lands on the card. Leave it empty to use the project's
					role model.
				</p>
				{err !== null && (
					<p className="auth-error" role="alert">
						{err}
					</p>
				)}
				<div className="dialog-actions">
					<button
						type="button"
						onClick={(e) => e.currentTarget.closest("dialog")?.close()}
					>
						Cancel
					</button>
					<button
						type="button"
						className={"primary" + (send.failed ? " failed" : "")}
						disabled={send.busy}
						aria-busy={send.busy || undefined}
						onClick={() =>
							send.start(() =>
								act(async () => {
									if (mode === "grill") {
										await post(
											`/api/projects/${encodeURIComponent(project)}/tasks/${taskId}/grill`,
											{ model: model || undefined },
										);
									} else {
										await post(
											`/api/projects/${encodeURIComponent(project)}/tasks/${taskId}/backlog`,
											{ to: "todo", model: model || undefined },
										);
									}
									onClose();
								}, setErr),
							)
						}
					>
						{send.busy && <span className="spinner" aria-hidden="true" />}
						<Icon name={mode === "grill" ? "send" : "plus"} />
						{mode === "grill" ? "Grill" : "Move to todo"}
					</button>
				</div>
			</div>
		</Modal>
	);
}

/**
 * Follow-up on a done task: opens from the done drawer's Follow up button; creates a fresh
 * task that continues in its drawer.
 */
function FollowUpDialog({
	task,
	open,
	onClose,
	act,
	onFollowed,
}: {
	task: TaskView;
	open: boolean;
	onClose: () => void;
	act: Act;
	onFollowed: (id: string, from: string) => void;
}) {
	return (
		<ComposeDialog
			open={open}
			onClose={onClose}
			act={act}
			draftKey={`followup:${task.id}`}
			label={`Follow up on ${task.sessionTitle ?? task.title}`}
			heading="Follow up"
			sub={task.sessionTitle ?? task.title}
			inputLabel="What should the agent do next?"
			placeholder="Describe the follow-up task…"
			hint="Enter sends the follow-up. Shift+Enter starts a new line. Images: paste, drop or browse."
			icon="send"
			submitLabel="Follow up"
			send={async ({ text, images, model }) => {
				const next = await post<TaskView>(
					`/api/projects/${encodeURIComponent(task.project)}/tasks/${task.id}/follow-up`,
					{ text, images, model: model || undefined },
				);
				onFollowed(next.id, task.id); // close the drawer; the board flies the new card out of this one
			}}
		/>
	);
}

const EMPTY_STAGE: Record<Stage, string> = {
	todo: "Nothing waiting.",
	in_progress: "No agent at work.",
	merging: "Nothing merging.",
	done: "Nothing landed yet.",
	backlog: "No ideas parked.",
};

/** "Create release" preview: what accumulated on the target since the last tag, and the Start button. Refetches on every open. */
function ReleaseDialog({
	project,
	open,
	onClose,
	act,
}: {
	project: ProjectView;
	open: boolean;
	onClose: () => void;
	act: Act;
}) {
	const [plan, setPlan] = useState<ReleasePlan | null>(null);
	const [version, setVersion] = useState("");
	const [loading, setLoading] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const catalog = useModels();
	const { model, setModel, modelQuery, setModelQuery, roleModel } =
		useReviewModel(open, catalog);
	const send = useBusy();
	const label = projectLabel(project);
	const first = plan !== null && plan.from === null;
	const short = plan?.sha.slice(0, 7) ?? "";
	const versionOk = VERSION_RE.test(version);
	useEffect(() => {
		if (!open) return;
		setPlan(null);
		setLoadError(null);
		setErr(null);
		setLoading(true);
		// unwrap: a non-JSON 200 must surface as a load error, not an empty dialog.
		fetch(`/api/projects/${encodeURIComponent(project.name)}/release`)
			.then((r) => unwrap<ReleasePlan>(r))
			.then((data) => {
				setPlan(data);
				setVersion(data.version);
			})
			.catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
			.finally(() => setLoading(false));
	}, [open, project.name]);
	const start = (): void => {
		if (plan === null || plan.blocked !== null || !versionOk) return;
		send.start(() =>
			act(async () => {
				await post<TaskView>(
					`/api/projects/${encodeURIComponent(project.name)}/release`,
					{
						sha: plan.sha,
						version: version !== plan.version ? version : undefined,
						model: model || undefined,
					},
				);
				onClose(); // the release card arrives through polling
			}, setErr),
		);
	};
	return (
		<Modal
			open={open}
			onClose={onClose}
			label={`Create release for ${label}`}
			className="dialog"
		>
			<div className="dialog-body">
				<div className="dialog-head">
					<h2>
						Create release<span className="dialog-sub">{label}</span>
					</h2>
					<CloseButton />
				</div>
				{loading && (
					<p className="hint" role="status">
						<span className="spinner" aria-hidden="true" />
						Reading the target…
					</p>
				)}
				{loadError !== null && (
					<p className="advisory">
						<Icon name="info" size={14} />
						{loadError}
					</p>
				)}
				{plan !== null && (
					<>
						<p className="release-line">
							<strong>
								{first ? "First release:" : `${plan.from} →`}
								<input
									className="version-input"
									value={version}
									onChange={(e) => setVersion(e.target.value)}
									spellCheck={false}
									aria-label="Release version"
								/>
							</strong>
							<span>
								{first
									? `${plan.commits} commits up to ${short}`
									: `${plan.commits} commits since ${plan.from} up to ${short}`}
							</span>
						</p>
						{plan.tasks.length > 0 && (
							<ul className="release-tasks" aria-label="Tasks in this release">
								{plan.tasks.map((t) => (
									<li key={t.id} title={`Task ${t.id}`}>
										{t.title}
									</li>
								))}
							</ul>
						)}
						<div className="release-notes">
							<Markdown text={plan.notes} />
						</div>
						{plan.blocked !== null ? (
							<p className="advisory">
								<Icon name="info" size={14} />
								{plan.blocked}
							</p>
						) : (
							<p className="hint">
								An agent reviews these commits and runs the full verification,
								including mutation tests. If nothing blocks,{" "}
								{project.settings.releaseCommand !== null ? (
									<>
										Ottr runs the project's release command for {plan.version}{" "}
										at {short} and then checks the tag with git.
									</>
								) : (
									<>
										Ottr tags {short} as {plan.version} and{" "}
										{project.github !== null
											? "creates the GitHub release"
											: "pushes the tag"}
										.
									</>
								)}
							</p>
						)}
						<ModelField
							catalog={catalog}
							model={model}
							setModel={setModel}
							modelQuery={modelQuery}
							setModelQuery={setModelQuery}
						/>
						<p className="model-notice" role="note">
							{roleModel !== null
								? `The release review runs with the ${roleModel.role} role's model (${roleModel.model}).`
								: "No plan or slow model is assigned in ~/.omp/agent/config.yml — the release review runs on the default model."}
						</p>
					</>
				)}
				{err !== null && (
					<p className="auth-error" role="alert">
						{err}
					</p>
				)}
				<div className="dialog-actions">
					<button
						type="button"
						onClick={(e) => e.currentTarget.closest("dialog")?.close()}
					>
						Cancel
					</button>
					<button
						type="button"
						className={`primary${send.failed ? " failed" : ""}`}
						disabled={
							plan === null || plan.blocked !== null || !versionOk || send.busy
						}
						aria-busy={send.busy || undefined}
						title={
							versionOk ? undefined : "Version must match vX.Y.Z (e.g. v1.2.3)"
						}
						onClick={start}
					>
						{send.busy && <span className="spinner" aria-hidden="true" />}
						<Icon name="tag" />
						Start release
					</button>
				</div>
			</div>
		</Modal>
	);
}

/**
 * Model choice before an architecture review starts: opened by the board's Start review button.
 * Preselects the plan (or slow) role's model; the picker stays open for overrides.
 */
function ArchReviewDialog({
	project,
	open,
	onClose,
	act,
}: {
	project: ProjectView;
	open: boolean;
	onClose: () => void;
	act: Act;
}) {
	const catalog = useModels();
	const { model, setModel, modelQuery, setModelQuery, roleModel } =
		useReviewModel(open, catalog);
	const send = useBusy();
	const [err, setErr] = useState<string | null>(null);
	const submit = (): void => {
		send.start(() =>
			act(async () => {
				// The card arrives through polling.
				await post(
					`/api/projects/${encodeURIComponent(project.name)}/arch-review`,
					{ model: model || undefined },
				);
				onClose();
			}, setErr),
		);
	};
	useEffect(() => {
		if (open) return;
		setErr(null);
	}, [open]);
	return (
		<Modal
			open={open}
			onClose={onClose}
			label={`Review for ${projectLabel(project)}`}
			className="dialog"
		>
			<form
				className="dialog-body"
				onSubmit={(e) => {
					e.preventDefault();
					submit();
				}}
			>
				<div className="dialog-head">
					<h2>
						Start review
						<span className="dialog-sub">{projectLabel(project)}</span>
					</h2>
					<CloseButton />
				</div>
				<ModelField
					catalog={catalog}
					model={model}
					setModel={setModel}
					modelQuery={modelQuery}
					setModelQuery={setModelQuery}
				/>
				<p className="model-notice" role="note">
					{roleModel !== null
						? `Runs with the ${roleModel.role} role's model (${roleModel.model}).`
						: "No plan or slow model is assigned in ~/.omp/agent/config.yml — a review judges the whole repo, so consider a stronger model."}
				</p>
				{err !== null && (
					<p className="auth-error" role="alert">
						{err}
					</p>
				)}
				<div className="dialog-actions">
					<button
						type="button"
						onClick={(e) => e.currentTarget.closest("dialog")?.close()}
					>
						Cancel
					</button>
					<button
						type="submit"
						className={"primary" + (send.failed ? " failed" : "")}
						disabled={send.busy}
						aria-busy={send.busy || undefined}
					>
						{send.busy && <span className="spinner" aria-hidden="true" />}
						<Icon name="play" />
						Start review
					</button>
				</div>
			</form>
		</Modal>
	);
}

/** Prompt behind the Diagrams window's "Create/update diagrams" button. */
const EXPLAIN_PROJECT =
	"Explain how this project works: load the explain-project skill and follow it. Write docs/how-it-works.md with Mermaid diagrams (architecture, the main use case, and the life cycle if the project has one). Map every node to its source path. If docs/how-it-works.md already exists, update it to match the code. Commit the file.";

/** Done lane page size: the cards shown before "Show more", and the step each click adds. */
const DONE_PAGE = 20;

/** Done order: latest landing first. doneAt stamps each entry into Done (the done clock);
 * a cancelled card orders by its cancel time. */
const newestLanded = (a: TaskCard, b: TaskCard): number =>
	(b.cancelledAt ?? b.doneAt ?? b.updatedAt) -
	(a.cancelledAt ?? a.doneAt ?? a.updatedAt);

/** The done lane's topic view: every topic, each cut to its newest page. `limits` holds the
 * page size of each topic its "Show more" grew; other topics show DONE_PAGE cards. */
export function doneTopicPages(
	tasks: TaskCard[],
	limits: ReadonlyMap<string, number>,
): { key: string; label: string; tasks: TaskCard[]; hidden: number }[] {
	return groupTopics(tasks).map((g) => {
		// groupTopics can append unclassified cards after overflow topics, so each topic
		// re-sorts by landing time before its newest page is cut.
		const page = donePage(
			[...g.tasks].sort(newestLanded),
			() => false,
			limits.get(g.key) ?? DONE_PAGE,
		);
		return { ...g, tasks: page.shown, hidden: page.hidden };
	});
}

/** Section key of the done lane's cancelled section (topic view). No real topic key starts
 * with "__" (keys are lowercased topic text), so a topic can never share this section's
 * collapse or page state. */
export const CANCELLED_KEY = "__cancelled";

/** The done lane's cancelled section (topic view): every cancelled card, newest cancel
 * first, paged like a topic under its own "Show more". Cancelled cards stay out of the
 * topic groups, so no topic count includes them. Empty while nothing is cancelled. */
export function cancelledTopic(
	tasks: TaskCard[],
	limits: ReadonlyMap<string, number>,
): { key: string; label: string; tasks: TaskCard[]; hidden: number }[] {
	const cancelled = tasks
		.filter((t) => t.cancelledAt !== null)
		.sort(newestLanded);
	if (cancelled.length === 0) return [];
	const page = donePage(
		cancelled,
		() => false,
		limits.get(CANCELLED_KEY) ?? DONE_PAGE,
	);
	return [
		{
			key: CANCELLED_KEY,
			label: "Cancelled",
			tasks: page.shown,
			hidden: page.hidden,
		},
	];
}

/** One project's flow: identity and New task, advisories, the queue, then the four stage columns. */
function ProjectBoard({
	project,
	tasks,
	deltas,
	open,
	seenAnswers,
	compose,
	composeDraft,
	act,
	onNotice,
	draining,
}: {
	project: ProjectView;
	tasks: TaskCard[];
	deltas: Map<string, number>;
	open: (id: string) => void;
	seenAnswers: Set<string>;
	compose: () => void;
	composeDraft: () => void;
	act: Act;
	onNotice: (message: string) => void;
	/** True while an update holds new turns (POST /api/drain): queued cards wait for the restart. */
	draining: boolean;
}) {
	const [showRelease, setShowRelease] = useState(false);
	const [showReview, setShowReview] = useState(false);
	const [showDiagrams, setShowDiagrams] = useState(false);
	const [query, setQuery] = useState("");
	// Mobile stage tabs: which column the single-column tier shows; the desktop grid ignores it.
	const [stage, setStage] = useState<Stage>("todo");
	// Horizontal swipe on the board flips to the neighbor column; touch start point.
	const touchStart = useRef<{ x: number; y: number } | null>(null);
	const swipeStage = (dir: number) => {
		const next = Math.max(
			0,
			Math.min(STAGE_KEYS.length - 1, STAGE_KEYS.indexOf(stage) + dir),
		);
		setStage(STAGE_KEYS[next] ?? stage);
	};
	// Collapsed topic sections in the done lane, by group key; unknown keys default expanded.
	const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
	// Done lane layout: flat newest-done-first list (default) or topic sections.
	const [grouped, setGrouped] = useState(false);
	// Done lane lazy load: how many read cards render before "Show more" appends a page.
	// The topic view pages each topic on its own, keyed by topic.
	const [doneLimit, setDoneLimit] = useState(DONE_PAGE);
	// A Map, not a plain object: a topic named "constructor" must not read Object.prototype.
	const [topicLimits, setTopicLimits] = useState<ReadonlyMap<string, number>>(
		() => new Map(),
	);
	// The setup wizard, opened from the checklist's Open setup button.
	const [setupOpen, setSetupOpen] = useState(false);
	/** One settings patch from the checklist row buttons; the board's project state refreshes. */
	const saveCheck = (patchBody: Record<string, unknown>): Promise<boolean> =>
		act(async () => {
			await post(
				`/api/projects/${encodeURIComponent(project.name)}/settings`,
				patchBody,
			);
			refreshState();
		});
	const q = query.trim().toLowerCase();
	/** One project interview endpoint call; its verdict becomes a board notice. */
	const interview = (path: string, body: Record<string, unknown>) =>
		act(async () => {
			const r = await post<{ interview: string }>(
				`/api/projects/${encodeURIComponent(project.name)}${path}`,
				body,
			);
			onNotice(interviewMsg(r.interview));
		});
	// Search filter and per-stage counts (unit-tested in queue.ts): the tab strip and lane heads read them.
	const { shown, counts } = laneCounts(tasks, query, seenAnswers);
	const perStage = COLUMNS.map((c) => ({ ...c, ...counts[c.key] }));
	return (
		<section className="project" aria-labelledby="project-title">
			<header className="project-head">
				<div className="project-id">
					<ProjectLogo project={project} />
					<div className="project-id-text">
						<h1 id="project-title">{projectLabel(project)}</h1>
						<p className="project-meta">
							{project.latestRelease !== null &&
								(project.github !== null ? (
									<a
										href={`${project.github}/releases/tag/${project.latestRelease}`}
										target="_blank"
										rel="noopener noreferrer"
										title="Latest release"
									>
										<Icon name="tag" size={13} />
										{project.latestRelease}
									</a>
								) : (
									<span title="Latest release">
										<Icon name="tag" size={13} />
										{project.latestRelease}
									</span>
								))}
							{project.latestImage !== null && (
								<a
									href={project.latestImage.url}
									target="_blank"
									rel="noopener noreferrer"
									title={`Docker image ${project.latestImage.tag}`}
								>
									<Icon name="container" size={13} />
									{project.latestImage.tag}
								</a>
							)}
							{(project.archReview?.due || project.archReview?.running) && (
								<span
									className={
										project.archReview.running ? "arch-live" : "arch-due"
									}
									title={
										project.archReview.running
											? "A review is queued or running, or its findings are still open"
											: project.archReview.reviewed
												? `Commits on ${project.target} since the last review`
												: `No review of ${project.target} yet`
									}
								>
									{project.archReview.running
										? "Review in progress"
										: project.archReview.reviewed
											? `Review due (${project.archReview.delta} commits)`
											: "Un-reviewed — review due"}
								</span>
							)}
							{project.github !== null && (
								<a
									href={project.github}
									target="_blank"
									rel="noopener noreferrer"
									title="GitHub"
									aria-label="GitHub"
								>
									<GhMark />
								</a>
							)}
						</p>
					</div>
				</div>
				<div className="project-actions">
					<input
						type="search"
						className={q === "" ? "search" : "search filtered"}
						placeholder="Search tasks"
						aria-label="Search tasks"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
					/>
					{q !== "" && (
						<span
							className="filter-note"
							role="status"
							title="Matching of total tasks"
						>
							{shown.length}/{tasks.length}
						</span>
					)}
					<div className="seg">
						{project.hasRules && (
							<button
								type="button"
								className="ghost"
								aria-label="Align rules"
								onClick={() =>
									window.confirm(
										"Align rules? This creates a task that fixes AGENTS.md rules that contradict the tracker's pipeline.",
									) && interview("/interview", { fix: true })
								}
								title="Fix AGENTS.md rules that contradict the tracker's pipeline (release-after-commit and the like)"
							>
								<Icon name="refresh-cw" />
								<span className="seg-label">Align rules</span>
							</button>
						)}
						{project.archReview?.due || project.archReview?.running ? (
							<button
								type="button"
								className="arch-start"
								aria-label="Review"
								disabled={project.archReview.running}
								title={
									project.archReview.running
										? "A review is still open: one review at a time"
										: "Pick a model and create a task that reviews the whole repo, the same review a release runs"
								}
								onClick={() => setShowReview(true)}
							>
								<Icon name="eye" size={13} />
								<span className="seg-label">Review</span>
							</button>
						) : (
							project.archReview !== null &&
							project.archReview.delta > 0 && (
								<button
									type="button"
									className="arch-start quiet"
									aria-label="Review"
									title={`${project.archReview.delta} commits on ${project.target} since the last review — start one early, the same review a release runs`}
									onClick={() => setShowReview(true)}
								>
									<Icon name="eye" size={13} />
									<span className="seg-label">Review</span>
								</button>
							)
						)}
						{!project.gitless && (
							<button
								type="button"
								className="ghost"
								aria-label="Create release"
								// Same guard as Review: a release runs that review (releaseBlocked).
								disabled={project.archReview?.running}
								onClick={() => setShowRelease(true)}
								title={
									project.archReview?.running
										? "A release or review is still open: one at a time"
										: "Release everything new on the target"
								}
							>
								<Icon name="tag" />
								<span className="seg-label">Create release</span>
							</button>
						)}
						{!project.gitless && (
							<button
								type="button"
								className="ghost"
								aria-label="Diagrams"
								onClick={() => setShowDiagrams(true)}
								title="Show docs/how-it-works.md with its Mermaid diagrams, as committed on the target branch"
							>
								<Icon name="image" />
								<span className="seg-label">Diagrams</span>
							</button>
						)}
					</div>
					{!project.gitless && (
						<button
							type="button"
							className="primary"
							onClick={compose}
							title="New task (N)"
						>
							<Icon name="plus" />
							New task
							<kbd>N</kbd>
						</button>
					)}
				</div>
			</header>
			<ReleaseDialog
				project={project}
				open={showRelease}
				onClose={() => setShowRelease(false)}
				act={act}
			/>
			<ArchReviewDialog
				project={project}
				open={showReview}
				onClose={() => setShowReview(false)}
				act={act}
			/>
			{showDiagrams && (
				<HowItWorksModal
					project={project.name}
					onClose={() => setShowDiagrams(false)}
					act={act}
					open={open}
				/>
			)}
			{project.dirty && (
				<p className="advisory">
					<Icon name="info" size={14} />
					The main checkout has uncommitted changes. Your own pull or stash can
					collide with commits from tasks.
				</p>
			)}
			{!project.hasRules && (
				<p className="advisory">
					<Icon name="info" size={14} />
					No AGENTS.md yet, so tasks wait in Todo.
					<BusyButton run={() => interview("/interview", {})}>
						Start rules interview
					</BusyButton>
				</p>
			)}
			{project.gitless && (
				<p className="advisory">
					<Icon name="info" size={14} />
					Not a git repository yet, so every action waits.
					<BusyButton run={() => interview("/init", {})}>
						Init git repository
					</BusyButton>
				</p>
			)}
			{q !== "" && shown.length === 0 && (
				<p className="advisory">
					<Icon name="info" size={14} />
					No tasks match "{q}".
				</p>
			)}
			{project.settings.setupChecklist && (
				<SetupChecklist
					project={project}
					save={saveCheck}
					onOpenSetup={() => setSetupOpen(true)}
				/>
			)}
			{setupOpen && (
				<SetupWizardModal
					project={project}
					act={act}
					onNotice={onNotice}
					onClose={() => setSetupOpen(false)}
				/>
			)}
			{/* Mobile stage tabs: CSS shows this strip and hides the inactive columns only in
			    the single-column tier (container ≤440px); the desktop grid never sees either. */}
			<div className="stage-tabs" role="tablist" aria-label="Board stages">
				{perStage.map((c) => (
					<button
						key={c.key}
						type="button"
						role="tab"
						id={`stage-tab-${c.key}`}
						data-tab={c.key}
						aria-selected={stage === c.key}
						aria-controls={`stage-${c.key}`}
						tabIndex={stage === c.key ? 0 : -1}
						onClick={() => setStage(c.key)}
						onKeyDown={(e) => switchTab(e, STAGE_KEYS, setStage)}
					>
						{c.label}
						<span className={q === "" ? "count" : "count filtered"}>
							{q === "" ? c.shown : `${c.shown}/${c.total}`}
						</span>
						{c.fresh > 0 && (
							<span className="count fresh" title="Answered, not opened yet">
								{c.fresh} new
							</span>
						)}
						{c.alarm !== null && (
							<span
								role="img"
								className={
									"count needs" + (c.alarm === "asked" ? " asked" : "")
								}
								title={c.alarm === "asked" ? "Question asked" : "Needs action"}
								aria-label={
									c.waiting === 1
										? "1 task needs action"
										: `${c.waiting} tasks need action`
								}
							>
								<Mark kind={c.alarm} />
								{c.waiting}
							</span>
						)}
					</button>
				))}
			</div>
			<div
				className="flow"
				onTouchStart={(e) => {
					if (e.touches.length !== 1) return;
					const t = e.touches[0];
					if (!t) return;
					touchStart.current = { x: t.clientX, y: t.clientY };
				}}
				onTouchEnd={(e) => {
					const start = touchStart.current;
					touchStart.current = null;
					if (!start) return;
					const t = e.changedTouches[0];
					if (!t) return;
					const dx = t.clientX - start.x;
					const dy = t.clientY - start.y;
					// ponytail: fixed 50px threshold at touchend, no live slide-follow animation.
					if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy)) return;
					swipeStage(dx < 0 ? 1 : -1);
				}}
			>
				{COLUMNS.map((c) => {
					const count = counts[c.key];
					// A kicked backlog card (grill session started) renders as a normal card in the todo lane.
					const filtered = shown.filter((t) => laneStage(t) === c.key);
					// Done: latest landing on top. doneAt stamps each entry into Done (the done clock), so it orders by landing time.
					if (c.key === "done") filtered.sort(newestLanded);
					// Other columns: running/needs_you first, queued cards in queue priority (draggable order).
					const unread = (t: TaskCard): boolean => isUnread(t, seenAnswers);
					let col = c.key === "done" ? filtered : laneOrder(filtered);
					// Done lazy-loads: the newest page renders and "Show more" appends the next page;
					// a search shows every match. Unread answers always stay above the cut.
					// ponytail: the state payload still carries every card; paginate /api/state
					// instead if boards grow into the thousands of done cards.
					let doneHidden = 0;
					// Empty search only: the done lane groups into topic sections under sticky heads,
					// every topic loaded and each one paged by its own "Show more". Cancelled cards
					// stay out of every topic (no topic count includes one) and ride in their own
					// trailing "Cancelled" section, paged like a topic.
					const doneGroups =
						c.key === "done" && q === "" && grouped
							? [
									...doneTopicPages(
										col.filter(
											(t) => t.cancelledAt === null && !unread(t) && !t.starred,
										),
										topicLimits,
									),
									...cancelledTopic(col, topicLimits),
								]
							: null;
					if (c.key === "done" && q === "" && !grouped) {
						const page = donePage(
							col,
							(t) => unread(t) || (t.starred && t.cancelledAt === null),
							doneLimit,
						);
						col = page.shown;
						doneHidden = page.hidden;
					}
					const onReorder = (
						dragId: string,
						beforeId: string | null,
					): Promise<void> => {
						const order = reorderIds(tasks, c.key, dragId, beforeId);
						if (order === null) return Promise.resolve();
						return act(() =>
							post(`/api/projects/${encodeURIComponent(project.name)}/queue`, {
								order,
							}).then(() => undefined),
						).then(() => undefined);
					};
					return (
						<section
							key={c.key}
							className="stage"
							aria-labelledby={`stage-${c.key}`}
							data-stage={c.key}
							data-active={stage === c.key}
						>
							<h2 id={`stage-${c.key}`} className="stage-head">
								{c.label}
								{c.key === "done" && q === "" && (
									<span className="lane-tools">
										<button
											type="button"
											className="view-toggle"
											title={
												grouped
													? "Show one flat list, newest done first"
													: "Group done cards by topic"
											}
											onClick={() => setGrouped((g) => !g)}
										>
											{grouped ? "By time" : "By topic"}
										</button>
										{doneGroups !== null && (
											<>
												<button
													type="button"
													title="Collapse all"
													aria-label="Collapse all"
													onClick={() =>
														setCollapsed(
															Object.fromEntries(
																doneGroups.map((g) => [g.key, true]),
															),
														)
													}
												>
													<Icon name="chevrons-up" size={13} />
												</button>
												<button
													type="button"
													title="Expand all"
													aria-label="Expand all"
													onClick={() => setCollapsed({})}
												>
													<Icon name="chevrons-down" size={13} />
												</button>
											</>
										)}
									</span>
								)}
								{count.fresh > 0 && (
									<span
										className="count fresh"
										title="Answered, not opened yet"
									>
										{count.fresh} new
									</span>
								)}
								<span className={q === "" ? "count" : "count filtered"}>
									{q === "" && doneHidden === 0
										? col.length
										: `${col.length}/${count.total}`}
								</span>
							</h2>
							<LaneCol
								stage={c.key}
								tasks={col}
								more={c.key === "done" ? doneHidden : 0}
								onMore={() => setDoneLimit((n) => n + DONE_PAGE)}
								// Idle backlog cards park under the todo lane, below a divider; started ones
								// joined the lane's own list and the search filter already applied.
								parked={
									c.key === "todo"
										? shown.filter((t) => laneStage(t) === "backlog")
										: undefined
								}
								parkedTotal={
									c.key === "todo" ? counts.backlog.total : undefined
								}
								onAddDraft={c.key === "todo" ? composeDraft : undefined}
								projectTasks={tasks}
								groups={doneGroups}
								collapsed={collapsed}
								onToggle={(key) =>
									setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))
								}
								onTopicMore={(key) =>
									setTopicLimits((prev) =>
										new Map(prev).set(
											key,
											(prev.get(key) ?? DONE_PAGE) + DONE_PAGE,
										),
									)
								}
								onStar={
									c.key === "done"
										? (t) => {
												void act(async () => {
													await post(
														`/api/projects/${encodeURIComponent(project.name)}/tasks/${t.id}/star`,
														{ starred: !t.starred },
													);
												});
											}
										: undefined
								}
								hasRules={project.hasRules}
								github={project.github}
								deltas={deltas}
								open={open}
								unread={unread}
								onReorder={onReorder}
								filtering={q !== ""}
								draining={draining}
							/>
						</section>
					);
				})}
			</div>
			{/* Phone-only New task FAB: the 720px tier swaps the header New task button for
			    this, so the board's only primary action stays thumb-reachable while reading
			    Done cards (the header button scrolls far off screen there). */}
			{!project.gitless && (
				<button
					type="button"
					className="fab"
					aria-label="New task"
					onClick={compose}
				>
					<Icon name="plus" size={22} />
				</button>
			)}
		</section>
	);
}

/** Triage block (Option A): every waiting card across projects, oldest
 * wait first, then each project's warnings. A row opens what it names: the card through the same
 * openTask the alarm bell popover uses, a warning through the project's board hash. */
function Triage({
	projects,
	tasks,
	openTask,
}: {
	projects: ProjectView[];
	tasks: TaskCard[];
	openTask: (id: string) => void;
}) {
	const { needs, asks } = splitAlarms(tasks);
	// Rank first (P0 before P3, unrated last), then updatedAt is when the card
	// last changed, i.e. when it started waiting on you.
	const cards = [...needs, ...asks].sort(triageWait);
	const warns = projects.flatMap((p) =>
		[
			!p.hasRules && "No AGENTS.md, tasks wait",
			p.dirty && "Uncommitted changes",
			p.gitless && "No git repo",
		]
			.filter((w): w is string => w !== false)
			.map((text) => ({ project: p, text })),
	);
	return (
		<section aria-labelledby="triage-title">
			<div className="ov-head">
				<h2 className="ov-sec" id="triage-title">
					Needs you
				</h2>
				<span className="ov-count">
					{`${cards.length} ${cards.length === 1 ? "card" : "cards"} · ${warns.length} ${warns.length === 1 ? "warning" : "warnings"}`}
				</span>
			</div>
			<div className="ov-wrap triage">
				{cards.length === 0 && warns.length === 0 ? (
					<p className="tri-empty">Nothing needs you.</p>
				) : (
					<>
						{cards.map((t) => {
							const owner = projects.find((p) => p.name === t.project);
							return (
								<button
									key={t.id}
									type="button"
									className={t.asked === null ? "tri alarm" : "tri"}
									onClick={() => openTask(t.id)}
								>
									<Mark kind={cardMark(t)} />
									{owner !== undefined && <ProjectTag project={owner} />}
									<span className="t">{t.title}</span>
									<RankBadges task={t} />
									<span className="k">{t.id}</span>
									<span className="w">
										{duration(Date.now() - t.updatedAt)}
									</span>
								</button>
							);
						})}
						{cards.length > 0 && warns.length > 0 && (
							<div className="tri-sep" />
						)}
						{warns.map(({ project, text }) => (
							<a
								className="tri warn"
								key={`${project.name}:${text}`}
								href={`#${encodeURIComponent(project.name)}`}
							>
								<Mark kind="warn" />
								<ProjectTag project={project} />
								<span className="t">{text}</span>
								{/* Empty cell keeps the warning row on the card rows' grid. */}
								<span className="rank-badges" />
								<span className="k">{project.name}</span>
								<span className="w" />
							</a>
						))}
					</>
				)}
			</div>
		</section>
	);
}

/** Every project in one table (the plant overview); clicking a row opens that project.
 * Option A order: triage, fleet KPIs, live table, per-project table. */
function Overview({
	projects,
	tasks,
	compose,
	onAdd,
	openTask,
}: {
	projects: ProjectView[];
	tasks: TaskCard[];
	compose: (name: string) => void;
	onAdd: () => void;
	openTask: (id: string) => void;
}) {
	const [range, setRange] = useState<PerfRange>("all");
	const { perf, err, refreshing } = usePerf(range);
	if (projects.length === 0) {
		return (
			<section className="empty">
				<h1>No projects yet</h1>
				<p>
					Point at any directory. Ottr gives every task its own worktree and
					agent, then merges the finished work; a directory without a git repo
					gets an Init git repository action first.
				</p>
				<button type="button" className="primary" onClick={onAdd}>
					<Icon name="plus" />
					Add project
				</button>
			</section>
		);
	}
	return (
		<section className="overview" aria-labelledby="overview-title">
			<h1 id="overview-title">Overview</h1>
			<Triage projects={projects} tasks={tasks} openTask={openTask} />
			<Provisioning />
			<section aria-labelledby="perf-title" className="perf">
				<div className="ov-head">
					<h2 className="ov-sec" id="perf-title">
						Performance
					</h2>
					<div className="perf-range">
						{refreshing && <span className="spinner" aria-hidden="true" />}
						{PERF_RANGES.map((r) => (
							<button
								key={r}
								type="button"
								aria-pressed={range === r}
								onClick={() => setRange(r)}
							>
								{r === "all" ? "All" : r}
							</button>
						))}
					</div>
				</div>
				{err !== null && (
					<p className="perf-error" role="alert">
						<Mark kind="crit" />
						<span>Performance data unavailable: {err}</span>
					</p>
				)}
				{perf !== null ? (
					<KpiStrip fleet={perf.fleet} />
				) : (
					err === null && (
						<p className="loading" role="status">
							<span className="spinner" aria-hidden="true" />
							Loading performance…
						</p>
					)
				)}
			</section>
			<h2 className="ov-sec" id="live-title">
				Projects now
			</h2>
			<div className="ov-wrap">
				<table className="ov">
					<thead>
						<tr>
							<th scope="col">Project</th>
							<th scope="col">Action required</th>
							{COLUMNS.map((c) => (
								<th key={c.key} scope="col">
									{c.label}
								</th>
							))}
							<th scope="col">Last activity</th>
							<th scope="col">
								<span className="sr">New task</span>
							</th>
						</tr>
					</thead>
					<tbody>
						{projects.map((p) => {
							const own = tasks.filter((t) => t.project === p.name);
							const split = splitAlarms(own);
							const needs = split.needs.length;
							const asks = split.asks.length;
							const last = Math.max(0, ...own.map((t) => t.updatedAt));
							return (
								<tr
									key={p.name}
									onClick={() => (location.hash = encodeURIComponent(p.name))}
								>
									<th scope="row">
										<a href={`#${encodeURIComponent(p.name)}`}>
											<ProjectTag project={p} />
											{projectLabel(p)}
										</a>
										{(p.dirty || !p.hasRules || p.gitless) && (
											<span className="ov-note">
												{[
													!p.hasRules && "No AGENTS.md, tasks wait",
													p.dirty && "Uncommitted changes",
													p.gitless && "No git repo",
												]
													.filter(Boolean)
													.join(" · ")}
											</span>
										)}
									</th>
									<td>
										{needs > 0 && (
											<span className="needs-count">
												<Mark kind="needs" />
												{needs}
												<span className="sr"> need action</span>
											</span>
										)}
										{asks > 0 && (
											<span className="needs-count ask-n">
												<Mark kind="asked" />
												{asks}
												<span className="sr"> asked</span>
											</span>
										)}
									</td>
									{COLUMNS.map((c) => {
										const inStage = own.filter((t) => t.stage === c.key);
										const running = splitAlarms(inStage).running.length;
										return (
											<td
												key={c.key}
												className={inStage.length === 0 ? "zero" : undefined}
											>
												{running > 0 && (
													<>
														<Mark kind="running" />
														<span className="sr">{running} running of </span>
													</>
												)}
												{inStage.length}
											</td>
										);
									})}
									<td className="age">{last > 0 ? age(last) : "–"}</td>
									<td>
										<button
											type="button"
											className="icon"
											aria-label={`New task for ${projectLabel(p)}`}
											title="New task"
											onClick={(e) => {
												e.stopPropagation();
												compose(p.name);
											}}
										>
											<Icon name="plus" />
										</button>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
			{perf !== null && <PerfTable perf={perf} projects={projects} />}
		</section>
	);
}

/** One line for the Overview server row: alate's hint text, plus key and error alarms.
    kind is the alarm level: ok (nothing wrong), warn (not configured, no API key or server down),
    crit (a recorded provision failure). */
export function serverLine(s: ProvisioningResponse["server"]): {
	text: string;
	kind: "ok" | "warn" | "crit";
} {
	if (s === null)
		return { text: "Agent server: not configured.", kind: "warn" };
	let text = alateHint(s.health);
	let kind: "ok" | "warn" | "crit" = s.health.state === "down" ? "warn" : "ok";
	if (!s.keySet) {
		text += " · no API key";
		kind = "warn";
	}
	if (s.lastError !== null) {
		text += ` · last provision failed: ${s.lastError}`;
		kind = "crit";
	}
	return { text, kind };
}

/** The worker lists alate provisions, in column order. */
const PROV_LISTS = [
	{ key: "apt", label: "Packages" },
	{ key: "tools", label: "Tools" },
	{ key: "env", label: "Env" },
] as const;

/** Polls GET /api/provisioning every 60 s (the endpoint runs a live probe, so it must
 *  not ride the 1 s state push) and shows the alate server state and worker lists. */
function Provisioning() {
	const [data, setData] = useState<ProvisioningResponse | null>(null);
	const [err, setErr] = useState<string | null>(null);
	useEffect(() => {
		let alive = true;
		const load = () => {
			setErr(null); // a later successful load clears an earlier failure
			fetch("/api/provisioning")
				.then((res) => unwrap<ProvisioningResponse>(res))
				.then((r) => {
					if (alive) setData(r);
				})
				.catch((e) => {
					if (alive) setErr(e instanceof Error ? e.message : String(e));
				});
		};
		load();
		const t = setInterval(load, 60_000);
		return () => {
			alive = false;
			clearInterval(t);
		};
	}, []);
	return (
		<section className="prov" aria-labelledby="prov-title">
			<div className="prov-head">
				<h2 className="ov-sec" id="prov-title">
					Provisioning
				</h2>
				{data !== null && (
					<p className="prov-server">
						{data.server === null ? (
							<>
								<Mark kind="warn" />
								Agent server not configured.{" "}
								<button
									type="button"
									onClick={() => openSettingsSection("alate-section")}
								>
									Set it up
								</button>
							</>
						) : (
							(() => {
								const line = serverLine(data.server);
								return (
									<>
										{line.kind !== "ok" && (
											<Mark kind={line.kind === "crit" ? "crit" : "warn"} />
										)}
										{line.text}
									</>
								);
							})()
						)}
					</p>
				)}
			</div>
			{err !== null && (
				<p className="prov-error" role="alert">
					<Mark kind="crit" />
					<span>Provisioning data unavailable: {err}</span>
				</p>
			)}
			{data === null && err === null && (
				<p className="loading" role="status">
					<span className="spinner" aria-hidden="true" />
					Loading provisioning…
				</p>
			)}
			{data !== null && (
				// One row per project, one column per list alate provisions; a check marks a list.
				<div className="ov-wrap">
					<table className="ov prov-matrix">
						<thead>
							<tr>
								<th scope="col">Project</th>
								{PROV_LISTS.map((l) => (
									<th key={l.key} scope="col">
										{l.label}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{data.workers.length === 0 ? (
								<tr>
									<th
										scope="row"
										colSpan={PROV_LISTS.length + 1}
										className="prov-none"
									>
										No provisioned worker lists.
									</th>
								</tr>
							) : (
								data.workers.map((w) => (
									<tr key={w.name}>
										<th scope="row">
											{w.name === "_all" ? (
												<span className="prov-all">All projects</span>
											) : (
												w.name
											)}
										</th>
										{PROV_LISTS.map((l) => (
											<td key={l.key}>
												{w[l.key] ? (
													<span className="prov-yes">
														<Icon name="check" size={14} />
														<span className="sr">provisioned</span>
													</span>
												) : (
													<span className="prov-none">
														–<span className="sr">none</span>
													</span>
												)}
											</td>
										))}
									</tr>
								))
							)}
						</tbody>
					</table>
				</div>
			)}
		</section>
	);
}

/** One fetch per range change; WS frames re-render the page around it without refetching.
 * ponytail: no poll, no cache — the user picks a range, the numbers load once for it. */
function usePerf(range: PerfRange): {
	perf: PerfResponse | null;
	err: string | null;
	refreshing: boolean;
} {
	const [perf, setPerf] = useState<PerfResponse | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	useEffect(() => {
		let alive = true;
		setRefreshing(true);
		setErr(null); // a later successful load clears an earlier failure
		fetch(`/api/performance?range=${range}`)
			.then((res) => unwrap<PerfResponse>(res))
			.then((r) => {
				if (alive) setPerf(r);
			})
			.catch((e) => {
				if (alive) setErr(e instanceof Error ? e.message : String(e));
			})
			.finally(() => {
				if (alive) setRefreshing(false);
			});
		return () => {
			alive = false;
		};
	}, [range]);
	return { perf, err, refreshing };
}

/** Heading label for the per-project table, e.g. "Projects, last 7 days". */
const PERF_RANGE_LABELS: Record<PerfRange, string> = {
	"1h": "last hour",
	"24h": "last 24 hours",
	"7d": "last 7 days",
	"30d": "last 30 days",
	"90d": "last 90 days",
	all: "all time",
};

/** Null-safe value formatters; a metric without input renders "–". */
const pctFmt = (v: number | null) =>
	v === null ? "–" : `${Math.round(v * 100)}%`;
const usdFmt = (v: number | null) => (v === null ? "–" : `$${v.toFixed(2)}`);
const durFmt = (v: number | null) => (v === null ? "–" : duration(v));

/** The five fleet tiles: grey everywhere, an amber edge only on a
 * failure rate past the 0.10 alarm line. */
function KpiStrip({ fleet: f }: { fleet: PerfMetrics }) {
	const ptsFmt = (v: number) => `${Math.round(v * 100)} pts`;
	return (
		<div className="kpis">
			<Kpi
				label="Throughput"
				stat={f.throughput}
				text={f.throughput.value === null ? "–" : String(f.throughput.value)}
				sub="done"
				dFmt={String}
				pFmt={String}
			/>
			<Kpi
				label="Lead time, median"
				stat={f.leadMedianMs}
				text={durFmt(f.leadMedianMs.value)}
				sub={`p90 ${durFmt(f.leadP90Ms.value)}`}
				dFmt={duration}
				pFmt={duration}
			/>
			<Kpi
				label="First-pass rate"
				stat={f.firstPass}
				text={pctFmt(f.firstPass.value)}
				sub={`${f.firstPassDone} of ${f.done}`}
				dFmt={ptsFmt}
				pFmt={pctFmt}
			/>
			<Kpi
				label="Failure rate"
				stat={f.failure}
				text={pctFmt(f.failure.value)}
				sub={`${f.failedTurns} of ${f.turns} turns`}
				dFmt={ptsFmt}
				pFmt={pctFmt}
				alarm={(f.failure.value ?? 0) > 0.1}
			/>
			<Kpi
				label="Spend"
				stat={f.spend}
				text={usdFmt(f.spend.value)}
				sub={f.costMissing > 0 ? `${f.costMissing} turns no data` : null}
				dFmt={usdFmt}
				pFmt={usdFmt}
			/>
		</div>
	);
}

/** One KPI tile: value with sub-line, delta against the previous window (hidden in range all,
 * where prev is null), and a decorative sparkline. The text carries every number; the arrow
 * shape carries the delta direction, never colour. */
function Kpi({
	label,
	stat,
	text,
	sub,
	dFmt,
	pFmt,
	alarm = false,
}: {
	label: string;
	stat: PerfStat;
	text: string;
	sub: string | null;
	dFmt: (abs: number) => string;
	pFmt: (n: number) => string;
	alarm?: boolean;
}) {
	const { value, prev } = stat;
	const d = value !== null && prev !== null ? value - prev : null;
	return (
		<div className={alarm ? "kpi alarm" : "kpi"}>
			<span className="l">
				{alarm && <Mark kind="needs" />}
				{label}
			</span>
			<span className="v">
				{text}
				{sub !== null && <small>{sub}</small>}
			</span>
			{d !== null && prev !== null && (
				<span className="d">
					{d !== 0 && (
						<svg className="d-arw" viewBox="0 0 10 10" aria-hidden="true">
							<path d={d > 0 ? "M5 1.5 9 7H1z" : "M5 8.5 1 3h8z"} />
						</svg>
					)}
					{`${d > 0 ? "+" : d < 0 ? "-" : ""}${dFmt(Math.abs(d))} vs ${pFmt(prev)}`}
				</span>
			)}
			<Spark series={stat.series} />
		</div>
	);
}

/** The tile's trend, aria-hidden: the tile text carries the numbers. Null buckets leave a gap;
 * one bucket (or none at all) renders the baseline only. */
function Spark({ series }: { series: (number | null)[] }) {
	const n = series.length;
	const vals = series.filter((v): v is number => v !== null);
	if (vals.length === 0) {
		return (
			<svg
				className="sp"
				viewBox="0 0 100 32"
				preserveAspectRatio="none"
				aria-hidden="true"
			>
				<line className="base" x1="0" x2="100" y1="31" y2="31" />
			</svg>
		);
	}
	const lo = Math.min(...vals);
	const r = Math.max(...vals) - lo || 1;
	// Bucket order is the time axis, so a null bucket shifts x and shows as a gap, not a bridge.
	const x = (i: number) => (n > 1 ? (i / (n - 1)) * 100 : 50);
	const y = (v: number) => 29 - ((v - lo) / r) * 26;
	const runs: string[] = [];
	let run: string[] = [];
	let last: [number, number] | null = null;
	series.forEach((v, i) => {
		if (v === null) {
			if (run.length > 0) runs.push(run.join(" "));
			run = [];
			return;
		}
		run.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
		last = [x(i), y(v)];
	});
	if (run.length > 0) runs.push(run.join(" "));
	return (
		<svg
			className="sp"
			viewBox="0 0 100 32"
			preserveAspectRatio="none"
			aria-hidden="true"
		>
			<line className="base" x1="0" x2="100" y1="31" y2="31" />
			{runs.map((points) => (
				<polyline key={points} points={points} />
			))}
			{last !== null && (
				<circle className="last" cx={last[0]} cy={last[1]} r="1.6" />
			)}
		</svg>
	);
}

/** Per-project performance for the selected range: one row per project, each cell a value plus a
 * grey inline bar scaled to the column max; a failure rate past 0.10 turns that bar amber. */
function PerfTable({
	perf,
	projects,
}: {
	perf: PerfResponse;
	projects: ProjectView[];
}) {
	const viewOf = (name: string) => projects.find((p) => p.name === name);
	const labelOf = (name: string) => viewOf(name)?.settings.displayName ?? name;
	const rows = perf.projects;
	// Column max for the bar scaling; a silent column scales by 1 so its bars stay empty.
	const maxOf = (get: (m: PerfMetrics) => number | null) =>
		Math.max(...rows.map((r) => get(r) ?? 0), 0) || 1;
	return (
		<section aria-labelledby="perf-projects-title" className="perf">
			<h2 className="ov-sec" id="perf-projects-title">
				Projects, {PERF_RANGE_LABELS[perf.range]}
			</h2>
			<div className="ov-wrap">
				<table className="ov">
					<thead>
						<tr>
							<th scope="col">Project</th>
							<th scope="col">Throughput</th>
							<th scope="col">Lead time (median / p90)</th>
							<th scope="col">First-pass</th>
							<th scope="col">Failure rate</th>
							<th scope="col">Spend</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((p) => {
							const alarm = (p.failure.value ?? 0) > 0.1;
							const view = viewOf(p.name);
							return (
								<tr key={p.name}>
									<th scope="row">
										<span className="p">
											{view !== undefined && <ProjectTag project={view} />}
											{labelOf(p.name)}
										</span>
									</th>
									<td>
										<CellBar
											text={p.throughput.value ?? "–"}
											ratio={
												(p.throughput.value ?? 0) /
												maxOf((m) => m.throughput.value)
											}
										/>
									</td>
									<td>
										<CellBar
											text={
												<>
													{durFmt(p.leadMedianMs.value)}
													<span className="sub">
														/ {durFmt(p.leadP90Ms.value)}
													</span>
												</>
											}
											ratio={
												(p.leadMedianMs.value ?? 0) /
												maxOf((m) => m.leadMedianMs.value)
											}
										/>
									</td>
									<td>
										<CellBar
											text={pctFmt(p.firstPass.value)}
											ratio={
												(p.firstPass.value ?? 0) /
												maxOf((m) => m.firstPass.value)
											}
										/>
									</td>
									<td>
										{alarm && <Mark kind="needs" />}
										<CellBar
											text={pctFmt(p.failure.value)}
											ratio={
												(p.failure.value ?? 0) / maxOf((m) => m.failure.value)
											}
											alarm={alarm}
										/>
									</td>
									<td>
										<CellBar
											text={usdFmt(p.spend.value)}
											ratio={(p.spend.value ?? 0) / maxOf((m) => m.spend.value)}
										/>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
		</section>
	);
}

/** A value and its decorative inline bar; the fill width rides the --v custom property and is
 * hidden from assistive tech, the value text is not. */
function CellBar({
	text,
	ratio,
	alarm = false,
}: {
	text: ReactNode;
	ratio: number;
	alarm?: boolean;
}) {
	return (
		<span className={alarm ? "cell-bar alarm" : "cell-bar"}>
			{/* The span groups value + sub-line as one flex item beside the bar track. */}
			<span>{text}</span>
			<i
				aria-hidden="true"
				style={{ "--v": `${Math.round(ratio * 100)}%` } as CSSProperties}
			/>
		</span>
	);
}

/**
 * One stage column; every card renders and the column scrolls when they overflow.
 * The browser owns the scroll position: no page state to clamp when the list shrinks,
 * and keyboard focus into an off-screen card scrolls it into view for free.
 */
export function LaneCol({
	stage,
	tasks,
	projectTasks,
	groups,
	collapsed,
	onToggle,
	hasRules,
	github,
	deltas,
	open,
	unread,
	onReorder,
	filtering,
	draining,
	parked,
	parkedTotal,
	onAddDraft,
	more = 0,
	onMore,
	onTopicMore,
	onStar,
}: {
	stage: Stage;
	tasks: TaskCard[];
	/** Todo lane only: idle backlog cards below the divider (started ones render in the lane's own list); the queue DnD never touches them. */
	parked?: TaskCard[];
	/** All parked (idle) backlog cards, ignoring the filter: the label count next to the Backlog label. */
	parkedTotal?: number;
	/** Todo lane only: opens the draft mask from the backlog row's Add draft button. */
	onAddDraft?: () => void;
	/** Done lane only: cards hidden behind the "Show more" button; 0 renders no button. */
	more?: number;
	onMore?: () => void;
	/** Every lane's cards: a dependency hold must find a dependency that sits in another lane. */
	projectTasks: TaskCard[];
	/** Done lane only: topic sections to render instead of the flat landing order;
	 * `hidden` counts the topic's cards behind its own "Show more" button. */
	groups:
		| { key: string; label: string; tasks: TaskCard[]; hidden: number }[]
		| null;
	onTopicMore?: (key: string) => void;
	/** Done lane only: toggles a done research card's star; the socket frame refreshes the card. */
	onStar?: (t: TaskCard) => void;
	collapsed: Record<string, boolean>;
	onToggle: (key: string) => void;
	hasRules: boolean;
	github: string | null;
	deltas: Map<string, number>;
	open: (id: string) => void;
	unread: (t: TaskCard) => boolean;
	onReorder: (dragId: string, beforeId: string | null) => Promise<void>;
	filtering: boolean;
	/** True while an update holds new turns (POST /api/drain): queued cards wait for the restart. */
	draining: boolean;
}) {
	const boxRef = useRef<HTMLDivElement | null>(null);
	const uid = useId();
	const [dragId, setDragId] = useState<string | null>(null);
	// undefined = old place/no slot, null = end, string = insert before that card.
	const [drop, setDrop] = useState<string | null | undefined>(undefined);
	// A reorder request in flight: the slot stays at the drop point with a spinner, the source
	// card dims, and every reorder path (drag, drop, keyboard) is blocked until it settles.
	const [pending, setPending] = useState<{
		id: string;
		before: string | null;
	} | null>(null);
	// Card tops inside this list's scrolled content at the last render, in DOM order.
	const tops = useRef(new Map<string, number>());
	// Cards slide into their new place when this column's order changes (a drop, a card leaving or
	// landing above). It runs after every render, so the last committed layout is the FLIP origin.
	useLayoutEffect(() => {
		const box = boxRef.current;
		const next = new Map<string, number>();
		const els = new Map<string, HTMLElement>();
		if (box !== null) {
			const origin = box.getBoundingClientRect().top - box.scrollTop;
			for (const el of box.querySelectorAll<HTMLElement>(
				".card[data-task-id]",
			)) {
				const id = el.dataset.taskId as string;
				next.set(id, el.getBoundingClientRect().top - origin);
				els.set(id, el);
			}
		}
		const slides = listSlides(tops.current, next);
		tops.current = next;
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		// The card that travels farthest, the dropped one, passes over the neighbours it crosses.
		let lead = "";
		let far = 0;
		for (const [id, dy] of slides) {
			if (Math.abs(dy) > far) {
				far = Math.abs(dy);
				lead = id;
			}
		}
		for (const [id, dy] of slides) {
			const el = els.get(id);
			if (el === undefined) continue;
			if (id === lead) el.style.zIndex = "3";
			const reset = (): void => {
				if (id === lead) el.style.zIndex = "";
			};
			el.animate(
				[{ transform: `translateY(${dy}px)` }, { transform: "none" }],
				{ duration: 220, easing: "cubic-bezier(0.2, 0.7, 0.3, 1)" }, // --ease; WAAPI options don't resolve var()
			).finished.then(reset, reset);
		}
	});
	const hasTasks = tasks.length > 0 || (parked?.length ?? 0) > 0;
	const showBacklogRow = parked != null;
	// "Show more" moves focus to the first card it reveals: the button may unmount on the last page,
	// and focus must not fall to <body> (WCAG 2.4.3). The index counts the cards above the button.
	const moreFocus = useRef<{ scope: HTMLElement; index: number } | null>(null);
	useEffect(() => {
		const f = moreFocus.current;
		if (f === null) return;
		moreFocus.current = null;
		f.scope.querySelectorAll<HTMLElement>(".card-open")[f.index]?.focus();
	});

	if (!hasTasks && !showBacklogRow)
		return (
			<p className="stage-empty">
				{filtering ? "No matches." : EMPTY_STAGE[stage]}
			</p>
		);

	// --- Queue drag & drop (native HTML5) -------------------------------------
	// Only queued cards drag; only queued cards and the area below them are drop
	// targets, so a queued card can never land above a running/needs_you card.
	const queued = tasks.filter((t) => t.state === "queued");
	const dnd = queued.length >= 2;
	const clear = (): void => {
		setDragId(null);
		setDrop(undefined);
	};
	// One reorder at a time: a second request would be computed from the pre-reorder order and
	// overwrite the first on the server (last write wins). Every reorder path routes through here.
	const sendReorder = (id: string, before: string | null): void => {
		setPending({ id, before });
		void onReorder(id, before).finally(() => setPending(null));
	};
	const busy = pending !== null;
	// The in-flight drop slot: dashed placeholder with a spinner, standing where the card will land.
	const slot = busy ? (
		<div key="reorder-slot" className="drop-slot" role="status">
			<span className="spinner" aria-hidden="true" />
			reordering…
		</div>
	) : null;
	// ponytail: read live card midpoints during drag; cache only if columns reach hundreds of cards.
	const dropAt = (y: number): string | null | undefined => {
		const box = boxRef.current;
		if (box === null || dragId === null) return undefined;
		const cards = Array.from(
			box.querySelectorAll<HTMLElement>(
				'.card[draggable="true"][data-task-id]',
			),
			(el) => {
				const rect = el.getBoundingClientRect();
				return {
					id: el.dataset.taskId as string,
					middle: (rect.top + rect.bottom) / 2,
				};
			},
		);
		return dropBeforeId(cards, dragId, y);
	};
	const showMore = (e: ReactMouseEvent<HTMLButtonElement>, go: () => void) => {
		const btn = e.currentTarget;
		const scope = btn.parentElement as HTMLElement;
		const index = Array.from(scope.querySelectorAll(".card-open")).filter(
			(el) =>
				btn.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING,
		).length;
		moreFocus.current = { scope, index };
		go();
	};
	const card = (t: TaskCard): ReactNode => (
		<Card
			key={t.id}
			task={t}
			hasRules={hasRules}
			github={github}
			delta={deltas.get(t.id)}
			hold={holdFor(t, projectTasks)}
			drain={draining}
			fuOf={t.followUpOf}
			onOpen={() => open(t.id)}
			unread={unread(t)}
			onStar={onStar ? () => onStar(t) : undefined}
			locked={pending?.id === t.id}
			drag={
				dnd && !busy && t.state === "queued"
					? {
							draggable: true,
							dragging: dragId === t.id,
							dropBefore: drop === t.id,
							onDragStart: (e) => {
								// Firefox refuses to start a drag with an empty dataTransfer.
								e.dataTransfer.setData("text/plain", t.id);
								e.dataTransfer.effectAllowed = "move";
								// The end slot previews the dragged card's own height.
								boxRef.current?.style.setProperty(
									"--drag-h",
									`${e.currentTarget.offsetHeight}px`,
								);
								// Hollow the card only after the browser has captured it as the drag image.
								requestAnimationFrame(() => setDragId(t.id));
							},
							onDragEnd: clear,
						}
					: undefined
			}
		/>
	);
	// Done lane: unseen answers pin above a divider; read cards keep landing order (stable
	// partition). A cancelled card never pins: its answer is final.
	const fresh =
		stage === "done"
			? tasks.filter((t) => t.cancelledAt === null && unread(t))
			: [];
	// Done lane: starred research cards get their own collapsible section; unread wins over
	// starred. A cancelled card never lands here: it pages in the main list (flat view) or
	// the trailing "Cancelled" section (topic view).
	const starred =
		stage === "done"
			? tasks.filter((t) => t.cancelledAt === null && t.starred && !unread(t))
			: [];
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: HTML5 drag-and-drop target for queued cards; keyboard users act through the card buttons
		<div
			className={`stage-cards${drop === null ? " drop-end" : ""}`}
			ref={boxRef}
			aria-busy={busy || undefined}
			onDragOver={
				dnd && dragId !== null
					? (e) => {
							if (
								(e.target as Element).closest('.card:not([draggable="true"])')
							) {
								setDrop(undefined);
								return;
							}
							e.preventDefault();
							e.dataTransfer.dropEffect = "move";
							setDrop(dropAt(e.clientY));
						}
					: undefined
			}
			onDrop={
				dnd && dragId !== null
					? (e) => {
							if (
								(e.target as Element).closest('.card:not([draggable="true"])')
							)
								return;
							e.preventDefault();
							const before = dropAt(e.clientY);
							if (before === undefined) {
								clear();
								return;
							}
							// Clearing here, not in onDragEnd: setPending re-renders before the browser
							// dispatches dragend, which detaches the drag prop and its handler, so a
							// stale drop would repaint the placeholder after the order confirms.
							clear();
							sendReorder(dragId, before);
						}
					: undefined
			}
			onDragLeave={
				dnd
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
			// Keyboard reorder: Alt+Arrow moves the focused queued card within its column's queued block.
			onKeyDown={
				dnd && !busy
					? (e) => {
							if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown"))
								return;
							const el = (e.target as HTMLElement).closest<HTMLElement>(
								".card[data-task-id]",
							);
							if (el === null) return;
							const id = el.dataset.taskId;
							if (id === undefined) return;
							const idx = queued.findIndex((t) => t.id === id);
							if (idx < 0) return;
							if (e.key === "ArrowUp" && idx > 0) {
								sendReorder(id, queued[idx - 1]!.id);
								e.preventDefault();
							} else if (e.key === "ArrowDown" && idx < queued.length - 1) {
								sendReorder(
									id,
									idx + 2 < queued.length ? queued[idx + 2]!.id : null,
								);
								e.preventDefault();
							}
						}
					: undefined
			}
		>
			{!hasTasks && (
				<p className="stage-empty">
					{filtering ? "No matches." : EMPTY_STAGE[stage]}
				</p>
			)}
			{fresh.length > 0 && <p className="lane-label">Unread</p>}
			{fresh.map(card)}
			{fresh.length > 0 && fresh.length + starred.length < tasks.length && (
				<hr className="lane-divider" />
			)}
			{starred.length > 0 && (
				<section
					className="topic"
					data-collapsed={collapsed.starred === true || undefined}
				>
					<button
						type="button"
						className="topic-head"
						aria-expanded={collapsed.starred !== true}
						aria-controls={`${uid}-topic-starred`}
						onClick={() => onToggle("starred")}
					>
						<svg className="chev" viewBox="0 0 8 8" aria-hidden="true">
							<path d="M2 3l2 2 2-2" />
						</svg>
						<span className="lane-label">Starred</span>
						<span className="topic-count">{starred.length}</span>
					</button>
					<div className="topic-body" id={`${uid}-topic-starred`}>
						<div className="topic-cards">{starred.map(card)}</div>
					</div>
				</section>
			)}
			{starred.length > 0 && fresh.length + starred.length < tasks.length && (
				<hr className="lane-divider" />
			)}
			{groups !== null
				? groups.map((g) => {
						const bodyId = `${uid}-topic-${g.key}`;
						const isCollapsed = collapsed[g.key] === true;
						return (
							<section
								key={g.key}
								className="topic"
								data-collapsed={isCollapsed || undefined}
							>
								<button
									type="button"
									className="topic-head"
									aria-expanded={!isCollapsed}
									aria-controls={bodyId}
									onClick={() => onToggle(g.key)}
								>
									<svg className="chev" viewBox="0 0 8 8" aria-hidden="true">
										<path d="M2 3l2 2 2-2" />
									</svg>
									<span className="lane-label">{g.label}</span>
									<span className="topic-count">
										{`${g.tasks.length}/${g.tasks.length + g.hidden}`}
									</span>
								</button>
								<div className="topic-body" id={bodyId}>
									<div className="topic-cards">
										{g.tasks.map(card)}
										{g.hidden > 0 && onTopicMore && (
											<button
												type="button"
												className="lane-more"
												onClick={(e) => showMore(e, () => onTopicMore(g.key))}
												title={`Show older ${g.label} cards`}
												aria-label={`Show more, ${g.hidden} older ${g.label} cards`}
											>
												Show more
												<span className="topic-count">{g.hidden}</span>
											</button>
										)}
									</div>
								</div>
							</section>
						);
					})
				: tasks
						.filter((t) => t.cancelledAt !== null || (!unread(t) && !t.starred))
						.flatMap((t) => [
							// The spinner slot stands in for the card while its reorder request is in flight.
							pending?.before === t.id ? slot : null,
							card(t),
						])}
			{more > 0 && onMore && (
				<button
					type="button"
					className="lane-more"
					onClick={(e) => showMore(e, onMore)}
					title="Show older done cards"
					aria-label={`Show more, ${more} older cards`}
				>
					Show more
					<span className="topic-count">{more}</span>
				</button>
			)}
			{parked != null && (
				<>
					<hr className="lane-divider" />
					<p className="lane-label backlog-head">
						Backlog
						{parkedTotal !== undefined && (
							<span className="topic-count">{parkedTotal}</span>
						)}
						{onAddDraft && (
							<button
								type="button"
								className="lane-add"
								onClick={onAddDraft}
								title="Park an idea in the backlog (B)"
							>
								<Icon name="plus" size={12} />
								Add draft
							</button>
						)}
					</p>
				</>
			)}
			{parked?.map(card)}
			{groups === null && pending?.before === null && slot}
		</div>
	);
}

interface SessionContext {
	promptTokens: number;
	model: string | null;
	compactions: number;
	at: number;
}

function fmtTokens(n: number): string {
	return n >= 1e6
		? `${(n / 1e6).toFixed(1)}M`
		: n >= 1000
			? `${(n / 1000).toFixed(1)}K`
			: String(n);
}

/** Session context usage for a task; polled every 5 s while the drawer is open, null when unknown or failing. */
function useSessionContext(
	project: string,
	taskId: string,
	reloadKey: string,
): SessionContext | null {
	const [ctx, setCtx] = useState<SessionContext | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is a refetch trigger, not a body input
	useEffect(() => {
		let alive = true;
		const url = `/api/projects/${encodeURIComponent(project)}/tasks/${taskId}/context`;
		const load = async (): Promise<void> => {
			try {
				const res = await fetch(url);
				if (!alive) return;
				if (!res.ok) throw new Error(String(res.status));
				const v = (await res.json()) as { context: SessionContext | null };
				if (alive) setCtx(v.context);
			} catch {
				if (alive) setCtx(null);
			}
		};
		void load();
		const timer = setInterval(() => void load(), 5000);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, [project, taskId, reloadKey]);
	return ctx;
}

function LogView({
	project,
	taskId,
}: {
	project: ProjectView;
	taskId: string;
}) {
	const [text, setText] = useState("");
	const offset = useRef(0);
	const stick = useRef(true);
	const pre = useRef<HTMLPreElement | null>(null);
	useEffect(() => {
		let alive = true;
		let fetching = false;
		let dirty = false; // a trigger during a fetch marks this; exactly one more fetch runs after
		const decoder = new TextDecoder();
		const tick = async (): Promise<void> => {
			if (fetching) {
				dirty = true;
				return;
			}
			fetching = true;
			try {
				// Fetch again while behind: one call returns at most 256 KiB, so a long log would otherwise stop after the first chunk.
				while (alive) {
					const res = await fetch(
						`/api/projects/${encodeURIComponent(project.name)}/tasks/${taskId}/log?from=${offset.current}`,
					);
					if (!res.ok || !alive) return;
					const buf = await res.arrayBuffer();
					if (!alive || buf.byteLength === 0) return;
					offset.current += buf.byteLength; // only bytes actually received
					const chunk = decoder.decode(buf, { stream: true });
					if (chunk.length > 0) setText((prev) => prev + chunk);
					if (offset.current >= Number(res.headers.get("X-Log-Size"))) return;
				}
			} catch {
				// transient network error; the next live event retries
			} finally {
				fetching = false;
				if (dirty && alive) {
					dirty = false;
					void tick();
				}
			}
		};
		void tick();
		const relevant = (e: Event): boolean => {
			if (e.type === "open") return true; // a reconnect may have missed log pushes: resync
			const d = (e as CustomEvent<{ project: string; id: string }>).detail;
			return d.project === project.name && d.id === taskId;
		};
		const onLive = (e: Event): void => {
			if (relevant(e)) void tick();
		};
		liveEvents.addEventListener("log", onLive);
		liveEvents.addEventListener("open", onLive);
		return () => {
			alive = false;
			liveEvents.removeEventListener("log", onLive);
			liveEvents.removeEventListener("open", onLive);
		};
		// decoder lives inside the effect so its streaming state survives across coalesced ticks
	}, [project.name, taskId]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: re-run pins the log to the bottom on new text
	useEffect(() => {
		const el = pre.current;
		if (el && stick.current) el.scrollTop = el.scrollHeight;
	}, [text]);

	return (
		<pre
			ref={pre}
			className="log"
			onScroll={() => {
				const el = pre.current;
				if (el)
					stick.current =
						el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
			}}
		>
			{text.length > 0 ? text : "(no log output yet)"}
		</pre>
	);
}

/** Roving-tabindex tabs: ArrowLeft/Right/Home/End move selection and focus.
    Buttons carry data-tab with their key; `tabs` is the tablist's key order. */
function switchTab<T extends string>(
	e: React.KeyboardEvent<HTMLButtonElement>,
	tabs: readonly T[],
	set: (t: T) => void,
): void {
	const at = tabs.indexOf(e.currentTarget.dataset.tab as T);
	const step = {
		ArrowLeft: -1,
		ArrowRight: 1,
		Home: -Infinity,
		End: Infinity,
	}[e.key];
	if (at < 0 || step === undefined) return;
	e.preventDefault();
	const next =
		step === -Infinity
			? tabs[0]
			: step === Infinity
				? tabs[tabs.length - 1]
				: tabs[(at + step + tabs.length) % tabs.length];
	if (next === undefined) return;
	set(next);
	e.currentTarget
		.closest("[role=tablist]")
		?.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)
		?.focus();
}

/** Rows the panel shows: a young release (no qualified target yet, G21) hides unless
 * "ignore 7-day rule" is on; removed rows are notifications, not updates, so they always show. */
export function visibleUpdateRows(
	rows: UpdateRow[],
	showYoung: boolean,
): UpdateRow[] {
	return showYoung
		? rows
		: rows.filter((r) => r.target !== null || r.removed === true);
}

/** Update ids an open card already carries (U6): a done card covers nothing, and a cancelled
 * card covers nothing — its row stays pending for the user. The updates panel and the inbox
 * entry read the same map, so a row can never be actionable in one and covered in the other. */
export function coveredUpdateIds(tasks: TaskCard[]): Map<string, TaskCard> {
	const covered = new Map<string, TaskCard>();
	for (const t of tasks) {
		if (t.cancelledAt !== null || t.stage === "done") continue;
		for (const id of t.updateIds) covered.set(id, t);
	}
	return covered;
}

/** Upstream updates from the Alate provider (U5): rows grouped by repo, optional Skip per row.
 * The WS state frame owns the data; the panel only fires a refresh and skip POSTs. */
function UpdatesPanel({
	updates,
	tasks,
	act,
	openTask,
	onClose,
}: {
	updates: UpdatesView | null;
	tasks: TaskCard[];
	act: (fn: () => Promise<void>) => Promise<boolean>;
	openTask: (id: string) => void;
	onClose: () => void;
}) {
	// One refresh per open, fire-and-forget: the WS frame re-renders the panel when the pull lands.
	// act surfaces a failed pull as the app error banner; no local state needed. act is stable.
	useEffect(() => {
		void act(() => post("/api/updates/refresh", {}));
	}, [act]);
	// U6: a row an open (non-done, non-cancelled) update card already carries is not actionable here.
	const covered = coveredUpdateIds(tasks);
	const [selected, setSelected] = useState<Set<string>>(() => new Set());
	// G21: a young release (no qualified target) hides until "ignore 7-day rule" is ticked.
	const [showYoung, setShowYoung] = useState(false);
	const all = updates?.rows ?? [];
	const rows = visibleUpdateRows(all, showYoung);
	const actionableIds = rows
		.filter(
			(r) =>
				r.project !== null && r.managedBy === undefined && !covered.has(r.id),
		)
		.map((r) => r.id);
	const allSelected =
		actionableIds.length > 0 && actionableIds.every((id) => selected.has(id));
	const toggleAll = (): void =>
		setSelected(allSelected ? new Set() : new Set(actionableIds));
	const withTarget = rows.filter(
		(r) => selected.has(r.id) && r.target !== null,
	);
	const noTarget = rows.filter((r) => selected.has(r.id) && r.target === null);
	const allow = useBusy();
	const toggle = (id: string): void =>
		setSelected((s) => {
			const next = new Set(s);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	return (
		<Modal
			open
			onClose={onClose}
			label="Upstream updates"
			className="dialog updates"
		>
			<div className="updates-head">
				<div className="dialog-head">
					<h2>
						Upstream updates
						{updates !== null && (
							<span className="dialog-sub">
								checked {age(Date.parse(updates.checkedAt))}
							</span>
						)}
					</h2>
					<CloseButton />
				</div>
				<div className="updates-actions">
					{selected.size > 0 && (
						<span className="updates-count" role="status">
							{selected.size} selected
						</span>
					)}
					<button
						type="button"
						className="primary"
						disabled={allow.busy || withTarget.length === 0}
						onClick={() => {
							// The WS state frame re-renders the panel, so the whole selection clears on success.
							void allow.start(() =>
								act(async () => {
									await post("/api/updates/allow", {
										ids: withTarget.map((r) => r.id),
										propose: false,
									});
									setSelected(new Set());
								}),
							);
						}}
					>
						Allow
					</button>
					<button
						type="button"
						disabled={allow.busy || noTarget.length === 0}
						onClick={() => {
							void allow.start(() =>
								act(async () => {
									await post("/api/updates/allow", {
										ids: noTarget.map((r) => r.id),
										propose: true,
									});
									setSelected(new Set());
								}),
							);
						}}
					>
						Propose now
					</button>
				</div>
				{all.length > 0 && (
					<label
						className="updates-all"
						title="Also show releases younger than 7 days (Propose now until they qualify)"
					>
						<input
							type="checkbox"
							checked={showYoung}
							onChange={() => {
								const next = !showYoung;
								setShowYoung(next);
								// Hiding the young rows drops them from the selection.
								if (!next)
									setSelected((s) => {
										const gone = new Set(
											rows
												.filter((r) => r.target === null && r.removed !== true)
												.map((r) => r.id),
										);
										return new Set([...s].filter((id) => !gone.has(id)));
									});
							}}
							aria-label="Show updates that ignore the 7 day rule"
						/>
						ignore 7-day rule
					</label>
				)}
				{actionableIds.length > 0 && (
					<label className="updates-all">
						<input
							type="checkbox"
							checked={allSelected}
							onChange={toggleAll}
							aria-label="Select all updates"
						/>
						select all
					</label>
				)}
			</div>
			<div className="updates-list">
				{updates === null ? (
					<p className="caption">
						No provider configured. Set the Alate url and key in Settings.
					</p>
				) : rows.length === 0 ? (
					<p className="caption">No upstream updates.</p>
				) : (
					[...Map.groupBy(rows, (r) => r.repo)].map(([repo, rows]) => (
						<section key={repo} className="updates-group">
							<h3>
								{repo}
								<span className="dialog-sub">
									{rows[0]?.project ?? "no board project"}
								</span>
							</h3>
							{rows.map((r) => (
								<UpdateRowLine
									key={r.id}
									row={r}
									act={act}
									card={covered.get(r.id) ?? null}
									selected={selected.has(r.id)}
									onToggle={() => toggle(r.id)}
									openTask={openTask}
								/>
							))}
						</section>
					))
				)}
			</div>
		</Modal>
	);
}

export function UpdateRowLine({
	row,
	act,
	card,
	selected,
	onToggle,
	openTask,
}: {
	row: UpdateRow;
	act: (fn: () => Promise<void>) => Promise<boolean>;
	/** Open update card already covering this row; null = actionable (U6). */
	card: TaskCard | null;
	selected: boolean;
	onToggle: () => void;
	openTask: (id: string) => void;
}) {
	// managedBy rows offer no actions (U5); removed rows are not selectable but
	// do offer Skip below (keep the local copy, hide the row).
	const actionable =
		row.project !== null &&
		row.managedBy === undefined &&
		row.removed !== true &&
		card === null;
	// Shared by normal and removed rows: /api/updates/skip takes any known id.
	const skipButton = (
		<button
			type="button"
			className="updates-skip ghost"
			onClick={() => {
				// The WS state frame removes the row; no local optimistic delete.
				void act(() => post("/api/updates/skip", { id: row.id }));
			}}
		>
			Skip
		</button>
	);
	// Explicit association: the input sits inside a fragment variable the
	// noLabelWithoutControl rule cannot see through.
	const pickId = `updates-pick-${row.id}`;
	const body = (
		<>
			{actionable ? (
				<input
					type="checkbox"
					id={pickId}
					className="updates-box"
					checked={selected}
					onChange={onToggle}
					aria-label={`Select ${row.name} for approval`}
				/>
			) : (
				<span className="updates-pick" />
			)}
			<span className="updates-name">
				{row.name} <span className="dialog-sub">{row.kind}</span>
			</span>
			<span className="updates-versions">
				<span className="updates-ver">
					<code>{row.current}</code>
					{row.removed !== true && (
						<>
							<span className="updates-arrow">→</span>
							<code>{row.target ?? row.latest}</code>
						</>
					)}
				</span>
				{row.target === null && row.removed !== true && (
					<span
						className="updates-qualifies"
						title={`Qualifies ${new Date(row.qualifiesAt).toLocaleString()}`}
					>
						qualifies {stamp(Date.parse(row.qualifiesAt))}
					</span>
				)}
			</span>
			{row.removed === true ? (
				// One cell so the phone layout cannot stack text and Skip onto the same grid area.
				<span className="updates-removed">
					<span className="dialog-sub">Removed upstream</span>
					{card === null ? (
						<>
							<button
								type="button"
								className="updates-remove ghost"
								onClick={() => {
									// The filed card covers the row; the WS state frame then shows "in progress".
									void act(() => post("/api/updates/remove", { id: row.id }));
								}}
							>
								Remove
							</button>
							{skipButton}
						</>
					) : (
						<button
							type="button"
							className="updates-inprogress"
							title={card.sessionTitle}
							onClick={() => openTask(card.id)}
						>
							in progress
						</button>
					)}
				</span>
			) : row.managedBy !== undefined ? (
				<span className="dialog-sub">managed by {row.managedBy}</span>
			) : card !== null ? (
				// U6: an open card owns this row; clicking jumps to it instead of offering Skip.
				<button
					type="button"
					className="updates-inprogress"
					title={card.sessionTitle}
					onClick={() => openTask(card.id)}
				>
					in progress
				</button>
			) : (
				skipButton
			)}
			<span className="updates-links">
				<a href={row.notesUrl} target="_blank" rel="noopener noreferrer">
					notes
				</a>
				{" · "}
				<a href={row.origin} target="_blank" rel="noopener noreferrer">
					origin
				</a>
			</span>
			{row.diffs !== undefined && row.diffs.length > 0 && (
				// Spans, not ul/li: an actionable row is a <label>, which allows phrasing content only.
				<span className="updates-diffs">
					{row.diffs.map((d) => (
						<span key={d.file}>
							<a
								href={d.url}
								target="_blank"
								rel="noopener noreferrer"
								aria-label={`Diff of ${d.file}`}
							>
								diff
							</a>{" "}
							<code>{d.file}</code>
						</span>
					))}
				</span>
			)}
		</>
	);
	// A row label makes the whole line toggle the checkbox; its own buttons and
	// links stay interactive because a click on interactive content does not
	// activate the label.
	return actionable ? (
		<label htmlFor={pickId} className="updates-row actionable">
			{body}
		</label>
	) : (
		<div className="updates-row">{body}</div>
	);
}
function AddProjectModal({
	act,
	onClose,
	onAdded,
}: {
	act: Act;
	onClose: () => void;
	onAdded: (interview: string) => void;
}) {
	const [mode, setMode] = useState<"url" | "new">("url");
	const [url, setUrl] = useState("");
	const [name, setName] = useState("");
	const [ghRepo, setGhRepo] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const add = useBusy();
	// Git-URL flow: a client-side name mirror, the hosts view, the SSH key choice and
	// the token step the server demands on a 400 needsToken.
	const [nameTouched, setNameTouched] = useState(false);
	const [hosts, setHosts] = useState<GitHostsView | null>(null);
	const [sshMode, setSshMode] = useState<"global" | "new">("global");
	const [pendingKey, setPendingKey] = useState<PendingKeyInfo | null>(null);
	const [trusted, setTrusted] = useState<string[] | undefined>(undefined);
	const [tested, setTested] = useState<string | null>(null); // "url\0key" that passed
	const [addTrust, setAddTrust] = useState<TrustNeeded | null>(null);
	const [needsTokenHost, setNeedsTokenHost] = useState<string | null>(null);
	const [tokUser, setTokUser] = useState("oauth2");
	const [tokToken, setTokToken] = useState("");
	const repoName = name.trim();
	const trimmedUrl = url.trim();
	const ssh = isSshUrl(trimmedUrl);
	const sshKey = ssh
		? sshMode === "global"
			? "global"
			: `pending:${pendingKey?.id ?? ""}`
		: undefined;
	// gh facts for the New tab's hints: auth state, login, projects root, name check.
	const [gh, setGh] = useState<GhStatus | null>(null);
	const [free, setFree] = useState<boolean | null>(null);
	// One probe per dialog open; a failed probe leaves the hints out, the form still works.
	useEffect(() => {
		let alive = true;
		fetch("/api/gh-status")
			.then((res) => unwrap<GhStatus>(res))
			.then((s) => {
				if (alive) setGh(s);
			})
			.catch(() => {});
		fetch("/api/git-hosts")
			.then((res) => unwrap<GitHostsView>(res))
			.then((s) => {
				if (!alive) return;
				setHosts(s);
				// The server rejects "global" when no global key exists: start on a new key.
				if (s.globalKey === null) setSshMode("new");
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, []);
	// The name mirror: propose the URL's last path segment until the user edits it.
	const onUrl = (u: string): void => {
		setUrl(u);
		if (!nameTouched) {
			const seg = (
				u.trim().replace(/\/+$/, "").split(/[:/]/).pop() ?? ""
			).replace(/\.git$/, "");
			setName(seg);
		}
	};
	// The Add call: ssh URLs carry the key choice; the server answers with trust or token steps.
	const addProject = (trust?: string[]): void => {
		add.start(() =>
			act(async () => {
				const { status, data } = await gitReq("POST", "/api/projects", {
					url: trimmedUrl,
					name: repoName === "" ? undefined : repoName,
					sshKey,
					trust,
				});
				const t = asTrust(data);
				if (status < 300) {
					const r = data as unknown as AddProjectResponse; // unchecked cast: the server's documented answer shape
					onAdded(r.interview);
					setAdded({ project: r.project, interview: r.interview });
				} else if (t !== null) {
					setAddTrust(t);
					throw new Error(t.error);
				} else if (typeof data.needsToken === "string") {
					setNeedsTokenHost(data.needsToken);
					throw new Error(asError(data, status));
				} else {
					throw new Error(asError(data, status));
				}
			}, setErr),
		);
	};
	// A token save for the host the server named, then the retry of Add.
	const saveToken = (): void => {
		void act(async () => {
			const { status, data } = await gitReq("POST", "/api/git-hosts/tokens", {
				host: needsTokenHost ?? "",
				username: tokUser.trim() || "oauth2",
				token: tokToken,
				testUrl: trimmedUrl,
			});
			if (status !== 200) throw new Error(asError(data, status));
			setNeedsTokenHost(null);
			setTokToken("");
			addProject(trusted);
		}, setErr);
	};
	// The SSH pre-test: Add stays disabled until the current url+key pair passed it.
	const runSshTest = (trust?: string[]): Promise<TestAnswer> => {
		if (trust !== undefined) setTrusted(trust);
		return gitReq("POST", "/api/git-hosts/ssh/test", {
			url: trimmedUrl,
			key: sshKey,
			trust,
		}).then(({ status, data }) => {
			const t = asTrust(data);
			if (status === 200) return { ok: true } as const;
			if (t !== null) return t;
			return { error: asError(data, status) };
		});
	};
	const sshTested =
		ssh &&
		(sshKey === "global"
			? (hosts?.globalKey ?? null) !== null
			: pendingKey !== null) &&
		tested === `${trimmedUrl}\0${sshKey ?? ""}`;
	// Availability while typing: check 500ms after the last keystroke; a stale
	// in-flight answer is dropped, so the hint always names the current input.
	useEffect(() => {
		if (
			mode !== "new" ||
			!ghRepo ||
			gh?.authed !== true ||
			!/^[A-Za-z0-9_.-]+$/.test(repoName)
		) {
			setFree(null);
			return;
		}
		let alive = false;
		const t = setTimeout(() => {
			alive = true;
			fetch(`/api/gh-status?name=${encodeURIComponent(repoName)}`)
				.then((res) => unwrap<GhStatus>(res))
				.then((s) => {
					if (alive) setFree(s.free);
				})
				.catch(() => {});
		}, 500);
		return () => {
			alive = false;
			clearTimeout(t);
		};
	}, [mode, ghRepo, gh?.authed, repoName]);
	// The created project: once set, the dialog shows the setup wizard instead of the form.
	const [added, setAdded] = useState<{
		project: ProjectView;
		interview: string;
	} | null>(null);

	return (
		<Modal onClose={onClose} label="Add project" className="dialog">
			<div className="dialog-body">
				<div className="dialog-head">
					<h2>
						{added === null
							? "Add project"
							: `Set up ${projectLabel(added.project)}`}
					</h2>
					<CloseButton />
				</div>
				{added === null ? (
					<form
						className="add-form"
						onSubmit={(e) => {
							e.preventDefault();
							if (mode === "url") {
								addProject(trusted);
								return;
							}
							add.start(() =>
								act(async () => {
									const r = await post<AddProjectResponse>("/api/projects", {
										name: name.trim(),
										github: ghRepo,
									});
									onAdded(r.interview);
									setAdded({ project: r.project, interview: r.interview });
								}, setErr),
							);
						}}
					>
						<div
							className="add-tabs"
							role="tablist"
							aria-label="Project source"
						>
							<button
								type="button"
								role="tab"
								id="add-tab-url"
								data-tab="url"
								aria-selected={mode === "url"}
								aria-controls="add-panel-url"
								tabIndex={mode === "url" ? 0 : -1}
								onClick={() => setMode("url")}
								onKeyDown={(e) => switchTab(e, ["url", "new"], setMode)}
							>
								<Icon name="branch" />
								Git URL
							</button>
							<button
								type="button"
								role="tab"
								id="add-tab-new"
								data-tab="new"
								aria-selected={mode === "new"}
								aria-controls="add-panel-new"
								tabIndex={mode === "new" ? 0 : -1}
								onClick={() => setMode("new")}
								onKeyDown={(e) => switchTab(e, ["url", "new"], setMode)}
							>
								<Icon name="branch" />
								New
							</button>
						</div>
						<div
							role="tabpanel"
							id="add-panel-url"
							aria-labelledby="add-tab-url"
							hidden={mode !== "url"}
						>
							<label>
								Git URL
								<input
									data-autofocus
									value={url}
									onChange={(e) => onUrl(e.target.value)}
									placeholder="https://gitlab.com/group/repo.git or git@host:group/repo.git"
									required={mode === "url"}
								/>
							</label>
							<label>
								Name
								<input
									value={name}
									onChange={(e) => {
										setNameTouched(true);
										setName(e.target.value);
									}}
									placeholder="my-project"
									required={mode === "url"}
								/>
							</label>
							{ssh && (
								<fieldset>
									<legend>SSH key</legend>
									<label className="add-check">
										<input
											type="radio"
											name="add-ssh-key"
											checked={sshMode === "global"}
											disabled={(hosts?.globalKey ?? null) === null}
											onChange={() => setSshMode("global")}
										/>
										Global key
										{(hosts?.globalKey ?? null) === null && (
											<span className="hint">
												No global key exists; set one in Settings → Git hosts.
											</span>
										)}
									</label>
									<label className="add-check">
										<input
											type="radio"
											name="add-ssh-key"
											checked={sshMode === "new"}
											onChange={() => setSshMode("new")}
										/>
										New key for this project
									</label>
									{sshMode === "new" && (
										<PendingKeyRow
											pending={pendingKey}
											onPending={(p) => {
												setPendingKey(p);
												setTested(null);
											}}
										/>
									)}
									<SshTestRow
										send={runSshTest}
										onOk={() => setTested(`${trimmedUrl}\0${sshKey ?? ""}`)}
									/>
									<p className="hint">
										Add stays disabled until the test passed for this URL and
										key.
									</p>
								</fieldset>
							)}
							{needsTokenHost !== null && (
								<fieldset>
									<legend>
										Token for <code>{needsTokenHost}</code>
									</legend>
									<label>
										Username
										<input
											value={tokUser}
											onChange={(e) => setTokUser(e.target.value)}
											placeholder="oauth2"
										/>
									</label>
									<label>
										Token
										<input
											type="password"
											value={tokToken}
											onChange={(e) => setTokToken(e.target.value)}
											autoComplete="off"
											required
										/>
									</label>
									<button
										type="button"
										disabled={tokToken === ""}
										onClick={saveToken}
									>
										Save token and retry
									</button>
								</fieldset>
							)}
						</div>
						<div
							role="tabpanel"
							id="add-panel-new"
							aria-labelledby="add-tab-new"
							hidden={mode !== "new"}
						>
							<label>
								Name
								<input
									value={name}
									onChange={(e) => setName(e.target.value)}
									placeholder="my-project"
									required={mode === "new"}
								/>
							</label>
							<label className="add-check">
								<input
									type="checkbox"
									checked={ghRepo}
									onChange={(e) => setGhRepo(e.target.checked)}
								/>
								Create a private GitHub repo and push (needs gh auth)
							</label>
							{ghRepo &&
								(gh === null ? null : gh.authed ? (
									<p className="hint">
										Repo will be created under {gh.user}.
										{free === false
											? " That name is already taken on GitHub."
											: free === true
												? " The name is free on GitHub."
												: ""}
									</p>
								) : (
									<p className="auth-error" role="status">
										gh is not authenticated on the server: run gh auth login
										there, or uncheck the box for a local repo only.
									</p>
								))}
							{!ghRepo && gh !== null && (
								<p className="hint">
									Without a repo the project lives in {gh.dir}/{repoName || "…"}{" "}
									on this host; nothing is pushed.
								</p>
							)}
						</div>
						{err !== null && (
							<p className="auth-error" role="alert">
								{err}
							</p>
						)}
						{addTrust !== null && (
							<SshTestRow
								label="Add"
								success="Project added"
								send={(trust) =>
									gitReq("POST", "/api/projects", {
										url: trimmedUrl,
										name: repoName === "" ? undefined : repoName,
										sshKey,
										trust,
									}).then(({ status, data }) => {
										const t = asTrust(data);
										if (status < 300) {
											const r = data as unknown as AddProjectResponse; // unchecked cast: the server's documented answer shape
											onAdded(r.interview);
											setAdded({ project: r.project, interview: r.interview });
											setAddTrust(null);
											return { ok: true } as const;
										}
										if (t !== null) return t;
										return { error: asError(data, status) };
									})
								}
							/>
						)}
						<div className="dialog-actions">
							<button
								type="submit"
								disabled={add.busy || (mode === "url" && ssh && !sshTested)}
								className={`primary${add.failed ? " failed" : ""}`}
								aria-busy={add.busy || undefined}
								title={
									mode === "url" && ssh && !sshTested
										? "Run the SSH test first"
										: undefined
								}
							>
								{add.busy && <span className="spinner" aria-hidden="true" />}
								<Icon name="plus" />
								Add
							</button>
						</div>
					</form>
				) : (
					<ProjectSetupSteps
						project={added.project}
						interview={added.interview}
						act={act}
						onClose={onClose}
					/>
				)}
			</div>
		</Modal>
	);
}

/** Board panel above the lanes while setupChecklist is set: only the still-open items. */
function SetupChecklist({
	project,
	save,
	onOpenSetup,
}: {
	project: ProjectView;
	save: (patch: Record<string, unknown>) => Promise<boolean>;
	onOpenSetup: () => void;
}) {
	const items: ReactNode[] = [];
	if (project.settings.retroSince === null)
		items.push(
			<li key="retro">
				<span>Retro — follow-up proposals from each done task are off</span>
				<BusyButton run={() => save({ retro: true })}>Turn on</BusyButton>
			</li>,
		);
	if (project.github !== null && !project.settings.forkResearch)
		items.push(
			<li key="fork">
				<span>
					Fork research — the hourly watch of the project's GitHub forks is off
				</span>
				<BusyButton run={() => save({ forkResearch: true })}>
					Turn on
				</BusyButton>
			</li>,
		);
	if (items.length === 0) return null;
	return (
		<section className="setup-checklist" aria-labelledby="setup-check-title">
			<h3 id="setup-check-title">Finish setting up {projectLabel(project)}</h3>
			<ul>{items}</ul>
			<div className="setup-checklist-actions">
				<button type="button" className="ghost" onClick={onOpenSetup}>
					Open setup
				</button>
				<BusyButton run={() => save({ setupChecklist: false })}>
					Dismiss
				</BusyButton>
			</div>
		</section>
	);
}

/** Dialog sub-line for project-scoped compose masks: the tag plus the name, in bright ink. */
function ProjectSub({ project }: { project: ProjectView }) {
	return (
		<span className="project-sub">
			<ProjectTag project={project} />
			{projectLabel(project)}
		</span>
	);
}

/** One ask question: single-choice presets answer in one click; multi questions collect
 * checkbox picks plus typed text and answer with one comma list. */
export function AskBlock({
	q,
	name,
	answered,
	selected,
	busy,
	onOpenDiff,
	onAnswer,
}: {
	q: AskQuestion;
	/** Radio group name: groups a single-choice question's presets. */
	name: string;
	answered: boolean;
	selected: string | null;
	busy: boolean;
	/** Opens the diff view scoped to the named files (the question's `diff:` links). */
	onOpenDiff: (files: string[]) => void;
	onAnswer: (text: string) => void;
}) {
	const [custom, setCustom] = useState("");
	const customRef = useRef<HTMLInputElement>(null);
	const multi = q.multi;
	// Multi picks accumulate in the block; a saved answer (draft or sent) re-checks its
	// presets on remount. ponytail: the join is ", ", so a label containing ", " would
	// split wrong on reload — rename the separator if labels ever carry commas.
	const [picked, setPicked] = useState<string[]>(() =>
		selected === null ? [] : selected.split(", "),
	);
	const togglePick = (label: string): void =>
		setPicked((p) =>
			p.includes(label) ? p.filter((l) => l !== label) : [...p, label],
		);
	// The custom row's radio joins the preset group: checked once the saved answer is not a preset.
	const customChosen =
		selected !== null && !q.options.some((o) => o.label === selected);
	// A preset click clears the custom draft (its answer shows on the radio); a custom submit keeps its
	// text in the input, because that input is the only place the recorded custom answer is visible.
	const answer = (text: string, preset: boolean) => {
		onAnswer(text);
		if (preset) setCustom("");
	};
	// Multi answer = the checked presets plus typed text, sent as one comma list.
	const multiTotal = picked.length + (custom.trim() === "" ? 0 : 1);
	const submitMulti = (): void => {
		const v = custom.trim();
		const parts = v === "" ? picked : [...picked, v];
		if (parts.length !== 0) {
			onAnswer(parts.join(", "));
			setCustom("");
		}
	};
	return (
		<div className={"ask-q" + (answered ? " answered" : "")}>
			<p className="ask-text">
				{/* Shape carries the per-question state: ? = open, check = answered. */}
				<Mark kind={answered ? "done" : "asked"} />
				{/* One span keeps the parts in normal inline flow: the paragraph is a flex row, and
					separate flex items per part would wrap the text out of reading order. */}
				<span>
					{diffLinkParts(q.question).map((part, pi) =>
						part.kind === "text" ? (
							// biome-ignore lint/suspicious/noArrayIndexKey: static split of the question text; parts are positional
							<Fragment key={pi}>{part.text}</Fragment>
						) : (
							<button
								// biome-ignore lint/suspicious/noArrayIndexKey: static split of the question text; parts are positional
								key={pi}
								type="button"
								className="diff-link"
								title="View these files' diff"
								onClick={() => onOpenDiff(part.files)}
							>
								{part.label === "" ? part.files.join(", ") : part.label}
							</button>
						),
					)}
				</span>
				<span className="sr">
					{answered ? " (answered)" : " (needs an answer)"}
				</span>
			</p>
			<div className="ask-options">
				{q.options.map((o, oi) => {
					const chosen = multi
						? picked.includes(o.label)
						: selected === o.label;
					return (
						// The whole entry (row + description) is one label: one hover/click target.
						<label
							key={o.label}
							className={
								"ask-opt" + (chosen ? " chosen" : "") + (busy ? " off" : "")
							}
						>
							<input
								type={multi ? "checkbox" : "radio"}
								name={name}
								checked={chosen}
								disabled={busy}
								onChange={() =>
									multi ? togglePick(o.label) : answer(o.label, true)
								}
								// aria-label keeps the name the short option text; the wrapped
								// description would otherwise become part of the radio's name.
								aria-label={o.label}
								aria-describedby={
									o.description === undefined
										? undefined
										: `${name}-opt-${oi}-desc`
								}
							/>
							{o.label}
							{/* The recommendation is a name, never a fill: filling is what a click looks like. */}
							{q.recommended === oi && !chosen && (
								<span className="ask-rec">Recommended</span>
							)}
							{/* The description shows under its option: hover titles never reach phones. */}
							{o.description !== undefined && (
								<p className="ask-desc" id={`${name}-opt-${oi}-desc`}>
									{o.description}
								</p>
							)}
						</label>
					);
				})}
			</div>
			<form
				className="ask-custom"
				onSubmit={(e) => {
					e.preventDefault();
					if (multi) submitMulti();
					else {
						const v = custom.trim();
						if (v !== "") answer(v, false);
					}
				}}
			>
				{/* Single: same radio group as the presets; saving a typed answer checks it. Clicking
				    the radio moves focus to the text field instead of checking a pick that was never
				    saved. Multi: the checkbox just mirrors "typed text joins the answer"; clicking it
				    also focuses the field. The ref lives on the text input, so the focus lands where
				    typing goes. */}
				<input
					type={multi ? "checkbox" : "radio"}
					name={name}
					checked={multi ? custom.trim() !== "" : customChosen}
					disabled={busy}
					aria-label="Other"
					onChange={() => customRef.current?.focus()}
				/>
				<input
					ref={customRef}
					value={custom}
					onChange={(e) => setCustom(e.target.value)}
					placeholder="Other — type your own"
					aria-label="Other answer"
					disabled={busy}
				/>
				<button
					type="submit"
					disabled={busy || (multi ? multiTotal === 0 : custom.trim() === "")}
				>
					{busy && <span className="spinner" aria-hidden="true" />}
					{(selected === null ? "Answer" : "Replace") +
						(multi && multiTotal > 0 ? ` (${multiTotal})` : "")}
				</button>
			</form>
		</div>
	);
}

function KeptFilesPanel({
	task,
	act,
	onClose,
}: {
	task: TaskView;
	act: Act;
	onClose: () => void;
}) {
	const [choices, setChoices] = useState<Record<string, KeptChoice>>(() =>
		Object.fromEntries(task.keptFiles.map((f) => [f, "move" as const])),
	);
	return (
		<div className="kept-panel">
			<h3>Kept worktree files</h3>
			<p className="kept-hint">
				The merge landed but the worktree held these files. Decide each, then
				discard the worktree.
			</p>
			{task.keptFiles.map((f) => (
				<div key={f} className="kept-file">
					<code className="kept-path">{f}</code>
					<div
						className="kept-choices"
						role="radiogroup"
						aria-label={`Action for ${f}`}
					>
						{(
							[
								["move", "Move to main checkout"],
								["ignore", "Ignore forever"],
								["delete", "Delete"],
							] as const
						).map(([value, label]) => (
							<label
								key={value}
								className={`kept-choice${choices[f] === value ? " on" : ""}`}
							>
								<input
									type="radio"
									name={`kept-${f}`}
									checked={choices[f] === value}
									onChange={() => setChoices((s) => ({ ...s, [f]: value }))}
								/>
								{label}
							</label>
						))}
					</div>
				</div>
			))}
			<div className="kept-actions">
				<BusyButton
					className="primary"
					run={() =>
						window.confirm(
							`Finish and discard the worktree?\n\nApplies the choices above, then deletes:\n${task.worktree ?? "the worktree"}${task.branch !== null ? `\nbranch ${task.branch}` : ""}\n\nMoved files are copied to the main checkout first; ignored files are added to .git/info/exclude; deleted files are lost.`,
						)
							? act(async () => {
									await post(
										`/api/projects/${encodeURIComponent(task.project)}/tasks/${task.id}/finish-kept`,
										{ choices },
									);
									onClose();
								})
							: Promise.resolve(true)
					}
				>
					Finish & discard worktree
				</BusyButton>
			</div>
		</div>
	);
}

/** Collapsible drawer section: the caps head is the toggle, the chevron mirrors the
 * Follow-ups head. `head` rides right of the label (Edit button, meters, downloads).
 * The body stays mounted and only `hidden` toggles, so its scroll and inputs survive. */
function DrawerSec({
	id,
	label,
	defaultOpen = true,
	head,
	className,
	children,
}: {
	id: string;
	label: string;
	defaultOpen?: boolean;
	head?: ReactNode;
	className?: string;
	children: ReactNode;
}) {
	const [open, setOpen] = useState(defaultOpen);
	const h3 = (
		<h3 className="fu-head" data-collapsed={!open || undefined}>
			<button
				type="button"
				aria-expanded={open}
				aria-controls={id}
				onClick={() => setOpen(!open)}
			>
				<svg className="chev" viewBox="0 0 8 8" aria-hidden="true">
					<path d="M2 3l2 2 2-2" />
				</svg>
				{label}
			</button>
		</h3>
	);
	return (
		<section className={"dsec" + (className ? ` ${className}` : "")}>
			{head ? (
				<div className="section-head">
					{h3}
					{head}
				</div>
			) : (
				h3
			)}
			<div id={id} hidden={!open}>
				{children}
			</div>
		</section>
	);
}

/** The ask: a single question answers in one click; several collect answers first so one reply covers them all. */
function AskPanel({
	asked,
	taskId,
	busy,
	failed,
	onOpenDiff,
	onSend,
}: {
	asked: AskQuestion[];
	/** Draft key: unsent answers survive closing the drawer and a page reload. */
	taskId: string;
	busy: boolean;
	failed: boolean;
	/** Opens the diff view scoped to the named files (a question's `diff:` links). */
	onOpenDiff: (files: string[]) => void;
	onSend: (text: string) => void;
}) {
	// A changed ask round never sees the old draft: the fingerprint drops it.
	const fp = asked.map((q) => q.question).join("\n");
	const [answers, setAnswers] = useState<Record<number, string>>(() => {
		const d = loadAskDrafts()[taskId];
		return d !== undefined && d.fp === fp ? d.answers : {};
	});
	// One send closes the ask: the card stays visible until polling removes it, so the panel
	// stays locked past the request response; a failed send reopens it for a retry.
	const [sent, setSent] = useState(false);
	useEffect(() => {
		if (failed) setSent(false);
	}, [failed]);
	const locked = busy || sent;
	const count = Object.keys(answers).length;
	const send = () => {
		const text = asked
			.map((q, qi) =>
				answers[qi] !== undefined ? `For "${q.question}": ${answers[qi]}` : "",
			)
			.filter(Boolean)
			.join("\n");
		if (text !== "") {
			setSent(true);
			onSend(text);
		}
	};
	return (
		<div className="ask-panel">
			{asked.map((q, qi) => (
				<AskBlock
					// biome-ignore lint/suspicious/noArrayIndexKey: answers state is keyed by this index; the ask round is replaced wholesale
					key={qi}
					q={q}
					name={`ask-${qi}`}
					answered={answers[qi] !== undefined}
					selected={answers[qi] ?? null}
					busy={locked}
					onOpenDiff={onOpenDiff}
					onAnswer={(t) => {
						if (asked.length === 1) {
							setSent(true);
							onSend(t);
						} else {
							const next = { ...answers, [qi]: t };
							setAnswers(next);
							saveAskDraft(taskId, { fp, answers: next });
						}
					}}
				/>
			))}
			<div className="ask-actions">
				<button
					type="button"
					className="ask-send"
					disabled={locked}
					onClick={() => {
						setSent(true);
						onSend("Approve");
					}}
					title='Replies "Approve" to the waiting session'
				>
					{locked && <span className="spinner" aria-hidden="true" />}
					<Icon name="check" />
					Approve
				</button>
				{asked.length > 1 && (
					<button
						type="button"
						className="primary ask-send"
						disabled={locked || count === 0}
						onClick={send}
					>
						{locked && <span className="spinner" aria-hidden="true" />}
						Send {count}/{asked.length} answers
					</button>
				)}
			</div>
		</div>
	);
}

/** Pages the lightbox by delta, wrapping at both ends. */
function turnPage<T extends { list: string[]; index: number }>(
	v: T,
	delta: number,
): T {
	return { ...v, index: (v.index + delta + v.list.length) % v.list.length };
}

/** Follow-up text behind a research report's "Implement recommendations" button. */
const IMPLEMENT_RECOMMENDATIONS =
	"Implement the recommended steps (also called next steps or action items) from the research report in the handoff. If the steps split into independent pieces of work, implement the first one in this task and file each other piece as its own card with the create_task tool. If the report recommends no steps, change nothing and report that.";

/** True when a research report names steps worth implementing. Same phrases the
 * follow-up prompt searches for, so the button never promises work the agent
 * cannot find. ponytail: phrase heuristic; a report saying "no next steps are
 * needed" still matches — an explicit recommendations field would fix that. */
export const recommendsSteps = (report: string): boolean =>
	/\brecommended steps\b|\bnext steps\b|\baction items\b/i.test(report);

/** Related cards in the drawer (dependencies, follow-ups): one quiet row per card with the same
 * status words and alarm coding as the meta line; a click opens the card. */
function RelatedTasks({
	items,
	project,
	tasks,
	onOpenTask,
	draining,
}: {
	items: TaskCard[];
	project: ProjectView;
	tasks: TaskCard[];
	onOpenTask: (id: string) => void;
	/** True while an update holds new turns (POST /api/drain): queued cards wait for the restart. */
	draining: boolean;
}) {
	return (
		<ul className="fu-list">
			{items.map((k) => (
				<li key={k.id}>
					<button
						type="button"
						title={k.sessionTitle ?? k.title}
						onClick={() => onOpenTask(k.id)}
					>
						<span className="fu-key">{k.id}</span>
						<span className="fu-title">{k.sessionTitle ?? k.title}</span>
						<span
							className={
								k.state === "needs_you"
									? "st st-needs_you" + (k.asked !== null ? " st-asked" : "")
									: "st"
							}
						>
							{/* Same alarm marks as the meta line: markup, not ::before. */}
							{k.state === "needs_you" && <Mark kind={cardMark(k)} />}
							{statusLine(k, project.hasRules, holdFor(k, tasks), draining)}
						</span>
					</button>
				</li>
			))}
		</ul>
	);
}

/** PR review card: the model's review draft as an editable comment; it reaches GitHub only on the Post click. */
function PrReviewSection({
	task,
	pr,
	draft,
	act,
	onLoaded,
}: {
	task: TaskView;
	pr: PrReviewView;
	/** The review draft that the watcher saved as the done card's details; null before the first review lands. */
	draft: string | null;
	act: Act;
	onLoaded: (v: TaskView) => void;
}) {
	const [body, setBody] = useState(draft ?? "");
	const [error, setError] = useState<string | null>(null);
	const taskUrl = `/api/projects/${encodeURIComponent(task.project)}/tasks/${task.id}`;
	// The posted head only shows while it is the reviewed one; postedUrl links the actual GitHub review.
	const postedLabel =
		pr.state === "open" &&
		pr.postedHead !== null &&
		pr.postedHead === pr.reviewedHead
			? `Posted for ${pr.postedHead.slice(0, 7)}`
			: null;
	const blocked =
		pr.state !== "open"
			? `PR is ${pr.state}`
			: (postedLabel ??
				(draft === null
					? "No review draft yet"
					: task.stage !== "done" || task.state !== "idle"
						? "The review is not done"
						: body.trim() === ""
							? "The comment is empty"
							: null));
	const shownError = error ?? pr.postError;
	return (
		<>
			<p>
				<a href={pr.url} target="_blank" rel="noopener noreferrer">
					PR #{pr.number}
				</a>
				{" · "}
				{pr.state}
			</p>
			<div className="reply-form">
				<label htmlFor="pr-review-text">Review comment</label>
				<textarea
					id="pr-review-text"
					rows={10}
					maxLength={65536}
					value={body}
					onChange={(e) => setBody(e.target.value)}
				/>
				<div className="reply-actions">
					{blocked !== null && (
						<span className="dim">
							{postedLabel !== null && pr.postedUrl !== null ? (
								<a
									href={pr.postedUrl}
									target="_blank"
									rel="noopener noreferrer"
								>
									{blocked}
								</a>
							) : (
								blocked
							)}
						</span>
					)}
					<BusyButton
						className="primary"
						disabled={blocked !== null}
						run={() =>
							act(async () => {
								setError(null);
								await post(`${taskUrl}/pr-review/post`, {
									body,
									head: pr.reviewedHead,
								});
								onLoaded(await unwrap<TaskView>(await fetch(taskUrl)));
							}, setError)
						}
					>
						<Icon name="send" />
						Post
					</BusyButton>
				</div>
			</div>
			{shownError !== null && (
				<p className="auth-error" role="alert">
					{shownError}
				</p>
			)}
		</>
	);
}

/** Saves a Blob as a file; the delayed revoke keeps early-revoking browsers from cancelling. */
function downloadBlob(name: string, blob: Blob): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = name;
	a.click();
	// Delay the revoke: some browsers cancel a download whose URL dies too early.
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Standalone document around the rendered report's HTML: inline CSS, no JS. The body is
 *  React-rendered (escaped); the title is the only untrusted string, so it is escaped here. */
export function reportHtml(title: string, body: string): string {
	const esc = title.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
	return [
		"<!doctype html>",
		'<html lang="en">',
		"<head>",
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		`<title>${esc}</title>`,
		"<style>",
		":root{color-scheme:light dark}",
		"body{margin:0 auto;max-width:64rem;padding:1rem 1.25rem;font:16px/1.6 system-ui,sans-serif;background:#fff;color:#1c1c1c}",
		".md img{max-width:100%;height:auto;border-radius:6px}",
		".md table{border-collapse:collapse;margin:1rem 0}",
		".md th,.md td{border:1px solid #d4d4d4;padding:.35rem .6rem;text-align:left;vertical-align:top}",
		".md code{background:#f2f2f2;border-radius:4px;padding:.1rem .3rem;font-size:.9em}",
		".md pre{background:#f2f2f2;padding:.75rem;border-radius:6px;overflow:auto}",
		".md pre code{background:none;padding:0}",
		".md blockquote{border-left:3px solid #d4d4d4;margin:1rem 0;padding:0 1rem}",
		".md a{color:#06c}",
		"@media (prefers-color-scheme:dark){body{background:#161616;color:#e4e4e4}.md th,.md td,.md blockquote{border-color:#3a3a3a}.md code,.md pre{background:#242424}}",
		"</style>",
		"</head>",
		`<body>${body}</body>`,
		"</html>",
	].join("\n");
}

export function Drawer({
	open = true,
	task: row,
	project,
	act,
	onClose,
	onFollowed,
	read,
	onMarkUnread,
	delta,
	tasks,
	onOpenTask,
	draining,
	usedTotal,
	maxTotal,
}: {
	/** False while the exit animation plays; the dialog then closes natively on screen. */
	open?: boolean;
	task: TaskCard;
	project: ProjectView;
	act: Act;
	onClose: () => void;
	onFollowed: (id: string, from: string) => void;
	/** The card's answer is read (in the seen set): the done drawer offers the reverse action. */
	read: boolean;
	/** Marks the answer unread again and closes the drawer; the board owns the seen set. */
	onMarkUnread: () => void;
	delta?: number;
	tasks: TaskCard[];
	onOpenTask: (id: string) => void;
	/** True while an update holds new turns (POST /api/drain): queued cards wait for the restart. */
	draining: boolean;
	/** Agents running machine-wide right now, and the global cap they share. */
	usedTotal: number;
	maxTotal: number | null;
}) {
	const parent =
		row.followUpOf === null
			? null
			: (tasks.find((t) => t.id === row.followUpOf) ?? null);
	// Oldest first: the rail reads top to bottom in the order the follow-ups were filed.
	const kids = tasks
		.filter((t) => t.followUpOf === row.id)
		.sort((a, b) => a.createdAt - b.createdAt);
	// A held card waits until these are done; a cancelled dependency counts as done.
	const waiting = row.stage !== "done" ? waitingOn(tasks, row) : [];
	const [reply, setReply] = useState("");
	const [steer, setSteer] = useState("");
	const [modelQuery, setModelQuery] = useState("");
	const [copied, flashCopied] = useFlash(1500);
	const [copiedId, flashCopiedId] = useFlash(1500);
	const [idCopyError, setIdCopyError] = useState<string | null>(null);
	const [cmdCopyError, setCmdCopyError] = useState<string | null>(null);
	/** The one turn whose log is expanded; the log is per task, so only one copy shows at a time. */
	const [openTurn, setOpenTurn] = useState<number | null>(null);
	/** Open lightbox: the full-size list, the page shown and, for screenshots, the file names to caption; null while closed. Task inputs, reply and steer drafts each page their own list. */
	const [viewing, setViewing] = useState<{
		list: string[];
		index: number;
		names?: string[];
	} | null>(null);
	/** Open diff view: null shows the whole diff, an array the named files' sections; undefined while closed. */
	const [diffView, setDiffView] = useState<string[] | null | undefined>(
		undefined,
	);
	/** The rendered research report node; the HTML download serializes its DOM. */
	const mdRef = useRef<HTMLDivElement | null>(null);
	// Arrow keys page a multi-image lightbox; a window listener, since the modal dialog owns focus.
	useEffect(() => {
		if (viewing === null || viewing.list.length < 2) return;
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "ArrowLeft")
				setViewing((v) => (v === null ? v : turnPage(v, -1)));
			else if (e.key === "ArrowRight")
				setViewing((v) => (v === null ? v : turnPage(v, 1)));
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [viewing]);
	const [followOpen, setFollowOpen] = useState(false);
	const [wfOpen, setWfOpen] = useState(false);
	// Open model pick for a parked card: which action asked for it; null while closed.
	const [pick, setPick] = useState<"grill" | "todo" | null>(null);
	const replyImages = useAttachedImages();
	const steerImages = useAttachedImages();
	const catalog = useModels();
	// The board row ships without turns or the report text; fetch the full task while the drawer is open.
	const [detail, setDetail] = useState<TaskView | null>(null);
	// Every turn start/finish is written in the same synchronous block as a task-row update (runTurn), so a
	// row change is the exact signal that turns or the report changed; no interval needed.
	const rowKey = JSON.stringify(row);
	const ctx = useSessionContext(row.project, row.id, rowKey);
	// ponytail: local cast, an old server's catalog lacks contextWindow
	const windowTok =
		ctx === null || ctx.model === null
			? null
			: ((
					catalog?.models.find((m) => m.selector === ctx.model) as
						| (ModelOption & { contextWindow?: number | null })
						| undefined
				)?.contextWindow ?? null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: rowKey refetches the detail when the row changes
	useEffect(() => {
		let alive = true;
		let retry: ReturnType<typeof setTimeout> | undefined;
		const url = `/api/projects/${encodeURIComponent(row.project)}/tasks/${row.id}`;
		const load = async (attempt: number): Promise<void> => {
			try {
				const res = await fetch(url);
				if (!alive) return;
				if (!res.ok) throw new Error(String(res.status));
				const v = (await res.json()) as TaskView;
				if (alive) setDetail(v);
			} catch {
				// Fetch failed or hiccuped: retry with backoff while the drawer is open. A done row never
				// changes again, so without a retry a blip at open time would show "No turns yet." forever.
				if (alive)
					retry = setTimeout(
						() => void load(attempt + 1),
						Math.min(1000 * 2 ** attempt, 10000),
					);
			}
		};
		void load(0);
		return () => {
			alive = false;
			clearTimeout(retry);
		};
	}, [row.project, row.id, rowKey]);
	const task: TaskView = detail ?? {
		...row,
		turns: [],
		details: null,
		report: null,
		diffFiles: null,
	};
	// Touched-file stats (captured at merge, or live from the branch while open): totals for the
	// section's summary line.
	const diffFiles = task.diffFiles ?? [];
	const diffPlus = diffFiles.reduce((n, f) => n + (f.plus ?? 0), 0);
	const diffMinus = diffFiles.reduce((n, f) => n + (f.minus ?? 0), 0);
	/** Done tasks answer with a follow-up task (handoff + fresh session) instead of a reply.
	 * A cancelled card's drawer is read-only: no follow-up, no edit, no action. */
	const cancelled = task.cancelledAt !== null;
	const followUp = task.stage === "done" && !cancelled;
	// Ask round live right now: drives the accent status word, mark and panel tint (stalls stay amber).
	const askedNow = task.state === "needs_you" && task.asked !== null;
	// Live mutation run on a running card: the same parse the board card's meter row uses.
	// The row (not the fetched detail) carries `progress`, and its changes refetch the detail.
	const mut = row.state === "running" ? strykerProgress(row.progress) : null;
	// Retro proposal card: Resume acts as Accept, and New session (409 on a never-run card) is hidden.
	const proposal =
		task.needsReason?.startsWith(PROPOSED_REASON_PREFIX) === true ||
		task.needsReason?.startsWith(FORK_PROPOSED_REASON_PREFIX) === true;
	// Non-null while the release-notes editor is open, for release cards with a mutable state.
	const [notesEdit, setNotesEdit] = useState<string | null>(null);
	const notesSave = useBusy();
	// Merge anyway: one modal run at a time; the reason is required, so it starts empty.
	const [mergeOpen, setMergeOpen] = useState(false);
	const [mergeReason, setMergeReason] = useState("");
	const [mergeError, setMergeError] = useState<string | null>(null);
	const mergeSave = useBusy();
	// Manual triage: rank and close-candidate nomination; one POST per change, the
	// board's socket refresh then refetches the drawer detail (same as the model switch).
	const [triageReason, setTriageReason] = useState("");
	const [triageError, setTriageError] = useState<string | null>(null);
	const triageSave = useBusy();
	const triageUrl = `/api/projects/${encodeURIComponent(task.project)}/tasks/${task.id}/triage`;
	const setRank = (p: string): void => {
		void act(
			async () => {
				await post(triageUrl, { priority: p === "" ? null : p });
			},
			(message) => setTriageError(message),
		);
	};
	const nominateCandidate = (): void => {
		triageSave.start(() =>
			act(async () => {
				await post(triageUrl, { closeCandidate: triageReason.trim() });
				setTriageReason("");
			}, setTriageError),
		);
	};
	const clearCandidate = (): void => {
		triageSave.start(() =>
			act(async () => {
				await post(triageUrl, { closeCandidate: null });
			}, setTriageError),
		);
	};
	const notesValid =
		notesEdit !== null &&
		notesEdit.trim().length > 0 &&
		notesEdit.trim().length <= 20000;
	/** Release cards show the notes section; only needs_you and not-yet-published idle ones may edit. */
	const notesEditable =
		task.releaseVersion !== null &&
		!cancelled &&
		(task.state === "needs_you" ||
			(task.state === "idle" && task.stage !== "done"));
	const notesSubmit = (mode: "save" | "append"): void => {
		if (notesEdit === null || !notesValid) return;
		notesSave.start(() =>
			act(async () => {
				await post(
					`/api/projects/${encodeURIComponent(task.project)}/tasks/${task.id}/release-notes`,
					{
						notes:
							mode === "append"
								? `${task.releaseNotes ?? ""}\n\n${notesEdit}`
								: notesEdit,
					},
				);
				setNotesEdit(null);
			}),
		);
	};
	// Non-null while the prompt editor is open; only unstarted todo tasks get one.
	const [edit, setEdit] = useState<string | null>(null);
	const editable =
		task.stage === "todo" && task.turns.length === 0 && !cancelled;
	const editValid =
		edit !== null && edit.trim().length > 0 && edit.trim().length <= 20000;
	/** Done tasks lead with the implementation's report; the merge turn's integration output stays in its work step. */
	const report =
		(task.stage === "done"
			? task.turns.findLast((t) => t.kind === "work" && t.summary !== null)
			: undefined) ?? task;
	// PR review card: the watcher saves each draft as the done card's details.
	const prDraft =
		task.kind === "pr_review" &&
		task.prReview !== undefined &&
		task.stage === "done"
			? task.details
			: null;
	// The Result skips details shown elsewhere: the research report section or the PR review draft.
	const hideDetails =
		(task.research && task.report !== null) || prDraft !== null;

	// Merge anyway shows only while the newest blockers run still has an unresolved blocker and
	// no run is live (a running or preparing card can still pass the check on its own).
	const wcUnresolved =
		task.workCheckLog
			.findLast((r) => r.outcome === "blockers")
			?.blockers.some((b) => b.status === undefined) ?? false;
	const wcMergeable =
		wcUnresolved && task.state !== "running" && task.state !== "preparing";

	const imgUrl = (name: string): string =>
		`/api/projects/${encodeURIComponent(task.project)}/tasks/${task.id}/images/${encodeURIComponent(name)}`;
	/** Every task input image (kept + pending) in thumb order; the lightbox pages this list. */
	const inputUrls = [...task.images, ...task.pendingImages].map(imgUrl);
	const shotUrls = task.shots.map(imgUrl);

	const resumeCmd =
		task.worktree !== null && task.sessionId !== null && task.stage !== "done"
			? `cd "${task.worktree}"; omp --session-dir "${project.sessionsDir}" --resume ${task.sessionId}`
			: null;

	/** Sends text (plus any pasted images) as a reply to the run. Fixed-text senders
	 * (Resume, ask answers) pass draft=false: the user's typed reply and its images stay. */
	const sendReply = (text: string, draft = false): Promise<boolean> => {
		if (text.trim().length === 0) return Promise.resolve(true);
		return act(async () => {
			const images = draft ? replyImages.images.map((i) => i.data) : [];
			await post(
				`/api/projects/${encodeURIComponent(task.project)}/tasks/${task.id}/reply`,
				{ text, images },
			);
			if (draft) {
				setReply("");
				replyImages.clear();
			}
		});
	};

	/** Posts the Merge-anyway reason past an unresolved work-check block; act shows a thrown
	 * error through setMergeError inside the modal, and the ok path closes it. */
	const mergeAnyway = (): Promise<boolean> =>
		act(async () => {
			await post(
				`/api/projects/${encodeURIComponent(task.project)}/tasks/${task.id}/merge-anyway`,
				{ reason: mergeReason.trim() },
			);
			setMergeOpen(false);
			setMergeReason("");
		}, setMergeError);

	/** Queues steering (text, pictures, or both); runTurn delivers it with the agent's next turn. */
	const sendSteer = (text: string): Promise<boolean> => {
		if (text.trim().length === 0 && steerImages.images.length === 0)
			return Promise.resolve(true);
		return act(async () => {
			const images = steerImages.images.map((i) => i.data);
			await post(
				`/api/projects/${encodeURIComponent(task.project)}/tasks/${task.id}/steer`,
				{ text, images },
			);
			setSteer("");
			steerImages.clear();
		});
	};
	/** Withdraws the queued steering before the agent's next turn delivers it. */
	const cancelSteer = (): Promise<boolean> =>
		act(async () => {
			await post(
				`/api/projects/${encodeURIComponent(task.project)}/tasks/${task.id}/steer/cancel`,
				{},
			);
		});
	/** Switches the model the agent's next turn runs with; lands in-between turns like a steer. */
	const switchModel = (m: string): void => {
		void act(async () => {
			await post(
				`/api/projects/${encodeURIComponent(task.project)}/tasks/${task.id}/model`,
				{ model: m },
			);
		});
	};
	const editSave = useBusy();
	const replySend = useBusy();
	const steerSend = useBusy();

	return (
		<>
			<Modal
				open={open}
				onClose={onClose}
				label={task.sessionTitle ?? task.title}
				className="drawer"
			>
				<div className="drawer-body">
					<div className="drawer-head">
						<h2>{task.sessionTitle ?? task.title}</h2>
						<div className="drawer-head-actions">
							<button
								type="button"
								className="icon"
								aria-label="Workflow overview"
								title="Workflow overview"
								onClick={() => setWfOpen(true)}
							>
								<Icon name="branch" />
							</button>
							<CloseButton />
						</div>
					</div>
					<p className="drawer-sub">
						<span>{projectLabel(project)}</span>
						<span className="sub-dim">
							{/* Click copies the id for pasting into another task or an agent session. */}
							<button
								type="button"
								className="task-id"
								title="Copy task ID"
								onClick={() => {
									setIdCopyError(null);
									copyText(task.id).then(flashCopiedId, (err) =>
										setIdCopyError(
											err instanceof Error ? err.message : String(err),
										),
									);
								}}
							>
								{copiedId ? "Copied" : task.id}
							</button>
							{idCopyError !== null && (
								<span role="alert" className="auth-error">
									{idCopyError}
								</span>
							)}
						</span>
						<span>
							{COLUMNS.find((c) => c.key === task.stage)?.label ?? task.stage}
						</span>
						<span
							className="sub-dim"
							title={new Date(task.createdAt).toLocaleString()}
						>
							created {stamp(task.createdAt)}
						</span>
						{task.cancelledAt !== null && (
							<span
								className="sub-dim"
								title={new Date(task.cancelledAt).toLocaleString()}
							>
								cancelled {stamp(task.cancelledAt)}
							</span>
						)}
						{task.stage === "done" && task.doneAt !== null && (
							<span
								className="sub-dim"
								title={new Date(task.doneAt).toLocaleString()}
							>
								landed {stamp(task.doneAt)}
							</span>
						)}
						{/* The stage label already says done; the status word only earns its place when it adds state. */}
						{task.state !== "idle" && (
							<span
								className={
									"st st-" + task.state + (askedNow ? " st-asked" : "")
								}
							>
								{/* Alarm coding rides in markup, not ::before: the drawer-sub
								    separator owns that pseudo-element. */}
								{task.state === "needs_you" && <Mark kind={cardMark(task)} />}
								{statusLine(
									task,
									project.hasRules,
									// The list below names the cards; the meta line only counts them.
									waiting.length > 0
										? `waiting for ${waiting.length === 1 ? "1 task" : `${waiting.length} tasks`}`
										: holdFor(task, tasks),
									draining,
								)}
							</span>
						)}
					</p>
					{mut !== null && (
						<DrawerSec
							id="drawer-mut"
							label="Mutation run"
							className="drawer-mut"
						>
							<Meter
								label={mut.tool}
								pct={mut.pct}
								value={`${Math.round(mut.pct)}%`}
								band={false}
							/>
							<dl className="readout">
								<div>
									<dt>Tested</dt>
									<dd>
										{mut.tested} / {mut.total}
									</dd>
								</div>
								{/* The tail's parts are known words (survived, elapsed, left, timed out); a part the format grows later keeps its raw text. */}
								{strykerStats(mut.rest).map((s) => (
									<div key={s.label === "" ? s.value : s.label}>
										<dt>{s.label}</dt>
										<dd>{s.value}</dd>
									</div>
								))}
							</dl>
						</DrawerSec>
					)}
					{/* Lineage rail: the parent above, this card as the filled node. Follow-ups run in
					    parallel, so they hang one level in off this card's node, each on its own elbow. */}
					{(row.followUpOf !== null || kids.length > 0) && (
						<DrawerSec id="drawer-lineage" label="Lineage" className="lineage">
							<ol className="lineage-rail">
								{row.followUpOf !== null &&
									(parent === null ? (
										// The state no longer carries the parent (a cancelled card): the
										// row keeps the lineage on the bare id, inert like the card's.
										<li className="lineage-gone">
											<span
												className="lineage-row"
												title={`${row.followUpOf} is not on the board`}
											>
												<span className="lineage-key">{row.followUpOf}</span>
												<span className="lineage-title">Not on the board</span>
												<span className="lineage-tag">parent</span>
											</span>
										</li>
									) : (
										<li>
											<button
												type="button"
												className="lineage-row"
												title={parent.sessionTitle ?? parent.title}
												onClick={() => onOpenTask(parent.id)}
											>
												<span className="lineage-key">{parent.id}</span>
												<span className="lineage-title">
													{parent.sessionTitle ?? parent.title}
												</span>
												<span className="lineage-tag">parent</span>
											</button>
										</li>
									))}
								<li className="lineage-self" aria-current="true">
									<span className="lineage-row">
										<span className="lineage-key">{row.id}</span>
										<span className="lineage-title">
											{row.sessionTitle ?? row.title}
										</span>
										<span className="lineage-tag">this card</span>
									</span>
									{kids.length > 0 && (
										<ol className="lineage-branch" aria-label="Follow-ups">
											{kids.map((k) => (
												<li key={k.id}>
													<button
														type="button"
														className="lineage-row"
														title={k.sessionTitle ?? k.title}
														onClick={() => onOpenTask(k.id)}
													>
														<span className="lineage-key">{k.id}</span>
														<span className="lineage-title">
															{k.sessionTitle ?? k.title}
														</span>
														<span
															className={
																k.state === "needs_you"
																	? "st st-needs_you" +
																		(k.asked !== null ? " st-asked" : "")
																	: "st"
															}
														>
															{/* Same alarm marks as the meta line: markup, not ::before. */}
															{k.state === "needs_you" && (
																<Mark kind={cardMark(k)} />
															)}
															{statusLine(
																k,
																project.hasRules,
																holdFor(k, tasks),
																draining,
															)}
														</span>
													</button>
												</li>
											))}
										</ol>
									)}
								</li>
							</ol>
						</DrawerSec>
					)}
					{waiting.length > 0 && (
						<DrawerSec id="drawer-waiting" label="Waiting for">
							<RelatedTasks
								items={waiting}
								project={project}
								tasks={tasks}
								onOpenTask={onOpenTask}
								draining={draining}
							/>
						</DrawerSec>
					)}
					{/* A live ask round hides its reason: the runner echoes the first question into
					    it, and the ask panel below already carries the full questions. */}
					{task.needsReason !== null && !askedNow && (
						<div className="needs-reason">{task.needsReason}</div>
					)}
					{/* A parked merge hold (update, fork, mismatch) approves by reply; the button
					    sends that approving reply itself. The server still gates the approval. */}
					{task.state === "needs_you" &&
						task.holdHead !== null &&
						!askedNow && (
							<BusyButton
								className="approve-hold"
								title="Sends the approving reply, so the parked merge can land"
								run={() => sendReply("approved")}
							>
								<Icon name="check" />
								Approve merge
							</BusyButton>
						)}
					{/* A stopped card only interacts through the composer at the very bottom;
					    the jump link skips the report so no manual scrolling is needed. */}
					{task.state === "needs_you" && !askedNow && !followUp && (
						<p className="jump-reply">
							<button
								type="button"
								className="jump-link"
								onClick={() =>
									document
										.getElementById("drawer-reply")
										?.scrollIntoView({ block: "start" })
								}
							>
								Go to reply ↓
							</button>
						</p>
					)}
					{task.state === "needs_you" && task.keptFiles.length > 0 && (
						<KeptFilesPanel task={task} act={act} onClose={onClose} />
					)}
					{(task.worktreeFiles?.length ?? 0) > 0 && (
						<DrawerSec id="drawer-wt" label="Worktree files">
							<div className="wt-files">
								<p className="hint">
									Uncommitted files this task produced. Open them before the
									worktree is removed.
								</p>
								{task.worktreeFiles!.slice(0, 50).map((f) => (
									<a
										key={f}
										className="wt-file"
										href={`/api/projects/${encodeURIComponent(task.project)}/tasks/${task.id}/files?path=${encodeURIComponent(f)}`}
										target="_blank"
										rel="noreferrer"
									>
										{f}
									</a>
								))}
								{task.worktreeFiles!.length > 50 && (
									<p className="hint">
										…and {task.worktreeFiles!.length - 50} more
									</p>
								)}
							</div>
						</DrawerSec>
					)}
					{diffFiles.length > 0 && (
						<DrawerSec id="drawer-diff" label="Changed files">
							<div className="wt-files">
								<p className="hint">
									+{diffPlus} −{diffMinus} across {diffFiles.length} file
									{diffFiles.length === 1 ? "" : "s"} ·{" "}
									<button
										type="button"
										className="diff-link"
										onClick={() => setDiffView(null)}
									>
										View diff
									</button>
								</p>
								{diffFiles.slice(0, 50).map((f) => (
									<div key={f.file} className="diff-file">
										<button
											type="button"
											className="diff-path"
											title="View this file's diff"
											onClick={() => setDiffView([f.file])}
										>
											{f.file}
										</button>
										<span className="diff-num">
											{f.plus === null
												? "binary"
												: `+${f.plus} −${f.minus ?? 0}`}
										</span>
									</div>
								))}
								{diffFiles.length > 50 && (
									<p className="hint">…and {diffFiles.length - 50} more</p>
								)}
							</div>
						</DrawerSec>
					)}
					{task.asked !== null && task.state === "needs_you" && (
						<AskPanel
							asked={task.asked}
							taskId={task.id}
							busy={replySend.busy}
							failed={replySend.failed}
							onOpenDiff={setDiffView}
							onSend={(text) => {
								replySend.start(async () => {
									const ok = await sendReply(text);
									if (ok) clearAskDraft(task.id);
									return ok;
								});
							}}
						/>
					)}
					{task.releaseVersion !== null &&
						(notesEdit === null ? (
							<DrawerSec
								id="drawer-notes"
								label="Release notes"
								head={
									notesEditable && (
										<button
											type="button"
											className="ghost"
											title="Edit release notes"
											aria-label="Edit release notes"
											onClick={() => setNotesEdit("")}
										>
											<Icon name="plus" />
											Edit
										</button>
									)
								}
							>
								{task.releaseNotes === null || task.releaseNotes === "" ? (
									<p className="dim">No notes yet.</p>
								) : (
									<div className="release-notes">
										<Markdown text={task.releaseNotes} />
									</div>
								)}
							</DrawerSec>
						) : (
							<section className="dsec">
								{/* The editor replaces the section body; the form's label titles it. */}
								<form
									className="reply-form"
									onSubmit={(e) => {
										e.preventDefault();
										notesSubmit("save");
									}}
								>
									<label htmlFor="release-notes-text">Release notes</label>
									<textarea
										id="release-notes-text"
										rows={6}
										value={notesEdit}
										onChange={(e) => setNotesEdit(e.target.value)}
										placeholder="Replacement notes — or text appended below the current notes."
									/>
									<div className="reply-actions">
										<button
											type="button"
											onClick={() => setNotesEdit(null)}
											disabled={notesSave.busy}
										>
											Cancel
										</button>
										<button
											type="button"
											className={notesSave.failed ? "failed" : undefined}
											disabled={!notesValid || notesSave.busy}
											aria-busy={notesSave.busy || undefined}
											onClick={() => notesSubmit("append")}
										>
											{notesSave.busy && (
												<span className="spinner" aria-hidden="true" />
											)}
											Append
										</button>
										<button
											type="submit"
											className={
												"primary" + (notesSave.failed ? " failed" : "")
											}
											disabled={!notesValid || notesSave.busy}
											aria-busy={notesSave.busy || undefined}
										>
											{notesSave.busy && (
												<span className="spinner" aria-hidden="true" />
											)}
											<Icon name="send" />
											Save
										</button>
									</div>
								</form>
							</section>
						))}
					{!editable && (
						<DrawerSec id="drawer-prompt" label="Prompt">
							<div className="prompt-text">
								<Markdown text={task.prompt} />
							</div>
						</DrawerSec>
					)}
					{editable && edit === null && (
						<DrawerSec id="drawer-prompt" label="Prompt">
							<div className="task-prompt">
								<Markdown text={task.prompt} />
								<button type="button" onClick={() => setEdit(task.prompt)}>
									<Icon name="plus" />
									Edit task
								</button>
							</div>
						</DrawerSec>
					)}
					{editable && edit !== null && (
						<form
							className="reply-form"
							onSubmit={(e) => {
								e.preventDefault();
								if (edit === null || !editValid) return;
								editSave.start(() =>
									act(async () => {
										await post(
											`/api/projects/${encodeURIComponent(task.project)}/tasks/${task.id}/edit`,
											{ prompt: edit },
										);
										setEdit(null);
									}),
								);
							}}
						>
							<label htmlFor="edit-text">Task</label>
							<textarea
								id="edit-text"
								rows={6}
								value={edit}
								onChange={(e) => setEdit(e.target.value)}
								placeholder="What should the agent do?"
							/>
							<div className="reply-actions">
								<button type="button" onClick={() => setEdit(null)}>
									Cancel
								</button>
								<button
									type="submit"
									className={"primary" + (editSave.failed ? " failed" : "")}
									disabled={!editValid || editSave.busy}
									aria-busy={editSave.busy || undefined}
								>
									{editSave.busy && (
										<span className="spinner" aria-hidden="true" />
									)}
									<Icon name="send" />
									Save
								</button>
							</div>
						</form>
					)}
					{(task.images.length > 0 || task.pendingImages.length > 0) && (
						<div className="thumbs">
							{[...task.images, ...task.pendingImages].map((name, i) => {
								const url = imgUrl(name);
								return (
									<button
										key={name}
										type="button"
										className="thumb"
										title="Open full size"
										onClick={() => setViewing({ list: inputUrls, index: i })}
									>
										<img src={url} alt={`Attachment ${i + 1}`} loading="lazy" />
									</button>
								);
							})}
						</div>
					)}
					{/* A done research card renders the full report once, in the Research report section below; the Result keeps the summary (tldr) only. */}
					{(report.summary !== null ||
						(report.details !== null && !hideDetails)) && (
						<DrawerSec
							id="drawer-result"
							label={task.stage === "done" ? "Result" : "Report"}
						>
							{report.summary !== null && (
								<p className="summary">{report.summary}</p>
							)}
							{report.details !== null && !hideDetails && (
								<Markdown text={report.details} />
							)}
						</DrawerSec>
					)}
					{task.kind === "pr_review" && task.prReview !== undefined && (
						<DrawerSec id="drawer-pr" label="PR review">
							<PrReviewSection
								key={task.prReview.reviewedHead ?? ""}
								task={task}
								pr={task.prReview}
								draft={prDraft}
								act={act}
								onLoaded={setDetail}
							/>
						</DrawerSec>
					)}
					{task.workCheckLog.length > 0 && (
						<DrawerSec
							id="drawer-wc"
							label="Work check"
							className="work-checks"
						>
							<ul>
								{task.workCheckLog.map((run, i) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: append-only log, runs are positional
									<li key={i}>
										<p className="wc-run">
											{run.outcome === "pass"
												? "Passed"
												: run.outcome === "blockers"
													? "Blocked"
													: "Error"}
											{" · "}
											{run.model === null
												? "default model"
												: run.model.slice(run.model.indexOf("/") + 1)}
											{" · "}
											{stamp(run.at)} · {duration(run.durationMs)}
										</p>
										{run.error !== undefined && (
											<p className="dim">{run.error}</p>
										)}
										{run.blockers.length > 0 && (
											<ul>
												{run.blockers.map((b, j) => (
													// biome-ignore lint/suspicious/noArrayIndexKey: static list, blockers are positional
													<li key={j}>
														<p>{b.finding}</p>
														<blockquote>{b.quote}</blockquote>
														{b.status !== undefined && (
															<p className="dim">
																{b.status}
																{b.statusReason !== undefined
																	? `: ${b.statusReason}`
																	: ""}
															</p>
														)}
													</li>
												))}
											</ul>
										)}
										{run.notes.length > 0 && (
											<ul>
												{run.notes.map((n, j) => (
													// biome-ignore lint/suspicious/noArrayIndexKey: static list, notes are positional
													<li key={j} className="dim">
														{n}
													</li>
												))}
											</ul>
										)}
									</li>
								))}
							</ul>
						</DrawerSec>
					)}
					{mergeOpen && (
						<Modal
							label="Merge anyway"
							className="dialog"
							onClose={() => setMergeOpen(false)}
						>
							<div className="dialog-body">
								<div className="dialog-head">
									<h2>Merge anyway</h2>
									<CloseButton />
								</div>
								<p className="hint">
									The work check found unresolved blockers. Say why the card
									merges anyway; the reason is kept with the check log.
								</p>
								<form
									className="reply-form"
									onSubmit={(e) => {
										e.preventDefault();
										mergeSave.start(() => mergeAnyway());
									}}
								>
									<label htmlFor="merge-anyway-reason">Reason</label>
									<textarea
										id="merge-anyway-reason"
										data-autofocus
										required
										maxLength={2000}
										value={mergeReason}
										onChange={(e) => setMergeReason(e.target.value)}
										placeholder="Why do the blockers not block this merge?"
									/>
									{mergeError !== null && (
										<p role="alert" className="dim">
											{mergeError}
										</p>
									)}
									<div className="reply-actions">
										<button
											type="button"
											onClick={() => setMergeOpen(false)}
											disabled={mergeSave.busy}
										>
											Cancel
										</button>
										<button
											type="submit"
											className="danger"
											disabled={
												mergeReason.trim().length === 0 || mergeSave.busy
											}
											aria-busy={mergeSave.busy || undefined}
										>
											{mergeSave.busy && (
												<span className="spinner" aria-hidden="true" />
											)}
											Merge anyway
										</button>
									</div>
								</form>
							</div>
						</Modal>
					)}
					{shotUrls.length > 0 && (
						<DrawerSec id="drawer-shots" label="Screenshots">
							<div className="thumbs">
								{task.shots.map((name, i) => {
									const url = imgUrl(name);
									return (
										<button
											key={name}
											type="button"
											className="thumb shot"
											title="Open full size"
											onClick={() =>
												setViewing({
													list: shotUrls,
													index: i,
													names: task.shots,
												})
											}
										>
											<img src={url} alt={name} loading="lazy" />
											<span className="shot-name">{name}</span>
										</button>
									);
								})}
							</div>
						</DrawerSec>
					)}
					{task.research && task.report !== null && (
						<DrawerSec
							id="drawer-research"
							label="Research report"
							head={
								<div style={{ display: "flex", gap: 8 }}>
									<button
										type="button"
										className="ghost"
										title="Download research-report.html"
										onClick={() => {
											downloadBlob(
												"research-report.html",
												// The section guard proves non-null; closures lose the narrowing.
												new Blob(
													[
														reportHtml(
															task.title,
															mdRef.current?.innerHTML ?? "",
														),
													],
													{ type: "text/html" },
												),
											);
										}}
									>
										<Icon name="download" />
										HTML
									</button>
									<button
										type="button"
										className="ghost"
										title="Download research-report.md"
										onClick={() => {
											downloadBlob(
												"research-report.md",
												new Blob([task.report ?? ""], {
													type: "text/markdown",
												}),
											);
										}}
									>
										<Icon name="download" />
										Download
									</button>
								</div>
							}
						>
							<div ref={mdRef}>
								<Markdown text={task.report} />
							</div>
						</DrawerSec>
					)}

					<DrawerSec
						id="drawer-steps"
						label="Work steps"
						head={
							ctx === null ? undefined : (
								<Meter
									label="Context"
									pct={windowTok ? (ctx.promptTokens / windowTok) * 100 : null}
									band={windowTok !== null}
									value={
										fmtTokens(ctx.promptTokens) +
										(windowTok !== null ? ` / ${fmtTokens(windowTok)}` : "")
									}
									title={
										windowTok === null
											? ctx.model === null
												? "Context window"
												: `Context window — ${ctx.model}`
											: `Context window — ${ctx.model}` +
												(ctx.compactions > 0
													? `, compacted ${ctx.compactions}×`
													: "")
									}
								/>
							)
						}
					>
						{detail === null ? (
							<p className="dim" role="status">
								<span className="spinner" aria-hidden="true" />
								Loading…
							</p>
						) : (
							task.turns.length === 0 && <p className="dim">No turns yet.</p>
						)}
						<ul className="turns">
							{task.turns.map((t) => {
								// A running turn's model is only written to the DB when it ends; meanwhile show what it runs with.
								const model =
									t.model ??
									(t.endedAt === null
										? (task.model ?? catalog?.defaultModel ?? null)
										: null);
								return (
									<li
										key={t.id}
										className="turn"
										// Keyboard support without a second tab stop: the turn-head button
										// is the only stop, and its Enter/Space keydown bubbles to the
										// handlers here (preventDefault stops the button's own click).
										onKeyDown={(e) => {
											if (e.key !== "Enter" && e.key !== " ") return;
											e.preventDefault();
											setOpenTurn(openTurn === t.id ? null : t.id);
										}}
										onClick={(e) => {
											// The log stays open while scrolling/selecting in it; selecting summary text must not toggle either.
											// The input bubble is display-only: clicking or selecting it never toggles the log.
											if (
												(e.target as Element).closest(".log, .you") ||
												!window.getSelection()?.isCollapsed
											)
												return;
											setOpenTurn(openTurn === t.id ? null : t.id);
										}}
									>
										{/* Shape carries state on the rail: check = ended, filled dot = live, triangle = needs you (steel when the turn asked a question). */}
										{t.endedAt === null ? (
											<span className="turn-node live" aria-hidden="true" />
										) : t.outcome === "needs_you" ? (
											<span
												className={
													"turn-node ask" +
													(t.question !== null ? " asked" : "")
												}
												aria-hidden="true"
											/>
										) : (
											<span className="turn-node">
												<Icon name="check" size={11} />
											</span>
										)}
										{/* The steer/reply this turn delivered speaks first: it is what started the
									    turn below, and it is display-only (the row's click-to-toggle skips it). */}
										{t.input !== null && (
											<div className="you">
												<span className="you-head">
													{t.inputBy === "supervisor" ? "Supervisor" : "You"}
												</span>
												<div className="you-bubble">
													{/* "." is the resume marker (Resume button, restart, background-wait), never prose: show it as a badge. */}
													{t.input.trim() === "." ? (
														<span className="you-chip">Resume</span>
													) : (
														<div className="you-msg">
															<Markdown text={t.input} />
														</div>
													)}
												</div>
											</div>
										)}
										{/* The agent's part: the one hover-glow target. The steer/reply bubble
									    above stays outside it — display-only, like the click. */}
										<div className="turn-body">
											<button
												type="button"
												className="turn-head"
												aria-expanded={openTurn === t.id}
											>
												<Icon name="chevron-right" size={13} />
												<strong>{t.kind}</strong>
												{t.outcome !== null && (
													<span
														className={
															"outcome o-" +
															t.outcome +
															(t.outcome === "needs_you" && t.question !== null
																? " asked"
																: "")
														}
													>
														{t.outcome === "needs_you" && t.question !== null
															? "question"
															: t.outcome.replace("_", " ")}
													</span>
												)}
												{model !== null && (
													<span className="turn-model" title="model">
														{model}
													</span>
												)}
												<span className="turn-time">
													{new Date(t.startedAt).toLocaleTimeString()}
												</span>
												<span className="turn-dur">{turnDuration(t)}</span>
											</button>
											{t.summary !== null && (
												<div className="dim turn-sum">{t.summary}</div>
											)}
											{t.error !== null && (
												<div
													className={
														"needs-reason" +
														(t.question !== null ? " asked" : "")
													}
												>
													{t.question !== null && <Mark kind="asked" />}
													{t.error}
												</div>
											)}
											{openTurn === t.id && (
												<LogView project={project} taskId={task.id} />
											)}
										</div>
									</li>
								);
							})}
							{/* A queued steer speaks in the timeline under the last turn: it is the
						    next input the agent will get, not part of the composer below.
						    Same visibility as before (running/queued): other states never showed it. */}
							{task.pendingPrompt !== null &&
								(task.state === "running" || task.state === "queued") && (
									<li className="turn">
										<span className="turn-node">
											<Mark kind="queued" />
										</span>
										<div className="you">
											<span className="you-head">
												Queued
												{task.pendingPrompt.trim() !== "." && (
													<BusyButton
														className="ghost"
														ariaLabel="Cancel the queued steering"
														run={() =>
															window.confirm("Discard the queued steering?")
																? cancelSteer()
																: Promise.resolve(true)
														}
													>
														Cancel
													</BusyButton>
												)}
											</span>
											<div className="you-bubble">
												{/* "." is the resume marker (Resume button, restart, background-wait), never prose: show it as a badge. */}
												{task.pendingPrompt.trim() === "." ? (
													<span className="you-chip">Resume</span>
												) : (
													<div className="you-msg">
														<Markdown text={task.pendingPrompt} />
													</div>
												)}
												{task.pendingImages.length > 0 && (
													<p className="you-msg dim">
														+{task.pendingImages.length} image
														{task.pendingImages.length === 1 ? "" : "s"}
													</p>
												)}
												{task.state === "queued" && (
													<p className="you-msg dim">
														Sends when an agent slot frees.
													</p>
												)}
											</div>
										</div>
									</li>
								)}
						</ul>
					</DrawerSec>

					{/* Collapsible Triage between the turn tree and the Steer composer,
					    collapsed by default: rank and close-candidate nomination are triage
					    controls, not the card's story. Done tasks hide it entirely: the
					    controls have no effect there. A cancelled card hides it too: its
					    drawer is read-only. */}
					{task.stage !== "done" && !cancelled && (
						<DrawerSec id="drawer-triage" label="Triage" defaultOpen={false}>
							<div className="triage-row">
								<label className="triage-rank">
									<span>Rank</span>
									<select
										value={task.priority ?? ""}
										disabled={triageSave.busy}
										onChange={(e) => setRank(e.target.value)}
									>
										<option value="">Default</option>
										{PRIORITIES.map((p) => (
											<option key={p} value={p}>
												{p}
											</option>
										))}
									</select>
								</label>
								{task.closeCandidate === null ? (
									<form
										className="triage-nominate"
										onSubmit={(e) => {
											e.preventDefault();
											if (triageReason.trim() !== "") nominateCandidate();
										}}
									>
										<input
											value={triageReason}
											maxLength={200}
											required
											placeholder="Close candidate: duplicate, superseded…"
											aria-label="Close candidate reason"
											disabled={triageSave.busy}
											onChange={(e) => setTriageReason(e.target.value)}
										/>
										<button
											type="submit"
											disabled={triageSave.busy || triageReason.trim() === ""}
											aria-busy={triageSave.busy || undefined}
										>
											{triageSave.busy && (
												<span className="spinner" aria-hidden="true" />
											)}
											Nominate
										</button>
									</form>
								) : (
									<span className="triage-set">
										<span className="close-badge" title={task.closeCandidate}>
											Close
										</span>
										<span className="triage-reason" title={task.closeCandidate}>
											{task.closeCandidate}
										</span>
										<button
											type="button"
											disabled={triageSave.busy}
											aria-busy={triageSave.busy || undefined}
											onClick={clearCandidate}
										>
											Clear
										</button>
									</span>
								)}
							</div>
							{triageError !== null && (
								<p className="auth-error" role="alert">
									{triageError}
								</p>
							)}
						</DrawerSec>
					)}
					{followUp ? (
						<div className="followup-cta">
							<button
								type="button"
								className="primary"
								onClick={() => setFollowOpen(true)}
							>
								<Icon name="send" />
								Follow up
							</button>
							{task.research &&
								task.report !== null &&
								recommendsSteps(task.report) && (
									<BusyButton
										title="Creates a follow-up task that implements the report's recommended steps"
										run={() =>
											act(async () => {
												const next = await post<TaskView>(
													`/api/projects/${encodeURIComponent(task.project)}/tasks/${task.id}/follow-up`,
													{ text: IMPLEMENT_RECOMMENDATIONS },
												);
												onFollowed(next.id, task.id);
											})
										}
									>
										<Icon name="play" />
										Implement recommendations
									</BusyButton>
								)}
							<p className="hint">
								Creates a new task that continues this one with a full handoff.
							</p>
						</div>
					) : (
						task.state === "needs_you" && (
							<form
								id="drawer-reply"
								className="reply-form"
								onSubmit={(e) => {
									e.preventDefault();
									replySend.start(() => sendReply(reply, true));
								}}
							>
								<PromptInput
									label="Reply"
									value={reply}
									placeholder="Answer the agent…"
									onChange={setReply}
									onEnter={() => replySend.start(() => sendReply(reply, true))}
									images={replyImages}
									onView={(i) => {
										const list = replyImages.images.map((im) => im.url);
										if (list[i] !== undefined) setViewing({ list, index: i });
									}}
								/>
								<ComposerActions
									onAddImages={replyImages.addFiles}
									catalog={catalog}
									model={task.model ?? ""}
									setModel={switchModel}
									modelQuery={modelQuery}
									setModelQuery={setModelQuery}
									secondary={
										<>
											{!proposal && (
												<BusyButton
													title="Start a fresh omp session in the same worktree; the broken one is abandoned (its files stay in .tasks/sessions)"
													run={() =>
														window.confirm(
															"Start a fresh omp session for this task? The broken session is abandoned (its transcript stays in .tasks/sessions).",
														)
															? act(async () => {
																	await post(
																		`/api/projects/${encodeURIComponent(task.project)}/tasks/${task.id}/restart-session`,
																		{},
																	);
																})
															: Promise.resolve(true)
													}
												>
													<Icon name="refresh-cw" />
													New session
												</BusyButton>
											)}
											<BusyButton
												title={
													proposal
														? "Start the proposed task"
														: "Continue the interrupted session (sends '.')"
												}
												run={() => sendReply(".")}
											>
												<Icon name="play" />
												{proposal ? "Accept" : "Resume"}
											</BusyButton>
											{wcMergeable && (
												<button
													type="button"
													className="danger"
													onClick={() => {
														setMergeReason("");
														setMergeError(null);
														setMergeOpen(true);
													}}
												>
													Merge anyway
												</button>
											)}
										</>
									}
									primary={
										<button
											type="submit"
											className={
												"primary" + (replySend.failed ? " failed" : "")
											}
											disabled={replySend.busy}
											aria-busy={replySend.busy || undefined}
										>
											{replySend.busy && (
												<span className="spinner" aria-hidden="true" />
											)}
											<Icon name="send" />
											Reply
										</button>
									}
								/>
								<p className="hint">
									Enter sends. Shift+Enter starts a new line. Images: paste,
									drop or browse. A model pick lands with the reply turn.
								</p>
							</form>
						)
					)}

					{(task.state === "running" || task.state === "queued") && (
						<form
							className="reply-form"
							onSubmit={(e) => {
								e.preventDefault();
								steerSend.start(() => sendSteer(steer));
							}}
						>
							<PromptInput
								label="Steer"
								value={steer}
								placeholder="Extra guidance the agent gets with its next turn…"
								onChange={setSteer}
								onEnter={() => steerSend.start(() => sendSteer(steer))}
								images={steerImages}
								onView={(i) => {
									const list = steerImages.images.map((im) => im.url);
									if (list[i] !== undefined) setViewing({ list, index: i });
								}}
							/>
							<ComposerActions
								onAddImages={steerImages.addFiles}
								catalog={catalog}
								model={task.model ?? ""}
								setModel={switchModel}
								modelQuery={modelQuery}
								setModelQuery={setModelQuery}
								secondary={
									<>
										{wcMergeable && (
											<button
												type="button"
												className="danger"
												onClick={() => {
													setMergeReason("");
													setMergeError(null);
													setMergeOpen(true);
												}}
											>
												Merge anyway
											</button>
										)}
										{task.state === "running" && (
											<BusyButton
												title="Interrupt this turn like Esc: the worktree, branch and session stay; the card waits for your reply"
												run={() =>
													window.confirm(
														"Stop this turn? The card waits for your reply.",
													) && window.confirm("Really stop the running turn?")
														? act(async () => {
																await post(
																	`/api/projects/${encodeURIComponent(task.project)}/tasks/${task.id}/stop`,
																	{},
																);
															})
														: Promise.resolve(true)
												}
											>
												<Icon name="stop" />
												Stop turn
											</BusyButton>
										)}
									</>
								}
								primary={
									<button
										type="submit"
										className={"primary" + (steerSend.failed ? " failed" : "")}
										disabled={steerSend.busy}
										aria-busy={steerSend.busy || undefined}
									>
										{steerSend.busy && (
											<span className="spinner" aria-hidden="true" />
										)}
										<Icon name="helm" />
										Steer
									</button>
								}
							/>
							<p className="hint">
								Enter steers. Shift+Enter starts a new line. Images: paste, drop
								or browse. A model pick lands with the next turn.
							</p>
						</form>
					)}

					{/* The actions row (Cancel task and stage-specific actions) sits between the steer form and meta. */}
					<div className="drawer-actions">
						{task.stage === "backlog" &&
							task.state === "idle" &&
							!cancelled && (
								<>
									<button
										type="button"
										title="Asks rounds of questions to refine the idea before it runs"
										onClick={() => setPick("grill")}
									>
										<Icon name="send" />
										Grill with the agent
									</button>
									<button
										type="button"
										title="Puts the card in the todo lane so the agent can start it"
										onClick={() => setPick("todo")}
									>
										<Icon name="plus" />
										Move to todo
									</button>
								</>
							)}
						{task.stage === "todo" &&
							task.state === "queued" &&
							task.pendingPrompt === null && (
								<BusyButton
									title="Parks the idea in the backlog until it is ready to run"
									run={() =>
										act(async () => {
											await post(
												`/api/projects/${encodeURIComponent(task.project)}/tasks/${task.id}/backlog`,
												{ to: "backlog" },
											);
										})
									}
								>
									<Icon name="x" />
									Not ready — park in backlog
								</BusyButton>
							)}
						{task.stage === "done" && read && !cancelled && (
							<BusyButton
								title="Puts the new badge back on this card: it counts as not opened again"
								run={async () => {
									onMarkUnread();
									return true;
								}}
							>
								<Icon name="eye-off" />
								Mark unread
							</BusyButton>
						)}
						{task.stage === "done" && task.research && !cancelled && (
							<BusyButton
								title={
									task.starred
										? "Removes this report from the Starred section"
										: "Pins this report in the Starred section of the done lane"
								}
								run={() =>
									act(async () => {
										await post(
											`/api/projects/${encodeURIComponent(task.project)}/tasks/${task.id}/star`,
											{ starred: !task.starred },
										);
									})
								}
							>
								<Icon name="star" />
								{task.starred ? "Starred" : "Star"}
							</BusyButton>
						)}
						{/* A cancelled card is final: its drawer is read-only, so the delete
						    action goes too (an uncancel does not exist). */}
						{!cancelled && (
							<BusyButton
								className="danger"
								run={() =>
									(
										task.stage === "done"
											? // A done task has no run, worktree or branch left; this only removes the card from the board.
												window.confirm("Delete this done task from the board?")
											: window.confirm(
													"Cancel this task? It stops the run and deletes its worktree and branch.",
												)
									)
										? act(async () => {
												const url = `/api/projects/${encodeURIComponent(task.project)}/tasks/${task.id}/cancel`;
												const r = await post<{ kept?: string }>(url, {});
												// The server kept work that isn't merged and flagged the card; deleting it takes a second yes.
												if (r.kept !== undefined) {
													if (
														!window.confirm(
															`The worktree was kept: ${r.kept}.\n\nDelete the worktree and its branch anyway?`,
														)
													)
														return;
													await post(url, { force: true });
												}
												onClose();
											})
										: Promise.resolve(true)
								}
							>
								<Icon name={task.stage === "done" ? "trash" : "x"} />
								{task.stage === "done" ? "Delete task" : "Cancel task"}
							</BusyButton>
						)}
					</div>

					{/* The meta section is the drawer's last element: it sits below everything else. */}
					<details className="meta-block">
						<summary>Meta</summary>
						<dl className="meta">
							{task.research && (
								<div>
									<dt>Research</dt>
									<dd>
										yes
										{task.state !== "running" && !cancelled && (
											<button
												type="button"
												className="unmark-research"
												title="Clear the research flag: the next settle classifies this card from its branch again"
												onClick={() =>
													act(async () => {
														await post(
															`/api/projects/${encodeURIComponent(task.project)}/tasks/${task.id}/unmark-research`,
															{},
														);
													})
												}
											>
												unmark
											</button>
										)}
									</dd>
								</div>
							)}
							<div>
								<dt>Branch</dt>
								<dd>{task.branch ?? "-"}</dd>
							</div>
							<div>
								<dt>Worktree</dt>
								<dd>{task.worktree ?? "-"}</dd>
							</div>
							<div>
								<dt>Session</dt>
								<dd>{task.sessionId ?? "-"}</dd>
							</div>
							{project.github !== null && (
								<div>
									<dt>GitHub</dt>
									<dd>
										<a
											href={project.github}
											target="_blank"
											rel="noopener noreferrer"
										>
											{project.github}
										</a>
									</dd>
								</div>
							)}
							<div>
								<dt>Commits</dt>
								<dd>
									{task.commits === null
										? "-"
										: delta !== undefined
											? `${task.commits} (+${delta})`
											: `${task.commits}`}
								</dd>
							</div>
						</dl>
						{resumeCmd !== null && (
							<div className="cmd-row">
								<code>{resumeCmd}</code>
								<button
									type="button"
									onClick={() => {
										setCmdCopyError(null);
										copyText(resumeCmd).then(flashCopied, (err) =>
											setCmdCopyError(
												err instanceof Error ? err.message : String(err),
											),
										);
									}}
								>
									{copied ? "Copied" : "Copy"}
								</button>
							</div>
						)}
						{resumeCmd !== null && cmdCopyError !== null && (
							<p className="auth-error" role="alert">
								{cmdCopyError}
							</p>
						)}
					</details>
				</div>
			</Modal>
			{/* Sibling, not child: a nested dialog's close event would propagate to the drawer's Modal and close both. */}
			<BacklogModelDialog
				project={task.project}
				taskTitle={task.sessionTitle ?? task.title}
				taskId={task.id}
				currentModel={task.model ?? null}
				mode={pick === "todo" ? "todo" : "grill"}
				open={pick !== null}
				onClose={() => setPick(null)}
				act={act}
			/>
			{/* Sibling, not child: a nested dialog's close event would propagate to the drawer's Modal and close both. */}
			<Modal
				open={viewing !== null}
				onClose={() => setViewing(null)}
				label="Attached image"
				className="lightbox"
			>
				{viewing !== null && (
					<div className="frame">
						<img
							src={viewing.list[viewing.index]}
							alt="Attachment, full size"
						/>
						{viewing.names?.[viewing.index] !== undefined && (
							<span className="caption">{viewing.names[viewing.index]}</span>
						)}
						{viewing.list.length > 1 && (
							<>
								<button
									type="button"
									className="page prev"
									aria-label="Previous image"
									onClick={() =>
										setViewing((v) => (v === null ? v : turnPage(v, -1)))
									}
								>
									<Icon name="chevron-left" />
								</button>
								<button
									type="button"
									className="page next"
									aria-label="Next image"
									onClick={() =>
										setViewing((v) => (v === null ? v : turnPage(v, 1)))
									}
								>
									<Icon name="chevron-right" />
								</button>
							</>
						)}
					</div>
				)}
			</Modal>
			{/* Sibling, not child: a nested dialog's close event would propagate to the drawer's Modal and close both. */}
			{wfOpen && (
				<WorkflowModal
					kind={workflowKind(task)}
					stage={task.cancelledAt !== null ? null : task.stage}
					label={projectLabel(project)}
					live={{
						slots: slotUse(tasks),
						waiting: queueOrder(tasks).length,
						maxParallel: project.settings.maxParallel,
						maxTotal,
						usedTotal,
						draining,
					}}
					onClose={() => setWfOpen(false)}
				/>
			)}
			{/* Sibling, not child: a nested dialog's close event would propagate to the drawer's Modal and close both. */}
			{diffView !== undefined && (
				<DiffModal
					task={task}
					files={diffView}
					onClose={() => setDiffView(undefined)}
				/>
			)}
			{/* Sibling, not child: a nested dialog's close event would propagate to the drawer's Modal and close both.
			    A cancelled card's drawer is read-only: it never opens a follow-up. */}
			{!cancelled && (
				<FollowUpDialog
					task={task}
					open={followOpen}
					onClose={() => setFollowOpen(false)}
					act={act}
					onFollowed={onFollowed}
				/>
			)}
		</>
	);
}

/**
 * Onboarding + login page, shown alone when the server asks for them (public-host access).
 * Success reloads the page: the push socket and every fetch then run with the fresh session cookie.
 */
function AuthPage({
	mode,
	version,
}: {
	mode: "setup" | "login";
	version: string | null;
}) {
	const [name, setName] = useState("");
	const [password, setPassword] = useState("");
	const [repeat, setRepeat] = useState("");
	const [githubToken, setGithubToken] = useState("");
	const tokenHint = useId();
	const [remember, setRemember] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const setup = mode === "setup";
	const submit = (e: React.FormEvent): void => {
		e.preventDefault();
		if (busy) return;
		if (setup && password !== repeat) {
			setError("The passwords do not match.");
			return;
		}
		setError(null);
		setBusy(true);
		post(setup ? "/api/setup" : "/api/login", {
			name: name.trim(),
			password,
			...(setup ? { githubToken: githubToken.trim() } : { remember }),
		})
			.then(() => {
				localStorage.removeItem(LOGOUT_KEY);
				location.reload();
			})
			.catch((err: unknown) => {
				setBusy(false);
				setError(err instanceof Error ? err.message : "Request failed");
			});
	};
	return (
		<main className="auth-page">
			<section className="auth-box">
				<h1 className="auth-brand">
					<img src={logo} alt="" />
					Ottr
				</h1>
				<form className="add-form" onSubmit={submit}>
					<label>
						Name
						<input
							type="text"
							autoComplete="username"
							value={name}
							onChange={(e) => setName(e.target.value)}
							required
						/>
					</label>
					<label>
						Password{setup ? " (at least 8 characters)" : ""}
						<input
							type="password"
							autoComplete={setup ? "new-password" : "current-password"}
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							minLength={setup ? 8 : undefined}
							required
						/>
					</label>
					{setup && (
						<label>
							Repeat password
							<input
								type="password"
								autoComplete="new-password"
								value={repeat}
								onChange={(e) => setRepeat(e.target.value)}
								required
							/>
						</label>
					)}
					{setup && (
						<label>
							GitHub token
							<input
								type="password"
								autoComplete="off"
								spellCheck={false}
								value={githubToken}
								onChange={(e) => setGithubToken(e.target.value)}
								aria-label="GitHub token"
								aria-describedby={tokenHint}
								required
							/>
							<span className="hint" id={tokenHint}>
								Ottr's git fetches and pushes your repos with it (repo access).
							</span>
						</label>
					)}
					{!setup && (
						<label className="auth-remember">
							<input
								type="checkbox"
								checked={remember}
								onChange={(e) => setRemember(e.target.checked)}
							/>
							Remember me
						</label>
					)}
					{error !== null && (
						<p className="auth-error" role="alert">
							{error}
						</p>
					)}
					<button type="submit" className="primary" disabled={busy}>
						{busy && <span className="spinner" aria-hidden="true" />}
						{setup ? "Create admin" : "Log in"}
					</button>
				</form>
				{version !== null && <p className="auth-version">{version}</p>}
			</section>
		</main>
	);
}

/** An scp-style or ssh:// URL (the two forms that need a key); https URLs use tokens. */
const isSshUrl = (u: string): boolean =>
	/^ssh:\/\//i.test(u) || /^[^/@\s]+@[^/\s]*:/.test(u);

/** User theme choice; "system" follows `prefers-color-scheme` (dark when the OS is dark). */
type Theme = "system" | "light" | "dark";

const THEME_KEY = "ottr.theme";
const THEME_ORDER: Theme[] = ["system", "light", "dark"];
const THEME_META: Record<
	Theme,
	{ icon: "monitor" | "sun" | "moon"; label: string }
> = {
	system: { icon: "monitor", label: "Match system" },
	light: { icon: "sun", label: "Light" },
	dark: { icon: "moon", label: "Dark" },
};

function loadTheme(): Theme {
	const saved = localStorage.getItem(THEME_KEY);
	return saved === "light" || saved === "dark" ? saved : "system";
}

/** Server version this tab last saw; sessionStorage keeps it across the one guarded reload. */
let seenVersion: string | null = sessionStorage.getItem(SEEN_VERSION_KEY);

/** Project links with live indicators; the desktop rail renders it, and on phones the areas popout reuses it. */
function AreasNav({
	projects,
	tasks,
	project,
	view,
	onAdd,
}: {
	projects: ProjectView[];
	tasks: TaskCard[];
	project: ProjectView | null;
	view: string;
	onAdd: () => void;
}) {
	// Closes the phone popout on selection; in the desktop rail the popover is already shut (no-op).
	const closePop = (): void =>
		document.getElementById("areas-pop")?.hidePopover();
	const [legendOpen, setLegendOpen] = useState(false);
	return (
		<>
			{/* biome-ignore lint/a11y/useValidAnchor: the empty hash is the overview route; readHash() maps "" to no project */}
			<a
				className="area"
				aria-current={
					project === null && !settingsSub(view).onSettings ? "page" : undefined
				}
				href="#"
				onClick={closePop}
			>
				<Icon name="grid" />
				<span className="area-name">Overview</span>
			</a>
			<a
				className="area"
				href={`#${SETTINGS_HASH}`}
				aria-current={
					view === SETTINGS_HASH || view.startsWith(`${SETTINGS_HASH}/`)
						? "page"
						: undefined
				}
				onClick={closePop}
			>
				<Icon name="gear" />
				<span className="area-name">Settings</span>
			</a>
			<p className="areas-label">
				PROJECTS
				<span className="areas-rule" aria-hidden="true" />
				<button
					type="button"
					className="areas-help"
					aria-expanded={legendOpen}
					aria-controls="areas-legend"
					title="What the task marks mean"
					onClick={() => setLegendOpen((open) => !open)}
				>
					<Icon name="help" size={13} />
				</button>
			</p>
			{/* The marks carry meaning, so the legend stays one click away (NN/g: tooltips must
			    not carry information vital to the task) — click, not hover, so touch works too. */}
			{legendOpen && (
				<p className="areas-legend" id="areas-legend">
					<span>
						<Mark kind="running" /> running
					</span>
					<span>
						<Mark kind="needs" /> needs action
					</span>
					<span>
						<Mark kind="asked" /> asked
					</span>
					<span>
						<Mark kind="queued" /> waiting
					</span>
				</p>
			)}
			<ul>
				{projects.map((p) => {
					const own = tasks.filter((t) => t.project === p.name);
					const split = splitAlarms(own);
					const needs = split.needs.length;
					const asks = split.asks.length;
					const running = split.running.length;
					// StateResponse.tasks carries cancelled cards too, but a cancel leaves the
					// row state "idle": none of the splits below (needs_you, running, queued)
					// counts one. Queued and running/preparing are exclusive states, so no card
					// counts in two badges; Merging cards appear in none (the Merging lane and
					// Agents meter cover them).
					const waiting = own.filter((t) => t.state === "queued").length;
					return (
						<li key={p.name}>
							<a
								className="area"
								href={`#${encodeURIComponent(p.name)}`}
								aria-current={project?.name === p.name ? "page" : undefined}
								onClick={closePop}
							>
								<ProjectTag project={p} />
								<span className="area-name">{projectLabel(p)}</span>
								{running > 0 && (
									<span className="area-ind">
										<Mark kind="running" />
										{running}
										<span className="sr"> running</span>
									</span>
								)}
								{needs > 0 && (
									<span className="area-ind needs">
										<Mark kind="needs" />
										{needs}
										<span className="sr"> need action</span>
									</span>
								)}
								{asks > 0 && (
									<span className="area-ind asked">
										<Mark kind="asked" />
										{asks}
										<span className="sr"> asked</span>
									</span>
								)}
								{waiting > 0 && (
									<span className="area-ind waiting">
										<Mark kind="queued" />
										{waiting}
										<span className="sr"> waiting</span>
									</span>
								)}
							</a>
						</li>
					);
				})}
			</ul>
			<button
				type="button"
				className="area-add"
				onClick={() => {
					closePop();
					onAdd();
				}}
			>
				<Icon name="plus" />
				Add project
			</button>
			<footer className="menu-foot">
				<a
					className="menu-brand"
					href={REPO}
					target="_blank"
					rel="noopener noreferrer"
					title="Ottr on GitHub"
				>
					Ottr
				</a>
			</footer>
		</>
	);
}

/** Server warnings (unseeded agent layer, provider without an active sign-in), one line each.
 * No dismiss: state recomputes per poll, so a fixed condition drops its own line. */
export function WarningLines({ warnings }: { warnings: string[] }) {
	if (warnings.length === 0) return null;
	return (
		<>
			{warnings.map((w, i) => (
				<p className="notif-line" role="note" key={`warn:${i}`}>
					<Mark kind="warn" />
					<span>{w}</span>
				</p>
			))}
		</>
	);
}

function App() {
	const [state, setState] = useState<StateResponse | null>(null);
	const [view, setView] = useState(readHash);
	const [showAdd, setShowAdd] = useState(false);
	const [showUpdates, setShowUpdates] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	/** Cards with something to read (answers, PR reviews) that the user has opened; the unread badge on done cards reads its absence. Starts empty; the server owns the set. */
	const [seenAnswers, setSeenAnswers] = useState(() => new Set<string>());
	/** One-shot localStorage → server migration of seen answers, run after the first state load. */
	const migratedSeen = useRef(false);
	// Hoisted above markSeen/openTask: openTask looks cards up here, and a plain const is not a hook, so order with the useState lines is free.
	const tasks = state?.tasks ?? [];
	// U6: rows an open (non-done, non-cancelled) update card already carries are not pending for the user.
	const coveredUpdates = coveredUpdateIds(tasks);
	/** Actionable upstream updates (rows with a pin target); drives the inbox entry (U5). */
	const updateIds =
		state?.updates?.rows
			.filter((r) => r.target !== null && !coveredUpdates.has(r.id))
			.map((r) => r.id) ?? [];
	const updateCount = updateIds.length;
	/** Only a card with something to read (an answer, a PR review) counts as seen: opening
	 * a card before that lands must not hide the "new" badge it earns. */
	const markSeen = useCallback((t: TaskCard | null | undefined) => {
		if (t == null || !seenable(t)) return;
		setSeenAnswers((s) => (s.has(t.id) ? s : new Set(s).add(t.id)));
		void post("/api/seen", { ids: [t.id] }).catch(() =>
			setNotice(
				"Saving the read state failed; this card may show as unread on your other devices.",
			),
		);
	}, []);
	/** The reverse of markSeen: puts a read answer back to unread, locally and on the server. */
	const markUnread = useCallback((t: TaskCard | null | undefined) => {
		if (t == null || !seenable(t)) return;
		setSeenAnswers((s) => {
			if (!s.has(t.id)) return s;
			const next = new Set(s);
			next.delete(t.id);
			return next;
		});
		void post("/api/seen", { ids: [t.id], unread: true }).catch(() =>
			setNotice(
				"Saving the read state failed; this card may show as read on your other devices.",
			),
		);
	}, []);
	const openTask = useCallback(
		(id: string) => {
			// Every card open is one history entry, so Back returns to the previous card
			// (e.g. child → parent → child) before it leaves the page.
			history.pushState({ ompTask: id }, "");
			setSelectedId(id);
			markSeen(tasks.find((t) => t.id === id));
		},
		[tasks, markSeen],
	);
	const [composeFor, setComposeFor] = useState<string | null>(null);
	const [draftFor, setDraftFor] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [offline, setOffline] = useState(false);
	/** Acknowledged inbox entry keys; opening the inbox acknowledges everything it lists. */
	const [inboxSeen, setInboxSeen] =
		useState<ReadonlySet<string>>(loadInboxSeen);
	const [inboxOpen, setInboxOpen] = useState(false);
	/** Rows unacknowledged when the inbox opened, plus arrivals while it stays open: the rows marked New. */
	const [inboxFresh, setInboxFresh] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	/** Bumped every 30 s so relative ages re-render; nothing reads the number itself. */
	const [, setClockTick] = useState(0);
	const [update, setUpdate] = useState<{
		behind: number;
		commits: string[];
	} | null>(null);
	const [theme, setTheme] = useState<Theme>(loadTheme);
	/** Whether the OS prefers light, so the system split icon can show which theme actually applies. */
	const [sysLight, setSysLight] = useState(
		() => window.matchMedia("(prefers-color-scheme: light)").matches,
	);
	/** "setup" until the admin exists, "login" when a public host demands credentials or the user logged out; null otherwise. */
	const [gate, setGate] = useState<"setup" | "login" | null>(null);
	const [bootVersion, setBootVersion] = useState<string | null>(null);
	const [live, setLive] = useState<boolean | null>(null);
	useEffect(() => {
		void fetch("/api/boot")
			.then(
				(r) =>
					r.json() as Promise<{
						onboarding: boolean;
						version: string;
						live: boolean;
					}>,
			)
			.then((b) => {
				setBootVersion(b.version);
				setLive(b.live);
				if (b.onboarding) setGate("setup");
				else if (localStorage.getItem(LOGOUT_KEY) !== null) setGate("login");
				else
					void fetch("/api/state").then((r) => {
						if (sessionLost(r.status)) setGate("login");
					});
			})
			.catch(() => {
				// unreachable server: poll mode self-heals via its own 5 s poll
				setLive(false);
			});
	}, []);

	/** Desktop-notification switch; re-reads on mount, so a second tab starts in sync. */
	const [notify, setNotify] = useState(notificationsOn);
	const toggleNotify = useCallback(async () => {
		if (notificationsOn()) {
			localStorage.removeItem(NOTIFY_KEY);
			setNotify(false);
			void (async () => {
				try {
					const reg = await navigator.serviceWorker.getRegistration();
					const sub = await reg?.pushManager.getSubscription();
					if (!sub) return;
					await sub.unsubscribe();
					await post("/api/push/unsubscribe", { endpoint: sub.endpoint });
				} catch {
					setNotice(
						"Unsubscribing this device from push failed; it may still get notifications.",
					);
				}
			})();
			return;
		}
		if ((await requestNotifyPermission()) === "granted") {
			localStorage.setItem(NOTIFY_KEY, "1");
			setNotify(true);
		} else {
			setNotice(
				"Desktop notifications stay off. Allow them for this site in the browser's settings, then turn them on again.",
			);
		}
	}, []);

	useEffect(() => {
		localStorage.setItem(THEME_KEY, theme);
		const mq = window.matchMedia("(prefers-color-scheme: light)");
		const apply = (): void => {
			setSysLight(mq.matches);
			document.documentElement.dataset.theme =
				theme === "system" ? (mq.matches ? "light" : "dark") : theme;
		};
		apply();
		if (theme === "system") {
			mq.addEventListener("change", apply);
			return () => mq.removeEventListener("change", apply);
		}
	}, [theme]);

	useEffect(() => {
		const onHash = (): void => setView(readHash());
		window.addEventListener("hashchange", onHash);
		return () => window.removeEventListener("hashchange", onHash);
	}, []);

	// Back/Forward walk the card entries pushState()d by openTask; a non-card entry closes
	// the drawer. A vanished card id self-cleans: the drawer only renders a task the
	// current state still lists. The explicit close (X, Esc, backdrop) only drops the
	// selection: it must not traverse, or closing the parent of a child → parent walk
	// would pop to the child's entry and reopen it instead of closing.
	useEffect(() => {
		const onPop = (e: PopStateEvent): void => {
			setSelectedId((e.state as { ompTask?: string } | null)?.ompTask ?? null);
		};
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, []);

	// One push-only socket per tab: state, update banner and stats all arrive over it.
	// Every state frame is diffed against the last one so tasks that just started needing
	// the user fire a desktop notification (only while the tab is hidden; see notify.ts).
	const seenTasks = useRef<TaskCard[] | null>(null);
	useEffect(() => {
		if (live === null) return; // boot hasn't answered yet
		const h = {
			onState: (s: StateResponse) => {
				showAlerts(freshAlerts(seenTasks.current, s.tasks));
				seenTasks.current = s.tasks;
				setState(s);
				// The open card can vanish (cancelled in another tab): drop the selection,
				// or the drawer would keep rendering a stale row.
				setSelectedId((id) =>
					id === null || s.tasks.some((t) => t.id === id) ? id : null,
				);
				// Drafts die with their ask: a sent, cancelled or other-device answer drops them.
				pruneAskDrafts(
					new Set(s.tasks.filter((t) => t.asked !== null).map((t) => t.id)),
				);
				// Append-only union: a local mark between frames must survive the next server frame.
				setSeenAnswers((prev) => new Set([...prev, ...s.seenAnswers]));
				if (!migratedSeen.current) {
					migratedSeen.current = true;
					const local = [...loadSeenAnswers()];
					if (local.length > 0)
						void post("/api/seen", { ids: local })
							.then(() => localStorage.removeItem(SEEN_KEY))
							.catch(() =>
								setNotice(
									"Moving your read answers to the server failed; they stay on this device only.",
								),
							);
				}
			},
			onUpdate: (behind: number, commits: string[]) =>
				setUpdate({ behind, commits }),
			onOnline: () => setOffline(false),
			// A dead socket cannot show the HTTP status, so ask once per drop: an expired or
			// revoked session lands on the login page instead of an endless "Retrying…".
			onOffline: () => {
				setOffline(true);
				void fetch("/api/state")
					.then((r) => {
						if (sessionLost(r.status)) setGate("login");
					})
					.catch(() => {}); // server down: the banner already says so
			},
		};
		// Prod board polls: the server refuses the socket in production mode.
		return live ? connectLive(h) : connectPolling(h);
	}, [live]);

	// Relative ages (age(), landed() in ./time.ts) are computed from Date.now() at render; they used to refresh
	// through the 2 s poll's re-render and would freeze on an idle board.
	useEffect(() => {
		const timer = setInterval(() => setClockTick((c) => c + 1), 30_000);
		return () => clearInterval(timer);
	}, []);

	// Stale-tab handshake: a restarted server ships a new serverVersion; reload once so the tab
	// picks up the fresh bundle instead of rendering old shapes against the new API. The drawer,
	// modals and compose dialog count as busy (their textareas only exist inside them), so a
	// half-typed reply is never lost; the effect reruns when busy state clears or on the next state push.
	useEffect(() => {
		if (state === null) return;
		const idle =
			composeFor === null &&
			draftFor === null &&
			selectedId === null &&
			!showAdd;
		const decision = decideReload(
			seenVersion,
			state.serverVersion,
			idle,
			sessionStorage.getItem(RELOAD_GUARD_KEY),
		);
		if (decision === "reload") {
			sessionStorage.setItem(RELOAD_GUARD_KEY, state.serverVersion);
			location.reload();
		} else if (decision === "done" && seenVersion !== state.serverVersion) {
			seenVersion = state.serverVersion;
			sessionStorage.setItem(SEEN_VERSION_KEY, state.serverVersion);
		}
	}, [state, composeFor, draftFor, selectedId, showAdd]);

	/** Cards travel: when a task's stage changes, fly the card from its old column to its new one (FLIP). */
	const cardPos = useRef(new Map<string, CardPos>());
	/** Every task id seen so far; a task missing here was just created and gets an entrance. */
	const seenIds = useRef<Set<string> | null>(null);
	/** A follow-up awaiting its first board render: { id: the new task, from: the done task it continues. } */
	const origin = useRef<{ id: string; from: string } | null>(null);
	useLayoutEffect(() => {
		if (state === null) return;
		const prev = cardPos.current;
		const next = new Map<string, CardPos>();
		const els = new Map<string, HTMLElement>();
		for (const el of document.querySelectorAll<HTMLElement>(
			".card[data-task-id]",
		)) {
			const id = el.dataset.taskId as string;
			const r = el.getBoundingClientRect();
			next.set(id, {
				stage: el.dataset.stage as string,
				left: r.left,
				top: r.top,
			});
			els.set(id, el);
		}
		cardPos.current = next;
		const fresh = freshTaskIds(seenIds.current, state.tasks);
		seenIds.current = new Set(state.tasks.map((t) => t.id));
		const flights = stageFlights(prev, next);
		// A fresh follow-up starts where its done parent sits, so it visibly grows out of that card.
		const org = origin.current;
		if (org !== null) {
			const el = els.get(org.id);
			const pos = next.get(org.id);
			const src = prev.get(org.from);
			if (el !== undefined && pos !== undefined && src !== undefined) {
				flights.set(org.id, {
					dx: src.left - pos.left,
					dy: src.top - pos.top,
				});
				origin.current = null;
			}
		}
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			// No movement under reduced motion; the appearance itself still gets a fade.
			for (const id of fresh)
				els.get(id)?.animate([{ opacity: "0" }, { opacity: "1" }], {
					duration: 180,
					easing: "ease-out",
				});
			return;
		}
		for (const [id, f] of flights) {
			const el = els.get(id);
			if (el === undefined) continue;
			el.style.zIndex = "3";
			el.animate(
				[
					{ transform: `translate(${f.dx}px, ${f.dy}px)` },
					{ transform: "translate(0, 0)" },
				],
				{
					duration: 340,
					easing: "cubic-bezier(0.2, 0.7, 0.3, 1)", // --ease; WAAPI options don't resolve var()
				},
			).finished.then(
				() => {
					el.style.zIndex = "";
				},
				() => {
					el.style.zIndex = "";
				},
			);
		}
		// Fresh cards whose parent is off screen rise in place instead.
		for (const id of fresh) {
			const el = els.get(id);
			if (el === undefined || flights.has(id)) continue;
			el.animate(
				[
					{ opacity: "0", transform: "translateY(8px)" },
					{ opacity: "1", transform: "translateY(0)" },
				],
				{
					duration: 220,
					easing: "cubic-bezier(0.2, 0.7, 0.3, 1)", // --ease
				},
			);
		}
	}, [state, view]);

	const act = useCallback(
		async (
			fn: () => Promise<void>,
			onError?: (message: string) => void,
		): Promise<boolean> => {
			try {
				await fn();
				// Production has no pushed frames: the poll fetches right now instead of
				// up to 5 s later (no-op in live mode).
				refreshState();
				return true;
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				setError(message);
				onError?.(message);
				return false;
			}
		},
		[], // stable: setError and refreshState never change between renders
	);

	const projects = state?.projects ?? [];
	// ponytail: a dev tool for the board that develops Ottr itself, so it shows only where a
	// project tracks ottr-ai/ottr (that project holds the check card). Put it behind a release
	// switch once Ottr ships releases.
	const checkProject = mapRepo("ottr-ai/ottr", projects);
	const project = projects.find((p) => p.name === view) ?? null;
	const settingsRoute = settingsSub(view);
	const selected =
		selectedId === null
			? null
			: (tasks.find((t) => t.id === selectedId) ?? null);
	const selectedProject =
		selected === null
			? null
			: (projects.find((p) => p.name === selected.project) ?? null);
	/** The drawer task+project a close froze; held while the exit animation plays, then dropped. */
	const [sheet, setSheet] = useState<{
		task: TaskCard;
		project: ProjectView;
	} | null>(null);
	// While open, the drawer renders the live selection; on a close (X, Esc, backdrop,
	// Back, mark-unread) it freezes into `sheet` so the dialog can animate out mounted.
	const drawerTask = selected ?? sheet?.task ?? null;
	const drawerProject = selectedProject ?? sheet?.project ?? null;
	useEffect(() => {
		if (selected !== null && selectedProject !== null) {
			setSheet((s) =>
				s !== null && s.task.id === selected.id && s.project === selectedProject
					? s
					: { task: selected, project: selectedProject },
			);
			return;
		}
		if (sheet === null) return;
		// The card the drawer closed on gets one outline-and-tint flash, so the board
		// points back at it. Color only, so reduced motion needs no separate variant.
		const el = document.querySelector<HTMLElement>(
			`.card[data-task-id="${CSS.escape(sheet.task.id)}"]`,
		);
		el?.animate(
			[
				{
					outline: "2px solid var(--accent)",
					outlineOffset: "2px",
					backgroundColor: "var(--accent-bg)",
				},
				{
					outline: "2px solid transparent",
					outlineOffset: "2px",
					backgroundColor: "var(--card)",
				},
			],
			{
				duration: 900,
				easing: "cubic-bezier(0.2, 0.7, 0.3, 1)", // --ease; WAAPI options don't resolve var()
			},
		);
		// Matches the drawer's 0.2 s CSS exit plus headroom; reopened sooner keeps the sheet.
		const t = setTimeout(() => setSheet(null), 300);
		return () => clearTimeout(t);
	}, [selected, selectedProject]);
	const deltas = commitDeltas(tasks);
	// Live agent counts for the drawer's Workflow modal: slots busy now machine-wide, against
	// the global cap (SystemBar shows the same count in the app bar).
	const slotsAll = slotUse(tasks);
	const usedTotal = SLOT_STAGES.reduce((n, s) => n + slotsAll[s], 0);
	// One split for the bell, the popover groups and the counts (shared with AreasNav/Overview).
	const { needs: needTasks, asks: askCards } = splitAlarms(tasks);
	const alarmLine = alarmLabel(needTasks.length, askCards.length);
	const alarmCount = needTasks.length + askCards.length;

	// Shared notification lines: the inbox panel renders the same content the
	// entries are keyed from, so rows and keys cannot drift apart.
	const behind = update === null ? 0 : Math.max(update.behind, 0);
	const behindCommits = update === null ? [] : update.commits;
	// An update holds new turns (scripts/update-image.ts): queued cards wait for the restart.
	const draining = (state?.drainUntil ?? null) !== null;
	const drainCommits = state?.drainCommits ?? [];
	// Advisory from the server: unseeded agent layer, provider without an active sign-in.
	const warnings = state?.warnings ?? [];
	const orphanList = state?.orphans ?? [];
	const orphansError = state?.orphansError ?? null;
	const keptCount = state?.keptWorktrees ?? { held: 0, stale: 0 };
	// Occurrence keys of the inbox entries; null when the source is absent.
	const critKey = error !== null ? `crit:${error}` : null;
	const noticeKey = notice !== null ? `notice:${notice}` : null;
	const drainKey = draining ? `drain:${state?.drainUntil}` : null;
	const behindKey = behind > 0 ? `behind:${behind}` : null;
	const updatesKey = updateCount > 0 ? `updates:${updateIds.join(",")}` : null;
	const orphansErrorKey =
		orphansError !== null ? `orphans-error:${orphansError}` : null;
	const orphansKey =
		orphanList.length > 0
			? `orphans:${orphanList.map((o) => o.pid).join(",")}`
			: null;
	const keptKey =
		keptCount.held > 0 ? `kept:${keptCount.held}:${keptCount.stale}` : null;
	const critLine =
		error !== null ? (
			<p className="notif-line">
				<Mark kind="crit" />
				<span>{error}</span>
				{critKey !== null && inboxFresh.has(critKey) && (
					<span className="new-tag">New</span>
				)}
				<button
					type="button"
					className="icon"
					aria-label="Dismiss error"
					onClick={() => setError(null)}
				>
					<Icon name="x" />
				</button>
			</p>
		) : null;
	const alarmList =
		alarmCount > 0
			? [
					{ heading: "Action required", tasks: needTasks },
					{ heading: "Questions", tasks: askCards },
				]
					.filter((g) => g.tasks.length > 0)
					.map((g) => (
						<section key={g.heading}>
							<h2>
								{g.heading} · {g.tasks.length}
							</h2>
							<ul className="alarm-list">
								{g.tasks.map((t) => {
									const owner = projects.find((p) => p.name === t.project);
									const key = taskEntryKey(t);
									return (
										<li key={t.id}>
											<button
												type="button"
												className="alarm-link"
												onClick={() => {
													openTask(t.id);
													// Hides the inbox panel; hiding a closed one is a no-op.
													document.getElementById("inbox")?.hidePopover();
												}}
											>
												<Mark kind={cardMark(t)} />
												<span className="alarm-project">
													{owner === undefined
														? t.project
														: projectLabel(owner)}
												</span>
												<span className="alarm-title">
													{t.sessionTitle ?? t.title}
												</span>
												{inboxFresh.has(key) && (
													<span className="new-tag">New</span>
												)}
											</button>
										</li>
									);
								})}
							</ul>
						</section>
					))
			: null;
	const infoLines =
		notice !== null || behind > 0 || draining ? (
			<>
				{notice !== null && (
					<p className="notif-line">
						<Icon name="info" size={16} />
						<span>{notice}</span>
						{noticeKey !== null && inboxFresh.has(noticeKey) && (
							<span className="new-tag">New</span>
						)}
						<button
							type="button"
							className="icon"
							aria-label="Dismiss notice"
							onClick={() => setNotice(null)}
						>
							<Icon name="x" />
						</button>
					</p>
				)}
				{draining && (
					<>
						<p className="notif-line">
							<Icon name="info" size={16} />
							<span>
								An Ottr update is ready. New turns wait until the running turns
								finish and Ottr restarts.
							</span>
							{drainKey !== null && inboxFresh.has(drainKey) && (
								<span className="new-tag">New</span>
							)}
						</p>
						{drainCommits.length > 0 && (
							<ul className="notif-commits">
								{drainCommits.map((c) => (
									<li key={c}>{c}</li>
								))}
							</ul>
						)}
					</>
				)}
				{behind > 0 && (
					<>
						<p className="notif-line">
							<Icon name="info" size={16} />
							<span>
								A new Ottr version is available ({behind} commit
								{behind === 1 ? "" : "s"}). Stop the server, run{" "}
								<code>bun run update</code>, then start it again.
							</span>
							{behindKey !== null && inboxFresh.has(behindKey) && (
								<span className="new-tag">New</span>
							)}
						</p>
						{behindCommits.length > 0 && (
							<ul className="notif-commits">
								{behindCommits.map((c) => (
									<li key={c}>{c}</li>
								))}
							</ul>
						)}
					</>
				)}
			</>
		) : null;
	// Advisory lines: orphan agent processes, the kept-worktree backlog, and an alate import
	// that has waited too long. The tracker reports them; it never kills processes, deletes
	// worktrees, or runs provisioning on its own.
	const nowMs = Date.now();
	const alatePendingKey = alatePendingEntry(
		state?.alatePendingSince ?? null,
		nowMs,
	);
	const signinAdvisories = state?.deadSignIns ?? [];
	const advisoryLines =
		state === null ||
		(orphanList.length === 0 &&
			keptCount.held === 0 &&
			orphansError === null &&
			alatePendingKey === null &&
			signinAdvisories.length === 0 &&
			warnings.length === 0) ? null : (
			<>
				<WarningLines warnings={warnings} />
				{orphansError !== null && (
					<p className="notif-line">
						<Icon name="info" size={16} />
						<span>
							Orphan scan failed: {orphansError} — the agent process list may be
							empty because no scan succeeded.
						</span>
						{orphansErrorKey !== null && inboxFresh.has(orphansErrorKey) && (
							<span className="new-tag">New</span>
						)}
					</p>
				)}
				{orphanList.length > 0 && (
					<p className="notif-line">
						<Icon name="info" size={16} />
						<span>
							{orphanList.length} agent process
							{orphanList.length === 1 ? "" : "es"} no turn claims:{" "}
							{orphanList
								.slice(0, 5)
								.map((o) =>
									o.started > 0
										? `pid ${o.pid} (running ${age(o.started, nowMs)})`
										: `pid ${o.pid}`,
								)
								.join(", ")}
							{orphanList.length > 5 ? " …" : ""} — stop them manually if stale;
							Ottr never kills processes.
						</span>
						{orphansKey !== null && inboxFresh.has(orphansKey) && (
							<span className="new-tag">New</span>
						)}
					</p>
				)}
				{keptCount.held > 0 && (
					<p className="notif-line">
						<Icon name="info" size={16} />
						<span>
							{keptCount.held} cancelled card
							{keptCount.held === 1 ? "" : "s"} still hold
							{keptCount.held === 1 ? "s" : ""} a worktree
							{keptCount.stale > 0
								? `, ${keptCount.stale} past the quarantine threshold`
								: ""}
							.
						</span>
						{keptKey !== null && inboxFresh.has(keptKey) && (
							<span className="new-tag">New</span>
						)}
					</p>
				)}
				{alatePendingKey !== null && (
					<p className="notif-line">
						<Icon name="info" size={16} />
						<span>
							Alate is waiting to provision an import.{" "}
							<button
								type="button"
								className="notif-link"
								onClick={() => openSettingsSection("alate-section")}
							>
								Open Settings
							</button>
						</span>
						{inboxFresh.has(alatePendingKey) && (
							<span className="new-tag">New</span>
						)}
					</p>
				)}
				{signinAdvisories.map((d) => (
					<p className="notif-line" key={`signin:${d.provider}`}>
						<Icon name="info" size={16} />
						<span>
							{d.provider}'s sign-in is disabled — {d.cause}. Used by the{" "}
							{d.roles.join(", ")} model role{d.roles.length === 1 ? "" : "s"}.{" "}
							<button
								type="button"
								className="notif-link"
								onClick={() => openSettingsSection("signin-section")}
							>
								Open Settings
							</button>
						</span>
						{inboxFresh.has(`signin:${d.provider}`) && (
							<span className="new-tag">New</span>
						)}
					</p>
				))}
			</>
		);
	// One inbox entry per panel row, most urgent first; the bell and the New chips read it.
	const infoKeys = [
		updatesKey,
		noticeKey,
		drainKey,
		behindKey,
		orphansErrorKey,
		orphansKey,
		keptKey,
		alatePendingKey,
		...signinAdvisories.map((d) => `signin:${d.provider}` as const),
	];
	const entries: InboxEntry[] = [
		...(critKey === null ? [] : [{ key: critKey, level: "crit" as const }]),
		...needTasks.map((t) => ({
			key: taskEntryKey(t),
			level: "needs" as const,
		})),
		...askCards.map((t) => ({ key: taskEntryKey(t), level: "asked" as const })),
		...infoKeys
			.filter((key) => key !== null)
			.map((key) => ({ key, level: "info" as const })),
	];
	const inbox = inboxView(entries, inboxSeen);
	const inboxSig = JSON.stringify(entries.map((e) => e.key));
	// Bell tooltip summary: one error, then the alarm split, then the remaining notices.
	const infoCount = entries.filter((e) => e.level === "info").length;
	const inboxSummary = [
		error !== null ? "1 error" : null,
		warnings.length > 0
			? `${warnings.length} warning${warnings.length === 1 ? "" : "s"}`
			: null,
		alarmCount > 0 ? alarmLine : null,
		infoCount > 0 ? `${infoCount} notice${infoCount === 1 ? "" : "s"}` : null,
	]
		.filter((p) => p !== null)
		.join(" · ");
	const inboxTitle =
		inboxSummary === "" ? "Notifications" : `Notifications: ${inboxSummary}`;
	const inboxName = inbox.lit
		? `Notifications, ${inbox.fresh.length} new of ${inbox.total}`
		: inbox.total > 0
			? `Notifications, ${inbox.total}`
			: "Notifications, all clear";
	const stateLoaded = state !== null;
	const updateLoaded = update !== null;

	// An entry that cleared loses its acknowledgement, so a recurrence counts as new.
	useEffect(() => {
		if (!stateLoaded) return;
		setInboxSeen((prev) =>
			pruneSeen(
				prev,
				new Set(JSON.parse(inboxSig) as string[]),
				(k) => !updateLoaded && k.startsWith("behind:"),
			),
		);
	}, [inboxSig, stateLoaded, updateLoaded]);

	// Opening the inbox acknowledges every entry it lists.
	useEffect(() => {
		if (!inboxOpen) return;
		const add = (JSON.parse(inboxSig) as string[]).filter(
			(k) => !inboxSeen.has(k),
		);
		if (add.length === 0) return;
		setInboxFresh((p) => new Set([...p, ...add]));
		setInboxSeen(new Set([...inboxSeen, ...add]));
	}, [inboxOpen, inboxSig, inboxSeen]);

	// Acknowledgements persist across tabs and reloads.
	useEffect(() => saveInboxSeen(inboxSeen), [inboxSeen]);

	// N opens New task for the open project; inert while typing or any modal is up.
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key !== "n" && e.key !== "N") return;
			if (e.ctrlKey || e.metaKey || e.altKey) return;
			if (composeFor !== null || selectedId !== null || showAdd) return;
			if (
				e.target instanceof HTMLElement &&
				e.target.closest("input, textarea, select, [contenteditable]")
			)
				return;
			if (project === null || project.gitless) return;
			e.preventDefault();
			setComposeFor(project.name);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [project, composeFor, selectedId, showAdd]);

	// B opens the draft mask for the open project; inert while typing or any modal is up.
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key !== "b" && e.key !== "B") return;
			if (e.ctrlKey || e.metaKey || e.altKey) return;
			if (draftFor !== null) return;
			if (composeFor !== null || selectedId !== null || showAdd) return;
			if (
				e.target instanceof HTMLElement &&
				e.target.closest("input, textarea, select, [contenteditable]")
			)
				return;
			if (project === null || project.gitless) return;
			e.preventDefault();
			setDraftFor(project.name);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [project, draftFor, composeFor, selectedId, showAdd]);

	// The gate is a full page, not an overlay: no board renders behind it.
	if (gate !== null) return <AuthPage mode={gate} version={bootVersion} />;

	return (
		<>
			<header className="bar">
				<button
					type="button"
					className="icon areas-toggle"
					popoverTarget="areas-pop"
					title="Projects"
					aria-label="Projects"
				>
					<Icon name="grid" />
				</button>
				<div
					id="areas-pop"
					popover="auto"
					className="popover notif-pop areas-pop"
				>
					<AreasNav
						projects={projects}
						tasks={tasks}
						project={project}
						view={view}
						onAdd={() => setShowAdd(true)}
					/>
				</div>
				<a className="brand" href="/">
					<img src={logo} alt="" />
					<span>Ottr</span>
				</a>
				{state !== null && (
					<SystemBar
						tasks={tasks}
						maxTotal={state.maxTotal}
						quota={state.quota}
					/>
				)}
				{checkProject !== null && (
					<button
						type="button"
						className="icon"
						title="Check the board with the check-ottr-board skill (dev tool)"
						aria-label="Check the board"
						onClick={() =>
							void act(async () => {
								const card = await post<{ id: string }>(
									`/api/projects/${encodeURIComponent(checkProject)}/board-check`,
									{},
								);
								openTask(card.id);
							})
						}
					>
						<Icon name="activity" />
					</button>
				)}
				<button
					type="button"
					className={inbox.lit ? "icon inbox lit" : "icon inbox"}
					data-level={inbox.level ?? undefined}
					popoverTarget="inbox"
					title={inboxTitle}
					aria-label={inboxName}
				>
					<Icon name="bell" />
					{inbox.level !== null && inbox.level !== "info" && (
						<Mark key={inbox.level} kind={inbox.level} />
					)}
					{inbox.total > 0 && (
						<span className="inbox-n">
							{inbox.lit ? inbox.fresh.length : inbox.total}
							{inbox.lit && <span className="inbox-new"> new</span>}
						</span>
					)}
				</button>
				<span className="sr" role="status">
					{inbox.fresh.length > 0
						? `${inbox.fresh.length} new notification${inbox.fresh.length === 1 ? "" : "s"}`
						: ""}
				</span>
				<div
					id="inbox"
					popover="auto"
					className="popover notif-pop inbox-pop"
					onToggle={(e) => {
						const open = e.newState === "open";
						setInboxOpen(open);
						if (open) setInboxFresh(new Set());
					}}
				>
					{critLine !== null && (
						<section>
							<h2>Critical</h2>
							{critLine}
						</section>
					)}
					{alarmList}
					{updatesKey !== null && (
						<section>
							<h2>Upstream updates</h2>
							<ul className="alarm-list">
								<li>
									<button
										type="button"
										className="alarm-link"
										onClick={() => {
											document.getElementById("inbox")?.hidePopover();
											setShowUpdates(true);
										}}
									>
										<Icon name="download" size={14} />
										<span className="alarm-title">
											{updateCount} update
											{updateCount === 1 ? "" : "s"} ready to review
										</span>
										{inboxFresh.has(updatesKey) && (
											<span className="new-tag">New</span>
										)}
									</button>
								</li>
							</ul>
						</section>
					)}
					{infoLines !== null && (
						<section>
							<h2>Notices</h2>
							{infoLines}
						</section>
					)}
					{advisoryLines !== null && (
						<section>
							<h2>Advisories</h2>
							{advisoryLines}
						</section>
					)}
					{inbox.total === 0 && (
						<section>
							<h2>All clear</h2>
							<p className="hint">
								Tasks that need you, failed actions and Ottr notices appear
								here.
							</p>
						</section>
					)}
					{notificationsSupported() && (
						<div className="inbox-foot notify-toggle">
							<button
								type="button"
								className="theme-choice"
								aria-pressed={notify}
								title={
									notify
										? "Desktop notifications are on (hidden tabs only)"
										: "Notify me when a task needs me or is done"
								}
								onClick={toggleNotify}
							>
								<Icon name={notify ? "bell" : "bell-off"} size={14} />
								<span>Desktop notifications</span>
								{notify && <Icon name="check" size={14} />}
							</button>
						</div>
					)}
				</div>
				<button
					type="button"
					className="icon"
					popoverTarget="theme-pop"
					title="Theme"
					aria-label="Theme"
				>
					<Icon name="monitor" />
				</button>
				<div
					id="theme-pop"
					popover="auto"
					className="popover notif-pop theme-pop"
				>
					<h2>Theme</h2>
					{THEME_ORDER.map((t) => (
						<button
							key={t}
							type="button"
							className="theme-choice"
							aria-pressed={theme === t}
							onClick={() => {
								setTheme(t);
								document.getElementById("theme-pop")?.hidePopover();
							}}
						>
							<Icon name={THEME_META[t].icon} size={14} />
							<span>
								{t === "system"
									? `${THEME_META[t].label} (${THEME_META[sysLight ? "light" : "dark"].label})`
									: THEME_META[t].label}
							</span>
							{theme === t && <Icon name="check" size={14} />}
						</button>
					))}
				</div>
				{state?.user != null && (
					<button
						type="button"
						className="icon"
						title={`Log out ${state.user}`}
						aria-label={`Log out ${state.user}`}
						// act surfaces a failed POST as an error and leaves the button usable;
						// only a confirmed logout sets the gate flag and reloads.
						onClick={() => void act(logOut)}
					>
						<Icon name="log-out" />
					</button>
				)}
			</header>

			<div className="shell">
				<nav className="areas" aria-label="Projects">
					<AreasNav
						projects={projects}
						tasks={tasks}
						project={project}
						view={view}
						onAdd={() => setShowAdd(true)}
					/>
				</nav>

				<main className="main">
					{state === null ? (
						<p className="loading" role="status">
							<span className="spinner" aria-hidden="true" />
							Loading board…
						</p>
					) : settingsRoute.onSettings ? (
						<SettingsPage
							projects={projects}
							tasks={tasks}
							maxTotal={state.maxTotal}
							reviewCheck={state.reviewCheck}
							workCheck={state.workCheck}
							act={act}
							view={view}
						/>
					) : project === null ? (
						<Overview
							projects={projects}
							tasks={tasks}
							compose={setComposeFor}
							onAdd={() => setShowAdd(true)}
							openTask={openTask}
						/>
					) : (
						<ProjectBoard
							key={project.name}
							project={project}
							tasks={tasks.filter((t) => t.project === project.name)}
							deltas={deltas}
							open={openTask}
							seenAnswers={seenAnswers}
							compose={() => {
								if (project.gitless) return;
								setComposeFor(project.name);
							}}
							composeDraft={() => {
								if (project.gitless) return;
								setDraftFor(project.name);
							}}
							act={act}
							onNotice={setNotice}
							draining={draining}
						/>
					)}
				</main>
			</div>

			{projects.map((p) => (
				<NewTaskDialog
					key={p.name}
					project={p}
					open={composeFor === p.name}
					onClose={() => setComposeFor(null)}
					act={act}
				/>
			))}

			{projects.map((p) => (
				<BacklogDialog
					key={p.name}
					project={p}
					open={draftFor === p.name}
					onClose={() => setDraftFor(null)}
					act={act}
				/>
			))}

			{drawerTask !== null && drawerProject !== null && (
				<Drawer
					key={drawerTask.id}
					open={selected !== null}
					task={drawerTask}
					project={drawerProject}
					delta={deltas.get(drawerTask.id)}
					tasks={tasks.filter((t) => t.project === drawerProject.name)}
					onOpenTask={openTask}
					draining={draining}
					usedTotal={usedTotal}
					maxTotal={state?.maxTotal ?? null}
					act={act}
					read={seenable(drawerTask) && seenAnswers.has(drawerTask.id)}
					onMarkUnread={() => {
						if (selected === null) return; // the deferred native close after an app-driven close
						void markUnread(selected);
						setSelectedId(null); // close so the board shows the card unread; onClose would re-mark it read
					}}
					onClose={() => {
						if (selected === null) return; // same deferred close; do not re-mark it read
						// An answer that landed while the drawer was open counts as read.
						markSeen(selected);
						setSelectedId(null);
					}}
					onFollowed={(id, from) => {
						origin.current = { id, from };
						setSelectedId(null); // close the drawer so the board shows the follow-up fly in
					}}
				/>
			)}

			{showAdd && (
				<AddProjectModal
					act={act}
					onClose={() => setShowAdd(false)}
					onAdded={(i) => setNotice(interviewMsg(i))}
				/>
			)}

			{showUpdates && (
				<UpdatesPanel
					updates={state?.updates ?? null}
					tasks={tasks}
					act={act}
					openTask={openTask}
					onClose={() => setShowUpdates(false)}
				/>
			)}

			{/* Server down kills the whole board, so the warning is a banner, not a bar notice. */}
			{offline && (
				<div className="conn-banner" role="status">
					<Mark kind="crit" />
					<span>Server connection lost. Retrying…</span>
				</div>
			)}
		</>
	);
}

// typeof document: true in the browser, false under bun test, so UI render tests
// can import this module without a DOM. (import.meta.main is undefined in a
// browser bundle, so it cannot drive this check.)
if (typeof document !== "undefined")
	createRoot(document.getElementById("root")!).render(<App />);
