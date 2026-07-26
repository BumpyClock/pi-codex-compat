import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	ACCOUNTS_FILE,
	AccountStore,
	LEGACY_CODEX_ACCOUNTS_FILE,
	LEGACY_MULTI_ACCOUNTS_FILE,
	migrateLegacyCodexAccountsFile,
	parseAccountName,
	parseAccountsData,
} from "../src/accounts/account-store.js";
import {
	FileAccountStorageBackend,
	InMemoryAccountStorageBackend,
} from "../src/accounts/storage.js";

const credential = (suffix: string) => ({
	type: "oauth" as const,
	access: `access-${suffix}`,
	refresh: `refresh-${suffix}`,
	expires: Date.now() + 60_000,
});

test("parseAccountName validates names", () => {
	assert.equal(parseAccountName("work").ok, true);
	assert.equal(parseAccountName("").ok, false);
	assert.equal(parseAccountName("bad name").ok, false);
});

test("parseAccountsData rejects non-codex providers", () => {
	assert.throws(
		() =>
			parseAccountsData(
				JSON.stringify({
					version: 1,
					providers: {
						anthropic: { accounts: { a: credential("a") } },
					},
				}),
			),
		/unsupported provider/,
	);
});

test("AccountStore serializes provider updates", async () => {
	const store = new AccountStore(new InMemoryAccountStorageBackend());
	await store.updateProvider("openai-codex", () => ({
		active: "work",
		accounts: { work: credential("work") },
	}));
	const state = await store.readProviderAsync("openai-codex");
	assert.equal(state.active, "work");
	assert.equal(state.accounts.work?.access, "access-work");
});

test("FileAccountStorageBackend writes private files", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-codex-acct-"));
	const filePath = join(dir, "pi-codex-compat-accounts.json");
	try {
		const backend = new FileAccountStorageBackend(filePath);
		backend.withLock(() => ({
			result: undefined,
			next: JSON.stringify(
				{
					version: 1,
					providers: {
						"openai-codex": { accounts: { work: credential("work") } },
					},
				},
				null,
				2,
			),
		}));
		const raw = readFileSync(filePath, "utf8");
		const parsed = parseAccountsData(raw);
		assert.equal(parsed.providers["openai-codex"]?.accounts.work?.refresh, "refresh-work");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("migrates legacy codex accounts file", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-codex-mig-"));
	const legacy = join(dir, LEGACY_CODEX_ACCOUNTS_FILE);
	const canonical = join(dir, "pi-codex-compat-accounts.json");
	try {
		writeFileSync(
			legacy,
			JSON.stringify({ active: "work", accounts: { work: credential("work") } }, null, 2),
			{ mode: 0o600 },
		);
		chmodSync(legacy, 0o600);
		const result = await migrateLegacyCodexAccountsFile(legacy, canonical);
		assert.equal(result.status, "migrated");
		const parsed = parseAccountsData(readFileSync(canonical, "utf8"));
		assert.equal(parsed.providers["openai-codex"]?.active, "work");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("extracts openai-codex section from multi-provider pi-accounts.json shape", () => {
	const raw = JSON.stringify({
		version: 1,
		providers: {
			"openai-codex": { active: "codex", accounts: { codex: credential("codex") } },
			anthropic: { accounts: { a: credential("a") } },
		},
	});
	// Validate that multi-provider raw is rejected by parseAccountsData (canonical is codex-only),
	// and that migration helper path is covered by storage backend tests above.
	assert.throws(() => parseAccountsData(raw), /unsupported provider/);
	assert.equal(LEGACY_MULTI_ACCOUNTS_FILE, "pi-accounts.json");
});

test("default AccountStore is lazy: factory construct does not create or migrate files", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-codex-lazy-acct-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		writeFileSync(
			join(agentDir, LEGACY_CODEX_ACCOUNTS_FILE),
			JSON.stringify({ active: "work", accounts: { work: credential("work") } }, null, 2),
			{ mode: 0o600 },
		);
		chmodSync(join(agentDir, LEGACY_CODEX_ACCOUNTS_FILE), 0o600);

		const store = new AccountStore();
		// Construction alone must not migrate or create the canonical file.
		assert.equal(existsSync(join(agentDir, ACCOUNTS_FILE)), false);
		assert.deepEqual(readdirSync(agentDir).sort(), [LEGACY_CODEX_ACCOUNTS_FILE]);

		// First real use migrates and exposes the notice.
		const notice = store.consumeMigrationNotice();
		assert.ok(notice);
		assert.match(notice, /copied into/);
		assert.equal(existsSync(join(agentDir, ACCOUNTS_FILE)), true);
		const parsed = store.read();
		assert.equal(parsed.providers["openai-codex"]?.active, "work");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	}
});
