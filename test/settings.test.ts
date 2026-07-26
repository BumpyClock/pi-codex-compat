import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeJsonAtomic } from "../src/settings/atomic-write.js";
import {
	loadPackageSettings,
	persistCanonicalMigrations,
	updateFastModeSetting,
	updatePackageSettings,
} from "../src/settings/load.js";

test("canonical project settings beat legacy project settings when trusted", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-codex-settings-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });

	writeFileSync(
		join(cwd, ".pi", "settings.json"),
		`${JSON.stringify({ openaiNativeCompaction: { enabled: false, debug: true } }, null, 2)}\n`,
	);
	writeFileSync(
		join(cwd, ".pi", "pi-codex-compat.json"),
		`${JSON.stringify({ openaiNativeCompaction: { enabled: true, debug: false } }, null, 2)}\n`,
	);

	const loaded = loadPackageSettings(cwd, {
		agentDirOverride: agentDir,
		isProjectTrusted: true,
	});
	assert.equal(loaded.settings.openaiNativeCompaction.enabled, true);
	assert.equal(loaded.settings.openaiNativeCompaction.debug, false);
});

test("untrusted project settings are skipped", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-codex-untrusted-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });

	writeFileSync(
		join(cwd, ".pi", "pi-codex-compat.json"),
		`${JSON.stringify(
			{
				fastMode: { enabled: true },
				openaiNativeCompaction: {
					enabled: true,
					redactSensitiveData: false,
					logProviderPayloads: true,
				},
			},
			null,
			2,
		)}\n`,
	);

	const loaded = loadPackageSettings(cwd, {
		agentDirOverride: agentDir,
		isProjectTrusted: false,
	});
	assert.equal(loaded.settings.fastMode.enabled, false);
	assert.equal(loaded.settings.openaiNativeCompaction.redactSensitiveData, true);
	assert.equal(loaded.settings.openaiNativeCompaction.logProviderPayloads, false);
	assert.equal(loaded.pendingProjectMigration, undefined);
	assert.ok(!loaded.sources.some((source) => source.includes(`${join(cwd, ".pi")}`)));
});

test("legacy global fast mode and compaction migrate into effective settings", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-codex-legacy-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });

	writeFileSync(
		join(agentDir, "settings.json"),
		`${JSON.stringify(
			{
				extensionSettings: {
					openaiCodexFastMode: { enabled: true },
				},
				openaiNativeCompaction: {
					enabled: true,
					debug: true,
					supportedProviders: ["openai-codex"],
				},
			},
			null,
			2,
		)}\n`,
	);

	const loaded = loadPackageSettings(cwd, { agentDirOverride: agentDir });
	assert.equal(loaded.settings.fastMode.enabled, true);
	assert.equal(loaded.settings.openaiNativeCompaction.enabled, true);
	assert.equal(loaded.settings.openaiNativeCompaction.debug, true);
	assert.deepEqual(loaded.settings.openaiNativeCompaction.supportedProviders, ["openai-codex"]);
	assert.ok(loaded.pendingUserMigration);
	assert.equal(
		(loaded.pendingUserMigration as { fastMode?: { enabled?: boolean } }).fastMode?.enabled,
		true,
	);
});

test("user migration is scope-pure and does not include project or env values", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-codex-scope-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(cwd, ".pi"), { recursive: true });

	writeFileSync(
		join(agentDir, "settings.json"),
		`${JSON.stringify(
			{
				extensionSettings: { openaiCodexFastMode: { enabled: false } },
				openaiNativeCompaction: { enabled: true, debug: false },
			},
			null,
			2,
		)}\n`,
	);
	writeFileSync(
		join(cwd, ".pi", "pi-codex-compat.json"),
		`${JSON.stringify(
			{
				fastMode: { enabled: true },
				openaiNativeCompaction: {
					enabled: false,
					redactSensitiveData: false,
					logProviderPayloads: true,
				},
			},
			null,
			2,
		)}\n`,
	);

	const previous = process.env.PI_OPENAI_NATIVE_COMPACTION_DEBUG;
	process.env.PI_OPENAI_NATIVE_COMPACTION_DEBUG = "1";
	try {
		const loaded = loadPackageSettings(cwd, {
			agentDirOverride: agentDir,
			isProjectTrusted: true,
		});
		// Effective runtime may see env + project.
		assert.equal(loaded.settings.openaiNativeCompaction.debug, true);
		assert.equal(loaded.settings.fastMode.enabled, true);

		const migration = loaded.pendingUserMigration as {
			fastMode?: { enabled?: boolean };
			openaiNativeCompaction?: {
				enabled?: boolean;
				debug?: boolean;
				redactSensitiveData?: boolean;
				logProviderPayloads?: boolean;
			};
		};
		assert.ok(migration);
		// User migration must stay scope-pure: legacy user values only.
		assert.equal(migration.fastMode?.enabled, false);
		assert.equal(migration.openaiNativeCompaction?.enabled, true);
		assert.equal(migration.openaiNativeCompaction?.debug, false);
		assert.equal(migration.openaiNativeCompaction?.redactSensitiveData, undefined);
		assert.equal(migration.openaiNativeCompaction?.logProviderPayloads, undefined);
	} finally {
		if (previous === undefined) delete process.env.PI_OPENAI_NATIVE_COMPACTION_DEBUG;
		else process.env.PI_OPENAI_NATIVE_COMPACTION_DEBUG = previous;
	}
});

test("field-level migration fills only absent canonical values", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-codex-field-mig-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });

	// Canonical already has fastMode; compaction still only in legacy.
	writeFileSync(
		join(agentDir, "pi-codex-compat.json"),
		`${JSON.stringify({ fastMode: { enabled: true }, tps: { enabled: false } }, null, 2)}\n`,
	);
	writeFileSync(
		join(agentDir, "settings.json"),
		`${JSON.stringify(
			{
				extensionSettings: { openaiCodexFastMode: { enabled: false } },
				openaiNativeCompaction: { enabled: true, debug: true },
			},
			null,
			2,
		)}\n`,
	);

	const loaded = loadPackageSettings(cwd, { agentDirOverride: agentDir });
	assert.equal(loaded.settings.fastMode.enabled, true); // canonical wins
	assert.equal(loaded.settings.openaiNativeCompaction.enabled, true);
	assert.ok(loaded.pendingUserMigration);
	const migration = loaded.pendingUserMigration as {
		fastMode?: unknown;
		openaiNativeCompaction?: { enabled?: boolean; debug?: boolean };
		tps?: unknown;
	};
	// fastMode already canonical — must not be re-migrated from legacy false.
	assert.equal(migration.fastMode, undefined);
	assert.equal(migration.tps, undefined);
	assert.equal(migration.openaiNativeCompaction?.enabled, true);
	assert.equal(migration.openaiNativeCompaction?.debug, true);
});

test("project migration is scope-pure from legacy project only", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-codex-proj-mig-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(cwd, ".pi"), { recursive: true });

	writeFileSync(
		join(agentDir, "pi-codex-compat.json"),
		`${JSON.stringify(
			{
				openaiNativeCompaction: {
					enabled: true,
					redactSensitiveData: true,
					supportedProviders: ["openai-codex"],
				},
			},
			null,
			2,
		)}\n`,
	);
	writeFileSync(
		join(cwd, ".pi", "settings.json"),
		`${JSON.stringify({ openaiNativeCompaction: { enabled: false, debug: true } }, null, 2)}\n`,
	);

	const loaded = loadPackageSettings(cwd, {
		agentDirOverride: agentDir,
		isProjectTrusted: true,
	});
	assert.ok(loaded.pendingProjectMigration);
	const migration = loaded.pendingProjectMigration as {
		openaiNativeCompaction?: {
			enabled?: boolean;
			debug?: boolean;
			redactSensitiveData?: boolean;
			supportedProviders?: string[];
		};
	};
	assert.equal(migration.openaiNativeCompaction?.enabled, false);
	assert.equal(migration.openaiNativeCompaction?.debug, true);
	// Must not pull user-scope fields into project migration.
	assert.equal(migration.openaiNativeCompaction?.redactSensitiveData, undefined);
	assert.equal(migration.openaiNativeCompaction?.supportedProviders, undefined);
});

test("environment overrides win over all files for compaction", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-codex-env-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(cwd, ".pi", "pi-codex-compat.json"),
		`${JSON.stringify({ openaiNativeCompaction: { enabled: true, debug: false } }, null, 2)}\n`,
	);

	const previous = process.env.PI_OPENAI_NATIVE_COMPACTION_ENABLED;
	process.env.PI_OPENAI_NATIVE_COMPACTION_ENABLED = "0";
	try {
		const loaded = loadPackageSettings(cwd, {
			agentDirOverride: agentDir,
			isProjectTrusted: true,
		});
		assert.equal(loaded.settings.openaiNativeCompaction.enabled, false);
	} finally {
		if (previous === undefined) delete process.env.PI_OPENAI_NATIVE_COMPACTION_ENABLED;
		else process.env.PI_OPENAI_NATIVE_COMPACTION_ENABLED = previous;
	}
});

test("updateFastModeSetting does not seed project compaction into user config", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-codex-update-fast-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(cwd, ".pi"), { recursive: true });

	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		writeFileSync(
			join(cwd, ".pi", "pi-codex-compat.json"),
			`${JSON.stringify(
				{
					openaiNativeCompaction: {
						enabled: true,
						redactSensitiveData: false,
						logProviderPayloads: true,
					},
				},
				null,
				2,
			)}\n`,
		);

		await updateFastModeSetting(true, cwd, { isProjectTrusted: true });
		const written = JSON.parse(readFileSync(join(agentDir, "pi-codex-compat.json"), "utf8")) as {
			fastMode?: { enabled?: boolean };
			openaiNativeCompaction?: unknown;
		};
		assert.equal(written.fastMode?.enabled, true);
		assert.equal(written.openaiNativeCompaction, undefined);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

test("updatePackageSettings writes only changed fields to user config", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-codex-update-pkg-"));
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
					fastMode: { enabled: false },
					openaiNativeCompaction: { enabled: true, debug: false },
					tps: { enabled: true, notifyOnComplete: true },
					customUnknown: "keep-me",
				},
				null,
				2,
			)}\n`,
		);

		await updatePackageSettings(
			(current) => ({
				...current,
				tps: { ...current.tps, enabled: false },
			}),
			cwd,
			{ isProjectTrusted: false },
		);
		const written = JSON.parse(readFileSync(join(agentDir, "pi-codex-compat.json"), "utf8")) as {
			fastMode?: { enabled?: boolean };
			openaiNativeCompaction?: { enabled?: boolean; debug?: boolean };
			tps?: { enabled?: boolean; notifyOnComplete?: boolean };
			customUnknown?: string;
		};
		assert.equal(written.customUnknown, "keep-me");
		assert.equal(written.tps?.enabled, false);
		assert.equal(written.tps?.notifyOnComplete, true);
		assert.equal(written.fastMode?.enabled, false);
		assert.equal(written.openaiNativeCompaction?.enabled, true);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

test("writeJsonAtomic does not chmod existing project .pi parent to 0700", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-codex-atomic-"));
	const projectPi = join(root, ".pi");
	mkdirSync(projectPi, { recursive: true });
	chmodSync(projectPi, 0o755);
	const beforeMode = statSync(projectPi).mode & 0o777;

	const filePath = join(projectPi, "pi-codex-compat.json");
	await writeJsonAtomic(
		filePath,
		{ fastMode: { enabled: false } },
		{ mode: 0o644, dirMode: 0o755, chmodParent: false },
	);

	const afterMode = statSync(projectPi).mode & 0o777;
	assert.equal(afterMode, beforeMode);
	assert.equal(afterMode, 0o755);
	const fileMode = statSync(filePath).mode & 0o777;
	assert.equal(fileMode, 0o644);
});

test("persistCanonicalMigrations uses project 0644 and user 0600", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-codex-persist-mode-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	chmodSync(join(cwd, ".pi"), 0o755);

	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		writeFileSync(
			join(agentDir, "settings.json"),
			`${JSON.stringify(
				{
					extensionSettings: { openaiCodexFastMode: { enabled: true } },
					openaiNativeCompaction: { enabled: true },
				},
				null,
				2,
			)}\n`,
		);
		writeFileSync(
			join(cwd, ".pi", "settings.json"),
			`${JSON.stringify({ openaiNativeCompaction: { debug: true } }, null, 2)}\n`,
		);

		const loaded = loadPackageSettings(cwd, {
			agentDirOverride: agentDir,
			isProjectTrusted: true,
		});
		await persistCanonicalMigrations(loaded, cwd);

		const userPath = join(agentDir, "pi-codex-compat.json");
		const projectPath = join(cwd, ".pi", "pi-codex-compat.json");
		assert.equal(statSync(userPath).mode & 0o777, 0o600);
		assert.equal(statSync(projectPath).mode & 0o777, 0o644);
		assert.equal(statSync(join(cwd, ".pi")).mode & 0o777, 0o755);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});
