import { expect, test } from "bun:test";
import { forModel, parseUsage, tightest, tightestFor } from "./quota.ts";
import type { QuotaLimit } from "./types.ts";

// Trimmed from real `omp usage --json` output (2026-09-28).
const REPORT = JSON.stringify({
	generatedAt: 1790629290975,
	reports: [
		{
			provider: "anthropic",
			limits: [
				{
					label: "Claude 5 Hour",
					window: { id: "5h", label: "5 Hour", resetsAt: 1790644200000 },
					amount: { used: 29, limit: 100, usedFraction: 0.29, unit: "percent" },
				},
				{
					label: "Claude 7 Day",
					window: { id: "7d", label: "7 Day", resetsAt: 1791090000000 },
					amount: { used: 44, limit: 100, usedFraction: 0.44 },
				},
			],
			metadata: { email: "someone@example.com", planType: "max" },
		},
		// Credits without usedFraction: derive it from used/limit. No window reset: null.
		{
			provider: "zai",
			limits: [
				{
					label: "ZAI Monthly",
					window: { label: "Monthly" },
					amount: { used: 1232, limit: 12000, unit: "credits" },
				},
			],
		},
		// Unusable entries are skipped, not guessed.
		{
			provider: "kimi",
			limits: [
				{ label: "broken", amount: { used: 3 } },
				{ label: "zero", amount: { used: 0, limit: 0 } },
			],
		},
		{ limits: [{ label: "no provider", amount: { usedFraction: 0.5 } }] },
		// Missing top-level label falls back to the window label.
		{
			provider: "google",
			limits: [
				{
					window: { label: "Weekly", resetsAt: 1790927121000 },
					amount: { usedFraction: 0.00017 },
				},
				// One shared pool reported once per model family: shown once.
				{
					label: "Claude & GPT (shared)",
					scope: { sharedGroup: "3p-weekly:weekly" },
					amount: { usedFraction: 0.25 },
				},
				{
					label: "Claude & GPT (shared)",
					scope: { sharedGroup: "3p-weekly:weekly" },
					amount: { usedFraction: 0.25 },
				},
			],
		},
	],
});

test("maps every usable limit to provider, label, percent, reset and plan, dropping the rest of the account metadata", () => {
	expect(parseUsage(REPORT)).toEqual([
		{
			provider: "anthropic",
			label: "Claude 5 Hour",
			window: "5h",
			plan: "max",
			usedPct: 29,
			resetsAt: 1790644200000,
		},
		{
			provider: "anthropic",
			label: "Claude 7 Day",
			window: "7d",
			plan: "max",
			usedPct: 44,
			resetsAt: 1791090000000,
		},
		{
			provider: "zai",
			label: "ZAI Monthly",
			window: null,
			plan: null,
			usedPct: 10.3,
			resetsAt: null,
		},
		{
			provider: "google",
			label: "Weekly",
			window: null,
			plan: null,
			usedPct: 0,
			resetsAt: 1790927121000,
		},
		{
			provider: "google",
			label: "Claude & GPT (shared)",
			window: null,
			plan: null,
			usedPct: 25,
			resetsAt: null,
		},
	]);
});

test("rejects output that is not a usage report", () => {
	expect(() => parseUsage("not json")).toThrow();
	expect(() => parseUsage("{}")).toThrow("no reports");
});

const CLAUDE_7_DAY: QuotaLimit = {
	provider: "anthropic",
	label: "Claude 7 Day",
	window: "7d",
	plan: null,
	usedPct: 49,
	resetsAt: 1,
};
const ZAI_WEEKLY: QuotaLimit = {
	provider: "zai",
	label: "ZAI Weekly Credit Quota",
	window: "7d",
	plan: null,
	usedPct: 40,
	resetsAt: 3,
};
const LIMITS: QuotaLimit[] = [
	CLAUDE_7_DAY,
	{
		provider: "zai",
		label: "ZAI 5 Hours Credit Quota",
		window: "5h",
		plan: null,
		usedPct: 5,
		resetsAt: 2,
	},
	ZAI_WEEKLY,
];

test("top-bar quota tracks the default model provider, not the global maximum", () => {
	expect(tightestFor(LIMITS, "zai/glm-5.3-flash")).toEqual(ZAI_WEEKLY);
});

test("a model prefix matches provider families like google -> google-antigravity", () => {
	const hit = tightestFor(
		[
			{
				provider: "google-antigravity",
				label: "Gemini",
				window: null,
				plan: null,
				usedPct: 12,
				resetsAt: 1,
			},
		],
		"google/gemini-3-pro",
	);
	expect(hit?.usedPct).toBe(12);
});

test("an unknown or unreported default falls back to the global tightest limit", () => {
	expect(tightestFor(LIMITS, null)).toEqual(CLAUDE_7_DAY);
	expect(tightestFor(LIMITS, "openai/gpt-5")).toEqual(CLAUDE_7_DAY);
	expect(tightestFor(LIMITS, "glm-5.3-flash")).toEqual(CLAUDE_7_DAY);
	expect(tightestFor([], "zai/glm-5.3-flash")).toBeNull();
});

test("the picker chip shows one row per window of the model's provider, tightest use kept", () => {
	expect(forModel(LIMITS, "zai/glm-5.3-flash")).toEqual([
		{
			provider: "zai",
			label: "ZAI 5 Hours Credit Quota",
			window: "5h",
			plan: null,
			usedPct: 5,
			resetsAt: 2,
		},
		ZAI_WEEKLY,
	]);
	// Real case (openai-codex): a main weekly pool plus a model-reserve row on the same window.
	const five: QuotaLimit = {
		provider: "openai-codex",
		label: "5 hours",
		window: "5h",
		plan: null,
		usedPct: 0,
		resetsAt: 7,
	};
	const main: QuotaLimit = {
		provider: "openai-codex",
		label: "7 days",
		window: "7d",
		plan: null,
		usedPct: 59,
		resetsAt: 8,
	};
	const reserve: QuotaLimit = {
		provider: "openai-codex",
		label: "7 days (gpt-reserve)",
		window: "7d",
		plan: null,
		usedPct: 1,
		resetsAt: 9,
	};
	expect(forModel([five, main, reserve], "openai/gpt-5")).toEqual([five, main]);
	// The higher use binds: a reserve row above the main pool wins its window's slot.
	expect(
		forModel([five, reserve, { ...main, usedPct: 99 }], "openai/gpt-5"),
	).toEqual([five, { ...main, usedPct: 99 }]);
});

test("the chip colors by the worst window", () => {
	expect(tightest([])).toBeNull();
	expect(tightest(LIMITS)).toBe(CLAUDE_7_DAY);
	expect(tightest(forModel(LIMITS, "zai/glm-5.3-flash"))).toBe(ZAI_WEEKLY);
});

test("the picker chip hides when the model has no provider or its provider reports nothing", () => {
	expect(forModel(LIMITS, null)).toEqual([]);
	expect(forModel(LIMITS, "glm-5.3-flash")).toEqual([]);
	expect(forModel(LIMITS, "openai/gpt-5")).toEqual([]);
	expect(forModel([], "zai/glm-5.3-flash")).toEqual([]);
});
