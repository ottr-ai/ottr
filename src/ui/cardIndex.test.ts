import { describe, expect, test } from "bun:test";
import type { CardRef } from "../types.ts";
import { buildCardIndex, lookupCard, lookupCardIn } from "./cardIndex.ts";

/** One CardRef fixture: the fields the spec pins, short-cast like every other
 * render fixture (docs/specs/card-lookup-scope.md). */
const ref = (
	over: Partial<CardRef> & Pick<CardRef, "id" | "project">,
): CardRef =>
	({
		sessionTitle: `title of ${over.id}`,
		kind: "work",
		stage: "done",
		state: "idle",
		cancelledAt: null,
		createdAt: 1,
		updatedAt: 1,
		doneAt: 100,
		followUpOf: null,
		followUpOfProject: null,
		asked: null,
		dependsOn: [],
		...over,
	}) as unknown as CardRef;

describe("buildCardIndex", () => {
	test("an empty allCards builds an empty index", () => {
		const index = buildCardIndex([]);
		expect(index.size).toBe(0);
		expect(lookupCard(index, "VELV-246")).toBeNull();
	});

	test("cards bucket by id, one bucket per id", () => {
		const velvarr = ref({ id: "VELV-246", project: "velvarr" });
		const ottr = ref({ id: "VELV-246", project: "ottr" });
		const other = ref({ id: "OTTR-9", project: "ottr" });
		const index = buildCardIndex([velvarr, ottr, other]);
		expect(index.size).toBe(2);
		expect(index.get("VELV-246")).toEqual([velvarr, ottr]);
		expect(index.get("OTTR-9")).toEqual([other]);
	});
});

describe("lookupCardIn", () => {
	test("the id and project pair picks exactly one entry", () => {
		const velvarr = ref({
			id: "VELV-246",
			project: "velvarr",
			sessionTitle: "Velvarr work",
		});
		const ottr = ref({
			id: "VELV-246",
			project: "ottr",
			sessionTitle: "Ottr work",
		});
		const index = buildCardIndex([velvarr, ottr]);
		expect(lookupCardIn(index, "VELV-246", "velvarr")).toBe(velvarr);
		expect(lookupCardIn(index, "VELV-246", "ottr")).toBe(ottr);
	});

	test("the same id in two projects stays distinct", () => {
		const velvarr = ref({ id: "VELV-246", project: "velvarr" });
		const ottr = ref({ id: "VELV-246", project: "ottr" });
		const index = buildCardIndex([velvarr, ottr]);
		expect(lookupCardIn(index, "VELV-246", "velvarr")).not.toBe(ottr);
		expect(lookupCardIn(index, "VELV-246", "velvarr")?.project).toBe("velvarr");
		expect(lookupCardIn(index, "VELV-246", "ottr")?.project).toBe("ottr");
	});

	test("a wrong project or an unknown id answers null", () => {
		const index = buildCardIndex([ref({ id: "VELV-246", project: "velvarr" })]);
		expect(lookupCardIn(index, "VELV-246", "ottr")).toBeNull();
		expect(lookupCardIn(index, "OTTR-9", "velvarr")).toBeNull();
	});
});

describe("lookupCard", () => {
	test("the first entry with the id in any project answers", () => {
		const velvarr = ref({ id: "VELV-246", project: "velvarr" });
		const ottr = ref({ id: "VELV-246", project: "ottr" });
		expect(lookupCard(buildCardIndex([velvarr, ottr]), "VELV-246")).toBe(
			velvarr,
		);
		expect(lookupCard(buildCardIndex([ottr, velvarr]), "VELV-246")).toBe(ottr);
	});

	test("a miss answers null", () => {
		const index = buildCardIndex([ref({ id: "VELV-246", project: "velvarr" })]);
		expect(lookupCard(index, "OTTR-9")).toBeNull();
		expect(lookupCard(buildCardIndex([]), "VELV-246")).toBeNull();
	});
});
