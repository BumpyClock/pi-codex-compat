import assert from "node:assert/strict";
import test from "node:test";
import piCodexCompat from "../src/pi-codex-compat.js";
import { createMockContext, createMockPi } from "./support.js";

const disabledSettings = {
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

function boot() {
	const mock = createMockPi();
	piCodexCompat(mock.pi, { settings: { ...disabledSettings } });
	return mock;
}

test("registers expected commands", () => {
	const { commands } = boot();
	for (const name of ["codex", "accounts", "usage", "usage-history", "fast"]) {
		assert.ok(commands.has(name), `missing command ${name}`);
	}
});

test("/codex rejects unknown routes in tui via notify", async () => {
	const { commands } = boot();
	const { ctx, notifications } = createMockContext({ mode: "tui", hasUI: true });
	await commands.get("codex")!.handler("rotate", ctx);
	assert.ok(notifications.some((item) => item.message.includes("Unknown /codex route")));
});

test("/codex unknown routes throw in print and json modes", async () => {
	const { commands } = boot();
	const print = createMockContext({ mode: "print", hasUI: false });
	const json = createMockContext({ mode: "json", hasUI: false });
	await assert.rejects(
		async () => commands.get("codex")!.handler("rotate", print.ctx),
		/Unknown \/codex route/,
	);
	await assert.rejects(
		async () => commands.get("codex")!.handler("rotate", json.ctx),
		/Unknown \/codex route/,
	);
});

test("/codex status works in rpc mode", async () => {
	const { commands } = boot();
	const { ctx, notifications } = createMockContext({ mode: "rpc", hasUI: true });
	await commands.get("codex")!.handler("status", ctx);
	assert.ok(notifications.some((item) => item.message.includes("pi-codex-compat status")));
});

test("/codex menu is tui-only and notifies in rpc", async () => {
	const { commands } = boot();
	const { ctx, notifications } = createMockContext({ mode: "rpc", hasUI: true });
	await commands.get("codex")!.handler("", ctx);
	assert.ok(notifications.some((item) => item.message.includes("requires TUI")));
});

test("/accounts and /usage throw in print mode", async () => {
	const { commands } = boot();
	const { ctx } = createMockContext({ mode: "print", hasUI: false });
	await assert.rejects(async () => commands.get("accounts")!.handler("", ctx), /print mode/);
	await assert.rejects(async () => commands.get("usage")!.handler("", ctx), /print mode/);
});

test("/usage-history sends the historical prompt in tui", async () => {
	const { commands, sentUserMessages } = boot();
	const { ctx } = createMockContext({
		mode: "tui",
		hasUI: true,
		waitForIdle: async () => undefined,
	});
	await commands.get("usage-history")!.handler("", ctx);
	assert.equal(sentUserMessages.length, 1);
	assert.match(sentUserMessages[0]!.text, /Pi usage report/);
});

test("/codex help works and /fast status works in rpc", async () => {
	const { commands } = boot();
	const { ctx, notifications } = createMockContext({ mode: "rpc", hasUI: true });
	await commands.get("codex")!.handler("help", ctx);
	await commands.get("fast")!.handler("status", ctx);
	assert.ok(notifications.some((item) => item.message.includes("/fast")));
	assert.ok(notifications.some((item) => item.message.includes("fast mode")));
});
