import type {
	CSSProperties,
	ClipboardEvent as ReactClipboardEvent,
	DragEvent as ReactDragEvent,
	MouseEvent as ReactMouseEvent,
	ReactNode,
} from "react";
import {
	Fragment,
	memo,
	useCallback,
	useContext,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createRoot } from "react-dom/client";
import type { DeepenCheck, DeepenPointCheck } from "../deepen.ts";
import { defaultGitUsername } from "../githubHost.ts";
import { joinLevel, splitLevel, THINKING_LEVELS } from "../levels.ts";
import type { DeadSignIn } from "../login.ts";
import type { ModelOption } from "../models.ts";
import { shortKey, taskEntryKey } from "../notifications.ts";
import { derivedTaskPrefix } from "../prefix.ts";
import { parseReviewDraft } from "../prInline.ts";
import { commitDeltas } from "../progress.ts";
import {
	DEEPEN_POINTS,
	IMPLEMENT_RECOMMENDATIONS,
	isProposalReason,
} from "../prompts.ts";
import { forModel, tightest, tightestFor } from "../quota.ts";
import { missingByUse, type SkillUse } from "../requiredSkills.ts";
import {
	type DepIndex,
	type DepProject,
	findDep,
	liveCardOf,
	queueOrder,
	waitingOn,
} from "../scheduler.ts";
import {
	type AddProjectResponse,
	APPROVE_REPLY,
	type AskQuestion,
	askAnswerLine,
	doneReadKey,
	type GhStatus,
	type KeptChoice,
	MERGE_HOLD_MISMATCH_REASON,
	type OrphanProcess,
	PERF_RANGES,
	type PerfMetrics,
	type PerfRange,
	type PerfResponse,
	type PerfStat,
	PRIORITIES,
	type ProjectView,
	type ProvisioningResponse,
	type PrReviewView,
	type QuotaState,
	REVIEW_BODY_MAX,
	type ReleasePlan,
	type RestartWaitView,
	recommendsSteps,
	type SeedFailedView,
	type Stage,
	type StateResponse,
	type SystemCard,
	type SystemPoint,
	type SystemSnapshot,
	type TaskCard,
	type TaskView,
	type TurnUsage,
	type TurnView,
	UPDATE_HOLD_REASON,
	type UpdateRow,
	type UpdatesView,
	VERSION_RE,
} from "../types.ts";
import type { UpdateCycleView } from "../updateCycle.ts";
import { mapRepo } from "../updates.ts";
import {
	type AttachedImage,
	type AttachedImages,
	readPicks,
} from "./attach.ts";
import {
	type DiffSection,
	diffLinkParts,
	lineDiff,
	numberDiffLines,
	pickDiffSections,
	splitDiffSections,
} from "./diff.ts";
import type { CardPos } from "./flight.ts";
import { freshTaskIds, listSlides, stageFlights } from "./flight.ts";
import logo from "./icon-192.png";
import {
	JiraBoardImportButton,
	JiraBoardImportDialog,
	JiraImportButton,
	JiraImportDialog,
} from "./jiraImport.tsx";
import {
	type Act,
	BAND_LIMIT,
	BusyButton,
	type BusyState,
	CloseButton,
	clamp,
	confirmDialog,
	copyText,
	EditConflict,
	Help,
	Icon,
	type IconName,
	interviewMsg,
	LiveElapsed,
	LOGOUT_KEY,
	loadLevel,
	logOut,
	Mark,
	Meter,
	Modal,
	ProjectLogo,
	ProjectTag,
	post,
	postEdit,
	projectLabel,
	repoSlug,
	Skeleton,
	unwrap,
	useBusy,
	useDelayedState,
	useFlash,
	useInstantSave,
	useOptimisticValue,
	useQuota,
	windowGone,
	ZoomableImage,
} from "./kit.tsx";
import { Markdown } from "./markdown.tsx";
import { loadMermaid } from "./mermaid.ts";
import {
	type ModelMenu,
	ModelMenuBody,
	ModelMenuTrigger,
	useModelMenu,
} from "./model-menu.tsx";
import {
	displayModel,
	type ModelCatalog,
	modelMatches,
	modelRows,
	reviewModel,
	useModels,
} from "./models.ts";
import {
	alatePendingEntry,
	clearAskDraft,
	clearComposeDraft,
	type InboxEntry,
	type InboxLevel,
	inboxView,
	loadAskDrafts,
	loadComposeDraft,
	loadSeenAnswers,
	pruneAskDrafts,
	SEEN_KEY,
	saveAskDraft,
	saveComposeDraft,
	seenToDrop,
} from "./notify.ts";
import { fmtNum } from "./numbers.ts";
import {
	autoMarkOnOpen,
	canMarkUnread,
	donePage,
	doneReadable,
	dropBeforeId,
	isUnread,
	laneCounts,
	laneOrder,
	laneStage,
	onBoard,
	railTop,
	reorderIds,
	researchSteps,
	SLOT_STAGES,
	type SlotCounts,
	seenable,
	slotUse,
} from "./queue.ts";
import {
	historyTask,
	migrateHash,
	navClick,
	projectPath,
	readPath,
	SETTINGS_HASH,
	SYSTEM_VIEW,
	settingsNavigate,
	settingsPath,
	settingsSub,
	taskPath,
	viewPath,
} from "./route.ts";
import {
	alateHint,
	asError,
	asTrust,
	type GitHostsView,
	gitReq,
	HostedContext,
	hostedHidden,
	openSettingsSection,
	type PendingKeyInfo,
	PendingKeyRow,
	ProjectSetupSteps,
	SETTINGS_TOC,
	SettingsPage,
	SetupWizardModal,
	SshTestRow,
	type TestAnswer,
	type TrustNeeded,
} from "./settings.tsx";
import {
	connectLive,
	connectPolling,
	latestSystem,
	liveEvents,
	refreshState,
} from "./socket.ts";
import {
	alarmLabel,
	cardMark,
	holdFor,
	holdLeft,
	reReleaseOf,
	splitAlarms,
	statusLine,
	strykerProgress,
	strykerStats,
} from "./status.ts";
import { workSteps } from "./steps.ts";
import { age, duration, landed, stamp, turnDuration, until } from "./time.ts";
import { turnLogStart } from "./turnlog.ts";
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

/** The gate after a lost-session check: login, except on a board still in setup. A fresh board
 *  has no admin yet, so its walled /api/state answers 401 too; showing login there would strand
 *  the user (the socket's onOffline check raced the boot's "setup"). */
export const gateAfterLostSession = (
	g: "setup" | "login" | null,
): "setup" | "login" => (g === "setup" ? g : "login");
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
	icon = "image",
}: {
	onAdd: (files: Iterable<File>) => void;
	/** The steer composer's icon-only button shows a plus (the chat-app "add" glyph). */
	icon?: IconName;
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
				<Icon name={icon} />
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
 * bar with Add image at its left edge; `primary` is the form's submit — stock grey when a
 * decision section owns the loud slot (one primary per surface, DESIGN.md → Buttons). */
function ComposerActions({
	onAddImages,
	catalog,
	model,
	setModel,
	modelQuery,
	setModelQuery,
	onModelMenuOpen,
	modelConflict,
	secondary,
	primary,
	attachIcon,
}: {
	onAddImages: (files: Iterable<File>) => void;
	catalog: ModelCatalog | null;
	model: string;
	setModel: (m: string) => void;
	modelQuery: string;
	setModelQuery: (q: string) => void;
	/** Fires when the model menu opens (OTTR-795: the drawer captures the card revision there). */
	onModelMenuOpen?: () => void;
	modelConflict?: { current: string | null } | null;
	secondary?: ReactNode;
	primary: ReactNode;
	/** Glyph of the Add image button (the steer composer uses "plus"). */
	attachIcon?: IconName;
}) {
	return (
		<div className="composer-actions">
			<ModelField
				catalog={catalog}
				model={model}
				setModel={setModel}
				modelQuery={modelQuery}
				setModelQuery={setModelQuery}
				onOpen={onModelMenuOpen}
				conflict={modelConflict}
			/>
			<div className="composer-bar">
				<ImageBrowseButton onAdd={onAddImages} icon={attachIcon} />
				{secondary}
				{primary}
			</div>
		</div>
	);
}

/** The shared text+image input behind New task, Reply/follow-up and Steer: paste, drop or browse images. */
function PromptInput({
	label,
	labelExtra,
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
	/** Rendered inside the label after its text; the deepen composers put the Help badge here. */
	labelExtra?: ReactNode;
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
			<label htmlFor={id}>
				{label}
				{labelExtra}
			</label>
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

/** A parsed mutation-progress line, the shape strykerProgress returns; null when the card has none. */
type MutationProgress = {
	tool: string;
	pct: number;
	tested: number;
	total: number;
	rest: string;
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

/** Render probe for tests: a test sets `fn` to count Card renders; a memoized Card that skips
 * its render never calls it. Production never sets it, so the call stays a no-op on the board. */
export const cardRenderProbe: { fn: (() => void) | null } = { fn: null };

/** The card shell's class: drag state, drop marker, reorder lock. */
function cardClass(
	drag: CardDrag | undefined,
	locked: boolean | undefined,
): string {
	return `card${drag?.dragging ? " dragging" : ""}${drag?.dropBefore ? " drop-before" : ""}${locked ? " reorder-lock" : ""}`;
}

/** Values derived once per card render; plain reads of `task`, no hooks. */
function cardDerived(task: TaskCard): {
	sp: MutationProgress | null;
	spLeft: string | null;
	silent: string | null;
	commits: number | null;
	held: string | null;
} {
	const commits = task.stage === "done" ? task.commits : null;
	const sp = task.state === "running" ? strykerProgress(task.progress) : null;
	// The card shows only the percent and the time left; the full line stays in the tooltip.
	const spLeft =
		sp === null
			? null
			: (strykerStats(sp.rest).find((x) => x.label === "Left")?.value ?? null);
	const silent =
		task.silentSince !== undefined
			? `No output for ${duration(Date.now() - task.silentSince)}: the agent may wait on a hung command. Steer, stop or cancel the card.`
			: null;
	// A usage-limit hold names its holder on the face ("held · zai limit · 1d 0h left") and
	// keeps the full reason one hover away; the sr line reads it out. null = not held now.
	const held =
		sp === null &&
		task.runStartedAt === undefined &&
		task.state === "queued" &&
		task.needsReason !== null &&
		task.holdUntil !== null
			? holdLeft(task.holdUntil, Date.now(), task.needsReason)
			: null;
	return { sp, spLeft, silent, commits, held };
}

/** A retro proposal waiting for the operator's decision: not started, never an error. */
function isProposalCard(
	task: Pick<TaskCard, "state" | "cancelledAt" | "needsReason">,
): boolean {
	return (
		task.state === "needs_you" &&
		task.cancelledAt === null &&
		isProposalReason(task.needsReason)
	);
}

/** The card's top line: mark, id, unread/research/cancelled flags, main-loop model. A
 *  proposal takes the grey queued ring: it waits like a card not started yet. */
function cardHead(
	task: TaskCard,
	unread: boolean,
	catalog: ModelCatalog | null,
	proposal: boolean,
): ReactNode {
	return (
		<span className="card-head">
			{task.starred && task.cancelledAt === null ? (
				// A starred report: the star stands in for the done check; the drawer's
				// icon button toggles it, the card carries only the state.
				<Mark kind="star" />
			) : (
				<Mark kind={proposal ? "queued" : cardMark(task)} />
			)}
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
			{cardModel(task, catalog)}
		</span>
	);
}

/** The main-loop model chip; pinned to the head's top right without the provider or the
 *  thinking effort — the tooltip keeps the full id with its level. */
function cardModel(task: TaskCard, catalog: ModelCatalog | null): ReactNode {
	if (task.stage === "done") return null;
	const model = task.model ?? task.lastModel ?? "default";
	return (
		<span
			className="model"
			title={`Main loop model: ${model}${task.model === null && task.lastModel ? " (last run)" : ""}`}
		>
			{displayModel(catalog?.models ?? [], splitLevel(model)[0])}
		</span>
	);
}

/** The line under the title: the needs-you reason, a silence warning, or the original title.
 *  Needs attention: the error takes the prompt line until the state clears; the card-open
 *  title also carries it. Ask rounds keep the prompt: their reason just echoes the first
 *  question the drawer's ask panel shows in full. A live turn whose log went silent past
 *  the board's limit takes the same line as .card-silent — grey, it reports, it does not
 *  alarm. A PR review waiting for its Post is no error either, so its reason takes the
 *  grey line too. */
function cardErrorLine(task: TaskCard, silent: string | null): ReactNode {
	if (
		task.state === "needs_you" &&
		task.asked === null &&
		task.needsReason !== null
	) {
		return (
			<span
				className={
					task.kind === "pr_review" ? "card-error card-silent" : "card-error"
				}
				title={task.needsReason}
			>
				{task.needsReason}
			</span>
		);
	}
	if (silent !== null) {
		return (
			<span className="card-error card-silent" title={silent}>
				{silent}
			</span>
		);
	}
	if (task.sessionTitle !== task.title) {
		return (
			<span className="card-original" title={task.title}>
				{task.title}
			</span>
		);
	}
	return null;
}

/** The meta title: cancelled, done, or created stamp. */
function cardMetaTitle(task: TaskCard): string {
	return stamp(
		task.cancelledAt ??
			(task.stage === "done" && task.doneAt !== null
				? task.doneAt
				: task.createdAt),
	);
}

/** The card's age item: landed stamp, live elapsed, or age. */
function cardMetaAge(
	task: TaskCard,
	sp: MutationProgress | null,
	status: string | undefined,
): ReactNode {
	if (task.cancelledAt !== null) return landed(task.cancelledAt);
	if (task.stage === "done" && task.doneAt !== null) return landed(task.doneAt);
	if (task.runStartedAt !== undefined) {
		return (
			<LiveElapsed
				since={task.runStartedAt}
				status={sp === null ? status : null}
				etaMs={sp === null ? task.etaMs : undefined}
			/>
		);
	}
	return age(task.createdAt);
}

/** The status item after the age: the live status words, or a hold label with its reason. */
function cardMetaStatus(
	task: TaskCard,
	status: string | undefined,
	sp: MutationProgress | null,
	held: string | null,
): ReactNode {
	if (sp !== null || task.runStartedAt !== undefined) return null;
	if (held !== null && task.needsReason !== null) {
		// One flex item (.card-meta wraps between items): the separator rides
		// inside the label, so a wrap never strands a lone "·" at a line end.
		return (
			<span title={task.needsReason}>
				{"·\u00A0"}
				{held}
				<span className="sr">{task.needsReason}</span>
			</span>
		);
	}
	return <>· {status}</>;
}

/** The commit count chip with its delta. */
function cardCommits(
	commits: number | null,
	delta: number | undefined,
): ReactNode {
	if (commits === null) return null;
	return (
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
	);
}

/** A stalled release card's held-merges note. */
function cardHold(
	reRelease: { ids: string[]; findings: number } | null | undefined,
): ReactNode {
	if (reRelease == null) return null;
	return (
		<span
			className="card-hold"
			title={`Held merges: ${reRelease.ids.join(", ")}`}
		>
			All {reRelease.findings} findings are done. {reRelease.ids.length} merges
			wait for this release: {reRelease.ids.join(", ")}.
		</span>
	);
}

/** The live mutation-progress chip with its dotted rail. The card's left edge is the
 *  progress: a dotted rail, filled bottom-up with the percent. One --p var drives the
 *  fill's scaleY and the end dot's translateY. */
function cardMutation(
	task: TaskCard,
	sp: ReturnType<typeof strykerProgress>,
	spLeft: string | null,
): ReactNode {
	if (sp === null) return null;
	return (
		<span className="card-mutation" title={task.progress ?? undefined}>
			Mutation <span className="card-mutation-value">{sp.pct}%</span>
			{spLeft !== null && ` · ${spLeft} left`}
			<span
				className="mutation-rail"
				aria-hidden="true"
				style={{ "--p": clamp(sp.pct, 0, 100) / 100 } as CSSProperties}
			>
				<i />
				<b />
			</span>
		</span>
	);
}

/** The card tags row: PR link, hold link, re-release button, release link; null renders none. */
function cardTags(
	task: TaskCard,
	github: string | null,
	release: string | null,
	holdRelease: { id: string; version: string | null } | null | undefined,
	onOpenTask: ((id: string) => void) | undefined,
	onRerelease: ((id: string) => void) | undefined,
): ReactNode {
	if (
		task.prNumber === null &&
		release === null &&
		holdRelease == null &&
		onRerelease === undefined
	) {
		return null;
	}
	return (
		<span className="card-tags">
			{task.prNumber !== null &&
				(task.prUrl !== null ? (
					<a
						className="pr-link"
						href={task.prUrl}
						target="_blank"
						rel="noopener noreferrer"
						title={`Open PR #${task.prNumber} on GitHub`}
						aria-label={`PR #${task.prNumber} on GitHub (opens a new tab)`}
					>
						PR #{task.prNumber}
					</a>
				) : (
					<span className="pr-link" title={`PR #${task.prNumber}`}>
						PR #{task.prNumber}
					</span>
				))}
			{holdRelease != null && onOpenTask !== undefined && (
				<a
					className="hold-link"
					href={taskPath(task.project, holdRelease.id)}
					title={`Task ${holdRelease.id}: the release holding this card${holdRelease.version !== null ? ` (${holdRelease.version})` : ""}`}
					onClick={(e) => {
						// The card body is a stretched open link: keep the click off it.
						e.stopPropagation();
						navClick(e, () => onOpenTask(holdRelease.id));
					}}
				>
					<Icon name="corner-up-left" size={12} />
					{holdRelease.id}
				</a>
			)}
			{onRerelease !== undefined && (
				<button
					type="button"
					className="hold-link"
					title={`Cancel release ${task.releaseVersion ?? ""} and open Create release`}
					onClick={(e) => {
						// The card body is a stretched open button: keep the click off it.
						e.preventDefault();
						e.stopPropagation();
						onRerelease(task.id);
					}}
				>
					<Icon name="corner-up-left" size={12} />
					Release again
				</button>
			)}
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
		</span>
	);
}

/** A proposal card's Decide chip beside the card tags: it opens the drawer, where the
 *  decision panel sits on top. Same click rules as the hold-link chips. The caller renders
 *  it only for a proposal card (isProposalCard). */
function cardDecide(task: TaskCard, onOpen: (id: string) => void): ReactNode {
	return (
		<span className="card-tags">
			<button
				type="button"
				className="decide-link"
				title="Accept, edit or cancel this proposal"
				onClick={(e) => {
					// The card body is a stretched open link: keep the click off it.
					e.stopPropagation();
					onOpen(task.id);
				}}
			>
				Decide
			</button>
		</span>
	);
}

const Card = memo(function Card({
	task,
	github,
	onOpen,
	unread,
	delta,
	fuOf,
	drag,
	hold,
	status,
	locked,
	holdRelease,
	onOpenTask,
	reRelease,
	onRerelease,
}: {
	task: TaskCard;
	github: string | null;
	/** Opens this card's drawer; stable across frames, so memoized cards keep it. */
	onOpen: (id: string) => void;
	unread: boolean;
	delta?: number;
	fuOf?: string | null;
	drag?: CardDrag;
	/** Why the tracker holds this queued card (a merge: a live review or its findings; a todo: its
	 * unfinished dependencies); null or undefined otherwise. */
	hold?: string | null;
	/** The card's status words (statusLine over the project's cards), computed once per lane
	 * render; undefined renders none. */
	status?: string;
	/** A reorder request for this card is in flight; the card dims and cannot start another drag. */
	locked?: boolean;
	/** The release card whose heldMerges list names this card; null or undefined otherwise. */
	holdRelease?: { id: string; version: string | null } | null;
	/** Opens another card's drawer; the hold link chip uses it to name the release. */
	onOpenTask?: (id: string) => void;
	/** A stalled release card's re-release view: findings done, merges waiting. Null otherwise. */
	reRelease?: { ids: string[]; findings: number } | null;
	/** Cancels the release card this id names and opens Create release; set only while
	 * reRelease is non-null. */
	onRerelease?: (id: string) => void;
	/** Bumped every 30 s so the relative ages on unchanged cards keep ticking; a memoized
	 * card skips pushed frames it is unchanged in, so the tick is its only time refresh. */
	tick?: number;
}) {
	cardRenderProbe.fn?.();
	// The model chip names the model as omp does (display name); one cached catalog serves every card.
	const catalog = useModels();
	const release = releaseOf(task);
	const { sp, spLeft, silent, commits, held } = cardDerived(task);
	const proposal = isProposalCard(task);
	return (
		// A stretched link opens the card; the release link sits beside it, never nested in it.
		// biome-ignore lint/a11y/noStaticElementInteractions: HTML5 drag-and-drop on the card shell; keyboard users act through the stretched link inside
		<div
			className={cardClass(drag, locked)}
			data-state={task.state}
			data-task-id={task.id}
			data-stage={task.stage}
			data-cancelled={task.cancelledAt !== null ? "" : undefined}
			data-proposal={proposal ? "" : undefined}
			data-asked={
				task.state === "needs_you" && task.asked !== null ? "" : undefined
			}
			data-unread={unread ? "" : undefined}
			data-held={hold ? "" : undefined}
			draggable={drag?.draggable}
			onDragStart={drag?.onDragStart}
			onDragEnd={drag?.onDragEnd}
		>
			<a
				className="card-open"
				href={taskPath(task.project, task.id)}
				// The card shell owns HTML5 drag-and-drop; the anchor must not start a link drag.
				draggable={false}
				title={
					task.state === "needs_you"
						? (task.needsReason ?? "Action required")
						: undefined
				}
				onClick={(e) => navClick(e, () => onOpen(task.id))}
			>
				{cardHead(task, unread, catalog, proposal)}
				<span className="card-title">{task.sessionTitle ?? task.title}</span>
				{/* A proposal is a suggestion, not a fault: its reason stays in the tooltip and the
				    drawer's decision panel, never as the amber error line. */}
				{!proposal && cardErrorLine(task, silent)}
				{/* The two-way follow-up link names its parent on the card itself, like the
				    drawer's "Follow-up of" chip; a bare glyph made the name hover-only. */}
				{fuOf != null && (
					<span className="card-fu" title={`Follow-up of ${fuOf}`}>
						<Icon name="corner-up-left" size={12} />
						<span className="card-fu-title">
							{proposal ? `From ${fuOf}` : fuOf}
						</span>
					</span>
				)}
				<span className="card-meta" title={cardMetaTitle(task)}>
					{proposal && <span className="proposal-chip">Proposal</span>}
					{cardMetaAge(task, sp, status)}{" "}
					{proposal ? "· not started" : cardMetaStatus(task, status, sp, held)}
					{cardCommits(commits, delta)}
				</span>
				{cardHold(reRelease)}
				{cardMutation(task, sp, spLeft)}
			</a>
			{cardTags(task, github, release, holdRelease, onOpenTask, onRerelease)}
			{/* A proposal card gets a Decide chip beside the card tags: it opens the drawer,
			    where the decision panel sits on top. Same click rules as the hold-link chips. */}
			{proposal && cardDecide(task, onOpen)}
		</div>
	);
});

/** The System snapshot: pushed every 30 s over the board socket, polled from /api/system in
 *  production mode. Null until the first sample lands. */
function useSystem(): SystemSnapshot | null {
	const [system, setSystem] = useState<SystemSnapshot | null>(latestSystem);
	useEffect(() => {
		const onSystem = (e: Event): void => {
			setSystem((e as CustomEvent<SystemSnapshot>).detail);
		};
		liveEvents.addEventListener("system", onSystem);
		return () => liveEvents.removeEventListener("system", onSystem);
	}, []);
	return system;
}

/** The meters button's aria label; hosted mode names agents only. */
function systemMetersAria(
	hosted: boolean,
	used: number,
	waiting: number,
	quotaPct: number | null,
): string {
	return hosted
		? `${used} running, ${waiting} waiting. Agent details`
		: `${used} running, ${waiting} waiting, quota ${quotaPct === null ? "n/a" : `${Math.round(quotaPct)}%`}. Agent and quota details`;
}

/** The quota group inside the meters button: the tightest limit's twin bar and percent.
 *  Hosted mode never renders it: provider quota is the operator's concern there. */
function systemQuotaGrp(
	tightest: QuotaState["limits"][number] | null,
	quotaLevel: string,
	quotaPct: number | null,
	quotaGone: number | null,
): ReactNode {
	return (
		<>
			<span className="sb-sep" aria-hidden="true" />
			<span
				className="sb-grp"
				title={
					tightest === null
						? undefined
						: `Tightest limit: ${tightest.provider} ${tightest.label}, ${tightest.usedPct}% used${quotaGone === null ? "" : `, ${Math.round(quotaGone)}% of the window gone`}`
				}
			>
				<span className="sb-lbl sb-hide-phone">Quota</span>
				{tightest !== null && <QuotaTwin limit={tightest} />}
				<span className="sb-val" data-level={quotaLevel}>
					{quotaLevel === "high" && <Mark kind="needs" />}
					{quotaLevel === "crit" && <Mark kind="crit" />}
					{quotaPct === null ? "n/a" : `${Math.round(quotaPct)}%`}
				</span>
			</span>
		</>
	);
}

/** The Agents section of the System popover: running, merging, waiting and the slot cap. */
function systemAgents(
	slots: SlotCounts,
	maxTotal: number | null,
	used: number,
	waiting: number,
): ReactNode {
	return (
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
	);
}

/** One quota window row: its time-over-quota twin bars, percent and reset stamp. */
function quotaRow(l: QuotaState["limits"][number]): ReactNode {
	const gone = windowGone(l, Date.now());
	return (
		<div key={l.label} className="qt-row" data-level={loadLevel(l.usedPct)}>
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
			<span className="qt-val">{Math.round(l.usedPct)} %</span>
			<span
				className="qt-reset"
				title={l.resetsAt === null ? undefined : `Resets ${stamp(l.resetsAt)}`}
			>
				{l.resetsAt === null ? "–" : until(l.resetsAt)}
			</span>
		</div>
	);
}

/** The Provider quota section of the System popover; one row per window per provider.
 *  One row per window: a thin time line over the quota bar, so a quota bar longer than
 *  its time line means the window burns faster than it runs. */
function systemQuotaSection(quota: QuotaState | null): ReactNode {
	return (
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
									{limits.map((l) => quotaRow(l))}
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
	);
}

/** Overview indicators in the app bar; the button opens the detail popover (agents and quota).
 *  While any container warns, a warning link to the System view sits beside the button. */
function SystemBar({
	tasks,
	maxTotal,
	quota,
	navigate,
	hosted,
}: {
	tasks: TaskCard[];
	maxTotal: number | null;
	quota: QuotaState | null;
	/** Plain-click navigation to a view path (see navClick). */
	navigate: (path: string) => void;
	/** Hosted mode has no System view, so no warning link. */
	hosted: boolean;
}) {
	const system = useSystem();
	const catalog = useModels();
	const slots = slotUse(tasks);
	const used = SLOT_STAGES.reduce((n, s) => n + slots[s], 0);
	const waiting = queueOrder(tasks).length;
	// The bar tracks the default model's provider: that is the quota that stops agents first.
	const tightest = tightestFor(
		quota?.limits ?? [],
		catalog?.defaultModel ?? null,
	);
	const quotaPct = tightest?.usedPct ?? null;
	const quotaLevel = loadLevel(quotaPct);
	const quotaGone = tightest === null ? null : windowGone(tightest, Date.now());
	// One line per warning container, its first reason only: the System view lists them all.
	const warned = (system?.containers ?? [])
		.filter((c) => c.warnings.length > 0)
		.map((c) => `${c.name} ${c.warnings[0]}`)
		.join("; ");
	return (
		<>
			{/* Quiet line: the running count first, then the tightest quota as a time-over-quota
			    twin bar. Every number lives in the popover. */}
			<button
				type="button"
				className="meters"
				popoverTarget="system-detail"
				aria-label={systemMetersAria(hosted, used, waiting, quotaPct)}
				title={hosted ? "Agent details" : "Agent and quota details"}
			>
				<span className="sb-grp">
					<Mark kind="running" />
					<span className="sb-big">{used}</span>
					{/* role=status, mounted even at zero: a live region must exist before a change
					    for screen readers to announce the 0→1 step. */}
					<span className="sb-lbl sb-hide-phone" role="status">
						{waiting > 0 ? `+${waiting} waiting` : "running"}
					</span>
				</span>
				{/* Hosted mode: provider quota is the operator's concern, so the bar and the
				    popover show agents only. */}
				{!hosted && systemQuotaGrp(tightest, quotaLevel, quotaPct, quotaGone)}
			</button>
			<div id="system-detail" popover="auto" className="popover">
				{/* Order by urgency: agents first (big figures, no table to read), quota second.
				    Running counts preparing todo slots too. */}
				{systemAgents(slots, maxTotal, used, waiting)}
				{!hosted && systemQuotaSection(quota)}
			</div>
			{/* Outside the meters button: a link cannot nest in a button. Rendered only while a
			    container warns, so the bar stays grey at rest. */}
			{warned !== "" && !hosted && (
				<a
					className="sb-warn"
					href={viewPath(SYSTEM_VIEW)}
					aria-label={`System warning: ${warned}`}
					title={`System warning: ${warned}`}
					onClick={(e) => navClick(e, navigate)}
				>
					<Mark kind="needs" />
				</a>
			)}
		</>
	);
}

const HOUR_MS = 3_600_000;

/** Bytes as GiB with one decimal: every System memory figure uses this one unit. */
function gib(bytes: number): string {
	return (bytes / 1024 ** 3).toFixed(1);
}

/** A turn's CPU time in the largest unit that keeps it short: "42 s", "17 min", "2.5 h". */
function cpuTime(sec: number): string {
	if (sec < 60) return `${Math.round(sec)} s`;
	if (sec < 3600) return `${Math.round(sec / 60)} min`;
	return `${(sec / 3600).toFixed(1)} h`;
}

/** A turn's usage line as figures that never break inside: the line wraps only between them. */
function turnUsageParts(u: TurnUsage): string[] {
	return [
		`${gib(u.mem)} GiB`,
		`peak ${gib(u.memPeak)} GiB`,
		`${u.cpuPct === null ? "n/a" : `${Math.round(u.cpuPct)} %`} CPU`,
		`${cpuTime(u.cpuSec)} CPU time`,
	];
}

/** "15:04": the time of day for the System view's since and until stamps. */
function clockTime(ms: number): string {
	return new Date(ms).toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	});
}

/** One hour of a System row as a small line chart. A null point (unreachable, unreadable)
 *  breaks the line, so an outage reads as a gap and never as zero. The y scale runs to the
 *  row's ceiling (its CPU share, its memory limit) when known, so a full chart means full. */
function Sparkline({
	history,
	pick,
	end,
	ceiling,
	label,
	format,
}: {
	history: SystemPoint[];
	pick: (p: SystemPoint) => number | null;
	/** The snapshot's time: the chart's right edge, one hour after its left edge. */
	end: number;
	ceiling: number | null;
	/** The accessible name's lead, e.g. "CPU last hour". */
	label: string;
	format: (v: number) => string;
}) {
	const w = 120;
	const h = 24;
	const nums = history.map(pick).filter((v): v is number => v !== null);
	if (nums.length === 0)
		return (
			<svg
				className="spark"
				viewBox={`0 0 ${w} ${h}`}
				role="img"
				aria-label={`${label}: no data`}
			/>
		);
	const lo = Math.min(...nums);
	const hi = Math.max(...nums);
	// y runs over [0, top]; a zero top (all-idle hour) would divide by zero.
	const top = Math.max(ceiling ?? 0, hi, 0) || 1;
	// The 1.5px stroke stays inside the box: points sit `pad` in from the top and bottom edges.
	const pad = 1.5;
	// Consecutive non-null points form one run; each run is its own polyline.
	type Run = { at: number; xy: Array<[number, number]> };
	const runs: Run[] = [];
	let run: Run | null = null;
	for (const p of history) {
		const v = pick(p);
		if (v === null) {
			run = null;
			continue;
		}
		if (run === null) {
			run = { at: p.at, xy: [] };
			runs.push(run);
		}
		run.xy.push([
			clamp(w * (1 - (end - p.at) / HOUR_MS), 0, w),
			h - pad - (clamp(v, 0, top) / top) * (h - 2 * pad),
		]);
	}
	return (
		<svg
			className="spark"
			viewBox={`0 0 ${w} ${h}`}
			role="img"
			aria-label={`${label}: min ${format(lo)}, max ${format(hi)}`}
		>
			{runs.map(({ at, xy }) =>
				// A lone sample between two gaps has no line to draw: a dot marks it.
				xy.length === 1 ? (
					<circle key={at} cx={xy[0]?.[0]} cy={xy[0]?.[1]} r="1.5" />
				) : (
					<polyline
						key={at}
						points={xy
							.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
							.join(" ")}
					/>
				),
			)}
		</svg>
	);
}

/** A live run's card in the System view: a link that opens its drawer, like every card link
 *  on the board. The card's title rides the tooltip. */
function SystemCardLink({
	card,
	tasks,
	openTask,
}: {
	card: SystemCard;
	tasks: TaskCard[];
	openTask: (id: string) => void;
}) {
	const t = tasks.find((x) => x.project === card.project && x.id === card.id);
	return (
		<a
			href={taskPath(card.project, card.id)}
			title={t?.sessionTitle}
			onClick={(e) => navClick(e, () => openTask(card.id))}
		>
			{card.id}
		</a>
	);
}

/** A memory.events counter since the container started, plus its growth over the last hour. */
function eventCount(total: number | null, hour: number | null): ReactNode {
	if (total === null) return "n/a";
	return (
		<>
			{fmtNum(total)}
			{hour !== null && (
				<span className="sys-sub"> +{fmtNum(hour)} in 1 h</span>
			)}
		</>
	);
}

/** The System view at /system: one row per container (the server, then each worker), the
 *  Docker VM, and the board-wide holds. Containers and VM come from the 30 s System snapshot;
 *  the holds read the live board state with the top bar's own slotUse and queueOrder, so the
 *  two always show the same numbers. */
/** One container row of the System table: warn head, metrics or gap, turns, mutation lock. */
function containerRow(
	c: SystemSnapshot["containers"][number],
	tasks: TaskCard[],
	at: number,
	links: (cards: SystemCard[]) => ReactNode,
	openTask: (id: string) => void,
): ReactNode {
	const warn = c.warnings.length > 0;
	return (
		<tr key={c.name} data-warn={warn || undefined}>
			{containerWarnHead(c)}
			{c.reachable ? (
				containerMetrics(c, at)
			) : (
				<td colSpan={4} className="sys-gap">
					{c.unreachableSince === null
						? "not reachable"
						: `not reachable since ${clockTime(c.unreachableSince)}`}
				</td>
			)}
			{containerTurns(c, tasks, openTask)}
			{containerLock(c, links)}
		</tr>
	);
}

/** A container row's first cell: name, warning mark, and the warning reasons in text —
 *  amber alone never carries a warning. */
function containerWarnHead(c: SystemSnapshot["containers"][number]): ReactNode {
	const warn = c.warnings.length > 0;
	return (
		<th scope="row">
			<span className="sys-name">
				{warn && <Mark kind="needs" />}
				{c.name}
			</span>
			{warn && (
				<ul className="sys-warns">
					{c.warnings.map((w) => (
						<li key={w}>{w}</li>
					))}
				</ul>
			)}
		</th>
	);
}

/** A reachable container's CPU and memory cells with their sparklines, then the event counts. */
function containerMetrics(
	c: SystemSnapshot["containers"][number],
	at: number,
): ReactNode {
	return (
		<>
			<td data-label="CPU">
				<div className="sys-metric">
					<span>
						{c.cpuPct === null ? "n/a" : `${Math.round(c.cpuPct)} %`}
						{c.cpuShare !== null && (
							<span className="sys-sub">
								{/* One decimal at most: "16", "1.5". */} of{" "}
								{Math.round(c.cpuShare * 10) / 10} CPUs
							</span>
						)}
					</span>
					<Sparkline
						history={c.history}
						pick={(p) => p.cpu}
						end={at}
						ceiling={c.cpuShare === null ? null : c.cpuShare * 100}
						label="CPU last hour"
						format={(v) => `${Math.round(v)} %`}
					/>
				</div>
			</td>
			<td data-label="Memory">
				<div className="sys-metric">
					<span>
						{c.memUsed === null
							? "n/a"
							: c.memLimit !== null && c.memLimit > 0
								? `${gib(c.memUsed)} / ${gib(c.memLimit)} GiB (${Math.round((c.memUsed / c.memLimit) * 100)} %)`
								: `${gib(c.memUsed)} GiB · no limit`}
					</span>
					<Sparkline
						history={c.history}
						pick={(p) => p.mem}
						end={at}
						ceiling={c.memLimit}
						label="Memory last hour"
						format={(v) => `${gib(v)} GiB`}
					/>
				</div>
			</td>
			<td data-label="Limit hits">
				{eventCount(c.memMaxHits, c.memMaxHitsHour)}
			</td>
			<td data-label="OOM kills">{eventCount(c.oomKills, c.oomKillsHour)}</td>
		</>
	);
}

/** A container's live-turns cell: none, or the turn list with each turn's usage figures. */
function containerTurns(
	c: SystemSnapshot["containers"][number],
	tasks: TaskCard[],
	openTask: (id: string) => void,
): ReactNode {
	if (c.cards.length === 0) {
		return (
			<td data-label="Turns">
				<span className="sys-sub">none</span>
			</td>
		);
	}
	return (
		<td data-label="Turns">
			{/* Largest memory first (the server's order): the turn to look at
			    when the container runs full leads the list. */}
			<ul className="sys-turns">
				{c.cards.map((t) => (
					<li key={`${t.project}/${t.id}`}>
						<SystemCardLink card={t} tasks={tasks} openTask={openTask} />
						{t.usage !== null && (
							<span className="sys-sub">
								{turnUsageParts(t.usage).map((part, i) => (
									<Fragment key={part}>
										{i > 0 && " · "}
										<span>{part}</span>
									</Fragment>
								))}
							</span>
						)}
					</li>
				))}
			</ul>
		</td>
	);
}

/** A container's mutation-lock cell: free or held, plus the waiting cards. */
function containerLock(
	c: SystemSnapshot["containers"][number],
	links: (cards: SystemCard[]) => ReactNode,
): ReactNode {
	return (
		<td data-label="Mutation lock">
			<span className="sys-cards">
				{!c.reachable ? (
					"n/a"
				) : c.lock.holderPid === null ? (
					"free"
				) : (
					<>
						<span>pid {c.lock.holderPid}</span>
						{c.lock.holderCard !== null && links([c.lock.holderCard])}
					</>
				)}
			</span>
			{c.lock.waiters.length > 0 && (
				<span className="sys-cards">
					<span className="sys-sub">{c.lock.waiters.length} waiting:</span>
					{links(c.lock.waiters)}
				</span>
			)}
		</td>
	);
}

function SystemView({
	state,
	openTask,
}: {
	state: StateResponse;
	openTask: (id: string) => void;
}) {
	const system = useSystem();
	const tasks = state.tasks;
	const slots = slotUse(tasks);
	const running = SLOT_STAGES.reduce((n, s) => n + slots[s], 0);
	const queue = queueOrder(tasks);
	const oldest = queue[0];
	const links = (cards: SystemCard[]): ReactNode =>
		cards.map((c) => (
			<SystemCardLink
				key={`${c.project}/${c.id}`}
				card={c}
				tasks={tasks}
				openTask={openTask}
			/>
		));
	return (
		<section className="system-view" aria-labelledby="system-title">
			<div>
				<h1 id="system-title">System</h1>
				{system === null ? (
					<p className="caption" role="status">
						Waiting for the first sample…
					</p>
				) : (
					<p className="caption">
						Sampled every 30 s, last at {clockTime(system.at)}. Charts show the
						last hour.
					</p>
				)}
			</div>
			{system !== null && (
				<section aria-labelledby="sys-containers">
					<h2 className="ov-sec" id="sys-containers">
						Containers
					</h2>
					{system.containers.length === 0 ? (
						<p className="caption">No container sampled yet.</p>
					) : (
						<div className="ov-wrap">
							<table className="sys">
								<caption className="sr">
									Containers: CPU and memory now and over the last hour, memory
									limit hits, OOM kills, live turns with each turn's memory and
									CPU, and the mutation lock
								</caption>
								<thead>
									<tr>
										<th scope="col">Container</th>
										<th scope="col">CPU</th>
										<th scope="col">Memory</th>
										<th scope="col">Limit hits</th>
										<th scope="col">OOM kills</th>
										<th scope="col">Turns</th>
										<th scope="col">Mutation lock</th>
									</tr>
								</thead>
								<tbody>
									{system.containers.map((c) =>
										containerRow(c, tasks, system.at, links, openTask),
									)}
								</tbody>
							</table>
						</div>
					)}
				</section>
			)}
			{system !== null && (
				<section aria-labelledby="sys-vm">
					<h2 className="ov-sec" id="sys-vm">
						Docker VM
					</h2>
					<dl className="sys-kv">
						<div>
							<dt>CPU</dt>
							<dd className="sys-metric sys-metric-inline">
								<span>
									{system.vm.cpuPct === null
										? "n/a"
										: `${Math.round(system.vm.cpuPct)} %`}
								</span>
								<Sparkline
									history={system.vm.history}
									pick={(p) => p.cpu}
									end={system.at}
									ceiling={100}
									label="VM CPU last hour"
									format={(v) => `${Math.round(v)} %`}
								/>
							</dd>
						</div>
						<div>
							<dt>Load</dt>
							<dd>
								{system.vm.load1 === null
									? "n/a"
									: `load ${system.vm.load1.toFixed(2)} / ${system.vm.cpus} CPUs`}
							</dd>
						</div>
						<div>
							<dt>Memory</dt>
							<dd>
								{system.vm.memAvailable === null || system.vm.memTotal === null
									? "n/a"
									: `${gib(system.vm.memAvailable)} / ${gib(system.vm.memTotal)} GiB available`}
							</dd>
						</div>
					</dl>
				</section>
			)}
			<section aria-labelledby="sys-holds">
				<h2 className="ov-sec" id="sys-holds">
					Holds
				</h2>
				<dl className="sys-kv">
					{state.drainUntil !== null && (
						<div>
							<dt>Update</dt>
							<dd>
								Update hold until {clockTime(state.drainUntil)}
								{(state.drainCommits ?? []).length > 0 && (
									<ul className="sys-commits">
										{(state.drainCommits ?? []).map((c) => (
											<li key={c}>{c}</li>
										))}
									</ul>
								)}
							</dd>
						</div>
					)}
					<div>
						<dt>Agent cap</dt>
						<dd>
							{state.maxTotal === null
								? `no cap · ${running} running`
								: `${running} / ${state.maxTotal} running`}
						</dd>
					</div>
					<div>
						<dt>Queue</dt>
						<dd>
							{oldest === undefined ? (
								"empty"
							) : (
								<>
									{queue.length} queued · oldest waiting{" "}
									<span className="sys-dur">
										{duration(
											Date.now() - (oldest.queuedAt ?? oldest.createdAt),
										)}
									</span>
								</>
							)}
						</dd>
					</div>
				</dl>
			</section>
		</section>
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
				<Skeleton shape="lines" rows={4} label="Loading the diagram" />
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
	if (svg === null) return <p className="hint wait">Drawing…</p>;
	return (
		<div className="hiw-diagram" dangerouslySetInnerHTML={{ __html: svg }} />
	);
}

/** The board's Diagrams button: the project's docs/how-it-works.md as committed on its target,
 *  with each ```mermaid block drawn, plus a Create/update diagrams button that creates the
 *  task which writes that file. */
function HowItWorksModal({
	project,
	userLayer,
	onClose,
	act,
	open,
}: {
	project: string;
	/** The provisioned user layer; null before the first provisioning answer. */
	userLayer: ProvisioningResponse["userLayer"] | null;
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
	const diagramsNote = skillGapNote(userLayer, "diagrams");
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
						onClick={async () =>
							(await confirmDialog(
								"Create/update diagrams? This creates a task that writes docs/how-it-works.md with Mermaid diagrams.",
								{ ok: "Create task" },
							)) &&
							act(async () => {
								const t = await post<TaskView>(
									`/api/projects/${encodeURIComponent(project)}/tasks`,
									{ prompt: EXPLAIN_PROJECT },
								);
								onClose();
								open(t.id);
							})
						}
						title={`Create a task that writes docs/how-it-works.md with Mermaid diagrams of this project${diagramsNote === null ? "" : `. ${diagramsNote}`}`}
					>
						<Icon name="grid" />
						Create/update diagrams
						{diagramsNote !== null && <SkillGapMark note={diagramsNote} />}
					</button>
					<CloseButton />
				</span>
			</div>
			{result === null ? (
				<Skeleton shape="lines" rows={6} label="Loading the workflow" />
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

/** The diff body: loading skeleton, unavailable note, empty note, or the section cards. */
function diffBody(
	result: { text: string } | { failed: true } | null,
	sections: DiffSection[],
	files: string[] | null,
): ReactNode {
	if (result === null)
		return <Skeleton shape="lines" rows={4} label="Loading the diff" />;
	if ("failed" in result)
		return <p className="hint diff-empty">Diff unavailable.</p>;
	if (sections.length === 0) {
		return (
			<p className="hint diff-empty">
				{files === null ? "No changes." : "No diff for this file."}
			</p>
		);
	}
	return (
		<div className="diff-scroll">
			{sections.map((section) => (
				<section key={section.names[0]} className="diff-card">
					<div className="diff-card-head">{section.path}</div>
					<div className="diff-card-body">
						{numberDiffLines(section.lines).map((line, i) => (
							<div key={i} className={`dl-${line.cls}`}>
								<span className="dl-old">{line.old ?? ""}</span>
								<span className="dl-new">{line.new ?? ""}</span>
								<span className="dl-text">
									{line.text === "" ? " " : line.text}
								</span>
							</div>
						))}
					</div>
				</section>
			))}
		</div>
	);
}

/** The task diff in a lightbox: one card per file, each with a line-number gutter.
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
	const sections =
		result !== null && "text" in result
			? files === null
				? splitDiffSections(result.text)
				: pickDiffSections(splitDiffSections(result.text), files)
			: [];
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
			{diffBody(result, sections, files)}
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

/** The quota tooltip: every window's used percent and its reset, one clause each. */
function quotaTitle(limits: QuotaState["limits"]): string {
	return limits
		.map(
			(l) =>
				`${l.label}: ${l.usedPct}% used${l.resetsAt === null ? "" : `, resets in ${until(l.resetsAt)}`}`,
		)
		.join("; ");
}

/** One window as the twin bar: a thin line for the time gone in the window over the quota used
    (the top bar's Quota group uses the same bar). Decorative; the percent beside it carries the value. */
function QuotaTwin({ limit }: { limit: QuotaState["limits"][number] }) {
	const gone = windowGone(limit, Date.now());
	return (
		<span
			className="sb-twin"
			data-level={loadLevel(limit.usedPct)}
			aria-hidden="true"
		>
			{gone !== null && (
				<span className="t">
					<i style={{ width: `${gone}%` }} />
				</span>
			)}
			<span className="q">
				<i
					style={{ transform: `scaleX(${clamp(limit.usedPct, 0, 100) / 100})` }}
				/>
			</span>
		</span>
	);
}

/** The model field's quota chip: every window as a twin bar with its used percent; only a
 *  window past the band turns amber, a critical one red. */
function modelQuotaChip(
	limits: QuotaState["limits"],
	worst: QuotaState["limits"][number] | null,
): ReactNode {
	if (worst === null) return null;
	return (
		<span className="model-quota" title={quotaTitle(limits)}>
			{limits.map((l) => (
				<span key={l.window ?? l.label} className="quota-win">
					<span className="quota-name">{l.window ?? l.label}</span>
					<QuotaTwin limit={l} />
					<span className="quota-pct" data-level={loadLevel(l.usedPct)}>
						{Math.round(l.usedPct)}%
					</span>
				</span>
			))}
		</span>
	);
}

/** The Thinking row and its level popover shown under the model menu rows. */
function modelLevelAfter(
	menu: ModelMenu,
	levelPopId: string,
	levelAnchor: string,
	levelBase: string,
	level: string,
	base: string,
	runLevel: string,
	pickLevel: (l: string) => void,
): ReactNode {
	return (
		<>
			<hr className="model-divider" />
			<button
				type="button"
				className="model-option level-row"
				popoverTarget={levelPopId}
				disabled={levelBase === ""}
				title={levelBase === "" ? "Pick a model first" : undefined}
				style={{ anchorName: levelAnchor } as React.CSSProperties}
				onKeyDown={(e) => {
					if (e.key === "ArrowRight" || e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						document.getElementById(levelPopId)?.showPopover();
						document
							.getElementById(levelPopId)
							?.querySelector<HTMLElement>(".model-option")
							?.focus();
						return;
					}
					menu.keys(e);
				}}
			>
				<span>Thinking</span>
				<span className="level-value">
					{level === "" ? "Default" : level}
					<Icon name="chevron-right" size={14} />
				</span>
			</button>
			<div
				id={levelPopId}
				popover="auto"
				className="popover level-pop"
				style={{ positionAnchor: levelAnchor } as React.CSSProperties}
			>
				<p className="level-hint">
					More thinking gives deeper answers, but turns take longer and use more
					quota.
				</p>
				{["", ...THINKING_LEVELS].map((l) => (
					<button
						key={l || "default"}
						type="button"
						className="model-option"
						aria-pressed={level === l}
						onClick={() => pickLevel(l)}
						onKeyDown={(e) => {
							// ArrowLeft steps back to the Thinking row of the model menu.
							if (e.key !== "ArrowLeft") return menu.keys(e);
							e.preventDefault();
							document.getElementById(levelPopId)?.hidePopover();
							document
								.getElementById(menu.popId)
								?.querySelector<HTMLElement>(".level-row")
								?.focus();
						}}
					>
						{/* On the default model, "Default" names the level it brings (e.g. max). */}
						<span>
							{l !== ""
								? l
								: base === "" && runLevel !== ""
									? `Default (${runLevel})`
									: "Default"}
						</span>
						{level === l && <Icon name="check" size={14} />}
					</button>
				))}
			</div>
		</>
	);
}

/** The shared model picker behind New task and Follow up: a trigger button opening a searchable popover.
 *  Optional `onOpen` fires when the menu opens (OTTR-795: the drawer captures the card revision
 *  there, so a poll mid-choice cannot hand a stale pick a passing revision) and `conflict` shows
 *  the notice of a refused pick beside the menu. */
function ModelField({
	catalog,
	model,
	setModel,
	modelQuery,
	setModelQuery,
	onOpen,
	conflict,
}: {
	catalog: ModelCatalog | null;
	model: string;
	setModel: (m: string) => void;
	modelQuery: string;
	setModelQuery: (q: string) => void;
	onOpen?: () => void;
	conflict?: { current: string | null } | null;
}) {
	// One picker per dialog instance; several New task dialogs (one per project) stay mounted at once.
	// The thinking level opens as a nested menu beside the model menu (like Claude's effort row).
	const menu = useModelMenu(onOpen);
	// The level menu anchors the Thinking row; a fixed name would collide across dialogs.
	const levelAnchor = `--model-level-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
	const levelPopId = useId();
	const allModels = catalog?.models ?? [];
	// model is a joined omp selector "provider/model:level"; "" level means omp default.
	const [base, level] = splitLevel(model);
	const models = allModels.filter((m) => modelMatches(m, modelQuery));
	// Trigger: the model without its provider, then ":level" (the default model's own level when
	// nothing is picked). The full selector stays in the tooltip and the accessible name.
	const runModel = base === "" ? (catalog?.defaultModel ?? "") : model;
	const [runBase, runLevel] = splitLevel(runModel);
	const fullLabel =
		base === ""
			? runModel === ""
				? "Default model"
				: `Default model: ${runModel}`
			: `Model: ${model}`;
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
		menu.close();
	};
	// On the default model a level needs an explicit anchor, so it pins the default's base
	// ("Default" level keeps following the omp default).
	const levelBase =
		base !== "" ? base : splitLevel(catalog?.defaultModel ?? "")[0];
	const pickLevel = (l: string): void => {
		setModel(base === "" && l === "" ? "" : joinLevel(levelBase, l));
		document.getElementById(levelPopId)?.hidePopover();
		menu.close();
		menu.trigger.current?.focus();
	};
	return (
		<>
			<div className="model-fields">
				{/* biome-ignore lint/a11y/noLabelWithoutControl: the label wraps the picker's trigger button, which sits inside ModelMenuTrigger */}
				<label className="field">
					<span className="field-head">
						{/* Name and mark share one flex child: the head is space-between, so a loose
						    third child would float mid-row between label and quota chip. */}
						<span className="field-head-name">
							Model
							<span className="opt-mark">(optional)</span>
						</span>
						{/* Every window as the top bar's twin bar (time gone over quota used) plus its used
						    percent; only a window past the band turns amber, a critical one red. */}
						{modelQuotaChip(limits, worst)}
					</span>
					<ModelMenuTrigger menu={menu} label={fullLabel}>
						<span className="model-name">
							{runBase === "" ? "Default" : displayModel(allModels, runBase)}
							{runLevel !== "" && (
								<span className="model-level"> {runLevel}</span>
							)}
						</span>
					</ModelMenuTrigger>
				</label>
			</div>
			{conflict != null && (
				<EditConflictNotice
					heading="The card changed while you were choosing. Your pick was not applied; pick again to set it on the current card."
					current={conflict.current}
					gone="The card runs the default model on the board now."
				/>
			)}
			{/* Sibling, not child: label click-forwarding must not fight the popover's focus. */}
			<ModelMenuBody
				menu={menu}
				query={modelQuery}
				setQuery={setModelQuery}
				rows={
					catalog === null
						? []
						: modelRows(allModels, catalog.roles ?? null, model, modelQuery)
				}
				shown={models.length}
				total={allModels.length}
				loading={catalog === null}
				onPick={pickModel}
				after={modelLevelAfter(
					menu,
					levelPopId,
					levelAnchor,
					levelBase,
					level,
					base,
					runLevel,
					pickLevel,
				)}
			/>
		</>
	);
}

/** The deepen rewrite review: the line diff of draft vs rewrite with +/- glyphs, the
 * five-point verdict panel, plus Use rewrite and Discard. */
export function DeepenReview({
	original,
	deepened,
	check,
	checkError,
	onUse,
	onDiscard,
}: {
	original: string;
	deepened: string;
	check: DeepenCheck | null;
	checkError: string | null;
	onUse: () => void;
	onDiscard: () => void;
}) {
	const rows = lineDiff(original, deepened);
	const changed = rows.some((r) => r.kind !== "same");
	// One row per canonical point: the label reads only the draft/rewrite pair, so the
	// model cannot drift the names or the verdicts.
	const pointLabel = (p: DeepenPointCheck): string =>
		p.rewrite === "missing"
			? "still missing"
			: p.draft === "missing"
				? "improved"
				: "already present";
	const improved =
		check === null
			? 0
			: check.points.filter((p) => pointLabel(p) === "improved").length;
	// A rewrite that improves nothing, or invents work, must not be the default action:
	// Use rewrite keeps working but Discard carries the visual weight.
	const weak = check !== null && (improved === 0 || check.additions.length > 0);
	return (
		<section className="deepen-review" aria-label="Deepen review">
			{changed ? (
				<div className="deepen-diff">
					{rows.map((r, i) => (
						<div
							key={i}
							className={
								r.kind === "add"
									? "dl-add"
									: r.kind === "del"
										? "dl-del"
										: undefined
							}
						>
							<span className="deepen-glyph" aria-hidden="true">
								{r.kind === "add" ? "+" : r.kind === "del" ? "\u2212" : ""}
							</span>
							<span className="dl-text">{r.text}</span>
						</div>
					))}
				</div>
			) : (
				<p className="hint">
					The rewrite matches the draft line for line; nothing to change.
				</p>
			)}
			{check === null ? (
				<p className="hint deepen-check-error">
					Check unavailable: {checkError ?? "unknown error"}
				</p>
			) : (
				<div className="deepen-points">
					<p className="deepen-points-summary">
						{improved === 0
							? "The rewrite improves no deepen point."
							: `Improves ${improved} of ${DEEPEN_POINTS.length} deepen points.`}
					</p>
					<ul className="deepen-points-list">
						{DEEPEN_POINTS.map((point, i) => {
							const pc = check.points[i];
							const label = pc === undefined ? "" : pointLabel(pc);
							return (
								<li key={point} className="deepen-point">
									<span
										className={`dp-label${label === "improved" ? " dp-improved" : ""}`}
									>
										{label}
									</span>
									<span className="dp-body">
										<span className="dp-name">{point}</span>
										{pc !== undefined && (
											<span className="dp-reason">{pc.reason}</span>
										)}
									</span>
								</li>
							);
						})}
					</ul>
					{check.additions.length > 0 && (
						<div className="deepen-additions">
							<p className="deepen-additions-head">
								Adds what the draft did not ask for
							</p>
							<ul>
								{check.additions.map((a, i) => (
									<li key={i}>{a}</li>
								))}
							</ul>
						</div>
					)}
				</div>
			)}
			<div className="dialog-actions">
				<button type="button" onClick={onDiscard}>
					Discard
				</button>
				<button
					type="button"
					className={weak ? undefined : "primary"}
					onClick={onUse}
				>
					Use rewrite
				</button>
			</div>
		</section>
	);
}

/** The Help pop-over text next to the composer label: what makes a good prompt, and what Deepen does. */
const DEEPEN_HELP = (
	<>
		<b className="help-title">Cover in a prompt</b>
		<ul className="help-list">
			<li>Goal: why the task matters</li>
			<li>Limits: what must not change</li>
			<li>Check: how to prove it works</li>
			<li>Method: how an expert would do it</li>
			<li>Material: files, data, examples</li>
			<li>Tools: commands and services to use</li>
		</ul>
		<p className="help-note">Deepen fills the gaps as a diff you accept.</p>
	</>
);

/** The shared compose dialog behind New task and Follow up: same hooks, draft reset and
    submit flow; callers pass the copy, the icon and a `send` that does the POST. */
export function ComposeDialog({
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
	deepen,
	/** Show the model picker; the draft mask hides it because a draft runs no agent. */
	showModel,
	/** One extra control above the prompt card (the follow-up's project picker). */
	field,
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
	/** Deepen the draft: POST /api/projects/:project/deepen. Absent on the backlog draft dialog. */
	deepen?: (
		text: string,
		model: string,
	) => Promise<{
		deepened: string;
		check: DeepenCheck | null;
		checkError: string | null;
	}>;
	showModel?: boolean;
	field?: ReactNode;
}) {
	const [text, setText] = useState("");
	const [model, setModel] = useState("");
	const [modelQuery, setModelQuery] = useState("");
	const catalog = useModels();
	const images = useAttachedImages();
	const sendState = useBusy();
	const deepenState = useBusy();
	/** Deepen result awaiting accept/edit: the diffed pair plus its five-point check; null while no review is open. */
	const [review, setReview] = useState<{
		original: string;
		deepened: string;
		check: DeepenCheck | null;
		checkError: string | null;
	} | null>(null);
	const [deepenErr, setDeepenErr] = useState<string | null>(null);
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
		setReview(null);
		setDeepenErr(null);
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
	// Own button, never the form's submit: a failed deepen shows its own error line and keeps the draft.
	const runDeepen = (): void => {
		if (deepen === undefined || text.trim().length === 0 || deepenState.busy)
			return;
		setDeepenErr(null);
		deepenState.start(async () => {
			try {
				const r = await deepen(text, model);
				setReview({
					original: text,
					deepened: r.deepened,
					check: r.check,
					checkError: r.checkError,
				});
				return true;
			} catch (e) {
				setDeepenErr(e instanceof Error ? e.message : String(e));
				return false;
			}
		});
	};
	// Through the draft path: the textarea (and the on-device cache) hold the rewrite, still editable.
	const useRewrite = (): void => {
		if (review === null) return;
		editText(review.deepened);
		setReview(null);
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
					{field}
					<div className="prompt-card">
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
						<ImageBrowseButton onAdd={images.addFiles} icon="plus" />
						{showModel !== false && (
							<ModelField
								catalog={catalog}
								model={model}
								setModel={editModel}
								modelQuery={modelQuery}
								setModelQuery={setModelQuery}
							/>
						)}
						<button
							type="submit"
							className={`primary${sendState.failed ? " failed" : ""}`}
							disabled={sendState.busy || text.trim().length === 0}
							aria-busy={sendState.busy || undefined}
							title={`${submitLabel} (Enter)`}
						>
							{sendState.busy ? (
								<span className="spinner" aria-hidden="true" />
							) : (
								<Icon name={icon} />
							)}
							{submitLabel}
						</button>
						{deepen !== undefined && (
							<span className="compose-deepen">
								<button
									type="button"
									className="ghost deepen-btn"
									disabled={text.trim().length === 0 || deepenState.busy}
									aria-busy={deepenState.busy || undefined}
									onClick={runDeepen}
								>
									{deepenState.busy ? (
										<span className="spinner" aria-hidden="true" />
									) : (
										<Icon name="edit" size={14} />
									)}
									Deepen
								</button>
								<Help label="Deepen" text={DEEPEN_HELP} />
							</span>
						)}
					</div>
					{/* The keys under the card as chips; the full hint stays in the tooltip and for screen readers. */}
					<p className="compose-keys" title={hint}>
						<kbd>Enter</kbd> {submitLabel.toLowerCase()}
						<span aria-hidden="true">·</span>
						<kbd>Shift</kbd>+<kbd>Enter</kbd> new line
						<span className="sr"> {hint}</span>
					</p>
					{deepen !== undefined && review !== null && (
						<DeepenReview
							original={review.original}
							deepened={review.deepened}
							check={review.check}
							checkError={review.checkError}
							onUse={useRewrite}
							onDiscard={() => setReview(null)}
						/>
					)}
					{deepen !== undefined && deepenErr !== null && (
						<p className="auth-error" role="alert">
							Deepen failed: {deepenErr} The draft is unchanged — try again.
						</p>
					)}
					{err !== null && (
						<p className="auth-error" role="alert">
							{err}
						</p>
					)}
				</form>
			</Modal>
			{/* Sibling, not child: a nested dialog's close event would propagate to the compose dialog and close both. */}
			<Modal
				open={viewing !== null}
				onClose={() => setViewing(null)}
				label="Attached image"
				className="lightbox"
			>
				{viewing !== null && (
					<ZoomableImage src={viewing} alt="Attachment, full size" />
				)}
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
			inputLabel="Task"
			placeholder="Fix the login redirect on Safari"
			hint="Enter adds the task. Shift+Enter starts a new line. Images: paste, drop or browse."
			icon="send"
			submitLabel="Add task"
			deepen={async (text, model) =>
				post<{
					deepened: string;
					check: DeepenCheck | null;
					checkError: string | null;
				}>(`/api/projects/${encodeURIComponent(project.name)}/deepen`, {
					prompt: text,
					model: model || undefined,
				})
			}
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
			inputLabel="Idea"
			placeholder="Batch-release on Thursdays"
			hint="Enter parks the draft in the backlog. Shift+Enter starts a new line. Images: paste, drop or browse. No model pick: a draft runs no agent."
			icon="send"
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
			// Plan with agent opens on the plan role's model (else slow, like the review and
			// release dialogs); with neither role assigned the card's own model stays.
			const rm = mode === "grill" ? reviewModel(catalog) : null;
			setModel(rm !== null ? rm.model : (currentModel ?? ""));
		} else {
			setModel("");
			setModelQuery("");
			setErr(null);
		}
	}, [open, currentModel, mode, catalog]);
	return (
		<Modal
			open={open}
			onClose={onClose}
			label={mode === "grill" ? "Plan with agent" : "Move to todo"}
			className="dialog"
		>
			<div className="dialog-body">
				<div className="dialog-head">
					<h2>
						{mode === "grill" ? "Plan with agent" : "Move to todo"}
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
						className={`primary${send.failed ? " failed" : ""}`}
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
						{mode === "grill" ? "Plan with agent" : "Move to todo"}
					</button>
				</div>
			</div>
		</Modal>
	);
}

/** Model pick for a research report's "Implement steps": mounted per open on the default model,
 * so a confirm without a change runs the default (OTTR-660). */
function ImplementStepsDialog({
	task,
	onClose,
	act,
	onMarkSeen,
	onFollowed,
}: {
	task: TaskView;
	onClose: () => void;
	act: Act;
	onMarkSeen: () => void;
	onFollowed: (id: string, from: string) => void;
}) {
	const [model, setModel] = useState("");
	const [modelQuery, setModelQuery] = useState("");
	const [err, setErr] = useState<string | null>(null);
	const catalog = useModels();
	const send = useBusy();
	return (
		<Modal open onClose={onClose} label="Implement steps" className="dialog">
			<div className="dialog-body">
				<div className="dialog-head">
					<h2>
						Implement steps
						<span className="dialog-sub">
							{task.sessionTitle ?? task.title}
						</span>
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
					Creates a follow-up task that implements the report's recommended
					steps. Leave the model unchanged to use the default model.
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
						className={`primary${send.failed ? " failed" : ""}`}
						disabled={send.busy}
						aria-busy={send.busy || undefined}
						onClick={() =>
							send.start(() =>
								act(async () => {
									await implementSteps({ task, model, onMarkSeen, onFollowed });
									onClose();
								}, setErr),
							)
						}
					>
						{send.busy && <span className="spinner" aria-hidden="true" />}
						<Icon name="play" />
						Implement steps
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
export function FollowUpDialog({
	task,
	projects,
	open,
	onClose,
	act,
	onFollowed,
}: {
	task: TaskView;
	projects: ProjectView[];
	open: boolean;
	onClose: () => void;
	act: Act;
	onFollowed: (id: string, from: string) => void;
}) {
	const [target, setTarget] = useState(task.project);
	// Closing drops the pick: the next open defaults to the task's own board again.
	useEffect(() => {
		if (!open) setTarget(task.project);
	}, [open, task.project]);
	const eligible = projects.filter((p) => !p.gitless);
	return (
		<ComposeDialog
			open={open}
			onClose={onClose}
			act={act}
			draftKey={`followup:${task.id}`}
			label={`Follow up on ${task.sessionTitle ?? task.title}`}
			heading="Follow up"
			sub={task.sessionTitle ?? task.title}
			inputLabel="Follow-up"
			placeholder="Re-run the failed tests"
			hint="Enter sends the follow-up. Shift+Enter starts a new line. Images: paste, drop or browse."
			icon="send"
			submitLabel="Follow up"
			field={
				eligible.length >= 2 && (
					<label className="triage-rank followup-project">
						<span>Project</span>
						<select value={target} onChange={(e) => setTarget(e.target.value)}>
							{eligible.map((p) => (
								<option key={p.name} value={p.name}>
									{projectLabel(p)}
								</option>
							))}
						</select>
					</label>
				)
			}
			deepen={async (text, model) =>
				post<{
					deepened: string;
					check: DeepenCheck | null;
					checkError: string | null;
				}>(`/api/projects/${encodeURIComponent(target)}/deepen`, {
					prompt: text,
					model: model || undefined,
				})
			}
			send={async ({ text, images, model }) => {
				const next = await post<TaskView>(
					`/api/projects/${encodeURIComponent(task.project)}/tasks/${task.id}/follow-up`,
					{
						text,
						images,
						model: model || undefined,
						project: target === task.project ? undefined : target,
					},
				);
				// Close the drawer; the board flies the new card out of this one (another board's card finds no origin).
				onFollowed(next.id, task.id);
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

/** The release line: first-release or since-tag summary with the editable version input. */
function releaseLine(
	plan: ReleasePlan,
	first: boolean,
	short: string,
	version: string,
	setVersion: (v: string) => void,
): ReactNode {
	if (plan.version === "") return null;
	return (
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
				<span className="opt-mark">(optional)</span>
			</strong>
			<span>
				{first
					? `${plan.commits} commits up to ${short}`
					: `${plan.commits} commits since ${plan.from} up to ${short}`}
			</span>
		</p>
	);
}

/** The consolidating busy line with its elapsed time, and the fallback notice. */
function releaseSummary(
	summaryBusy: boolean,
	summarySince: number | null,
	summaryReason: string | null,
): ReactNode {
	return (
		<>
			{summaryBusy && (
				<p className="hint wait" role="status">
					<span className="spinner" aria-hidden="true" />
					Consolidating the notes…
					{summarySince !== null && (
						<>
							{" · "}
							<LiveElapsed since={summarySince} />
						</>
					)}
				</p>
			)}
			{summaryReason !== null && (
				<p className="advisory">
					<Icon name="info" size={14} />
					{`Consolidated notes unavailable: ${summaryReason} — showing the deterministic list.`}
				</p>
			)}
		</>
	);
}

/** The notes editor: the proposal textarea, the full-commit-list toggle and its list. */
function releaseNotes(
	plan: ReleasePlan,
	notesDraft: string | null,
	edited: { current: boolean },
	setNotesDraft: (v: string | null) => void,
	showCommits: boolean,
	setShowCommits: React.Dispatch<React.SetStateAction<boolean>>,
): ReactNode {
	return (
		<>
			<label htmlFor="release-notes-proposal">Release notes</label>
			<textarea
				id="release-notes-proposal"
				rows={10}
				spellCheck={false}
				className="release-notes-input"
				value={notesDraft ?? plan.notes}
				onChange={(e) => {
					setNotesDraft(e.target.value);
					edited.current = e.target.value !== plan.notes;
				}}
			/>
			{plan.from !== null && (
				<button
					type="button"
					className="release-notes-toggle"
					aria-pressed={showCommits}
					onClick={() => setShowCommits((v) => !v)}
				>
					{showCommits ? "Hide full commit list" : "Show full commit list"}
				</button>
			)}
			{showCommits && (
				<div className="release-notes">
					<Markdown text={plan.notes} />
				</div>
			)}
		</>
	);
}

/** What happens on Start: the review runs the release command, or Ottr tags directly. */
function releaseHint(
	plan: ReleasePlan,
	project: ProjectView,
	short: string,
): ReactNode {
	if (plan.blocked !== null) {
		return (
			<p className="advisory">
				<Icon name="info" size={14} />
				{plan.blocked}
			</p>
		);
	}
	return (
		<p className="hint">
			An agent reviews these commits and runs the full verification, including
			mutation tests. If nothing blocks,{" "}
			{project.settings.releaseCommand !== null ? (
				<>
					Ottr runs the project's release command for {plan.version} at {short}{" "}
					and then checks the tag with git.
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
	);
}

/** The dialog's action row: Cancel and the guarded Start release button. */
function releaseActions(
	plan: ReleasePlan | null,
	versionOk: boolean,
	send: BusyState,
	start: () => void,
): ReactNode {
	return (
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
	);
}

/** The release summary reply: draft the notes, or record why none came. */
function summaryReply(
	res: { summary: string | null; reason: string | null },
	alive: boolean,
	edited: { current: boolean },
	setNotesDraft: (v: string | null) => void,
	setSummaryReason: (v: string | null) => void,
): void {
	if (!alive) return;
	if (res.summary !== null) {
		if (!edited.current) setNotesDraft(res.summary);
	} else {
		setSummaryReason(res.reason);
	}
}

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
	const [notesDraft, setNotesDraft] = useState<string | null>(null);
	const [summaryBusy, setSummaryBusy] = useState(false);
	/** When the notes consolidation call started; the busy line ticks its elapsed time. */
	const [summarySince, setSummarySince] = useState<number | null>(null);
	const [summaryReason, setSummaryReason] = useState<string | null>(null);
	const [showCommits, setShowCommits] = useState(false);
	const edited = useRef(false);
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
		setNotesDraft(null);
		setSummaryBusy(false);
		setSummarySince(null);
		setSummaryReason(null);
		setShowCommits(false);
		edited.current = false;
		setLoading(true);
		let alive = true;
		// unwrap: a non-JSON 200 must surface as a load error, not an empty dialog.
		fetch(`/api/projects/${encodeURIComponent(project.name)}/release`)
			.then((r) => unwrap<ReleasePlan>(r))
			.then((data) => {
				if (!alive) return;
				setPlan(data);
				setVersion(data.version);
				if (data.from !== null) {
					setSummaryBusy(true);
					setSummarySince(Date.now());
					post<{ summary: string | null; reason: string | null }>(
						`/api/projects/${encodeURIComponent(project.name)}/release-summary`,
						{ sha: data.sha },
					)
						.then((res) =>
							summaryReply(res, alive, edited, setNotesDraft, setSummaryReason),
						)
						.catch((e) => {
							if (alive)
								setSummaryReason(e instanceof Error ? e.message : String(e));
						})
						.finally(() => {
							if (alive) setSummaryBusy(false);
						});
				}
			})
			.catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
			.finally(() => setLoading(false));
		return () => {
			alive = false;
		};
	}, [open, project.name]);
	const start = (): void => {
		if (plan === null || plan.blocked !== null || !versionOk) return;
		const proposal = notesDraft ?? plan.notes;
		send.start(() =>
			act(async () => {
				await post<TaskView>(
					`/api/projects/${encodeURIComponent(project.name)}/release`,
					{
						sha: plan.sha,
						version: version !== plan.version ? version : undefined,
						model: model || undefined,
						notes: proposal !== plan.notes ? proposal : undefined,
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
			className="dialog release-dialog"
		>
			<div className="dialog-body">
				<div className="dialog-head">
					<h2>
						Create release<span className="dialog-sub">{label}</span>
					</h2>
					<CloseButton />
				</div>
				{loading && (
					<Skeleton shape="lines" rows={3} label="Reading the target" />
				)}
				{loadError !== null && (
					<p className="advisory">
						<Icon name="info" size={14} />
						{loadError}
					</p>
				)}
				{plan !== null && (
					<>
						{releaseLine(plan, first, short, version, setVersion)}
						{plan.tasks.length > 0 && (
							<ul className="release-tasks" aria-label="Tasks in this release">
								{plan.tasks.map((t) => (
									<li key={t.id} title={`Task ${t.id}`}>
										{t.title}
									</li>
								))}
							</ul>
						)}
						{releaseSummary(summaryBusy, summarySince, summaryReason)}
						{releaseNotes(
							plan,
							notesDraft,
							edited,
							setNotesDraft,
							showCommits,
							setShowCommits,
						)}
						{releaseHint(plan, project, short)}
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
				{releaseActions(plan, versionOk, send, start)}
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
						className={`primary${send.failed ? " failed" : ""}`}
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
	"Explain how this project works: load the explain-project skill and follow it. Write docs/how-it-works.md with Mermaid diagrams (architecture, the main use case, and the life cycle if the project has one). Map every node to its source path. If docs/how-it-works.md already exists, update it to match the code. If this runner lacks the skill, report needs_you: Alate provisioning installs it. Commit the file.";

/** Done lane page size: the cards shown before "Show more", and the step each click adds. */
const DONE_PAGE = 20;

/** Search apply delay: the lanes re-filter this long after the last keystroke, so swift
 * typing on a big board re-renders once, not per keypress. */
export const SEARCH_APPLY_MS = 150;

/** Done order: latest landing first. doneAt stamps each entry into Done (the done clock);
 * a cancelled card orders by its cancel time. */
const newestLanded = (a: TaskCard, b: TaskCard): number =>
	(b.cancelledAt ?? b.doneAt ?? b.updatedAt) -
	(a.cancelledAt ?? a.doneAt ?? a.updatedAt);

/** Per-column card list plus the done lane's paging state, computed once per column. */
function laneColumnData(
	key: Stage,
	shown: readonly TaskCard[],
	q: string,
	doneLimit: number,
	seenAnswers: ReadonlySet<string>,
	since: number,
) {
	const unread = (t: TaskCard): boolean => isUnread(t, seenAnswers, since);
	// A kicked backlog card (grill session started) renders as a normal card in the todo lane.
	const filtered = shown.filter((t) => laneStage(t) === key);
	// Done: latest landing on top. doneAt stamps each entry into Done (the done clock), so it orders by landing time.
	if (key === "done") filtered.sort(newestLanded);
	// Other columns: running/needs_you first, queued cards in queue priority (draggable order).
	let col = key === "done" ? filtered : laneOrder(filtered);
	// Done lazy-loads: the newest page renders and "Show more" appends the next page;
	// a search shows every match. Unread answers always stay above the cut.
	// ponytail: the state payload still carries every card; paginate /api/state
	// instead if boards grow into the thousands of done cards.
	let doneHidden = 0;
	if (key === "done" && q === "") {
		const page = donePage(
			col,
			(t) => unread(t) || (t.starred && t.cancelledAt === null),
			doneLimit,
		);
		col = page.shown;
		doneHidden = page.hidden;
	}
	return { col, doneHidden };
}

/** The project head's overflow menu: review, release, diagrams and settings, plus the popover trigger. */
function ProjectMenu(p: {
	project: ProjectView;
	/** The provisioned user layer; null before the first provisioning answer. */
	userLayer: ProvisioningResponse["userLayer"] | null;
	startReview: () => void;
	showRelease: () => void;
	showDiagrams: () => void;
}) {
	const project = p.project;
	const reviewNote = skillGapNote(p.userLayer, "review");
	return (
		<>
			<button
				type="button"
				className="project-more"
				popoverTarget="project-more"
				aria-label="More project actions"
				title="More project actions"
			>
				<Icon name="more" />
			</button>
			{/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: the items are buttons; a click on one runs it, then this closes the menu */}
			<div
				id="project-more"
				popover="auto"
				className="project-menu"
				onClick={(e) => e.currentTarget.hidePopover()}
			>
				{project.archReview !== null &&
					!(project.archReview.due && !project.archReview.running) &&
					(project.archReview.running || project.archReview.delta > 0) && (
						<button
							type="button"
							className="ghost"
							disabled={project.archReview.running}
							title={
								(project.archReview.running
									? "A review is still open: one review at a time"
									: `${project.archReview.delta} commits on ${project.target} since the last review — start one early, the same review a release runs`) +
								(reviewNote === null ? "" : `. ${reviewNote}`)
							}
							onClick={p.startReview}
						>
							<Icon name="shield-check" />
							Start review
							{reviewNote !== null && <SkillGapMark note={reviewNote} />}
						</button>
					)}
				{!project.gitless && (
					<button
						type="button"
						className="ghost"
						// Same guard as Review: a release runs that review (releaseBlocked).
						disabled={project.archReview?.running}
						onClick={p.showRelease}
						title={
							(project.archReview?.running
								? "A release or review is still open: one at a time"
								: "Release all new commits") +
							(reviewNote === null ? "" : `. ${reviewNote}`)
						}
					>
						<Icon name="package" />
						Create release
						{reviewNote !== null && <SkillGapMark note={reviewNote} />}
					</button>
				)}
				{!project.gitless && (
					<button
						type="button"
						className="ghost"
						onClick={p.showDiagrams}
						title="Show docs/how-it-works.md with its Mermaid diagrams, as committed on the target branch"
					>
						<Icon name="workflow" />
						Show diagrams
					</button>
				)}
				{/* A real link, so a middle click opens the project's settings page in a
				    new tab; a plain click walks the popstate path. */}
				<a
					className="ghost"
					href={settingsPath(project.name)}
					aria-label="Project settings"
					title="Project settings"
					onClick={(e) =>
						navClick(e, () =>
							settingsNavigate(`${SETTINGS_HASH}/${project.name}`),
						)
					}
				>
					<Icon name="gear" />
					Project settings
				</a>
			</div>
		</>
	);
}

/** The review state chip in the project meta line. */
function ReviewStateChip(p: {
	review: ProjectView["archReview"];
	target: string | null;
}) {
	return (
		<span
			className={p.review?.running ? "arch-live" : "arch-due"}
			title={
				p.review?.running
					? "A review is queued or running, or its findings are still open"
					: p.review?.reviewed
						? `Commits on ${p.target} since the last review`
						: `No review of ${p.target} yet`
			}
		>
			{p.review?.running
				? "Review in progress"
				: p.review?.reviewed
					? `Review due (${p.review.delta} commits)`
					: "Un-reviewed — review due"}
		</span>
	);
}

/** The project head's meta line: latest release, latest image, review state, open PRs, repo link. */
function ProjectMeta(p: { project: ProjectView }) {
	const project = p.project;
	return (
		<p className="project-meta">
			{project.latestRelease !== null &&
				(project.latestReleaseUrl != null ? (
					<a
						href={project.latestReleaseUrl}
						target="_blank"
						rel="noopener noreferrer"
						title="Latest release"
					>
						<Icon name="tag" size={13} />
						{project.latestRelease}
					</a>
				) : project.github !== null ? (
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
				<ReviewStateChip review={project.archReview} target={project.target} />
			)}
			{/* More than three open PRs collapse to one count link, mirroring prs.ts's PR_CHIP_MAX. */}
			{project.openPrs != null &&
				project.github !== null &&
				(project.openPrs.prs.length < project.openPrs.total ? (
					<a
						href={`${project.github}/pulls`}
						target="_blank"
						rel="noopener noreferrer"
						title="Open pull requests"
					>
						<Icon name="git-pr" size={13} />
						{project.openPrs.total} open PRs
					</a>
				) : (
					project.openPrs.prs.map((pr) => (
						<a
							key={pr.number}
							href={pr.url}
							target="_blank"
							rel="noopener noreferrer"
							title={`${pr.title}${pr.draft ? " (draft)" : ""}`}
						>
							<Icon name="git-pr" size={13} />#{pr.number}
						</a>
					))
				))}
			{project.github !== null && (
				<a
					href={project.github}
					target="_blank"
					rel="noopener noreferrer"
					title="GitHub repository"
				>
					<GhMark />
					{repoSlug(project.github)}
				</a>
			)}
		</p>
	);
}

/** The advisory strip under the project head: checkout, branch, rules and search notices. */
function ProjectAdvisories(p: {
	project: ProjectView;
	hosted: boolean;
	short: string | null;
	q: string;
	shown: readonly TaskCard[];
	pushMain: () => Promise<boolean>;
	saveCheck: (patchBody: Record<string, unknown>) => Promise<boolean>;
	interview: (path: string, body: Record<string, unknown>) => Promise<boolean>;
	rulesTask: TaskCard | null;
	openTask: (id: string) => void;
}) {
	const { project, short, q, rulesTask } = p;
	return (
		<>
			{project.dirty && (
				<p className="advisory">
					<Icon name="info" size={14} />
					The main checkout has uncommitted changes. Your own pull or stash can
					collide with commits from tasks.
				</p>
			)}
			{project.mainBranch !== null &&
				short !== null &&
				project.mainBranch !== short && (
					<p className="advisory">
						<Icon name="info" size={14} />
						The main checkout is on branch <code>{project.mainBranch}</code>,
						not {short}. Commit to {short}, never to a task branch.
					</p>
				)}
			{short !== null && project.mainUnpushed && (
				<p className="advisory">
					<Icon name="info" size={14} />
					Local {short} has commits origin lacks. Merges wait until it reaches
					origin.
					<BusyButton run={p.pushMain}>Push to origin</BusyButton>
				</p>
			)}
			{project.prModeSuggestion && (
				<p className="advisory">
					<Icon name="info" size={14} />
					<span>
						GitHub requires pull requests into <code>{short}</code>, so the
						merge turn's push would be refused.{" "}
						<BusyButton run={() => p.saveCheck({ prMode: true })}>
							Turn on PR mode
						</BusyButton>
					</span>
				</p>
			)}
			{project.githubHostNotice &&
				!hostedHidden(p.hosted, "github-host-block") && (
					<p className="advisory">
						<Icon name="info" size={14} />
						<span>
							GitHub features off: set GitHub host to{" "}
							<code>{project.githubHostNotice}</code> under{" "}
							<button
								type="button"
								className="notif-link"
								onClick={() => openSettingsSection("github-host-block")}
							>
								Settings → GitHub → GitHub host
							</button>
							.
						</span>
					</p>
				)}
			{project.dependabotOff && project.github !== null && (
				<p className="advisory">
					<Icon name="info" size={14} />
					<span>
						Dependabot alerts are off for{" "}
						<code>{repoSlug(project.github)}</code> on GitHub, so the board sees
						no Dependabot alerts for it.{" "}
						<a
							className="notif-link"
							href={`${project.github}/settings/security_analysis`}
							target="_blank"
							rel="noopener noreferrer"
						>
							Enable on GitHub
						</a>
						. Hide this warning under{" "}
						<button
							type="button"
							className="notif-link"
							onClick={() => openSettingsSection("project-watches-section")}
						>
							Settings → Watches → Dependabot warning
						</button>
						.
					</span>
				</p>
			)}
			{!project.hasRules && (
				<p className="advisory">
					<Icon name="info" size={14} />
					No AGENTS.md yet, so tasks wait in Todo.
					{rulesTask === null ? (
						<BusyButton run={() => p.interview("/interview", {})}>
							Discuss rules
						</BusyButton>
					) : (
						<BusyButton
							run={async () => {
								p.openTask(rulesTask.id);
								return true;
							}}
						>
							Open rules task
						</BusyButton>
					)}
				</p>
			)}
			{project.gitless && (
				<p className="advisory">
					<Icon name="info" size={14} />
					Not a git repository yet, so every action waits.
					<BusyButton run={() => p.interview("/init", {})}>
						Create git repo
					</BusyButton>
				</p>
			)}
			{q !== "" && p.shown.length === 0 && (
				<p className="advisory">
					<Icon name="info" size={14} />
					No tasks match "{q}".
				</p>
			)}
		</>
	);
}

/** One project's flow: identity and New task, advisories, the queue, then the four stage columns. */
/** OTTR-708: the cross-project dependency lookup for one project's board — resolves a
 * dependsOn id through the project's own cards first, then by the projects' id handles
 * (resolveDep, the server's rule). undefined when the project is not among `projects`. */
function depIndexOf(
	projects: ProjectView[],
	tasks: TaskCard[],
	project: ProjectView,
): DepIndex | undefined {
	const cards = new Map<string, TaskCard>();
	for (const t of tasks) cards.set(`${t.project}\u0000${t.id}`, t);
	const deps: DepProject[] = projects.map((p) => ({
		name: p.name,
		prefix: p.taskPrefix,
		getTask: (id: string) => cards.get(`${p.name}\u0000${id}`) ?? null,
	}));
	const own = deps.find((p) => p.name === project.name);
	return own === undefined ? undefined : (id) => findDep(id, deps, own);
}

export function ProjectBoard({
	project,
	tasks,
	deltas,
	open,
	seenAnswers,
	seenDoneSince,
	compose,
	composeDraft,
	act,
	onNotice,
	draining,
	tick,
	foreignDeps,
	userLayer,
}: {
	project: ProjectView;
	tasks: TaskCard[];
	deltas: Map<string, number>;
	open: (id: string) => void;
	seenAnswers: Set<string>;
	/** The server's done baseline; the unread rule reads it (OTTR-827). */
	seenDoneSince: number;
	compose: () => void;
	composeDraft: () => void;
	act: Act;
	onNotice: (message: string) => void;
	/** True while an update holds new turns (POST /api/drain): queued cards wait for the restart. */
	draining: boolean;
	/** The board's 30 s clock tick; feeds the memoized cards so their ages keep ticking. */
	tick?: number;
	/** OTTR-708: looks a dependsOn id up across every project's cards, so a hold names a
	 * foreign card; absent before the first state frame or for an unknown project. */
	foreignDeps?: DepIndex;
	/** The provisioned user layer; absent before the first provisioning answer, and absent
	 * in hosted mode (the operator owns the workers' layer), so the markers stay out. */
	userLayer?: ProvisioningResponse["userLayer"] | null;
}) {
	const hosted = useContext(HostedContext);
	const [showRelease, setShowRelease] = useState(false);
	const [showReview, setShowReview] = useState(false);
	// The project's cards at the last render: the re-release callback stays stable across
	// frames (a memoized card keeps its callback), so it reads the card from here instead
	// of closing over a frame's array.
	const tasksRef = useRef(tasks);
	tasksRef.current = tasks;
	// A stalled release card's action: cancel the release, then open Create release so the
	// user re-releases with the same version; the held merges then wait for the new release's review.
	const rerelease = useCallback(
		async (id: string): Promise<void> => {
			const t = tasksRef.current.find((x) => x.id === id);
			if (t === undefined) return;
			if (
				!(await confirmDialog(
					`Cancel release ${t.releaseVersion ?? ""} and open Create release? The held merges then wait for the new release's review.`,
					{ ok: "Cancel release", danger: true },
				))
			)
				return;
			void act(async () => {
				const url = `/api/projects/${encodeURIComponent(t.project)}/tasks/${t.id}/cancel`;
				const r = await post<{ kept?: string }>(url, {});
				// The server kept unmerged work and wants a second yes; a release card normally keeps nothing.
				if (r.kept !== undefined) {
					if (
						!(await confirmDialog(
							`Delete the kept worktree and branch of ${t.id} "${t.title}"? The worktree was kept: ${r.kept}.`,
							{ ok: "Delete", danger: true },
						))
					)
						return;
					await post(url, { force: true });
				}
				setShowRelease(true);
			});
		},
		[act],
	);
	const [showDiagrams, setShowDiagrams] = useState(false);
	const [showJira, setShowJira] = useState(false);
	// The search box takes each keystroke uncontrolled; the filter lands after the
	// pause (SEARCH_APPLY_MS), so a big board does not re-render per keypress.
	const [applied, applySearch] = useDelayedState(SEARCH_APPLY_MS);
	// The review prompt's skill gap: the overdue Start review button and the menu's
	// review and release controls share it.
	const reviewNote = skillGapNote(userLayer ?? null, "review");
	// Mobile stage tabs: which column the single-column tier shows; the desktop grid ignores it.
	const [stage, setStage] = useState<Stage>("todo");
	const stageTab = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		// Center alignment stays stable while tap feedback shrinks the button.
		stageTab.current?.scrollIntoView({ block: "nearest", inline: "center" });
	}, [stage]);
	// Horizontal swipe on the board flips to the neighbor column; touch start point.
	const touchStart = useRef<{ x: number; y: number } | null>(null);
	const swipeStage = (dir: number) => {
		const next = Math.max(
			0,
			Math.min(STAGE_KEYS.length - 1, STAGE_KEYS.indexOf(stage) + dir),
		);
		setStage(STAGE_KEYS[next] ?? stage);
	};
	// Done lane lazy load: how many read cards render before "Show more" appends a page.
	const [doneLimit, setDoneLimit] = useState(DONE_PAGE);
	// The flat view's pinned Starred section: one collapse toggle, default expanded.
	const [starredCollapsed, setStarredCollapsed] = useState(false);
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
	const q = applied.trim().toLowerCase();
	// The target branch name without the origin/ prefix; the project's default branch.
	const short = project.target?.startsWith("origin/")
		? project.target.slice(7)
		: null;
	/** One push-main endpoint call; the run verdict drives BusyButton's styling. */
	const pushMain = () =>
		act(async () => {
			await post(
				`/api/projects/${encodeURIComponent(project.name)}/push-main`,
				{},
			);
		});
	/** One project interview endpoint call; its verdict becomes a board notice. */
	const interview = (path: string, body: Record<string, unknown>) =>
		act(async () => {
			const r = await post<{ interview: string }>(
				`/api/projects/${encodeURIComponent(project.name)}${path}`,
				body,
			);
			onNotice(interviewMsg(r.interview));
		});
	// The live rules interview card, if any: the no-rules advisory then offers opening it
	// instead of a second "Discuss rules" that would only answer "queued".
	const rulesTask = liveCardOf(tasks, "interview");
	// Search filter and per-stage counts (unit-tested in queue.ts): the tab strip and lane heads read them.
	const { shown, counts } = laneCounts(
		tasks,
		applied,
		seenAnswers,
		seenDoneSince,
	);
	// The search count matches the lanes: a retro off the board is no task to count.
	const boardTotal = tasks.filter(onBoard).length;
	return (
		<section className="project" aria-labelledby="project-title">
			<header className="project-head">
				<div className="project-id">
					<ProjectLogo project={project} />
					<div className="project-id-text">
						<h1 id="project-title">{projectLabel(project)}</h1>
						<ProjectMeta project={project} />
					</div>
				</div>
				<div className="project-actions">
					<span className={q === "" ? "search-group" : "search-group filtered"}>
						<input
							type="search"
							className={q === "" ? "search" : "search filtered"}
							placeholder="Search tasks"
							aria-label="Search tasks"
							// Uncontrolled: each keystroke stays in the DOM input, no board render.
							defaultValue=""
							onChange={(e) => applySearch(e.target.value)}
						/>
						<span
							className="search-count"
							role="status"
							title={
								q === "" ? "Tasks in this project" : "Matching of total tasks"
							}
						>
							{q === "" ? boardTotal : `${shown.length}/${boardTotal}`}
						</span>
					</span>
					{/* Only an overdue review stays out, as the grey nudge; every other action waits in the menu. */}
					{project.archReview?.due && !project.archReview.running && (
						<button
							type="button"
							className="arch-start"
							title={`Pick a model and create a task that reviews the whole repo, the same review a release runs${reviewNote === null ? "" : `. ${reviewNote}`}`}
							onClick={() => setShowReview(true)}
						>
							<Icon name="shield-check" size={13} />
							Start review
							{reviewNote !== null && <SkillGapMark note={reviewNote} />}
						</button>
					)}
					<JiraImportButton
						project={project}
						onOpen={() => setShowJira(true)}
					/>
					{/* Project settings now lives in the menu, so every project gets the menu;
					    review, release and diagrams stay conditional inside it. */}
					<ProjectMenu
						project={project}
						userLayer={userLayer ?? null}
						startReview={() => setShowReview(true)}
						showRelease={() => setShowRelease(true)}
						showDiagrams={() => setShowDiagrams(true)}
					/>
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
					userLayer={userLayer ?? null}
					onClose={() => setShowDiagrams(false)}
					act={act}
					open={open}
				/>
			)}
			{showJira && project.settings.jiraConnection !== null && (
				<JiraImportDialog
					project={project}
					onClose={() => setShowJira(false)}
					openTask={open}
				/>
			)}
			<ProjectAdvisories
				project={project}
				hosted={hosted}
				short={short}
				q={q}
				shown={shown}
				pushMain={pushMain}
				saveCheck={saveCheck}
				interview={interview}
				rulesTask={rulesTask}
				openTask={open}
			/>
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
					rulesTask={rulesTask?.id ?? null}
					openTask={open}
					onClose={() => setSetupOpen(false)}
				/>
			)}
			{/* Mobile stage tabs appear only in the single-column tier (container ≤440px).
			    Equal-width tabs keep labels, counts and alarm marks whole. The outer strip
			    scrolls, never the page. Done has no count because it shows landed history. */}
			<div className="stage-tabs" role="tablist" aria-label="Board stages">
				<div>
					{COLUMNS.map((c) => {
						const count = counts[c.key];
						return (
							<button
								key={c.key}
								ref={stage === c.key ? stageTab : null}
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
								{c.key !== "done" && (
									<>
										<span className="tabs-digits">
											{q === ""
												? fmtNum(count.shown)
												: `${fmtNum(count.shown)}/${fmtNum(count.total)}`}
										</span>
										{count.alarm !== null && (
											<span
												role="img"
												title={
													count.alarm === "asked"
														? "Question asked"
														: "Needs action"
												}
												aria-label={
													count.waiting === 1
														? "1 task needs action"
														: `${count.waiting} tasks need action`
												}
											>
												<Mark kind={count.alarm} />
											</span>
										)}
									</>
								)}
							</button>
						);
					})}
				</div>
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
					const { col, doneHidden } = laneColumnData(
						c.key,
						shown,
						q,
						doneLimit,
						seenAnswers,
						seenDoneSince,
					);
					const count = counts[c.key];
					const unread = (t: TaskCard): boolean =>
						isUnread(t, seenAnswers, seenDoneSince);
					const onReorder = (
						dragId: string,
						beforeId: string | null,
					): Promise<boolean> => {
						const order = reorderIds(tasks, c.key, dragId, beforeId);
						if (order === null) return Promise.resolve(true);
						return act(() =>
							post(`/api/projects/${encodeURIComponent(project.name)}/queue`, {
								order,
							}).then(() => undefined),
						);
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
								<span className="stage-name">{c.label}</span>
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
										? fmtNum(col.length)
										: `${fmtNum(col.length)}/${fmtNum(count.total)}`}
								</span>
							</h2>
							<LaneCol
								stage={c.key}
								tasks={col}
								more={c.key === "done" ? doneHidden : 0}
								onMore={() => setDoneLimit((n) => n + DONE_PAGE)}
								starredCollapsed={starredCollapsed}
								onStarredToggle={() => setStarredCollapsed((c) => !c)}
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
								foreignDeps={foreignDeps}
								onRerelease={rerelease}
								hasRules={project.hasRules}
								github={project.github}
								deltas={deltas}
								open={open}
								unread={unread}
								onReorder={onReorder}
								filtering={q !== ""}
								draining={draining}
								tick={tick}
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
 * openTask the alarm bell popover uses, a warning through the project's path. */
function Triage({
	projects,
	tasks,
	openTask,
	navigate,
	setup,
}: {
	projects: ProjectView[];
	tasks: TaskCard[];
	openTask: (id: string) => void;
	/** Plain-click navigation to a view path (see navClick). */
	navigate: (path: string) => void;
	/** Board-wide setup problems (setupHints); each row opens Settings → Alate. */
	setup: SetupHint[];
}) {
	const { needs, asks } = splitAlarms(tasks);
	// Rank first (P0 before P3, unrated last), then updatedAt is when the card
	// last changed, i.e. when it started waiting on you.
	const cards = [...needs, ...asks].sort(triageWait);
	const projectWarns = projects.flatMap((p) =>
		[
			!p.hasRules && "No AGENTS.md, tasks wait",
			p.dirty && "Uncommitted changes",
			p.gitless && "No git repo",
		]
			.filter((w): w is string => w !== false)
			.map((text) => ({ project: p, text })),
	);
	const warns = [...setup, ...projectWarns];
	return (
		<section aria-labelledby="triage-title">
			<div className="ov-head">
				<h2 className="ov-sec" id="triage-title">
					Your turn
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
								<a
									key={t.id}
									className="tri"
									href={taskPath(t.project, t.id)}
									onClick={(e) => navClick(e, () => openTask(t.id))}
								>
									<Mark kind={cardMark(t)} />
									{owner !== undefined && <ProjectTag project={owner} />}
									<span className="t">{t.title}</span>
									<RankBadges task={t} />
									<span className="k">{t.id}</span>
									<span className="w">
										{duration(Date.now() - t.updatedAt)}
									</span>
								</a>
							);
						})}
						{cards.length > 0 && warns.length > 0 && (
							<div className="tri-sep" />
						)}
						{setup.map((h) => (
							<button
								type="button"
								className="tri warn"
								key={`setup:${h.text}`}
								onClick={() => openSettingsSection("alate-section")}
							>
								<Mark kind={h.kind} />
								<span className="tri-setup" aria-hidden="true">
									<Icon name="gear" size={14} />
								</span>
								<span className="t">{h.text}</span>
								<span className="rank-badges" />
								<span className="k">Setup</span>
								<span className="w" />
							</button>
						))}
						{projectWarns.map(({ project, text }) => (
							<a
								className="tri warn"
								key={`${project.name}:${text}`}
								href={projectPath(project.name)}
								onClick={(e) => navClick(e, navigate)}
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

const OVERVIEW_TABS = ["now", "perf", "setup"] as const;
type OverviewTab = (typeof OVERVIEW_TABS)[number];

/** The plant overview in three tabs: Now (Your turn and the projects table; clicking a row
 * opens that project), Performance (fleet KPIs, per-project table) and Setup (provisioning). */
export function Overview({
	projects,
	tasks,
	compose,
	onAdd,
	openTask,
	navigate,
	prov,
}: {
	projects: ProjectView[];
	tasks: TaskCard[];
	compose: (name: string) => void;
	onAdd: () => void;
	openTask: (id: string) => void;
	/** Plain-click navigation to a view path (see navClick). */
	navigate: (path: string) => void;
	/** The provisioning poll App owns; null data before the first answer (hosted mode keeps it null). */
	prov: { data: ProvisioningResponse | null; err: string | null };
}) {
	const hosted = useContext(HostedContext);
	const [range, setRange] = useState<PerfRange>("all");
	const { perf, err, refreshing } = usePerf(range);
	// The provisioning poll lives in App: the Setup tab reads it here, and the skill-gap
	// markers on the Diagrams, review and release controls read it on the project view.
	// Tabs: Now (what waits on you, the live projects), Performance and Setup.
	const [picked, setTab] = useState<OverviewTab>("now");
	const [showBoardJira, setShowBoardJira] = useState(false);
	const tabs: readonly OverviewTab[] = hosted
		? OVERVIEW_TABS.filter((t) => t !== "setup")
		: OVERVIEW_TABS;
	// A selection of a tab that hosted mode hides falls back to Now.
	const tab = tabs.includes(picked) ? picked : "now";
	if (projects.length === 0) {
		return (
			<section className="empty">
				<h1>No projects yet</h1>
				<p>
					Point at any directory. Ottr gives every task its own worktree and
					agent, then merges the finished work; a directory without a git repo
					gets a Create git repo action first.
				</p>
				<button type="button" className="primary" onClick={onAdd}>
					<Icon name="plus" />
					Add project
				</button>
			</section>
		);
	}
	const rangeButtons = (
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
	);
	const perfStatus = (
		<>
			{err !== null && (
				<p className="perf-error" role="alert">
					<Mark kind="crit" />
					<span>Performance data unavailable: {err}</span>
				</p>
			)}
			{perf === null && err === null && (
				<Skeleton shape="stats" rows={7} label="Loading the performance view" />
			)}
		</>
	);
	// One card, like Projects: the KPI strip, a hairline, then the per-project table, whose first
	// header names the range. The same range buttons drive both.
	const performance = (
		<section aria-labelledby="perf-title" className="perf">
			<div className="ov-head">
				{/* The Performance tab names the section; the heading stays for screen readers. */}
				<h2 className="ov-sec sr" id="perf-title">
					Performance
				</h2>
				{rangeButtons}
			</div>
			{perfStatus}
			{perf !== null && (
				<div className="ov-wrap">
					<KpiStrip fleet={perf.fleet} openTask={openTask} />
					<PerfTable
						perf={perf}
						projects={projects}
						firstCol={`By project · ${PERF_RANGE_LABELS[perf.range]}`}
						openTask={openTask}
					/>
				</div>
			)}
		</section>
	);
	const projectsNow = (
		<>
			<div className="ov-head">
				<h2 className="ov-sec" id="live-title">
					Projects
				</h2>
				<JiraBoardImportButton onOpen={() => setShowBoardJira(true)} />
			</div>
			<div className="ov-wrap">
				<table className="ov ov-phone">
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
							// The cards the project's board lists: a retro off the board counts nowhere.
							const own = tasks.filter(
								(t) => t.project === p.name && onBoard(t),
							);
							const split = splitAlarms(own);
							// Last activity reads every card, cancelled ones included: the cancel
							// stamp is the project's latest event (updateTask bumps updated_at)
							// and the card stays visible under Done.
							const last = Math.max(0, ...own.map((t) => t.updatedAt));
							return (
								<tr
									key={p.name}
									onClick={(e) => {
										// Row click = plain-click link: modifier and middle clicks
										// keep the browser's own behavior.
										if (
											e.button === 0 &&
											!e.metaKey &&
											!e.ctrlKey &&
											!e.shiftKey &&
											!e.altKey
										)
											navigate(projectPath(p.name));
									}}
								>
									<th scope="row">
										<a
											href={projectPath(p.name)}
											onClick={(e) => {
												// The anchor navigates; keep the row handler from
												// pushing the same path a second time.
												e.stopPropagation();
												navClick(e, navigate);
											}}
										>
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
									<td data-label="Action required">
										<span>
											{split.needs.length > 0 && (
												<span className="needs-count">
													<Mark kind="needs" />
													{split.needs.length}
													<span className="sr"> need action</span>
												</span>
											)}
											{split.asks.length > 0 && (
												<span className="needs-count ask-n">
													<Mark kind="asked" />
													{split.asks.length}
													<span className="sr"> asked</span>
												</span>
											)}
											{split.needs.length === 0 && split.asks.length === 0 && (
												<span className="ov-none">None</span>
											)}
										</span>
									</td>
									{COLUMNS.map((c) => {
										// Count what the board lanes show: laneStage sends a cancelled
										// card to Done, however old its stage column still reads.
										const inStage = own.filter((t) => laneStage(t) === c.key);
										const running = splitAlarms(inStage).running.length;
										return (
											<td
												key={c.key}
												data-label={c.label}
												className={inStage.length === 0 ? "zero" : undefined}
											>
												<span>
													{running > 0 && (
														<>
															<Mark kind="running" />
															<span className="sr">{running} running of </span>
														</>
													)}
													{inStage.length}
												</span>
											</td>
										);
									})}
									<td className="age" data-label="Last activity">
										<span>{last > 0 ? age(last) : "–"}</span>
									</td>
									<td data-label="New task">
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
		</>
	);
	// Every setup row opens the Alate card, which hosted mode hides with the Setup tab.
	const setup = hosted ? [] : setupHints(prov.data, prov.err);
	const { needs, asks } = splitAlarms(tasks);
	const turn = needs.length + asks.length;
	const tabProps = (key: OverviewTab) => ({
		type: "button" as const,
		role: "tab",
		id: `ov-tab-${key}`,
		"aria-controls": `ov-panel-${key}`,
		"aria-selected": tab === key,
		tabIndex: tab === key ? 0 : -1,
		"data-tab": key,
		onClick: () => setTab(key),
		onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) =>
			switchTab(e, tabs, setTab),
	});
	const panelProps = (key: OverviewTab) => ({
		role: "tabpanel",
		id: `ov-panel-${key}`,
		"aria-labelledby": `ov-tab-${key}`,
		className: "ov-panel",
		hidden: tab !== key,
	});
	return (
		<section className="overview" aria-labelledby="overview-title">
			<h1 id="overview-title">Overview</h1>
			<div
				className="add-tabs ov-tabs"
				role="tablist"
				aria-label="Overview sections"
			>
				<button {...tabProps("now")}>
					Now
					{turn > 0 && <span className="ov-tab-n">{turn}</span>}
				</button>
				<button {...tabProps("perf")}>Performance</button>
				{/* No agent server blocks every worker's provisioning: the tab says so in amber,
				    like the Setup panel's callout; other setup hints keep the grey mark. */}
				{tabs.includes("setup") && (
					<button
						{...tabProps("setup")}
						data-alarm={prov.data?.server === null ? "" : undefined}
					>
						Setup
						{setup.length > 0 && (
							<>
								<Mark kind={prov.data?.server === null ? "needs" : "warn"} />
								<span className="sr"> needs attention</span>
							</>
						)}
					</button>
				)}
			</div>
			<div {...panelProps("now")}>
				<Triage
					projects={projects}
					tasks={tasks}
					openTask={openTask}
					navigate={navigate}
					setup={setup}
				/>
				{projectsNow}
				{showBoardJira && (
					<JiraBoardImportDialog
						projects={projects}
						onClose={() => setShowBoardJira(false)}
						navigate={navigate}
					/>
				)}
			</div>
			<div {...panelProps("perf")}>{performance}</div>
			{tabs.includes("setup") && (
				<div {...panelProps("setup")}>
					<Provisioning data={prov.data} err={prov.err} />
				</div>
			)}
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
	{ key: "requirements", label: "Python" },
	{ key: "env", label: "Env" },
] as const;

/** One "Your turn" row per board-wide setup problem: the alate server line when it is not ok,
 *  or the failed provisioning fetch. A healthy setup gives no row. */
export interface SetupHint {
	text: string;
	kind: "warn" | "crit";
}
export function setupHints(
	data: ProvisioningResponse | null,
	err: string | null,
): SetupHint[] {
	if (err !== null)
		return [{ text: `Provisioning data unavailable: ${err}`, kind: "warn" }];
	if (data === null) return [];
	const line = serverLine(data.server);
	return line.kind === "ok" ? [] : [{ text: line.text, kind: line.kind }];
}

/** The note for a control whose prompt needs skills or rules the workers lack: the missing
 *  names on one line, or null when the workers hold everything (or no layer loaded yet).
 *  The control appends the note to its title and shows the marker next to it. */
export function skillGapNote(
	userLayer: ProvisioningResponse["userLayer"] | null,
	use: SkillUse,
): string | null {
	if (userLayer === null) return null;
	const names = missingByUse(userLayer)[use];
	return names.length === 0 ? null : `Missing on workers: ${names.join(", ")}`;
}

/** The always-visible warning mark for such a control; the note rides the aria-label and
 *  the title, so the gap reaches keyboard and screen-reader users, not only the mouse. */
function SkillGapMark({ note }: { note: string }) {
	return (
		<span role="img" aria-label={note} title={note} className="skill-gap-mark">
			<Mark kind="warn" />
		</span>
	);
}

/** Polls GET /api/provisioning every 60 s (the endpoint runs a live probe, so it must not ride
 *  the 1 s state push). App reads it once for the Setup panel, Your turn and the skill-gap
 *  markers on the prompts' controls. Off while `enabled` is false: hosted mode has no Setup
 *  tab, and the operator owns the workers' layer. */
function useProvisioning(enabled: boolean): {
	data: ProvisioningResponse | null;
	err: string | null;
} {
	const [data, setData] = useState<ProvisioningResponse | null>(null);
	const [err, setErr] = useState<string | null>(null);
	useEffect(() => {
		if (!enabled) return;
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
	}, [enabled]);
	return { data, err };
}

/** The alate server state and the worker lists, from the Overview's useProvisioning. */
function Provisioning({
	data,
	err,
}: {
	data: ProvisioningResponse | null;
	err: string | null;
}) {
	return (
		<section className="prov" aria-labelledby="prov-title">
			<div className="prov-head">
				<h2 className="ov-sec" id="prov-title">
					Provisioning
				</h2>
				{data !== null &&
					(data.server === null ? (
						// No agent server stops provisioning for every worker: it waits on the
						// user like a needs-action card, so it takes the amber callout.
						<div className="prov-callout" role="status">
							<Mark kind="needs" />
							<span className="prov-callout-text">
								<b>Agent server not configured</b>
								<small>
									Workers get no omp rules, settings, skills or plugins until an
									Alate server is set.
								</small>
							</span>
							<button
								type="button"
								onClick={() => openSettingsSection("alate-section")}
							>
								Open setup
							</button>
						</div>
					) : (
						<p className="prov-server">
							{(() => {
								const line = serverLine(data.server);
								return (
									<>
										{line.kind !== "ok" && (
											<Mark kind={line.kind === "crit" ? "crit" : "warn"} />
										)}
										{line.text}
									</>
								);
							})()}
						</p>
					))}
			</div>
			{err !== null && (
				<p className="prov-error" role="alert">
					<Mark kind="crit" />
					<span>Provisioning data unavailable: {err}</span>
				</p>
			)}
			{data === null && err === null && (
				<Skeleton shape="rows" rows={4} label="Loading provisioning" />
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

/** Sub-heading label for the per-project table, e.g. "By project, last 7 days". */
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
/** Context-window sizes read at a glance: k below a million, M above. */
const tokFmt = (v: number | null) =>
	v === null
		? "–"
		: v >= 1_000_000
			? `${(v / 1_000_000).toFixed(1)}M`
			: v >= 10_000
				? `${Math.round(v / 1000)}k`
				: String(v);

/** The seven fleet tiles: grey everywhere, an amber edge only on a
 * failure rate past the 0.10 alarm line. */
export function KpiStrip({
	fleet: f,
	openTask,
}: {
	fleet: PerfMetrics;
	openTask: (id: string) => void;
}) {
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
			<Kpi
				label="Context, avg"
				stat={f.contextAvgTokens}
				text={tokFmt(f.contextAvgTokens.value)}
				sub={
					f.done === 0
						? null
						: f.contextMissing > 0
							? `${f.contextMissing} of ${f.done} no data`
							: `${f.done} done`
				}
				dFmt={tokFmt}
				pFmt={tokFmt}
			/>
			<Kpi
				label="Context, max"
				stat={f.contextMaxTokens}
				text={tokFmt(f.contextMaxTokens.value)}
				sub={f.contextMaxTask === null ? null : f.contextMaxTask.id}
				dFmt={tokFmt}
				pFmt={tokFmt}
				link={
					f.contextMaxTask === null
						? undefined
						: {
								id: f.contextMaxTask.id,
								project: f.contextMaxTask.project,
								title: `Open ${f.contextMaxTask.project} ${f.contextMaxTask.id}`,
							}
				}
				onOpen={openTask}
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
	link,
	onOpen,
}: {
	label: string;
	stat: PerfStat;
	text: string;
	sub: string | null;
	dFmt: (abs: number) => string;
	pFmt: (n: number) => string;
	alarm?: boolean;
	/** Task the value points at; the link wraps the value so the whole number opens the card. */
	link?: { id: string; project: string; title: string } | null;
	onOpen?: (id: string) => void;
}) {
	const { value, prev } = stat;
	const d = value !== null && prev !== null ? value - prev : null;
	const vContent = (
		<>
			{text}
			{sub !== null && <small>{sub}</small>}
		</>
	);
	return (
		<div className={alarm ? "kpi alarm" : "kpi"}>
			<span className="l">
				{alarm && <Mark kind="needs" />}
				{label}
			</span>
			<span className="v">
				{link !== undefined && link !== null && onOpen !== undefined ? (
					<a
						className="v-link"
						href={taskPath(link.project, link.id)}
						title={link.title}
						onClick={(e) => navClick(e, () => onOpen(link.id))}
					>
						{vContent}
					</a>
				) : (
					vContent
				)}
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
export function PerfTable({
	perf,
	projects,
	firstCol = "Project",
	openTask,
}: {
	perf: PerfResponse;
	projects: ProjectView[];
	/** Header of the project column; the Performance card puts the range label here. */
	firstCol?: string;
	openTask: (id: string) => void;
}) {
	const viewOf = (name: string) => projects.find((p) => p.name === name);
	const labelOf = (name: string) => viewOf(name)?.settings.displayName ?? name;
	const rows = perf.projects;
	// Column max for the bar scaling; a silent column scales by 1 so its bars stay empty.
	const maxOf = (get: (m: PerfMetrics) => number | null) =>
		Math.max(...rows.map((r) => get(r) ?? 0), 0) || 1;
	// Bare table: the Performance section frames it, and the same range buttons drive it.
	return (
		<table className="ov ov-phone">
			<thead>
				<tr>
					<th scope="col">{firstCol}</th>
					<th scope="col">Throughput</th>
					<th scope="col">Lead time (median / p90)</th>
					<th scope="col">First-pass</th>
					<th scope="col">Failure rate</th>
					<th scope="col">Spend</th>
					<th scope="col">Context (avg)</th>
					<th scope="col">Context (max)</th>
				</tr>
			</thead>
			<tbody>
				{rows.map((p) => {
					const alarm = (p.failure.value ?? 0) > 0.1;
					const view = viewOf(p.name);
					// Narrow once so the link id stays non-null inside the JSX.
					const maxTask = p.contextMaxTask;
					return (
						<tr key={p.name}>
							<th scope="row">
								<span className="p">
									{view !== undefined && <ProjectTag project={view} />}
									{labelOf(p.name)}
								</span>
							</th>
							<td data-label="Throughput">
								<CellBar
									text={p.throughput.value ?? "–"}
									ratio={
										(p.throughput.value ?? 0) / maxOf((m) => m.throughput.value)
									}
								/>
							</td>
							<td data-label="Lead time (median / p90)">
								<CellBar
									text={
										<>
											{durFmt(p.leadMedianMs.value)}
											<span className="sub">/ {durFmt(p.leadP90Ms.value)}</span>
										</>
									}
									ratio={
										(p.leadMedianMs.value ?? 0) /
										maxOf((m) => m.leadMedianMs.value)
									}
								/>
							</td>
							<td data-label="First-pass">
								<CellBar
									text={pctFmt(p.firstPass.value)}
									ratio={
										(p.firstPass.value ?? 0) / maxOf((m) => m.firstPass.value)
									}
								/>
							</td>
							<td data-label="Failure rate">
								<span>
									{alarm && <Mark kind="needs" />}
									<CellBar
										text={pctFmt(p.failure.value)}
										ratio={
											(p.failure.value ?? 0) / maxOf((m) => m.failure.value)
										}
										alarm={alarm}
									/>
								</span>
							</td>
							<td data-label="Spend">
								<CellBar
									text={usdFmt(p.spend.value)}
									ratio={(p.spend.value ?? 0) / maxOf((m) => m.spend.value)}
								/>
							</td>
							<td data-label="Context (avg)">
								<CellBar
									text={tokFmt(p.contextAvgTokens.value)}
									ratio={
										(p.contextAvgTokens.value ?? 0) /
										maxOf((m) => m.contextAvgTokens.value)
									}
								/>
							</td>
							<td data-label="Context (max)">
								<CellBar
									text={
										maxTask === null ? (
											tokFmt(p.contextMaxTokens.value)
										) : (
											<a
												className="v-link"
												href={taskPath(maxTask.project, maxTask.id)}
												title={`Open ${maxTask.project} ${maxTask.id}`}
												onClick={(e) => navClick(e, () => openTask(maxTask.id))}
											>
												{tokFmt(p.contextMaxTokens.value)}
											</a>
										)
									}
									ratio={
										(p.contextMaxTokens.value ?? 0) /
										maxOf((m) => m.contextMaxTokens.value)
									}
								/>
							</td>
						</tr>
					);
				})}
			</tbody>
		</table>
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

/** Slide the lane's cards to their new places; the farthest traveler (the dropped card) passes over the neighbours it crosses. */
function playSlides(
	els: Map<string, HTMLElement>,
	slides: Map<string, number>,
): void {
	if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
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
}

/** The focused queued card an Alt+Arrow press targets, or null when the key press is not a lane reorder. */
function queueTarget(
	e: React.KeyboardEvent,
	queued: readonly TaskCard[],
): { id: string; idx: number } | null {
	if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return null;
	const el = (e.target as HTMLElement).closest<HTMLElement>(
		".card[data-task-id]",
	);
	if (el === null) return null;
	const id = el.dataset.taskId;
	if (id === undefined) return null;
	const idx = queued.findIndex((t) => t.id === id);
	if (idx < 0) return null;
	return { id, idx };
}

/** A lane's card content: the empty state, the pinned Inbox and Starred groups, the flat list, then the "Show more" button. */
function LaneCards(p: {
	stage: Stage;
	filtering: boolean;
	hasTasks: boolean;
	total: number;
	unread: (t: TaskCard) => boolean;
	fresh: TaskCard[];
	starred: TaskCard[];
	view: TaskCard[];
	more: number;
	onMore: (() => void) | undefined;
	/** LaneCol's useId value: names the Starred body for aria-controls. */
	uid: string;
	starredCollapsed: boolean;
	onStarredToggle: (() => void) | undefined;
	showMore: (e: ReactMouseEvent<HTMLButtonElement>, go: () => void) => void;
	card: (t: TaskCard) => ReactNode;
}) {
	const {
		stage,
		filtering,
		hasTasks,
		unread,
		uid,
		view,
		more,
		onMore,
		showMore,
		card,
	} = p;
	return (
		<>
			{!hasTasks && (
				<p className="stage-empty">
					{filtering ? "No matches." : EMPTY_STAGE[stage]}
				</p>
			)}
			{p.fresh.length > 0 && <p className="lane-label">Inbox</p>}
			{p.fresh.map(p.card)}
			{p.fresh.length > 0 && p.fresh.length + p.starred.length < p.total && (
				<hr className="lane-divider" />
			)}
			{p.starred.length > 0 && (
				<section
					className="starred"
					data-collapsed={p.starredCollapsed || undefined}
				>
					<button
						type="button"
						className="starred-head"
						aria-expanded={!p.starredCollapsed}
						aria-controls={`${uid}-starred`}
						onClick={p.onStarredToggle}
					>
						<svg className="chev" viewBox="0 0 8 8" aria-hidden="true">
							<path d="M2 3l2 2 2-2" />
						</svg>
						<span className="lane-label">Starred</span>
						<span className="topic-count">{p.starred.length}</span>
					</button>
					<div className="starred-body" id={`${uid}-starred`}>
						<div className="starred-cards">{p.starred.map(p.card)}</div>
					</div>
				</section>
			)}
			{/* A collapsed section is just its head, whose own fill already separates
			    it from the cards below; the trailing rule renders only while open. */}
			{p.starred.length > 0 &&
				!p.starredCollapsed &&
				p.fresh.length + p.starred.length < p.total && (
					<hr className="lane-divider" />
				)}
			{
				// Only the done lane pins unread and starred cards above; other lanes show every card.
				view
					.filter(
						(t) =>
							stage !== "done" ||
							t.cancelledAt !== null ||
							(!unread(t) && !t.starred),
					)
					.map(card)
			}
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
		</>
	);
}

/**
 * One stage column; every card renders and the column scrolls when they overflow.
 * The browser owns the scroll position: no page state to clamp when the list shrinks,
 * and keyboard focus into an off-screen card scrolls it into view for free.
 */
/** The drag-and-drop and keyboard props for a lane with queued cards; empty when reorder is off. */
function laneDndProps(p: {
	dnd: boolean;
	busy: boolean;
	dragId: string | null;
	setDrop: (v: string | null | undefined) => void;
	clear: () => void;
	dropAt: (y: number) => string | null | undefined;
	sendReorder: (id: string, before: string | null) => void;
	queueKeydown: (e: React.KeyboardEvent) => void;
}) {
	const onKeyDown = p.busy ? undefined : p.queueKeydown;
	if (!p.dnd) return { onKeyDown };
	const onDragLeave = (e: React.DragEvent): void => {
		const rect = e.currentTarget.getBoundingClientRect();
		if (
			e.clientX < rect.left ||
			e.clientX > rect.right ||
			e.clientY < rect.top ||
			e.clientY > rect.bottom
		)
			p.setDrop(undefined);
	};
	if (p.dragId === null) return { onDragLeave, onKeyDown };
	const dragId = p.dragId;
	const onDragOver = (e: React.DragEvent): void => {
		if ((e.target as Element).closest('.card:not([draggable="true"])')) {
			p.setDrop(undefined);
			return;
		}
		e.preventDefault();
		e.dataTransfer.dropEffect = "move";
		p.setDrop(p.dropAt(e.clientY));
	};
	const onDrop = (e: React.DragEvent): void => {
		if ((e.target as Element).closest('.card:not([draggable="true"])')) return;
		e.preventDefault();
		const before = p.dropAt(e.clientY);
		if (before === undefined) {
			p.clear();
			return;
		}
		// Clearing here, not in onDragEnd: setPending re-renders before the browser
		// dispatches dragend, which detaches the drag prop and its handler, so a
		// stale drop would re-send the reorder after the order confirms.
		p.clear();
		p.sendReorder(dragId, before);
	};
	return { onDragOver, onDrop, onDragLeave, onKeyDown };
}

/** Which open release holds each queued merge: the inverse of the release cards' heldMerges lists. */
function heldByMap(
	projectTasks: readonly TaskCard[],
): Map<string, { id: string; version: string | null }> {
	const heldBy = new Map<string, { id: string; version: string | null }>();
	for (const r of projectTasks) {
		if (r.heldMerges === undefined) continue;
		for (const id of r.heldMerges)
			heldBy.set(id, { id: r.id, version: r.releaseVersion });
	}
	return heldBy;
}

/** The lane's rendered list: with an overlay held, non-queued cards keep their positions first and the queued block follows the client's order (the partition laneOrder draws). */
function laneView(
	tasks: readonly TaskCard[],
	localOrder: readonly string[] | null,
): TaskCard[] {
	if (localOrder === null) return [...tasks];
	return [
		...tasks.filter((t) => t.state !== "queued"),
		...localOrder
			.map((id) => tasks.find((t) => t.id === id))
			.filter((t) => t !== undefined),
	];
}

export function LaneCol({
	stage,
	tasks,
	projectTasks,
	foreignDeps,
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
	starredCollapsed = false,
	onStarredToggle,
	onRerelease,
	tick,
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
	/** Done lane only: the pinned Starred section starts collapsed when true. */
	starredCollapsed?: boolean;
	/** Done lane only: flips the Starred section's collapse state. */
	onStarredToggle?: () => void;
	/** Every lane's cards: a dependency hold must find a dependency that sits in another lane. */
	projectTasks: TaskCard[];
	/** OTTR-708: looks a dependsOn id up across every project's cards, so a hold names a
	 * foreign card; absent before the first state frame or for an unknown project. */
	foreignDeps?: DepIndex;
	/** Cancels the stalled release card this id names and opens Create release; set only for
	 * the release flow. */
	onRerelease?: (id: string) => void;
	hasRules: boolean;
	github: string | null;
	deltas: Map<string, number>;
	open: (id: string) => void;
	unread: (t: TaskCard) => boolean;
	onReorder: (dragId: string, beforeId: string | null) => Promise<boolean>;
	filtering: boolean;
	/** True while an update holds new turns (POST /api/drain): queued cards wait for the restart. */
	draining: boolean;
	/** The board's 30 s clock tick; feeds the memoized cards so their ages keep ticking. */
	tick?: number;
}) {
	const uid = useId();
	const boxRef = useRef<HTMLDivElement | null>(null);
	// Optimistic overlay: the queued-id order the client adopted on a reorder tap, before the
	// server frame confirms it. null = render the server order; a failed POST clears it and
	// the FLIP effect slides the cards back.
	const [localOrder, setLocalOrder] = useState<string[] | null>(null);
	const [dragId, setDragId] = useState<string | null>(null);
	// undefined = old place/no slot, null = end, string = insert before that card.
	const [drop, setDrop] = useState<string | null | undefined>(undefined);
	// A reorder request in flight: the moved card dims, and every reorder path (drag, drop,
	// keyboard) is blocked until it settles. The new order shows at once via localOrder.
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
		playSlides(els, slides);
	});
	// Queued-card facts the drag map keys on: the joined id order changes only when the
	// queue's membership or order changes, so unchanged frames reuse the drag objects.
	const queued = tasks.filter((t) => t.state === "queued");
	const queuedIds = queued.map((t) => t.id).join(" ");
	const dnd = queued.length >= 2;
	const busy = pending !== null;
	const clear = useCallback((): void => {
		setDragId(null);
		setDrop(undefined);
	}, []);
	// Per-card facts over the project's cards, one pass per lane render: holdFor, reReleaseOf
	// and statusLine each scan the project's cards, so calling them per rendered card is
	// quadratic on a big board. The lane's own cards and the parked backlog row join the pass,
	// because a lane list can hold cards the project list misses in tests.
	const facts = useMemo(() => {
		const holds = new Map<string, string | null>();
		const statuses = new Map<string, string>();
		const rereleases = new Map<
			string,
			{ ids: string[]; findings: number } | null
		>();
		const done = new Set<string>();
		const scan = (list: readonly TaskCard[]): void => {
			for (const t of list) {
				if (done.has(t.id)) continue;
				done.add(t.id);
				const hold = holdFor(t, projectTasks, foreignDeps);
				holds.set(t.id, hold);
				statuses.set(
					t.id,
					statusLine(t, hasRules, hold, draining, projectTasks),
				);
				rereleases.set(t.id, reReleaseOf(t, projectTasks));
			}
		};
		scan(projectTasks);
		scan(tasks);
		if (parked !== undefined) scan(parked);
		return { holds, statuses, rereleases };
	}, [projectTasks, tasks, parked, hasRules, draining, foreignDeps]);
	// One drag wiring per queued card, rebuilt only when the drag state or the queued order
	// changes: a fresh object on every frame would break the memoized Card's shallow compare.
	// The handlers capture the id, never the card object, so a changed card elsewhere in the
	// project does not rebuild them.
	const drags = useMemo(() => {
		const m = new Map<string, CardDrag>();
		if (!dnd || busy) return m;
		for (const id of queuedIds.split(" ")) {
			m.set(id, {
				draggable: true,
				dragging: dragId === id,
				dropBefore: drop === id,
				onDragStart: (e) => {
					// Firefox refuses to start a drag with an empty dataTransfer.
					e.dataTransfer.setData("text/plain", id);
					e.dataTransfer.effectAllowed = "move";
					// The end slot previews the dragged card's own height.
					boxRef.current?.style.setProperty(
						"--drag-h",
						`${e.currentTarget.offsetHeight}px`,
					);
					// Hollow the card only after the browser has captured it as the drag image.
					requestAnimationFrame(() => setDragId(id));
				},
				onDragEnd: clear,
			});
		}
		return m;
	}, [dnd, busy, queuedIds, dragId, drop, clear]);
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
	// Settle: once a server frame's queued order matches the overlay, the overlay is
	// redundant and clears (any later change re-renders from the server order).
	useEffect(() => {
		if (localOrder === null) return;
		const serverQueued = tasks
			.filter((t) => t.state === "queued")
			.map((t) => t.id)
			.join(" ");
		if (serverQueued === localOrder.join(" ")) setLocalOrder(null);
	}, [tasks, localOrder]);

	// Keyboard reorder: Alt+Arrow moves the focused queued card within its column's queued block.
	const queueKeydown = (e: React.KeyboardEvent): void => {
		const hit = queueTarget(e, queued);
		if (hit === null) return;
		const { id, idx } = hit;
		if (e.key === "ArrowUp" && idx > 0) {
			const prev = queued[idx - 1];
			if (prev !== undefined) sendReorder(id, prev.id);
			e.preventDefault();
		} else if (e.key === "ArrowDown" && idx < queued.length - 1) {
			const next = queued[idx + 2];
			sendReorder(id, next !== undefined ? next.id : null);
			e.preventDefault();
		}
	};

	if (!hasTasks && !showBacklogRow)
		return (
			<p className="stage-empty">
				{filtering ? "No matches." : EMPTY_STAGE[stage]}
			</p>
		);

	// --- Queue drag & drop (native HTML5) -------------------------------------
	// Only queued cards drag; only queued cards and the area below them are drop
	// targets, so a queued card can never land above a running/needs_you card.
	// The rendered list: with an overlay held, non-queued cards keep their positions first
	// and the queued block follows the client's order (the partition laneOrder draws).
	const view = laneView(tasks, localOrder);
	// One reorder at a time: a second request would be computed from the pre-reorder order and
	// overwrite the first on the server (last write wins). Every reorder path routes through here.
	const sendReorder = (id: string, before: string | null): void => {
		// `tasks` is this column's laneOrder-ed list; reorderIds over it yields the column's
		// queued-id order, which the server's queuedAt rewrite reproduces exactly.
		const next = reorderIds(tasks, stage, id, before);
		setPending({ id, before });
		if (next !== null) setLocalOrder(next);
		void onReorder(id, before)
			.then((ok) => {
				if (!ok) setLocalOrder(null);
			})
			.finally(() => setPending(null));
	};
	// Keyboard reorder: Alt+Arrow moves the focused queued card within its column's queued block.
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
	const heldBy = heldByMap(projectTasks);
	const card = (t: TaskCard): ReactNode => (
		<Card
			key={t.id}
			task={t}
			github={github}
			delta={deltas.get(t.id)}
			hold={facts.holds.get(t.id) ?? null}
			status={facts.statuses.get(t.id)}
			fuOf={t.followUpOf}
			onOpen={open}
			unread={unread(t)}
			locked={pending?.id === t.id}
			holdRelease={heldBy.get(t.id)}
			onOpenTask={open}
			reRelease={facts.rereleases.get(t.id) ?? null}
			onRerelease={
				onRerelease !== undefined &&
				(facts.rereleases.get(t.id) ?? null) !== null
					? onRerelease
					: undefined
			}
			drag={drags.get(t.id)}
			tick={tick}
		/>
	);
	// Done lane: unseen answers pin above a divider; read cards keep landing order (stable
	// partition). A cancelled card never pins: its answer is final.
	const fresh =
		stage === "done"
			? tasks.filter((t) => t.cancelledAt === null && unread(t))
			: [];
	// Done lane: starred research cards pin above the main list; unread wins over starred.
	// A cancelled card never lands here: it pages in the main list.
	const starred =
		stage === "done"
			? tasks.filter((t) => t.cancelledAt === null && t.starred && !unread(t))
			: [];
	return (
		<div
			className={`stage-cards${drop === null ? " drop-end" : ""}`}
			ref={boxRef}
			aria-busy={busy || undefined}
			{...laneDndProps({
				dnd,
				busy,
				dragId,
				setDrop,
				clear,
				dropAt,
				sendReorder,
				queueKeydown,
			})}
		>
			<LaneCards
				stage={stage}
				filtering={filtering}
				hasTasks={hasTasks}
				total={tasks.length}
				unread={unread}
				fresh={fresh}
				starred={starred}
				view={view}
				more={more}
				onMore={onMore}
				uid={uid}
				starredCollapsed={starredCollapsed}
				onStarredToggle={onStarredToggle}
				showMore={showMore}
				card={card}
			/>
			{parked != null && (
				<>
					<hr className="lane-divider" />
					<p className="lane-label backlog-head">
						Backlog
						{parkedTotal !== undefined && (
							<span className="backlog-count">{parkedTotal}</span>
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
								<kbd>B</kbd>
							</button>
						)}
					</p>
				</>
			)}
			{parked?.map(card)}
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

function fmtBytes(n: number): string {
	return n >= 1e6
		? `${(n / 1e6).toFixed(1)} MB`
		: n >= 1e3
			? `${(n / 1e3).toFixed(1)} kB`
			: `${n} B`;
}

async function fetchSessionContext(
	url: string,
): Promise<SessionContext | null> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(String(res.status));
	const v = (await res.json()) as { context: SessionContext | null };
	return v.context;
}

/** One streaming log chunk: appends received bytes and returns true while more of the log remains. */
async function fetchLogChunk(
	project: string,
	taskId: string,
	offset: { current: number },
	decoder: TextDecoder,
	alive: () => boolean,
	onChunk: (chunk: string) => void,
): Promise<boolean> {
	const res = await fetch(
		`/api/projects/${encodeURIComponent(project)}/tasks/${taskId}/log?from=${offset.current}`,
	);
	if (!res.ok || !alive()) return false;
	const buf = await res.arrayBuffer();
	if (!alive() || buf.byteLength === 0) return false;
	offset.current += buf.byteLength; // only bytes actually received
	const chunk = decoder.decode(buf, { stream: true });
	if (chunk.length > 0) onChunk(chunk);
	return offset.current < Number(res.headers.get("X-Log-Size"));
}

/** Session context usage for a task: one snapshot fetch when the drawer opens, re-polled every
 * 5 s only while the card is running; null when unknown or failing. */
function useSessionContext(
	project: string,
	taskId: string,
	reloadKey: string,
	running: boolean,
): SessionContext | null {
	const [ctx, setCtx] = useState<SessionContext | null>(null);
	useEffect(() => {
		let alive = true;
		const url = `/api/projects/${encodeURIComponent(project)}/tasks/${taskId}/context`;
		const load = async (): Promise<void> => {
			try {
				const v = await fetchSessionContext(url);
				if (alive) setCtx(v);
			} catch {
				if (alive) setCtx(null);
			}
		};
		void load();
		// A done or idle card's context is static: only a live turn earns the 5 s poll.
		if (!running)
			return () => {
				alive = false;
			};
		const timer = setInterval(() => void load(), 5000);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, [project, taskId, reloadKey, running]);
	return ctx;
}

export function LogView({
	project,
	taskId,
	startedAt,
	logOffset,
}: {
	project: ProjectView;
	taskId: string;
	/** The expanded turn's startedAt: the view starts at this turn's own log section. */
	startedAt: number;
	/** Byte offset in the card log where the expanded turn's own section starts (its `== turn`
	 *  header); null keeps the old whole-log fetch and the client-side turnLogStart slice. */
	logOffset?: number | null;
}) {
	const [text, setText] = useState("");
	const [full, setFull] = useState(false);
	const offset = useRef(0);
	const stick = useRef(true);
	const pre = useRef<HTMLPreElement | null>(null);
	// Fetch base: "Full log" always refetches the whole card log from 0; the turn view starts
	// at the turn's stored byte offset when known, else at 0 (the header slice still trims).
	const base = full ? 0 : (logOffset ?? 0);
	useEffect(() => {
		let alive = true;
		let fetching = false;
		let dirty = false; // a trigger during a fetch marks this; exactly one more fetch runs after
		const decoder = new TextDecoder();
		offset.current = base;
		setText("");
		const drain = async (): Promise<void> => {
			// Fetch again while behind: one call returns at most 256 KiB, so a long log would otherwise stop after the first chunk.
			while (alive) {
				const more = await fetchLogChunk(
					project.name,
					taskId,
					offset,
					decoder,
					() => alive,
					(chunk) => setText((prev) => prev + chunk),
				);
				if (!more) return;
			}
		};
		const tick = async (): Promise<void> => {
			if (fetching) {
				dirty = true;
				return;
			}
			fetching = true;
			try {
				await drain();
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
	}, [project.name, taskId, base]);

	useEffect(() => {
		const el = pre.current;
		if (el && stick.current) el.scrollTop = el.scrollHeight;
	}, [text]);

	// The expanded turn shows its own section: from its header on. A log without that
	// header (file recreated after the turn) falls back to the whole text so no output hides.
	const start = full ? 0 : (turnLogStart(text, startedAt) ?? 0);
	const shown = text.slice(start);
	return (
		<>
			<div className="log-head">
				<button
					type="button"
					className="log-mode"
					aria-pressed={!full}
					onClick={(e) => {
						e.stopPropagation();
						setFull(false);
					}}
					onKeyDown={(e) => e.stopPropagation()}
				>
					Turn log
				</button>
				<button
					type="button"
					className="log-mode"
					aria-pressed={full}
					onClick={(e) => {
						e.stopPropagation();
						setFull(true);
					}}
					onKeyDown={(e) => e.stopPropagation()}
				>
					Full log
				</button>
			</div>
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
				{shown.length > 0 ? shown : "(no log output yet)"}
			</pre>
		</>
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
 * The WS state frame owns the data; the panel fires a refresh, optimistic Allow/Skip taps
 * (clear-or-hide first, rollback on a failed POST), and skip POSTs. */
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
	const allow = useInstantSave(act);
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
							// Optimistic: the selection clears the moment the request goes out; a
							// failed allow restores exactly the ids that were being sent.
							const ids = withTarget.map((r) => r.id);
							setSelected(new Set());
							allow.run(
								() => post("/api/updates/allow", { ids, propose: false }),
								() => setSelected(new Set(ids)),
							);
						}}
					>
						Allow
					</button>
					<button
						type="button"
						disabled={allow.busy || noTarget.length === 0}
						onClick={() => {
							const ids = noTarget.map((r) => r.id);
							setSelected(new Set());
							allow.run(
								() => post("/api/updates/allow", { ids, propose: true }),
								() => setSelected(new Set(ids)),
							);
						}}
					>
						Propose
					</button>
				</div>
				{all.length > 0 && (
					<label
						className="updates-all"
						title="Also show releases younger than 7 days (Propose until they qualify)"
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

/** The "in progress" link to an update card that already covers this row (U6). */
function UpdateCardLink({
	card,
	openTask,
}: {
	card: TaskCard;
	openTask: (id: string) => void;
}) {
	return (
		<a
			className="updates-inprogress"
			href={taskPath(card.project, card.id)}
			title={card.sessionTitle}
			onClick={(e) => navClick(e, () => openTask(card.id))}
		>
			in progress
		</a>
	);
}

/** Per-file diff links of an update row; spans because an actionable row is a <label>, which allows phrasing content only. */
function UpdateDiffs({ diffs }: { diffs: UpdateRow["diffs"] }) {
	if (diffs === undefined || diffs.length === 0) return null;
	return (
		<span className="updates-diffs">
			{diffs.map((d) => (
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
	// Optimistic Skip: the row hides the moment the tap lands, the skip POST rolls it
	// back on failure, and the WS state frame removes it for good. The server marks a
	// skipped row without creating ids, so the tap is reversible and safe to lead with.
	const skip = useInstantSave(act);
	const [hidden, setHidden] = useState(false);
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
			disabled={skip.busy}
			onClick={() => {
				setHidden(true);
				skip.run(
					() => post("/api/updates/skip", { id: row.id }),
					() => setHidden(false),
				);
			}}
		>
			Skip
		</button>
	);
	if (hidden) return null;
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
						<UpdateCardLink card={card} openTask={openTask} />
					)}
				</span>
			) : row.managedBy !== undefined ? (
				<span className="dialog-sub">managed by {row.managedBy}</span>
			) : card !== null ? (
				// U6: an open card owns this row; clicking jumps to it instead of offering Skip.
				<UpdateCardLink card={card} openTask={openTask} />
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
			<UpdateDiffs diffs={row.diffs} />
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
/** The "Git URL" tab of the Add-project dialog: URL and name fields, the SSH key choice,
 * and the token fieldset the server demands on a 400 needsToken. */
function AddUrlPanel({
	mode,
	url,
	onUrl,
	urlProblem,
	name,
	onName,
	ssh,
	sshMode,
	setSshMode,
	hosts,
	pendingKey,
	onPending,
	runSshTest,
	onSshTestOk,
	needsTokenHost,
	tokUser,
	onTokUser,
	tokToken,
	onTokToken,
	saveToken,
	boardTokenUsable,
	useBoardToken,
}: {
	mode: "url" | "new";
	url: string;
	onUrl: (u: string) => void;
	urlProblem: string | null;
	name: string;
	onName: (n: string) => void;
	ssh: boolean;
	sshMode: "global" | "new";
	setSshMode: (m: "global" | "new") => void;
	hosts: GitHostsView | null;
	pendingKey: PendingKeyInfo | null;
	onPending: (p: PendingKeyInfo | null) => void;
	runSshTest: (trust?: string[]) => Promise<TestAnswer>;
	onSshTestOk: () => void;
	needsTokenHost: string | null;
	tokUser: string;
	onTokUser: (u: string) => void;
	tokToken: string;
	onTokToken: (t: string) => void;
	saveToken: () => void;
	boardTokenUsable: boolean;
	useBoardToken: () => void;
}) {
	return (
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
					inputMode="url"
					spellCheck={false}
					autoComplete="off"
					aria-invalid={urlProblem !== null || undefined}
					aria-describedby={
						urlProblem !== null ? "add-git-url-error" : undefined
					}
				/>
				{urlProblem !== null && (
					<span className="auth-error" id="add-git-url-error" role="alert">
						{urlProblem}
					</span>
				)}
				<code>https or SSH git URL</code>
			</label>
			<label>
				Name
				<input
					value={name}
					onChange={(e) => onName(e.target.value)}
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
								No global key exists; set one in Settings → Git identity → SSH
								key.
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
						<PendingKeyRow pending={pendingKey} onPending={onPending} />
					)}
					<SshTestRow send={runSshTest} onOk={onSshTestOk} />
					<p className="hint">
						Add stays disabled until the test passed for this URL and key.
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
						<span className="opt-mark">(optional)</span>
						<input
							value={tokUser}
							onChange={(e) => onTokUser(e.target.value)}
							placeholder={defaultGitUsername(
								needsTokenHost ?? "",
								hosts?.githubHost ?? null,
							)}
						/>
					</label>
					<label>
						Token
						<input
							type="password"
							value={tokToken}
							onChange={(e) => onTokToken(e.target.value)}
							autoComplete="off"
							required
						/>
					</label>
					<button type="button" disabled={tokToken === ""} onClick={saveToken}>
						Save token and retry
					</button>
					{boardTokenUsable && (
						<button type="button" onClick={useBoardToken}>
							Use the board GitHub token
						</button>
					)}
				</fieldset>
			)}
		</div>
	);
}

/** The private-repo hint line of the "New" tab: the signed-in state plus name availability. */
function GhRepoHint({
	gh,
	free,
	onClose,
}: {
	gh: GhStatus;
	free: boolean | null;
	onClose: () => void;
}) {
	const hosted = useContext(HostedContext);
	return gh.authed ? (
		<p className="hint">
			Repo will be created under {gh.user}.
			{free === false
				? ` That name is already taken on ${gh.host}.`
				: free === true
					? ` The name is free on ${gh.host}.`
					: ""}
		</p>
	) : (
		<p className="hint trust-warn" role="status">
			{/* Hosted mode hides the git credential cards: the control plane owns git credentials. */}
			{hostedHidden(hosted, "github-token-block") ? (
				<>
					No Git host is signed in, so Ottr cannot create the repo. Uncheck the
					box for a local repo only.
				</>
			) : (
				<>
					No Git host is signed in, so Ottr cannot create the repo. Add a token
					in Settings → Other git hosts, or uncheck the box for a local repo
					only.{" "}
					<button
						type="button"
						className="notif-link"
						onClick={() => {
							onClose();
							openSettingsSection("github-token-block");
						}}
					>
						Open settings
					</button>
				</>
			)}
		</p>
	);
}

/** The Add-project POST body shared by both submit paths. */
function addGitProjectRequest(req: {
	url: string;
	name: string;
	taskIdPrefix: string;
	sshKey: string | undefined;
	trust: string[] | undefined;
}): ReturnType<typeof gitReq> {
	return gitReq("POST", "/api/projects", {
		url: req.url,
		name: req.name === "" ? undefined : req.name,
		taskIdPrefix: req.taskIdPrefix,
		sshKey: req.sshKey,
		trust: req.trust,
	});
}

function reportAddedProject(
	data: unknown,
	hooks: {
		onAdded: (interview: string) => void;
		setAdded: (v: {
			project: ProjectView;
			interview: string;
			id: string | null;
		}) => void;
	},
): void {
	const r = data as unknown as AddProjectResponse; // unchecked cast: the server's documented answer shape
	hooks.onAdded(r.interview);
	hooks.setAdded({
		project: r.project,
		interview: r.interview,
		id: r.id ?? null,
	});
}

/** The Add submit from the form: success reports the project, otherwise it raises
 * the trust step, the token step or the server's error into the dialog. */
async function addGitProject(
	req: {
		url: string;
		name: string;
		taskIdPrefix: string;
		sshKey: string | undefined;
		trust: string[] | undefined;
	},
	hooks: {
		onAdded: (interview: string) => void;
		setAdded: (v: {
			project: ProjectView;
			interview: string;
			id: string | null;
		}) => void;
		setAddTrust: (t: TrustNeeded) => void;
		setNeedsTokenHost: (h: string) => void;
	},
): Promise<void> {
	const { status, data } = await addGitProjectRequest(req);
	const t = asTrust(data);
	if (status < 300) {
		reportAddedProject(data, hooks);
		return;
	}
	if (t !== null) {
		hooks.setAddTrust(t);
		throw new Error(t.error);
	}
	if (typeof data.needsToken === "string") {
		hooks.setNeedsTokenHost(data.needsToken);
		throw new Error(asError(data, status, "adding the project"));
	}
	throw new Error(asError(data, status, "adding the project"));
}

/** The Add retry after the user confirmed the trust prompt: success clears the prompt. */
async function addGitProjectTrusted(
	req: {
		url: string;
		name: string;
		taskIdPrefix: string;
		sshKey: string | undefined;
		trust: string[] | undefined;
	},
	hooks: {
		onAdded: (interview: string) => void;
		setAdded: (v: {
			project: ProjectView;
			interview: string;
			id: string | null;
		}) => void;
		setAddTrust: (t: TrustNeeded | null) => void;
	},
): Promise<TestAnswer> {
	const { status, data } = await addGitProjectRequest(req);
	const t = asTrust(data);
	if (status < 300) {
		reportAddedProject(data, hooks);
		hooks.setAddTrust(null);
		return { ok: true } as const;
	}
	if (t !== null) return t;
	return { error: asError(data, status, "adding the project") };
}

/** Empty keeps the server's derived default; otherwise 1 to 8 letters and digits. */
function prefixUsable(prefixOut: string): boolean {
	return prefixOut === "" || /^[A-Z0-9]{1,8}$/.test(prefixOut);
}

/** The task ID prefix field with its duplicate-handle warning; shared by both source tabs. */
function AddPrefixField({
	prefix,
	setPrefix,
	prefixOut,
	projects,
}: {
	prefix: string;
	setPrefix: (v: string) => void;
	prefixOut: string;
	projects: ProjectView[];
}) {
	const clash =
		prefixOut !== "" && projects.some((p) => p.taskPrefix === prefixOut);
	return (
		<>
			<label>
				Task ID prefix
				<input
					maxLength={8}
					value={prefix}
					aria-label="Task ID prefix"
					onChange={(e) => {
						setPrefix(e.target.value);
					}}
				/>
				<code>1 to 8 letters and digits</code>
			</label>
			{clash && (
				<p className="hint trust-warn" role="status">
					The task ID prefix {prefixOut} is already in use. Pick another prefix,
					or tasks from both projects will look shared.
				</p>
			)}
		</>
	);
}

/** The tab strip of the Add-project dialog. */
function AddTabs({
	mode,
	setMode,
}: {
	mode: "url" | "new";
	setMode: (m: "url" | "new") => void;
}) {
	return (
		<div className="add-tabs" role="tablist" aria-label="Project source">
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
				<Icon name="plus" />
				New
			</button>
		</div>
	);
}

/** The dialog's submit row: Add stays disabled until the SSH test passed or the host sign-in blocks it. */
function AddSubmitButton({
	busy,
	failed,
	mode,
	ssh,
	sshTested,
	noGitHost,
}: {
	busy: boolean;
	failed: boolean;
	mode: "url" | "new";
	ssh: boolean;
	sshTested: boolean;
	noGitHost: boolean;
}) {
	const untested = mode === "url" && ssh && !sshTested;
	return (
		<div className="dialog-actions">
			<button
				type="submit"
				disabled={busy || untested || noGitHost}
				className={`primary${failed ? " failed" : ""}`}
				aria-busy={busy || undefined}
				title={
					untested
						? "Run the SSH test first"
						: noGitHost
							? "Sign in to a Git host in Settings, or uncheck the repo box"
							: undefined
				}
			>
				{busy && <span className="spinner" aria-hidden="true" />}
				<Icon name="plus" />
				Add project
			</button>
		</div>
	);
}

/** The "new" tab of the Add dialog: the project name plus the optional private repo
 * push, with host sign-in hints when the repo box is checked. */
function AddNewPanel({
	mode,
	name,
	setName,
	ghRepo,
	setGhRepo,
	gh,
	free,
	repoName,
	onClose,
}: {
	mode: "url" | "new";
	name: string;
	setName: (n: string) => void;
	ghRepo: boolean;
	setGhRepo: (v: boolean) => void;
	gh: GhStatus | null;
	free: boolean | null;
	repoName: string;
	onClose: () => void;
}) {
	return (
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
				Create a private repo on {gh?.host ?? "the configured Git host"} and
				push
			</label>
			{ghRepo &&
				(gh === null ? null : (
					<GhRepoHint gh={gh} free={free} onClose={onClose} />
				))}
			{!ghRepo && gh !== null && (
				<p className="hint">
					Without a repo the project lives in {gh.dir}/{repoName || "…"} on this
					host; nothing is pushed.
				</p>
			)}
		</div>
	);
}

export function AddProjectModal({
	act,
	onClose,
	onAdded,
	openTask,
	projects,
}: {
	act: Act;
	onClose: () => void;
	onAdded: (interview: string) => void;
	/** Opens the rules interview card in the board drawer: the wizard's "Open rules task". */
	openTask: (id: string) => void;
	projects: ProjectView[];
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
	// The task ID prefix: follows the derived value from the name until the user edits it.
	const [prefix, setPrefix] = useState("");
	const [prefixTouched, setPrefixTouched] = useState(false);
	const [hosts, setHosts] = useState<GitHostsView | null>(null);
	const [sshMode, setSshMode] = useState<"global" | "new">("global");
	const [pendingKey, setPendingKey] = useState<PendingKeyInfo | null>(null);
	const [trusted, setTrusted] = useState<string[] | undefined>(undefined);
	const [tested, setTested] = useState<string | null>(null); // "url\0key" that passed
	const [addTrust, setAddTrust] = useState<TrustNeeded | null>(null);
	const [needsTokenHost, setNeedsTokenHost] = useState<string | null>(null);
	const [tokUser, setTokUser] = useState("oauth2");
	// When the hosts view lands and names the configured GitHub host, prefill the
	// host's token convention ("x-access-token") instead of the generic "oauth2".
	useEffect(() => {
		if (needsTokenHost !== null && hosts !== null) {
			setTokUser(defaultGitUsername(needsTokenHost, hosts.githubHost));
		}
	}, [needsTokenHost, hosts]);
	const [tokToken, setTokToken] = useState("");
	const repoName = name.trim();
	// The effective handle: uppercase, and empty keeps the server's derived default.
	const prefixOut = prefix.trim().toUpperCase();
	const trimmedUrl = url.trim();
	// The URL field's own error (The Error-Says-Fix Rule): shown while the URL tab
	// holds a value that cannot parse, under the field it names.
	const urlProblem = gitUrlProblem(trimmedUrl);
	const ssh = isSshUrl(trimmedUrl);
	const sshKey = ssh
		? sshMode === "global"
			? "global"
			: `pending:${pendingKey?.id ?? ""}`
		: undefined;
	// gh facts for the New tab's hints: auth state, login, projects root, name check.
	const [gh, setGh] = useState<GhStatus | null>(null);
	const [free, setFree] = useState<boolean | null>(null);
	// A checked repo box needs a signed-in Git host; Add waits until one is (or the box clears).
	// A failed probe (gh null) blocks nothing: the server still answers at submit.
	const noGitHost = mode === "new" && ghRepo && gh?.authed === false;
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
	const onName = (n: string): void => {
		setName(n);
		if (!prefixTouched) setPrefix(derivedTaskPrefix(n));
	};
	const onUrl = (u: string): void => {
		setUrl(u);
		if (!nameTouched) {
			const seg = (
				u.trim().replace(/\/+$/, "").split(/[:/]/).pop() ?? ""
			).replace(/\.git$/, "");
			onName(seg);
		}
	};
	// The prefix must stay a short handle of letters and digits; the server
	// normalizes case itself, but the client rejects other characters early.
	const prefixValid = prefixUsable(prefixOut);
	// The Add call: ssh URLs carry the key choice; the server answers with trust or token steps.
	const addProject = (trust?: string[]): void => {
		if (!prefixValid) {
			setErr("The task ID prefix must be 1 to 8 letters and digits.");
			return;
		}
		add.start(() =>
			act(
				async () =>
					await addGitProject(
						{
							url: trimmedUrl,
							name: repoName,
							taskIdPrefix: prefixOut,
							sshKey,
							trust,
						},
						{
							onAdded,
							setAdded,
							setAddTrust: (t) => setAddTrust(t),
							setNeedsTokenHost: (h) => setNeedsTokenHost(h),
						},
					),
				setErr,
			),
		);
	};
	// The created project: once set, the dialog shows the setup wizard instead of the form.
	const [added, setAdded] = useState<{
		project: ProjectView;
		interview: string;
		id: string | null;
	} | null>(null);
	// A token save for the host the server named, then the retry of Add.
	const saveToken = (): void => {
		void act(async () => {
			const { status, data } = await gitReq("POST", "/api/git-hosts/tokens", {
				host: needsTokenHost ?? "",
				username:
					tokUser.trim() ||
					defaultGitUsername(needsTokenHost ?? "", hosts?.githubHost ?? null),
				token: tokToken,
				testUrl: trimmedUrl,
			});
			if (status !== 200)
				throw new Error(
					asError(data, status, `saving the token for ${needsTokenHost}`),
				);
			setNeedsTokenHost(null);
			setTokToken("");
			addProject(trusted);
		}, setErr);
	};
	// One click opts the board GitHub token in for this host: the server stores it as the
	// host's entry (username x-access-token) and the Add retries.
	const useBoardToken = (): void => {
		void act(async () => {
			const { status, data } = await gitReq(
				"POST",
				"/api/git-hosts/github-token",
				{
					testUrl: trimmedUrl,
				},
			);
			if (status !== 200)
				throw new Error(asError(data, status, "saving the board GitHub token"));
			setNeedsTokenHost(null);
			setTokToken("");
			addProject(trusted);
		}, setErr);
	};
	// The board token can stand in only when the dialog's host IS the configured
	// GitHub host and the board actually has one.
	const boardTokenUsable =
		needsTokenHost !== null &&
		hosts?.githubTokenSet === true &&
		hosts.githubHost !== null &&
		needsTokenHost.toLowerCase() === hosts.githubHost;
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
			return { error: asError(data, status, "the SSH key test") };
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
								// The field error already says why; a known-bad URL never posts.
								if (urlProblem !== null) return;
								addProject(trusted);
								return;
							}
							if (!prefixValid) {
								setErr("The task ID prefix must be 1 to 8 letters and digits.");
								return;
							}
							add.start(() =>
								act(async () => {
									const r = await post<AddProjectResponse>("/api/projects", {
										name: name.trim(),
										taskIdPrefix: prefixOut,
										github: ghRepo,
									});
									onAdded(r.interview);
									setAdded({
										project: r.project,
										interview: r.interview,
										id: r.id ?? null,
									});
								}, setErr),
							);
						}}
					>
						<AddTabs mode={mode} setMode={setMode} />
						<AddUrlPanel
							mode={mode}
							url={url}
							onUrl={onUrl}
							urlProblem={urlProblem}
							name={name}
							onName={(n) => {
								setNameTouched(true);
								setName(n);
								if (!prefixTouched) setPrefix(derivedTaskPrefix(n));
							}}
							ssh={ssh}
							sshMode={sshMode}
							setSshMode={setSshMode}
							hosts={hosts}
							pendingKey={pendingKey}
							onPending={(p) => {
								setPendingKey(p);
								setTested(null);
							}}
							runSshTest={runSshTest}
							onSshTestOk={() => setTested(`${trimmedUrl}\0${sshKey ?? ""}`)}
							needsTokenHost={needsTokenHost}
							tokUser={tokUser}
							onTokUser={setTokUser}
							tokToken={tokToken}
							onTokToken={setTokToken}
							saveToken={saveToken}
							boardTokenUsable={boardTokenUsable}
							useBoardToken={useBoardToken}
						/>
						<AddNewPanel
							mode={mode}
							name={name}
							setName={(n) => onName(n)}
							ghRepo={ghRepo}
							setGhRepo={setGhRepo}
							gh={gh}
							free={free}
							repoName={repoName}
							onClose={onClose}
						/>
						<AddPrefixField
							prefix={prefix}
							setPrefix={(v) => {
								setPrefixTouched(true);
								setPrefix(v);
							}}
							prefixOut={prefixOut}
							projects={projects}
						/>
						{err !== null && (
							<p className="auth-error" role="alert">
								{err}
							</p>
						)}
						{addTrust !== null && (
							<SshTestRow
								label="Add project"
								success="Project added"
								send={(trust) =>
									addGitProjectTrusted(
										{
											url: trimmedUrl,
											name: repoName,
											taskIdPrefix: prefixOut,
											sshKey,
											trust,
										},
										{
											onAdded,
											setAdded,
											setAddTrust: (t) => setAddTrust(t),
										},
									)
								}
							/>
						)}
						<AddSubmitButton
							busy={add.busy}
							failed={add.failed}
							mode={mode}
							ssh={ssh}
							sshTested={sshTested}
							noGitHost={noGitHost}
						/>
					</form>
				) : (
					<ProjectSetupSteps
						project={added.project}
						interview={added.interview}
						rulesTask={added.id}
						openTask={openTask}
						act={act}
						onClose={onClose}
					/>
				)}
			</div>
		</Modal>
	);
}

/** The question line: text with inline diff links plus the answered marker. */
function AskText({
	q,
	changed,
	done,
	onOpenDiff,
}: {
	q: AskQuestion;
	changed: string[];
	done: boolean;
	onOpenDiff: (files: string[]) => void;
}) {
	return (
		<p className="ask-text">
			{/* Shape carries the per-question state: ? = open, check = answered. */}
			<Mark kind={done ? "done" : "asked"} />
			{/* One span keeps the parts in normal inline flow: the paragraph is a flex row, and
				separate flex items per part would wrap the text out of reading order. */}
			<span>
				{diffLinkParts(q.question, changed).map((part, pi) =>
					part.kind === "text" ? (
						<Fragment key={pi}>{part.text}</Fragment>
					) : (
						<button
							key={pi}
							type="button"
							className="diff-link"
							title={
								part.files.length === 1
									? "View this file's diff"
									: "View these files' diff"
							}
							onClick={() => onOpenDiff(part.files)}
						>
							{part.label === "" ? part.files.join(", ") : part.label}
						</button>
					),
				)}
			</span>
			<span className="sr">{done ? " (answered)" : " (needs an answer)"}</span>
		</p>
	);
}

/** One preset option row: the whole entry (row + description) is one label, so it is one hover/click target. */
function AskOption({
	q,
	o,
	oi,
	name,
	multi,
	picked,
	selected,
	busy,
	onToggle,
	onPreset,
}: {
	q: AskQuestion;
	o: AskQuestion["options"][number];
	oi: number;
	name: string;
	multi: boolean;
	picked: string[];
	selected: string | null;
	busy: boolean;
	onToggle: (label: string) => void;
	onPreset: (text: string, preset: boolean) => void;
}) {
	const chosen = multi ? picked.includes(o.label) : selected === o.label;
	return (
		<label className={`ask-opt${chosen ? " chosen" : ""}${busy ? " off" : ""}`}>
			<input
				type={multi ? "checkbox" : "radio"}
				name={name}
				checked={chosen}
				disabled={busy}
				onChange={() => (multi ? onToggle(o.label) : onPreset(o.label, true))}
				// aria-label keeps the name the short option text; the wrapped
				// description would otherwise become part of the radio's name.
				aria-label={o.label}
				aria-describedby={
					o.description === undefined ? undefined : `${name}-opt-${oi}-desc`
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
}

/** A multi question's answer text: the checked presets plus the "Other" row (typed text,
 * or the bare pick when the field stays empty), as one comma list; null when nothing. */
function askMultiText(
	picked: string[],
	otherOn: boolean,
	text: string,
): string | null {
	const v = text.trim();
	const parts = [...picked];
	if (v !== "") parts.push(v);
	else if (otherOn) parts.push("Other");
	return parts.length === 0 ? null : parts.join(", ");
}

/** The "Other" row of an ask question: the custom pick control, the text field and the submit button. */
// The custom row's radio joins the preset group: checked once the saved answer is not a preset.
function customChosen(q: AskQuestion, selected: string | null): boolean {
	return selected !== null && !q.options.some((o) => o.label === selected);
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

function AskCustom({
	q,
	multi,
	name,
	busy,
	selected,
	picked,
	customOn,
	setCustomOn,
	custom,
	setCustom,
	customRef,
	onDraft,
	onAnswer,
	multiTotal,
}: {
	q: AskQuestion;
	multi: boolean;
	name: string;
	busy: boolean;
	selected: string | null;
	picked: string[];
	customOn: boolean;
	setCustomOn: (v: boolean) => void;
	custom: string;
	setCustom: (v: string) => void;
	customRef: React.RefObject<HTMLInputElement | null>;
	onDraft: (text: string | null) => void;
	onAnswer: (text: string) => void;
	multiTotal: number;
}) {
	const customJoined = customOn || custom.trim() !== "";
	// The live picks already are the recorded answer (or both are empty): Answer has nothing to add.
	const multiRecorded =
		multi && askMultiText(picked, customOn, custom) === selected;
	const submitMulti = (): void => {
		const t = askMultiText(picked, customOn, custom);
		// The typed text stays in the input: that input is the only place the recorded
		// custom answer is visible (each preset shows as a check instead).
		if (t !== null) onAnswer(t);
	};
	return (
		<form
			className="ask-custom"
			onSubmit={(e) => {
				e.preventDefault();
				if (multi) submitMulti();
				else {
					const v = custom.trim();
					if (v !== "") onAnswer(v);
				}
			}}
		>
			{/* Single: same radio group as the presets; saving a typed answer checks it. Clicking
			    the radio moves focus to the text field instead of checking a pick that was never
			    saved. Multi: the checkbox is a real pick — it joins the answer as "Other" even
			    when the field stays empty, and typed text checks it on its own. Turning it on
			    focuses the field; the ref lives on the text input, so the focus lands where
			    typing goes. */}
			<input
				type={multi ? "checkbox" : "radio"}
				name={name}
				checked={multi ? customJoined : customChosen(q, selected)}
				disabled={busy}
				aria-label="Other"
				onChange={() => {
					if (!multi) {
						customRef.current?.focus();
						return;
					}
					const next = !customOn;
					setCustomOn(next);
					onDraft(askMultiText(picked, next, custom));
					if (next) customRef.current?.focus();
				}}
			/>
			<label>
				<span>Other</span>
				<input
					ref={customRef}
					value={custom}
					onChange={(e) => {
						setCustom(e.target.value);
						if (multi) onDraft(askMultiText(picked, customOn, e.target.value));
					}}
					placeholder="Deploy only the API"
					disabled={busy}
				/>
			</label>
			<button
				type="submit"
				disabled={busy || (multi ? multiRecorded : custom.trim() === "")}
			>
				{busy && <span className="spinner" aria-hidden="true" />}
				{(selected === null
					? "Answer"
					: multiRecorded
						? "Answered"
						: "Replace answer") +
					(multi && multiTotal > 0 ? ` (${multiTotal})` : "")}
			</button>
		</form>
	);
}

/** One ask question: single-choice presets answer in one click; multi questions collect
 * checkbox picks plus an "Other" pick or typed text and answer with one comma list. */
export function AskBlock({
	q,
	name,
	answered,
	selected,
	busy,
	changed,
	onOpenDiff,
	onAnswer,
	onDraft,
}: {
	q: AskQuestion;
	/** Radio group name: groups a single-choice question's presets. */
	name: string;
	answered: boolean;
	selected: string | null;
	busy: boolean;
	/** The task's changed files: bare quoted paths among these become diff links. */
	changed: string[];
	/** Opens the diff view scoped to the named files (the question's `diff:` links). */
	onOpenDiff: (files: string[]) => void;
	onAnswer: (text: string) => void;
	/** A multi question's live picks as its comma list, or null once nothing is picked:
	 * a check counts as an answer at once, without the Answer button. */
	onDraft: (text: string | null) => void;
}) {
	const multi = q.multi;
	const customRef = useRef<HTMLInputElement>(null);
	const savedParts = selected === null ? [] : selected.split(", ");
	const [picked, setPicked] = useState<string[]>(() =>
		savedParts.filter((l) => q.options.some((o) => o.label === l)),
	);
	const [customOn, setCustomOn] = useState(
		() =>
			!q.options.some((o) => o.label === "Other") &&
			savedParts.includes("Other"),
	);
	const [custom, setCustom] = useState(() =>
		savedParts
			.filter((l) => !q.options.some((o) => o.label === l) && l !== "Other")
			.join(", "),
	);
	const togglePick = (label: string): void => {
		const next = picked.includes(label)
			? picked.filter((l) => l !== label)
			: [...picked, label];
		setPicked(next);
		onDraft(askMultiText(next, customOn, custom));
	};
	// A preset click clears the custom draft (its answer shows on the radio); a custom submit keeps its
	// text in the input, because that input is the only place the recorded custom answer is visible.
	const answer = (text: string, preset: boolean): void => {
		onAnswer(text);
		if (preset) setCustom("");
	};
	const customJoined = customOn || custom.trim() !== "";
	const multiTotal = picked.length + (customJoined ? 1 : 0);
	// A multi question counts as answered as soon as anything is checked.
	const done = answered || (multi && multiTotal > 0);
	return (
		<div className={`ask-q${done ? " answered" : ""}`}>
			<AskText q={q} changed={changed} done={done} onOpenDiff={onOpenDiff} />
			<div className="ask-options">
				{q.options.map((o, oi) => (
					<AskOption
						key={o.label}
						q={q}
						o={o}
						oi={oi}
						name={name}
						multi={multi}
						picked={picked}
						selected={selected}
						busy={busy}
						onToggle={togglePick}
						onPreset={answer}
					/>
				))}
			</div>
			<AskCustom
				q={q}
				multi={multi}
				name={name}
				busy={busy}
				selected={selected}
				picked={picked}
				customOn={customOn}
				setCustomOn={setCustomOn}
				custom={custom}
				setCustom={setCustom}
				customRef={customRef}
				onDraft={onDraft}
				onAnswer={onAnswer}
				multiTotal={multiTotal}
			/>
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
					className="danger"
					run={async () =>
						(await confirmDialog(
							`Finish and discard the worktree?\n\nApplies the choices above, then deletes:\n${task.worktree ?? "the worktree"}${task.branch !== null ? `\nbranch ${task.branch}` : ""}\n\nMoved files are copied to the main checkout first; ignored files are added to .git/info/exclude; deleted files are lost.`,
							{ ok: "Finish and discard", danger: true },
						))
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

/** The drawer section heads' chevron: points down when open, right when collapsed (CSS). */
const SEC_CHEV = (
	<svg className="chev" viewBox="0 0 8 8" aria-hidden="true">
		<path d="M2 3l2 2 2-2" />
	</svg>
);

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
				{SEC_CHEV}
				{label}
			</button>
		</h3>
	);
	return (
		<section className={`dsec${className ? ` ${className}` : ""}`}>
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

/** The in-flight blocks a lazy drawer section holds its space with (Work steps, the file lists). */
function DrawerLoading({ label }: { label: string }) {
	return <Skeleton shape="list" rows={3} label={label} />;
}

/** The ask: a single question answers in one click; several collect answers first so one reply covers them all. */
function AskPanel({
	asked,
	taskId,
	busy,
	failed,
	changed,
	onOpenDiff,
	onSend,
}: {
	asked: AskQuestion[];
	/** Draft key: unsent answers survive closing the drawer and a page reload. */
	taskId: string;
	busy: boolean;
	failed: boolean;
	/** The task's changed files: bare quoted paths among these become diff links. */
	changed: string[];
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
			.map((q, qi) => {
				const a = answers[qi];
				return a !== undefined ? askAnswerLine(q.question, a) : "";
			})
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
					key={qi}
					q={q}
					name={`ask-${qi}`}
					answered={answers[qi] !== undefined}
					selected={answers[qi] ?? null}
					busy={locked}
					changed={changed}
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
					onDraft={(t) => {
						// One question: the reply goes out on Answer, so picks stay local to the block.
						if (asked.length === 1) return;
						const next = { ...answers };
						if (t === null) delete next[qi];
						else next[qi] = t;
						setAnswers(next);
						saveAskDraft(taskId, { fp, answers: next });
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
						Send {fmtNum(count)}/{fmtNum(asked.length)} answers
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

/** First GitHub Actions run URL in the text, canonical form; null when the text links none. */
export function ciRunUrl(text: string): string | null {
	const m =
		/https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/actions\/runs\/(\d+)/.exec(
			text,
		);
	return m === null
		? null
		: `https://github.com/${m[1]}/${m[2]}/actions/runs/${m[3]}`;
}

/** Runs the drawer's "Implement steps" dialog: posts the follow-up handoff on the picked model
 * ("" = the default model), then clears the steps report's Inbox pin (OTTR-488: only the drawer
 * buttons clear it) and hands the new card to the board. Marking waits for the follow-up: a
 * failed post keeps the pin up. Exported for tests. */
export async function implementSteps(o: {
	task: Pick<TaskView, "project" | "id">;
	model: string;
	onMarkSeen: () => void;
	onFollowed: (id: string, from: string) => void;
}): Promise<void> {
	const next = await post<TaskView>(
		`/api/projects/${encodeURIComponent(o.task.project)}/tasks/${o.task.id}/follow-up`,
		{ text: IMPLEMENT_RECOMMENDATIONS, model: o.model || undefined },
	);
	o.onMarkSeen();
	o.onFollowed(next.id, o.task.id);
}

/** moved to ../types.ts (the server resolves stored steps too, OTTR-488) */
export { recommendsSteps };

/** Related cards in the drawer (dependencies, follow-ups): one quiet row per card with the same
 * status words and alarm coding as the meta line; a click opens the card. The href uses each
 * linked card's own project, so a cross-project row opens that project's URL. */
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
					<a
						href={taskPath(k.project, k.id)}
						title={k.sessionTitle ?? k.title}
						onClick={(e) => navClick(e, () => onOpenTask(k.id))}
					>
						<span className="fu-key">{k.id}</span>
						<span className="fu-title">{k.sessionTitle ?? k.title}</span>
						<span
							className={
								k.state === "needs_you"
									? `st st-needs_you${k.asked !== null ? " st-asked" : ""}`
									: "st"
							}
						>
							{/* Same alarm marks as the meta line: markup, not ::before. */}
							{k.state === "needs_you" && <Mark kind={cardMark(k)} />}
							{statusLine(k, project.hasRules, holdFor(k, tasks), draining)}
						</span>
					</a>
				</li>
			))}
		</ul>
	);
}

/** The posted-head label; it shows only while the posted head is the reviewed one. */
function prPostedLabel(pr: PrReviewView): string | null {
	return pr.state === "open" &&
		pr.postedHead !== null &&
		pr.postedHead === pr.reviewedHead
		? `Posted for ${pr.postedHead.slice(0, 7)}${
				pr.postedLogin !== null && pr.postedLogin !== ""
					? ` · Posted as ${pr.postedLogin}`
					: ""
			}`
		: null;
}

/** The posted-head label and the reason Post review is blocked (null when it may run). */
function prPostState(
	pr: PrReviewView,
	draft: string | null,
	cancelledAt: number | null,
	body: string,
): { postedLabel: string | null; blocked: string | null } {
	const postedLabel = prPostedLabel(pr);
	const blocked =
		pr.state !== "open"
			? `PR is ${pr.state}`
			: (postedLabel ??
				(draft === null
					? "No review draft yet"
					: cancelledAt !== null
						? "The card is cancelled"
						: body.trim() === ""
							? "The comment is empty"
							: null));
	return { postedLabel, blocked };
}

/** PR review card: the model's review draft as an editable comment; it reaches GitHub only on the Post click. */
export function PrReviewSection({
	task,
	pr,
	draft,
	act,
	onLoaded,
}: {
	task: TaskView;
	pr: PrReviewView;
	/** The review draft that the watcher saved as the card's details; null before the first review lands. */
	draft: string | null;
	act: Act;
	onLoaded: (v: TaskView) => void;
}) {
	const [body, setBody] = useState(draft ?? "");
	const [error, setError] = useState<string | null>(null);
	// Second composer: a note asking for a fresh draft of the current head. `noteFor` holds
	// what was sent plus the draft at send time, so the hint disappears once new text is
	// typed or a new draft lands on the card.
	const [note, setNote] = useState("");
	const [noteFor, setNoteFor] = useState<{
		text: string;
		draft: string | null;
	} | null>(null);
	const taskUrl = `/api/projects/${encodeURIComponent(task.project)}/tasks/${task.id}`;
	const { postedLabel, blocked } = prPostState(
		pr,
		draft,
		task.cancelledAt,
		body,
	);
	const inlineCount = parseReviewDraft(body).comments.length;
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
					maxLength={REVIEW_BODY_MAX}
					value={body}
					aria-describedby="pr-review-inline"
					onChange={(e) => setBody(e.target.value)}
				/>
				<p id="pr-review-inline" className="dim pr-inline-hint">
					{inlineCount === 0
						? "No inline comments"
						: `${inlineCount} inline comment${inlineCount === 1 ? "" : "s"}`}
					. Lines between <code>{"<!-- inline path:line -->"}</code> and{" "}
					<code>{"<!-- /inline -->"}</code> post as an inline comment on that
					line. A <code>suggestion</code> code block in a comment proposes a
					change.
				</p>
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
						Post review
					</BusyButton>
				</div>
			</div>
			{pr.state === "open" && (
				<div className="reply-form">
					<label htmlFor="pr-review-note">Ask for a new draft</label>
					<textarea
						id="pr-review-note"
						rows={3}
						maxLength={20000}
						value={note}
						onChange={(e) => setNote(e.target.value)}
					/>
					<div className="reply-actions">
						{noteFor !== null &&
							note === noteFor.text &&
							draft === noteFor.draft && (
								<span className="dim">
									The new draft will appear here when it is ready.
								</span>
							)}
						<BusyButton
							// Plain, not primary: a done drawer keeps exactly one primary (Post review).
							disabled={note.trim() === ""}
							run={() =>
								act(async () => {
									setError(null);
									await post(`${taskUrl}/reply`, { text: note });
									setNoteFor({ text: note, draft });
									setNote("");
								}, setError)
							}
						>
							<Icon name="send" />
							Ask for draft
						</BusyButton>
					</div>
				</div>
			)}
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
		"body{margin:0 auto;max-width:64rem;padding:1rem 1.25rem;font:16px/1.6 system-ui,sans-serif;background:#faf9f6;color:#1c1c1c}",
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

/** One agent process no card owns; the inbox advisory shows what it is, and a human
 * decides whether to stop it. Ottr itself never kills these. */
export interface OrphanRow {
	pid: number;
	started: number;
	cmd: string;
	project: string | null;
	card: string | null;
	kind: string | null;
}

/** The orphan advisory: a definition line, then one row per process (at most five)
 * with the card link, the command summary, a copy action and a confirm-gated stop.
 * inboxKey tags every row, so a click anywhere in the advisory acknowledges it. */
export function OrphanNotice(props: {
	orphans: OrphanRow[];
	fresh: boolean;
	nowMs: number;
	openTask: (id: string) => void;
	inboxKey?: string;
}): ReactNode {
	const { orphans, fresh, nowMs, openTask, inboxKey } = props;
	// In-flight stop requests keyed by pid, so one slow request never disables the others.
	const [stopping, setStopping] = useState<ReadonlySet<number>>(
		() => new Set(),
	);
	// Pids whose clipboard write failed; the row then shows the command as text.
	const [copyFailed, setCopyFailed] = useState<ReadonlySet<number>>(
		() => new Set(),
	);

	const copyKill = async (o: OrphanRow): Promise<void> => {
		try {
			await navigator.clipboard.writeText(`kill ${o.pid}`);
			setCopyFailed((s) => {
				const next = new Set(s);
				next.delete(o.pid);
				return next;
			});
		} catch {
			setCopyFailed((s) => new Set(s).add(o.pid));
		}
	};

	const stop = async (o: OrphanRow): Promise<void> => {
		const cardName = o.card ?? "unknown card";
		if (
			!window.confirm(
				`Stop process ${o.pid}? Card: ${cardName}. Command: ${o.cmd}`,
			)
		)
			return;
		setStopping((s) => new Set(s).add(o.pid));
		try {
			await post("/api/orphans/stop", {
				pid: o.pid,
				started: o.started,
				cmd: o.cmd,
			});
		} catch (err) {
			window.alert(err instanceof Error ? err.message : String(err));
		} finally {
			setStopping((s) => {
				const next = new Set(s);
				next.delete(o.pid);
				return next;
			});
		}
	};

	return (
		<>
			<p className="notif-line" data-inbox-key={inboxKey}>
				<Icon name="info" size={16} />
				<span>
					An orphan is an agent run that no card owns any more. Check each
					process before you stop it. Ottr never kills a process on its own.
				</span>
				{fresh && <span className="new-tag">New</span>}
			</p>
			{orphans.slice(0, 5).map((o) => {
				// Narrowed locals: the closures below need non-null card, and property
				// narrowing does not survive into a callback.
				const card = o.card;
				return (
					<p
						className="notif-line"
						key={`orphan:${o.pid}`}
						data-inbox-key={inboxKey}
					>
						<Icon name="info" size={16} />
						<span>
							pid {o.pid}
							{o.started > 0 && <> · started {age(o.started, nowMs)}</>}
							{o.kind !== null && <> · {o.kind}</>}
							{o.project !== null && <> · {o.project}</>} ·{" "}
							{card !== null && (
								<button
									type="button"
									className="notif-link"
									title={`Open card ${card}`}
									onClick={() => openTask(card)}
								>
									{card}
								</button>
							)}
							<code title={o.cmd}>{o.cmd}</code>{" "}
							<button
								type="button"
								className="notif-link"
								onClick={() => void copyKill(o)}
							>
								Copy kill command
							</button>{" "}
							<button
								type="button"
								className="notif-link"
								disabled={stopping.has(o.pid)}
								onClick={() => void stop(o)}
							>
								Stop process
							</button>
							{copyFailed.has(o.pid) && (
								<>
									{" "}
									Copy failed. Run: <code>kill {o.pid}</code>
								</>
							)}
						</span>
					</p>
				);
			})}
			{orphans.length > 5 && (
				<p className="notif-line" data-inbox-key={inboxKey}>
					<Icon name="info" size={16} />
					<span>… {orphans.length - 5} more orphaned processes.</span>
				</p>
			)}
		</>
	);
}
/** One card link in the drawer's lineage rail: the one place a drawer renders a link
 * to another card (the parent above, the follow-ups below), so an href change lands
 * on every row at once. The href always uses the LINKED card's project and id, so a
 * cross-project link opens that project's URL; a plain click lets openTask select
 * that project first, then opens the card, and a middle or Ctrl/Cmd click opens a
 * new tab. */
function LineageCardLink({
	card,
	selfProject,
	tag,
	state,
	onOpenTask,
}: {
	card: TaskCard;
	selfProject: string;
	/** Row label after the title: "parent", or empty on a follow-up row. */
	tag: string;
	/** Live state of a follow-up row, rendered after the tags. */
	state?: ReactNode;
	onOpenTask: (id: string) => void;
}) {
	return (
		<a
			className="lineage-row"
			href={taskPath(card.project, card.id)}
			title={card.sessionTitle ?? card.title}
			onClick={(e) => navClick(e, () => onOpenTask(card.id))}
		>
			<span className="lineage-key">{card.id}</span>
			<span className="lineage-title">{card.sessionTitle ?? card.title}</span>
			<span className="lineage-end">
				{card.project !== selfProject && (
					<span className="lineage-tag">{card.project}</span>
				)}
				{tag !== "" && <span className="lineage-tag">{tag}</span>}
				{state}
			</span>
		</a>
	);
}

/** A proposal reason names its source card by id; the drawer renders that id as a card
 * link with the same click rules as LineageCardLink. Legacy wording names a title
 * instead of an id, and an id the board no longer lists renders as plain text — the
 * box never promises a link it cannot open. */
function ProposalReasonLink({
	reason,
	selfProject,
	tasks,
	onOpenTask,
}: {
	reason: string;
	selfProject: string;
	tasks: TaskCard[];
	onOpenTask: (id: string) => void;
}) {
	const m =
		/^(Retro proposal from |Fork proposal from )(\S+?)(?: \("|\. |$)/.exec(
			reason,
		);
	const lead = m?.[1];
	const hit = m?.[2];
	if (lead === undefined || hit === undefined) return <span>{reason}</span>;
	const id: string = hit;
	const linked =
		tasks.find((t) => t.id === id && t.project === selfProject) ??
		tasks.find((t) => t.id === id) ??
		null;
	const start = lead.length;
	const end = start + id.length;
	// One span, not a fragment: .needs-reason is a flex row and multiple children
	// would lay out as separate columns instead of flowing as one paragraph.
	return (
		<span>
			{reason.slice(0, start)}
			{linked === null ? (
				id
			) : (
				<a
					className="reason-card-link"
					href={taskPath(linked.project, linked.id)}
					title={linked.sessionTitle ?? linked.title}
					onClick={(e) => navClick(e, () => onOpenTask(linked.id))}
				>
					{id}
				</a>
			)}
			{reason.slice(end)}
		</span>
	);
}

/** Card ids inside a proposal's Why line render as card links, same-project first, else any
 * project; an id the board no longer lists stays plain text — mirror ProposalReasonLink. */
function CardIdLinks({
	text,
	selfProject,
	tasks,
	onOpenTask,
}: {
	text: string;
	selfProject: string;
	tasks: TaskCard[];
	onOpenTask: (id: string) => void;
}) {
	const parts: ReactNode[] = [];
	const re = /\b[A-Z]{1,4}-\d+\b/g;
	let last = 0;
	for (const m of text.matchAll(re)) {
		if (m.index > last) parts.push(text.slice(last, m.index));
		const id = m[0];
		const linked =
			tasks.find((t) => t.id === id && t.project === selfProject) ??
			tasks.find((t) => t.id === id) ??
			null;
		parts.push(
			linked === null ? (
				id
			) : (
				<a
					key={`${id}-${m.index}`}
					className="reason-card-link"
					href={taskPath(linked.project, linked.id)}
					title={linked.sessionTitle ?? linked.title}
					onClick={(e) => navClick(e, () => onOpenTask(linked.id))}
				>
					{id}
				</a>
			),
		);
		last = m.index + id.length;
	}
	parts.push(text.slice(last));
	return <>{parts}</>;
}

/** OTTR-795: a revision-guarded save was refused with 409 — the card changed while the
 *  editor held it. The notice names that, and shows the board's current version of the
 *  edited content beside the kept text (the editor still holds the user's draft), so the
 *  user can compare and re-apply. Polite region: the refusal lands after the user's own
 *  Save press, never while they type. Reuses the crit and hint text styles (WCAG AA). */
function EditConflictNotice(p: {
	heading: string;
	/** The board's current value of the edited content; null when there is none anymore. */
	current: string | null;
	/** Said instead of the current version when it is gone. */
	gone: string;
}) {
	return (
		<div className="edit-conflict" aria-live="polite">
			<p className="auth-error">
				<Mark kind="crit" />
				<span>{p.heading}</span>
			</p>
			{p.current === null ? (
				<p className="hint">{p.gone}</p>
			) : (
				<>
					<p className="conflict-label">Current version on the board</p>
					<div className="conflict-current">{p.current}</div>
				</>
			)}
		</div>
	);
}

/** The prompt editor form, shared by the panel on a proposal card and the Prompt section on
 * an ordinary unstarted card: same ids and handlers either way, and never both at once. */
function PromptEditForm({
	edit,
	onEdit,
	editValid,
	saveArmed,
	editSave,
	onSave,
	conflict,
}: {
	edit: string;
	onEdit: (value: string | null) => void;
	editValid: boolean;
	/** False until the editor's hold claim landed: the guarded save needs the armed
	 *  revision, and an unconditional save could silently overwrite another tab. */
	saveArmed: boolean;
	editSave: BusyState;
	onSave: () => void;
	/** Non-null after a refused save: the board's row, shown beside the kept text. */
	conflict: TaskView | null;
}) {
	return (
		<form
			className="reply-form"
			onSubmit={(e) => {
				e.preventDefault();
				onSave();
			}}
		>
			<label htmlFor="edit-text">Task</label>
			<textarea
				id="edit-text"
				rows={6}
				value={edit}
				onChange={(e) => onEdit(e.target.value)}
				placeholder="Task"
			/>
			{conflict !== null && (
				<EditConflictNotice
					heading="The card changed while you were editing. Your text is kept; edit and save again to re-apply it."
					current={conflict.prompt}
					gone="The board's version is empty now."
				/>
			)}
			<div className="reply-actions">
				<button type="button" onClick={() => onEdit(null)}>
					Cancel
				</button>
				<button
					type="submit"
					// One primary per surface: edit saves stay stock grey; the decision
					// (or nothing) owns the loud slot.
					className={editSave.failed ? "failed" : undefined}
					disabled={!editValid || !saveArmed || editSave.busy}
					title={saveArmed ? undefined : "Claiming the edit hold…"}
					aria-busy={editSave.busy || undefined}
				>
					{editSave.busy && <span className="spinner" aria-hidden="true" />}
					<Icon name="send" />
					Save
				</button>
			</div>
		</form>
	);
}

/** The decision panel of a proposal card: the reason line, the stored five-line summary
 * (or the prompt's first paragraph for older and fork proposals), the two decision
 * buttons and the collapsed full prompt. The decline lives in the drawer-actions row's
 * Cancel task. The panel replaces the needs-reason box and the
 * Prompt section, which stay hidden on proposal cards. */
function ProposalPanel({
	task,
	selfProject,
	tasks,
	onOpenTask,
	editOpen,
	editGuardTitle,
	edit,
	onAccept,
	onEdit,
	onEditChange,
	editValid,
	editSaveArmed,
	editSave,
	onSaveEdit,
	editConflict,
	onCancel,
}: {
	task: TaskView;
	selfProject: string;
	tasks: TaskCard[];
	onOpenTask: (id: string) => void;
	editOpen: boolean;
	editGuardTitle: string;
	edit: string | null;
	onAccept: () => Promise<boolean>;
	onEdit: () => void;
	onEditChange: (value: string | null) => void;
	editValid: boolean;
	editSaveArmed: boolean;
	editSave: BusyState;
	onSaveEdit: () => void;
	editConflict: TaskView | null;
	/** Declines the proposal (the drawer's Cancel task, with its confirm). */
	onCancel: () => Promise<boolean>;
}) {
	// Older proposals and partial fixtures carry no summary: undefined reads as the fallback.
	const s = task.proposalSummary ?? null;
	// A proposal is a suggestion, not a fault: a dim byline led by the lineage arrow,
	// never the amber needs-reason box.
	const reason = (
		<div className="decide-reason">
			<Icon name="corner-up-left" size={13} />
			<ProposalReasonLink
				reason={task.needsReason ?? ""}
				selfProject={selfProject}
				tasks={tasks}
				onOpenTask={onOpenTask}
			/>
		</div>
	);
	const facts =
		s !== null ? (
			<dl className="decide-facts">
				<div>
					<dt>What changes</dt>
					<dd>{s.whatChanges}</dd>
				</div>
				<div>
					<dt>Why</dt>
					<dd>
						<CardIdLinks
							text={s.why}
							selfProject={selfProject}
							tasks={tasks}
							onOpenTask={onOpenTask}
						/>
					</dd>
				</div>
				<div>
					<dt>Gain</dt>
					<dd>{s.gain}</dd>
				</div>
				<div>
					<dt>Risk</dt>
					<dd>{s.risk}</dd>
				</div>
				<div>
					<dt>Check</dt>
					<dd>{s.check}</dd>
				</div>
			</dl>
		) : (
			// First paragraph of the prompt, one line per row: the prompt's single-newline
			// sections (Why:, Change:, …) keep their run-in labels readable.
			<div className="decide-fallback">
				{(task.prompt.split(/\n{2}/)[0] ?? "").split("\n").map((line) => (
					<div key={line}>{line}</div>
				))}
			</div>
		);
	// The footer holds all three decisions: the decline (danger) apart at the left, the
	// constructive pair at the right, the same grammar as the drawer's action row.
	const actions = (
		<div className="decide-actions">
			<BusyButton className="danger" run={onCancel}>
				<Icon name="x" />
				Cancel task
			</BusyButton>
			<BusyButton
				className="primary"
				title={editOpen ? editGuardTitle : "Start the proposed task"}
				disabled={editOpen}
				run={onAccept}
			>
				Accept
			</BusyButton>
			<button
				type="button"
				title={editOpen ? editGuardTitle : "Edit the task text"}
				disabled={editOpen}
				onClick={onEdit}
			>
				Edit
			</button>
		</div>
	);
	const prompt =
		edit !== null ? (
			<PromptEditForm
				edit={edit}
				onEdit={onEditChange}
				editValid={editValid}
				saveArmed={editSaveArmed}
				editSave={editSave}
				onSave={onSaveEdit}
				conflict={editConflict}
			/>
		) : (
			<details className="decide-prompt">
				<summary>
					{SEC_CHEV}
					Full prompt
				</summary>
				<div className="prompt-text">
					<Markdown text={task.prompt} />
				</div>
			</details>
		);
	// One recessed card holds the whole decision: reason, summary and full prompt, then
	// a footer bar with Accept and Edit at the right, like a dialog's actions.
	return (
		<div className="decide-card">
			<div className="decide-body">
				{reason}
				{facts}
				{prompt}
			</div>
			{actions}
		</div>
	);
}

/** The drawer head's optimistic star: the icon flips before the POST lands, a failed
 * POST rolls it back (The Optimistic-Tap Rule). `disabled` while the save is in
 * flight keeps one request at a time. */
export function StarToggle({
	act,
	task,
}: {
	act: Act;
	task: Pick<TaskCard, "project" | "id" | "starred">;
}) {
	const star = useOptimisticValue(task.starred, act);
	const url = `/api/projects/${encodeURIComponent(task.project)}/tasks/${task.id}/star`;
	return (
		<button
			type="button"
			className="icon"
			aria-pressed={star.value}
			aria-label={star.value ? "Starred" : "Star"}
			title={
				star.value
					? "Removes this report from the Starred section"
					: "Pins this report in the Starred section of the done lane"
			}
			disabled={star.busy}
			aria-busy={star.busy || undefined}
			onClick={() => {
				star.set(!star.value);
				star.run(() => post(url, { starred: !star.value }));
			}}
		>
			<Icon name="star" />
		</button>
	);
}

/** Where the card ran, for the Meta row: the newest work turn that recorded it, else the newest
 * turn of any kind (a merge-only history), else null — the row shows "-". The string names the
 * worker or the board plus the docker container hostname the run executed in. */
export function ranOnLabel(turns: readonly TurnView[]): string | null {
	return (
		turns.findLast((t) => t.kind === "work" && t.ranOn !== null)?.ranOn ??
		turns.findLast((t) => t.ranOn !== null)?.ranOn ??
		null
	);
}

/** Drawer Head section: extracted verbatim from the drawer body. */
function DrawerHead(p: {
	task: TaskView;
	project: ProjectView;
	cancelled: boolean;
	askedNow: boolean;
	waiting: TaskCard[];
	tasks: TaskCard[];
	draining: boolean;
	act: Act;
	copiedId: ReturnType<typeof useFlash>[0];
	flashCopiedId: ReturnType<typeof useFlash>[1];
	idCopyError: string | null;
	setIdCopyError: (v: string | null) => void;
	setWfOpen: (v: boolean) => void;
}) {
	const {
		task,
		project,
		cancelled,
		askedNow,
		waiting,
		tasks,
		draining,
		act,
		copiedId,
		flashCopiedId,
		idCopyError,
		setIdCopyError,
		setWfOpen,
	} = p;
	return (
		<header className="drawer-top">
			<div className="drawer-head">
				<h2>{task.sessionTitle ?? task.title}</h2>
				<div className="drawer-head-actions">
					{task.stage === "done" && task.research && !cancelled && (
						// Optimistic tap: the star flips at once, the POST follows, a
						// failure rolls it back (The Optimistic-Tap Rule).
						<StarToggle act={act} task={task} />
					)}
					<button
						type="button"
						className="icon"
						aria-label="Workflow overview"
						title="Workflow overview"
						onClick={() => setWfOpen(true)}
					>
						<Icon name="route" />
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
				{/* PR mode: the pull request this card waits on, beside the stage in the
				    head line; the Meta block keeps the full row. */}
				{task.prNumber !== null && (
					<span>
						{task.prUrl !== null ? (
							<a
								className="pr-link"
								href={task.prUrl}
								target="_blank"
								rel="noopener noreferrer"
								title={`Open PR #${task.prNumber} on GitHub`}
								aria-label={`PR #${task.prNumber} on GitHub (opens a new tab)`}
							>
								PR #{task.prNumber}
							</a>
						) : (
							<span className="pr-link">PR #{task.prNumber}</span>
						)}
					</span>
				)}
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
				{/* The stage label already says done; the status word only earns its place when it adds state.
				    A proposal is a suggestion, not a fault: it reads "not started" in grey, like its card. */}
				{isProposalCard(task) ? (
					<span className="st">not started</span>
				) : (
					task.state !== "idle" && (
						<span
							className={`st st-${task.state}${askedNow ? " st-asked" : ""}`}
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
					)
				)}
			</p>
		</header>
	);
}

/** Drawer Mut section: extracted verbatim from the drawer body. */
function DrawerMut(p: { mut: ReturnType<typeof strykerProgress> | null }) {
	const { mut } = p;
	return (
		<>
			{" "}
			{mut !== null && (
				<DrawerSec id="drawer-mut" label="Mutation run">
					<div className="mut-run">
						<span className="mut-pct">{Math.round(mut.pct)}%</span>
						<span className="mut-bar" aria-hidden="true">
							<i
								style={{
									transform: `scaleX(${clamp(mut.pct, 0, 100) / 100})`,
								}}
							/>
						</span>
						<dl className="mut-figs">
							<div>
								<dt>Tested</dt>
								<dd>
									{fmtNum(mut.tested)} / {fmtNum(mut.total)}
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
					</div>
				</DrawerSec>
			)}
		</>
	);
}

/** Drawer Lineage section: extracted verbatim from the drawer body. */
function DrawerLineage(p: {
	row: TaskCard;
	parent: TaskCard | null;
	retroSource: { id: string; card: TaskCard | null } | null;
	kids: TaskCard[];
	proposals: Map<string, TaskCard[]>;
	branchRow: (k: TaskCard, tag: string) => ReactNode;
	onOpenTask: (id: string) => void;
}) {
	const { row, parent, retroSource, kids, proposals, branchRow, onOpenTask } =
		p;
	return (
		<>
			{" "}
			{/* Lineage rail: the parent above, this card as the filled node. Follow-ups run in
					    parallel, so they hang one level in off this card's node, each on its own elbow. */}
			{(row.followUpOf !== null || kids.length > 0) && (
				<DrawerSec id="drawer-lineage" label="Lineage" className="lineage">
					<ol className="lineage-rail">
						{retroSource !== null &&
							(retroSource.card === null ? (
								<li className="lineage-gone">
									<span
										className="lineage-row"
										title={`${retroSource.id} is not on the board`}
									>
										<span className="lineage-key">{retroSource.id}</span>
										<span className="lineage-title">Not on the board</span>
										<span className="lineage-tag">retro source</span>
									</span>
								</li>
							) : (
								<li>
									<LineageCardLink
										card={retroSource.card}
										selfProject={row.project}
										tag="retro source"
										onOpenTask={onOpenTask}
									/>
								</li>
							))}
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
									<LineageCardLink
										card={parent}
										selfProject={row.project}
										tag={retroSource !== null ? "retro" : "parent"}
										onOpenTask={onOpenTask}
									/>
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
									{kids.map((k) => {
										const props = proposals.get(k.id);
										return (
											<li
												key={k.id}
												className={
													props !== undefined && props.length > 0
														? "lineage-holds"
														: undefined
												}
											>
												{branchRow(k, k.kind === "retro" ? "retro" : "")}
												{props !== undefined && props.length > 0 && (
													<ol className="lineage-branch" aria-label="Proposals">
														{props.map((p) => (
															<li key={p.id}>{branchRow(p, "")}</li>
														))}
													</ol>
												)}
											</li>
										);
									})}
								</ol>
							)}
						</li>
					</ol>
				</DrawerSec>
			)}
			{/* A waiting release card reads its unreviewed commits before it approves,
					    so this section rides above the ask and the file lists. */}
		</>
	);
}

/** Drawer LateCommits section: extracted verbatim from the drawer body. */
function DrawerLateCommits(p: { task: TaskView; cancelled: boolean }) {
	const { task, cancelled } = p;
	return (
		<>
			{" "}
			{task.releaseVersion !== null &&
				task.state === "needs_you" &&
				!cancelled &&
				task.lateCommits !== undefined &&
				task.lateCommits.length > 0 && (
					<DrawerSec id="drawer-late" label="Commits since the review">
						<ul className="late-commits">
							{task.lateCommits.map((c) => (
								<li key={c.sha}>
									<code>{c.sha.slice(0, 7)}</code>
									<span className="late-subject">{c.subject}</span>
									<span className={c.reviewed ? "late-mark" : "late-mark warn"}>
										{!c.reviewed && <Mark kind="needs" />}
										{c.reviewed ? "review fix" : "not reviewed"}
									</span>
								</li>
							))}
						</ul>
					</DrawerSec>
				)}
		</>
	);
}

/** Drawer AskPanel section: extracted verbatim from the drawer body. */
function DrawerAskPanel(p: {
	task: TaskView;
	replySend: ReturnType<typeof useBusy>;
	sendReply: (text: string, draft?: boolean) => Promise<boolean>;
	diffFiles: NonNullable<TaskView["diffFiles"]>;
	setDiffView: React.Dispatch<
		React.SetStateAction<string[] | null | undefined>
	>;
}) {
	const { task, replySend, sendReply, diffFiles, setDiffView } = p;
	return (
		<>
			{" "}
			{/* The ask leads the body: an outstanding question is the card's one
					    action item, so it sits right below the lineage, before the file lists. */}
			{task.asked !== null && task.state === "needs_you" && (
				<AskPanel
					asked={task.asked}
					taskId={task.id}
					busy={replySend.busy}
					failed={replySend.failed}
					changed={diffFiles.map((f) => f.file)}
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
			{/* A parked prompt gate: the reason line sits above the one-tap escape hatch;
			    it answers through the same reply endpoint as the ask. */}
			{task.state === "needs_you" && task.gate?.parked === true && (
				<div className="gate-start">
					{task.needsReason !== null && (
						<div className="needs-reason">{task.needsReason}</div>
					)}
					<button
						type="button"
						className="ghost gate-start-btn"
						disabled={replySend.busy}
						onClick={() => {
							replySend.start(() => sendReply("Start anyway"));
						}}
						title='Replies "Start anyway" to the waiting session'
					>
						{replySend.busy && <span className="spinner" aria-hidden="true" />}
						Start anyway
					</button>
				</div>
			)}
		</>
	);
}

/** Drawer Waiting section: extracted verbatim from the drawer body. */
function DrawerWaiting(p: {
	waiting: TaskCard[];
	task: TaskView;
	askedNow: boolean;
	proposal: boolean;
	row: TaskCard;
	project: ProjectView;
	tasks: TaskCard[];
	onOpenTask: (id: string) => void;
	draining: boolean;
}) {
	const {
		waiting,
		project,
		tasks,
		onOpenTask,
		draining,
		task,
		askedNow,
		proposal,
		row,
	} = p;
	return (
		<>
			{" "}
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
					    it, and the ask panel above already carries the full questions. A parked
					    gate shows its reason inside the gate-start block above, not twice. */}
			{task.needsReason !== null &&
				!askedNow &&
				!proposal &&
				task.gate?.parked !== true && (
					<div className="needs-reason">
						<ProposalReasonLink
							reason={task.needsReason}
							selfProject={row.project}
							tasks={tasks}
							onOpenTask={onOpenTask}
						/>
					</div>
				)}
			{/* A parked merge hold approves by reply; the hold-actions bar at the end of the
					    body pins the message's actions while the report scrolls. The server still
					    gates the approval. */}
		</>
	);
}

/** Drawer Files section: extracted verbatim from the drawer body. */
function DrawerFiles(p: {
	wtLoading: boolean;
	diffLoading: boolean;
	task: TaskView;
	diffFiles: NonNullable<TaskView["diffFiles"]>;
	diffPlus: number;
	diffMinus: number;
	setDiffView: React.Dispatch<
		React.SetStateAction<string[] | null | undefined>
	>;
}) {
	const {
		wtLoading,
		diffLoading,
		task,
		diffFiles,
		diffPlus,
		diffMinus,
		setDiffView,
	} = p;
	return (
		<>
			{" "}
			{/* Loading placeholders in the loaded sections' slots, so the headers stay put. */}
			{wtLoading && (
				<DrawerSec id="drawer-wt" label="Worktree files">
					<DrawerLoading label="Loading the files" />
				</DrawerSec>
			)}
			{diffLoading && (
				<DrawerSec id="drawer-diff" label="Changed files">
					<DrawerLoading label="Loading the files" />
				</DrawerSec>
			)}
			{task.worktreeFiles != null && task.worktreeFiles.length > 0 && (
				<DrawerSec id="drawer-wt" label="Worktree files">
					<div className="wt-files">
						<p className="hint">
							{task.stage === "done"
								? task.savedFiles != null && task.savedFiles.length > 0
									? "Uncommitted files this task produced, captured when it finished. Kept copies are under Saved files."
									: "Uncommitted files this task produced, captured when it finished. The worktree is gone, so only the names remain."
								: "Uncommitted files this task produced. Open them before the worktree is removed."}
						</p>
						{task.worktreeFiles.slice(0, 50).map((f) =>
							task.stage === "done" ? (
								<code key={f} className="kept-path">
									{f}
								</code>
							) : (
								<a
									key={f}
									className="wt-file"
									href={`/api/projects/${encodeURIComponent(task.project)}/tasks/${task.id}/files?path=${encodeURIComponent(f)}`}
									target="_blank"
									rel="noreferrer"
								>
									{f}
								</a>
							),
						)}
						{task.worktreeFiles.length > 50 && (
							<p className="hint">…and {task.worktreeFiles.length - 50} more</p>
						)}
					</div>
				</DrawerSec>
			)}
			{task.savedFiles != null && task.savedFiles.length > 0 && (
				<DrawerSec id="drawer-saved" label="Saved files">
					<div className="wt-files">
						<p className="hint">
							Files this task left uncommitted, kept when its worktree was
							removed.
						</p>
						{task.savedFiles.slice(0, 50).map((f) => (
							<a
								key={f.name}
								className="wt-file"
								href={`/api/projects/${encodeURIComponent(task.project)}/tasks/${task.id}/saved-files?path=${encodeURIComponent(f.name)}`}
								target="_blank"
								rel="noreferrer"
							>
								{f.name}
								<span className="saved-size">{fmtBytes(f.size)}</span>
							</a>
						))}
						{task.savedFiles.length > 50 && (
							<p className="hint">…and {task.savedFiles.length - 50} more</p>
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
									{f.plus === null ? "binary" : `+${f.plus} −${f.minus ?? 0}`}
								</span>
							</div>
						))}
						{diffFiles.length > 50 && (
							<p className="hint">…and {diffFiles.length - 50} more</p>
						)}
					</div>
				</DrawerSec>
			)}
		</>
	);
}

/** Drawer Notes section: extracted verbatim from the drawer body. */
/** The release-notes edit form: shown instead of the section body while an edit is open. */
function ReleaseNotesEditor(p: {
	value: string;
	setValue: (v: string | null) => void;
	valid: boolean;
	save: ReturnType<typeof useBusy>;
	submit: (mode: "save" | "append") => void;
	/** Non-null after a refused save: the board's row, shown beside the kept text. */
	conflict: TaskView | null;
}) {
	return (
		<section className="dsec">
			{/* The editor replaces the section body; the form's label titles it. */}
			<form
				className="reply-form"
				onSubmit={(e) => {
					e.preventDefault();
					p.submit("save");
				}}
			>
				<label htmlFor="release-notes-text">Release notes</label>
				<textarea
					id="release-notes-text"
					rows={6}
					value={p.value}
					onChange={(e) => p.setValue(e.target.value)}
					placeholder="Replacement notes — or text appended below the current notes."
				/>
				{p.conflict !== null && (
					<EditConflictNotice
						heading="The card changed while you were editing. Your text is kept; edit and save again to re-apply it."
						current={p.conflict.releaseNotes || null}
						gone="The board's notes are empty now."
					/>
				)}
				<div className="reply-actions">
					<button
						type="button"
						onClick={() => p.setValue(null)}
						disabled={p.save.busy}
					>
						Cancel
					</button>
					<button
						type="button"
						className={p.save.failed ? "failed" : undefined}
						disabled={!p.valid || p.save.busy}
						aria-busy={p.save.busy || undefined}
						onClick={() => p.submit("append")}
					>
						{p.save.busy && <span className="spinner" aria-hidden="true" />}
						Add to notes
					</button>
					{/* One primary per surface: the notes Save stays stock grey. */}
					<button
						type="submit"
						className={p.save.failed ? "failed" : undefined}
						disabled={!p.valid || p.save.busy}
						aria-busy={p.save.busy || undefined}
					>
						{p.save.busy && <span className="spinner" aria-hidden="true" />}
						<Icon name="send" />
						Save
					</button>
				</div>
			</form>
		</section>
	);
}

function DrawerNotes(p: {
	task: TaskView;
	notesEdit: string | null;
	setNotesEdit: (v: string | null) => void;
	openNotes: () => void;
	notesValid: boolean;
	notesEditable: boolean;
	notesSubmit: (mode: "save" | "append") => void;
	notesSave: ReturnType<typeof useBusy>;
	notesConflict: TaskView | null;
}) {
	const {
		task,
		notesEdit,
		setNotesEdit,
		openNotes,
		notesValid,
		notesEditable,
		notesSubmit,
		notesSave,
		notesConflict,
	} = p;
	return (
		<>
			{" "}
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
									onClick={openNotes}
								>
									<Icon name="edit" />
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
					<ReleaseNotesEditor
						value={notesEdit}
						setValue={setNotesEdit}
						valid={notesValid}
						save={notesSave}
						submit={notesSubmit}
						conflict={notesConflict}
					/>
				))}
		</>
	);
}

/** Drawer Prompts section: extracted verbatim from the drawer body. */
function DrawerPrompts(p: {
	editable: boolean;
	proposal: boolean;
	task: TaskView;
	edit: string | null;
	setEdit: (v: string | null) => void;
	openEdit: () => void;
	editValid: boolean;
	editSaveArmed: boolean;
	editSave: ReturnType<typeof useBusy>;
	editSubmit: () => void;
	editConflict: TaskView | null;
	inputUrls: string[];
	imgUrl: (name: string) => string;
	setViewing: React.Dispatch<
		React.SetStateAction<{
			list: string[];
			index: number;
			names?: string[];
		} | null>
	>;
}) {
	const {
		editable,
		proposal,
		task,
		edit,
		setEdit,
		openEdit,
		editValid,
		editSaveArmed,
		editSave,
		editSubmit,
		editConflict,
		inputUrls,
		imgUrl,
		setViewing,
	} = p;
	return (
		<>
			{" "}
			{!editable && !proposal && (
				<DrawerSec id="drawer-prompt" label="Prompt">
					<div className="prompt-text">
						<Markdown text={task.prompt} />
					</div>
				</DrawerSec>
			)}
			{!proposal && editable && edit === null && (
				<DrawerSec id="drawer-prompt" label="Prompt">
					<div className="task-prompt">
						<Markdown text={task.prompt} />
						<button type="button" onClick={openEdit}>
							<Icon name="edit" />
							Edit task
						</button>
					</div>
				</DrawerSec>
			)}
			{!proposal && editable && edit !== null && (
				<PromptEditForm
					edit={edit}
					onEdit={setEdit}
					editValid={editValid}
					saveArmed={editSaveArmed}
					editSave={editSave}
					onSave={editSubmit}
					conflict={editConflict}
				/>
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
		</>
	);
}

/** Drawer Result section: extracted verbatim from the drawer body. */
function DrawerResult(p: {
	report: TaskView | TurnView;
	hideDetails: boolean;
	task: TaskView;
}) {
	const { report, hideDetails, task } = p;
	return (
		<>
			{" "}
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
		</>
	);
}

/** Drawer PrSec section: extracted verbatim from the drawer body. */
function DrawerPrSec(p: {
	task: TaskView;
	prDraft: string | null;
	act: Act;
	setDetail: React.Dispatch<React.SetStateAction<TaskView | null>>;
}) {
	const { task, prDraft, act, setDetail } = p;
	return (
		<>
			{" "}
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
		</>
	);
}

/** Drawer WorkCheck section: extracted verbatim from the drawer body. */
function DrawerWorkCheck(p: {
	task: TaskView;
	catalog: ReturnType<typeof useModels>;
}) {
	const { task, catalog } = p;
	return (
		<>
			{" "}
			{task.workCheckLog.length > 0 && (
				<DrawerSec id="drawer-wc" label="Work check" className="work-checks">
					<ul>
						{task.workCheckLog.map((run, i) => (
							<li key={i}>
								<p className="wc-run">
									{run.outcome === "pass"
										? "Passed"
										: run.outcome === "blockers"
											? "Blocked"
											: "Error"}
									{" · "}
									{run.role === "critic" || run.role === "adversary" ? (
										<>
											{run.role}
											{" · "}
										</>
									) : run.role === "default" && run.model !== null ? (
										<>
											default role
											{" · "}
										</>
									) : null}
									{run.model === null
										? "default model"
										: displayModel(catalog?.models ?? [], run.model)}
									{" · "}
									{stamp(run.at)} · {duration(run.durationMs)}
								</p>
								{run.warn !== undefined && (
									<p className="hint">
										<Mark kind="warn" /> {run.warn}
									</p>
								)}
								{run.error !== undefined && <p className="dim">{run.error}</p>}
								{run.blockers.length > 0 && (
									<ul>
										{run.blockers.map((b, j) => (
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
		</>
	);
}

/** Drawer MergeModal section: extracted verbatim from the drawer body. */
function DrawerMergeModal(p: {
	mergeOpen: boolean;
	setMergeOpen: (v: boolean) => void;
	mergeReason: string;
	setMergeReason: (v: string) => void;
	mergeError: string | null;
	mergeSave: ReturnType<typeof useBusy>;
	mergeAnyway: () => Promise<boolean>;
}) {
	const {
		mergeOpen,
		setMergeOpen,
		mergeReason,
		setMergeReason,
		mergeError,
		mergeSave,
		mergeAnyway,
	} = p;
	return (
		<>
			{" "}
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
							The work check found unresolved blockers. Say why the card merges
							anyway; the reason is kept with the check log.
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
									disabled={mergeReason.trim().length === 0 || mergeSave.busy}
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
		</>
	);
}

/** Drawer Shots section: extracted verbatim from the drawer body. */
function DrawerShots(p: {
	shotUrls: string[];
	task: TaskView;
	setViewing: React.Dispatch<
		React.SetStateAction<{
			list: string[];
			index: number;
			names?: string[];
		} | null>
	>;
	imgUrl: (name: string) => string;
}) {
	const { shotUrls, task, setViewing, imgUrl } = p;
	return (
		<>
			{" "}
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
		</>
	);
}

/** Drawer Research section: extracted verbatim from the drawer body. */
function DrawerResearch(p: {
	task: TaskView;
	mdRef: React.RefObject<HTMLDivElement | null>;
}) {
	const { task, mdRef } = p;
	return (
		<>
			{" "}
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
											[reportHtml(task.title, mdRef.current?.innerHTML ?? "")],
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
		</>
	);
}

/** Drawer Steps section: extracted verbatim from the drawer body. */
/** One Work-steps rail entry: a work check, a filed finding or a turn with its expandable log. */
type WorkStep = ReturnType<typeof workSteps>[number];

/** One work check run on the rail; not expandable, the Work check section holds the findings. */
function CheckStep(p: {
	s: Extract<WorkStep, { kind: "check" }>;
	catalog: ReturnType<typeof useModels>;
}) {
	const { run } = p.s;
	const nb = run.blockers.length;
	const nn = run.notes.length;
	return (
		<li key={`check-${p.s.n}`} className="turn turn-check">
			{run.outcome === "pass" ? (
				<span className="turn-node">
					<Icon name="check" size={11} />
				</span>
			) : (
				<span className="turn-node ask" aria-hidden="true" />
			)}
			<div className="turn-head">
				<strong>work check</strong>
				<span
					className={`outcome${run.outcome === "pass" ? "" : " o-needs_you"}`}
				>
					{run.outcome === "pass"
						? "passed"
						: run.outcome === "blockers"
							? "blocked"
							: "error"}
				</span>
				<span className="turn-model" title="model">
					{run.model === null
						? "default model"
						: displayModel(p.catalog?.models ?? [], run.model)}
				</span>
				<span className="turn-time">
					{new Date(run.at).toLocaleTimeString()}
				</span>
				<span className="turn-dur">{duration(run.durationMs)}</span>
			</div>
			{(run.error !== undefined || nb + nn > 0) && (
				<div className="dim turn-sum">
					{run.error ??
						`${nb} ${nb === 1 ? "blocker" : "blockers"} · ${nn} ${nn === 1 ? "note" : "notes"}`}
				</div>
			)}
			{run.warn !== undefined && (
				<div className="dim turn-sum">
					<Mark kind="warn" /> {run.warn}
				</div>
			)}
		</li>
	);
}

/** One filed finding on the rail; not expandable, the finding has no turns yet and its card holds the state. */
function FiledStep(p: { s: Extract<WorkStep, { kind: "filed" }> }) {
	const f = p.s.finding;
	return (
		<li key={`filed-${f.id}`} className="turn turn-check">
			<span className="turn-node" aria-hidden="true">
				<Mark kind="queued" />
			</span>
			<div className="turn-head">
				<strong>finding</strong>
				<span
					className={
						"outcome" +
						(f.cancelledAt !== null || f.state === "needs_you"
							? " o-needs_you"
							: "")
					}
				>
					{f.cancelledAt !== null ? "cancelled" : f.state}
				</span>
				<span className="turn-time">
					{new Date(f.createdAt).toLocaleTimeString()}
				</span>
			</div>
			<div className="dim turn-sum">{f.title}</div>
		</li>
	);
}

/** The rail node shape: check = ended, filled dot = live, triangle = needs you (steel when the turn asked a question). */
function TurnNode(p: { t: TurnView }) {
	return p.t.endedAt === null ? (
		<span className="turn-node live" aria-hidden="true" />
	) : p.t.outcome === "needs_you" ? (
		<span
			className={`turn-node ask${p.t.question !== null ? " asked" : ""}`}
			aria-hidden="true"
		/>
	) : (
		<span className="turn-node">
			<Icon name="check" size={11} />
		</span>
	);
}

/** The steer/reply bubble this turn delivered: it is what started the turn, and it is display-only. */
function YouBubble(p: { input: string; inputBy: TurnView["inputBy"] }) {
	return (
		<div className="you">
			<span className="you-head">
				{p.inputBy === "supervisor" ? "Supervisor" : "You"}
			</span>
			<div className="you-bubble">
				{/* "." is the resume marker (Resume button, restart, background-wait), never prose: show it as a badge. */}
				{p.input.trim() === "." ? (
					<span className="you-chip">Resume</span>
				) : (
					<div className="you-msg">
						<Markdown text={p.input} />
					</div>
				)}
			</div>
		</div>
	);
}

/** The turn row's head button: kind, outcome, model, start time and duration. */
function TurnHead(p: {
	t: TurnView;
	sub: string | null;
	kind: WorkStep["kind"];
	model: string | null;
	expanded: boolean;
}) {
	const t = p.t;
	return (
		<button type="button" className="turn-head" aria-expanded={p.expanded}>
			<Icon name="chevron-right" size={13} />
			<strong>
				{p.sub === null ? t.kind : p.kind === "finding" ? "finding" : "retro"}
			</strong>
			{t.outcome !== null && (
				<span
					className={
						"outcome o-" +
						t.outcome +
						(t.outcome === "needs_you" && t.question !== null ? " asked" : "")
					}
				>
					{t.outcome === "needs_you" && t.question !== null
						? "question"
						: t.outcome.replace("_", " ")}
				</span>
			)}
			{p.model !== null && (
				<span className="turn-model" title="model">
					{p.model}
				</span>
			)}
			<span className="turn-time">
				{new Date(t.startedAt).toLocaleTimeString()}
			</span>
			<span className="turn-dur">
				{t.endedAt === null ? (
					<LiveElapsed since={t.startedAt} />
				) : (
					turnDuration({ startedAt: t.startedAt, endedAt: t.endedAt })
				)}
			</span>
		</button>
	);
}

/** A retro or finding turn's id comes from another card: key its open state apart. */
function turnStepKey(s: WorkStep, t: TurnView): string | number {
	const sub =
		s.kind === "retro" ? s.retroId : s.kind === "finding" ? s.finding.id : null;
	return sub === null ? t.id : `${s.kind}-${sub}-${t.id}`;
}

/** The turn row's own-card links: open the retro or the finding card. */
function TurnLinks(p: {
	s: Extract<WorkStep, Record<"turn", unknown>>;
	idx: number;
	task: TaskView;
	lastRetro: WorkStep | undefined;
	lastFindingStep: Map<string, number>;
	onOpenTask: (id: string) => void;
}) {
	const { s, idx, task, lastRetro, lastFindingStep, onOpenTask } = p;
	return (
		<>
			{/* The retro card's own drawer keeps reply and cancel for a retro that waits. */}
			{s.kind === "retro" && s === lastRetro && (
				<a
					className="turn-link"
					href={taskPath(task.project, s.retroId)}
					// The link is its own target: the row's toggle must not fire.
					onKeyDown={(e) => e.stopPropagation()}
					onClick={(e) => {
						e.stopPropagation();
						navClick(e, () => onOpenTask(s.retroId));
					}}
				>
					Open retro
				</a>
			)}
			{s.kind === "finding" && lastFindingStep.get(s.finding.id) === idx && (
				<a
					className="turn-link"
					href={taskPath(task.project, s.finding.id)}
					// The link is its own target: the row's toggle must not fire.
					onKeyDown={(e) => e.stopPropagation()}
					onClick={(e) => {
						e.stopPropagation();
						navClick(e, () => onOpenTask(s.finding.id));
					}}
				>
					Open finding
				</a>
			)}
		</>
	);
}

/** The turn row's error and the retro's waiting reason, shown as needs-reason blocks. */
function TurnAlerts(p: {
	t: TurnView;
	retroWait: NonNullable<TaskView["retro"]> | null;
}) {
	return (
		<>
			{p.t.error !== null && (
				<div className={`needs-reason${p.t.question !== null ? " asked" : ""}`}>
					{p.t.question !== null && <Mark kind="asked" />}
					{p.t.error}
				</div>
			)}
			{p.retroWait !== null && (
				<div
					className={`needs-reason${p.retroWait.asked !== null ? " asked" : ""}`}
				>
					{p.retroWait.asked !== null && <Mark kind="asked" />}
					{p.retroWait.needsReason}
				</div>
			)}
		</>
	);
}

/** A running turn's model is only written to the DB when it ends; meanwhile show what it runs with. A retro or finding runs on its own card's model, which this drawer does not carry. */
function turnModel(
	s: Extract<WorkStep, Record<"turn", unknown>>,
	t: TurnView,
	task: TaskView,
	catalog: ReturnType<typeof useModels>,
): string | null {
	const sub =
		s.kind === "retro" ? s.retroId : s.kind === "finding" ? s.finding.id : null;
	return (
		t.model ??
		(t.endedAt === null && sub === null
			? (task.model ?? catalog?.defaultModel ?? null)
			: null)
	);
}

/** One turn (own, retro or finding) with its expandable log. */
function TurnStep(p: {
	s: Extract<WorkStep, Record<"turn", unknown>>;
	idx: number;
	task: TaskView;
	project: ProjectView;
	catalog: ReturnType<typeof useModels>;
	openTurn: number | string | null;
	setOpenTurn: React.Dispatch<React.SetStateAction<number | string | null>>;
	lastRetro: WorkStep | undefined;
	lastFindingStep: Map<string, number>;
	onOpenTask: (id: string) => void;
}) {
	const {
		s,
		idx,
		task,
		project,
		catalog,
		openTurn,
		setOpenTurn,
		lastRetro,
		lastFindingStep,
		onOpenTask,
	} = p;
	const t = s.turn;
	// The card that ran the turn: null for this card's own turns.
	const sub =
		s.kind === "retro" ? s.retroId : s.kind === "finding" ? s.finding.id : null;
	// A retro or finding turn's id comes from another card: key its open state apart.
	const stepKey = turnStepKey(s, t);
	const expanded = openTurn === stepKey;
	// The retro's waiting reason, unless its latest turn already shows it.
	const retroWait =
		s === lastRetro &&
		task.retro?.state === "needs_you" &&
		task.retro.needsReason !== null &&
		task.retro.needsReason !== t.error
			? task.retro
			: null;
	// A running turn's model is only written to the DB when it ends; meanwhile show what it runs with.
	// A retro or finding runs on its own card's model, which this drawer does not carry.
	const model = turnModel(s, t, task, catalog);
	return (
		<li
			key={stepKey}
			className="turn"
			// Keyboard support without a second tab stop: the turn-head button
			// is the only stop, and its Enter/Space keydown bubbles to the
			// handlers here (preventDefault stops the button's own click).
			onKeyDown={(e) => {
				if (e.key !== "Enter" && e.key !== " ") return;
				e.preventDefault();
				setOpenTurn(expanded ? null : stepKey);
			}}
			onClick={(e) => {
				// The log stays open while scrolling/selecting in it; selecting summary text must not toggle either.
				// The input bubble is display-only: clicking or selecting it never toggles the log.
				if (
					(e.target as Element).closest(".log, .you") ||
					!window.getSelection()?.isCollapsed
				)
					return;
				setOpenTurn(expanded ? null : stepKey);
			}}
		>
			<TurnNode t={t} />
			{t.input !== null && <YouBubble input={t.input} inputBy={t.inputBy} />}
			{/* The agent's part: the one hover-glow target. The steer/reply bubble
			    above stays outside it — display-only, like the click. */}
			<div className="turn-body">
				<TurnHead
					t={t}
					sub={sub}
					kind={s.kind}
					model={model}
					expanded={expanded}
				/>
				{s.kind === "finding" && (
					<div className="dim turn-sum">{s.finding.title}</div>
				)}
				{t.summary !== null && <div className="dim turn-sum">{t.summary}</div>}
				{/* The run fell back to another model than dispatched (provider error,
				omp's retry chain): name both, so a steered model pick that did not
				run is legible instead of silent. The card keeps the pick. */}
				{t.dispatchedModel !== null && t.model !== null && (
					<div
						className="dim turn-sum"
						title={`Dispatched ${t.dispatchedModel}, but the run served ${t.model}: the provider errored and omp's retry chain fell back. The card keeps ${t.dispatchedModel} for its next turn.`}
					>
						<Mark kind="warn" /> dispatched{" "}
						{displayModel(catalog?.models ?? [], t.dispatchedModel)}, ran{" "}
						{displayModel(catalog?.models ?? [], t.model)}
					</div>
				)}
				<TurnLinks
					s={s}
					idx={idx}
					task={task}
					lastRetro={lastRetro}
					lastFindingStep={lastFindingStep}
					onOpenTask={onOpenTask}
				/>
				<TurnAlerts t={t} retroWait={retroWait} />
				{expanded && (
					<LogView
						project={project}
						taskId={sub ?? task.id}
						startedAt={t.startedAt}
						logOffset={t.logOffset}
					/>
				)}
			</div>
		</li>
	);
}

/** One Work-steps rail entry: a work check, a filed finding or a turn with its expandable log. */
function DrawerStepItem(p: {
	s: WorkStep;
	idx: number;
	task: TaskView;
	project: ProjectView;
	catalog: ReturnType<typeof useModels>;
	openTurn: number | string | null;
	setOpenTurn: React.Dispatch<React.SetStateAction<number | string | null>>;
	lastRetro: WorkStep | undefined;
	lastFindingStep: Map<string, number>;
	onOpenTask: (id: string) => void;
}) {
	if (p.s.kind === "check") return <CheckStep s={p.s} catalog={p.catalog} />;
	if (p.s.kind === "filed") return <FiledStep s={p.s} />;
	return (
		<TurnStep
			s={p.s}
			idx={p.idx}
			task={p.task}
			project={p.project}
			catalog={p.catalog}
			openTurn={p.openTurn}
			setOpenTurn={p.setOpenTurn}
			lastRetro={p.lastRetro}
			lastFindingStep={p.lastFindingStep}
			onOpenTask={p.onOpenTask}
		/>
	);
}

/** The Work steps head's context meter: prompt tokens over the model's context window. */
function ContextMeter(p: { ctx: SessionContext; windowTok: number | null }) {
	const { ctx, windowTok } = p;
	return (
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
						(ctx.compactions > 0 ? `, compacted ${ctx.compactions}×` : "")
			}
		/>
	);
}

/** The queued steering edit form: replaces the bubble while an edit is open. */
function SteerEditForm(p: {
	steerEdit: string;
	setSteerEdit: (v: string | null) => void;
	steerEditSave: ReturnType<typeof useBusy>;
	saveSteerEdit: (text: string) => Promise<boolean>;
}) {
	return (
		<form
			className="reply-form"
			onSubmit={(e) => {
				e.preventDefault();
				if (p.steerEdit.trim().length === 0) return;
				p.steerEditSave.start(() => p.saveSteerEdit(p.steerEdit));
			}}
		>
			<label htmlFor="steer-edit-text">Steering</label>
			<textarea
				id="steer-edit-text"
				rows={4}
				value={p.steerEdit}
				onChange={(e) => p.setSteerEdit(e.target.value)}
			/>
			<div className="reply-actions">
				<button type="button" onClick={() => p.setSteerEdit(null)}>
					Cancel
				</button>
				{/* One primary per surface: the edit Save stays stock grey. */}
				<button
					type="submit"
					className={p.steerEditSave.failed ? "failed" : undefined}
					disabled={p.steerEdit.trim().length === 0 || p.steerEditSave.busy}
					aria-busy={p.steerEditSave.busy || undefined}
				>
					{p.steerEditSave.busy && (
						<span className="spinner" aria-hidden="true" />
					)}
					<Icon name="send" />
					Save
				</button>
			</div>
		</form>
	);
}

/** A queued steer in the timeline under the last turn: the next input the agent will get, with edit and cancel for the server's queued prompt. */
function QueuedSteer(p: {
	task: TaskView;
	localPending: { text: string; images: number } | null;
	steerEdit: string | null;
	setSteerEdit: (v: string | null) => void;
	openSteerEdit: (text: string) => void;
	steerEditSave: ReturnType<typeof useBusy>;
	saveSteerEdit: (text: string) => Promise<boolean>;
	cancelSteer: (expectedRevision: number) => Promise<boolean>;
	steerConflict: { current: string | null; cancel: boolean } | null;
}) {
	const {
		task,
		localPending,
		steerEdit,
		setSteerEdit,
		openSteerEdit,
		steerEditSave,
		saveSteerEdit,
		cancelSteer,
		steerConflict,
	} = p;
	const text =
		localPending !== null ? localPending.text : (task.pendingPrompt ?? "");
	return (
		<li className="turn">
			<span className="turn-node">
				<Mark kind="queued" />
			</span>
			<div className="you">
				<span className="you-head">
					Queued
					{/* Edit/Cancel act on the server's queued prompt: they
												    wait for the server frame, so they hide while the
												    optimistic bubble from this client's own send is
												    still unconfirmed. */}
					{localPending === null &&
						task.pendingPrompt !== null &&
						task.pendingPrompt.trim() !== "." && (
							<>
								<BusyButton
									className="ghost"
									ariaLabel="Edit the queued steering"
									run={() => {
										const pending = task.pendingPrompt;
										if (pending === null) return Promise.resolve(false);
										openSteerEdit(pending);
										return Promise.resolve(true);
									}}
								>
									Edit
								</BusyButton>
								<BusyButton
									className="ghost"
									ariaLabel="Cancel the queued steering"
									run={async () => {
										// OTTR-795: the discard carries the revision the user decided
										// on, captured before the confirm waits — a poll during the
										// dialog must not hand it a passing revision.
										const expectedRevision = task.revision;
										return (await confirmDialog(
											"Discard the queued steering?",
											{
												ok: "Discard",
												danger: true,
											},
										))
											? cancelSteer(expectedRevision)
											: true;
									}}
								>
									Cancel
								</BusyButton>
							</>
						)}
				</span>
				<div className="you-bubble">
					{/* "." is the resume marker (Resume button, restart, background-wait), never prose: show it as a badge. */}
					{steerEdit !== null && localPending === null ? (
						// A kept draft outranks the resume marker and the bubble: the
						// notice says the text is kept, so the editor must be reachable.
						<SteerEditForm
							steerEdit={steerEdit}
							setSteerEdit={setSteerEdit}
							steerEditSave={steerEditSave}
							saveSteerEdit={saveSteerEdit}
						/>
					) : text.trim() === "." ? (
						<span className="you-chip">Resume</span>
					) : (
						<div className="you-msg">
							<Markdown text={text} />
						</div>
					)}
					{(localPending !== null
						? localPending.images > 0
						: task.pendingImages.length > 0) && (
						<p className="you-msg dim">
							+
							{localPending !== null
								? localPending.images
								: task.pendingImages.length}{" "}
							image
							{(localPending !== null
								? localPending.images
								: task.pendingImages.length) === 1
								? ""
								: "s"}
						</p>
					)}
					{task.state === "queued" && (
						<p className="you-msg dim">Sends when an agent slot frees.</p>
					)}
					{steerConflict !== null && (
						<EditConflictNotice
							heading={
								steerConflict.cancel
									? "The card changed while you were confirming. Nothing was discarded; cancel again to discard the current steering."
									: "The card changed while you were editing. Your text is kept; edit and save again to re-apply it."
							}
							current={steerConflict.current}
							gone="Nothing is queued on the board now."
						/>
					)}
				</div>
			</div>
		</li>
	);
}

function DrawerSteps(p: {
	ctx: SessionContext | null;
	windowTok: number | null;
	detail: TaskView | null;
	steps: ReturnType<typeof workSteps>;
	catalog: ReturnType<typeof useModels>;
	openTurn: number | string | null;
	setOpenTurn: React.Dispatch<React.SetStateAction<number | string | null>>;
	lastRetro: ReturnType<typeof workSteps>[number] | undefined;
	lastFindingStep: Map<string, number>;
	project: ProjectView;
	task: TaskView;
	localPending: { text: string; images: number } | null;
	steerEdit: string | null;
	setSteerEdit: (v: string | null) => void;
	openSteerEdit: (text: string) => void;
	steerEditSave: ReturnType<typeof useBusy>;
	saveSteerEdit: (text: string) => Promise<boolean>;
	cancelSteer: (expectedRevision: number) => Promise<boolean>;
	steerConflict: { current: string | null; cancel: boolean } | null;
	onOpenTask: (id: string) => void;
}) {
	const {
		ctx,
		windowTok,
		detail,
		steps,
		catalog,
		openTurn,
		setOpenTurn,
		lastRetro,
		lastFindingStep,
		project,
		task,
		localPending,
		steerEdit,
		setSteerEdit,
		openSteerEdit,
		steerEditSave,
		saveSteerEdit,
		cancelSteer,
		steerConflict,
		onOpenTask,
	} = p;
	return (
		<>
			{" "}
			<DrawerSec
				id="drawer-steps"
				label="Work steps"
				// A live ticket shows its rail; only a done card starts it collapsed.
				defaultOpen={task.stage !== "done"}
				head={
					ctx === null ? undefined : (
						<ContextMeter ctx={ctx} windowTok={windowTok} />
					)
				}
			>
				{detail === null ? (
					<DrawerLoading label="Loading the steps" />
				) : (
					steps.length === 0 && <p className="dim">No turns yet.</p>
				)}
				<ul className="turns">
					{steps.map((s, idx) => (
						<DrawerStepItem
							key={
								s.kind === "check"
									? `check-${s.n}`
									: s.kind === "filed"
										? `filed-${s.finding.id}`
										: s.turn.id
							}
							s={s}
							idx={idx}
							task={task}
							project={project}
							catalog={catalog}
							openTurn={openTurn}
							setOpenTurn={setOpenTurn}
							lastRetro={lastRetro}
							lastFindingStep={lastFindingStep}
							onOpenTask={onOpenTask}
						/>
					))}
					{(steerConflict !== null ||
						((localPending !== null || task.pendingPrompt !== null) &&
							(task.state === "running" || task.state === "queued"))) && (
						<QueuedSteer
							task={task}
							localPending={localPending}
							steerEdit={steerEdit}
							setSteerEdit={setSteerEdit}
							openSteerEdit={openSteerEdit}
							steerEditSave={steerEditSave}
							saveSteerEdit={saveSteerEdit}
							cancelSteer={cancelSteer}
							steerConflict={steerConflict}
						/>
					)}
				</ul>
			</DrawerSec>
		</>
	);
}

/** Drawer Triage section: extracted verbatim from the drawer body. */
function DrawerTriage(p: {
	task: TaskView;
	cancelled: boolean;
	rank: ReturnType<typeof useOptimisticValue<string>>;
	setRank: (p: string) => void;
	triageSave: ReturnType<typeof useBusy>;
	triageReason: string;
	setTriageReason: (v: string) => void;
	nominateCandidate: () => void;
	clearCandidate: () => void;
	triageError: string | null;
}) {
	const {
		task,
		cancelled,
		rank,
		setRank,
		triageSave,
		triageReason,
		setTriageReason,
		nominateCandidate,
		clearCandidate,
		triageError,
	} = p;
	return (
		<>
			{" "}
			{/* Collapsible Triage between the turn tree and the Steer composer,
					    collapsed by default: rank and close-candidate nomination are triage
					    controls, not the card's story. Done tasks hide it entirely: the
					    controls have no effect there. A cancelled card hides it too: its
					    drawer is read-only. */}
			{task.stage !== "done" && !cancelled && (
				<DrawerSec id="drawer-triage" label="Triage" defaultOpen={false}>
					<div className="triage-row">
						{/* The rank picker: five fixed options show all at once as a
								    segmented control, never a select (DESIGN.md, Choice controls).
								    The optimistic wiring is unchanged: rank.set shows the pick at
								    once, rank.run posts it, a failure rolls the press back. */}
						<fieldset className="triage-rank">
							{/* fieldset names the group for assistive tech (the visible
									    caption stays the span); biome's useSemanticElements
									    requires the real element over role="group". */}
							<legend className="sr">Triage rank</legend>
							<span>Rank</span>
							<div className="rank-seg">
								{["", ...PRIORITIES].map((p) => (
									<button
										key={p}
										type="button"
										aria-pressed={rank.value === p}
										disabled={triageSave.busy || rank.busy}
										onClick={() => setRank(p)}
									>
										{p === "" ? "Default" : p}
									</button>
								))}
							</div>
						</fieldset>
						{task.closeCandidate === null ? (
							<form
								className="triage-nominate"
								onSubmit={(e) => {
									e.preventDefault();
									if (triageReason.trim() !== "") nominateCandidate();
								}}
							>
								<label>
									<span>Close reason</span>
									<input
										value={triageReason}
										maxLength={200}
										required
										placeholder="Duplicate of OTTR-640"
										disabled={triageSave.busy}
										onChange={(e) => setTriageReason(e.target.value)}
									/>
								</label>
								<button
									type="submit"
									disabled={triageSave.busy || triageReason.trim() === ""}
									aria-busy={triageSave.busy || undefined}
								>
									{triageSave.busy && (
										<span className="spinner" aria-hidden="true" />
									)}
									Suggest closing
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
									Clear reason
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
		</>
	);
}

/** Drawer HoldBar section: extracted verbatim from the drawer body. */
function DrawerHoldBar(p: {
	task: TaskView;
	askedNow: boolean;
	diffFiles: NonNullable<TaskView["diffFiles"]>;
	sendReply: (text: string, draft?: boolean) => Promise<boolean>;
}) {
	const { task, askedNow, diffFiles, sendReply } = p;
	return (
		<>
			{" "}
			{/* A parked merge hold (update, fork, mismatch) approves by reply; the fixed bar
					    carries the hold message's actions and pins to the drawer's bottom edge while
					    the report scrolls. The server still gates the approval. */}
			{task.state === "needs_you" && task.holdHead !== null && !askedNow && (
				<div className="hold-actions">
					{/* The summary is the ready report an update card parks on; it always
								    exists, so the button rides the bar's first paint. Before the fetch
								    lands it scrolls to the drawer top, where the report sits. */}
					{task.needsReason === UPDATE_HOLD_REASON && (
						<button
							type="button"
							title="Scrolls up to the report summary"
							onClick={() => {
								const target = document.getElementById("drawer-result");
								if (target !== null) target.scrollIntoView({ block: "start" });
								else
									document.querySelector("dialog.drawer")?.scrollTo({ top: 0 });
							}}
						>
							Read the summary
						</button>
					)}
					{/* The mismatch park serves its stat only through the drawer fetch, so
								    the button and the Changed files section appear together. */}
					{task.needsReason === MERGE_HOLD_MISMATCH_REASON &&
						diffFiles.length > 0 && (
							<button
								type="button"
								title="Scrolls to the changed files the merge added beyond the approval"
								onClick={() =>
									document
										.getElementById("drawer-diff")
										?.scrollIntoView({ block: "start" })
								}
							>
								Read the diff
							</button>
						)}
					<BusyButton
						className="primary"
						title="Sends the approving reply, so the parked merge can land"
						run={() => sendReply(APPROVE_REPLY)}
					>
						<Icon name="check" />
						Approve merge
					</BusyButton>
				</div>
			)}
		</>
	);
}

/** The follow-up call to action: one full-width row that reads as the next step (send
 *  icon and title in steel, the handoff hint under it, a chevron), plus a research
 *  report's Implement steps and No further steps under it. No filled button: the row
 *  never competes with a decision section's primary. */
function FollowUpCta(p: {
	task: TaskView;
	setFollowOpen: (v: boolean) => void;
	setStepsOpen: (v: boolean) => void;
	onMarkSeen: () => void;
}) {
	const { task, setFollowOpen, setStepsOpen, onMarkSeen } = p;
	return (
		<div className="followup-cta">
			<button
				type="button"
				className="followup-row"
				onClick={() => setFollowOpen(true)}
			>
				<Icon name="send" />
				<span>
					<b>Follow up</b>
					<small>
						Creates a new task that continues this one with a full handoff.
					</small>
				</span>
				<Icon name="chevron-right" size={14} />
			</button>
			{task.research && researchSteps(task) === "yes" && (
				<div className="followup-extra">
					<button
						type="button"
						title="Picks a model, then creates a follow-up task that implements the report's recommended steps"
						onClick={() => setStepsOpen(true)}
					>
						<Icon name="play" />
						Implement steps
					</button>
					<BusyButton
						title="Marks the report read and clears it from the Inbox"
						run={async () => {
							onMarkSeen();
							return true;
						}}
					>
						<Icon name="eye-off" />
						No further steps
					</BusyButton>
				</div>
			)}
		</div>
	);
}

/** The needs_you reply composer; a PR review posts and asks for drafts in its own section, not here. */
function ReplyComposer(p: {
	task: TaskView;
	proposal: boolean;
	cancelled: boolean;
	editOpen: boolean;
	editGuardTitle: string;
	replySend: ReturnType<typeof useBusy>;
	sendReply: (text: string, draft?: boolean) => Promise<boolean>;
	reply: string;
	setReply: (v: string) => void;
	replyImages: ReturnType<typeof useAttachedImages>;
	catalog: ReturnType<typeof useModels>;
	model: ReturnType<typeof useOptimisticValue<string>>;
	modelQuery: string;
	setModelQuery: (v: string) => void;
	switchModel: (m: string) => void;
	onModelMenuOpen: () => void;
	modelConflict: { current: string | null } | null;
	decisionPrimary: boolean;
	act: Act;
	setViewing: React.Dispatch<
		React.SetStateAction<{
			list: string[];
			index: number;
			names?: string[];
		} | null>
	>;
}) {
	const {
		task,
		proposal,
		cancelled,
		editOpen,
		editGuardTitle,
		replySend,
		sendReply,
		reply,
		setReply,
		replyImages,
		catalog,
		model,
		modelQuery,
		setModelQuery,
		switchModel,
		onModelMenuOpen,
		modelConflict,
		decisionPrimary,
		act,
		setViewing,
	} = p;
	// The docked band folds under a Reply head at every width. Phones start folded to one
	// reply field, so the report keeps the screen; desktop starts open.
	const [replyOpen, setReplyOpen] = useState(
		() =>
			typeof window !== "undefined" &&
			!window.matchMedia("(max-width: 720px)").matches,
	);
	const formRef = useRef<HTMLFormElement | null>(null);
	const openReply = (): void => {
		setReplyOpen(true);
		requestAnimationFrame(() =>
			formRef.current?.querySelector("textarea")?.focus(),
		);
	};
	// A sent reply folds the band again; a failed send keeps it open with the text.
	const send = (): void =>
		replySend.start(async () => {
			const ok = await sendReply(reply, true);
			if (ok) setReplyOpen(false);
			return ok;
		});
	return (
		<form
			id="drawer-reply"
			ref={formRef}
			className="reply-form reply-fold"
			data-open={replyOpen || undefined}
			onSubmit={(e) => {
				e.preventDefault();
				send();
			}}
		>
			<button
				type="button"
				className="reply-peek"
				aria-label="Write a reply"
				onClick={openReply}
			>
				<span>{reply.trim() !== "" ? reply : "Reply to the agent…"}</span>
				<Icon name="send" size={15} />
			</button>
			<button
				type="button"
				className="reply-head"
				aria-expanded={replyOpen}
				onClick={() => {
					setReplyOpen(false);
					// Focus lands on the field that reopens it, not on the page body.
					requestAnimationFrame(() =>
						formRef.current?.querySelector<HTMLElement>(".reply-peek")?.focus(),
					);
				}}
			>
				{SEC_CHEV}
				Reply
			</button>
			<PromptInput
				label="Reply"
				value={reply}
				placeholder="Yes, but keep the old route"
				onChange={setReply}
				onEnter={send}
				images={replyImages}
				onView={(i) => {
					const list = replyImages.images.map((im) => im.url);
					if (list[i] !== undefined) setViewing({ list, index: i });
				}}
			/>
			<ComposerActions
				onAddImages={replyImages.addFiles}
				catalog={catalog}
				model={model.value}
				setModel={switchModel}
				modelQuery={modelQuery}
				setModelQuery={setModelQuery}
				onModelMenuOpen={onModelMenuOpen}
				modelConflict={modelConflict}
				secondary={
					<>
						{!proposal && (
							<BusyButton
								title="Start a fresh omp session in the same worktree; the broken one is abandoned (its files stay in .tasks/sessions)"
								run={async () =>
									(await confirmDialog(
										`Start a fresh omp session for ${task.id} "${task.title}"? The broken session is abandoned (its transcript stays in .tasks/sessions).`,
										{ ok: "Start fresh session" },
									))
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
						{/* The Decide section owns Accept while its panel shows (proposal,
										    needs_you, not cancelled); the composer keeps the button only
										    when the panel is hidden, so a proposal never offers Accept
										    twice. */}
						{(!proposal || cancelled) && (
							<BusyButton
								title={
									editOpen
										? editGuardTitle
										: proposal
											? "Start the proposed task"
											: "Continue the interrupted session (sends '.')"
								}
								disabled={editOpen}
								run={() => sendReply(".")}
							>
								<Icon name="play" />
								{proposal ? "Accept" : "Resume"}
							</BusyButton>
						)}
					</>
				}
				primary={
					<button
						type="submit"
						// One primary per surface: while a decision section owns
						// the loud slot (hold, proposal, ask, kept files), the
						// composer's Reply renders stock grey.
						className={
							decisionPrimary
								? replySend.failed
									? "failed"
									: undefined
								: `primary${replySend.failed ? " failed" : ""}`
						}
						disabled={replySend.busy}
						aria-busy={replySend.busy || undefined}
					>
						{replySend.busy && <span className="spinner" aria-hidden="true" />}
						<Icon name="send" />
						Reply
					</button>
				}
			/>
			<p className="hint">
				Enter sends. Shift+Enter starts a new line. Images: paste, drop or
				browse. A model pick lands with the reply turn.
			</p>
		</form>
	);
}

/** The running/queued steer composer. */
function SteerComposer(p: {
	task: TaskView;
	steerSend: ReturnType<typeof useBusy>;
	sendSteer: (text: string) => Promise<boolean>;
	steer: string;
	setSteer: (v: string) => void;
	steerImages: ReturnType<typeof useAttachedImages>;
	catalog: ReturnType<typeof useModels>;
	model: ReturnType<typeof useOptimisticValue<string>>;
	modelQuery: string;
	setModelQuery: (v: string) => void;
	switchModel: (m: string) => void;
	onModelMenuOpen: () => void;
	modelConflict: { current: string | null } | null;
	act: Act;
	setViewing: React.Dispatch<
		React.SetStateAction<{
			list: string[];
			index: number;
			names?: string[];
		} | null>
	>;
}) {
	const {
		task,
		steerSend,
		sendSteer,
		steer,
		setSteer,
		steerImages,
		catalog,
		model,
		modelQuery,
		setModelQuery,
		switchModel,
		onModelMenuOpen,
		modelConflict,
		act,
		setViewing,
	} = p;
	return (
		<form
			className="reply-form steer-form prompt-card"
			onSubmit={(e) => {
				e.preventDefault();
				steerSend.start(() => sendSteer(steer));
			}}
		>
			<PromptInput
				label="Steer"
				value={steer}
				placeholder="Also update the changelog"
				onChange={setSteer}
				onEnter={() => steerSend.start(() => sendSteer(steer))}
				images={steerImages}
				onView={(i) => {
					const list = steerImages.images.map((im) => im.url);
					if (list[i] !== undefined) setViewing({ list, index: i });
				}}
			/>
			<ComposerActions
				attachIcon="plus"
				onAddImages={steerImages.addFiles}
				catalog={catalog}
				model={model.value}
				setModel={switchModel}
				modelQuery={modelQuery}
				setModelQuery={setModelQuery}
				onModelMenuOpen={onModelMenuOpen}
				modelConflict={modelConflict}
				secondary={
					task.state === "running" && (
						<BusyButton
							title="Interrupt this turn like Esc: the worktree, branch and session stay; the card waits for your reply"
							run={async () =>
								(await confirmDialog(
									`Stop the running turn of ${task.id} "${task.title}"? The card waits for your reply.`,
									{ ok: "Stop turn" },
								)) &&
								(await confirmDialog(
									`Really stop the running turn of ${task.id} "${task.title}"?`,
									{ ok: "Stop turn", danger: true },
								))
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
					)
				}
				primary={
					<button
						type="submit"
						className={`primary${steerSend.failed ? " failed" : ""}`}
						// Nothing to send while the field and the images are empty.
						disabled={
							steerSend.busy ||
							(steer.trim() === "" && steerImages.images.length === 0)
						}
						aria-busy={steerSend.busy || undefined}
						title="Steer (Enter)"
					>
						{steerSend.busy ? (
							<span className="spinner" aria-hidden="true" />
						) : (
							<Icon name="helm" />
						)}
						Steer
					</button>
				}
			/>
			<p className="hint">
				Enter steers. Shift+Enter starts a new line. Images: paste, drop or
				browse. A model pick lands with the next turn.
			</p>
		</form>
	);
}

function DrawerComposer(p: {
	followUp: boolean;
	prReviewOpen: boolean;
	task: TaskView;
	setFollowOpen: (v: boolean) => void;
	setStepsOpen: (v: boolean) => void;
	onMarkSeen: () => void;
	replySend: ReturnType<typeof useBusy>;
	sendReply: (text: string, draft?: boolean) => Promise<boolean>;
	reply: string;
	setReply: (v: string) => void;
	replyImages: ReturnType<typeof useAttachedImages>;
	catalog: ReturnType<typeof useModels>;
	modelQuery: string;
	setModelQuery: (v: string) => void;
	switchModel: (m: string) => void;
	onModelMenuOpen: () => void;
	modelConflict: { current: string | null } | null;
	decisionPrimary: boolean;
	proposal: boolean;
	cancelled: boolean;
	editOpen: boolean;
	editGuardTitle: string;
	steerSend: ReturnType<typeof useBusy>;
	sendSteer: (text: string) => Promise<boolean>;
	steer: string;
	setSteer: (v: string) => void;
	steerImages: ReturnType<typeof useAttachedImages>;
	act: Act;
	model: ReturnType<typeof useOptimisticValue<string>>;
	setViewing: React.Dispatch<
		React.SetStateAction<{
			list: string[];
			index: number;
			names?: string[];
		} | null>
	>;
}) {
	const {
		followUp,
		prReviewOpen,
		task,
		setFollowOpen,
		setStepsOpen,
		onMarkSeen,
		replySend,
		sendReply,
		reply,
		setReply,
		replyImages,
		catalog,
		model,
		modelQuery,
		setModelQuery,
		switchModel,
		onModelMenuOpen,
		modelConflict,
		setViewing,
		decisionPrimary,
		proposal,
		cancelled,
		editOpen,
		editGuardTitle,
		steerSend,
		sendSteer,
		steer,
		setSteer,
		steerImages,
		act,
	} = p;
	return (
		<>
			{" "}
			{followUp ? (
				<FollowUpCta
					task={task}
					setFollowOpen={setFollowOpen}
					setStepsOpen={setStepsOpen}
					onMarkSeen={onMarkSeen}
				/>
			) : (
				task.state === "needs_you" &&
				!prReviewOpen && (
					<ReplyComposer
						task={task}
						proposal={proposal}
						cancelled={cancelled}
						editOpen={editOpen}
						editGuardTitle={editGuardTitle}
						replySend={replySend}
						sendReply={sendReply}
						reply={reply}
						setReply={setReply}
						replyImages={replyImages}
						catalog={catalog}
						model={model}
						modelQuery={modelQuery}
						setModelQuery={setModelQuery}
						switchModel={switchModel}
						onModelMenuOpen={onModelMenuOpen}
						modelConflict={modelConflict}
						decisionPrimary={decisionPrimary}
						act={act}
						setViewing={setViewing}
					/>
				)
			)}
			{(task.state === "running" || task.state === "queued") && (
				<SteerComposer
					task={task}
					steerSend={steerSend}
					sendSteer={sendSteer}
					steer={steer}
					setSteer={setSteer}
					steerImages={steerImages}
					catalog={catalog}
					model={model}
					modelQuery={modelQuery}
					setModelQuery={setModelQuery}
					switchModel={switchModel}
					onModelMenuOpen={onModelMenuOpen}
					modelConflict={modelConflict}
					act={act}
					setViewing={setViewing}
				/>
			)}
		</>
	);
}

/** Drawer Actions section: extracted verbatim from the drawer body. */
function DrawerActions(p: {
	task: TaskView;
	cancelled: boolean;
	editOpen: boolean;
	editGuardTitle: string;
	setPick: (v: "grill" | "todo" | null) => void;
	act: Act;
	read: boolean;
	onMarkUnread: () => void;
	wcMergeable: boolean;
	setMergeReason: (v: string) => void;
	setMergeError: (v: string | null) => void;
	setMergeOpen: (v: boolean) => void;
	rerunUrl: string | null;
	rerunFailedJobs: () => Promise<boolean>;
	rerunError: string | null;
	/** OTTR-781: true on a cancelled Dependabot card; shows the Refile action. */
	refileAvailable: boolean;
	runRefile: () => Promise<boolean>;
	refileError: string | null;
	rerunDone: boolean;
	runCancel: () => Promise<boolean>;
	/** A proposal's decision card carries Cancel task in its footer; the row drops it. */
	cancelInPanel: boolean;
}) {
	const {
		task,
		cancelled,
		editOpen,
		editGuardTitle,
		setPick,
		act,
		read,
		onMarkUnread,
		wcMergeable,
		setMergeReason,
		setMergeError,
		setMergeOpen,
		rerunUrl,
		rerunFailedJobs,
		rerunError,
		refileAvailable,
		runRefile,
		refileError,
		rerunDone,
		runCancel,
		cancelInPanel,
	} = p;
	return (
		<>
			{" "}
			{/* The actions row (Cancel task and stage-specific actions) sits between the steer form and meta. */}
			<div className="drawer-actions">
				{task.stage === "backlog" && task.state === "idle" && !cancelled && (
					<>
						<button
							type="button"
							className="primary"
							title={
								editOpen
									? editGuardTitle
									: "Asks rounds of questions to refine the idea before it runs"
							}
							disabled={editOpen}
							onClick={() => setPick("grill")}
						>
							<Icon name="send" />
							Plan with agent
						</button>
						<button
							type="button"
							title={
								editOpen
									? editGuardTitle
									: "Puts the card in the todo lane so the agent can start it"
							}
							disabled={editOpen}
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
				{/* Merge anyway overrides the open work-check blockers through the
						    reason modal. It used to sit in the reply/steer composer bars; it
						    moved here so no danger button shares a row with the primary
						    action. The state guard keeps the old bars' exact reachability. */}
				{wcMergeable &&
					(task.state === "needs_you" || task.state === "queued") && (
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
				{/* OTTR-604: cards whose text links a GitHub Actions run offer a
						    re-run of that run's failed jobs; errors surface inline. */}
				{rerunUrl !== null && !cancelled && (
					<BusyButton run={rerunFailedJobs}>Re-run failed jobs</BusyButton>
				)}
				{/* A cancelled card is final: its drawer is read-only, so the delete
						    action goes too (an uncancel does not exist). */}
				{!cancelled && !cancelInPanel && (
					<BusyButton className="danger" run={runCancel}>
						<Icon name={task.stage === "done" ? "trash" : "x"} />
						{task.stage === "done" ? "Delete task" : "Cancel task"}
					</BusyButton>
				)}
				{/* OTTR-781: a cancelled Dependabot card blocks its PR; Refile files a
						    fresh card for the same PR so the ship step can adopt it. */}
				{refileAvailable && (
					<BusyButton
						title="Files a fresh card for this Dependabot PR with the same prompt and source-PR fields; a card that still covers the PR blocks the refile"
						run={runRefile}
					>
						<Icon name="refresh-cw" />
						Refile
					</BusyButton>
				)}
			</div>
			{/* OTTR-604: the re-run error and confirmation render as full-width
					    lines below the actions row, not as flex items inside it, so they
					    align with the drawer's content margin and keep their spacing. */}
			{refileError !== null && (
				<p className="auth-error" role="alert">
					{refileError}
				</p>
			)}
			{rerunUrl !== null && !cancelled && rerunError !== null && (
				<p className="auth-error" role="alert">
					{rerunError}
				</p>
			)}
			{rerunUrl !== null && !cancelled && rerunDone && rerunError === null && (
				<p className="hint" role="status">
					Re-run requested.
				</p>
			)}
		</>
	);
}

/** Drawer Meta section: extracted verbatim from the drawer body. */
function DrawerMeta(p: {
	task: TaskView;
	cancelled: boolean;
	act: Act;
	project: ProjectView;
	delta: number | undefined;
	resumeCmd: string | null;
	setCmdCopyError: (v: string | null) => void;
	flashCopied: ReturnType<typeof useFlash>[1];
	copied: ReturnType<typeof useFlash>[0];
	cmdCopyError: string | null;
}) {
	const {
		task,
		cancelled,
		act,
		project,
		delta,
		resumeCmd,
		setCmdCopyError,
		flashCopied,
		copied,
		cmdCopyError,
	} = p;
	return (
		<>
			{" "}
			{/* The meta section is the drawer's last element: it sits below everything else. */}
			<details className="meta-block">
				<summary>
					{SEC_CHEV}
					Meta
				</summary>
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
					{task.prNumber !== null && (
						<div>
							<dt>PR</dt>
							<dd>
								{task.prUrl !== null ? (
									<a
										href={task.prUrl}
										target="_blank"
										rel="noopener noreferrer"
									>
										PR #{task.prNumber}
									</a>
								) : (
									`PR #${task.prNumber}`
								)}
							</dd>
						</div>
					)}
					<div>
						<dt>Worktree</dt>
						<dd>{task.worktree ?? "-"}</dd>
					</div>
					<div>
						<dt>Session</dt>
						<dd>{task.sessionId ?? "-"}</dd>
					</div>
					<div>
						<dt>Ran on</dt>
						<dd>{ranOnLabel(task.turns) ?? "-"}</dd>
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
							{copied ? "Copied" : "Copy command"}
						</button>
					</div>
				)}
				{resumeCmd !== null && cmdCopyError !== null && (
					<p className="auth-error" role="alert">
						{cmdCopyError}
					</p>
				)}
			</details>
		</>
	);
}

/** Drawer sibling dialogs: model pick, lightbox, workflow, diff, follow-up and steps. */
function DrawerDialogs(p: {
	task: TaskView;
	pick: "grill" | "todo" | null;
	setPick: (v: "grill" | "todo" | null) => void;
	act: Act;
	viewing: { list: string[]; index: number; names?: string[] } | null;
	setViewing: React.Dispatch<
		React.SetStateAction<{
			list: string[];
			index: number;
			names?: string[];
		} | null>
	>;
	wfOpen: boolean;
	setWfOpen: (v: boolean) => void;
	project: ProjectView;
	tasks: TaskCard[];
	maxTotal: number | null;
	usedTotal: number;
	draining: boolean;
	diffView: string[] | null | undefined;
	setDiffView: React.Dispatch<
		React.SetStateAction<string[] | null | undefined>
	>;
	cancelled: boolean;
	projects: ProjectView[];
	followOpen: boolean;
	setFollowOpen: (v: boolean) => void;
	onFollowed: (id: string, from: string) => void;
	stepsOpen: boolean;
	setStepsOpen: (v: boolean) => void;
	onMarkSeen: () => void;
}) {
	const {
		task,
		pick,
		setPick,
		act,
		viewing,
		setViewing,
		wfOpen,
		setWfOpen,
		project,
		tasks,
		maxTotal,
		usedTotal,
		draining,
		diffView,
		setDiffView,
		cancelled,
		projects,
		followOpen,
		setFollowOpen,
		onFollowed,
		stepsOpen,
		setStepsOpen,
		onMarkSeen,
	} = p;
	return (
		<>
			{" "}
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
						{/* index is always in range: thumbs set it and turnPage wraps. */}
						<ZoomableImage
							src={viewing.list[viewing.index] ?? ""}
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
					projects={projects}
					open={followOpen}
					onClose={() => setFollowOpen(false)}
					act={act}
					onFollowed={onFollowed}
				/>
			)}
			{/* Sibling, not child: a nested dialog's close event would propagate to the drawer's Modal and close both. */}
			{!cancelled && stepsOpen && (
				<ImplementStepsDialog
					task={task}
					onClose={() => setStepsOpen(false)}
					act={act}
					onMarkSeen={onMarkSeen}
					onFollowed={onFollowed}
				/>
			)}
		</>
	);
}

/** Fetch one task detail; throws on a non-OK response so the caller's catch handles it. */
async function readDetail(url: string): Promise<TaskView> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(String(res.status));
	return (await res.json()) as TaskView;
}

/** A waiting release card: its late-commit list follows the target head, which moves without a row change. */
const releaseWaits = (v: TaskView): boolean =>
	v.releaseVersion !== null &&
	v.state === "needs_you" &&
	v.cancelledAt === null;

/** The follow-up lineage of a drawer card: its parent row and, for a retro, the source
 * card above it. Null when the card is a root, or the parent is no retro. */
function followUpParent(
	row: TaskCard,
	tasks: TaskCard[],
): {
	parent: TaskCard | null;
	retroSource: { id: string; card: TaskCard | null } | null;
} {
	const parent =
		row.followUpOf === null
			? null
			: (tasks.find(
					(t) =>
						t.id === row.followUpOf &&
						t.project === (row.followUpOfProject ?? row.project),
				) ?? null);
	// A retro's proposal card reads its lineage from the retro's source: the parent row is the
	// retro and the source card sits above it. Null when the parent is no retro.
	const retroSource =
		parent === null || parent.kind !== "retro" || parent.followUpOf === null
			? null
			: {
					id: parent.followUpOf,
					card:
						tasks.find(
							(t) =>
								t.id === parent.followUpOf &&
								t.project === (parent.followUpOfProject ?? parent.project),
						) ?? null,
				};
	return { parent, retroSource };
}

/** Every retro under the card, each with every card filed off it (whatever its reason
 * says now), oldest first. One pass over the board, so the rail never scans it once per
 * retro. */
function retroProposals(
	kids: TaskCard[],
	tasks: TaskCard[],
	project: string,
): Map<string, TaskCard[]> {
	const proposals = new Map<string, TaskCard[]>();
	for (const k of kids) if (k.kind === "retro") proposals.set(k.id, []);
	if (proposals.size > 0)
		for (const t of tasks)
			if (
				t.followUpOf !== null &&
				(t.followUpOfProject ?? t.project) === project
			)
				proposals.get(t.followUpOf)?.push(t);
	for (const list of proposals.values())
		list.sort((a, b) => a.createdAt - b.createdAt);
	return proposals;
}

/** The model's context window for the drawer's token meter; null while the session or
 * its model is unknown. ponytail: local cast, an old server's catalog lacks contextWindow. */
function drawerWindowTok(
	ctx: SessionContext | null,
	catalog: ModelCatalog | null,
): number | null {
	return ctx === null || ctx.model === null
		? null
		: ((
				catalog?.models.find((m) => m.selector === ctx.model) as
					| (ModelOption & { contextWindow?: number | null })
					| undefined
			)?.contextWindow ?? null);
}

/** Per-render card flags for the drawer: loading placeholders, reply-vs-follow-up
 * routing, the live ask round, a running mutation, and the merge-anyway gate. */
function drawerCardFlags(
	task: TaskView,
	row: TaskCard,
	detail: TaskView | null,
): {
	wtLoading: boolean;
	diffLoading: boolean;
	cancelled: boolean;
	followUp: boolean;
	askedNow: boolean;
	mut: MutationProgress | null;
	wcUnresolved: boolean;
	wcMergeable: boolean;
} {
	const wtLoading = detail === null && row.worktree !== null;
	const diffLoading =
		detail === null &&
		row.kind === "work" &&
		!row.research &&
		row.releaseVersion === null;
	/** Done tasks answer with a follow-up task (handoff + fresh session) instead of a reply.
	 * A cancelled card's drawer is read-only: no follow-up, no edit, no action. */
	const cancelled = task.cancelledAt !== null;
	const followUp = task.stage === "done" && !cancelled;
	// Ask round live right now: drives the accent status word, mark and panel tint (stalls stay amber).
	const askedNow = task.state === "needs_you" && task.asked !== null;
	// Live mutation run on a running card: the same parse the board card's meter row uses.
	// The row (not the fetched detail) carries `progress`, and its changes refetch the detail.
	const mut = row.state === "running" ? strykerProgress(row.progress) : null;
	const wcUnresolved =
		task.workCheckLog
			.findLast((r) => r.outcome === "blockers")
			?.blockers.some((b) => b.status === undefined) ?? false;
	// Merge anyway shows only while the newest blockers run still has an unresolved blocker and
	// no run is live (a running or preparing card can still pass the check on its own).
	const wcMergeable =
		wcUnresolved && task.state !== "running" && task.state !== "preparing";
	return {
		wtLoading,
		diffLoading,
		cancelled,
		followUp,
		askedNow,
		mut,
		wcUnresolved,
		wcMergeable,
	};
}

/** Per-render prompt-edit and release-notes flags for the drawer: validity of the
 * drafts, and the gates that decide whether each editor may open at all. */
function drawerEditFlags(
	task: TaskView,
	cancelled: boolean,
	notesEdit: string | null,
	edit: string | null,
): {
	notesValid: boolean;
	notesEditable: boolean;
	editable: boolean;
	editValid: boolean;
} {
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
	const editable =
		((task.stage === "todo" && task.state === "queued") ||
			(task.stage === "backlog" && task.state === "idle")) &&
		task.turns.length === 0 &&
		!cancelled;
	const editValid =
		edit !== null && edit.trim().length > 0 && edit.trim().length <= 20000;
	return { notesValid, notesEditable, editable, editValid };
}

/** Per-render result-section flags for the drawer: which report leads the done card,
 * whether the PR review draft replaces the details, and which action is the surface's
 * one primary. */
function drawerResultFlags(
	task: TaskView,
	askedNow: boolean,
	proposal: boolean,
): {
	report: TaskView | TurnView;
	prReviewOpen: boolean;
	prDraft: string | null;
	hideDetails: boolean;
	decisionPrimary: boolean;
} {
	/** Done tasks lead with the implementation's report; the merge turn's integration output stays in its work step. */
	const report =
		(task.stage === "done"
			? task.turns.findLast((t) => t.kind === "work" && t.summary !== null)
			: undefined) ?? task;
	const prReviewOpen = task.kind === "pr_review" && task.prReview !== undefined;
	// PR review card: the watcher saves each draft as the card's details, both while it
	// waits for the Post (needs_you) and after it (done).
	const prDraft =
		task.kind === "pr_review" && task.prReview !== undefined
			? task.details
			: null;
	// The Result skips details shown elsewhere: the research report section or the PR review draft.
	const hideDetails =
		(task.research && task.report !== null) || prDraft !== null;
	// One primary per surface (DESIGN.md → Buttons): the drawer stacks sections that each
	// carry a steel button, so at most one may claim the fill. The card's decision wins —
	// hold approve, proposal accept, ask send, kept-files finish — and the composer's
	// Reply renders stock grey beside it. On a done PR-review card the section's Post
	// review outranks the generic Follow up the same way.
	const decisionPrimary =
		askedNow ||
		(task.state === "needs_you" && task.holdHead !== null) ||
		proposal ||
		(task.state === "needs_you" && task.keptFiles.length > 0);
	return { report, prReviewOpen, prDraft, hideDetails, decisionPrimary };
}

/** Model picker opened from a drawer action on a parked card (grill vs todo mode).
 * Sibling, not child: a nested dialog's close event would propagate to the drawer's
 * Modal and close both. */
function DrawerPickDialog({
	pick,
	setPick,
	task,
	act,
}: {
	pick: "grill" | "todo" | null;
	setPick: (v: "grill" | "todo" | null) => void;
	task: TaskView;
	act: Act;
}) {
	return (
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
	);
}

/** Full-size image lightbox over the drawer's attachments; pages multi-image lists.
 * Sibling, not child: a nested dialog's close event would propagate to the drawer's
 * Modal and close both. */
function DrawerLightbox({
	viewing,
	setViewing,
}: {
	viewing: { list: string[]; index: number; names?: string[] } | null;
	setViewing: React.Dispatch<
		React.SetStateAction<{
			list: string[];
			index: number;
			names?: string[];
		} | null>
	>;
}) {
	return (
		<Modal
			open={viewing !== null}
			onClose={() => setViewing(null)}
			label="Attached image"
			className="lightbox"
		>
			{viewing !== null && (
				<div className="frame">
					{/* index is always in range: thumbs set it and turnPage wraps. */}
					<ZoomableImage
						src={viewing.list[viewing.index] ?? ""}
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
	);
}

export function Drawer({
	open = true,
	task: row,
	project,
	projects,
	act,
	onClose,
	onFollowed,
	read,
	onMarkUnread,
	onMarkSeen,
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
	/** Every board: the follow-up dialog can file into another project. */
	projects: ProjectView[];
	act: Act;
	onClose: () => void;
	onFollowed: (id: string, from: string) => void;
	/** The card's answer is read (in the seen set): the done drawer offers the reverse action. */
	read: boolean;
	/** Marks the answer unread again and closes the drawer; the board owns the seen set. */
	onMarkUnread: () => void;
	/** Marks the steps report read ('No further steps' button); the board owns the seen set. */
	onMarkSeen: () => void;
	delta?: number;
	tasks: TaskCard[];
	onOpenTask: (id: string) => void;
	/** True while an update holds new turns (POST /api/drain): queued cards wait for the restart. */
	draining: boolean;
	/** Agents running machine-wide right now, and the global cap they share. */
	usedTotal: number;
	maxTotal: number | null;
}) {
	const { parent, retroSource } = followUpParent(row, tasks);
	// Oldest first: the rail reads top to bottom in the order the follow-ups were filed.
	// Retros are follow-up rows too; each retro's proposals hang one more level in under it.
	const kids = tasks
		.filter(
			(t) =>
				t.followUpOf === row.id &&
				(t.followUpOfProject ?? t.project) === row.project,
		)
		.sort((a, b) => a.createdAt - b.createdAt);
	const proposals = retroProposals(kids, tasks, row.project);
	/** A follow-up or proposal row: the linked card with its live state, as the meta line shows it. */
	const branchRow = (k: TaskCard, tag: string): ReactNode => (
		<LineageCardLink
			card={k}
			selfProject={row.project}
			tag={tag}
			onOpenTask={onOpenTask}
			state={
				<span
					className={
						k.state === "needs_you"
							? `st st-needs_you${k.asked !== null ? " st-asked" : ""}`
							: "st"
					}
				>
					{/* Same alarm marks as the meta line: markup, not ::before. */}
					{k.state === "needs_you" && <Mark kind={cardMark(k)} />}
					{statusLine(k, project.hasRules, holdFor(k, tasks), draining)}
				</span>
			}
		/>
	);
	// A held card waits until these are done; a cancelled dependency counts as done.
	const waiting = row.stage !== "done" ? waitingOn(tasks, row) : [];
	const [reply, setReply] = useState("");
	const [steer, setSteer] = useState("");
	/** Non-null while the queued steering's text editor is open: holds the editor's draft. */
	const [steerEdit, setSteerEdit] = useState<string | null>(null);
	const [modelQuery, setModelQuery] = useState("");
	const [copied, flashCopied] = useFlash(1500);
	const [copiedId, flashCopiedId] = useFlash(1500);
	const [idCopyError, setIdCopyError] = useState<string | null>(null);
	const [cmdCopyError, setCmdCopyError] = useState<string | null>(null);
	/** The one Work steps turn whose log is expanded: a turn id, or `retro-<id>` for a retro turn (its
	 * id comes from another card and may equal one of this card's). Only one log shows at a time. */
	const [openTurn, setOpenTurn] = useState<number | string | null>(null);
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
	const [stepsOpen, setStepsOpen] = useState(false);
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
	const ctx = useSessionContext(
		row.project,
		row.id,
		rowKey,
		row.state === "running",
	);
	const windowTok = drawerWindowTok(ctx, catalog);
	useEffect(() => {
		let alive = true;
		let retry: ReturnType<typeof setTimeout> | undefined;
		const url = `/api/projects/${encodeURIComponent(row.project)}/tasks/${row.id}`;
		const load = async (attempt: number): Promise<void> => {
			try {
				const v = await readDetail(url);
				if (!alive) return;
				setDetail(v);
				// A waiting release card's late-commit list follows the target head, which moves without a
				// row change of this card; repoll so the list stays fresh while the card waits for approval.
				if (releaseWaits(v)) retry = setTimeout(() => void load(0), 5000);
			} catch {
				// Fetch failed or hiccuped: retry with backoff while the drawer is open. A done row never
				// changes again, so without a retry a blip at open time would show "No turns yet." forever.
				if (!alive) return;
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
	// Work steps rail: this card's turns, its work check runs, its retro's turns and its
	// review's finding turns by start time.
	const steps = workSteps(
		task.turns,
		task.workCheckLog,
		task.retro,
		task.findings,
	);
	// The retro's link and waiting reason ride on its latest step only.
	const lastRetro = steps.findLast((s) => s.kind === "retro");
	// Each finding's "Open finding" link rides on its latest step only.
	const lastFindingStep = new Map<string, number>();
	steps.forEach((s, i) => {
		if (s.kind === "finding") lastFindingStep.set(s.finding.id, i);
	});
	// Touched-file stats (captured at merge, or live from the branch while open): totals for the
	// section's summary line.
	const diffFiles = task.diffFiles ?? [];
	const diffPlus = diffFiles.reduce((n, f) => n + (f.plus ?? 0), 0);
	const diffMinus = diffFiles.reduce((n, f) => n + (f.minus ?? 0), 0);
	// The two file sections ride the fetched detail; while it is in flight the drawer holds
	// their space with a loading line, so the loaded lists fill in instead of popping the
	// body down. The row predicts which sections can appear, with the server's detail rules:
	// worktree files need a live worktree; a diff needs a build card (work kind, not research,
	// not a release), done cards serve the stat captured at merge start.
	const {
		wtLoading,
		diffLoading,
		cancelled,
		followUp,
		askedNow,
		mut,
		wcMergeable,
	} = drawerCardFlags(task, row, detail);
	// Retro proposal card: Resume acts as Accept, and New session (409 on a never-run card) is hidden.
	const proposal = isProposalReason(task.needsReason);
	const { report, prReviewOpen, prDraft, hideDetails, decisionPrimary } =
		drawerResultFlags(task, askedNow, proposal);
	// Non-null while the release-notes editor is open, for release cards with a mutable state.
	const [notesEdit, setNotesEdit] = useState<string | null>(null);
	const notesSave = useBusy();
	// OTTR-795: the card revision each open editor guards its write with, captured when
	// the editor loaded the card. The drawer refetches the card while it sits open (the
	// rowKey poll), so a save must send the captured revision, not the live one — a poll
	// must never hand a stale edit a passing one. A refused save (409) keeps the editor
	// and the user's text, stores the 409's current row as the conflict shown beside the
	// kept text, and re-arms on the row the user just saw, so Save can re-apply it.
	const [editRevision, setEditRevision] = useState<number | null>(null);
	// The prompt editor's Save stays disabled until its hold claim landed: the claim is
	// guarded by the draft's snapshot revision, so saving before it resolves could send
	// no revision at all (the unconditional path) and silently overwrite another tab.
	const [editHoldPending, setEditHoldPending] = useState(false);
	// The claim/reclaim run in effects and page events with stale closures, so the
	// armed revision is mirrored here for them to read at call time.
	const editRevisionRef = useRef<number | null>(null);
	const armEditRevision = (value: number | null): void => {
		editRevisionRef.current = value;
		setEditRevision(value);
	};
	const [editConflict, setEditConflict] = useState<TaskView | null>(null);
	const [notesRevision, setNotesRevision] = useState<number | null>(null);
	const [notesConflict, setNotesConflict] = useState<TaskView | null>(null);
	const [steerRevision, setSteerRevision] = useState<number | null>(null);
	const [steerConflict, setSteerConflict] = useState<{
		current: string | null;
		cancel: boolean;
	} | null>(null);
	const [modelRevision, setModelRevision] = useState<number | null>(null);
	const [modelConflict, setModelConflict] = useState<{
		current: string | null;
	} | null>(null);
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
	// OTTR-604 re-run failed jobs: the action exists only while the card's text
	// links a GitHub Actions run; a cancelled card's drawer is read-only, so no
	// action there either. The server's error string names the missing scope.
	const rerunUrl = ciRunUrl(
		[
			task.prompt,
			task.needsReason ?? "",
			task.summary ?? "",
			detail?.details ?? "",
		].join("\n"),
	);
	const [rerunError, setRerunError] = useState<string | null>(null);
	const [rerunDone, setRerunDone] = useState(false);
	// A new card's drawer starts without the previous card's re-run status or error.
	const rerunTaskId = task.id;
	useEffect(() => {
		setRerunError(null);
		setRerunDone(false);
	}, [rerunTaskId]);
	const rerunFailedJobs = async (): Promise<boolean> => {
		setRerunError(null);
		try {
			await post(
				`/api/projects/${encodeURIComponent(task.project)}/tasks/${encodeURIComponent(task.id)}/rerun-failed-jobs`,
				{},
			);
			setRerunDone(true);
			return true;
		} catch (e) {
			setRerunError(e instanceof Error ? e.message : String(e));
			return false;
		}
	};
	// OTTR-781: a cancelled Dependabot card can be refiled — the fresh card copies the
	// prompt and source-PR fields, so the ship step adopts the PR instead of opening a
	// duplicate. Available only on a cancelled card whose prompt head names a Dependabot PR.
	const refileAvailable =
		cancelled &&
		(task.prompt.split("\n", 1)[0] ?? "").startsWith("Dependabot PR #");
	const [refileError, setRefileError] = useState<string | null>(null);
	useEffect(() => {
		setRefileError(null);
	}, [rerunTaskId]);
	const runRefile = async (): Promise<boolean> => {
		setRefileError(null);
		if (
			!(await confirmDialog(
				`File a fresh card for this Dependabot PR? ${task.id} stays cancelled; a card that still covers the PR blocks the refile.`,
				{ ok: "Refile" },
			))
		)
			return true;
		try {
			await post<{ id: string }>(
				`/api/projects/${encodeURIComponent(task.project)}/tasks/${task.id}/refile`,
				{},
			);
			return true;
		} catch (e) {
			setRefileError(e instanceof Error ? e.message : String(e));
			return false;
		}
	};
	// The rank strip leads: the picked segment presses at once, the triage POST
	// follows, a failure rolls the strip back and lands in the inline alert
	// (onError).
	const rank = useOptimisticValue(task.priority ?? "", act);
	const triageUrl = `/api/projects/${encodeURIComponent(task.project)}/tasks/${task.id}/triage`;
	const setRank = (p: string): void => {
		rank.set(p);
		rank.run(
			() => post(triageUrl, { priority: p === "" ? null : p }),
			undefined,
			setTriageError,
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
	/** Opens the notes editor and captures the loaded row's revision for the guarded
	 *  save: a poll that refreshes the card mid-edit must not hand stale text a pass. */
	const openNotes = (): void => {
		setNotesRevision(task.revision);
		setNotesConflict(null);
		setNotesEdit("");
	};
	const notesSubmit = (mode: "save" | "append"): void => {
		if (notesEdit === null || !notesValid) return;
		// The append base is the row the armed revision belongs to: after a refused
		// save the conflict row holds the board's current notes, and a retry before
		// the next refresh would otherwise append onto the stale snapshot and drop
		// the other writer's text.
		const base = notesConflict ?? task;
		notesSave.start(() =>
			act(async () => {
				try {
					await postEdit(
						`/api/projects/${encodeURIComponent(task.project)}/tasks/${task.id}/release-notes`,
						{
							notes:
								mode === "append"
									? `${base.releaseNotes ?? ""}\n\n${notesEdit}`
									: notesEdit,
							revision: notesRevision ?? undefined,
						},
					);
					setNotesEdit(null);
					setNotesConflict(null);
					setNotesRevision(null);
				} catch (e) {
					if (e instanceof EditConflict) {
						setNotesConflict(e.task);
						setNotesRevision(e.task.revision);
					}
					throw e;
				}
			}),
		);
	};
	// Non-null while the prompt editor is open; a card still waiting gets one: queued in
	// todo, parked idle in backlog. A preparing claim already consumed the prompt, so
	// editing it would be lost.
	const [edit, setEdit] = useState<string | null>(null);
	const { notesValid, notesEditable, editable, editValid } = drawerEditFlags(
		task,
		cancelled,
		notesEdit,
		edit,
	);
	// A start runs the saved prompt, so while the edit is open the start actions wait:
	// they disable until the edit finishes (Save or Cancel), or the draft dies silently
	// once the started turn makes the card uneditable.
	const editOpen = edit !== null;
	const editGuardTitle = "Save or cancel the prompt edit first";
	/** Opens the prompt editor on the loaded row's snapshot. The hold claim below is
	 *  guarded by that same revision and the hold is contentless (it never moves the
	 *  revision), so the armed revision stays the draft's snapshot until a real
	 *  content edit conflicts. Save stays disabled until the claim landed. */
	const openEdit = (): void => {
		armEditRevision(task.revision);
		setEditHoldPending(true);
		setEditConflict(null);
		setEdit(task.prompt);
	};
	const editSaveArmed = editRevision !== null && !editHoldPending;
	const editSubmit = (): void => {
		if (edit === null || !editValid || !editSaveArmed) return;
		editSave.start(() =>
			act(async () => {
				try {
					await postEdit(
						`/api/projects/${encodeURIComponent(task.project)}/tasks/${task.id}/edit`,
						{ prompt: edit, revision: editRevision ?? undefined },
					);
					setEdit(null);
					setEditConflict(null);
					armEditRevision(null);
				} catch (e) {
					if (e instanceof EditConflict) {
						setEditConflict(e.task);
						armEditRevision(e.task.revision);
					}
					throw e;
				}
			}),
		);
	};
	// And the server holds the card off for exactly as long as the editor is open: the open
	// editor claims PROMPT_EDIT_HELD and no renewal runs — hidden tabs throttle timers (a
	// background beat can silently stop arriving mid-edit), so nothing depends on one. Every
	// close path releases: Save clears the hold server-side, Cancel and drawer unmount post
	// stop, and a tab closing mid-edit releases through the pagehide keepalive call, re-claim
	// on pageshow covers the back-forward cache restoring the page with the editor open.
	// Merely hiding the tab keeps the hold: the editor is still open when the user returns.
	useEffect(() => {
		if (!editOpen) return;
		const url = `/api/projects/${encodeURIComponent(task.project)}/tasks/${task.id}/edit`;
		// The claim is guarded by the draft's snapshot revision, and the hold itself is
		// contentless (it never moves the revision), so the armed revision stays the
		// draft's snapshot until a real content edit conflicts. A claim 409 means such
		// an edit landed since the load: the conflict state shows the board's prompt
		// beside the kept draft, and only an explicit re-save applies it. Any other
		// claim failure disarms the save — a stale draft never saves silently.
		const claim = (): void => {
			setEditHoldPending(true);
			void postEdit(`${url}/start`, {
				revision: editRevisionRef.current ?? undefined,
			})
				.then(() => setEditHoldPending(false))
				.catch((err) => {
					if (err instanceof EditConflict) {
						setEditConflict(err.task);
						armEditRevision(err.task.revision);
					} else {
						armEditRevision(null);
					}
					setEditHoldPending(false);
				});
		};
		claim();
		const release = (): void => {
			void fetch(`${url}/stop`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
				keepalive: true,
			}).catch(() => {});
		};
		const reclaim = (): void => {
			claim();
		};
		window.addEventListener("pagehide", release);
		window.addEventListener("pageshow", reclaim);
		return () => {
			window.removeEventListener("pagehide", release);
			window.removeEventListener("pageshow", reclaim);
			void post(`${url}/stop`, {}).catch(() => {});
		};
	}, [editOpen, task.project, task.id]);
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
		// Optimistic Queued bubble: mirror the server's prompt (`text.trim() || "."`) and
		// show it at once; a failed POST rolls it back (The Optimistic-Tap Rule).
		const prompt = text.trim() || ".";
		setLocalPending({
			text: prompt,
			images: draft ? replyImages.images.length : 0,
		});
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
		}).then((ok) => {
			if (!ok) setLocalPending(null);
			return ok;
		});
	};

	/** The confirm + cancel flow of the drawer-actions row: a fork or mismatch hold
	 * message names cancelling the card as an action, so the row's Cancel task is the
	 * hold's decline path too. A trending proposal asks why not: the scout never proposes
	 * the repo again, and the reason rides the cancel POST to guide its later scans. */
	const runCancel = async (): Promise<boolean> => {
		let reason = "";
		const repo = task.trendingRepo;
		const yes =
			task.stage === "done"
				? // A done task has no run, worktree or branch left; this only removes
					// the card from the board. The dialog names the card it acts on.
					await confirmDialog(
						`Delete the done task ${task.id} "${task.title}" from the board?`,
						{
							ok: "Delete task",
							danger: true,
						},
					)
				: // The Named-Object Rule: the dialog names the card it acts on.
					await confirmDialog(
						`Cancel ${task.id} "${task.title}"? It stops the run and deletes its worktree and branch.`,
						{
							ok: "Cancel task",
							cancel: "Keep task",
							danger: true,
							field:
								repo === undefined
									? undefined
									: {
											label: "Why not? (optional)",
											help: `The scout won't propose ${repo} again; your reason guides later scans.`,
											maxLength: 1000,
											onInput: (v) => {
												reason = v;
											},
										},
						},
					);
		if (!yes) return true;
		const why = reason.trim();
		const body = why === "" ? {} : { reason: why };
		return act(async () => {
			const url = `/api/projects/${encodeURIComponent(task.project)}/tasks/${task.id}/cancel`;
			const r = await post<{ kept?: string }>(url, body);
			// The server kept work that isn't merged and flagged the card; deleting it takes a second yes.
			if (r.kept !== undefined) {
				if (
					!(await confirmDialog(
						`Delete the kept worktree and branch of ${task.id} "${task.title}"? The worktree was kept: ${r.kept}.`,
						{ ok: "Delete", danger: true },
					))
				)
					return;
				await post(url, { ...body, force: true });
			}
			onClose();
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
		// Optimistic Queued bubble, as in sendReply: show it at once, roll back on failure.
		const prompt = text.trim() || ".";
		setLocalPending({ text: prompt, images: steerImages.images.length });
		return act(async () => {
			const images = steerImages.images.map((i) => i.data);
			await post(
				`/api/projects/${encodeURIComponent(task.project)}/tasks/${task.id}/steer`,
				{ text, images },
			);
			setSteer("");
			steerImages.clear();
		}).then((ok) => {
			if (!ok) setLocalPending(null);
			return ok;
		});
	};
	/** Withdraws the queued steering before the agent's next turn delivers it.
	 *  `expectedRevision` is the row the user decided on, captured before the confirm
	 *  dialog; a poll during the dialog must not hand the discard a passing revision. */
	const cancelSteer = (expectedRevision: number): Promise<boolean> =>
		act(async () => {
			try {
				await postEdit(
					`/api/projects/${encodeURIComponent(task.project)}/tasks/${task.id}/steer/cancel`,
					{ revision: expectedRevision },
				);
				setSteerConflict(null);
			} catch (e) {
				if (e instanceof EditConflict) {
					setSteerConflict({ current: e.task.pendingPrompt, cancel: true });
				}
				throw e;
			}
		});
	/** Saves an edit of the queued steering: replaces its text before the agent's next turn sends it. */
	const saveSteerEdit = (text: string): Promise<boolean> =>
		act(async () => {
			try {
				await postEdit(
					`/api/projects/${encodeURIComponent(task.project)}/tasks/${task.id}/steer/edit`,
					{ text, revision: steerRevision ?? undefined },
				);
				setSteerEdit(null);
				setSteerConflict(null);
				setSteerRevision(null);
			} catch (e) {
				if (e instanceof EditConflict) {
					setSteerConflict({ current: e.task.pendingPrompt, cancel: false });
					setSteerRevision(e.task.revision);
					// A detail refresh may have landed before this 409 and cleared the
					// draft (no conflict existed yet to guard it): restore the submitted
					// text, so the notice's "your text is kept" holds even after that
					// race. When the editor still holds text, the user's own edits win.
					setSteerEdit((prev) => (prev === null ? text : prev));
				}
				throw e;
			}
		});
	/** Opens the steering editor and captures the loaded row's revision for the guarded
	 *  save: a poll that refreshes the card mid-edit must not hand stale text a pass. */
	const openSteerEdit = (text: string): void => {
		setSteerRevision(task.revision);
		setSteerConflict(null);
		setSteerEdit(text);
	};
	// The drawer live-polls the server: the queued text the steering editor was opened
	// with can be delivered or appended to while the editor sits open. A stale draft
	// must never open over — and a later Save replace — newer steering, so a
	// pendingPrompt change clears it. A refused save is the exception: the conflict
	// flow keeps the user's text across refreshes and re-arms the revision, so the
	// poll's own pendingPrompt change must not wipe the draft the notice says is
	// kept. The last-seen ref keeps the conflict flip itself (openSteerEdit clearing
	// it to re-open the editor) from reading as a change.
	const lastPendingPrompt = useRef(task.pendingPrompt);
	useEffect(() => {
		const changed = task.pendingPrompt !== lastPendingPrompt.current;
		lastPendingPrompt.current = task.pendingPrompt;
		if (changed && steerConflict === null) setSteerEdit(null);
	}, [task.pendingPrompt, steerConflict]);
	/** Switches the model the agent's next turn runs with; lands in-between turns like a steer.
	 *  The picker leads: the picked name shows at once, the POST follows, a failure rolls back. */
	const modelUrl = `/api/projects/${encodeURIComponent(task.project)}/tasks/${task.id}/model`;
	const model = useOptimisticValue(task.model ?? "", act);
	/** OTTR-795: the model menu's open edge captures the loaded row's revision, so a poll
	 *  between open and pick cannot hand a stale choice a passing one. */
	const captureModelMenu = (): void => {
		setModelRevision(task.revision);
		setModelConflict(null);
	};
	const switchModel = (m: string): void => {
		model.set(m);
		model.run(async () => {
			try {
				await postEdit(modelUrl, {
					model: m,
					revision: modelRevision ?? undefined,
				});
				setModelConflict(null);
			} catch (e) {
				if (e instanceof EditConflict) {
					setModelConflict({ current: e.task.model });
					setModelRevision(e.task.revision);
				}
				throw e;
			}
		});
	};
	const editSave = useBusy();
	const steerEditSave = useBusy();
	const replySend = useBusy();
	const steerSend = useBusy();
	// The optimistic Queued bubble: what this client just sent, before the server's
	// pendingPrompt frame lands. null = render the server's pendingPrompt as before.
	const [localPending, setLocalPending] = useState<{
		text: string;
		images: number;
	} | null>(null);
	// Settle: once the server's pendingPrompt carries the sent text (it appends with
	// "\n\n" when one was already parked) the overlay is redundant. If the prompt is
	// gone again and no send is in flight, the bubble was consumed mid-run — clear too.
	// busy is true synchronously in the same handler that sets localPending, so this
	// effect cannot clear the overlay in the tick it is set.
	useEffect(() => {
		if (localPending === null) return;
		const server = task.pendingPrompt;
		const settled =
			(server !== null &&
				(server === localPending.text ||
					server.endsWith(`\n\n${localPending.text}`))) ||
			(server === null && !steerSend.busy && !replySend.busy);
		if (settled) setLocalPending(null);
	}, [task.pendingPrompt, localPending, steerSend.busy, replySend.busy]);

	return (
		<>
			<Modal
				open={open}
				onClose={onClose}
				label={task.sessionTitle ?? task.title}
				className="drawer"
			>
				<div className="drawer-body">
					<DrawerHead
						task={task}
						project={project}
						cancelled={cancelled}
						askedNow={askedNow}
						waiting={waiting}
						tasks={tasks}
						draining={draining}
						act={act}
						copiedId={copiedId}
						flashCopiedId={flashCopiedId}
						idCopyError={idCopyError}
						setIdCopyError={setIdCopyError}
						setWfOpen={setWfOpen}
					/>
					{/* The decision card leads the drawer body on a proposal card, always open and
					    without a section head: it is the reason the drawer is open. The needs-reason
					    box and the Prompt section below stay hidden because the card carries both. */}
					{proposal && task.state === "needs_you" && !cancelled && (
						<section id="drawer-decide" className="dsec" aria-label="Decide">
							<ProposalPanel
								task={task}
								selfProject={row.project}
								tasks={tasks}
								onOpenTask={onOpenTask}
								editOpen={editOpen}
								editGuardTitle={editGuardTitle}
								edit={edit}
								onAccept={() => sendReply(".")}
								onEdit={openEdit}
								onEditChange={setEdit}
								editValid={editValid}
								editSaveArmed={editSaveArmed}
								editSave={editSave}
								onSaveEdit={editSubmit}
								editConflict={editConflict}
								onCancel={runCancel}
							/>
						</section>
					)}
					<DrawerMut mut={mut} />
					<DrawerLineage
						row={row}
						parent={parent}
						retroSource={retroSource}
						kids={kids}
						proposals={proposals}
						branchRow={branchRow}
						onOpenTask={onOpenTask}
					/>
					<DrawerLateCommits task={task} cancelled={cancelled} />
					<DrawerAskPanel
						task={task}
						replySend={replySend}
						sendReply={sendReply}
						diffFiles={diffFiles}
						setDiffView={setDiffView}
					/>
					<DrawerWaiting
						waiting={waiting}
						task={task}
						askedNow={askedNow}
						proposal={proposal}
						row={row}
						project={project}
						tasks={tasks}
						onOpenTask={onOpenTask}
						draining={draining}
					/>
					{task.state === "needs_you" && task.keptFiles.length > 0 && (
						<KeptFilesPanel task={task} act={act} onClose={onClose} />
					)}
					<DrawerFiles
						wtLoading={wtLoading}
						diffLoading={diffLoading}
						task={task}
						diffFiles={diffFiles}
						diffPlus={diffPlus}
						diffMinus={diffMinus}
						setDiffView={setDiffView}
					/>
					<DrawerNotes
						task={task}
						notesEdit={notesEdit}
						setNotesEdit={setNotesEdit}
						openNotes={openNotes}
						notesValid={notesValid}
						notesEditable={notesEditable}
						notesSubmit={notesSubmit}
						notesSave={notesSave}
						notesConflict={notesConflict}
					/>
					<DrawerPrompts
						editable={editable}
						proposal={proposal}
						task={task}
						edit={edit}
						setEdit={setEdit}
						openEdit={openEdit}
						editValid={editValid}
						editSaveArmed={editSaveArmed}
						editSave={editSave}
						editSubmit={editSubmit}
						editConflict={editConflict}
						inputUrls={inputUrls}
						imgUrl={imgUrl}
						setViewing={setViewing}
					/>
					<DrawerResult report={report} hideDetails={hideDetails} task={task} />
					<DrawerPrSec
						task={task}
						prDraft={prDraft}
						act={act}
						setDetail={setDetail}
					/>
					<DrawerWorkCheck task={task} catalog={catalog} />
					<DrawerMergeModal
						mergeOpen={mergeOpen}
						setMergeOpen={setMergeOpen}
						mergeReason={mergeReason}
						setMergeReason={setMergeReason}
						mergeError={mergeError}
						mergeSave={mergeSave}
						mergeAnyway={mergeAnyway}
					/>
					<DrawerShots
						shotUrls={shotUrls}
						task={task}
						setViewing={setViewing}
						imgUrl={imgUrl}
					/>
					<DrawerResearch task={task} mdRef={mdRef} />
					<DrawerSteps
						ctx={ctx}
						windowTok={windowTok}
						detail={detail}
						steps={steps}
						catalog={catalog}
						openTurn={openTurn}
						setOpenTurn={setOpenTurn}
						lastRetro={lastRetro}
						lastFindingStep={lastFindingStep}
						project={project}
						task={task}
						localPending={localPending}
						steerEdit={steerEdit}
						setSteerEdit={setSteerEdit}
						openSteerEdit={openSteerEdit}
						steerEditSave={steerEditSave}
						saveSteerEdit={saveSteerEdit}
						cancelSteer={cancelSteer}
						steerConflict={steerConflict}
						onOpenTask={onOpenTask}
					/>
					<DrawerTriage
						task={task}
						cancelled={cancelled}
						rank={rank}
						setRank={setRank}
						triageSave={triageSave}
						triageReason={triageReason}
						setTriageReason={setTriageReason}
						nominateCandidate={nominateCandidate}
						clearCandidate={clearCandidate}
						triageError={triageError}
					/>
					<DrawerHoldBar
						task={task}
						askedNow={askedNow}
						diffFiles={diffFiles}
						sendReply={sendReply}
					/>
					<DrawerComposer
						followUp={followUp}
						prReviewOpen={prReviewOpen}
						task={task}
						setFollowOpen={setFollowOpen}
						setStepsOpen={setStepsOpen}
						onMarkSeen={onMarkSeen}
						model={model}
						setViewing={setViewing}
						replySend={replySend}
						sendReply={sendReply}
						reply={reply}
						setReply={setReply}
						replyImages={replyImages}
						catalog={catalog}
						modelQuery={modelQuery}
						setModelQuery={setModelQuery}
						switchModel={switchModel}
						onModelMenuOpen={captureModelMenu}
						modelConflict={modelConflict}
						decisionPrimary={decisionPrimary}
						proposal={proposal}
						cancelled={cancelled}
						editOpen={editOpen}
						editGuardTitle={editGuardTitle}
						steerSend={steerSend}
						sendSteer={sendSteer}
						steer={steer}
						setSteer={setSteer}
						steerImages={steerImages}
						act={act}
					/>
					<DrawerActions
						task={task}
						cancelled={cancelled}
						editOpen={editOpen}
						editGuardTitle={editGuardTitle}
						setPick={setPick}
						act={act}
						read={read}
						onMarkUnread={onMarkUnread}
						wcMergeable={wcMergeable}
						setMergeReason={setMergeReason}
						setMergeError={setMergeError}
						setMergeOpen={setMergeOpen}
						rerunUrl={rerunUrl}
						rerunFailedJobs={rerunFailedJobs}
						rerunError={rerunError}
						refileAvailable={refileAvailable}
						runRefile={runRefile}
						refileError={refileError}
						rerunDone={rerunDone}
						runCancel={runCancel}
						cancelInPanel={proposal && task.state === "needs_you"}
					/>
					<DrawerMeta
						task={task}
						cancelled={cancelled}
						act={act}
						project={project}
						delta={delta}
						resumeCmd={resumeCmd}
						setCmdCopyError={setCmdCopyError}
						flashCopied={flashCopied}
						copied={copied}
						cmdCopyError={cmdCopyError}
					/>
				</div>
			</Modal>
			{/* Sibling, not child: a nested dialog's close event would propagate to the drawer's Modal and close both. */}
			<DrawerPickDialog pick={pick} setPick={setPick} task={task} act={act} />
			{/* Sibling, not child: a nested dialog's close event would propagate to the drawer's Modal and close both. */}
			<DrawerLightbox viewing={viewing} setViewing={setViewing} />
			<DrawerDialogs
				task={task}
				pick={pick}
				setPick={setPick}
				act={act}
				viewing={viewing}
				setViewing={setViewing}
				wfOpen={wfOpen}
				setWfOpen={setWfOpen}
				project={project}
				tasks={tasks}
				maxTotal={maxTotal}
				usedTotal={usedTotal}
				draining={draining}
				diffView={diffView}
				setDiffView={setDiffView}
				cancelled={cancelled}
				projects={projects}
				followOpen={followOpen}
				setFollowOpen={setFollowOpen}
				onFollowed={onFollowed}
				stepsOpen={stepsOpen}
				setStepsOpen={setStepsOpen}
				onMarkSeen={onMarkSeen}
			/>
		</>
	);
}

/**
 * Onboarding + login page, shown alone when the server asks for them (public-host access).
 * Success reloads the page: the push socket and every fetch then run with the fresh session cookie.
 */
export function AuthPage({
	mode,
	version,
}: {
	mode: "setup" | "login";
	version: string | null;
}) {
	const [name, setName] = useState("");
	const [password, setPassword] = useState("");
	const [reveal, setReveal] = useState(false);
	const [githubToken, setGithubToken] = useState("");
	const [githubHost, setGithubHost] = useState("");
	const pwId = useId();
	const tokenHint = useId();
	const [remember, setRemember] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const setup = mode === "setup";
	const submit = (e: React.FormEvent): void => {
		e.preventDefault();
		if (busy) return;
		setError(null);
		setBusy(true);
		const host = githubHost.trim();
		post(setup ? "/api/setup" : "/api/login", {
			name: name.trim(),
			password,
			...(setup ? { githubToken: githubToken.trim() } : { remember }),
		})
			.then(() => {
				if (setup && host !== "") {
					return post("/api/settings/github-host", { host }).catch(
						(err: unknown) => {
							// The admin exists and the session works; only the host save failed.
							const msg = err instanceof Error ? err.message : "Request failed";
							throw new Error(
								`${msg} You can set the GitHub host later under Settings → GitHub → GitHub host.`,
							);
						},
					);
				}
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
						Password
						<span className="pw-wrap">
							<input
								id={pwId}
								type={reveal ? "text" : "password"}
								autoComplete={setup ? "new-password" : "current-password"}
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								minLength={setup ? 8 : undefined}
								required
							/>
							<button
								type="button"
								className="icon pw-toggle"
								aria-pressed={reveal}
								aria-controls={pwId}
								aria-label={reveal ? "Hide password" : "Show password"}
								title={reveal ? "Hide password" : "Show password"}
								onClick={() => setReveal((v) => !v)}
							>
								<Icon name={reveal ? "eye-off" : "eye"} />
							</button>
						</span>
						{setup && (
							<span className="hint pw-count" role="status">
								{password.length >= 8
									? "ok"
									: `${password.length} / 8 characters`}
							</span>
						)}
					</label>
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
								Serves the GitHub API features (PR reviews, CI watch,
								Dependabot, releases, token expiry) and gh, and git uses it on
								the configured GitHub host when Settings → Other git hosts has
								no token for that host.
							</span>
						</label>
					)}
					{setup && (
						<label>
							GitHub host
							<span className="opt-mark">(optional)</span>
							<input
								type="text"
								autoComplete="off"
								spellCheck={false}
								value={githubHost}
								onChange={(e) => setGithubHost(e.target.value)}
								aria-label="GitHub host"
								placeholder="github.com"
							/>
							<span className="hint">
								Empty uses github.com. Set this before onboarding when GitHub
								lives on a *.ghe.com host, or the token is checked against
								github.com.
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
						{setup ? "Create admin" : "Sign in"}
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

/** Field error for a Git URL that cannot parse; the wording of the server's
 * GIT_URL_ERROR (gitHosts.ts) restated for the field. */
const GIT_URL_FIELD_ERROR =
	"Not a git repository URL. Use https://…, git@host:path or ssh://….";

/** Client-side mirror of the server's parseGitUrl classes (gitHosts.ts), so the
 * field error shows while typing instead of after a rejected POST. Not the trust
 * boundary: the server re-validates every Add, and a class this mirror is looser
 * about still lands in the dialog-level alert. */
/** https/ssh form: an optional ssh user, then host[:port]/path. */
const gitUrlSchemeProblem = (url: string, lower: string): string | null => {
	const rest = url.slice(lower.startsWith("https://") ? 8 : 6);
	const at = rest.lastIndexOf("@");
	// https carries no user in the URL, ever; ssh may name one.
	if (at !== -1 && !lower.startsWith("ssh://")) return GIT_URL_FIELD_ERROR;
	const hostPort = at === -1 ? rest : rest.slice(at + 1);
	const slash = hostPort.indexOf("/");
	const path = slash === -1 ? "" : hostPort.slice(slash + 1);
	if (
		!/^[A-Za-z0-9.-]+(:[0-9]+)?$/.test(
			slash === -1 ? hostPort : hostPort.slice(0, slash),
		) ||
		!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*(\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/.test(
			path,
		)
	)
		return GIT_URL_FIELD_ERROR;
	return null;
};

const gitUrlProblem = (raw: string): string | null => {
	const url = raw.trim();
	if (url === "") return null; // the input's required check covers empty
	if (url.startsWith("-") || /[\s\p{Cc}]/u.test(url))
		return GIT_URL_FIELD_ERROR;
	const lower = url.toLowerCase();
	if (lower.startsWith("https://") || lower.startsWith("ssh://"))
		return gitUrlSchemeProblem(url, lower);
	// scp form: user@host:path; the path is relative (no leading slash).
	return /^([A-Za-z0-9_.-]+)@([A-Za-z0-9.-]+):(?!\/)\S+$/.test(url)
		? null
		: GIT_URL_FIELD_ERROR;
};

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

/** One project's rail counts: the exclusive states, the most urgent mark, and a spoken summary. */
function railRow(
	p: ProjectView,
	tasks: TaskCard[],
	seen: ReadonlySet<string>,
	since: number,
) {
	const own = tasks.filter((t) => t.project === p.name);
	const split = splitAlarms(own);
	const running = split.running.length;
	const needs = split.needs.length;
	const asks = split.asks.length;
	const waiting = own.filter((t) => t.state === "queued").length;
	const unread = own.filter((t) => isUnread(t, seen, since)).length;
	// The one mark a row shows, by rank: needs action > asked > running > unread. Waiting has no mark.
	const top = railTop({ needs, asks, running, unread });
	const summary = [
		needs > 0 ? `${needs} need action` : "",
		asks > 0 ? `${asks} asked` : "",
		running > 0 ? `${running} running` : "",
		unread > 0 ? `${unread} unread` : "",
		waiting > 0 ? `${waiting} waiting` : "",
	]
		.filter((s) => s !== "")
		.join(", ");
	return { p, running, needs, asks, waiting, unread, top, summary };
}

/** The project rail's rows: Overview, System, Add project, one link per project with its one
 * ranked mark, and the "Ottr <version>" footer line. The desktop rail renders it, and the phone
 * popout under the bar's grid button reuses it (always expanded there). */
export function RailRows({
	projects,
	tasks,
	seenAnswers,
	seenDoneSince,
	project,
	overviewCurrent,
	systemCurrent,
	hosted,
	version,
	collapsed,
	navigate,
	onAdd,
	onPick,
	children,
}: {
	projects: ProjectView[];
	tasks: TaskCard[];
	/** Read marks and the server's done baseline, for the unread dot. */
	seenAnswers: Set<string>;
	seenDoneSince: number;
	project: ProjectView | null;
	/** Overview is the open page (no project, no settings page, not the System view). */
	overviewCurrent: boolean;
	/** The System view is the open page. */
	systemCurrent: boolean;
	/** Hosted mode: no System row (docs/specs/hosted-mode.md). */
	hosted: boolean;
	version: string | null;
	/** Folded desktop rail: the rows show only their plates, so each one gets a title tooltip. */
	collapsed: boolean;
	/** Plain-click navigation to a view path (see navClick). */
	navigate: (path: string) => void;
	onAdd: () => void;
	/** Runs after any row click; the phone popout closes itself here. */
	onPick?: () => void;
	/** More footer content after the ident line (the desktop account chip). */
	children?: ReactNode;
}) {
	const go = (e: ReactMouseEvent<HTMLAnchorElement>): void => {
		navClick(e, navigate);
		onPick?.();
	};
	return (
		<>
			<a
				className="area"
				aria-current={overviewCurrent ? "page" : undefined}
				href="/"
				onClick={go}
				title={collapsed ? "Overview" : undefined}
			>
				<span className="rail-plate icon">
					<Icon name="grid" size={13} />
				</span>
				<span className="area-name rail-label">Overview</span>
			</a>
			{!hosted && (
				<a
					className="area"
					aria-current={systemCurrent ? "page" : undefined}
					href={viewPath(SYSTEM_VIEW)}
					onClick={go}
					title={collapsed ? "System" : undefined}
				>
					<span className="rail-plate icon">
						<Icon name="activity" size={13} />
					</span>
					<span className="area-name rail-label">System</span>
				</a>
			)}
			<button
				type="button"
				className="area area-add"
				aria-label="Add project"
				title={collapsed ? "Add project" : undefined}
				onClick={() => {
					onPick?.();
					onAdd();
				}}
			>
				<span className="rail-plate icon">
					<Icon name="plus" size={13} />
				</span>
				<span className="rail-label">Add project</span>
			</button>
			<p className="areas-label">Projects</p>
			<ul>
				{projects.map((p) => {
					const r = railRow(p, tasks, seenAnswers, seenDoneSince);
					return (
						<li key={p.name}>
							<a
								className="area"
								href={projectPath(p.name)}
								aria-current={project?.name === p.name ? "page" : undefined}
								onClick={go}
								title={
									collapsed
										? `${projectLabel(p)}${r.summary === "" ? "" : `: ${r.summary}`}`
										: undefined
								}
							>
								<span className="rail-plate">
									<ProjectTag project={p} />
									{r.top !== null && (
										<span className="rail-badge">
											<Mark kind={r.top} />
										</span>
									)}
								</span>
								<span className="area-name rail-label">{projectLabel(p)}</span>
								{/* One mark, the highest ranked; the full counts sit in the title and
								    for screen readers. */}
								{r.top !== null && (
									<span className={`area-ind ${r.top}`} title={r.summary}>
										<Mark kind={r.top} />
									</span>
								)}
								{r.summary !== "" && <span className="sr">: {r.summary}</span>}
							</a>
						</li>
					);
				})}
			</ul>
			<footer className="rail-foot">
				<p className="rail-ident">
					<a
						className="menu-brand"
						href={REPO}
						target="_blank"
						rel="noopener noreferrer"
						title="Ottr on GitHub"
						onClick={onPick}
					>
						Ottr
					</a>
					{version !== null && (
						<span className="rail-ver" title={version}>
							{version}
						</span>
					)}
				</p>
				{children}
			</footer>
		</>
	);
}

/** General-page TOC labels (sections and blocks) mapped to their scroll-target ids;
 * the warning-link grammar below matches exactly these labels. */
const SETTINGS_LABEL_IDS: ReadonlyMap<string, string> = new Map([
	...SETTINGS_TOC.flatMap((group) =>
		group.sections.flatMap((section) => [
			[section.label, section.id] as const,
			...("blocks" in section
				? section.blocks.map((block) => [block.label, block.id] as const)
				: []),
		]),
	),
	// Labels of renamed cards: stored notices still name them.
	["Git hosts", "git-hosts-section"],
	["Other host tokens", "host-tokens-block"],
	["Global SSH key", "ssh-key-block"],
]);

const SETTINGS_SEP = String.raw`\s*(?:→|->|–|—|-)\s*`;
const SETTINGS_LABELS = [...SETTINGS_LABEL_IDS.keys()]
	.sort((a, b) => b.length - a.length)
	.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
	.join("|");
/** One scan for both link rules: a https:// URL, or a settings phrase — the word
 * plus one or more `<separator> <label>` steps. The trailing lookahead keeps a
 * longer word ("Settings - Envelope") from matching the "Env" label, and sentence
 * punctuation can never join a label, so it stays outside the anchor naturally. */
const WARNING_LINK_RE = new RegExp(
	`(https://\\S+)|(\\bSettings(?:${SETTINGS_SEP}(?:${SETTINGS_LABELS}))+)(?![A-Za-z0-9])`,
	"g",
);
/** The label steps of a matched settings phrase, for the deepest-id walk. */
const SETTINGS_PHRASE_LABEL_RE = new RegExp(
	`${SETTINGS_SEP}(${SETTINGS_LABELS})`,
	"g",
);

/** Deepest TOC id for a matched settings phrase: walk its labels from the end and
 * keep the first one that resolves, so a chain anchors to its last step. */
function settingsPhraseId(phrase: string): string {
	const labels = [...phrase.matchAll(SETTINGS_PHRASE_LABEL_RE)]
		.map((m) => m[1] ?? "")
		.reverse();
	for (const label of labels) {
		const id = SETTINGS_LABEL_IDS.get(label);
		if (id !== undefined) return id;
	}
	// Unreachable: the phrase grammar only admits known labels.
	return "";
}

/** Links inside a server warning: https:// URLs open in a new tab, and a
 * `Settings <sep> <label>` phrase opens that General settings section in-tab (a
 * chain like `Settings → GitHub → GitHub token` anchors the whole phrase to
 * the deepest step). A trailing sentence period stays outside the anchor so the
 * href stays valid. In hosted mode a phrase that names a hidden card stays plain text. */
export function warningLinks(text: string, hosted = false): ReactNode {
	const out: ReactNode[] = [];
	let last = 0;
	for (const m of text.matchAll(WARNING_LINK_RE)) {
		const { index = 0 } = m;
		const url = m[1];
		const phrase = m[2] ?? "";
		if (index > last) out.push(text.slice(last, index));
		if (url !== undefined) {
			const link = url.replace(/\.+$/, "");
			out.push(
				<Fragment key={out.length}>
					<a
						className="notif-link"
						href={link}
						target="_blank"
						rel="noopener noreferrer"
					>
						{link}
					</a>
					{url.slice(link.length)}
				</Fragment>,
			);
		} else {
			const id = settingsPhraseId(phrase);
			if (hostedHidden(hosted, id)) out.push(phrase);
			else
				out.push(
					<a
						key={out.length}
						className="notif-link"
						href={`${settingsPath(null)}#${id}`}
						onClick={(e) => {
							e.preventDefault();
							openSettingsSection(id);
						}}
					>
						{phrase}
					</a>,
				);
		}
		last = index + m[0].length;
	}
	if (last < text.length) out.push(text.slice(last));
	return out;
}

/** Server warnings (unseeded agent layer, provider without an active sign-in), one line each.
 * No dismiss: state recomputes per poll, so a fixed condition drops its own line. */
export function WarningLines({ warnings }: { warnings: string[] }) {
	const hosted = useContext(HostedContext);
	if (warnings.length === 0) return null;
	return (
		<>
			{warnings.map((w, i) => (
				<p className="notif-line" role="note" key={`warn:${i}`}>
					<Mark kind="warn" />
					<span>{warningLinks(w, hosted)}</span>
				</p>
			))}
		</>
	);
}

/** OTTR-625: the update task defers the restart while the board runs an older commit than
 * the image it built. One amber line: the user can act (restart on the host), and the board
 * cannot restart itself (no docker in the image), so the notice names the exact command —
 * that naming is the danger confirmation, it says what dies. Null renders nothing. */
export function RestartWaitLine({
	wait,
	inboxKey,
	fresh,
}: {
	wait: RestartWaitView | null;
	inboxKey?: string;
	fresh: boolean;
}) {
	if (wait === null) return null;
	return (
		<p className="notif-line" role="note" data-inbox-key={inboxKey}>
			<Mark kind="warn" />
			<span>
				The board runs {wait.running.slice(0, 7)}; the image holds{" "}
				{wait.commit.slice(0, 7)} ({wait.commits} commit
				{wait.commits === 1 ? "" : "s"} newer).{" "}
				{wait.turns.length > 0
					? `The restart waits for: ${wait.turns.join(", ")}. Restarting now stops those turns.`
					: "Restarting now stops the running turns."}{" "}
				On the host, run <code>{wait.command}</code> from the stack's checkout.
			</span>
			{fresh && <span className="new-tag">New</span>}
		</p>
	);
}

/** The skill folder a SkillSpector rejection names, e.g. "egm-review-loop" from the
 *  alate install output's ".../user/omp/agent/skills/egm-review-loop"; null otherwise. */
export function seedFailSkill(text: string): string | null {
	const m = /skills\/([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(text);
	return m === null ? null : (m[1] ?? null);
}

/** OTTR-753: the update script's hourly seed of the agent layer failed (the record it
 *  writes next to the board home). One red line: the first failure's time, the commit
 *  it tried, the redacted failure text, and the next step. A SkillSpector rejection
 *  names the skill folder and its baseline file. Null renders nothing. */
export function SeedFailedLine({
	fail,
	inboxKey,
	fresh,
}: {
	fail: SeedFailedView | null;
	inboxKey?: string;
	fresh: boolean;
}) {
	if (fail === null) return null;
	const skill = seedFailSkill(fail.text);
	// The recorded tail often ends mid-sentence (the script cuts it), so the next
	// step starts on a clean sentence boundary.
	const text =
		fail.text !== "" && !/[.!?;:]$/.test(fail.text)
			? `${fail.text}.`
			: fail.text;
	return (
		<p className="notif-line" role="note" data-inbox-key={inboxKey}>
			<Mark kind="crit" />
			<span>
				Agent layer seed failed since {stamp(fail.since)}.{" "}
				{fail.commit !== "" && <>Tried commit {fail.commit.slice(0, 12)}. </>}
				{text !== "" && <>{text} </>}
				{skill !== null
					? `Fix the skill ${skill}, or accept the findings in its .skillspector-baseline.yaml in the data repo.`
					: "The next update run seeds the agent layer again."}
			</span>
			{fresh && <span className="new-tag">New</span>}
		</p>
	);
}

/** OTTR-753: the last failed provision attempt (Settings → Alate → Provision now, or
 *  the board's own trigger). One red line, so a failed provision is not settings-only;
 *  a success or a settled health poll drops it. Null renders nothing. */
export function ProvisionErrorLine({
	error,
	inboxKey,
	fresh,
}: {
	error: string | null;
	inboxKey?: string;
	fresh: boolean;
}) {
	if (error === null) return null;
	return (
		<p className="notif-line" role="note" data-inbox-key={inboxKey}>
			<Mark kind="crit" />
			<span>
				Agent layer provision failed: {error} Run Provision again, and check
				that the alate server is up.
			</span>
			{fresh && <span className="new-tag">New</span>}
		</p>
	);
}

/** True when two wire copies of one card carry equal content. The server re-serializes every
 * frame, so array and object fields never keep reference identity; a shallow primitive compare
 * first, then a JSON compare for the fields where references differ. Key counts differ when
 * the server adds or drops a conditional field, which also counts as changed. */
function sameCard(a: TaskCard, b: TaskCard): boolean {
	const keys = Object.keys(a) as (keyof TaskCard)[];
	if (keys.length !== Object.keys(b).length) return false;
	for (const k of keys) {
		if (a[k] === b[k]) continue;
		if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
	}
	return true;
}

/** Merges a pushed state frame with the previous one: a card the frame carries unchanged keeps
 * the previous object, so a memoized Card skips its render, and a frame that changes no card
 * keeps even the tasks array. The frame's other fields (quota, server version, projects)
 * always come through: a frame that moves only them must still reach the UI. */
export function reuseCards(
	prev: StateResponse | null,
	next: StateResponse,
): StateResponse {
	if (prev === null) return next;
	const prevById = new Map(prev.tasks.map((t) => [t.id, t]));
	const tasks = next.tasks.map((t) => {
		const p = prevById.get(t.id);
		return p !== undefined && sameCard(p, t) ? p : t;
	});
	for (let i = 0; i < tasks.length; i++) {
		if (tasks[i] !== prev.tasks[i]) return { ...next, tasks };
	}
	return prev.tasks.length === tasks.length
		? { ...next, tasks: prev.tasks }
		: { ...next, tasks };
}

/** One card per rendered card, `<id>:<stage>`; two frames whose cards sit in the same stages
 * cannot fly a card between lanes, so the board FLIP effect has nothing to measure. */
export function boardFlipSig(tasks: readonly TaskCard[]): string {
	return tasks.map((t) => `${t.id}:${t.stage}`).join(" ");
}

/** Measure every rendered card's position so the FLIP effect can fly it between lanes. */
function measureCards(): {
	next: Map<string, CardPos>;
	els: Map<string, HTMLElement>;
} {
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
	return { next, els };
}

/** A fresh follow-up starts where its done parent sits, so it visibly grows out of that card. */
function applyOriginFlight(
	origin: { current: { id: string; from: string } | null },
	flights: Map<string, { dx: number; dy: number }>,
	els: Map<string, HTMLElement>,
	prev: Map<string, CardPos>,
	next: Map<string, CardPos>,
): void {
	const org = origin.current;
	if (org === null) return;
	const el = els.get(org.id);
	const pos = next.get(org.id);
	const src = prev.get(org.from);
	if (el === undefined || pos === undefined || src === undefined) return;
	flights.set(org.id, {
		dx: src.left - pos.left,
		dy: src.top - pos.top,
	});
	origin.current = null;
}

/** Fly the changed cards between lanes and fade the fresh ones in; reduced motion gets the fade only. */
function animateBoardChanges(
	els: Map<string, HTMLElement>,
	flights: Map<string, { dx: number; dy: number }>,
	fresh: ReadonlySet<string>,
): void {
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
}

/** Shared guard for the single-letter board shortcuts: true while a modifier, a modal or a text field holds the key. */
function shortcutInert(
	e: KeyboardEvent,
	key: string,
	blocked: boolean,
): boolean {
	if (e.key !== key && e.key !== key.toUpperCase()) return true;
	if (e.ctrlKey || e.metaKey || e.altKey) return true;
	if (blocked) return true;
	if (
		e.target instanceof HTMLElement &&
		e.target.closest("input, textarea, select, [contenteditable]")
	)
		return true;
	return false;
}

/** The board's per-render view selection: the active project (or System/Settings route),
 * the card the drawer shows, and hosted mode. Pure reads, so the drawer sheet and the
 * keyboard shortcuts see the same values as the JSX below. */
function appViewSelection(
	state: StateResponse | null,
	view: string,
	projects: ProjectView[],
	selectedId: string | null,
	tasks: TaskCard[],
	bootHosted: boolean,
): {
	hosted: boolean;
	onSystem: boolean;
	project: ProjectView | null;
	settingsRoute: { onSettings: boolean; project: string | null };
	overviewCurrent: boolean;
	selected: TaskCard | null;
	selectedProject: ProjectView | null;
} {
	// Hosted mode (docs/specs/hosted-mode.md): the control plane owns the host, so the System
	// view, the update notices and the identity pages stay hidden.
	const hosted = bootHosted || state?.hosted === true;
	// The System view's view string shares the namespace of project names, like "settings":
	// on /system no project is current. Hosted mode has no System view: /system is a plain view.
	const onSystem = !hosted && view === SYSTEM_VIEW;
	const project = onSystem
		? null
		: (projects.find((p) => p.name === view) ?? null);
	const settingsRoute = settingsSub(view);
	const overviewCurrent =
		project === null && !settingsRoute.onSettings && !onSystem;
	const selected =
		selectedId === null
			? null
			: (tasks.find((t) => t.id === selectedId) ?? null);
	const selectedProject =
		selected === null
			? null
			: (projects.find((p) => p.name === selected.project) ?? null);
	return {
		hosted,
		onSystem,
		project,
		settingsRoute,
		overviewCurrent,
		selected,
		selectedProject,
	};
}

/** Server-frame notice fields the board's inbox and banner read; defaults while the
 * first frame is still loading. */
function appServerNotices(state: StateResponse | null): {
	draining: boolean;
	drainCommits: string[];
	warnings: string[];
	orphanList: OrphanProcess[];
	orphansError: string | null;
	keptCount: StateResponse["keptWorktrees"];
} {
	// An update holds new turns (scripts/update-image.ts): queued cards wait for the restart.
	const draining = (state?.drainUntil ?? null) !== null;
	const drainCommits = state?.drainCommits ?? [];
	// Advisory from the server: unseeded agent layer, provider without an active sign-in.
	const warnings = state?.warnings ?? [];
	const orphanList = state?.orphans ?? [];
	const orphansError = state?.orphansError ?? null;
	const keptCount = state?.keptWorktrees ?? { held: 0, stale: 0 };
	return {
		draining,
		drainCommits,
		warnings,
		orphanList,
		orphansError,
		keptCount,
	};
}

/** Update-banner values: how far behind the board is, the pending commits, the restart
 * wait, the failed seed, and the provider sign-in advisories. Hosted mode drops the
 * host-owned ones. */
function appUpdateNotices(
	hosted: boolean,
	update: { behind: number; commits: string[] } | null,
	state: StateResponse | null,
): {
	behind: number;
	behindCommits: string[];
	restartWait: RestartWaitView | null;
	seedFailed: SeedFailedView | null;
	signinAdvisories: DeadSignIn[];
} {
	// Shared notification lines: the inbox panel renders the same content the
	// entries are keyed from, so rows and keys cannot drift apart.
	const behind = hosted || update === null ? 0 : Math.max(update.behind, 0);
	const behindCommits = update === null ? [] : update.commits;
	// OTTR-625: the update task holds the restart until the running turns finish, because
	// the board runs an older commit than the image it built.
	const restartWait = hosted ? null : (state?.restartWait ?? null);
	// OTTR-753: the update task's hourly seed of the agent layer failed; the host owns
	// the record, so hosted mode drops it like the restart wait.
	const seedFailed = hosted ? null : (state?.seedFailed ?? null);
	const signinAdvisories = hosted ? [] : (state?.deadSignIns ?? []);
	return { behind, behindCommits, restartWait, seedFailed, signinAdvisories };
}

/** Inbox entry keys for the board's notice lines: occurrence keys so a recurrence
 * counts as new. shortKey hashes a long body (an error text, an id list), so no key
 * outgrows the seen route's limit. */
function appNoticeKeys(
	state: StateResponse | null,
	coveredUpdates: Map<string, TaskCard>,
	error: string | null,
	notice: string | null,
	hosted: boolean,
	behind: number,
	restartWait: RestartWaitView | null,
	seedFailed: SeedFailedView | null,
	draining: boolean,
	orphanList: OrphanProcess[],
	orphansError: string | null,
	keptCount: StateResponse["keptWorktrees"],
	nowMs: number,
): {
	updateIds: string[];
	updateCount: number;
	critKey: string | null;
	noticeKey: string | null;
	drainNotice: boolean;
	drainKey: string | null;
	behindKey: string | null;
	restartWaitKey: string | null;
	seedFailKey: string | null;
	provisionErrKey: string | null;
	updatesKey: string | null;
	orphansErrorKey: string | null;
	orphansKey: string | null;
	keptKey: string | null;
	alatePendingKey: string | null;
} {
	// U6: rows an open (non-done, non-cancelled) update card already carries are not pending for the user.
	/** Actionable upstream updates (rows with a pin target); drives the inbox entry (U5). */
	const updateIds =
		state?.updates?.rows
			.filter((r) => r.target !== null && !coveredUpdates.has(r.id))
			.map((r) => r.id) ?? [];
	const updateCount = updateIds.length;
	const critKey = error !== null ? shortKey("crit", error) : null;
	const noticeKey = notice !== null ? shortKey("notice", notice) : null;
	// Cards still name the hold in their status line; hosted mode drops only the inbox notice.
	const drainNotice = draining && !hosted;
	const drainKey = drainNotice ? `drain:${state?.drainUntil}` : null;
	const behindKey = behind > 0 ? `behind:${behind}` : null;
	// `since` in the key: a new wait (a later image) counts as new again.
	const restartWaitKey =
		restartWait !== null ? `restart-wait:${restartWait.since}` : null;
	// OTTR-753: `since` in the key too, so a new failure episode counts as new again.
	const seedFailKey =
		seedFailed !== null ? `seed-failed:${seedFailed.since}` : null;
	// The last failed provision attempt: shortKey hashes the error text, so a
	// changed failure is a new occurrence, and the same failure stays one.
	const provisionErr = hosted ? null : (state?.alateProvisionError ?? null);
	const provisionErrKey =
		provisionErr !== null ? shortKey("provision-error", provisionErr) : null;
	const updatesKey =
		updateCount > 0 ? shortKey("updates", updateIds.join(",")) : null;
	const orphansErrorKey =
		orphansError !== null ? shortKey("orphans-error", orphansError) : null;
	const orphansKey =
		orphanList.length > 0
			? shortKey("orphans", orphanList.map((o) => o.pid).join(","))
			: null;
	const keptKey =
		keptCount.held > 0 ? `kept:${keptCount.held}:${keptCount.stale}` : null;
	// Hosted mode: Alate and provider sign-ins are the operator's, so neither notice shows.
	const alatePendingKey = hosted
		? null
		: alatePendingEntry(state?.alatePendingSince ?? null, nowMs);
	return {
		updateIds,
		updateCount,
		critKey,
		noticeKey,
		drainNotice,
		drainKey,
		behindKey,
		restartWaitKey,
		seedFailKey,
		provisionErrKey,
		updatesKey,
		orphansErrorKey,
		orphansKey,
		keptKey,
		alatePendingKey,
	};
}

/** What the bell and the notification popover read; the shape inboxView returns. */
type InboxSummary = {
	total: number;
	fresh: InboxEntry[];
	lit: boolean;
	level: InboxLevel | null;
};

/** The board's inbox: one entry per panel row, most urgent first, plus the bell's
 * tooltip lines. `inboxSeen` is the server's shared list plus this tab's pending acks. */
export function appInboxMeta(
	state: StateResponse | null,
	ackLocal: ReadonlySet<string>,
	error: string | null,
	critKey: string | null,
	needTasks: TaskCard[],
	askCards: TaskCard[],
	prActivity: TaskCard[],
	infoKeys: (string | null)[],
	warnings: string[],
	alarmCount: number,
	alarmLine: string,
): {
	inboxSeen: ReadonlySet<string>;
	entries: InboxEntry[];
	inbox: InboxSummary;
	inboxSig: string;
	inboxTitle: string;
	inboxName: string;
} {
	/** Acknowledged inbox entry keys: the server's shared list plus this tab's pending acks. */
	const inboxSeen: ReadonlySet<string> = new Set([
		...(state?.inboxSeen ?? []),
		...ackLocal,
	]);
	const entries: InboxEntry[] = [
		...(critKey === null ? [] : [{ key: critKey, level: "crit" as const }]),
		...needTasks.map((t) => ({
			key: taskEntryKey(t),
			level: "needs" as const,
		})),
		...prActivity.map((t) => ({
			key: `pr:${t.id}:${t.prOccurrence?.comments}`,
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
	return { inboxSeen, entries, inbox, inboxSig, inboxTitle, inboxName };
}

/** The bell button and its screen-reader summary line. */
export function AppInboxBell({
	inbox,
	inboxTitle,
	inboxName,
	loaded,
}: {
	inbox: InboxSummary;
	inboxTitle: string;
	inboxName: string;
	loaded: boolean;
}) {
	// The arrival ring: when the unseen set grows while the board is open, `ring` steps
	// and the icon remounts (key={ring}), so the CSS bell-ring plays once per batch. An
	// ack shrinks the set and a reorder reshuffles it — neither rings. The baseline arms
	// on the first loaded frame, so a bell that mounts lit (page load, reload) stays
	// silent, and the rung class keeps the animation off until an arrival: the lit fill
	// and the badge already announce what is waiting.
	const freshSig = inbox.fresh.map((e) => e.key).join("\n");
	const [seenFresh, setSeenFresh] = useState<string | null>(
		loaded ? freshSig : null,
	);
	const [ring, setRing] = useState(0);
	if (loaded) {
		if (seenFresh === null) {
			setSeenFresh(freshSig);
		} else if (freshSig !== seenFresh) {
			const prev = seenFresh === "" ? [] : seenFresh.split("\n");
			if (inbox.fresh.some((e) => !prev.includes(e.key))) setRing(ring + 1);
			setSeenFresh(freshSig);
		}
	}
	return (
		<>
			<button
				type="button"
				className={
					(inbox.lit ? "icon inbox lit" : "icon inbox") +
					(ring > 0 ? " rung" : "")
				}
				data-level={inbox.level ?? undefined}
				popoverTarget="inbox"
				title={inboxTitle}
				aria-label={inboxName}
			>
				<Icon name="bell" key={ring} />
				{inbox.total > 0 && <span className="inbox-n">{inbox.total}</span>}
			</button>
			<span className="sr" role="status">
				{inbox.fresh.length > 0
					? `${inbox.fresh.length} new notification${inbox.fresh.length === 1 ? "" : "s"}`
					: ""}
			</span>
		</>
	);
}

/** The board's notification popover: critical line, alarm groups, the upstream-updates
 * entry, notices, advisories, and the ack footer. */
export function AppInboxPanel(p: {
	error: string | null;
	critKey: string | null;
	needTasks: TaskCard[];
	askCards: TaskCard[];
	prActivity: TaskCard[];
	alarmCount: number;
	updatesKey: string | null;
	updateCount: number;
	isNew: (key: string) => boolean;
	notice: string | null;
	noticeKey: string | null;
	orphansError: string | null;
	drainNotice: boolean;
	drainKey: string | null;
	drainCommits: string[];
	behind: number;
	behindKey: string | null;
	behindCommits: string[];
	restartWait: RestartWaitView | null;
	restartWaitKey: string | null;
	seedFailed: SeedFailedView | null;
	seedFailKey: string | null;
	provisionError: string | null;
	provisionErrKey: string | null;
	state: StateResponse | null;
	warnings: string[];
	orphanList: OrphanProcess[];
	orphansErrorKey: string | null;
	orphansKey: string | null;
	keptCount: StateResponse["keptWorktrees"];
	keptKey: string | null;
	alatePendingKey: string | null;
	signinAdvisories: DeadSignIn[];
	projects: ProjectView[];
	nowMs: number;
	openTask: (id: string) => void;
	entries: InboxEntry[];
	inbox: InboxSummary;
	ackInbox: (keys: string[]) => void;
	setShowUpdates: (v: boolean) => void;
	setError: (v: string | null) => void;
	setNotice: (v: string | null) => void;
}) {
	const {
		error,
		critKey,
		needTasks,
		askCards,
		prActivity,
		alarmCount,
		updatesKey,
		updateCount,
		isNew,
		notice,
		noticeKey,
		orphansError,
		drainNotice,
		drainKey,
		drainCommits,
		behind,
		behindKey,
		behindCommits,
		restartWait,
		restartWaitKey,
		seedFailed,
		seedFailKey,
		provisionError,
		provisionErrKey,
		state,
		warnings,
		orphanList,
		orphansErrorKey,
		orphansKey,
		keptCount,
		keptKey,
		alatePendingKey,
		signinAdvisories,
		projects,
		nowMs,
		openTask,
		entries,
		inbox,
		ackInbox,
		setShowUpdates,
		setError,
		setNotice,
	} = p;
	const critLine =
		error !== null ? (
			<p className="notif-line" data-inbox-key={critKey ?? undefined}>
				<Mark kind="crit" />
				<span>{error}</span>
				{critKey !== null && isNew(critKey) && (
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
					{
						heading: "PR review activity",
						tasks: prActivity,
						prKey: true,
					},
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
									const key = g.prKey
										? `pr:${t.id}:${t.prOccurrence?.comments}`
										: taskEntryKey(t);
									return (
										<li key={t.id} data-inbox-key={key}>
											<a
												className="alarm-link"
												href={taskPath(t.project, t.id)}
												onClick={(e) => {
													navClick(e, () => openTask(t.id));
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
												<span className="alarm-key" title={`Task ${t.id}`}>
													{t.id}
												</span>
												<span className="alarm-title">
													{t.sessionTitle ?? t.title}
												</span>
												{isNew(key) && <span className="new-tag">New</span>}
											</a>
										</li>
									);
								})}
							</ul>
						</section>
					))
			: null;
	return (
		<div id="inbox" popover="auto" className="popover notif-pop inbox-pop">
			{/* The rows scroll here; the ack footer sits outside, so it never covers a row. */}
			<div className="notif-scroll">
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
							<li data-inbox-key={updatesKey}>
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
									{isNew(updatesKey) && <span className="new-tag">New</span>}
								</button>
							</li>
						</ul>
					</section>
				)}
				<AppInfoLines
					notice={notice}
					noticeKey={noticeKey}
					drainNotice={drainNotice}
					drainKey={drainKey}
					drainCommits={drainCommits}
					behind={behind}
					behindKey={behindKey}
					behindCommits={behindCommits}
					restartWait={restartWait}
					restartWaitKey={restartWaitKey}
					seedFailed={seedFailed}
					seedFailKey={seedFailKey}
					provisionError={provisionError}
					provisionErrKey={provisionErrKey}
					isNew={isNew}
					setNotice={setNotice}
					updateCycle={state?.updateCycle ?? null}
					nowMs={nowMs}
				/>
				<AppAdvisoryLines
					state={state}
					warnings={warnings}
					orphanList={orphanList}
					orphansError={orphansError}
					orphansErrorKey={orphansErrorKey}
					orphansKey={orphansKey}
					keptCount={keptCount}
					keptKey={keptKey}
					alatePendingKey={alatePendingKey}
					signinAdvisories={signinAdvisories}
					nowMs={nowMs}
					openTask={openTask}
					isNew={isNew}
				/>
				{inbox.total === 0 && (
					<section>
						<h2>All clear</h2>
						<p className="hint">
							Tasks that need you, failed actions and Ottr notices appear here.
						</p>
					</section>
				)}
			</div>
			{inbox.total > 0 && (
				<div className="inbox-foot">
					<button
						type="button"
						disabled={inbox.fresh.length === 0}
						onClick={() => ackInbox(entries.map((e) => e.key))}
					>
						Mark all as read
					</button>
				</div>
			)}
		</div>
	);
}

/** The upstream version notice and the pending commit list. */
export function AppBehindNotice(p: {
	behind: number;
	behindKey: string | null;
	behindCommits: string[];
	isNew: (key: string) => boolean;
	updateCycle: UpdateCycleView | null;
	nowMs: number;
}) {
	const { behind, behindKey, behindCommits, isNew } = p;
	return (
		behind > 0 && (
			<div
				className="update-cycle-notice"
				data-inbox-key={behindKey ?? undefined}
			>
				<p className="notif-line">
					<Icon name="info" size={16} />
					<span>
						A new Ottr version is available ({behind} commit
						{behind === 1 ? "" : "s"}).
						{p.updateCycle === null && (
							<>
								{" "}
								Host control is unavailable. Stop the server, run{" "}
								<code>bun run update</code>, then start it again.
							</>
						)}
					</span>
					{behindKey !== null && isNew(behindKey) && (
						<span className="new-tag">New</span>
					)}
				</p>
				<UpdateCycleControl cycle={p.updateCycle} nowMs={p.nowMs} />
				{behindCommits.length > 0 && (
					<ul className="notif-commits">
						{behindCommits.map((c) => (
							<li key={c}>{c}</li>
						))}
					</ul>
				)}
			</div>
		)
	);
}

/** The host owns the schedule. A missing view also covers an expired host lease. */
export function UpdateCycleControl({
	cycle,
	nowMs,
}: {
	cycle: UpdateCycleView | null;
	nowMs: number;
}) {
	const [requested, setRequested] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const request = useRef(false);
	useEffect(() => {
		if (cycle === null) setError(null);
		if (cycle === null || cycle.phase !== "idle") {
			setRequested(false);
			request.current = false;
		}
	}, [cycle]);
	if (cycle === null) return null;
	const phase = requested ? "requested" : cycle.phase;
	let status = "Update cycle in progress.";
	if (phase === "requested") status = "Update requested. Wait for the host.";
	else if (phase === "idle") {
		status =
			cycle.nextCycleAt <= nowMs
				? "Next update cycle is due."
				: `Next update cycle in ${duration(cycle.nextCycleAt - nowMs)}.`;
	}
	return (
		<span className="update-cycle">
			<span className="update-cycle-status" role="status">
				{status}
			</span>
			<BusyButton
				disabled={!cycle.canStart || phase !== "idle"}
				title="Fetch commits, build the image, and update Ottr"
				run={async () => {
					if (request.current) return false;
					request.current = true;
					setRequested(true);
					setError(null);
					try {
						await post("/api/update", {});
						refreshState();
						return true;
					} catch (e) {
						request.current = false;
						setRequested(false);
						setError(e instanceof Error ? e.message : String(e));
						return false;
					}
				}}
			>
				Update
			</BusyButton>
			{phase === "idle" && !cycle.canStart && (
				<span>No turn can run or prepare. Wait until all turns finish.</span>
			)}
			{(error ?? cycle.error) !== null && (
				<span className="update-cycle-error" role="alert">
					{error ?? cycle.error} Retry when the host is available.
				</span>
			)}
		</span>
	);
}

/** The notices section: the running notice, the drain hold, the upstream version
 * notice, the restart wait, the failed seed and the failed provision. Null while none
 * applies. */
function AppInfoLines(p: {
	notice: string | null;
	noticeKey: string | null;
	drainNotice: boolean;
	drainKey: string | null;
	drainCommits: string[];
	behind: number;
	behindKey: string | null;
	behindCommits: string[];
	restartWait: RestartWaitView | null;
	restartWaitKey: string | null;
	seedFailed: SeedFailedView | null;
	seedFailKey: string | null;
	provisionError: string | null;
	provisionErrKey: string | null;
	isNew: (key: string) => boolean;
	setNotice: (v: string | null) => void;
	updateCycle: UpdateCycleView | null;
	nowMs: number;
}) {
	const {
		notice,
		noticeKey,
		drainNotice,
		drainKey,
		drainCommits,
		behind,
		behindKey,
		behindCommits,
		restartWait,
		restartWaitKey,
		seedFailed,
		seedFailKey,
		provisionError,
		provisionErrKey,
		isNew,
		setNotice,
	} = p;
	const showRestartControl = behind <= 0 && restartWait !== null;
	if (
		!(
			notice !== null ||
			behind > 0 ||
			drainNotice ||
			restartWait !== null ||
			seedFailed !== null ||
			provisionError !== null
		)
	)
		return null;
	return (
		<section>
			<h2>Notices</h2>
			{notice !== null && (
				<p className="notif-line" data-inbox-key={noticeKey ?? undefined}>
					<Icon name="info" size={16} />
					<span>{notice}</span>
					{noticeKey !== null && isNew(noticeKey) && (
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
			{drainNotice && (
				<>
					<p className="notif-line" data-inbox-key={drainKey ?? undefined}>
						<Icon name="info" size={16} />
						<span>
							An Ottr update is ready. New turns wait until the running turns
							finish and Ottr restarts.
						</span>
						{drainKey !== null && isNew(drainKey) && (
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
			<AppBehindNotice
				behind={behind}
				behindKey={behindKey}
				behindCommits={behindCommits}
				isNew={isNew}
				updateCycle={p.updateCycle}
				nowMs={p.nowMs}
			/>
			<RestartWaitLine
				wait={restartWait}
				inboxKey={restartWaitKey ?? undefined}
				fresh={restartWaitKey !== null && isNew(restartWaitKey)}
			/>
			{showRestartControl && (
				<div className="update-cycle-restart">
					<UpdateCycleControl cycle={p.updateCycle} nowMs={p.nowMs} />
				</div>
			)}
			<SeedFailedLine
				fail={seedFailed}
				inboxKey={seedFailKey ?? undefined}
				fresh={seedFailKey !== null && isNew(seedFailKey)}
			/>
			<ProvisionErrorLine
				error={provisionError}
				inboxKey={provisionErrKey ?? undefined}
				fresh={provisionErrKey !== null && isNew(provisionErrKey)}
			/>
		</section>
	);
}

/** The kept-worktree backlog line: cancelled cards still holding a worktree, each named
 * with a link into its card. */
function AppKeptNotice(p: {
	keptCount: StateResponse["keptWorktrees"];
	keptKey: string | null;
	openTask: (id: string) => void;
	isNew: (key: string) => boolean;
}) {
	const { keptCount, keptKey, openTask, isNew } = p;
	const cards = keptCount.cards ?? [];
	return (
		keptCount.held > 0 && (
			<p className="notif-line" data-inbox-key={keptKey ?? undefined}>
				<Icon name="info" size={16} />
				<span>
					{keptCount.held} cancelled card
					{keptCount.held === 1 ? "" : "s"} still hold
					{keptCount.held === 1 ? "s" : ""} a worktree
					{keptCount.stale > 0
						? `, ${keptCount.stale} past the quarantine threshold`
						: ""}
					{cards.map((id, i) => (
						<Fragment key={id}>
							{i === 0 && ": "}
							{i > 0 && ", "}
							<button
								type="button"
								className="notif-link"
								title={`Open card ${id}`}
								onClick={() => {
									// Navigation rows leave the panel: hiding first keeps the
									// drawer unobstructed, like the alarm rows above.
									document.getElementById("inbox")?.hidePopover();
									openTask(id);
								}}
							>
								{id}
							</button>
						</Fragment>
					))}
					.
				</span>
				{keptKey !== null && isNew(keptKey) && (
					<span className="new-tag">New</span>
				)}
			</p>
		)
	);
}

/** The advisories section: orphan agent processes, the kept-worktree backlog, an
 * alate import that has waited too long, and disabled provider sign-ins. The tracker
 * reports them; it never kills processes, deletes worktrees, or runs provisioning on
 * its own. Null while none applies. */
function AppAdvisoryLines(p: {
	state: StateResponse | null;
	warnings: string[];
	orphanList: OrphanProcess[];
	orphansError: string | null;
	orphansErrorKey: string | null;
	orphansKey: string | null;
	keptCount: StateResponse["keptWorktrees"];
	keptKey: string | null;
	alatePendingKey: string | null;
	signinAdvisories: DeadSignIn[];
	nowMs: number;
	openTask: (id: string) => void;
	isNew: (key: string) => boolean;
}) {
	const {
		state,
		warnings,
		orphanList,
		orphansError,
		orphansErrorKey,
		orphansKey,
		keptCount,
		keptKey,
		alatePendingKey,
		signinAdvisories,
		nowMs,
		openTask,
		isNew,
	} = p;
	if (
		state === null ||
		(orphanList.length === 0 &&
			keptCount.held === 0 &&
			orphansError === null &&
			alatePendingKey === null &&
			signinAdvisories.length === 0 &&
			warnings.length === 0)
	)
		return null;
	return (
		<section>
			<h2>Advisories</h2>
			<WarningLines warnings={warnings} />
			{orphansError !== null && (
				<p className="notif-line" data-inbox-key={orphansErrorKey ?? undefined}>
					<Icon name="info" size={16} />
					<span>
						Orphan scan failed: {orphansError} — the agent process list may be
						empty because no scan succeeded.
					</span>
					{orphansErrorKey !== null && isNew(orphansErrorKey) && (
						<span className="new-tag">New</span>
					)}
				</p>
			)}
			{orphanList.length > 0 && (
				<OrphanNotice
					orphans={orphanList}
					fresh={orphansKey !== null && isNew(orphansKey)}
					nowMs={nowMs}
					openTask={openTask}
					inboxKey={orphansKey ?? undefined}
				/>
			)}
			<AppKeptNotice
				keptCount={keptCount}
				keptKey={keptKey}
				openTask={openTask}
				isNew={isNew}
			/>
			{alatePendingKey !== null && (
				<p className="notif-line" data-inbox-key={alatePendingKey}>
					<Icon name="info" size={16} />
					<span>
						Alate is waiting to provision an import.{" "}
						<button
							type="button"
							className="notif-link"
							onClick={() => openSettingsSection("alate-section")}
						>
							Open settings
						</button>
					</span>
					{isNew(alatePendingKey) && <span className="new-tag">New</span>}
				</p>
			)}
			{signinAdvisories.map((d) => (
				<p
					className="notif-line"
					key={`signin:${d.provider}`}
					data-inbox-key={`signin:${d.provider}`}
				>
					<Icon name="info" size={16} />
					<span>
						{d.provider}'s sign-in is disabled — {d.cause}. Used by the{" "}
						{d.roles.join(", ")} model role{d.roles.length === 1 ? "" : "s"}.{" "}
						<button
							type="button"
							className="notif-link"
							onClick={() => openSettingsSection("signin-section")}
						>
							Open settings
						</button>
					</span>
					{isNew(`signin:${d.provider}`) && (
						<span className="new-tag">New</span>
					)}
				</p>
			))}
		</section>
	);
}

/** The bar's rail fold button: a click shortcut for the "[" keyboard fold. */
function AppRailToggle({
	railCollapsed,
	toggleRail,
}: {
	railCollapsed: boolean;
	toggleRail: () => void;
}) {
	return (
		<button
			type="button"
			className="icon rail-toggle"
			aria-expanded={!railCollapsed}
			aria-keyshortcuts="["
			aria-label={railCollapsed ? "Expand the sidebar" : "Collapse the sidebar"}
			title={`${railCollapsed ? "Expand" : "Collapse"} the sidebar ([)`}
			onClick={toggleRail}
		>
			<Icon name="panel-left" />
		</button>
	);
}

/** The account menu (rail chip on phones, bar button everywhere): identity, settings
 * link, theme radios, sign out. */
function AppUserMenu({
	hosted,
	state,
	theme,
	setTheme,
	sysLight,
	navigate,
	act,
}: {
	hosted: boolean;
	state: StateResponse | null;
	theme: Theme;
	setTheme: (t: Theme) => void;
	sysLight: boolean;
	navigate: (path: string) => void;
	act: Act;
}) {
	return (
		<div id="user-menu" popover="auto" className="user-menu">
			{!hosted && (
				<p className="menu-who">
					{state?.user == null
						? "Local access, no login"
						: `Signed in as ${state.user}`}
				</p>
			)}
			<a
				className="menu-row"
				href={settingsPath(null)}
				onClick={(e) => {
					navClick(e, navigate);
					document.getElementById("user-menu")?.hidePopover();
				}}
			>
				<Icon name="gear" size={14} />
				Settings
			</a>
			{/* Phones only: the bar has no room for the theme button there. */}
			<fieldset className="menu-theme">
				<legend className="sr">Theme</legend>
				<hr />
				{THEME_ORDER.map((t) => (
					<button
						key={t}
						type="button"
						className="menu-row"
						aria-pressed={theme === t}
						onClick={() => setTheme(t)}
					>
						<Icon name={THEME_META[t].icon} size={14} />
						{t === "system"
							? `${THEME_META[t].label} (${THEME_META[sysLight ? "light" : "dark"].label})`
							: THEME_META[t].label}
						{theme === t && <Icon name="check" size={14} />}
					</button>
				))}
			</fieldset>
			{state?.user != null && !hosted && (
				<>
					<hr />
					<button
						type="button"
						className="menu-row"
						// act surfaces a failed POST as an error; only a confirmed logout reloads.
						onClick={() => void act(logOut)}
					>
						<Icon name="log-out" size={14} />
						Sign out
					</button>
				</>
			)}
		</div>
	);
}

/** The board's main pane: skeleton while loading, then the Settings/System/Overview/
 * project view the URL asks for. */
function AppMainContent(p: {
	state: StateResponse | null;
	view: string;
	hosted: boolean;
	settingsRoute: { onSettings: boolean; project: string | null };
	onSystem: boolean;
	project: ProjectView | null;
	projects: ProjectView[];
	tasks: TaskCard[];
	seenAnswers: Set<string>;
	/** The server's done baseline; the unread rule reads it (OTTR-827). */
	seenDoneSince: number;
	deltas: Map<string, number>;
	act: Act;
	openTask: (id: string) => void;
	navigate: (path: string) => void;
	setComposeFor: (v: string | null) => void;
	setDraftFor: (v: string | null) => void;
	setNotice: (v: string | null) => void;
	setShowAdd: (v: boolean) => void;
	draining: boolean;
	tick: number;
	/** The provisioning poll App owns; the Overview Setup panel and the skill-gap markers read it. */
	prov: { data: ProvisioningResponse | null; err: string | null };
}) {
	const {
		state,
		view,
		hosted,
		settingsRoute,
		onSystem,
		project,
		projects,
		tasks,
		seenAnswers,
		seenDoneSince,
		deltas,
		act,
		openTask,
		navigate,
		setComposeFor,
		setDraftFor,
		setNotice,
		setShowAdd,
		draining,
		tick,
		prov,
	} = p;
	return state === null ? (
		<Skeleton shape="list" rows={6} label="Loading the board" />
	) : settingsRoute.onSettings ? (
		<SettingsPage
			projects={projects}
			tasks={tasks}
			maxTotal={state.maxTotal}
			reviewCheck={state.reviewCheck}
			workCheck={state.workCheck}
			idleReviews={state.idleReviews}
			trendingScan={state.trendingScan}
			commitIdentity={state.commitIdentity}
			trendingStatus={state.trendingStatus}
			act={act}
			view={view}
			openTask={openTask}
			hosted={hosted}
		/>
	) : onSystem ? (
		<SystemView state={state} openTask={openTask} />
	) : project === null ? (
		<Overview
			projects={projects}
			tasks={tasks}
			compose={setComposeFor}
			onAdd={() => setShowAdd(true)}
			openTask={openTask}
			navigate={navigate}
			prov={prov}
		/>
	) : (
		<ProjectBoard
			key={project.name}
			project={project}
			tasks={tasks.filter((t) => t.project === project.name)}
			foreignDeps={depIndexOf(projects, tasks, project)}
			deltas={deltas}
			open={openTask}
			seenAnswers={seenAnswers}
			seenDoneSince={seenDoneSince}
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
			tick={tick}
			userLayer={prov.data?.userLayer ?? null}
		/>
	);
}

/** The task drawer and its frozen exit sheet: mounted only while a card and its
 * project are selected. */
function AppDrawer(p: {
	selected: TaskCard | null;
	selectedProject: ProjectView | null;
	sheet: { task: TaskCard; project: ProjectView } | null;
	state: StateResponse | null;
	projects: ProjectView[];
	tasks: TaskCard[];
	deltas: Map<string, number>;
	draining: boolean;
	usedTotal: number;
	seenAnswers: ReadonlySet<string>;
	origin: React.RefObject<{ id: string; from: string } | null>;
	act: Act;
	openTask: (id: string) => void;
	markRead: (t: TaskCard | null | undefined) => void;
	markUnread: (t: TaskCard | null | undefined) => void;
	closeDrawer: () => void;
	/** The server's done baseline; the drawer's read state reads it (OTTR-827). */
	seenDoneSince: number;
}) {
	const {
		selected,
		selectedProject,
		sheet,
		state,
		projects,
		tasks,
		deltas,
		draining,
		usedTotal,
		seenAnswers,
		origin,
		act,
		openTask,
		markRead,
		markUnread,
		closeDrawer,
		seenDoneSince,
	} = p;
	// While open, the drawer renders the live selection; on a close (X, Esc, backdrop,
	// Back, mark-unread) it freezes into `sheet` so the dialog can animate out mounted.
	const drawerTask = selected ?? sheet?.task ?? null;
	const drawerProject = selectedProject ?? sheet?.project ?? null;
	if (drawerTask === null || drawerProject === null) return null;
	// The drawer's context: the project's cards plus the cross-project links the
	// lineage rail resolves (OTTR-787) — the drawer card's foreign parent, that
	// parent's own source (a retro's source card), the drawer card's foreign
	// children, and a foreign proposal whose retro is this card or a retro filed
	// off it. The source card's drawer nests such a proposal under its retro, and
	// the proposal's drawer links the retro and the source instead of a bare id.
	const linkedParent =
		drawerTask.followUpOf !== null && drawerTask.followUpOfProject !== null
			? (tasks.find(
					(t) =>
						t.id === drawerTask.followUpOf &&
						t.project === drawerTask.followUpOfProject,
				) ?? null)
			: null;
	const drawerTasks = tasks.filter(
		(t) =>
			t.project === drawerProject.name ||
			(drawerTask.followUpOf !== null &&
				drawerTask.followUpOfProject !== null &&
				t.id === drawerTask.followUpOf &&
				t.project === drawerTask.followUpOfProject) ||
			(linkedParent !== null &&
				linkedParent.followUpOf !== null &&
				t.id === linkedParent.followUpOf &&
				t.project ===
					(linkedParent.followUpOfProject ?? linkedParent.project)) ||
			(t.followUpOf === drawerTask.id &&
				t.followUpOfProject === drawerTask.project) ||
			(t.followUpOfProject === drawerTask.project &&
				tasks.some(
					(x) =>
						x.id === t.followUpOf &&
						x.project === drawerProject.name &&
						(x.id === drawerTask.id ||
							(x.kind === "retro" && x.followUpOf === drawerTask.id)),
				)),
	);
	return (
		<Drawer
			key={drawerTask.id}
			open={selected !== null}
			task={drawerTask}
			project={drawerProject}
			projects={projects}
			delta={deltas.get(drawerTask.id)}
			tasks={drawerTasks}
			onOpenTask={openTask}
			draining={draining}
			usedTotal={usedTotal}
			maxTotal={state?.maxTotal ?? null}
			act={act}
			// OTTR-827: `read` doubles as the reverse action's offer — a card the
			// baseline reads has no removable marks, so the drawer hides the control.
			read={
				seenable(drawerTask) &&
				!isUnread(drawerTask, seenAnswers, seenDoneSince) &&
				canMarkUnread(drawerTask, seenDoneSince)
			}
			onMarkUnread={() => {
				if (selected === null) return; // the deferred native close after an app-driven close
				void markUnread(selected);
				closeDrawer(); // close so the board shows the card unread; onClose would re-mark it read
			}}
			onMarkSeen={() => {
				if (selected !== null) markRead(selected);
			}}
			onClose={() => {
				if (selected === null) return; // same deferred close; do not re-mark it read
				// An answer that landed while the drawer was open counts as read.
				if (autoMarkOnOpen(selected)) markRead(selected);
				closeDrawer();
			}}
			onFollowed={(id, from) => {
				origin.current = { id, from };
				closeDrawer(); // close the drawer so the board shows the follow-up fly in
			}}
		/>
	);
}

/** Board-level overlays: the add-project modal, the upstream-updates panel and the
 * offline banner. */
function AppOverlays(p: {
	showAdd: boolean;
	showUpdates: boolean;
	offline: boolean;
	state: StateResponse | null;
	tasks: TaskCard[];
	act: Act;
	openTask: (id: string) => void;
	setShowAdd: (v: boolean) => void;
	setShowUpdates: (v: boolean) => void;
	setNotice: (v: string | null) => void;
}) {
	const {
		showAdd,
		showUpdates,
		offline,
		state,
		tasks,
		act,
		openTask,
		setShowAdd,
		setShowUpdates,
		setNotice,
	} = p;
	return (
		<>
			{showAdd && (
				<AddProjectModal
					act={act}
					projects={state?.projects ?? []}
					onClose={() => setShowAdd(false)}
					onAdded={(i) => setNotice(interviewMsg(i))}
					openTask={openTask}
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

/** The whole board. Exported for the DOM tests; index.html is its only real consumer. */
export function App() {
	// One-time client migration: an old hash URL becomes its path URL before the first
	// readPath(), so the initial view and card come from the pathname.
	migrateHash();
	const [state, setState] = useState<StateResponse | null>(null);
	const [view, setView] = useState(readPath().view);
	const [showAdd, setShowAdd] = useState(false);
	const [showUpdates, setShowUpdates] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(
		() => readPath().task,
	);
	/** Cards with something to read (answers, PR reviews) that the user has opened; the unread badge on done cards reads its absence. Starts empty; the server owns the set. */
	const [seenAnswers, setSeenAnswers] = useState(() => new Set<string>());
	/** Done-read keys whose auto-mark POST failed; the read-mark effect must not re-post them in a loop. */
	const failedDoneReads = useRef<ReadonlySet<string>>(new Set());
	/** OTTR-566: the server's baseline; done cards with doneAt at or before it count as read. Infinity until the first frame so nothing flashes unread. */
	const [seenDoneSince, setSeenDoneSince] = useState(Number.POSITIVE_INFINITY);
	/** One-shot localStorage → server migration of seen answers, run after the first state load. */
	const migratedSeen = useRef(false);
	// Hoisted above markRead/openTask: openTask looks cards up here, and a plain const is not a hook, so order with the useState lines is free.
	const tasks = state?.tasks ?? [];
	// U6: rows an open (non-done, non-cancelled) update card already carries are not pending for the user.
	const coveredUpdates = coveredUpdateIds(tasks);
	/** OTTR-827: marks a card read — the plain id always, and (OTTR-566) the completion key
	 * `id@doneAt` beside it for a done work card, so the face badge and the rail dot clear
	 * together. A failed POST rolls both keys back and records them as failed; the failed set
	 * silences only the automatic effect, so an explicit user action can always retry. */
	const markRead = useCallback(
		(t: TaskCard | null | undefined, automatic = false) => {
			if (t == null || !seenable(t)) return;
			const keys = [t.id];
			if (t.doneAt !== null && doneReadable(t, seenDoneSince))
				keys.push(doneReadKey({ id: t.id, doneAt: t.doneAt }));
			// The failed set only silences the automatic read-mark effect: one failed
			// POST must never wedge a card. An explicit user action always retries,
			// and its success clears the failure so the effect resumes.
			if (automatic && keys.every((k) => failedDoneReads.current.has(k)))
				return;
			setSeenAnswers((s) => {
				if (keys.every((k) => s.has(k))) return s;
				const next = new Set(s);
				for (const k of keys) next.add(k);
				return next;
			});
			void post("/api/seen", { ids: keys })
				.then(() => {
					failedDoneReads.current = new Set(
						[...failedDoneReads.current].filter((k) => !keys.includes(k)),
					);
				})
				.catch(() => {
					// Roll the optimistic marks back: the card reads as unread again.
					failedDoneReads.current = new Set([
						...failedDoneReads.current,
						...keys,
					]);
					setSeenAnswers((s) => {
						if (!keys.some((k) => s.has(k))) return s;
						const next = new Set(s);
						for (const k of keys) next.delete(k);
						return next;
					});
					setNotice(
						"Saving the read state failed; this card may show as unread on your other devices.",
					);
				});
		},
		[seenDoneSince],
	);
	/** The reverse of markRead: puts a read card back to unread, locally and on the server. A
	 * done card's completion key goes too, or the rail would stay read while the face shows New. */
	const markUnread = useCallback((t: TaskCard | null | undefined) => {
		if (t == null || !seenable(t)) return;
		const keys =
			t.stage === "done" && t.doneAt !== null
				? [t.id, doneReadKey({ id: t.id, doneAt: t.doneAt })]
				: [t.id];
		setSeenAnswers((s) => {
			if (!keys.some((k) => s.has(k))) return s;
			const next = new Set(s);
			for (const k of keys) next.delete(k);
			return next;
		});
		void post("/api/seen", { ids: keys, unread: true }).catch(() => {
			// Roll the optimistic unmark back: the answer reads as read again.
			setSeenAnswers((s) => {
				if (keys.every((k) => s.has(k))) return s;
				const next = new Set(s);
				for (const k of keys) next.add(k);
				return next;
			});
			setNotice(
				"Saving the read state failed; this card may show as read on your other devices.",
			);
		});
	}, []);
	const openTask = useCallback(
		(id: string) => {
			// Every card open is one history entry, so Back returns to the previous card
			// (e.g. child → parent → child) before it leaves the page. The URL names the
			// card: /projects/<project>/tasks/<id>, and the board follows the URL: a card
			// of another project selects that project first, so header, rail, lanes and
			// drawer always agree (OTTR-487). Closing the drawer then stays on that
			// project. The same value is a no-op: a current-project open changes nothing.
			const card = tasks.find((t) => t.id === id);
			if (card === undefined) {
				history.pushState({ ompTask: id }, "", location.pathname);
			} else {
				history.pushState({ ompTask: id }, "", taskPath(card.project, id));
				setView(card.project);
			}
			setSelectedId(id);
			if (card !== undefined && autoMarkOnOpen(card)) markRead(card);
		},
		[tasks, markRead],
	);
	/** Plain-click navigation for the view links: pushes the path and swaps the view. The
	 * drawer selection stays untouched, like the hashchange listener did. */
	const navigate = useCallback((path: string) => {
		history.pushState(null, "", path);
		setView(readPath().view);
	}, []);
	/** The explicit drawer close (X, Esc, backdrop): rewrites the current entry to the view's
	 * URL without a card. replaceState never adds an entry, so Back keeps walking cards. */
	const closeDrawer = useCallback(() => {
		setSelectedId(null);
		history.replaceState(null, "", viewPath(view));
	}, [view]);
	const [composeFor, setComposeFor] = useState<string | null>(null);
	const [draftFor, setDraftFor] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [offline, setOffline] = useState(false);
	/** Inbox keys acknowledged in this tab since the last state frame (optimistic, cleared per frame). */
	const [ackLocal, setAckLocal] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	/** Bumped every 30 s so relative ages re-render; the memoized cards read it as their tick. */
	const [clockTick, setClockTick] = useState(0);
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
	/** Hosted mode from /api/boot, known before the first state frame (docs/specs/hosted-mode.md). */
	const [bootHosted, setBootHosted] = useState(false);
	// The desktop rail folds to its icons; the choice survives reloads.
	const [railCollapsed, setRailCollapsed] = useState(
		() => localStorage.getItem("ottr.rail.collapsed") === "1",
	);
	const toggleRail = useCallback(
		(): void =>
			setRailCollapsed((c) => {
				localStorage.setItem("ottr.rail.collapsed", c ? "0" : "1");
				return !c;
			}),
		[],
	);
	// "[" folds the rail (Linear's key), except while typing or with a modifier held.
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key !== "[" || e.ctrlKey || e.metaKey || e.altKey) return;
			const t = e.target as HTMLElement | null;
			if (t?.closest("input, textarea, select, [contenteditable]")) return;
			toggleRail();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [toggleRail]);
	const [live, setLive] = useState<boolean | null>(null);
	useEffect(() => {
		void fetch("/api/boot")
			.then(
				(r) =>
					r.json() as Promise<{
						onboarding: boolean;
						version: string;
						live: boolean;
						hosted?: boolean;
					}>,
			)
			.then((b) => {
				setBootVersion(b.version);
				setLive(b.live);
				// Hosted mode: the proxy owns identity, so the board shows no setup or login page.
				if (b.hosted === true) setBootHosted(true);
				else if (b.onboarding) setGate("setup");
				else if (localStorage.getItem(LOGOUT_KEY) !== null) setGate("login");
				// A lost session needs no boot probe of its own: the poll's failed
				// /api/state (or the live socket's refusal) reaches onOffline with the
				// status and gates the board.
			})
			.catch(() => {
				// unreachable server: poll mode self-heals via its own 5 s poll
				setLive(false);
			});
	}, []);

	/** Shared inbox acknowledgement: optimistic until the next state frame brings the server's list. */
	const ackInbox = useCallback((keys: string[]) => {
		setAckLocal((p) => new Set([...p, ...keys]));
		void post("/api/inbox/seen", { keys }).catch(() => {});
	}, []);
	// Clicking an inbox row (or a link or button inside it) acknowledges that entry.
	useEffect(() => {
		const onClick = (e: MouseEvent): void => {
			const row = (e.target as Element | null)?.closest<HTMLElement>(
				"#inbox [data-inbox-key]",
			);
			const key = row?.dataset.inboxKey;
			if (key !== undefined && key !== "") ackInbox([key]);
		};
		document.addEventListener("click", onClick);
		return () => document.removeEventListener("click", onClick);
	}, [ackInbox]);
	// Opening a card's drawer acknowledges its entries, once per selection.
	useEffect(() => {
		if (selectedId === null) return;
		void post("/api/inbox/seen", { taskIds: [selectedId] }).catch(() => {});
	}, [selectedId]);
	// Focus heartbeat: the server holds OS pushes while any board tab is focused, so a user
	// looking at the board is never pinged on the same machine.
	useEffect(() => {
		// randomUUID needs a secure context; a plain-HTTP LAN tab still needs a unique id.
		const tab =
			typeof crypto.randomUUID === "function"
				? crypto.randomUUID()
				: `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		let timer: number | null = null;
		const send = (focused: boolean): void => {
			void fetch("/api/presence", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ tab, focused }),
				// The unfocus beat must survive the page unloading.
				keepalive: !focused,
			}).catch(() => {});
		};
		const sync = (): void => {
			if (document.visibilityState === "visible" && document.hasFocus()) {
				send(true);
				timer ??= window.setInterval(() => send(true), 20_000);
			} else if (timer !== null) {
				clearInterval(timer);
				timer = null;
				send(false);
			}
		};
		const leave = (): void => {
			clearInterval(timer ?? undefined);
			timer = null;
			send(false);
		};
		sync();
		window.addEventListener("focus", sync);
		window.addEventListener("blur", sync);
		document.addEventListener("visibilitychange", sync);
		window.addEventListener("pagehide", leave);
		return () => {
			window.removeEventListener("focus", sync);
			window.removeEventListener("blur", sync);
			document.removeEventListener("visibilitychange", sync);
			window.removeEventListener("pagehide", leave);
			leave();
		};
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
	const applied = theme === "system" ? (sysLight ? "light" : "dark") : theme;
	const themeName = `Theme: ${THEME_META[applied].label}${theme === "system" ? " (match system)" : ""}`;

	// Back/Forward walk the entries pushState()d by openTask and the view links; both the
	// view and the drawer follow the entry. A vanished card id self-cleans: the drawer only
	// renders a task the current state still lists. The explicit close (X, Esc, backdrop)
	// only drops the selection: it must not traverse, or closing the parent of a child →
	// parent walk would pop to the child's entry and reopen it instead of closing.
	useEffect(() => {
		const onPop = (e: PopStateEvent): void => {
			const path = readPath();
			setView(path.view);
			setSelectedId(historyTask(e.state, path.task));
		};
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, []);

	// One push-only socket per tab: state, update banner and System snapshots all arrive over it.
	useEffect(() => {
		if (live === null) return; // boot hasn't answered yet
		const h = {
			onState: (s: StateResponse) => {
				// Unchanged cards keep their previous object (reuseCards), so the memoized
				// cards skip their render and only the changed card redraws.
				setState((prev) => reuseCards(prev, s));
				// The frame carries the server's seen list, which now includes (or settled) every ack sent before it.
				setAckLocal(new Set());
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
				setSeenDoneSince(s.seenDoneSince);
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
			// A dead socket cannot show the HTTP status, so live mode asks once per drop: an
			// expired or revoked session lands on the login page instead of an endless
			// "Retrying…". Polling always carries the failed /api/state's status here —
			// 0 on a transport failure, which cannot be a session loss — so it never refetches.
			onOffline: (status?: number) => {
				setOffline(true);
				if (status !== undefined) {
					if (sessionLost(status)) setGate(gateAfterLostSession);
					return;
				}
				void fetch("/api/state")
					.then((r) => {
						if (sessionLost(r.status)) setGate(gateAfterLostSession);
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
	/** The last frame the FLIP effect measured: its id:stage signature and path. A frame whose
	 * cards sit in the same stages at the same path cannot fly a card between lanes. */
	const flipKey = useRef<{ sig: string; path: string }>({ sig: "", path: "" });
	/** Every task id seen so far; a task missing here was just created and gets an entrance. */
	const seenIds = useRef<Set<string> | null>(null);
	/** A follow-up awaiting its first board render: { id: the new task, from: the done task it continues. } */
	const origin = useRef<{ id: string; from: string } | null>(null);
	useLayoutEffect(() => {
		if (state === null) return;
		// Skip the document-wide rect scan when no id or stage changed (an unchanged card's
		// push, the clock tick's siblings); the entrance and flight animations all need one of
		// the two. A path change remeasures, because another board's DOM sits where the last
		// scan measured.
		const sig = boardFlipSig(state.tasks);
		const path = location.pathname;
		if (sig === flipKey.current.sig && path === flipKey.current.path) return;
		flipKey.current = { sig, path };
		const prev = cardPos.current;
		const { next, els } = measureCards();
		cardPos.current = next;
		const fresh = freshTaskIds(seenIds.current, state.tasks);
		seenIds.current = new Set(state.tasks.map((t) => t.id));
		const flights = stageFlights(prev, next);
		// A fresh follow-up starts where its done parent sits, so it visibly grows out of that card.
		applyOriginFlight(origin, flights, els, prev, next);
		animateBoardChanges(els, flights, fresh);
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
	const {
		hosted,
		onSystem,
		project,
		settingsRoute,
		overviewCurrent,
		selected,
		selectedProject,
	} = appViewSelection(state, view, projects, selectedId, tasks, bootHosted);
	// Hosted mode: Alate, provisioning and the workers are the operator's, so no probe runs
	// and the user layer stays unknown (the skill-gap markers stay out). The gate waits for
	// the first state frame: `hosted` is false before it lands, and a mount-time fetch would
	// probe in hosted mode before the flag arrives.
	const prov = useProvisioning(state !== null && !hosted);
	const boardNote = skillGapNote(prov.data?.userLayer ?? null, "board-check");
	// OTTR-566/OTTR-827: an open drawer is the read event for a card the user is looking
	// at, whatever opened it (a card click, a pasted/deep-link URL, or the task finishing
	// while its drawer is open). A steps report stays pinned: only its drawer buttons
	// clear it, so the effect marks nothing there. isUnread checks seenAnswers, so a mark
	// already made is not posted again.
	useEffect(() => {
		if (
			selected !== null &&
			autoMarkOnOpen(selected) &&
			isUnread(selected, seenAnswers, seenDoneSince)
		)
			markRead(selected, true);
	}, [selected, seenAnswers, seenDoneSince, markRead]);
	/** The drawer task+project a close froze; held while the exit animation plays, then dropped. */
	const [sheet, setSheet] = useState<{
		task: TaskCard;
		project: ProjectView;
	} | null>(null);
	// While open, the drawer renders the live selection; on a close (X, Esc, backdrop,
	// Back, mark-unread) it freezes into `sheet` so the dialog can animate out mounted.
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
	// One split for the bell, the popover groups and the counts (shared with the rail rows/Overview).
	const { needs: needTasks, asks: askCards } = splitAlarms(tasks);
	// Projects with PR review notifications off show no PR rows in the bell.
	const prQuiet = (t: TaskCard): boolean =>
		t.kind === "pr_review" &&
		projects.find((p) => p.name === t.project)?.settings.prReviewNotify ===
			false;
	const needsShown = needTasks.filter((t) => !prQuiet(t));
	const prActivity = tasks.filter(
		(t) =>
			t.kind === "pr_review" && t.prOccurrence?.comments != null && !prQuiet(t),
	);
	const alarmLine = alarmLabel(
		needsShown.length,
		askCards.length,
		prActivity.length,
	);
	const alarmCount = needsShown.length + askCards.length + prActivity.length;
	const {
		draining,
		drainCommits,
		warnings,
		orphanList,
		orphansError,
		keptCount,
	} = appServerNotices(state);
	const { behind, behindCommits, restartWait, seedFailed, signinAdvisories } =
		appUpdateNotices(hosted, update, state);
	// Occurrence keys of the inbox entries; null when the source is absent. shortKey hashes a
	// long body (an error text, an id list), so no key outgrows the seen route's limit.
	const nowMs = Date.now();
	const {
		updateCount,
		critKey,
		noticeKey,
		drainNotice,
		drainKey,
		behindKey,
		restartWaitKey,
		seedFailKey,
		provisionErrKey,
		updatesKey,
		orphansErrorKey,
		orphansKey,
		keptKey,
		alatePendingKey,
	} = appNoticeKeys(
		state,
		coveredUpdates,
		error,
		notice,
		hosted,
		behind,
		restartWait,
		seedFailed,
		draining,
		orphanList,
		orphansError,
		keptCount,
		nowMs,
	);
	// One inbox entry per panel row, most urgent first; the bell and the New chips read it.
	const infoKeys = [
		updatesKey,
		noticeKey,
		drainKey,
		behindKey,
		restartWaitKey,
		seedFailKey,
		provisionErrKey,
		orphansErrorKey,
		orphansKey,
		keptKey,
		alatePendingKey,
		...signinAdvisories.map((d) => `signin:${d.provider}` as const),
	];
	const { inboxSeen, entries, inbox, inboxSig, inboxTitle, inboxName } =
		appInboxMeta(
			state,
			ackLocal,
			error,
			critKey,
			needsShown,
			askCards,
			prActivity,
			infoKeys,
			warnings,
			alarmCount,
			alarmLine,
		);
	/** "New" = not acknowledged yet. */
	const isNew = (key: string): boolean => !inboxSeen.has(key);
	const updateLoaded = update !== null;

	// The server prunes task-derived keys (task:, done:, error:) itself; the client drops the
	// rest once their cause cleared, so a recurrence counts as new. crit: and notice: entries
	// live in one tab only: another tab's absence proves nothing, so a tab drops only the
	// browser-local keys it showed itself and then lost. Runs once per entry signature.
	const serverSeen = state?.inboxSeen;
	const prunedSig = useRef<string | null>(null);
	const localShown = useRef(new Set<string>());
	useEffect(() => {
		if (serverSeen === undefined) return;
		const sig = `${updateLoaded}:${inboxSig}`;
		if (prunedSig.current === sig) return;
		prunedSig.current = sig;
		const drop = seenToDrop(
			serverSeen,
			new Set(JSON.parse(inboxSig) as string[]),
			localShown.current,
			updateLoaded,
		);
		if (drop.length > 0) void post("/api/inbox/seen", { drop }).catch(() => {});
	}, [inboxSig, serverSeen, updateLoaded]);

	// N opens New task for the open project; inert while typing or any modal is up.
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (
				shortcutInert(
					e,
					"n",
					composeFor !== null || selectedId !== null || showAdd,
				)
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
			if (
				shortcutInert(
					e,
					"b",
					draftFor !== null ||
						composeFor !== null ||
						selectedId !== null ||
						showAdd,
				)
			)
				return;
			if (project === null || project.gitless) return;
			e.preventDefault();
			setDraftFor(project.name);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [project, draftFor, composeFor, selectedId, showAdd]);

	// The gate is a full page, not an overlay: no board renders behind it. Hosted mode has no
	// login page: the proxy owns identity, so a lost session leaves the offline banner only.
	if (gate !== null && !hosted)
		return <AuthPage mode={gate} version={bootVersion} />;

	return (
		<HostedContext.Provider value={hosted}>
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
					<RailRows
						projects={projects}
						tasks={tasks}
						seenAnswers={seenAnswers}
						seenDoneSince={seenDoneSince}
						project={project}
						overviewCurrent={overviewCurrent}
						systemCurrent={onSystem}
						hosted={hosted}
						version={bootVersion}
						collapsed={false}
						navigate={navigate}
						onAdd={() => setShowAdd(true)}
						onPick={() => document.getElementById("areas-pop")?.hidePopover()}
					/>
				</div>
				<AppRailToggle railCollapsed={railCollapsed} toggleRail={toggleRail} />
				<a className="brand" href="/" aria-label="Ottr home">
					<img src={logo} alt="" />
					<span>Ottr</span>
				</a>
				{state !== null && (
					<SystemBar
						tasks={tasks}
						maxTotal={state.maxTotal}
						quota={state.quota}
						navigate={navigate}
						hosted={hosted}
					/>
				)}
				{checkProject !== null && (
					<>
						<button
							type="button"
							className="icon"
							title={`Check the board with the check-ottr-board skill (dev tool)${boardNote === null ? "" : `. ${boardNote}`}`}
							aria-label={
								boardNote === null
									? "Check the board"
									: `Check the board. ${boardNote}`
							}
							onClick={async () =>
								(await confirmDialog(
									"Check the board? This creates a task that runs an agent over every open card. When a check card is still open, it opens that card instead.",
									{ ok: "Create task" },
								)) &&
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
						{boardNote !== null && <SkillGapMark note={boardNote} />}
					</>
				)}
				<AppInboxBell
					inbox={inbox}
					inboxTitle={inboxTitle}
					inboxName={inboxName}
					loaded={state !== null}
				/>
				<AppInboxPanel
					error={error}
					critKey={critKey}
					needTasks={needsShown}
					askCards={askCards}
					prActivity={prActivity}
					alarmCount={alarmCount}
					updatesKey={updatesKey}
					updateCount={updateCount}
					isNew={isNew}
					notice={notice}
					noticeKey={noticeKey}
					drainNotice={drainNotice}
					drainKey={drainKey}
					drainCommits={drainCommits}
					behind={behind}
					behindKey={behindKey}
					behindCommits={behindCommits}
					restartWait={restartWait}
					restartWaitKey={restartWaitKey}
					seedFailed={seedFailed}
					seedFailKey={seedFailKey}
					provisionError={hosted ? null : (state?.alateProvisionError ?? null)}
					provisionErrKey={provisionErrKey}
					state={state}
					warnings={warnings}
					orphanList={orphanList}
					orphansError={orphansError}
					orphansErrorKey={orphansErrorKey}
					orphansKey={orphansKey}
					keptCount={keptCount}
					keptKey={keptKey}
					alatePendingKey={alatePendingKey}
					signinAdvisories={signinAdvisories}
					projects={projects}
					nowMs={nowMs}
					openTask={openTask}
					entries={entries}
					inbox={inbox}
					ackInbox={ackInbox}
					setShowUpdates={setShowUpdates}
					setError={setError}
					setNotice={setNotice}
				/>
				{/* Desktop keeps theme in the bar; phones reach it through the account menu. */}
				<button
					type="button"
					className="icon bar-theme"
					popoverTarget="theme-pop"
					title={themeName}
					aria-label={themeName}
				>
					{/* The applied theme, also while "Match system" decides it. */}
					<Icon name={THEME_META[applied].icon} />
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
				{/* Phones have no rail: the bar's account chip opens the same account menu. */}
				<button
					type="button"
					className="icon bar-user"
					popoverTarget="user-menu"
					title="Account"
					aria-label={`Account menu, ${state?.user ?? "operator"}`}
				>
					<Icon name="user" />
				</button>
			</header>

			<div
				className="shell"
				data-rail={railCollapsed ? "collapsed" : undefined}
			>
				{/* biome-ignore lint/a11y/useKeyWithClickEvents: a mouse shortcut only; the fold button in the footer is the keyboard path */}
				<nav
					className="areas rail"
					aria-label="Projects"
					data-collapsed={railCollapsed || undefined}
					// A click on the rail's empty space (not on a row or the footer) folds it, like the fold button.
					onClick={(e) => {
						if (e.target === e.currentTarget) toggleRail();
					}}
				>
					<RailRows
						projects={projects}
						tasks={tasks}
						seenAnswers={seenAnswers}
						seenDoneSince={seenDoneSince}
						project={project}
						overviewCurrent={overviewCurrent}
						systemCurrent={onSystem}
						hosted={hosted}
						version={bootVersion}
						collapsed={railCollapsed}
						navigate={navigate}
						onAdd={() => setShowAdd(true)}
					>
						{/* ponytail: placeholder account chip; swap in the user's avatar and name when
				    		    Ottr gets user accounts. */}
						<button
							type="button"
							className="rail-user"
							popoverTarget="user-menu"
							title={railCollapsed ? "Account" : undefined}
							aria-label={`Account menu, ${state?.user ?? "operator"}`}
						>
							<span className="user-chip" aria-hidden="true">
								<Icon name="user" size={15} />
							</span>
							<span className="rail-label">{state?.user ?? "Operator"}</span>
							<span className="rail-user-caret" aria-hidden="true">
								<Icon name="chevron-right" size={12} />
							</span>
						</button>
					</RailRows>
				</nav>
				<AppUserMenu
					hosted={hosted}
					state={state}
					theme={theme}
					setTheme={setTheme}
					sysLight={sysLight}
					navigate={navigate}
					act={act}
				/>

				<main className="main">
					<AppMainContent
						state={state}
						view={view}
						hosted={hosted}
						settingsRoute={settingsRoute}
						onSystem={onSystem}
						project={project}
						projects={projects}
						tasks={tasks}
						seenAnswers={seenAnswers}
						seenDoneSince={seenDoneSince}
						deltas={deltas}
						act={act}
						openTask={openTask}
						navigate={navigate}
						setComposeFor={setComposeFor}
						setDraftFor={setDraftFor}
						setNotice={setNotice}
						setShowAdd={setShowAdd}
						draining={draining}
						tick={clockTick}
						prov={prov}
					/>
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

			<AppDrawer
				selected={selected}
				selectedProject={selectedProject}
				sheet={sheet}
				state={state}
				projects={projects}
				tasks={tasks}
				deltas={deltas}
				draining={draining}
				usedTotal={usedTotal}
				seenAnswers={seenAnswers}
				origin={origin}
				act={act}
				openTask={openTask}
				markRead={markRead}
				markUnread={markUnread}
				closeDrawer={closeDrawer}
				seenDoneSince={seenDoneSince}
			/>

			<AppOverlays
				showAdd={showAdd}
				showUpdates={showUpdates}
				offline={offline}
				state={state}
				tasks={tasks}
				act={act}
				openTask={openTask}
				setShowAdd={setShowAdd}
				setShowUpdates={setShowUpdates}
				setNotice={setNotice}
			/>
		</HostedContext.Provider>
	);
}

// typeof document: true in the browser, false under bun test, so UI render tests
// can import this module without a DOM. (import.meta.main is undefined in a
// browser bundle, so it cannot drive this check.)
if (typeof document !== "undefined") {
	const root = document.getElementById("root");
	if (root !== null) createRoot(root).render(<App />);
}
