import type { GlobalStore } from "./globalStore.ts";
import type { SweepRecord } from "./inboxSweep.ts";
import type { ProjectStore } from "./store.ts";
import { doneReadKey } from "./types.ts";

export interface SweepApplication {
	card: string;
	action: "clear" | "implement";
	doneAt: number;
	delivered: boolean;
}

/** Board-owned state. Model findings never supply batch membership or approvals. */
export interface SweepState {
	batch: string[];
	verdicts: SweepRecord[];
	applications: SweepApplication[];
	filedDrafts: string[];
}

export function newSweepState(batch: string[]): SweepState {
	return { batch: [...batch], verdicts: [], applications: [], filedDrafts: [] };
}

const strings = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((v) => typeof v === "string");

/** Corrupt internal state is an error, never an empty batch or a new approval. */
export function parseSweepState(text: string): SweepState {
	const state = JSON.parse(text) as Partial<SweepState> | null;
	if (
		!state ||
		!strings(state.batch) ||
		!strings(state.filedDrafts) ||
		!Array.isArray(state.verdicts) ||
		!Array.isArray(state.applications)
	)
		throw new Error("Invalid inbox sweep state");
	for (const v of state.verdicts) {
		if (
			!v ||
			!state.batch.includes(v.cardId) ||
			!["done", "partial", "none", "info"].includes(v.verdict) ||
			typeof v.evidence !== "string" ||
			!strings(v.drafts)
		)
			throw new Error("Invalid inbox sweep verdict");
	}
	for (const a of state.applications) {
		if (
			!a ||
			!state.verdicts.some((v) => v.cardId === a.card) ||
			(a.action !== "clear" && a.action !== "implement") ||
			!Number.isSafeInteger(a.doneAt) ||
			a.doneAt < 0 ||
			typeof a.delivered !== "boolean"
		)
			throw new Error("Invalid inbox sweep application");
	}
	return state as SweepState;
}

export type MarkSweepSeen = (
	keys: string[],
	deliveryId: string,
) => Promise<void>;

/** Each global effect commits with its id, so a retry cannot undo a later unread action. */
export async function writeSweepSeen(
	gstore: GlobalStore,
	keys: string[],
	deliveryId: string,
): Promise<void> {
	await gstore.transaction(async () => {
		if ((await gstore.get(deliveryId)) === true) return;
		await gstore.update<unknown>("seen_answers", (raw) =>
			[
				...new Set([
					...(Array.isArray(raw)
						? raw.filter((v): v is string => typeof v === "string")
						: []),
					...keys,
				]),
			].sort(),
		);
		await gstore.set(deliveryId, true);
	});
}

/** Run only outside a project transaction. Proposals and receipts must commit first. */
export async function flushSweepSeen(
	store: ProjectStore,
	markSeen: MarkSweepSeen,
	runId?: string,
): Promise<void> {
	const states =
		runId === undefined
			? await store.listInboxSweeps()
			: [{ id: runId, state: await store.getInboxSweep(runId) }];
	for (const { id, state } of states) {
		for (const row of state?.applications ?? []) {
			if (row.delivered) continue;
			const deliveryId = `inbox-sweep-seen:${JSON.stringify([store.name, id, row.card, row.action])}`;
			await markSeen(
				[doneReadKey({ id: row.card, doneAt: row.doneAt })],
				deliveryId,
			);
			await store.transaction(async () => {
				const current = await store.getInboxSweep(id);
				if (current === null)
					throw new Error(`Inbox sweep state is absent for ${id}`);
				const receipt = current.applications.find(
					(a) => a.card === row.card && a.action === row.action,
				);
				if (receipt === undefined)
					throw new Error(`Inbox sweep receipt is absent for ${row.card}`);
				receipt.delivered = true;
				await store.setInboxSweep(id, current);
			});
		}
	}
}
