import { useEffect, useId, useRef, useState } from "react";
import type {
	JiraImportResult,
	JiraRow,
	JiraSearchResult,
	ProjectView,
} from "../types.ts";
import { CloseButton, Modal, post, projectLabel } from "./kit.tsx";
import { navClick, taskPath } from "./route.ts";

type Stage = "backlog" | "todo";

/** The board header's "Import from Jira" button: only a project with a Jira connection has it. */
export function JiraImportButton({
	project,
	onOpen,
}: {
	project: ProjectView;
	onOpen: () => void;
}) {
	if (project.settings.jiraConnection === null) return null;
	return (
		<button
			type="button"
			title={`Search the Jira connection ${project.settings.jiraConnection} and file tickets as cards`}
			onClick={onOpen}
		>
			Import from Jira
		</button>
	);
}

/** Merges a fresh page into the loaded rows: a key already shown keeps its place (offset
 *  paging can repeat a row when the result set moves between pages). */
const appendRows = (rows: JiraRow[], page: JiraRow[]): JiraRow[] => {
	const seen = new Set(rows.map((r) => r.key));
	return [...rows, ...page.filter((r) => !seen.has(r.key))];
};

/** "Filed N cards", plus the race-skipped count when the server skipped any. */
function importSummary(r: JiraImportResult): string {
	const n = r.filed.length;
	const filed = `Filed ${n} card${n === 1 ? "" : "s"}`;
	return r.skipped.length === 0
		? filed
		: `${filed}. ${r.skipped.length} skipped: already imported`;
}

/**
 * Import from Jira (docs/specs/jira-import.md section 3): a JQL search through the board
 * server, paged with Load more, then one card per selected ticket in Backlog or Todo.
 * Mount it only while it is open: each open starts from the project's last JQL.
 */
export function JiraImportDialog({
	project,
	onClose,
	openTask,
}: {
	project: ProjectView;
	onClose: () => void;
	openTask: (id: string) => void;
}) {
	const base = `/api/projects/${encodeURIComponent(project.name)}/jira`;
	const [jql, setJql] = useState(project.settings.jiraLastJql ?? "");
	// The JQL behind the loaded rows: Load more and the post-import refresh page it, not
	// whatever the field holds now.
	const [query, setQuery] = useState("");
	const [rows, setRows] = useState<JiraRow[] | null>(null);
	const [next, setNext] = useState<string | null>(null);
	const [pages, setPages] = useState(0);
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
	const [stage, setStage] = useState<Stage>("backlog");
	const [busy, setBusy] = useState<"search" | "more" | "import" | null>(null);
	const [note, setNote] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const jqlId = useId();
	const allRef = useRef<HTMLInputElement | null>(null);

	const importable = (rows ?? []).filter((r) => r.importedCard === null);
	const picked = importable.filter((r) => selected.has(r.key)).length;
	const allPicked = importable.length > 0 && picked === importable.length;
	useEffect(() => {
		if (allRef.current !== null)
			allRef.current.indeterminate = picked > 0 && !allPicked;
	}, [picked, allPicked]);

	const page = (q: string, cursor: string | null): Promise<JiraSearchResult> =>
		post<JiraSearchResult>(`${base}/search`, { jql: q, cursor });

	/** Pages 1..count of `q` again, so filed tickets show as already imported. */
	const reload = async (q: string, count: number): Promise<void> => {
		let all: JiraRow[] = [];
		let cursor: string | null = null;
		for (let i = 0; i < count; i++) {
			const r: JiraSearchResult = await page(q, cursor);
			all = appendRows(all, r.rows);
			cursor = r.next;
			if (cursor === null) break;
		}
		setRows(all);
		setNext(cursor);
	};

	const run = async (
		kind: "search" | "more" | "import",
		fn: () => Promise<void>,
	): Promise<void> => {
		setBusy(kind);
		setError(null);
		try {
			await fn();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	};

	const search = (): void => {
		const q = jql.trim();
		if (q === "" || busy !== null) return;
		void run("search", async () => {
			setNote(null);
			setSelected(new Set());
			const r = await page(q, null);
			setQuery(q);
			setRows(r.rows);
			setNext(r.next);
			setPages(1);
		});
	};

	const loadMore = (): void => {
		if (next === null || busy !== null) return;
		void run("more", async () => {
			const r = await page(query, next);
			setRows((old) => appendRows(old ?? [], r.rows));
			setNext(r.next);
			setPages((n) => n + 1);
		});
	};

	const importSelected = (): void => {
		const keys = importable
			.filter((r) => selected.has(r.key))
			.map((r) => r.key);
		if (keys.length === 0 || busy !== null) return;
		void run("import", async () => {
			setNote(null);
			const r = await post<JiraImportResult>(`${base}/import`, {
				keys,
				stage,
			});
			setSelected(new Set());
			setNote(importSummary(r));
			await reload(query, pages);
		});
	};

	const toggle = (key: string, on: boolean): void =>
		setSelected((old) => {
			const s = new Set(old);
			if (on) s.add(key);
			else s.delete(key);
			return s;
		});

	const statusText =
		busy === "search"
			? "Searching Jira…"
			: busy === "more"
				? "Loading more tickets…"
				: busy === "import"
					? "Importing…"
					: rows !== null && rows.length === 0
						? "No tickets match."
						: (note ?? "");

	return (
		<Modal
			onClose={onClose}
			label={`Import from Jira into ${projectLabel(project)}`}
			className="dialog jira-dialog"
		>
			<div className="dialog-body">
				<div className="dialog-head">
					<h2>
						Import from Jira
						<span className="dialog-sub">{projectLabel(project)}</span>
					</h2>
					<CloseButton />
				</div>
				<form
					className="jira-search"
					onSubmit={(e) => {
						e.preventDefault();
						search();
					}}
				>
					<label htmlFor={jqlId}>JQL</label>
					<textarea
						id={jqlId}
						data-autofocus
						value={jql}
						rows={3}
						spellCheck={false}
						placeholder={'project = PROJ AND status = "To Do"'}
						onChange={(e) => setJql(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
								e.preventDefault();
								search();
							}
						}}
					/>
					<div className="jira-search-actions">
						<span className="hint">Ctrl+Enter or Cmd+Enter searches.</span>
						<button
							type="submit"
							disabled={busy !== null || jql.trim() === ""}
							aria-busy={busy === "search" || undefined}
						>
							{busy === "search" && (
								<span className="spinner" aria-hidden="true" />
							)}
							Search
						</button>
					</div>
				</form>
				<p className="hint jira-status" role="status">
					{statusText}
				</p>
				{error !== null && (
					<p className="auth-error" role="alert">
						{error}
					</p>
				)}
				{rows !== null && rows.length > 0 && (
					<>
						<label className="jira-all">
							<input
								ref={allRef}
								type="checkbox"
								checked={allPicked}
								disabled={importable.length === 0 || busy !== null}
								onChange={() =>
									setSelected(
										allPicked
											? new Set()
											: new Set(importable.map((r) => r.key)),
									)
								}
							/>
							Select all ({importable.length} importable of {rows.length}{" "}
							loaded)
						</label>
						<ul className="jira-rows">
							{rows.map((r) => (
								<JiraRowItem
									key={r.key}
									row={r}
									project={project.name}
									checked={selected.has(r.key)}
									disabled={busy !== null}
									onToggle={(on) => toggle(r.key, on)}
									openCard={(id) => {
										onClose();
										openTask(id);
									}}
								/>
							))}
						</ul>
						{next !== null && (
							<button
								type="button"
								className="jira-more"
								disabled={busy !== null}
								aria-busy={busy === "more" || undefined}
								onClick={loadMore}
							>
								{busy === "more" && (
									<span className="spinner" aria-hidden="true" />
								)}
								Load more
							</button>
						)}
					</>
				)}
				<fieldset className="jira-stage">
					<legend>Stage</legend>
					<label>
						<input
							type="radio"
							name={`${jqlId}-stage`}
							value="backlog"
							checked={stage === "backlog"}
							onChange={() => setStage("backlog")}
						/>
						Backlog
					</label>
					<label>
						<input
							type="radio"
							name={`${jqlId}-stage`}
							value="todo"
							checked={stage === "todo"}
							onChange={() => setStage("todo")}
						/>
						Todo
					</label>
				</fieldset>
				<div className="dialog-actions">
					<button
						type="button"
						onClick={(e) => e.currentTarget.closest("dialog")?.close()}
					>
						Close
					</button>
					<button
						type="button"
						className="primary"
						disabled={picked === 0 || busy !== null}
						aria-busy={busy === "import" || undefined}
						onClick={importSelected}
					>
						{busy === "import" && (
							<span className="spinner" aria-hidden="true" />
						)}
						Import {picked}
					</button>
				</div>
			</div>
		</Modal>
	);
}

/** One ticket: its checkbox (named by key and summary), the Jira link and the facts line. */
function JiraRowItem({
	row,
	project,
	checked,
	disabled,
	onToggle,
	openCard,
}: {
	row: JiraRow;
	project: string;
	checked: boolean;
	disabled: boolean;
	onToggle: (on: boolean) => void;
	openCard: (id: string) => void;
}) {
	const card = row.importedCard;
	const facts = [row.issueType, row.status, row.priority].filter(
		(s) => s !== "",
	);
	return (
		<li className={card === null ? "jira-row" : "jira-row imported"}>
			<input
				type="checkbox"
				aria-label={`${row.key}: ${row.summary}`}
				checked={card === null && checked}
				disabled={card !== null || disabled}
				onChange={(e) => onToggle(e.target.checked)}
			/>
			<div className="jira-row-text">
				<span className="jira-row-head">
					<a href={row.url} target="_blank" rel="noopener noreferrer">
						{row.key}
					</a>{" "}
					<span className="jira-summary">{row.summary}</span>
				</span>
				<span className="jira-facts">
					{facts.join(" · ")}
					{card !== null && (
						<>
							{facts.length > 0 && " · "}
							already imported as{" "}
							<a
								href={taskPath(project, card)}
								onClick={(e) => navClick(e, () => openCard(card))}
							>
								{card}
							</a>
						</>
					)}
				</span>
			</div>
		</li>
	);
}
