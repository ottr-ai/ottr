/**
 * Image attachments for prompt inputs. Files are read fully the moment they are
 * picked, so an unreadable file is refused with its error right at the input —
 * never discovered later as a failed send or a dangling picture reference.
 */
import type {
	ClipboardEvent as ReactClipboardEvent,
	DragEvent as ReactDragEvent,
} from "react";

/** One image attached to a prompt: the file, its object URL for display, and its base64 payload. */
export interface AttachedImage {
	file: File;
	url: string;
	data: string;
}

export interface AttachedImages {
	images: AttachedImage[];
	/** True while an image file drag hovers the input; drives the drop highlight. */
	dropping: boolean;
	/** Set when a pick failed; names the unreadable files with the browser's error. */
	error: string | null;
	dismissError: () => void;
	onPaste: (e: ReactClipboardEvent<HTMLTextAreaElement>) => void;
	onDragOver: (e: ReactDragEvent<HTMLTextAreaElement>) => void;
	onDragLeave: () => void;
	onDrop: (e: ReactDragEvent<HTMLTextAreaElement>) => void;
	addFiles: (files: Iterable<File>) => void;
	remove: (index: number) => void;
	clear: () => void;
}

export function readImage(file: File): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const reader = new FileReader();
	reader.onload = () => {
		const data = String(reader.result);
		resolve(data.slice(data.indexOf(",") + 1));
	};
	reader.onerror = () =>
		reject(reader.error ?? new Error("Failed to read image"));
	reader.readAsDataURL(file);
	return promise;
}

/**
 * Reads every picked file. Unreadable ones never attach: ok carries the readable
 * files in pick order, failed carries one message naming them with the error.
 * ponytail: readable-but-corrupt files still attach here; the server's
 * decodeImages magic-byte check rejects those at send time.
 */
export async function readPicks(
	files: File[],
): Promise<{ ok: { file: File; data: string }[]; failed: string | null }> {
	const failedNames: string[] = [];
	let reason = "";
	const results = await Promise.all(
		files.map(async (file) => {
			try {
				return { file, data: await readImage(file) };
			} catch (err) {
				failedNames.push(file.name);
				reason = err instanceof Error ? err.message : String(err);
				return null;
			}
		}),
	);
	const failed =
		failedNames.length === 0
			? null
			: `Could not read ${failedNames.map((n) => `"${n}"`).join(", ")} — not attached: ${reason}`;
	return { ok: results.filter((r) => r !== null), failed };
}
