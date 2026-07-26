import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { CANONICAL_SETTINGS_FILE } from "./types.js";

export function agentSettingsPath(fileName = CANONICAL_SETTINGS_FILE): string {
	return join(getAgentDir(), fileName);
}

export function legacyGlobalSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

export function legacyCompactionPackageSettingsPath(packageLocalPath?: string): string | undefined {
	return packageLocalPath;
}

export function projectSettingsPath(cwd: string, fileName = CANONICAL_SETTINGS_FILE): string {
	return join(cwd, CONFIG_DIR_NAME, fileName);
}

export function legacyProjectSettingsPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "settings.json");
}
