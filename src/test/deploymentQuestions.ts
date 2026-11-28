import assert from "node:assert/strict";
import { LEAD_QUESTIONS_PROMPT_PREFIX } from "../scheduler.ts";
import { ProjectStore } from "../store.ts";
import fc from "./properties.ts";

/** Both backend child processes use real close/open recovery. */
export async function deploymentQuestionRecovery(path: string): Promise<void> {
	await clearedDeploymentQuestionRecovery(`${path}-cleared`);
	let store = await ProjectStore.init(path);
	try {
		const review = await store.createTask("Review deployment", null, "review");
		const other = await store.createTask("Other review", null, "review");
		const makeLead = async (name: string, deployment = true) => {
			const lead = await store.createTask(
				`Needs validation: ${name}\nBlocker: ${deployment ? "deployment fact: Is the proxy public?" : "sandbox run: reproduce"}`,
			);
			await store.updateTask(lead.id, {
				followUpOf: review.id,
				stage: "backlog",
				state: "idle",
				details: "The user answered: Not sure. Free text: I cannot tell.",
			});
			return lead;
		};
		const first = await makeLead("public proxy");
		const waiting = await makeLead("already waiting");
		await store.updateTask(waiting.id, {
			stage: "todo",
			state: "queued",
			waitsValidation: true,
			validatedAt: 10,
		});
		const question = {
			question: `Original exact question? (card #${first.id})`,
			options: [
				{ label: "Applies" },
				{ label: "Does not apply" },
				{ label: "Not sure" },
			],
			multi: false,
			recommended: null,
			text: false,
		};
		const closed = await store.createTask(
			`${LEAD_QUESTIONS_PROMPT_PREFIX}${review.id}`,
		);
		await store.updateTask(closed.id, {
			followUpOf: review.id,
			stage: "done",
			state: "idle",
			asked: [question],
			details: "Keep these notes",
		});
		assert.equal(await store.leadQuestionCardId(first.id, review.id), null);
		const excluded = await decidedDeploymentLeads(store, review.id);
		const cancelled = await makeLead("cancelled");
		await store.updateTask(cancelled.id, { cancelledAt: 1 });
		excluded.push(cancelled.id);
		const unknownLegacy = await makeLead("unmarked stamped lead");
		await store.updateTask(unknownLegacy.id, { validatedAt: 10 });
		excluded.push(unknownLegacy.id);
		const foreignLead = await makeLead("foreign review collision");
		await store.updateTask(foreignLead.id, {
			followUpOfProject: "foreign-project",
			stage: "todo",
			waitsValidation: true,
		});
		excluded.push(foreignLead.id);
		const foreignCards: string[] = [];
		for (const stage of ["backlog", "done"] as const) {
			const card = await store.createTask(
				`${LEAD_QUESTIONS_PROMPT_PREFIX}${review.id}`,
			);
			await store.updateTask(card.id, {
				followUpOf: review.id,
				followUpOfProject: "foreign-project",
				stage,
				state: stage === "done" ? "idle" : "needs_you",
				asked: [
					{ ...question, question: `Foreign question? (card #${first.id})` },
				],
			});
			foreignCards.push(card.id);
		}
		assert.equal(await store.leadQuestionCardId(first.id, review.id), null);
		const fallback = await makeLead("title fallback", false);
		const history =
			"\nValidated by #old: deployment — No question text remains.\n\n" +
			"Private historical note. ".repeat(100);
		await store.updateTask(fallback.id, {
			title: "Proxy exposure",
			stage: "todo",
			state: "queued",
			waitsValidation: true,
			validatedAt: 10,
			details: history,
		});
		const expectedQuestions = new Map([
			[waiting.id, `Is the proxy public? (card #${waiting.id})`],
			[
				fallback.id,
				`Does the risk in "Proxy exposure" apply to this deployment? (card #${fallback.id})`,
			],
		]);
		const outcomes = await deploymentOutcomeLeads(store, review.id);
		excluded.push(...outcomes.excluded);
		for (const [id, text] of outcomes.questions)
			expectedQuestions.set(id, text);
		await store.close();
		store = await ProjectStore.open(path);
		assert.equal(
			await store.leadQuestionCardId(first.id, review.id),
			closed.id,
		);
		assert.equal(await store.leadQuestionCardId(first.id, other.id), null);
		const suffixLead = await makeLead("suffix lookup", false);
		await store.updateTask(suffixLead.id, { followUpOf: other.id });
		await fc.assert(
			fc.asyncProperty(fc.string(), async (text) => {
				const card = await store.createTask(
					`${LEAD_QUESTIONS_PROMPT_PREFIX}${other.id}`,
				);
				try {
					await store.updateTask(card.id, {
						followUpOf: other.id,
						stage: "backlog",
						state: "needs_you",
						asked: [
							{
								...question,
								question: `${text} (card #${suffixLead.id}) not a suffix`,
							},
						],
					});
					assert.equal(
						await store.leadQuestionCardId(suffixLead.id, other.id),
						null,
					);
					await store.updateTask(card.id, {
						asked: [
							{ ...question, question: `${text} (card #${suffixLead.id})` },
						],
					});
					assert.equal(
						await store.leadQuestionCardId(suffixLead.id, other.id),
						card.id,
					);
				} finally {
					await store.updateTask(card.id, { cancelledAt: 1 });
				}
			}),
			{ seed: 1350, numRuns: 100 },
		);
		assert.equal(
			await store.leadQuestionCardId(waiting.id, review.id),
			closed.id,
		);
		assert.deepEqual((await store.getTask(closed.id))?.asked?.[0], question);
		assert.equal((await store.getTask(closed.id))?.details, "Keep these notes");
		for (const id of excluded)
			assert.equal(await store.leadQuestionCardId(id, review.id), null);
		assert.equal((await store.getTask(first.id))?.waitsValidation, true);
		const restored = await store.getTask(closed.id);
		assert(restored?.asked);
		for (const [id, text] of expectedQuestions) {
			assert.equal(await store.leadQuestionCardId(id, review.id), closed.id);
			assert.equal(
				restored.asked.find((q) => q.question.endsWith(`(card #${id})`))
					?.question,
				text,
			);
			assert.equal((await store.getTask(id))?.waitsValidation, true);
		}
		assert.equal((await store.getTask(fallback.id))?.details, history);
		assert.equal((await store.getTask(unknownLegacy.id))?.stage, "backlog");
		assert.equal(
			(await store.getTask(unknownLegacy.id))?.waitsValidation,
			false,
		);
		for (const id of foreignCards) {
			const card = await store.getTask(id);
			assert.equal(card?.followUpOfProject, "foreign-project");
			assert.equal(card?.stage, id === foreignCards[0] ? "backlog" : "done");
			assert.equal(
				card?.asked?.[0]?.question,
				`Foreign question? (card #${first.id})`,
			);
		}
		await store.updateTask(closed.id, {
			asked: [
				...restored.asked,
				{ ...question, question: `Foreign lead? (card #${foreignLead.id})` },
			],
		});
		assert.equal(
			await store.leadQuestionCardId(foreignLead.id, review.id),
			null,
		);
		await store.updateTask(closed.id, { asked: restored.asked });
		const before = (await store.getTask(closed.id))?.asked;
		await store.close();
		store = await ProjectStore.open(path);
		assert.deepEqual((await store.getTask(closed.id))?.asked, before);
		const added = await makeLead("partial open question");
		await store.close();
		store = await ProjectStore.open(path);
		assert.equal(
			await store.leadQuestionCardId(added.id, review.id),
			closed.id,
		);
		assert.equal(
			(await store.getTask(closed.id))?.asked?.length,
			(before?.length ?? 0) + 1,
		);
		await store.updateTask(closed.id, { cancelledAt: 1 });
		assert.equal(await store.leadQuestionCardId(first.id, review.id), null);
		await store.close();
		store = await ProjectStore.open(path);
		const replacement = await store.leadQuestionCardId(first.id, review.id);
		assert(replacement !== null);
		assert.notEqual(replacement, closed.id);
		assert.deepEqual(
			(await store.getTask(replacement))?.asked?.[0]?.options.map(
				(o) => o.label,
			),
			["Applies", "Does not apply", "Not sure"],
		);
	} finally {
		await store.close();
	}
}

async function deploymentOutcomeLeads(
	store: ProjectStore,
	reviewId: string,
): Promise<{ excluded: string[]; questions: Map<string, string> }> {
	const excluded: string[] = [];
	const questions = new Map<string, string>();
	for (const state of [
		"queued",
		"running",
		"needs_you",
		"cancelled",
		"done",
	] as const) {
		const lead = await store.createTask(
			`Needs validation: outcome ${state}\nBlocker: sandbox run: reproduce`,
		);
		await store.updateTask(lead.id, {
			followUpOf: reviewId,
			stage: "backlog",
			state: "idle",
		});
		const run = await store.createTask("Validation run", null, "validation");
		await store.updateTask(run.id, {
			followUpOf: reviewId,
			stage: state === "done" || state === "cancelled" ? "done" : "in_progress",
			state: state === "cancelled" || state === "done" ? "idle" : state,
			cancelledAt: state === "cancelled" ? 1 : null,
		});
		await store.appendReviewFinding(run.id, {
			prompt: `Validation: #${lead.id} deployment\nIs this service public?`,
			model: null,
			rank: null,
			security: null,
		});
		if (state !== "done") excluded.push(lead.id);
		else questions.set(lead.id, `Is this service public? (card #${lead.id})`);
	}
	return { excluded, questions };
}

async function decidedDeploymentLeads(
	store: ProjectStore,
	reviewId: string,
): Promise<string[]> {
	const excluded: string[] = [];
	for (const outcome of ["confirmed", "refuted"] as const) {
		for (const source of ["details", "applied"] as const) {
			const lead = await store.createTask(
				`Needs validation: ${source} ${outcome}\nBlocker: deployment fact: Is the proxy public?`,
			);
			await store.updateTask(lead.id, {
				followUpOf: reviewId,
				stage: "todo",
				waitsValidation: true,
				validatedAt: 10,
				details:
					source === "details" ? `\nValidated by #old: ${outcome}.` : null,
			});
			if (source === "applied") {
				const run = await store.createTask(
					"Completed validation",
					null,
					"validation",
				);
				await store.updateTask(run.id, {
					followUpOf: reviewId,
					stage: "done",
					state: "idle",
				});
				await store.appendReviewFinding(run.id, {
					prompt: `Validation: #${lead.id} ${outcome}\nThe result decides this lead.`,
					model: null,
					rank: null,
					security: null,
				});
			}
			excluded.push(lead.id);
		}
	}
	for (const stage of ["todo", "done"] as const) {
		const lead = await store.createTask(
			"Needs validation: answered or done\nBlocker: deployment fact: Is the proxy public?",
		);
		await store.updateTask(lead.id, {
			followUpOf: reviewId,
			stage,
			waitsValidation: true,
			prompt:
				stage === "todo"
					? `${lead.prompt}\nThe user answered the review's question: Applies`
					: lead.prompt,
		});
		excluded.push(lead.id);
	}
	return excluded;
}

async function clearedDeploymentQuestionRecovery(path: string): Promise<void> {
	let store = await ProjectStore.init(path);
	try {
		const cases: {
			reviewId: string;
			leadId: string;
			cardId: string;
			details: string;
		}[] = [];
		for (const answer of ["Not sure", "I cannot tell which proxy applies."]) {
			const review = await store.createTask(
				"Review closed questions",
				null,
				"review",
			);
			const lead = await store.createTask(
				"Needs validation: public proxy\nBlocker: deployment fact: Is the proxy public?",
			);
			const details = `\n\nThe user answered the review's question: ${answer}`;
			await store.updateTask(lead.id, {
				followUpOf: review.id,
				waitsValidation: true,
				validatedAt: 10,
				details,
			});
			const card = await store.createTask(
				`${LEAD_QUESTIONS_PROMPT_PREFIX}${review.id}`,
			);
			await store.updateTask(card.id, {
				followUpOf: review.id,
				stage: "done",
				state: "idle",
				asked: null,
			});
			cases.push({
				reviewId: review.id,
				leadId: lead.id,
				cardId: card.id,
				details,
			});
		}
		await store.close();
		store = await ProjectStore.open(path);
		for (const entry of cases) {
			assert.equal(
				await store.leadQuestionCardId(entry.leadId, entry.reviewId),
				entry.cardId,
			);
			const card = await store.getTask(entry.cardId);
			assert.equal(card?.stage, "backlog");
			assert.equal(card?.state, "needs_you");
			assert.equal(
				card?.asked?.[0]?.question,
				`Is the proxy public? (card #${entry.leadId})`,
			);
			const lead = await store.getTask(entry.leadId);
			assert.equal(lead?.waitsValidation, true);
			assert.equal(lead?.validatedAt, 10);
			assert.equal(lead?.details, entry.details);
		}
		const before = await store.listTasks();
		await store.close();
		store = await ProjectStore.open(path);
		assert.deepEqual(await store.listTasks(), before);
	} finally {
		await store.close();
	}
}
