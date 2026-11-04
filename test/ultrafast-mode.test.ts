import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AccountStore } from "../src/accounts/account-store.js";
import { InMemoryAccountStorageBackend } from "../src/accounts/storage.js";
import { createFastModeController, registerFastMode } from "../src/fast-mode/fast-mode.js";
import piCodexCompat from "../src/pi-codex-compat.js";
import { loadPackageSettings } from "../src/settings/load.js";
import type { FastModeSettings, PackageSettings, SpeedMode } from "../src/settings/types.js";
import { createMockContext, createMockPi } from "./support.js";

const astra = { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-6-astra" };
const sol = { provider: "openai", api: "openai-responses", id: "gpt-6.1-sol" };
const unsupported = { provider: "openai", api: "openai-responses", id: "gpt-5-mini" };
const selections: Record<SpeedMode, FastModeSettings> = {
	standard: { enabled: false },
	fast: { enabled: true, tier: "priority" },
	ultrafast: { enabled: true, tier: "ultrafast" },
};

function payload(model = astra.id) {
	return {
		model,
		stream: true,
		instructions: "system",
		input: [{ type: "message", role: "user", content: "hi" }],
		tool_choice: "auto",
		prompt_cache_key: "cache-regression",
		temperature: 0.2,
		metadata: { retained: true },
	};
}

async function disabledOAuth(): Promise<never> {
	assert.fail("OAuth disabled in speed-mode tests");
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-ultrafast-test-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	await mkdir(agentDir);
	await mkdir(cwd);
	const settingsPath = join(agentDir, "pi-codex-compat.json");
	const disabled: Omit<PackageSettings, "fastMode"> = {
		openaiNativeCompaction: {
			enabled: false,
			debug: false,
			logProviderPayloads: false,
			logCompactResponses: false,
			redactSensitiveData: true,
			artifactRoot: join(root, "artifacts"),
			supportedProviders: ["openai", "openai-codex"],
			supportedApis: ["openai-responses", "openai-codex-responses"],
			notifyOnLoad: false,
		},
		tps: { enabled: false, notifyOnComplete: false },
		auth: { disableApiKeyWhenCodexAuthenticated: false },
	};
	const seed = async (fastMode?: FastModeSettings) => {
		await writeFile(
			settingsPath,
			JSON.stringify({ ...disabled, ...(fastMode ? { fastMode } : {}), unrelated: { keep: true } }),
		);
	};
	await seed();
	const live: Array<{
		mock: ReturnType<typeof createMockPi>;
		context: ReturnType<typeof createMockContext>;
	}> = [];
	return {
		root,
		agentDir,
		cwd,
		settingsPath,
		seed,
		async saved() {
			return JSON.parse(await readFile(settingsPath, "utf8"));
		},
		boot(fastMode?: FastModeSettings, overrides: Record<string, unknown> = {}) {
			const mock = createMockPi();
			piCodexCompat(mock.pi, {
				cwd,
				...(fastMode ? { settings: { ...disabled, fastMode } } : {}),
				accounts: {
					providers: [
						{
							id: "openai-codex",
							displayName: "OpenAI Codex",
							requiresApiKeyBridge: false,
							oauth: { login: disabledOAuth, refresh: disabledOAuth, toAuth: disabledOAuth },
						},
					],
					store: new AccountStore(new InMemoryAccountStorageBackend()),
				},
				authState: { read: async () => ({ kind: "absent" }) },
				authPath: join(agentDir, "unused-auth.json"),
			});
			const context = createMockContext({
				cwd,
				mode: "tui",
				hasUI: true,
				model: astra,
				...overrides,
			});
			live.push({ mock, context });
			return {
				...mock,
				...context,
				command: async (name: string, args = "") => {
					const command = mock.commands.get(name);
					assert.ok(command, `missing /${name}`);
					await command.handler(args, context.ctx);
				},
				async emit(name: string, event: unknown = {}) {
					for (const handler of mock.events.get(name) ?? []) await handler(event, context.ctx);
				},
				async request(original = payload()) {
					let current: unknown = original;
					const handlers = mock.events.get("before_provider_request") ?? [];
					assert.ok(handlers.length, "provider request pipeline registered");
					for (const handler of handlers) {
						const next = await handler({ payload: current }, context.ctx);
						if (next !== undefined) current = next;
					}
					return JSON.parse(JSON.stringify(current));
				},
			};
		},
		async close() {
			for (const { mock, context } of live) {
				for (const handler of mock.events.get("session_shutdown") ?? [])
					await handler({}, context.ctx);
			}
			await rm(root, { recursive: true, force: true });
		},
	};
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function regression(name: string, run: (f: Fixture) => Promise<void>) {
	test(name, async (t) => {
		const f = await fixture();
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = f.agentDir;
		const network = t.mock.method(globalThis, "fetch", () => {
			throw new Error("Unexpected network request");
		});
		try {
			await run(f);
			assert.equal(network.mock.callCount(), 0, "no network requests");
		} finally {
			try {
				await f.close();
			} finally {
				if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
				else process.env.PI_CODING_AGENT_DIR = previous;
			}
		}
	});
}

regression(
	"default off and legacy enabled-without-tier retain priority, never Ultrafast",
	async (f) => {
		for (const [settings, expected] of [
			[undefined, undefined],
			[{ enabled: false, tier: "ultrafast" }, undefined],
			[{ enabled: true }, "priority"],
			[{ enabled: true, tier: "priority" }, "priority"],
		] as const) {
			await f.seed(settings);
			const app = f.boot();
			await app.emit("session_start");
			assert.equal((await app.request()).service_tier, expected);
		}
	},
);

for (const model of [astra, { ...astra, id: sol.id }, sol, { ...sol, id: astra.id }]) {
	regression(
		`command -> serialized Ultrafast request for ${model.provider}/${model.id}`,
		async (f) => {
			const app = f.boot(selections.standard, { model });
			const original = payload(model.id);
			const before = structuredClone(original);
			await app.command("ultrafast", "on");
			assert.deepEqual(await app.request(original), { ...before, service_tier: "ultrafast" });
			assert.deepEqual(original, before, "caller payload not mutated");
			assert.ok(
				app.notifications.some((n) => n.level === "warning" && /cost|pric/i.test(n.message)),
			);
			const saved = await f.saved();
			assert.deepEqual(saved.fastMode, { enabled: true, tier: "ultrafast" });
			assert.deepEqual(saved.unrelated, { keep: true });
			assert.deepEqual(saved.auth, { disableApiKeyWhenCodexAuthenticated: false });
			assert.deepEqual(await readdir(f.agentDir), ["pi-codex-compat.json"]);
			assert.deepEqual(app.providerRegistrations, []);
			assert.deepEqual(app.setModels, []);
			const reloaded = f.boot(undefined, { model });
			await reloaded.emit("session_start");
			assert.equal((await reloaded.request(payload(model.id))).service_tier, "ultrafast");
		},
	);
}

for (const [name, model, requestModel] of [
	["wrong provider", { ...astra, provider: "custom-provider" }, astra.id],
	["Codex with OpenAI API", { ...astra, api: "openai-responses" }, astra.id],
	["OpenAI with Codex API", { ...sol, api: "openai-codex-responses" }, sol.id],
	["chat completions API", { ...sol, api: "openai-completions" }, sol.id],
	["missing provider", { api: astra.api, id: astra.id }, astra.id],
	["missing API", { provider: astra.provider, id: astra.id }, astra.id],
	["missing model ID", { provider: astra.provider, api: astra.api }, astra.id],
	["older model", { ...astra, id: "gpt-5.3-codex" }, "gpt-5.3-codex"],
	["model suffix", { ...astra, id: "gpt-6-astra-preview" }, "gpt-6-astra-preview"],
	["model prefix", { ...sol, id: "custom-gpt-6.1-sol" }, "custom-gpt-6.1-sol"],
	["model case", { ...astra, id: "GPT-6-ASTRA" }, "GPT-6-ASTRA"],
	["other eligible payload model", astra, sol.id],
	["ineligible payload model", sol, "gpt-5-mini"],
] as const) {
	regression(`saved Ultrafast skips injection for ${name}`, async (f) => {
		const app = f.boot(selections.ultrafast, { model });
		const original = { ...payload(requestModel), service_tier: "auto" };
		assert.deepEqual(await app.request(original), original);
	});
}

regression("Ultrafast rejects missing payload.model and non-object payloads", async () => {
	const controller = createFastModeController(selections.ultrafast);
	for (const value of [null, undefined, "text", [], {}, { ...payload(), model: undefined }]) {
		assert.equal(controller.applyPayload(value, astra), undefined);
	}
});

for (const command of ["ultrafast", "utrafast"]) {
	for (const initial of ["standard", "fast"] as const) {
		regression(
			`/${command} on unsupported model retains ${initial} and saved settings`,
			async (f) => {
				await f.seed(selections[initial]);
				const before = await readFile(f.settingsPath, "utf8");
				const app = f.boot(selections[initial], { model: unsupported });
				await app.command(command, "on");
				assert.equal(await readFile(f.settingsPath, "utf8"), before);
				assert.ok(
					app.notifications.some(
						(n) => n.level === "warning" && /requires|unsupported/i.test(n.message),
					),
				);
				const codex = createMockContext({ cwd: f.cwd, model: astra });
				const result = (await app.events.get("before_provider_request")![0]!(
					{ payload: payload() },
					codex.ctx,
				)) as Record<string, unknown> | undefined;
				assert.equal(result?.service_tier, initial === "fast" ? "priority" : undefined);
			},
		);
	}
}

for (const [initial, command, action, expected] of [
	["standard", "ultrafast", "", "ultrafast"],
	["standard", "utrafast", "toggle", "ultrafast"],
	["fast", "ultrafast", "on", "ultrafast"],
	["ultrafast", "fast", "on", "fast"],
	["ultrafast", "fast", "toggle", "fast"],
	["ultrafast", "fast", "off", "ultrafast"],
	["fast", "ultrafast", "off", "fast"],
	["fast", "utrafast", "off", "fast"],
	["ultrafast", "ultrafast", "off", "standard"],
	["ultrafast", "utrafast", "toggle", "standard"],
	["ultrafast", "ultrafast", "", "standard"],
	["ultrafast", "ultrafast", "on", "ultrafast"],
	["fast", "fast", "off", "standard"],
] as const) {
	regression(`${initial}: /${command} ${action || "(no args)"} -> ${expected}`, async (f) => {
		await f.seed(selections[initial]);
		const app = f.boot(selections[initial]);
		await app.command(command, action);
		const tier =
			expected === "standard" ? undefined : expected === "fast" ? "priority" : "ultrafast";
		assert.equal((await app.request()).service_tier, tier);
		const reloaded = f.boot();
		await reloaded.emit("session_start");
		assert.equal((await reloaded.request()).service_tier, tier);
	});
}

regression(
	"controller exposes one mode and waits for persistence before changing it",
	async (f) => {
		const controller = createFastModeController(selections.standard);
		const mock = createMockPi();
		registerFastMode(mock.pi, controller, { cwd: f.cwd });
		const ui = createMockContext({ cwd: f.cwd, model: astra, mode: "rpc", hasUI: true });
		const pending = mock.commands.get("ultrafast")!.handler("on", ui.ctx);
		assert.equal(controller.getMode(), "standard");
		assert.equal(controller.applyPayload(payload(), astra), undefined);
		await pending;
		assert.deepEqual((await f.saved()).fastMode, { enabled: true, tier: "ultrafast" });
		assert.equal(controller.getMode(), "ultrafast");
		controller.setMode("fast");
		assert.equal(controller.getMode(), "fast");
		assert.equal(
			(controller.applyPayload(payload(), astra) as Record<string, unknown>).service_tier,
			"priority",
		);
		controller.setMode("standard");
		assert.equal(controller.getMode(), "standard");
		assert.equal(controller.applyPayload(payload(), astra), undefined);
	},
);

regression(
	"unsupported model switch keeps saved Ultrafast but reports inactive until supported again",
	async (f) => {
		const app = f.boot(selections.standard, { model: sol });
		await app.command("ultrafast", "on");
		const before = await readFile(f.settingsPath, "utf8");
		await app.emit("model_select", { model: unsupported });
		assert.match(app.statuses.get("codex-fast-mode") ?? "", /ultrafast.*inactive/i);
		assert.ok(app.notifications.some((n) => n.level === "warning" && /inactive/i.test(n.message)));
		const switched = f.boot(undefined, { model: unsupported });
		await switched.emit("session_start");
		assert.deepEqual(await switched.request(payload(unsupported.id)), payload(unsupported.id));
		for (const name of ["ultrafast", "codex"]) {
			await switched.command(name, "status");
			assert.match(switched.notifications.at(-1)!.message, /ultrafast.*inactive/is);
		}
		assert.equal(await readFile(f.settingsPath, "utf8"), before);
		await app.emit("model_select", { model: sol });
		assert.match(app.statuses.get("codex-fast-mode") ?? "", /ultrafast:on/);
		assert.equal((await app.request(payload(sol.id))).service_tier, "ultrafast");
		assert.equal(
			loadPackageSettings(f.cwd, { agentDirOverride: f.agentDir }).settings.fastMode.tier,
			"ultrafast",
		);
	},
);

for (const mode of ["tui", "rpc"]) {
	for (const name of ["fast", "ultrafast", "utrafast"]) {
		regression(`/${name} toggle/on/off/status works in ${mode}`, async (f) => {
			const app = f.boot(selections.standard, { mode, hasUI: true });
			const tier = name === "fast" ? "priority" : "ultrafast";
			for (const [action, expected] of [
				["on", tier],
				["status", tier],
				["off", undefined],
				["toggle", tier],
				["", undefined],
			] as const) {
				await app.command(name, action);
				assert.equal((await app.request()).service_tier, expected);
			}
			assert.ok(app.notifications.some((n) => n.level === "info" && /mode is/i.test(n.message)));
		});
	}
}

for (const mode of ["print", "json"]) {
	regression(
		`speed commands reject all actions in ${mode} without changing saved mode`,
		async (f) => {
			await f.seed(selections.ultrafast);
			const before = await readFile(f.settingsPath, "utf8");
			const app = f.boot(selections.ultrafast, { mode, hasUI: false });
			for (const name of ["fast", "ultrafast", "utrafast"]) {
				for (const action of ["", "toggle", "on", "off", "status"]) {
					await assert.rejects(
						() => app.command(name, action),
						new RegExp(`not supported in ${mode} mode`),
					);
				}
			}
			assert.equal(await readFile(f.settingsPath, "utf8"), before);
			assert.equal((await app.request()).service_tier, "ultrafast");
		},
	);
}

regression(
	"speed status, invalid args and completions are observable without changing selection",
	async (f) => {
		await f.seed(selections.ultrafast);
		const app = f.boot(selections.ultrafast);
		const before = await readFile(f.settingsPath, "utf8");
		for (const name of ["fast", "ultrafast", "utrafast"]) {
			await app.command(name, "status");
			assert.match(app.notifications.at(-1)!.message, /fast mode is off.*ultrafast mode is on/is);
			await app.command(name, "turbo");
			assert.match(app.notifications.at(-1)!.message, /usage:.*toggle\|on\|off\|status/i);
			const complete = app.commands.get(name)!.getArgumentCompletions!;
			assert.deepEqual(
				complete(""),
				["toggle", "on", "off", "status"].map((value) => ({ value, label: value })),
			);
			assert.deepEqual(
				complete(" o"),
				["on", "off"].map((value) => ({ value, label: value })),
			);
			assert.equal(complete("missing"), null);
		}
		await app.command("codex", "status");
		assert.match(app.notifications.at(-1)!.message, /fast mode: off\s+ultrafast mode: on/i);
		await app.command("codex", "help");
		assert.match(app.notifications.at(-1)!.message, /\/ultrafast/);
		assert.match(app.notifications.at(-1)!.message, /\/utrafast/);
		assert.equal(await readFile(f.settingsPath, "utf8"), before);
	},
);

for (const [initial, command, action] of [
	["standard", "ultrafast", "on"],
	["fast", "utrafast", "on"],
	["ultrafast", "fast", "on"],
	["ultrafast", "ultrafast", "off"],
	["standard", "codex", ""],
] as const) {
	regression(`save failure retains ${initial} for /${command} ${action}`, async (f) => {
		await f.seed(selections[initial]);
		const before = await readFile(f.settingsPath, "utf8");
		const app = f.boot(selections[initial], { select: async () => "Ultrafast mode (off)" });
		const backup = `${f.settingsPath}.backup`;
		await rename(f.settingsPath, backup);
		await mkdir(f.settingsPath);
		await app.command(command, action);
		assert.ok(app.notifications.some((n) => n.level === "error" && /save/i.test(n.message)));
		const tier = initial === "standard" ? undefined : initial === "fast" ? "priority" : "ultrafast";
		assert.equal((await app.request()).service_tier, tier);
		await rm(f.settingsPath, { recursive: true });
		await rename(backup, f.settingsPath);
		assert.equal(await readFile(f.settingsPath, "utf8"), before);
	});
}

for (const model of [sol, unsupported]) {
	regression(
		`Codex manager uses Ultrafast command persistence/validation for ${model.id}`,
		async (f) => {
			const choices: string[][] = [];
			const menu = f.boot(selections.standard, {
				model,
				select: async (_title: string, items: string[]) => {
					choices.push(items);
					return items.find((item) => item.startsWith("Ultrafast mode"));
				},
			});
			await menu.command("codex");
			assert.ok(choices[0]!.some((item) => /Ultrafast.*off/i.test(item)));
			const menuSaved = await f.saved();
			const menuMessages = [...menu.notifications];
			await f.seed();
			const command = f.boot(selections.standard, { model });
			await command.command("ultrafast", "on");
			assert.deepEqual(await f.saved(), menuSaved);
			assert.deepEqual(command.notifications, menuMessages);
			assert.deepEqual(
				await menu.request(payload(model.id)),
				await command.request(payload(model.id)),
			);
			if (model === sol) {
				assert.ok(menuMessages.some((n) => n.level === "warning" && /cost|pric/i.test(n.message)));
				await menu.command("codex");
				assert.ok(choices[1]!.some((item) => /Ultrafast.*on/i.test(item)));
				assert.equal((await menu.request(payload(model.id))).service_tier, undefined);
				const reloaded = f.boot();
				await reloaded.emit("session_start");
				assert.equal((await reloaded.request()).service_tier, undefined);
			}
		},
	);
}
