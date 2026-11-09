import type { Mermaid } from "mermaid";
import { mermaidSrc } from "../mermaidVersion.ts";

declare global {
	interface Window {
		/** Set by the versioned mermaid bundle; see loadMermaid. */
		mermaid?: Mermaid;
	}
}

let mermaidLoad: Promise<Mermaid> | null = null;

/**
 * mermaid's prebuilt bundle, served by the server at the versioned path (src/mermaidVersion.ts)
 * with an immutable year cache, and loaded once on first use: Bun's HTML bundler would inline a
 * dynamic import into the board bundle. A failed load clears the promise, so the next open retries.
 * `doc` is a seam for tests; production callers use the default document.
 */
export function loadMermaid(doc: Document = document): Promise<Mermaid> {
	if (mermaidLoad !== null) return mermaidLoad;
	const { promise, resolve, reject } = Promise.withResolvers<Mermaid>();
	const fail = () => {
		mermaidLoad = null;
		s.remove();
		reject(new Error("mermaid failed to load"));
	};
	const s = doc.createElement("script");
	s.src = mermaidSrc;
	s.onload = () => (window.mermaid ? resolve(window.mermaid) : fail());
	s.onerror = fail;
	doc.head.append(s);
	mermaidLoad = promise;
	return promise;
}
