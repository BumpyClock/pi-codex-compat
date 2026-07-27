import type { ExtensionSettings as CompactionSettings } from "../compaction/types.js";

export const PACKAGE_ID = "pi-codex-compat";
export const CANONICAL_SETTINGS_FILE = "pi-codex-compat.json";
export const CANONICAL_ACCOUNTS_FILE = "pi-codex-compat-accounts.json";

export const LEGACY_FAST_MODE_KEY = "openaiCodexFastMode";
export const LEGACY_COMPACTION_KEY = "openaiNativeCompaction";
export const COMPACTION_ENV_PREFIX = "PI_OPENAI_NATIVE_COMPACTION_";

export type FastModeSettings = {
	enabled: boolean;
};

export type TpsSettings = {
	enabled: boolean;
	notifyOnComplete: boolean;
};

export type AuthSettings = {
	disableApiKeyWhenCodexAuthenticated: boolean;
};

export type PackageSettings = {
	fastMode: FastModeSettings;
	openaiNativeCompaction: CompactionSettings;
	tps: TpsSettings;
	auth: AuthSettings;
};

export type LoadedPackageSettings = {
	settings: PackageSettings;
	sources: string[];
	warnings: string[];
	/** Recognized values that should be written into the canonical user settings file. */
	pendingUserMigration?: Record<string, unknown>;
	/** Recognized values that should be written into the canonical project settings file. */
	pendingProjectMigration?: Record<string, unknown>;
};

export const DEFAULT_FAST_MODE: FastModeSettings = {
	enabled: false,
};

export const DEFAULT_TPS: TpsSettings = {
	enabled: true,
	notifyOnComplete: true,
};

export const DEFAULT_AUTH: AuthSettings = {
	disableApiKeyWhenCodexAuthenticated: false,
};
