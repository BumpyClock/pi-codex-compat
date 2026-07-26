import assert from "node:assert/strict";
import test from "node:test";
import { registerTps, TPS_STATUS_KEY } from "../src/tps/tps.js";
import { createMockContext, createMockPi } from "./support.js";

test("tps tracks streamed estimates and clears on shutdown", async () => {
	const { pi, events } = createMockPi();
	registerTps(pi, { enabled: true, notifyOnComplete: true });
	const { ctx, statuses, notifications } = createMockContext({ mode: "tui", hasUI: true });

	for (const handler of events.get("agent_start") ?? []) await handler({}, ctx);
	assert.ok(statuses.get(TPS_STATUS_KEY)?.includes("generating"));

	for (const handler of events.get("message_start") ?? []) {
		await handler({ message: { role: "assistant", usage: { output: 0 } } }, ctx);
	}
	// First delta establishes streamStart; second delta with elapsed > 0 updates status.
	const updates = events.get("message_update") ?? [];
	for (const handler of updates) {
		await handler(
			{
				message: { role: "assistant", usage: { output: 0 } },
				assistantMessageEvent: { type: "text_delta", delta: "abcd".repeat(20) },
			},
			ctx,
		);
	}
	await new Promise((resolve) => setTimeout(resolve, 20));
	for (const handler of updates) {
		await handler(
			{
				message: { role: "assistant", usage: { output: 16 } },
				assistantMessageEvent: { type: "text_delta", delta: "efgh".repeat(20) },
			},
			ctx,
		);
	}
	assert.ok(String(statuses.get(TPS_STATUS_KEY) ?? "").includes("tok"));

	for (const handler of events.get("message_end") ?? []) {
		await handler({ message: { role: "assistant", usage: { output: 40 } } }, ctx);
	}
	for (const handler of events.get("agent_end") ?? []) await handler({}, ctx);
	assert.ok(
		notifications.some((item) => item.message.includes("tok/s") || item.message.includes("N/A")),
	);

	for (const handler of events.get("session_shutdown") ?? []) await handler({}, ctx);
	assert.equal(statuses.get(TPS_STATUS_KEY), undefined);
});

test("tps disabled skips status updates", async () => {
	const { pi, events } = createMockPi();
	registerTps(pi, { enabled: false, notifyOnComplete: false });
	const { ctx, statuses } = createMockContext({ mode: "tui", hasUI: true });
	for (const handler of events.get("agent_start") ?? []) await handler({}, ctx);
	assert.equal(statuses.get(TPS_STATUS_KEY), undefined);
});
