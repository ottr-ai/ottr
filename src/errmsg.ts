/** The message of a thrown value: an Error's message, otherwise its string form. */
export function errmsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** An HTTP status in words; the one shared table for server error strings
 *  (DESIGN.md, the Error-Says-Fix Rule). Unknown statuses keep their number. */
export function statusWords(status: number): string {
	switch (status) {
		case 400:
			return "invalid request";
		case 401:
			return "not signed in";
		case 403:
			return "refused";
		case 404:
			return "not found";
		case 409:
			return "conflict";
		case 413:
			return "too large";
		case 429:
			return "too many requests";
		case 500:
			return "server error";
		case 502:
			return "bad gateway";
		case 503:
			return "unavailable";
		case 504:
			return "gateway timeout";
		default:
			return `status ${status}`;
	}
}

/** One line for a failed HTTP request: what failed, the status in words, and the
 *  next step (DESIGN.md, the Error-Says-Fix Rule). `what` starts lowercase in a
 *  log string and capitalized in a user-facing one. */
export function requestFailed(
	what: string,
	status: number,
	next: string,
): string {
	return `${what} failed (${statusWords(status)}): ${next}`;
}
