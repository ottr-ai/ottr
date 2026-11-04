/** The message of a thrown value: an Error's message, otherwise its string form. */
export function errmsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
