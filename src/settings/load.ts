import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ExtensionSettings as CompactionSettings,
	DEFAULT_EXTENSION_SETTINGS,
} from "../compaction/types.js";
import { isRecord } from "../shared/is-record.js";
import { writeJsonAtomic } from "./atomic-write.js";
import {
	agentSettingsPath,
	legacyGlobalSettingsPath,
	legacyProjectSettingsPath,
	projectSettingsPath,
} from "./paths.js";
import {
	type AuthSettings,
	CANONICAL_SETTINGS_FILE,
	COMPACTION_ENV_PREFIX,
	DEFAULT_AUTH,
	DEFAULT_FAST_MODE,
	DEFAULT_TPS,
	type FastModeSettings,
	LEGACY_COMPACTION_KEY,
	LEGACY_FAST_MODE_KEY,
	type LoadedPackageSettings,
	type PackageSettings,
	type TpsSettings,
} from "./types.js";

type PartialCompaction = Partial<CompactionSettings>;
type PartialPackage = {
	fastMode?: Partial<FastModeSettings>;
	openaiNativeCompaction?: PartialCompaction;
	tps?: Partial<TpsSettings>;
	auth?: Partial<AuthSettings>;
};

const PACKAGE_ROOT = pathDirname(fileURLToPath(import.meta.url));
// src/settings -> package root is ../..
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");
const LEGACY_PACKAGE_COMPACTION_SETTINGS = join(
	homedir(),
	".pi",
	"agent",
	"extensions",
	"openai-compaction",
	"settings.json",
);

const COMPACTION_FIELD_KEYS = [
	"enabled",
	"debug",
	"logProviderPayloads",
	"logCompactResponses",
	"redactSensitiveData",
	"notifyOnLoad",
	"artifactRoot",
	"supportedProviders",
	"supportedApis",
] as const satisfies readonly (keyof CompactionSettings)[];

const USER_FILE_WRITE = { mode: 0o600, dirMode: 0o700, chmodParent: true } as const;
const PROJECT_FILE_WRITE = { mode: 0o644, dirMode: 0o755, chmodParent: false } as const;

function pathDirname(filePath: string): string {
	return dirname(filePath);
}

function isFile(filePath: string): boolean {
	try {
		return statSync(filePath).isFile();
	} catch {
		return false;
	}
}

function readJsonObject(filePath: string, warnings: string[]): Record<string, unknown> | undefined {
	if (!isFile(filePath)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
		if (isRecord(parsed)) return parsed;
		warnings.push(`Ignoring ${filePath}: expected a JSON object at the top level.`);
		return undefined;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		warnings.push(`Ignoring ${filePath}: ${message}`);
		return undefined;
	}
}

function resolveConfiguredPath(rawPath: string, baseDir: string): string {
	if (rawPath.startsWith("~/")) return join(homedir(), rawPath.slice(2));
	if (rawPath.startsWith("/")) return rawPath;
	return join(baseDir, rawPath);
}

function toBoolean(value: unknown, fieldPath: string, warnings: string[]): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "boolean") return value;
	warnings.push(`Ignoring ${fieldPath}: expected a boolean.`);
	return undefined;
}

function toStringArray(
	value: unknown,
	fieldPath: string,
	warnings: string[],
): string[] | undefined {
	if (value === undefined) return undefined;
	if (
		!Array.isArray(value) ||
		value.some((item) => typeof item !== "string" || item.trim().length === 0)
	) {
		warnings.push(`Ignoring ${fieldPath}: expected a string array.`);
		return undefined;
	}
	return [...new Set(value.map((item) => item.trim()))];
}

function readCompactionBlock(
	raw: unknown,
	blockPath: string,
	baseDir: string,
	warnings: string[],
): PartialCompaction {
	if (raw === undefined) return {};
	if (!isRecord(raw)) {
		warnings.push(`Ignoring ${blockPath}: expected an object.`);
		return {};
	}
	const resolved: PartialCompaction = {};
	resolved.enabled = toBoolean(raw.enabled, `${blockPath}.enabled`, warnings);
	resolved.debug = toBoolean(raw.debug, `${blockPath}.debug`, warnings);
	resolved.logProviderPayloads = toBoolean(
		raw.logProviderPayloads,
		`${blockPath}.logProviderPayloads`,
		warnings,
	);
	resolved.logCompactResponses = toBoolean(
		raw.logCompactResponses,
		`${blockPath}.logCompactResponses`,
		warnings,
	);
	resolved.redactSensitiveData = toBoolean(
		raw.redactSensitiveData,
		`${blockPath}.redactSensitiveData`,
		warnings,
	);
	resolved.notifyOnLoad = toBoolean(raw.notifyOnLoad, `${blockPath}.notifyOnLoad`, warnings);

	const artifactPathValue = raw.artifactRoot ?? raw.artifactDir;
	if (artifactPathValue !== undefined) {
		if (typeof artifactPathValue === "string" && artifactPathValue.trim().length > 0) {
			resolved.artifactRoot = resolveConfiguredPath(artifactPathValue.trim(), baseDir);
		} else {
			warnings.push(`Ignoring ${blockPath}.artifactRoot: expected a non-empty string.`);
		}
	}

	resolved.supportedProviders = toStringArray(
		raw.supportedProviders,
		`${blockPath}.supportedProviders`,
		warnings,
	);
	resolved.supportedApis = toStringArray(raw.supportedApis, `${blockPath}.supportedApis`, warnings);
	return Object.fromEntries(
		Object.entries(resolved).filter(([, value]) => value !== undefined),
	) as PartialCompaction;
}

function readFastModeBlock(
	raw: unknown,
	blockPath: string,
	warnings: string[],
): Partial<FastModeSettings> {
	if (raw === undefined) return {};
	if (!isRecord(raw)) {
		warnings.push(`Ignoring ${blockPath}: expected an object.`);
		return {};
	}
	const enabled = toBoolean(raw.enabled, `${blockPath}.enabled`, warnings);
	return enabled === undefined ? {} : { enabled };
}

function readTpsBlock(raw: unknown, blockPath: string, warnings: string[]): Partial<TpsSettings> {
	if (raw === undefined) return {};
	if (!isRecord(raw)) {
		warnings.push(`Ignoring ${blockPath}: expected an object.`);
		return {};
	}
	const enabled = toBoolean(raw.enabled, `${blockPath}.enabled`, warnings);
	const notifyOnComplete = toBoolean(
		raw.notifyOnComplete,
		`${blockPath}.notifyOnComplete`,
		warnings,
	);
	const result: Partial<TpsSettings> = {};
	if (enabled !== undefined) result.enabled = enabled;
	if (notifyOnComplete !== undefined) result.notifyOnComplete = notifyOnComplete;
	return result;
}

function readAuthBlock(raw: unknown, blockPath: string, warnings: string[]): Partial<AuthSettings> {
	if (raw === undefined) return {};
	if (!isRecord(raw)) {
		warnings.push(`Ignoring ${blockPath}: expected an object.`);
		return {};
	}
	const disableApiKeyWhenCodexAuthenticated = toBoolean(
		raw.disableApiKeyWhenCodexAuthenticated,
		`${blockPath}.disableApiKeyWhenCodexAuthenticated`,
		warnings,
	);
	return disableApiKeyWhenCodexAuthenticated === undefined
		? {}
		: { disableApiKeyWhenCodexAuthenticated };
}

function readCanonicalPackage(
	settings: Record<string, unknown> | undefined,
	settingsPath: string,
	warnings: string[],
): PartialPackage {
	if (!settings) return {};
	const baseDir = dirname(settingsPath);
	const compactionRaw = settings.openaiNativeCompaction ?? settings.compaction;
	return {
		fastMode: readFastModeBlock(settings.fastMode, `${settingsPath}.fastMode`, warnings),
		openaiNativeCompaction: readCompactionBlock(
			compactionRaw,
			`${settingsPath}.${LEGACY_COMPACTION_KEY}`,
			baseDir,
			warnings,
		),
		tps: readTpsBlock(settings.tps, `${settingsPath}.tps`, warnings),
		auth: readAuthBlock(settings.auth, `${settingsPath}.auth`, warnings),
	};
}

function mergePartial(base: PackageSettings, patch: PartialPackage): PackageSettings {
	return {
		fastMode: { ...base.fastMode, ...patch.fastMode },
		openaiNativeCompaction: {
			...base.openaiNativeCompaction,
			...patch.openaiNativeCompaction,
		},
		tps: { ...base.tps, ...patch.tps },
		auth: { ...base.auth, ...patch.auth },
	};
}

function mergePartials(...patches: PartialPackage[]): PartialPackage {
	const result: PartialPackage = {};
	for (const patch of patches) {
		if (patch.fastMode && Object.keys(patch.fastMode).length > 0) {
			result.fastMode = { ...result.fastMode, ...patch.fastMode };
		}
		if (patch.openaiNativeCompaction && Object.keys(patch.openaiNativeCompaction).length > 0) {
			result.openaiNativeCompaction = {
				...result.openaiNativeCompaction,
				...patch.openaiNativeCompaction,
			};
		}
		if (patch.tps && Object.keys(patch.tps).length > 0) {
			result.tps = { ...result.tps, ...patch.tps };
		}
		if (patch.auth && Object.keys(patch.auth).length > 0) {
			result.auth = { ...result.auth, ...patch.auth };
		}
	}
	return result;
}

function hasPartial(patch: PartialPackage): boolean {
	return (
		Object.keys(patch.fastMode ?? {}).length > 0 ||
		Object.keys(patch.openaiNativeCompaction ?? {}).length > 0 ||
		Object.keys(patch.tps ?? {}).length > 0 ||
		Object.keys(patch.auth ?? {}).length > 0
	);
}

function applyCompactionEnv(settings: CompactionSettings, cwd: string): CompactionSettings {
	const resolveEnvBoolean = (name: string): boolean | undefined => {
		const value = process.env[`${COMPACTION_ENV_PREFIX}${name}`]?.trim().toLowerCase();
		if (!value) return undefined;
		if (["1", "true", "yes", "on"].includes(value)) return true;
		if (["0", "false", "no", "off"].includes(value)) return false;
		return undefined;
	};
	const resolveEnvCsv = (name: string): string[] | undefined => {
		const rawValue = process.env[`${COMPACTION_ENV_PREFIX}${name}`]?.trim();
		if (!rawValue) return undefined;
		const items = rawValue
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean);
		return items.length > 0 ? [...new Set(items)] : undefined;
	};
	const artifactRoot = process.env[`${COMPACTION_ENV_PREFIX}ARTIFACT_ROOT`]?.trim();
	return {
		...settings,
		enabled: resolveEnvBoolean("ENABLED") ?? settings.enabled,
		debug: resolveEnvBoolean("DEBUG") ?? settings.debug,
		logProviderPayloads: resolveEnvBoolean("LOG_PROVIDER_PAYLOADS") ?? settings.logProviderPayloads,
		logCompactResponses: resolveEnvBoolean("LOG_COMPACT_RESPONSES") ?? settings.logCompactResponses,
		redactSensitiveData: resolveEnvBoolean("REDACT_SENSITIVE_DATA") ?? settings.redactSensitiveData,
		notifyOnLoad: resolveEnvBoolean("NOTIFY_ON_LOAD") ?? settings.notifyOnLoad,
		artifactRoot:
			typeof artifactRoot === "string" && artifactRoot.length > 0
				? resolveConfiguredPath(artifactRoot, cwd)
				: settings.artifactRoot,
		supportedProviders: resolveEnvCsv("SUPPORTED_PROVIDERS") ?? settings.supportedProviders,
		supportedApis: resolveEnvCsv("SUPPORTED_APIS") ?? settings.supportedApis,
	};
}

function normalizeCompactionPaths(settings: CompactionSettings, cwd: string): CompactionSettings {
	return {
		...settings,
		artifactRoot: resolveConfiguredPath(settings.artifactRoot, cwd),
		supportedProviders: [
			...new Set(settings.supportedProviders.map((item) => item.trim()).filter(Boolean)),
		],
		supportedApis: [...new Set(settings.supportedApis.map((item) => item.trim()).filter(Boolean))],
	};
}

function recognizedCompactionShape(settings: CompactionSettings): Record<string, unknown> {
	return {
		enabled: settings.enabled,
		debug: settings.debug,
		logProviderPayloads: settings.logProviderPayloads,
		logCompactResponses: settings.logCompactResponses,
		redactSensitiveData: settings.redactSensitiveData,
		notifyOnLoad: settings.notifyOnLoad,
		artifactRoot: settings.artifactRoot,
		supportedProviders: settings.supportedProviders,
		supportedApis: settings.supportedApis,
	};
}

function recognizedCanonicalShape(settings: PackageSettings): Record<string, unknown> {
	return {
		fastMode: settings.fastMode,
		openaiNativeCompaction: recognizedCompactionShape(settings.openaiNativeCompaction),
		tps: settings.tps,
		auth: settings.auth,
	};
}

/**
 * Build a field-level migration blob for values present in `legacy` but absent from `canonical`.
 * Never invent defaults; only copy fields that legacy sources actually supplied.
 */
function fieldLevelMigration(
	legacy: PartialPackage,
	canonical: PartialPackage,
): Record<string, unknown> | undefined {
	const result: Record<string, unknown> = {};

	if (legacy.fastMode?.enabled !== undefined && canonical.fastMode?.enabled === undefined) {
		result.fastMode = { enabled: legacy.fastMode.enabled };
	}

	const compactionLegacy = legacy.openaiNativeCompaction ?? {};
	const compactionCanonical = canonical.openaiNativeCompaction ?? {};
	const compactionMig: Record<string, unknown> = {};
	for (const key of COMPACTION_FIELD_KEYS) {
		const legacyValue = compactionLegacy[key];
		if (legacyValue !== undefined && compactionCanonical[key] === undefined) {
			compactionMig[key] = legacyValue;
		}
	}
	if (Object.keys(compactionMig).length > 0) {
		// Preserve any already-canonical compaction fields when writing a partial block.
		result.openaiNativeCompaction = {
			...compactionCanonical,
			...compactionMig,
		};
	}

	const tpsLegacy = legacy.tps ?? {};
	const tpsCanonical = canonical.tps ?? {};
	const tpsMig: Record<string, unknown> = {};
	if (tpsLegacy.enabled !== undefined && tpsCanonical.enabled === undefined) {
		tpsMig.enabled = tpsLegacy.enabled;
	}
	if (tpsLegacy.notifyOnComplete !== undefined && tpsCanonical.notifyOnComplete === undefined) {
		tpsMig.notifyOnComplete = tpsLegacy.notifyOnComplete;
	}
	if (Object.keys(tpsMig).length > 0) {
		result.tps = {
			...tpsCanonical,
			...tpsMig,
		};
	}

	// auth has no legacy migration path.

	return Object.keys(result).length > 0 ? result : undefined;
}

function packageSettingsDelta(before: PackageSettings, after: PackageSettings): PartialPackage {
	const patch: PartialPackage = {};
	if (before.fastMode.enabled !== after.fastMode.enabled) {
		patch.fastMode = { enabled: after.fastMode.enabled };
	}

	const compactionPatch: PartialCompaction = {};
	for (const key of COMPACTION_FIELD_KEYS) {
		const beforeValue = before.openaiNativeCompaction[key];
		const afterValue = after.openaiNativeCompaction[key];
		if (JSON.stringify(beforeValue) !== JSON.stringify(afterValue)) {
			(compactionPatch as Record<string, unknown>)[key] = afterValue;
		}
	}
	if (Object.keys(compactionPatch).length > 0) {
		patch.openaiNativeCompaction = compactionPatch;
	}

	const tpsPatch: Partial<TpsSettings> = {};
	if (before.tps.enabled !== after.tps.enabled) tpsPatch.enabled = after.tps.enabled;
	if (before.tps.notifyOnComplete !== after.tps.notifyOnComplete) {
		tpsPatch.notifyOnComplete = after.tps.notifyOnComplete;
	}
	if (Object.keys(tpsPatch).length > 0) patch.tps = tpsPatch;

	const authPatch: Partial<AuthSettings> = {};
	if (
		before.auth.disableApiKeyWhenCodexAuthenticated !==
		after.auth.disableApiKeyWhenCodexAuthenticated
	) {
		authPatch.disableApiKeyWhenCodexAuthenticated = after.auth.disableApiKeyWhenCodexAuthenticated;
	}
	if (Object.keys(authPatch).length > 0) patch.auth = authPatch;
	return patch;
}

function applyPartialToExistingFile(
	existing: Record<string, unknown>,
	patch: PartialPackage,
): Record<string, unknown> {
	const next = { ...existing };
	if (patch.fastMode && Object.keys(patch.fastMode).length > 0) {
		const current = isRecord(existing.fastMode) ? existing.fastMode : {};
		next.fastMode = { ...current, ...patch.fastMode };
	}
	if (patch.openaiNativeCompaction && Object.keys(patch.openaiNativeCompaction).length > 0) {
		const current = isRecord(existing.openaiNativeCompaction)
			? existing.openaiNativeCompaction
			: {};
		next.openaiNativeCompaction = { ...current, ...patch.openaiNativeCompaction };
	}
	if (patch.tps && Object.keys(patch.tps).length > 0) {
		const current = isRecord(existing.tps) ? existing.tps : {};
		next.tps = { ...current, ...patch.tps };
	}
	if (patch.auth && Object.keys(patch.auth).length > 0) {
		const current = isRecord(existing.auth) ? existing.auth : {};
		next.auth = { ...current, ...patch.auth };
	}
	return next;
}

export type LoadPackageSettingsOptions = {
	legacyPackageCompactionPath?: string;
	agentDirOverride?: string;
	/**
	 * When false (default), project settings layers are ignored.
	 * Callers with a live ExtensionContext must pass ctx.isProjectTrusted().
	 */
	isProjectTrusted?: boolean;
};

/**
 * Native-compaction resolution (and package settings):
 * defaults → old package-local settings → legacy global → canonical user →
 * legacy trusted-project → canonical trusted-project → environment overrides.
 * Canonical values win over legacy values at the same scope; env wins over all files.
 * Project layers apply only when isProjectTrusted is true.
 */
export function loadPackageSettings(
	cwd = process.cwd(),
	options: LoadPackageSettingsOptions = {},
): LoadedPackageSettings {
	const warnings: string[] = [];
	const sources: string[] = [];
	const isProjectTrusted = options.isProjectTrusted === true;
	const agentUserPath = options.agentDirOverride
		? join(options.agentDirOverride, CANONICAL_SETTINGS_FILE)
		: agentSettingsPath();
	const legacyGlobalPath = options.agentDirOverride
		? join(options.agentDirOverride, "settings.json")
		: legacyGlobalSettingsPath();
	// When tests override the agent dir, do not leak real ~/.pi package-local compaction settings
	// unless an explicit legacyPackageCompactionPath is provided.
	const legacyPackagePath =
		options.legacyPackageCompactionPath ??
		(options.agentDirOverride
			? join(options.agentDirOverride, "extensions", "openai-compaction", "settings.json")
			: LEGACY_PACKAGE_COMPACTION_SETTINGS);
	const legacyProjectPath = legacyProjectSettingsPath(cwd);
	const canonicalProjectPath = projectSettingsPath(cwd);

	let resolved: PackageSettings = {
		fastMode: { ...DEFAULT_FAST_MODE },
		openaiNativeCompaction: { ...DEFAULT_EXTENSION_SETTINGS },
		tps: { ...DEFAULT_TPS },
		auth: { ...DEFAULT_AUTH },
	};

	// Track scope-pure legacy contributions for migrations (never env, never cross-scope).
	let userLegacyPartial: PartialPackage = {};
	let projectLegacyPartial: PartialPackage = {};

	// 1) old package-local compaction settings (user scope)
	const packageLocal = readJsonObject(legacyPackagePath, warnings);
	if (packageLocal) {
		const compaction = readCompactionBlock(
			packageLocal.openaiNativeCompaction ?? packageLocal,
			legacyPackagePath,
			dirname(legacyPackagePath),
			warnings,
		);
		if (Object.keys(compaction).length > 0) {
			const patch = { openaiNativeCompaction: compaction };
			userLegacyPartial = mergePartials(userLegacyPartial, patch);
			resolved = mergePartial(resolved, patch);
			sources.push(legacyPackagePath);
		}
	}

	// 2) legacy global settings.json (user scope)
	const legacyGlobal = readJsonObject(legacyGlobalPath, warnings);
	if (legacyGlobal) {
		const extensionSettings = isRecord(legacyGlobal.extensionSettings)
			? legacyGlobal.extensionSettings
			: undefined;
		const fastMode = readFastModeBlock(
			extensionSettings?.[LEGACY_FAST_MODE_KEY],
			`${legacyGlobalPath}.extensionSettings.${LEGACY_FAST_MODE_KEY}`,
			warnings,
		);
		const compaction = readCompactionBlock(
			legacyGlobal[LEGACY_COMPACTION_KEY],
			`${legacyGlobalPath}.${LEGACY_COMPACTION_KEY}`,
			dirname(legacyGlobalPath),
			warnings,
		);
		const patch: PartialPackage = {
			fastMode,
			openaiNativeCompaction: compaction,
		};
		if (hasPartial(patch)) {
			userLegacyPartial = mergePartials(userLegacyPartial, patch);
			resolved = mergePartial(resolved, patch);
			sources.push(legacyGlobalPath);
		}
	}

	// 3) canonical user settings
	const canonicalUser = readJsonObject(agentUserPath, warnings);
	const userCanonicalPartial = readCanonicalPackage(canonicalUser, agentUserPath, warnings);
	if (hasPartial(userCanonicalPartial)) {
		resolved = mergePartial(resolved, userCanonicalPartial);
		sources.push(agentUserPath);
	}

	// 4-5) trusted project layers only
	let projectCanonicalPartial: PartialPackage = {};
	if (isProjectTrusted) {
		// 4) legacy trusted-project settings.json
		const legacyProject = readJsonObject(legacyProjectPath, warnings);
		if (legacyProject) {
			const compaction = readCompactionBlock(
				legacyProject[LEGACY_COMPACTION_KEY],
				`${legacyProjectPath}.${LEGACY_COMPACTION_KEY}`,
				dirname(legacyProjectPath),
				warnings,
			);
			if (Object.keys(compaction).length > 0) {
				const patch = { openaiNativeCompaction: compaction };
				projectLegacyPartial = mergePartials(projectLegacyPartial, patch);
				resolved = mergePartial(resolved, patch);
				sources.push(legacyProjectPath);
			}
		}

		// 5) canonical trusted-project settings
		const canonicalProject = readJsonObject(canonicalProjectPath, warnings);
		projectCanonicalPartial = readCanonicalPackage(
			canonicalProject,
			canonicalProjectPath,
			warnings,
		);
		if (hasPartial(projectCanonicalPartial)) {
			resolved = mergePartial(resolved, projectCanonicalPartial);
			sources.push(canonicalProjectPath);
		}
	}

	// 6) environment overrides for compaction (runtime only — never migrated into files)
	resolved = {
		...resolved,
		openaiNativeCompaction: normalizeCompactionPaths(
			applyCompactionEnv(resolved.openaiNativeCompaction, cwd),
			cwd,
		),
	};

	// Scope-pure, field-level migrations. Never promote project/env into user or user/env into project.
	const pendingUserMigration = fieldLevelMigration(userLegacyPartial, userCanonicalPartial);
	const pendingProjectMigration =
		isProjectTrusted && hasPartial(projectLegacyPartial)
			? fieldLevelMigration(projectLegacyPartial, projectCanonicalPartial)
			: undefined;

	return {
		settings: resolved,
		sources,
		warnings,
		pendingUserMigration,
		pendingProjectMigration,
	};
}

export async function persistCanonicalMigrations(
	loaded: LoadedPackageSettings,
	cwd = process.cwd(),
): Promise<void> {
	if (loaded.pendingUserMigration) {
		const path = agentSettingsPath();
		const existing = readJsonObject(path, []) ?? {};
		const patch = readCanonicalPackage(loaded.pendingUserMigration, path, []);
		await writeJsonAtomic(path, applyPartialToExistingFile(existing, patch), USER_FILE_WRITE);
	}
	if (loaded.pendingProjectMigration) {
		const path = projectSettingsPath(cwd);
		const existing = readJsonObject(path, []) ?? {};
		const patch = readCanonicalPackage(loaded.pendingProjectMigration, path, []);
		await writeJsonAtomic(path, applyPartialToExistingFile(existing, patch), PROJECT_FILE_WRITE);
	}
}

export type SettingsWriteOptions = {
	isProjectTrusted?: boolean;
};

/**
 * Persist only the fast-mode field into user config.
 * Does not seed compaction/tps from effective (possibly project) settings.
 */
export async function updateFastModeSetting(
	enabled: boolean,
	cwd = process.cwd(),
	options: SettingsWriteOptions = {},
): Promise<PackageSettings> {
	const loaded = loadPackageSettings(cwd, {
		isProjectTrusted: options.isProjectTrusted === true,
	});
	const path = agentSettingsPath();
	const existing = readJsonObject(path, []) ?? {};
	await writeJsonAtomic(
		path,
		applyPartialToExistingFile(existing, { fastMode: { enabled } }),
		USER_FILE_WRITE,
	);
	return {
		...loaded.settings,
		fastMode: { enabled },
	};
}

/**
 * Apply a mutator to effective settings and persist only the changed fields into user config.
 * Never copies untouched project/env-resolved values into the user file.
 */
export async function updatePackageSettings(
	mutator: (current: PackageSettings) => PackageSettings,
	cwd = process.cwd(),
	options: SettingsWriteOptions = {},
): Promise<PackageSettings> {
	const loaded = loadPackageSettings(cwd, {
		isProjectTrusted: options.isProjectTrusted === true,
	});
	const next = mutator(loaded.settings);
	const delta = packageSettingsDelta(loaded.settings, next);
	if (!hasPartial(delta)) return next;
	const path = agentSettingsPath();
	const existing = readJsonObject(path, []) ?? {};
	await writeJsonAtomic(path, applyPartialToExistingFile(existing, delta), USER_FILE_WRITE);
	return next;
}

// Keep REPO_ROOT referenced so package-local discovery remains available for tests.
void REPO_ROOT;
void recognizedCanonicalShape;
