import type {
	BeforeProviderRequestEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import accountsExtension from "./accounts/accounts.js";
import type { CodexAuthStateReader } from "./accounts/codex-auth-state.js";
import { type AuthPolicyController, registerAuthPolicy } from "./auth-policy/controller.js";
import { registerCodexCommand } from "./commands/codex.js";
import { type CompactionController, registerCompaction } from "./compaction/register.js";
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
	authState?: CodexAuthStateReader;
	authPath?: string;
};

/**
 * Single factory owning all registrations.
 * before_provider_request pipeline: native compaction replay first, then priority-tier injection.
 *
 * Lifecycle order:
 * 1. session_start settings load (registered first)
 * 2. accounts session_start sync
 * 3. auth-policy reconcile
 * Auth-policy compact/tree gates register before native compaction handlers.
 * Auth-policy session_shutdown release registers before other shutdown handlers.
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
	let tps!: ReturnType<typeof registerTps>;
	let compaction!: CompactionController;
	let authPolicy!: AuthPolicyController;
	const accountsRef: {
		current: ReturnType<typeof accountsExtension> | undefined;
	} = { current: undefined };

	// 1) Settings load must run before accounts sync and policy reconcile.
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
	});

	// 2) Auth-policy before tps/accounts/compaction so session_shutdown release is first
	// and compact/tree gates precede native compaction.
	authPolicy = registerAuthPolicy(pi, {
		getSettings: () => settings,
		authState:
			dependencies.authState ??
			({
				read: () => {
					const accounts = accountsRef.current;
					if (!accounts) {
						return Promise.resolve({ kind: "absent" as const });
					}
					return accounts.getCodexAuthState();
				},
			} satisfies CodexAuthStateReader),
	});

	tps = registerTps(pi, settings.tps);

	const accounts = accountsExtension(pi, {
		...dependencies.accounts,
		authPath: dependencies.authPath ?? dependencies.accounts?.authPath,
		registerCommand: true,
		onAuthChanged: async (ctx) => {
			await authPolicy.reconcile(ctx);
		},
	});
	accountsRef.current = accounts;

	// 3) Native compaction after auth-policy compact/tree gates.
	compaction = registerCompaction(pi, settings.openaiNativeCompaction);

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
		getAuthPolicyStatusLine: () => authPolicy.getStatusLine(),
		reconcileAuthPolicy: async (ctx: ExtensionCommandContext) => {
			await authPolicy.reconcile(ctx);
		},
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
		onSettingsChanged: async (ctx: ExtensionCommandContext) => {
			await authPolicy.reconcile(ctx);
		},
	});

	// 4) After accounts sync (registered inside accountsExtension), reconcile policy.
	pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
		await authPolicy.reconcile(ctx);
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

	// Auth-policy release already registered earlier; this only clears UI/status state.
	pi.on("session_shutdown", async (_event: unknown, ctx: ExtensionContext) => {
		ctx.ui.setStatus("codex-fast-mode", undefined);
		tps.clear(ctx);
	});
}
