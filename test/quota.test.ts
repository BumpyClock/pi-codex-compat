import assert from "node:assert/strict";
import test from "node:test";
import { formatUsageStatusline } from "../src/quota/format.js";
import { normalizeCodexBackendPayload } from "../src/quota/providers/codex.js";
import {
	AUTH_FINGERPRINT_SALT,
	adapterForProvider,
	resolveUsageAuth,
	SUPPORTED_ADAPTERS,
} from "../src/quota/query.js";
import { createMockContext } from "./support.js";

const codexModel = {
	provider: "openai-codex",
	id: "gpt-5.3-codex",
	name: "gpt-5.3-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	api: "openai-codex-responses",
};

test("only openai-codex adapter is registered", () => {
	assert.deepEqual(
		SUPPORTED_ADAPTERS.map((adapter) => adapter.id),
		["openai-codex"],
	);
	assert.equal(adapterForProvider("openrouter"), undefined);
});

test("normalizes codex backend payload windows", () => {
	const report = normalizeCodexBackendPayload(
		{
			plan_type: "plus",
			rate_limit: {
				primary_window: {
					used_percent: 40,
					limit_window_seconds: 5 * 60 * 60,
					reset_at: 1_700_000_000,
				},
				secondary_window: {
					used_percent: 10,
					limit_window_seconds: 7 * 24 * 60 * 60,
					reset_at: 1_700_100_000,
				},
			},
			credits: { has_credits: false },
		},
		Date.now(),
	);
	assert.equal(report.providerId, "openai-codex");
	assert.equal(report.buckets.length, 2);
	assert.equal(report.buckets[0]?.used, 40);
	const status = formatUsageStatusline(report, codexModel);
	assert.ok(status);
	assert.match(status, /%/);
});

test("resolveUsageAuth rejects non-official origin", async () => {
	const { ctx } = createMockContext({
		model: { ...codexModel, baseUrl: "https://evil.example/proxy" },
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "secret-token" }),
			getProviderAuth: async () => ({
				auth: { apiKey: "secret-token", baseUrl: "https://evil.example/proxy" },
			}),
			getProviderAuthStatus: () => ({ configured: true }),
			getAvailable: () => [],
			getAll: () => [],
		},
	});
	const adapter = adapterForProvider("openai-codex");
	assert.ok(adapter);
	await assert.rejects(
		async () => resolveUsageAuth(ctx, adapter!, AUTH_FINGERPRINT_SALT),
		/custom provider base URL|proxy-resolved credential|official usage endpoint/,
	);
});

test("resolveUsageAuth accepts official chatgpt origin", async () => {
	const { ctx } = createMockContext({
		model: codexModel,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({
				ok: true,
				apiKey: "secret-token",
				headers: { Authorization: "Bearer secret-token" },
			}),
			getProviderAuth: async () => ({
				auth: {
					apiKey: "secret-token",
					baseUrl: "https://chatgpt.com/backend-api",
					headers: { Authorization: "Bearer secret-token" },
				},
			}),
			getProviderAuthStatus: () => ({ configured: true }),
			getAvailable: () => [codexModel],
			getAll: () => [codexModel],
		},
	});
	const adapter = adapterForProvider("openai-codex");
	assert.ok(adapter);
	const auth = await resolveUsageAuth(ctx, adapter!, AUTH_FINGERPRINT_SALT);
	assert.ok(auth);
	assert.equal(auth!.headers.Authorization, "Bearer secret-token");
	assert.ok(auth!.fingerprint);
	assert.ok(auth!.secrets.includes("secret-token"));
});
