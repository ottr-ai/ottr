/** Uppercase alphanumeric fallback handle, max 4 chars, from the folder name; TASK when nothing survives. */
export function derivedTaskPrefix(folderName: string): string {
	const p = folderName
		.replaceAll(/[^A-Za-z0-9]/g, "")
		.toUpperCase()
		.slice(0, 4);
	return p === "" ? "TASK" : p;
}
