import { expect, test } from "bun:test";
import {
	forModel,
	parseUsage,
	providerBlocked,
	tightest,
	tightestFor,
	usageReset,
} from "./quota.ts";
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
			windowLabel: "5 Hour",
			plan: "max",
			usedPct: 29,
			resetsAt: 1790644200000,
		},
		{
			provider: "anthropic",
			label: "Claude 7 Day",
			window: "7d",
			windowLabel: "7 Day",
			plan: "max",
			usedPct: 44,
			resetsAt: 1791090000000,
		},
		{
			provider: "zai",
			label: "ZAI Monthly",
			window: null,
			windowLabel: "Monthly",
			plan: null,
			usedPct: 10.3,
			resetsAt: null,
		},
		{
			provider: "google",
			label: "Weekly",
			window: null,
			windowLabel: "Weekly",
			plan: null,
			usedPct: 0,
			resetsAt: 1790927121000,
		},
		{
			provider: "google",
			label: "Claude & GPT (shared)",
			window: null,
			windowLabel: null,
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

test("usageReset waits for the latest reset of the model's full windows", () => {
	const row = (p: Partial<QuotaLimit>): QuotaLimit => ({
		provider: "openai-codex",
		label: "x",
		window: null,
		plan: null,
		usedPct: 100,
		resetsAt: 500,
		...p,
	});
	const rows = [
		row({ window: "5h", resetsAt: 300 }),
		row({ window: "7d", resetsAt: 900 }),
		row({ usedPct: 99, resetsAt: 5_000 }),
		row({ resetsAt: null }),
		row({ resetsAt: 50 }),
		row({ provider: "anthropic", resetsAt: 9_000 }),
	];
	expect(usageReset(rows, "openai-codex/gpt-5", 100)).toEqual({
		provider: "openai-codex",
		resetsAt: 900,
		window: "7d",
	});
	// The binding window's id rides along; a windowless row binds with window null.
	expect(
		usageReset(
			[row({ usedPct: 100, resetsAt: 900 })],
			"openai-codex/gpt-5",
			100,
		)?.window,
	).toBeNull();
	expect(usageReset(rows, "openai-codex/gpt-5", 1_000)).toBeNull();
	expect(usageReset(rows, "gpt-5", 100)).toBeNull();
});

test("providerBlocked names the binding exhausted window; free or past-reset is null", () => {
	const row = (p: Partial<QuotaLimit>): QuotaLimit => ({
		provider: "zai",
		label: "x",
		window: null,
		plan: null,
		usedPct: 100,
		resetsAt: 500,
		...p,
	});
	// 100% with a future reset blocks, and the latest reset is the binding window.
	expect(
		providerBlocked([row({ window: "7d", resetsAt: 900 })], "zai", 100),
	).toEqual(row({ window: "7d", resetsAt: 900 }));
	expect(
		providerBlocked(
			[
				row({ window: "5h", resetsAt: 300 }),
				row({ window: "7d", resetsAt: 900 }),
			],
			"zai",
			100,
		)?.window,
	).toBe("7d");
	// A full window whose reset passed no longer blocks.
	expect(providerBlocked([row({ resetsAt: 50 })], "zai", 100)).toBeNull();
	// Below 100% does not block.
	expect(
		providerBlocked([row({ usedPct: 99.9, resetsAt: 900 })], "zai", 100),
	).toBeNull();
	// No windows at all (an unknown provider or a failed report) blocks nothing here;
	// the release keeps such holds because forProvider returns no rows.
	expect(providerBlocked([], "zai", 100)).toBeNull();
	expect(
		providerBlocked([row({ provider: "anthropic" })], "zai", 100),
	).toBeNull();
});
