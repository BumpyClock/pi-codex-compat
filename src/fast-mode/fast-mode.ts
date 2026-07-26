import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { updateFastModeSetting } from "../settings/load.js";
import type { PackageSettings } from "../settings/types.js";
import { isRecord } from "../shared/is-record.js";
import { guardObservableCommand } from "../shared/mode.js";

export const SERVICE_TIER = "priority";
export const FAST_MODE_STATUS_KEY = "codex-fast-mode";
export const CODEX_PROVIDER = "openai-codex";
export const CODEX_RESPONSES_API = "openai-codex-responses";

type ModelLike = {
	provider?: string;
	id?: string;
	api?: string;
};

export type FastModeController = {
	isEnabled(): boolean;
	setEnabled(enabled: boolean): void;
	updateStatus(ctx: ExtensionContext, model?: ModelLike): void;
	applyPayload(payload: unknown, model?: ModelLike): unknown | undefined;
	statusText(): string;
};

export function isCodexModel(model: ModelLike | undefined): boolean {
	if (!model) return false;
	return model.provider === CODEX_PROVIDER || model.id?.includes("codex") === true;
}

/** Primary gate: verified openai-codex + openai-codex-responses only. */
export function isVerifiedCodexResponsesModel(model: ModelLike | undefined): boolean {
	return model?.provider === CODEX_PROVIDER && model.api === CODEX_RESPONSES_API;
}

/**
 * Secondary payload sanity check. Must not alone authorize priority tier injection.
 * Prefer isVerifiedCodexResponsesModel for the authority gate.
 */
export function isOpenAICodexResponsesPayload(
	payload: unknown,
): payload is Record<string, unknown> {
	if (!isRecord(payload)) return false;
	const model = payload.model;
	if (typeof model === "string" && model.includes("codex")) return true;
	return (
		payload.stream === true &&
		typeof payload.instructions === "string" &&
		Array.isArray(payload.input) &&
		payload.tool_choice === "auto" &&
		"prompt_cache_key" in payload
	);
}

export function injectPriorityServiceTier(
	payload: unknown,
	model?: ModelLike,
): Record<string, unknown> | undefined {
	// Authority: provider + api. Payload shape is secondary sanity only.
	if (!isVerifiedCodexResponsesModel(model)) return undefined;
	if (!isOpenAICodexResponsesPayload(payload)) return undefined;
	return {
		...payload,
		service_tier: SERVICE_TIER,
	};
}

export function createFastModeController(initial: PackageSettings["fastMode"]): FastModeController {
	let enabled = initial.enabled;

	const statusText = () => `OpenAI Codex fast mode is ${enabled ? "on" : "off"}.`;

	const updateStatus = (ctx: ExtensionContext, model: ModelLike | undefined = ctx.model) => {
		if (!isCodexModel(model)) {
			ctx.ui.setStatus(FAST_MODE_STATUS_KEY, undefined);
			return;
		}
		const label = `⚡ fast:${enabled ? "on" : "off"}`;
		ctx.ui.setStatus(
			FAST_MODE_STATUS_KEY,
			enabled ? ctx.ui.theme.fg("accent", label) : ctx.ui.theme.fg("dim", label),
		);
	};

	return {
		isEnabled: () => enabled,
		setEnabled(next) {
			enabled = next;
		},
		updateStatus,
		applyPayload(payload, model) {
			if (!enabled) return undefined;
			return injectPriorityServiceTier(payload, model);
		},
		statusText,
	};
}

export function registerFastMode(
	pi: ExtensionAPI,
	controller: FastModeController,
	options: { cwd?: string } = {},
): void {
	const statusText = () => controller.statusText();

	async function applyFastMode(ctx: ExtensionContext, enabled: boolean) {
		try {
			await updateFastModeSetting(enabled, options.cwd ?? ctx.cwd, {
				isProjectTrusted: ctx.isProjectTrusted(),
			});
		} catch (error) {
			ctx.ui.notify(
				`Failed to save OpenAI Codex fast mode: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return;
		}
		controller.setEnabled(enabled);
		controller.updateStatus(ctx);
		ctx.ui.notify(statusText(), "info");
	}

	pi.registerCommand("fast", {
		description:
			"Toggle OpenAI Codex priority service tier. Usage: /fast [toggle|on|off|status]. No args toggles.",
		getArgumentCompletions: (prefix) => {
			const commands = ["toggle", "on", "off", "status"];
			const filtered = commands.filter((command) => command.startsWith(prefix.trim()));
			return filtered.length > 0
				? filtered.map((command) => ({ value: command, label: command }))
				: null;
		},
		handler: async (args, ctx: ExtensionCommandContext) => {
			if (guardObservableCommand("/fast", ctx) === "stop") return;
			const action = args.trim().toLowerCase() || "toggle";
			if (action === "toggle") {
				await applyFastMode(ctx, !controller.isEnabled());
				return;
			}
			if (action === "on") {
				await applyFastMode(ctx, true);
				return;
			}
			if (action === "off") {
				await applyFastMode(ctx, false);
				return;
			}
			if (action === "status") {
				controller.updateStatus(ctx);
				ctx.ui.notify(statusText(), "info");
				return;
			}
			ctx.ui.notify("Usage: /fast [toggle|on|off|status]", "warning");
		},
	});

	pi.registerShortcut("alt+shift+f", {
		description: "Toggle OpenAI Codex fast mode",
		handler: async (ctx) => {
			await applyFastMode(ctx, !controller.isEnabled());
		},
	});

	pi.on("model_select", async (event, ctx) => {
		controller.updateStatus(ctx, event.model);
	});
}
