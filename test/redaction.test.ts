import assert from "node:assert/strict";
import test from "node:test";
import { redactTokenText } from "../src/accounts/runtime-auth.js";
import { redactValue } from "../src/compaction/debug.js";
import { redactUsageError } from "../src/quota/core.js";

const JWT_SAMPLE = "eyJhbGciOiJub25lIn0.eyJzdWIiOiIxMjMifQ.sig";

test("compaction redaction removes authorization and jwt-like values", () => {
	const redacted = redactValue({
		headers: {
			Authorization: "Bearer sk-abc.def.ghi",
			"OpenAI-Api-Key": "sk-test",
		},
		token: JWT_SAMPLE,
		safe: "ok",
	}) as Record<string, unknown>;
	assert.notEqual(JSON.stringify(redacted), undefined);
	assert.equal((redacted.headers as Record<string, unknown>).Authorization, "[REDACTED]");
	assert.equal(redacted.safe, "ok");
});

test("broad JWT-like scrubbing applies under non-sensitive keys and body text", () => {
	const redacted = redactValue({
		body: `user said ${JWT_SAMPLE} in chat`,
		message: JWT_SAMPLE,
		nested: {
			content: `prefix ${JWT_SAMPLE} suffix`,
			note: "plain text stays",
		},
		safe: "ok",
	}) as {
		body: string;
		message: string;
		nested: { content: string; note: string };
		safe: string;
	};

	assert.equal(redacted.safe, "ok");
	assert.equal(redacted.nested.note, "plain text stays");
	assert.doesNotMatch(redacted.body, /eyJhbGciOiJub25lIn0/);
	assert.doesNotMatch(redacted.message, /eyJhbGciOiJub25lIn0/);
	assert.doesNotMatch(redacted.nested.content, /eyJhbGciOiJub25lIn0/);
	assert.match(redacted.body, /\[REDACTED\]/);
	assert.equal(redacted.message, "[REDACTED]");
});

test("account token redaction strips bearer-like secrets", () => {
	const message = redactTokenText("failed with Bearer abc.def.ghi and refresh=xyz");
	assert.doesNotMatch(message, /abc\.def\.ghi/);
});

test("quota error redaction removes provided secrets", () => {
	const message = redactUsageError("status 401 secret-token leaked", ["secret-token"]);
	assert.doesNotMatch(message, /secret-token/);
});
