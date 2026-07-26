import assert from "node:assert/strict";
import test from "node:test";
import { resolveLatestNativeCompactionEntry } from "../src/compaction/details-store.js";
import {
	createNativeCompactionDetails,
	createNativeCompactionShimResult,
	isNativeCompactionDetails,
	NATIVE_COMPACTION_SHIM_SUMMARY,
	NATIVE_COMPACTION_STRATEGY,
} from "../src/compaction/types.js";

test("pins pre-upgrade native compaction schema and shim summary", () => {
	const details = createNativeCompactionDetails({
		provider: "openai-codex",
		api: "openai-codex-responses",
		model: "gpt-5.3-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		compactedWindow: [
			{
				type: "item_reference",
				id: "item_123",
			},
		],
		compactResponseId: "resp_abc",
		createdAt: "2026-01-01T00:00:00.000Z",
		requestMeta: { tokensBefore: 12000, previousSummaryPresent: false },
	});

	assert.equal(details.strategy, NATIVE_COMPACTION_STRATEGY);
	assert.equal(details.strategy, "openai-native-compact-v1");
	assert.equal(isNativeCompactionDetails(details), true);

	const shim = createNativeCompactionShimResult({
		firstKeptEntryId: "entry-keep",
		tokensBefore: 12000,
		details,
	});
	assert.equal(shim.summary, NATIVE_COMPACTION_SHIM_SUMMARY);
	assert.equal(shim.summary, "[OpenAI native compaction checkpoint]");
	assert.equal(shim.firstKeptEntryId, "entry-keep");
	assert.deepEqual(shim.details, details);
});

test("resolveLatestNativeCompactionEntry matches provider/api/model/baseUrl identity", () => {
	const details = createNativeCompactionDetails({
		provider: "openai-codex",
		api: "openai-codex-responses",
		model: "gpt-5.3-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		compactedWindow: [{ type: "message", role: "user", content: "x" }],
		createdAt: "2026-01-01T00:00:00.000Z",
	});

	const branch = [
		{
			type: "compaction",
			id: "c1",
			summary: NATIVE_COMPACTION_SHIM_SUMMARY,
			firstKeptEntryId: "keep",
			tokensBefore: 1,
			details,
		},
		{ type: "message", id: "m1", message: { role: "user", content: "hi" } },
	] as never[];

	const hit = resolveLatestNativeCompactionEntry(branch, {
		provider: "openai-codex",
		api: "openai-codex-responses",
		model: "gpt-5.3-codex",
		baseUrl: "https://chatgpt.com/backend-api",
	});
	assert.equal(hit.ok, true);
	if (hit.ok) {
		assert.equal(hit.entry.id, "c1");
		assert.deepEqual(hit.entry.details?.compactedWindow, details.compactedWindow);
	}

	const miss = resolveLatestNativeCompactionEntry(branch, {
		provider: "openai",
		api: "openai-responses",
		model: "gpt-5-mini",
		baseUrl: "https://api.openai.com/v1",
	});
	assert.equal(miss.ok, false);
});
