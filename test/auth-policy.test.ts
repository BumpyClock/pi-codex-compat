import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	inspectAuthJsonContents,
	readOpenAICodexOAuthPresence,
} from "../src/accounts/auth-json-presence.js";
import { createCodexAuthStateReader } from "../src/accounts/codex-auth-state.js";
import {
	PROVIDER_CONFLICT_MESSAGE,
	STALE_OPENAI_BLOCK_MESSAGE,
	UNKNOWN_AUTH_BLOCK_MESSAGE,
} from "../src/auth-policy/messages.js";
import piCodexCompat from "../src/pi-codex-compat.js";
import { loadPackageSettings, updatePackageSettings } from "../src/settings/load.js";
import { createMockContext, createMockPi } from "./support.js";

const baseSettings = {
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
};

function openaiModel() {
	return {
		provider: "openai",
		id: "gpt-5",
		api: "openai-responses",
		baseUrl: "https://api.openai.com/v1",
	};
}

function codexModel() {
	return {
		provider: "openai-codex",
		id: "gpt-5.3-codex",
		api: "openai-codex-responses",
		baseUrl: "https://chatgpt.com/backend-api",
	};
}

function boot(
	options: {
		settings?: typeof baseSettings;
		authState?: {
			read: () => Promise<import("../src/accounts/codex-auth-state.js").RedactedCodexAuthState>;
		};
		authPath?: string;
	} = {},
) {
	const mock = createMockPi();
	piCodexCompat(mock.pi, {
		settings: options.settings ?? { ...baseSettings },
		authState: options.authState,
		authPath: options.authPath,
	});
	return mock;
}

function contextFor(
	mock: ReturnType<typeof createMockPi>,
	overrides: Record<string, unknown> = {},
) {
	return createMockContext({
		mode: "tui",
		hasUI: true,
		modelRegistry: mock.modelRegistry,
		...overrides,
	});
}

async function emitAll(
	mock: ReturnType<typeof createMockPi>,
	event: string,
	payload: unknown,
	ctx: unknown,
) {
	const handlers = mock.events.get(event) ?? [];
	const results: unknown[] = [];
	for (const handler of handlers) {
		results.push(await handler(payload, ctx));
	}
	return results;
}

test("auth setting defaults false and validates boolean with unknown-field preservation", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-codex-auth-settings-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });

	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		writeFileSync(
			join(agentDir, "pi-codex-compat.json"),
			`${JSON.stringify(
				{
					auth: { disableApiKeyWhenCodexAuthenticated: "yes", extra: 1 },
					customUnknown: "keep",
				},
				null,
				2,
			)}\n`,
		);
		const loaded = loadPackageSettings(cwd, { agentDirOverride: agentDir });
		assert.equal(loaded.settings.auth.disableApiKeyWhenCodexAuthenticated, false);
		assert.ok(
			loaded.warnings.some((warning) => warning.includes("disableApiKeyWhenCodexAuthenticated")),
		);

		await updatePackageSettings(
			(current) => ({
				...current,
				auth: { disableApiKeyWhenCodexAuthenticated: true },
			}),
			cwd,
		);
		const written = JSON.parse(readFileSync(join(agentDir, "pi-codex-compat.json"), "utf8")) as {
			auth?: { disableApiKeyWhenCodexAuthenticated?: boolean; extra?: number };
			customUnknown?: string;
		};
		assert.equal(written.auth?.disableApiKeyWhenCodexAuthenticated, true);
		assert.equal(written.customUnknown, "keep");
		// Invalid/extra fields in auth block are preserved by shallow merge of existing object.
		assert.equal(written.auth?.extra, 1);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

test("project auth setting beats user when trusted", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-codex-auth-prec-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(
		join(agentDir, "pi-codex-compat.json"),
		`${JSON.stringify({ auth: { disableApiKeyWhenCodexAuthenticated: false } }, null, 2)}\n`,
	);
	writeFileSync(
		join(cwd, ".pi", "pi-codex-compat.json"),
		`${JSON.stringify({ auth: { disableApiKeyWhenCodexAuthenticated: true } }, null, 2)}\n`,
	);
	const trusted = loadPackageSettings(cwd, { agentDirOverride: agentDir, isProjectTrusted: true });
	assert.equal(trusted.settings.auth.disableApiKeyWhenCodexAuthenticated, true);
	const untrusted = loadPackageSettings(cwd, {
		agentDirOverride: agentDir,
		isProjectTrusted: false,
	});
	assert.equal(untrusted.settings.auth.disableApiKeyWhenCodexAuthenticated, false);
});

test("auth settings toggle under trusted project override reports effective outcome", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-codex-auth-toggle-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(cwd, ".pi"), { recursive: true });

	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		// User off, trusted project on → effective on.
		writeFileSync(
			join(agentDir, "pi-codex-compat.json"),
			`${JSON.stringify({ auth: { disableApiKeyWhenCodexAuthenticated: false } }, null, 2)}\n`,
		);
		writeFileSync(
			join(cwd, ".pi", "pi-codex-compat.json"),
			`${JSON.stringify({ auth: { disableApiKeyWhenCodexAuthenticated: true } }, null, 2)}\n`,
		);

		const beforeEffective = loadPackageSettings(cwd, {
			agentDirOverride: agentDir,
			isProjectTrusted: true,
		}).settings.auth.disableApiKeyWhenCodexAuthenticated;
		assert.equal(beforeEffective, true);

		// updatePackageSettings contract: user-layer write only, no API change.
		await updatePackageSettings(
			(current) => ({
				...current,
				auth: {
					...current.auth,
					disableApiKeyWhenCodexAuthenticated: !current.auth.disableApiKeyWhenCodexAuthenticated,
				},
			}),
			cwd,
			{ isProjectTrusted: true },
		);
		const userWritten = JSON.parse(
			readFileSync(join(agentDir, "pi-codex-compat.json"), "utf8"),
		) as {
			auth?: { disableApiKeyWhenCodexAuthenticated?: boolean };
		};
		assert.equal(userWritten.auth?.disableApiKeyWhenCodexAuthenticated, false);
		const afterEffective = loadPackageSettings(cwd, {
			agentDirOverride: agentDir,
			isProjectTrusted: true,
		}).settings.auth.disableApiKeyWhenCodexAuthenticated;
		assert.equal(afterEffective, true);

		// Menu path: pin effective settings (on), toggle, refresh from disk under trusted project.
		const mock = createMockPi();
		piCodexCompat(mock.pi, {
			cwd,
			settings: {
				...baseSettings,
				auth: { disableApiKeyWhenCodexAuthenticated: true },
			},
			authState: { read: async () => ({ kind: "absent" }) },
		});
		let stage: "root" | "settings" = "root";
		const { ctx, notifications } = createMockContext({
			mode: "tui",
			hasUI: true,
			cwd,
			isProjectTrusted: () => true,
			select: async (_title: string, options: string[]) => {
				if (stage === "root") {
					stage = "settings";
					return "Settings";
				}
				return options.find((option) => option.startsWith("Block OpenAI API key"));
			},
		});
		await mock.commands.get("codex")!.handler("", ctx);
		assert.ok(
			notifications.some(
				(item) =>
					item.level === "warning" &&
					item.message.includes("trusted project override") &&
					item.message.includes("effective value unchanged"),
			),
			`expected project-override warning, got ${JSON.stringify(notifications)}`,
		);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

test("auth.json presence reader is read-only and detects oauth", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-codex-authjson-"));
	const authPath = join(root, "auth.json");
	assert.equal((await readOpenAICodexOAuthPresence({ authPath })).status, "absent");
	assert.equal(statSync(root).isDirectory(), true);
	// Missing file must not be created.
	assert.throws(() => readFileSync(authPath, "utf8"));

	writeFileSync(
		authPath,
		`${JSON.stringify({ "openai-codex": { type: "oauth", access: "tok", refresh: "ref", expires: 1 } }, null, 2)}\n`,
		{ mode: 0o600 },
	);
	chmodSync(authPath, 0o600);
	const before = readFileSync(authPath, "utf8");
	assert.equal((await readOpenAICodexOAuthPresence({ authPath })).status, "present");
	assert.equal(readFileSync(authPath, "utf8"), before);

	writeFileSync(
		authPath,
		`${JSON.stringify({ "openai-codex": { type: "api_key", key: "sk-test" } }, null, 2)}\n`,
	);
	assert.equal((await readOpenAICodexOAuthPresence({ authPath })).status, "absent");

	assert.equal(inspectAuthJsonContents("{").status, "unknown");
	assert.equal(
		inspectAuthJsonContents(JSON.stringify({ "openai-codex": "bad" })).status,
		"unknown",
	);
});

test("auth.json presence reader returns unknown on lock compromise", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-codex-auth-compromise-"));
	const authPath = join(root, "auth.json");
	writeFileSync(
		authPath,
		`${JSON.stringify({ "openai-codex": { type: "oauth", access: "tok", refresh: "ref", expires: 1 } }, null, 2)}\n`,
	);

	const result = await readOpenAICodexOAuthPresence({
		authPath,
		lock: async (_path, options) => {
			// Fire compromise after lock is granted; read would otherwise succeed.
			options?.onCompromised?.(new Error("lock compromised by peer"));
			return async () => undefined;
		},
	});
	assert.equal(result.status, "unknown");
	if (result.status === "unknown") {
		assert.match(result.message, /compromised|could not be determined/i);
		assert.equal(result.message.includes("tok"), false);
		assert.equal(result.message.includes("peer"), false);
	}
	// File contents untouched.
	assert.match(readFileSync(authPath, "utf8"), /"type": "oauth"/);
});

test("policy off or no codex credential leaves openai registration unchanged", async () => {
	const mock = boot({
		settings: { ...baseSettings, auth: { disableApiKeyWhenCodexAuthenticated: true } },
		authState: { read: async () => ({ kind: "absent" }) },
	});
	mock.rawPi.registerProvider("openai", {
		baseUrl: "https://proxy.example",
		models: [{ id: "kept" }],
	});
	const { ctx } = contextFor(mock, { model: openaiModel() });
	await emitAll(mock, "session_start", { type: "session_start" }, ctx);
	assert.deepEqual(mock.providers.get("openai"), {
		baseUrl: "https://proxy.example",
		models: [{ id: "kept" }],
	});
	assert.equal(mock.providerUnregistrations.length, 0);
});

test("default oauth and named account hide openai including empty-catalog models.json case", async () => {
	for (const state of [
		{ kind: "default_present" as const },
		{ kind: "named_selected" as const, accountName: "work" },
	]) {
		const mock = boot({
			settings: { ...baseSettings, auth: { disableApiKeyWhenCodexAuthenticated: true } },
			authState: { read: async () => state },
		});
		// Simulate prior models.json / extension models on openai.
		mock.rawPi.registerProvider("openai", {
			baseUrl: "https://api.openai.com/v1",
			models: [{ id: "gpt-4o" }, { id: "custom-from-models-json" }],
		});
		const { ctx } = contextFor(mock, { model: codexModel() });
		await emitAll(mock, "session_start", { type: "session_start" }, ctx);
		const current = mock.providers.get("openai") as { models?: unknown[]; baseUrl?: string };
		assert.deepEqual(current.models, []);
		assert.equal(current.baseUrl, "https://api.openai.com/v1");
	}
});

test("unknown auth and present auth both fail closed for stale openai gates", async () => {
	const unknownMock = boot({
		settings: { ...baseSettings, auth: { disableApiKeyWhenCodexAuthenticated: true } },
		authState: { read: async () => ({ kind: "unknown", message: "store locked" }) },
	});
	const unknownCtx = contextFor(unknownMock, { model: openaiModel() });
	let aborted = false;
	(unknownCtx.ctx as { abort: () => void }).abort = () => {
		aborted = true;
	};
	await emitAll(unknownMock, "turn_start", { type: "turn_start" }, unknownCtx.ctx);
	assert.equal(aborted, true);
	assert.ok(
		unknownCtx.notifications.some((item) => item.message.includes(UNKNOWN_AUTH_BLOCK_MESSAGE)),
	);

	const presentMock = boot({
		settings: { ...baseSettings, auth: { disableApiKeyWhenCodexAuthenticated: true } },
		authState: { read: async () => ({ kind: "default_present" }) },
	});
	const presentCtx = contextFor(presentMock, { model: openaiModel() });
	const compactResults = await emitAll(
		presentMock,
		"session_before_compact",
		{ type: "session_before_compact" },
		presentCtx.ctx,
	);
	assert.ok(compactResults.some((result) => (result as { cancel?: boolean })?.cancel === true));
	assert.ok(
		presentCtx.notifications.some((item) => item.message.includes(STALE_OPENAI_BLOCK_MESSAGE)),
	);

	const treeCancel = await emitAll(
		presentMock,
		"session_before_tree",
		{ type: "session_before_tree", preparation: { userWantsSummary: true } },
		presentCtx.ctx,
	);
	assert.ok(treeCancel.some((result) => (result as { cancel?: boolean })?.cancel === true));

	const treeAllow = await emitAll(
		presentMock,
		"session_before_tree",
		{ type: "session_before_tree", preparation: { userWantsSummary: false } },
		presentCtx.ctx,
	);
	assert.ok(treeAllow.every((result) => result === undefined));
});

test("openai-codex model remains allowed while policy blocks openai", async () => {
	const mock = boot({
		settings: { ...baseSettings, auth: { disableApiKeyWhenCodexAuthenticated: true } },
		authState: { read: async () => ({ kind: "default_present" }) },
	});
	const { ctx, notifications } = contextFor(mock, { model: codexModel() });
	let aborted = false;
	(ctx as { abort: () => void }).abort = () => {
		aborted = true;
	};
	await emitAll(mock, "turn_start", { type: "turn_start" }, ctx);
	assert.equal(aborted, false);
	assert.equal(notifications.length, 0);
});

test("restores legacy config, native provider, and builtin exactly; conflict is not clobbered", async () => {
	// Legacy restore
	const mutable = { kind: "default_present" as "default_present" | "absent" };
	const mock = boot({
		settings: { ...baseSettings, auth: { disableApiKeyWhenCodexAuthenticated: true } },
		authState: {
			read: async () =>
				mutable.kind === "default_present" ? { kind: "default_present" } : { kind: "absent" },
		},
	});
	mock.rawPi.registerProvider("openai", {
		baseUrl: "https://legacy.example",
		headers: { "X-Test": "1" },
		models: [{ id: "legacy-model" }],
	});
	const { ctx } = contextFor(mock, { model: openaiModel() });
	await emitAll(mock, "session_start", { type: "session_start" }, ctx);
	assert.deepEqual((mock.providers.get("openai") as { models?: unknown[] }).models, []);

	mutable.kind = "absent";
	await emitAll(mock, "model_select", { type: "model_select", model: openaiModel() }, ctx);
	assert.deepEqual(mock.providers.get("openai"), {
		baseUrl: "https://legacy.example",
		headers: { "X-Test": "1" },
		models: [{ id: "legacy-model" }],
	});

	// Native restore
	const nativeState = { on: true };
	const nativeMock = boot({
		settings: { ...baseSettings, auth: { disableApiKeyWhenCodexAuthenticated: true } },
		authState: {
			read: async () => (nativeState.on ? { kind: "default_present" } : { kind: "absent" }),
		},
	});
	const nativeProvider = { id: "openai", name: "Native OpenAI", models: [] };
	nativeMock.rawPi.registerProvider(nativeProvider);
	assert.equal(nativeMock.nativeProviders.get("openai"), nativeProvider);
	const nativeCtx = contextFor(nativeMock, { model: openaiModel() });
	await emitAll(nativeMock, "session_start", { type: "session_start" }, nativeCtx.ctx);
	assert.equal(nativeMock.nativeProviders.has("openai"), false);
	assert.deepEqual((nativeMock.providers.get("openai") as { models?: unknown[] }).models, []);
	nativeState.on = false;
	await emitAll(
		nativeMock,
		"model_select",
		{ type: "model_select", model: openaiModel() },
		nativeCtx.ctx,
	);
	assert.equal(nativeMock.nativeProviders.get("openai"), nativeProvider);

	// Builtin restore
	const builtinState = { on: true };
	const builtinMock = boot({
		settings: { ...baseSettings, auth: { disableApiKeyWhenCodexAuthenticated: true } },
		authState: {
			read: async () => (builtinState.on ? { kind: "default_present" } : { kind: "absent" }),
		},
	});
	const builtinCtx = contextFor(builtinMock, { model: openaiModel() });
	await emitAll(builtinMock, "session_start", { type: "session_start" }, builtinCtx.ctx);
	assert.deepEqual((builtinMock.providers.get("openai") as { models?: unknown[] }).models, []);
	builtinState.on = false;
	await emitAll(
		builtinMock,
		"model_select",
		{ type: "model_select", model: openaiModel() },
		builtinCtx.ctx,
	);
	assert.equal(builtinMock.providers.has("openai"), false);

	// Conflict: foreign registration while owned
	const conflictMock = boot({
		settings: { ...baseSettings, auth: { disableApiKeyWhenCodexAuthenticated: true } },
		authState: { read: async () => ({ kind: "default_present" }) },
	});
	const conflictCtx = contextFor(conflictMock, { model: openaiModel() });
	await emitAll(conflictMock, "session_start", { type: "session_start" }, conflictCtx.ctx);
	// Foreign extension changes registration.
	conflictMock.rawPi.registerProvider("openai", { models: [{ id: "foreign" }] });
	await emitAll(
		conflictMock,
		"model_select",
		{ type: "model_select", model: openaiModel() },
		conflictCtx.ctx,
	);
	assert.deepEqual(conflictMock.providers.get("openai"), { models: [{ id: "foreign" }] });
	assert.ok(
		conflictCtx.notifications.some((item) => item.message.includes(PROVIDER_CONFLICT_MESSAGE)),
	);
	// Blocking still active for stale turns.
	let aborted = false;
	(conflictCtx.ctx as { abort: () => void }).abort = () => {
		aborted = true;
	};
	await emitAll(conflictMock, "turn_start", { type: "turn_start" }, conflictCtx.ctx);
	assert.equal(aborted, true);
});

test("owned openai restores on session_shutdown; reload re-hides then release restores original", async () => {
	const auth = { kind: "default_present" as "default_present" | "absent" };
	const mock = boot({
		settings: { ...baseSettings, auth: { disableApiKeyWhenCodexAuthenticated: true } },
		authState: {
			read: async () =>
				auth.kind === "default_present" ? { kind: "default_present" } : { kind: "absent" },
		},
	});
	mock.rawPi.registerProvider("openai", {
		baseUrl: "https://shutdown.example",
		models: [{ id: "keep-me" }],
	});
	const { ctx } = contextFor(mock, { model: openaiModel() });
	await emitAll(mock, "session_start", { type: "session_start" }, ctx);
	assert.deepEqual((mock.providers.get("openai") as { models?: unknown[] }).models, []);

	// Shutdown release is first registered handler and restores owned registration.
	const shutdownHandlers = mock.events.get("session_shutdown") ?? [];
	assert.ok(shutdownHandlers.length >= 1);
	await emitAll(mock, "session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
	assert.deepEqual(mock.providers.get("openai"), {
		baseUrl: "https://shutdown.example",
		models: [{ id: "keep-me" }],
	});

	// Reload path: re-hide then release again restores original.
	await emitAll(mock, "session_start", { type: "session_start" }, ctx);
	assert.deepEqual((mock.providers.get("openai") as { models?: unknown[] }).models, []);
	await emitAll(mock, "session_shutdown", { type: "session_shutdown", reason: "reload" }, ctx);
	assert.deepEqual(mock.providers.get("openai"), {
		baseUrl: "https://shutdown.example",
		models: [{ id: "keep-me" }],
	});
});

test("after provider conflict, auth absence still blocks openai until release/reload", async () => {
	const auth = { kind: "default_present" as "default_present" | "absent" };
	const mock = boot({
		settings: { ...baseSettings, auth: { disableApiKeyWhenCodexAuthenticated: true } },
		authState: {
			read: async () =>
				auth.kind === "default_present" ? { kind: "default_present" } : { kind: "absent" },
		},
	});
	mock.rawPi.registerProvider("openai", { models: [{ id: "orig" }] });
	const { ctx, notifications } = contextFor(mock, { model: openaiModel() });
	await emitAll(mock, "session_start", { type: "session_start" }, ctx);
	mock.rawPi.registerProvider("openai", { models: [{ id: "foreign" }] });
	await emitAll(mock, "model_select", { type: "model_select", model: openaiModel() }, ctx);
	assert.ok(notifications.some((item) => item.message.includes(PROVIDER_CONFLICT_MESSAGE)));
	assert.deepEqual(mock.providers.get("openai"), { models: [{ id: "foreign" }] });

	// Logout / auth absence must not unblock openai while conflict is latched.
	auth.kind = "absent";
	await emitAll(mock, "model_select", { type: "model_select", model: openaiModel() }, ctx);
	// Never retake ownership / clobber foreign registration.
	assert.deepEqual(mock.providers.get("openai"), { models: [{ id: "foreign" }] });

	let aborted = false;
	(ctx as { abort: () => void }).abort = () => {
		aborted = true;
	};
	await emitAll(mock, "turn_start", { type: "turn_start" }, ctx);
	assert.equal(aborted, true);

	// Release/reload clears latch; with auth absent, openai is allowed again and foreign kept.
	await emitAll(mock, "session_shutdown", { type: "session_shutdown", reason: "reload" }, ctx);
	assert.deepEqual(mock.providers.get("openai"), { models: [{ id: "foreign" }] });
	aborted = false;
	await emitAll(mock, "session_start", { type: "session_start" }, ctx);
	await emitAll(mock, "turn_start", { type: "turn_start" }, ctx);
	assert.equal(aborted, false);
});

test("mid-run auth/settings changes enforce on next turn_start; no auto model switch or env mutation", async () => {
	const previousKey = process.env.OPENAI_API_KEY;
	process.env.OPENAI_API_KEY = "sk-keep-me";
	try {
		const state = { kind: "absent" as "absent" | "default_present" };
		const settings = {
			...baseSettings,
			auth: { disableApiKeyWhenCodexAuthenticated: true },
		};
		const mock = boot({
			settings,
			authState: {
				read: async () =>
					state.kind === "default_present" ? { kind: "default_present" } : { kind: "absent" },
			},
		});
		const { ctx, notifications } = contextFor(mock, { model: openaiModel() });
		let aborted = false;
		(ctx as { abort: () => void }).abort = () => {
			aborted = true;
		};
		await emitAll(mock, "turn_start", { type: "turn_start" }, ctx);
		assert.equal(aborted, false);

		state.kind = "default_present";
		aborted = false;
		await emitAll(mock, "turn_start", { type: "turn_start" }, ctx);
		assert.equal(aborted, true);
		assert.ok(notifications.some((item) => item.message.includes(STALE_OPENAI_BLOCK_MESSAGE)));
		assert.equal(mock.setModels.length, 0);
		assert.equal(process.env.OPENAI_API_KEY, "sk-keep-me");
	} finally {
		if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = previousKey;
	}
});

test("auth-policy compact gate registers before native compaction handler", () => {
	const mock = boot({
		settings: {
			...baseSettings,
			openaiNativeCompaction: { ...baseSettings.openaiNativeCompaction, enabled: true },
			auth: { disableApiKeyWhenCodexAuthenticated: true },
		},
		authState: { read: async () => ({ kind: "default_present" }) },
	});
	const handlers = mock.events.get("session_before_compact") ?? [];
	assert.ok(handlers.length >= 2);
	// First handler is auth policy (returns cancel object); compaction is later.
});

test("/codex status and Status menu await reconcile for fresh auth", async () => {
	const auth = { kind: "absent" as "absent" | "default_present" };
	const mock = boot({
		settings: { ...baseSettings, auth: { disableApiKeyWhenCodexAuthenticated: true } },
		authState: {
			read: async () =>
				auth.kind === "default_present" ? { kind: "default_present" } : { kind: "absent" },
		},
	});
	const { ctx, notifications } = contextFor(mock, {
		mode: "rpc",
		hasUI: true,
		model: openaiModel(),
	});
	await emitAll(mock, "session_start", { type: "session_start" }, ctx);
	await mock.commands.get("codex")!.handler("status", ctx);
	assert.ok(notifications.some((item) => item.message.includes("Direct OpenAI API key: allowed")));

	// External default /login between status checks.
	auth.kind = "default_present";
	notifications.length = 0;
	await mock.commands.get("codex")!.handler("status", ctx);
	assert.ok(
		notifications.some((item) =>
			item.message.includes("Direct OpenAI API key: blocked while Codex is logged in"),
		),
	);
	assert.ok(
		notifications.some((item) =>
			item.message.includes("Block OpenAI API key when Codex logged in: on"),
		),
	);

	// Status menu path also reconciles.
	auth.kind = "absent";
	notifications.length = 0;
	const tui = contextFor(mock, {
		mode: "tui",
		hasUI: true,
		model: openaiModel(),
		select: async () => "Status",
	});
	await mock.commands.get("codex")!.handler("", tui.ctx);
	assert.ok(
		tui.notifications.some((item) => item.message.includes("Direct OpenAI API key: allowed")),
	);

	await mock.commands.get("codex")!.handler("help", ctx);
	assert.ok(
		notifications.some((item) => item.message.includes("auth.disableApiKeyWhenCodexAuthenticated")),
	);
});

test("codex auth state reads both stores; any unknown wins even if named selected", async () => {
	const namedWins = createCodexAuthStateReader({
		readNamedSelection: async () => ({ status: "selected", accountName: "work" }),
		readDefaultPresence: async () => ({ status: "present" }),
	});
	assert.deepEqual(await namedWins.read(), { kind: "named_selected", accountName: "work" });

	const unknownDefaultBeatsNamed = createCodexAuthStateReader({
		readNamedSelection: async () => ({ status: "selected", accountName: "work" }),
		readDefaultPresence: async () => ({
			status: "unknown",
			message: "auth.json lock was compromised.",
		}),
	});
	const unknownState = await unknownDefaultBeatsNamed.read();
	assert.equal(unknownState.kind, "unknown");
	if (unknownState.kind === "unknown") {
		assert.match(unknownState.message, /compromised/i);
	}

	const unknownNamed = createCodexAuthStateReader({
		readNamedSelection: async () => ({
			status: "unknown",
			message: "Named Codex account store could not be read: Bearer secret-token",
		}),
		readDefaultPresence: async () => ({ status: "present" }),
	});
	const namedUnknown = await unknownNamed.read();
	assert.equal(namedUnknown.kind, "unknown");
	if (namedUnknown.kind === "unknown") {
		assert.equal(namedUnknown.message.includes("secret-token"), false);
	}
});
