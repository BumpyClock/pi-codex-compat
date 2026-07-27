import type { Provider } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ProviderConfig,
	SessionBeforeCompactEvent,
	SessionBeforeTreeEvent,
} from "@earendil-works/pi-coding-agent";
import {
	type CodexAuthStateReader,
	createCodexAuthStateReader,
	isCodexAuthBlockingState,
	type RedactedCodexAuthState,
} from "../accounts/codex-auth-state.js";
import type { PackageSettings } from "../settings/types.js";
import {
	formatDirectOpenAIStatus,
	PROVIDER_CONFLICT_MESSAGE,
	STALE_OPENAI_BLOCK_MESSAGE,
	UNKNOWN_AUTH_BLOCK_MESSAGE,
} from "./messages.js";

const OPENAI_PROVIDER_ID = "openai";

type RuntimeProviderConfig = ProviderConfig;

type PriorOpenAIRegistration =
	| { kind: "legacy"; config: RuntimeProviderConfig }
	| { kind: "native"; provider: Provider }
	| { kind: "builtin" };

export type AuthPolicyController = {
	/** Reconcile settings + auth presence into provider overlay and gate state. */
	reconcile(ctx: ExtensionContext): Promise<void>;
	/**
	 * Restore owned openai registration (if still owned) and clear latch/ownership.
	 * Call on session_shutdown before other extension cleanup.
	 */
	release(ctx: ExtensionContext): void;
	/** Fresh presence check used by per-turn / compact / tree gates. */
	evaluateGate(ctx: ExtensionContext): Promise<AuthPolicyGateDecision>;
	getStatusLine(): string;
	isBlockingActive(): boolean;
	hasProviderConflict(): boolean;
	/** Test/inspection helper. */
	getLastAuthState(): RedactedCodexAuthState | undefined;
};

export type AuthPolicyGateDecision =
	| { action: "allow" }
	| {
			action: "block";
			message: string;
			reason: "stale_openai" | "unknown_auth" | "provider_conflict";
	  };

export type AuthPolicyDependencies = {
	getSettings: () => PackageSettings;
	authState?: CodexAuthStateReader;
};

export function registerAuthPolicy(
	pi: ExtensionAPI,
	dependencies: AuthPolicyDependencies,
): AuthPolicyController {
	const authState = dependencies.authState ?? createCodexAuthStateReader();
	let lastAuthState: RedactedCodexAuthState | undefined;
	let blockingActive = false;
	/** Latched until release()/reload. Never retake ownership while set. */
	let providerConflict = false;
	let conflictReported = false;
	let prior: PriorOpenAIRegistration | undefined;
	let applied: RuntimeProviderConfig | undefined;
	let owned = false;

	const controller: AuthPolicyController = {
		async reconcile(ctx) {
			const settings = dependencies.getSettings();
			const enabled = settings.auth.disableApiKeyWhenCodexAuthenticated === true;

			// Conflict latches until release/reload: keep openai gates armed, never retake ownership.
			if (providerConflict) {
				blockingActive = enabled;
				if (enabled) {
					// Re-surface once per latch if UI missed the first report.
					if (!conflictReported) markConflict(ctx);
				}
				return;
			}

			const state = await authState.read();
			lastAuthState = state;
			const shouldHide = enabled && isCodexAuthBlockingState(state);
			blockingActive = shouldHide;

			if (!shouldHide) {
				restoreIfOwned(ctx);
				return;
			}

			if (owned) {
				if (!stillOwns(ctx)) {
					markConflict(ctx);
					// Drop ownership tracking only; keep conflict latch. Do not clobber foreign reg.
					clearOwnershipTracking();
					return;
				}
				return;
			}

			takeOwnership(ctx);
		},

		release(ctx) {
			// Restore only while we still own the exact applied registration.
			if (owned) {
				if (stillOwns(ctx)) {
					try {
						restoreRegistration();
					} catch (error) {
						notify(
							ctx,
							`Failed to restore openai provider on auth policy release: ${error instanceof Error ? error.message : String(error)}`,
							"error",
						);
					}
				} else {
					// Foreign registration present — never clobber; latch is cleared by release/reload.
					markConflict(ctx);
				}
			}
			clearOwnershipTracking();
			providerConflict = false;
			conflictReported = false;
			blockingActive = false;
			lastAuthState = undefined;
		},

		async evaluateGate(ctx) {
			const settings = dependencies.getSettings();
			if (settings.auth.disableApiKeyWhenCodexAuthenticated !== true) {
				return { action: "allow" };
			}

			// Latched conflict: block exact openai even if auth later becomes absent.
			if (providerConflict) {
				blockingActive = true;
				if (!isOpenAIModel(ctx.model)) return { action: "allow" };
				return {
					action: "block",
					reason: "provider_conflict",
					message: `${STALE_OPENAI_BLOCK_MESSAGE} (${PROVIDER_CONFLICT_MESSAGE})`,
				};
			}

			const state = await authState.read();
			lastAuthState = state;
			if (state.kind === "absent") {
				blockingActive = false;
				return { action: "allow" };
			}
			blockingActive = true;

			if (!isOpenAIModel(ctx.model)) {
				return { action: "allow" };
			}

			if (state.kind === "unknown") {
				return {
					action: "block",
					reason: "unknown_auth",
					message: `${UNKNOWN_AUTH_BLOCK_MESSAGE} (${state.message})`,
				};
			}

			return {
				action: "block",
				reason: "stale_openai",
				message: STALE_OPENAI_BLOCK_MESSAGE,
			};
		},

		getStatusLine() {
			return formatDirectOpenAIStatus(blockingActive || providerConflict);
		},

		isBlockingActive() {
			return blockingActive || providerConflict;
		},

		hasProviderConflict() {
			return providerConflict;
		},

		getLastAuthState() {
			return lastAuthState;
		},
	};

	// Register cost-safety gates before native-compaction handlers (caller orders factory).
	// session_shutdown release is registered here so it runs before later shutdown handlers.
	pi.on("session_shutdown", (_event, ctx) => {
		controller.release(ctx);
	});

	pi.on("session_before_compact", async (_event: SessionBeforeCompactEvent, ctx) => {
		const decision = await controller.evaluateGate(ctx);
		if (decision.action === "allow") return undefined;
		notify(ctx, decision.message, "error");
		return { cancel: true };
	});

	pi.on("session_before_tree", async (event: SessionBeforeTreeEvent, ctx) => {
		if (!event.preparation.userWantsSummary) return undefined;
		const decision = await controller.evaluateGate(ctx);
		if (decision.action === "allow") return undefined;
		notify(ctx, decision.message, "error");
		return { cancel: true };
	});

	pi.on("turn_start", async (_event, ctx) => {
		const decision = await controller.evaluateGate(ctx);
		if (decision.action === "allow") return;
		notify(ctx, decision.message, "error");
		ctx.abort();
	});

	pi.on("model_select", async (_event, ctx) => {
		await controller.reconcile(ctx);
	});

	function takeOwnership(ctx: ExtensionContext): void {
		// Never retake after a latched conflict (reload/release clears the latch).
		if (providerConflict) return;

		const registry = getRegistry(ctx);
		const legacy = registry.getRegisteredProviderConfig?.(OPENAI_PROVIDER_ID);
		const native = registry.getRegisteredNativeProvider?.(OPENAI_PROVIDER_ID);

		if (native) {
			prior = { kind: "native", provider: native };
		} else if (legacy) {
			prior = { kind: "legacy", config: cloneProviderConfig(legacy) };
		} else {
			prior = { kind: "builtin" };
		}

		const emptyModels: NonNullable<RuntimeProviderConfig["models"]> = [];
		try {
			pi.registerProvider(OPENAI_PROVIDER_ID, { models: emptyModels });
		} catch (error) {
			prior = undefined;
			notify(
				ctx,
				`Failed to hide openai models for auth policy: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return;
		}

		const current = registry.getRegisteredProviderConfig?.(OPENAI_PROVIDER_ID);
		applied = current ? cloneProviderConfig(current) : { models: emptyModels };
		// Keep the live models array reference so shallow ownership checks match runtime storage.
		if (current?.models) applied.models = current.models;
		owned = true;
	}

	function restoreIfOwned(ctx: ExtensionContext): void {
		if (!owned) return;
		if (!stillOwns(ctx)) {
			markConflict(ctx);
			clearOwnershipTracking();
			return;
		}

		try {
			restoreRegistration();
		} catch (error) {
			notify(
				ctx,
				`Failed to restore openai provider after auth policy release: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		} finally {
			clearOwnershipTracking();
		}
	}

	function restoreRegistration(): void {
		pi.unregisterProvider(OPENAI_PROVIDER_ID);
		if (prior?.kind === "legacy") {
			pi.registerProvider(OPENAI_PROVIDER_ID, prior.config);
		} else if (prior?.kind === "native") {
			pi.registerProvider(prior.provider);
		}
		// builtin: unregister alone restores built-ins
	}

	function stillOwns(ctx: ExtensionContext): boolean {
		if (!owned || !applied) return false;
		const registry = getRegistry(ctx);
		const native = registry.getRegisteredNativeProvider?.(OPENAI_PROVIDER_ID);
		if (native) return false;
		const current = registry.getRegisteredProviderConfig?.(OPENAI_PROVIDER_ID);
		return providerConfigsMatch(current, applied);
	}

	function markConflict(ctx: ExtensionContext): void {
		providerConflict = true;
		if (!conflictReported) {
			conflictReported = true;
			notify(ctx, PROVIDER_CONFLICT_MESSAGE, "warning");
		}
	}

	function clearOwnershipTracking(): void {
		owned = false;
		prior = undefined;
		applied = undefined;
	}

	return controller;
}

function isOpenAIModel(model: ExtensionContext["model"] | undefined): boolean {
	return model?.provider === OPENAI_PROVIDER_ID;
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
	try {
		ctx.ui.notify(message, level);
	} catch {
		// Stale UI contexts must not break gates.
	}
}

function getRegistry(ctx: ExtensionContext): {
	getRegisteredProviderConfig?: (provider: string) => RuntimeProviderConfig | undefined;
	getRegisteredNativeProvider?: (provider: string) => Provider | undefined;
} {
	return ctx.modelRegistry as {
		getRegisteredProviderConfig?: (provider: string) => RuntimeProviderConfig | undefined;
		getRegisteredNativeProvider?: (provider: string) => Provider | undefined;
	};
}

function cloneProviderConfig(config: RuntimeProviderConfig): RuntimeProviderConfig {
	const next: RuntimeProviderConfig = { ...config };
	if (config.models) next.models = config.models.map((model) => ({ ...model }));
	else delete next.models;
	if (config.headers) next.headers = { ...config.headers };
	else delete next.headers;
	return next;
}

function providerConfigsMatch(
	left: RuntimeProviderConfig | undefined,
	right: RuntimeProviderConfig | undefined,
): boolean {
	if (left === right) return true;
	if (!left || !right) return !left && !right;
	const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
	for (const key of keys) {
		const leftValue = (left as Record<string, unknown>)[key];
		const rightValue = (right as Record<string, unknown>)[key];
		if (key === "models") {
			if (!modelsMatch(leftValue, rightValue)) return false;
			continue;
		}
		if (key === "headers") {
			if (!headersMatch(leftValue, rightValue)) return false;
			continue;
		}
		if (!Object.is(leftValue, rightValue)) return false;
	}
	return true;
}

function modelsMatch(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (!Array.isArray(left) || !Array.isArray(right)) return false;
	if (left.length !== right.length) return false;
	// Auth policy only applies empty catalogs; treat any equal-length empty as match.
	if (left.length === 0 && right.length === 0) return true;
	return left.every((item, index) => Object.is(item, right[index]));
}

function headersMatch(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (!left || !right) return !left && !right;
	if (typeof left !== "object" || typeof right !== "object") return false;
	const leftRecord = left as Record<string, unknown>;
	const rightRecord = right as Record<string, unknown>;
	const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
	for (const key of keys) {
		if (!Object.is(leftRecord[key], rightRecord[key])) return false;
	}
	return true;
}
