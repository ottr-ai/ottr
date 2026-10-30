// omp thinking levels in model selectors. No imports: the server and the browser bundle share it.

/** omp model-selector thinking levels (selector suffix `:level`, same enum as omp's --thinking flag). */
export const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"auto",
] as const;

/** Splits a trailing `:level` suffix off a model selector: [base, level], level "" when absent.
    The suffix only counts when it is a known thinking level, so ids like "openrouter/x:exacto" stay intact. */
export function splitLevel(selector: string): [string, string] {
	const i = selector.lastIndexOf(":");
	const lvl = selector.slice(i + 1);
	if (i !== -1 && (THINKING_LEVELS as readonly string[]).includes(lvl))
		return [selector.slice(0, i), lvl];
	return [selector, ""];
}

/** Appends `:level` to a selector, replacing any existing suffix; "" level keeps the bare base. */
export function joinLevel(base: string, level: string): string {
	const [clean] = splitLevel(base);
	return level === "" || clean === "" ? clean : `${clean}:${level}`;
}
