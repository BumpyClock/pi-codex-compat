import type {
	BeforeProviderRequestEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import accountsExtension from "./accounts/accounts.js";
import { registerCodexCommand } from "./commands/codex.js";
import { registerCompaction } from "./compaction/register.js";
import { createFastModeController, registerFastMode } from "./fast-mode/fast-mode.js";
import usageExtension from "./quota/usage.js";
import { loadPackageSettings, persistCanonicalMigrations } from "./settings/load.js";
import type { PackageSettings } from "./settings/types.js";
import { isRecord } from "./shared/is-record.js";
import { registerTps } from "./tps/tps.js";
import { registerUsageHistory } from "./usage-history/usage-history.js";

export type PiCodexCompatDependencies = {
	cwd?: string;
	settings?: PackageSettings;
	accounts?: Parameters<typeof accountsExtension>[1];
	quota?: Parameters<typeof usageExtension>[1];
};

/**
 * Single factory owning all registrations.
 * before_provider_request pipeline: native compaction replay first, then priority-tier injection.
 */
export default function piCodexCompat(
	pi: ExtensionAPI,
	dependencies: PiCodexCompatDependencies = {},
): void {
	const cwd = dependencies.cwd;
	// Before session_start there is no trust signal; default untrusted (skip project layers).
	const loaded = dependencies.settings
		? {
				settings: dependencies.settings,
				sources: [] as string[],
				warnings: [] as string[],
			}
		: loadPackageSettings(cwd, { isProjectTrusted: false });
	let settings = loaded.settings;

	const fastMode = createFastModeController(settings.fastMode);
	const compaction = registerCompaction(pi, settings.openaiNativeCompaction);
	const tps = registerTps(pi, settings.tps);

	const accounts = accountsExtension(pi, {
		...dependencies.accounts,
		registerCommand: true,
	});
	const quota = usageExtension(pi, {
		...dependencies.quota,
		registerCommand: true,
	});

	registerFastMode(pi, fastMode, { cwd });
	registerUsageHistory(pi);
	registerCodexCommand(pi, {
		getSettings: () => settings,
		fastMode,
		openAccountsMenu: accounts.openMenu,
		openQuotaMenu: quota.openMenu,
		refreshSettings: (ctx?: ExtensionCommandContext) => {
			const next = loadPackageSettings(cwd ?? ctx?.cwd ?? process.cwd(), {
				isProjectTrusted: ctx?.isProjectTrusted() === true,
			});
			settings = next.settings;
			fastMode.setEnabled(settings.fastMode.enabled);
			compaction.setSettings(settings.openaiNativeCompaction);
			tps.configure(settings.tps);
			return settings;
		},
	});

	pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
		if (!dependencies.settings) {
			const next = loadPackageSettings(cwd ?? ctx.cwd, {
				isProjectTrusted: ctx.isProjectTrusted(),
			});
			settings = next.settings;
			fastMode.setEnabled(settings.fastMode.enabled);
			compaction.setSettings(settings.openaiNativeCompaction);
			tps.configure(settings.tps);
			try {
				await persistCanonicalMigrations(next, cwd ?? ctx.cwd);
			} catch (error) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`pi-codex-compat settings migration warning: ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
				}
			}
			for (const warning of next.warnings.slice(0, 3)) {
				if (ctx.hasUI) ctx.ui.notify(warning, "warning");
			}
		}
		fastMode.updateStatus(ctx);
	});

	pi.on(
		"before_provider_request",
		async (event: BeforeProviderRequestEvent, ctx: ExtensionContext) => {
			// Deterministic pipeline: native replay first, then priority-tier injection.
			let payload: unknown = event.payload;
			const rewritten = await compaction.rewriteProviderRequest({ ...event, payload }, ctx);
			if (rewritten !== undefined) payload = rewritten;

			const withTier = fastMode.applyPayload(payload, ctx.model);
			if (withTier !== undefined) payload = withTier;

			if (payload === event.payload) return undefined;
			return isRecord(payload) ? payload : undefined;
		},
	);

	pi.on("session_shutdown", async (_event: unknown, ctx: ExtensionContext) => {
		ctx.ui.setStatus("codex-fast-mode", undefined);
		tps.clear(ctx);
	});
}
