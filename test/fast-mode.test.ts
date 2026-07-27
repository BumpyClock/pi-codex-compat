import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	injectPriorityServiceTier,
	isOpenAICodexResponsesPayload,
	isVerifiedCodexResponsesModel,
	SERVICE_TIER,
} from "../src/fast-mode/fast-mode.js";
import piCodexCompat from "../src/pi-codex-compat.js";
import { loadPackageSettings } from "../src/settings/load.js";
import { createMockContext, createMockPi } from "./support.js";

function codexPayload(overrides: Record<string, unknown> = {}) {
	return {
		model: "gpt-5.3-codex",
		stream: true,
		instructions: "system",
		input: [{ type: "message", role: "user", content: "hi" }],
		tool_choice: "auto",
		prompt_cache_key: "cache-1",
		...overrides,
	};
}

function responsesShapedPayload(model = "gpt-5-mini") {
	return {
		model,
		stream: true,
		instructions: "system",
		input: [{ type: "message", role: "user", content: "hi" }],
		tool_choice: "auto",
		prompt_cache_key: "cache-1",
	};
}

test("detects OpenAI Codex Responses payloads", () => {
	assert.equal(isOpenAICodexResponsesPayload(codexPayload()), true);
	assert.equal(isOpenAICodexResponsesPayload({ model: "gpt-4.1" }), false);
	// Shape-only Responses payloads are secondary-true but must not authorize injection alone.
	assert.equal(isOpenAICodexResponsesPayload(responsesShapedPayload("gpt-5-mini")), true);
});

test("verified codex responses model requires provider and api", () => {
	assert.equal(
		isVerifiedCodexResponsesModel({
			provider: "openai-codex",
			api: "openai-codex-responses",
			id: "gpt-5.3-codex",
		}),
		true,
	);
	assert.equal(
		isVerifiedCodexResponsesModel({
			provider: "openai",
			api: "openai-responses",
			id: "gpt-5.3-codex",
		}),
		false,
	);
	assert.equal(
		isVerifiedCodexResponsesModel({
			provider: "openai-codex",
			api: "openai-responses",
			id: "gpt-5.3-codex",
		}),
		false,
	);
});

test("injects priority service tier without dropping fields for verified codex", () => {
	const payload = codexPayload({ temperature: 0.2 });
	const next = injectPriorityServiceTier(payload, {
		provider: "openai-codex",
		api: "openai-codex-responses",
		id: "gpt-5.3-codex",
	});
	assert.deepEqual(next, { ...payload, service_tier: SERVICE_TIER });
});

test("does not inject priority tier for non-codex Responses shape/model", () => {
	const shaped = responsesShapedPayload("gpt-5-mini");
	assert.equal(
		injectPriorityServiceTier(shaped, {
			provider: "openai",
			api: "openai-responses",
			id: "gpt-5-mini",
		}),
		undefined,
	);

	const codexNamed = responsesShapedPayload("gpt-5.3-codex");
	assert.equal(
		injectPriorityServiceTier(codexNamed, {
			provider: "openai",
			api: "openai-responses",
			id: "gpt-5.3-codex",
		}),
		undefined,
	);

	assert.equal(
		injectPriorityServiceTier(codexNamed, {
			provider: "custom-provider",
			api: "openai-codex-responses",
			id: "gpt-5.3-codex",
		}),
		undefined,
	);

	// Payload secondary check alone is insufficient even when model looks codex-ish.
	assert.equal(injectPriorityServiceTier(codexPayload()), undefined);
});

test("fast mode settings persist under canonical file", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-codex-fast-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const cwd = await mkdtemp(join(tmpdir(), "pi-codex-cwd-"));
		const settingsPath = join(agentDir, "pi-codex-compat.json");
		await mkdir(agentDir, { recursive: true });
		await writeFile(settingsPath, `${JSON.stringify({ fastMode: { enabled: false } }, null, 2)}\n`);

		const loaded = loadPackageSettings(cwd, { agentDirOverride: agentDir });
		assert.equal(loaded.settings.fastMode.enabled, false);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

test("before_provider_request pipeline applies compaction then priority tier", async () => {
	const { pi, events } = createMockPi();
	const fastSettings = {
		fastMode: { enabled: true },
		openaiNativeCompaction: {
			enabled: false,
			debug: false,
			logProviderPayloads: false,
			logCompactResponses: false,
			redactSensitiveData: true,
			artifactRoot: "~/.pi/agent/artifacts/openai-native-compaction",
			supportedProviders: ["openai", "openai-codex"],
			supportedApis: ["openai-responses", "openai-codex-responses"],
			notifyOnLoad: false,
		},
		tps: { enabled: false, notifyOnComplete: false },
		auth: { disableApiKeyWhenCodexAuthenticated: false },
	};
	piCodexCompat(pi, { settings: fastSettings });

	const handlers = events.get("before_provider_request") ?? [];
	assert.ok(handlers.length >= 1);
	const { ctx } = createMockContext({
		mode: "tui",
		hasUI: true,
		model: {
			provider: "openai-codex",
			id: "gpt-5.3-codex",
			api: "openai-codex-responses",
			baseUrl: "https://chatgpt.com/backend-api",
		},
	});
	const payload = codexPayload();
	const result = (await handlers[0]!({ payload }, ctx)) as Record<string, unknown> | undefined;
	assert.equal(result?.service_tier, SERVICE_TIER);
	assert.equal(result?.prompt_cache_key, "cache-1");
});

test("before_provider_request does not inject tier for openai Responses codex-named model", async () => {
	const { pi, events } = createMockPi();
	piCodexCompat(pi, {
		settings: {
			fastMode: { enabled: true },
			openaiNativeCompaction: {
				enabled: false,
				debug: false,
				logProviderPayloads: false,
				logCompactResponses: false,
				redactSensitiveData: true,
				artifactRoot: "~/.pi/agent/artifacts/openai-native-compaction",
				supportedProviders: ["openai", "openai-codex"],
				supportedApis: ["openai-responses", "openai-codex-responses"],
				notifyOnLoad: false,
			},
			tps: { enabled: false, notifyOnComplete: false },
			auth: { disableApiKeyWhenCodexAuthenticated: false },
		},
	});

	const handlers = events.get("before_provider_request") ?? [];
	const { ctx } = createMockContext({
		mode: "tui",
		hasUI: true,
		model: {
			provider: "openai",
			id: "gpt-5.3-codex",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
		},
	});
	const payload = responsesShapedPayload("gpt-5.3-codex");
	const result = (await handlers[0]!({ payload }, ctx)) as Record<string, unknown> | undefined;
	assert.equal(result, undefined);
});

test("/fast rejects print mode", async () => {
	const { pi, commands } = createMockPi();
	piCodexCompat(pi, {
		settings: {
			fastMode: { enabled: false },
			openaiNativeCompaction: {
				enabled: false,
				debug: false,
				logProviderPayloads: false,
				logCompactResponses: false,
				redactSensitiveData: true,
				artifactRoot: "~/.pi/agent/artifacts/openai-native-compaction",
				supportedProviders: ["openai", "openai-codex"],
				supportedApis: ["openai-responses", "openai-codex-responses"],
				notifyOnLoad: false,
			},
			tps: { enabled: false, notifyOnComplete: false },
			auth: { disableApiKeyWhenCodexAuthenticated: false },
		},
	});
	const command = commands.get("fast");
	assert.ok(command);
	const { ctx } = createMockContext({ mode: "print", hasUI: false });
	await assert.rejects(async () => command!.handler("status", ctx), /not supported in print mode/);
});
