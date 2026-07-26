import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { FastModeController } from "../fast-mode/fast-mode.js";
import { updatePackageSettings } from "../settings/load.js";
import type { PackageSettings } from "../settings/types.js";
import { guardObservableCommand, guardTuiOnlyMenu } from "../shared/mode.js";
import { runUsageHistory } from "../usage-history/usage-history.js";

export type CodexCommandDeps = {
	getSettings: () => PackageSettings;
	fastMode: FastModeController & { statusText?: () => string };
	openAccountsMenu: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	openQuotaMenu: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	refreshSettings?: (ctx?: ExtensionCommandContext) => PackageSettings;
};

const HELP_TEXT = [
	"pi-codex-compat commands:",
	"  /codex              Open the manager menu (TUI)",
	"  /codex status       Show feature status (TUI/RPC)",
	"  /codex help         Show this help (TUI/RPC)",
	"  /accounts           Manage named OpenAI Codex OAuth accounts (TUI)",
	"  /usage              Live Codex subscription quota (TUI)",
	"  /usage-history      Historical Pi/Codex CLI cost report (TUI/RPC)",
	"  /fast [toggle|on|off|status]  Priority service tier (TUI/RPC)",
	"  Alt+Shift+F         Toggle fast mode",
].join("\n");

function formatStatus(settings: PackageSettings, fastEnabled: boolean): string {
	return [
		"pi-codex-compat status",
		`  fast mode: ${fastEnabled ? "on" : "off"}`,
		`  native compaction: ${settings.openaiNativeCompaction.enabled ? "enabled" : "disabled"}`,
		`  tps: ${settings.tps.enabled ? "enabled" : "disabled"}`,
		`  tps notify: ${settings.tps.notifyOnComplete ? "on" : "off"}`,
	].join("\n");
}

export function registerCodexCommand(pi: ExtensionAPI, deps: CodexCommandDeps): void {
	pi.registerCommand("codex", {
		description: "OpenAI Codex manager. Usage: /codex [status|help]. No args opens the TUI menu.",
		getArgumentCompletions: (prefix: string) => {
			const commands = ["status", "help"];
			const filtered = commands.filter((command) => command.startsWith(prefix.trim()));
			return filtered.length > 0
				? filtered.map((command) => ({ value: command, label: command }))
				: null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const action = args.trim().toLowerCase();
			if (!action) {
				if (guardTuiOnlyMenu("/codex", ctx) === "stop") return;
				await showCodexMenu(pi, ctx, deps);
				return;
			}
			if (action === "status") {
				if (guardObservableCommand("/codex status", ctx) === "stop") return;
				ctx.ui.notify(formatStatus(deps.getSettings(), deps.fastMode.isEnabled()), "info");
				return;
			}
			if (action === "help") {
				if (guardObservableCommand("/codex help", ctx) === "stop") return;
				ctx.ui.notify(HELP_TEXT, "info");
				return;
			}
			const unknownMessage = `Unknown /codex route "${args.trim()}". Use /codex, /codex status, or /codex help.`;
			// Print/JSON have no observable notify channel — throw per mode contract.
			if (ctx.mode === "print" || ctx.mode === "json") {
				throw new Error(unknownMessage);
			}
			ctx.ui.notify(unknownMessage, "warning");
		},
	});
}

async function showCodexMenu(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	deps: CodexCommandDeps,
): Promise<void> {
	const settings = deps.getSettings();
	const choice = await ctx.ui.select("Codex manager", [
		"Accounts",
		"Quota",
		`Fast mode (${deps.fastMode.isEnabled() ? "on" : "off"})`,
		"Historical usage",
		"Settings",
		"Status",
		"Help",
	]);
	if (!choice) return;

	if (choice === "Accounts") {
		await deps.openAccountsMenu("", ctx);
		return;
	}
	if (choice === "Quota") {
		await deps.openQuotaMenu("", ctx);
		return;
	}
	if (choice.startsWith("Fast mode")) {
		const next = !deps.fastMode.isEnabled();
		// Reuse /fast persistence path via settings helper and controller.
		const { updateFastModeSetting } = await import("../settings/load.js");
		await updateFastModeSetting(next, ctx.cwd, {
			isProjectTrusted: ctx.isProjectTrusted(),
		});
		deps.fastMode.setEnabled(next);
		deps.fastMode.updateStatus(ctx);
		ctx.ui.notify(`OpenAI Codex fast mode is ${next ? "on" : "off"}.`, "info");
		return;
	}
	if (choice === "Historical usage") {
		await runUsageHistory(pi, ctx);
		return;
	}
	if (choice === "Settings") {
		await showSettingsMenu(ctx, deps, settings);
		return;
	}
	if (choice === "Status") {
		ctx.ui.notify(formatStatus(settings, deps.fastMode.isEnabled()), "info");
		return;
	}
	if (choice === "Help") {
		ctx.ui.notify(HELP_TEXT, "info");
	}
}

async function showSettingsMenu(
	ctx: ExtensionCommandContext,
	deps: CodexCommandDeps,
	settings: PackageSettings,
): Promise<void> {
	const choice = await ctx.ui.select("Codex settings", [
		`Native compaction: ${settings.openaiNativeCompaction.enabled ? "on" : "off"}`,
		`TPS status: ${settings.tps.enabled ? "on" : "off"}`,
		`TPS completion notify: ${settings.tps.notifyOnComplete ? "on" : "off"}`,
		"Back",
	]);
	if (!choice || choice === "Back") return;

	if (choice.startsWith("Native compaction")) {
		const next = await updatePackageSettings(
			(current) => ({
				...current,
				openaiNativeCompaction: {
					...current.openaiNativeCompaction,
					enabled: !current.openaiNativeCompaction.enabled,
				},
			}),
			ctx.cwd,
			{ isProjectTrusted: ctx.isProjectTrusted() },
		);
		deps.refreshSettings?.(ctx);
		ctx.ui.notify(
			`Native compaction ${next.openaiNativeCompaction.enabled ? "enabled" : "disabled"}.`,
			"info",
		);
		return;
	}
	if (choice.startsWith("TPS status")) {
		const next = await updatePackageSettings(
			(current) => ({
				...current,
				tps: { ...current.tps, enabled: !current.tps.enabled },
			}),
			ctx.cwd,
			{ isProjectTrusted: ctx.isProjectTrusted() },
		);
		deps.refreshSettings?.(ctx);
		ctx.ui.notify(`TPS status ${next.tps.enabled ? "enabled" : "disabled"}.`, "info");
		return;
	}
	if (choice.startsWith("TPS completion")) {
		const next = await updatePackageSettings(
			(current) => ({
				...current,
				tps: { ...current.tps, notifyOnComplete: !current.tps.notifyOnComplete },
			}),
			ctx.cwd,
			{ isProjectTrusted: ctx.isProjectTrusted() },
		);
		deps.refreshSettings?.(ctx);
		ctx.ui.notify(
			`TPS completion notify ${next.tps.notifyOnComplete ? "enabled" : "disabled"}.`,
			"info",
		);
	}
}
