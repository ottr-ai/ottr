/**
 * Non-product path filter for release notes (OTTR-1213): the release notes describe the
 * product its users run, so work on the repo around the product — a landing page, the
 * marketing site, root docs, CI, agent or board files — stays out. The filter is
 * deterministic: a commit or card whose changed files all sit under a non-product glob is
 * dropped before the model call, and the deterministic fallback notes apply the same
 * filter. Breaking items are never dropped. A project extends the defaults with its
 * `nonProductPaths` setting (an array of Bun.Glob patterns).
 */

/** Bun.Glob patterns for repository paths that are not the product: a landing page or
 * marketing site folder, root docs (README and the other root .md files), CI and issue
 * templates, and agent or board configuration. */
export const DEFAULT_NON_PRODUCT_PATHS = [
	"*.md",
	".github/**",
	".agents/**",
	".omp/**",
	"landing/**",
	"site/**",
	"website/**",
];

/** The non-product globs for one project: the defaults plus the setting's patterns. */
export function nonProductGlobs(extra?: string[] | null): Bun.Glob[] {
	return [...DEFAULT_NON_PRODUCT_PATHS, ...(extra ?? [])].map(
		(p) => new Bun.Glob(p),
	);
}

/** True when the repo-relative path sits under a non-product glob. */
export function isNonProductPath(file: string, globs: Bun.Glob[]): boolean {
	const p = file.replace(/^\.\//, "");
	return globs.some((g) => g.match(p));
}

/** True when a commit with these changed files keeps its notes bullet: a breaking commit
 * always keeps it, a commit with no known files keeps it (the filter never hides what it
 * cannot see), and otherwise any product file keeps it. */
export function keepCommitFiles(
	files: string[] | undefined,
	globs: Bun.Glob[],
	breaking: boolean,
): boolean {
	if (breaking) return true;
	if (files === undefined || files.length === 0) return true;
	return files.some((f) => !isNonProductPath(f, globs));
}

/** One release-summary card's shape the filter reads; callers pass their richer card. */
export type FilterableCard = {
	details: string | null;
	/** Repo-relative paths the card's branch changed; null when never captured. */
	files?: string[] | null;
};

/** True when a card stays in the model input: a report that marks a breaking change
 * stays, a card with no captured files stays (the filter never hides what it cannot
 * see), and otherwise any product file keeps it. A card whose captured diff is empty
 * changed nothing on the target, so it drops. */
export function keepSummaryCard(
	card: FilterableCard,
	globs: Bun.Glob[],
): boolean {
	if (/\*\*Breaking:\*\*/.test(card.details ?? "")) return true;
	const files = card.files;
	if (files === undefined || files === null) return true;
	if (files.length === 0) return false;
	return files.some((f) => !isNonProductPath(f, globs));
}
