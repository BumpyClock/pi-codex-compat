import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { updateFastModeSetting } from "../settings/load.js";
import type { FastModeSettings, SpeedMode } from "../settings/types.js";
import { isRecord } from "../shared/is-record.js";
import { guardObservableCommand } from "../shared/mode.js";

export const SERVICE_TIER = "priority";
export const ULTRAFAST_SERVICE_TIER = "ultrafast";
export const FAST_MODE_STATUS_KEY = "codex-fast-mode";
export const CODEX_PROVIDER = "openai-codex";
export const CODEX_RESPONSES_API = "openai-codex-responses";
export const ULTRAFAST_MODELS = ["gpt-6-astra", "gpt-6.1-sol"] as const;
export const ULTRAFAST_COST_WARNING =
	"Ultrafast costs more. Codex requires Pro $500 or eligible Enterprise/Edu access. " +
	"Pro $500 uses included allowance at 8x Standard, then credits at 6x. " +
	"API-key requests use separate Ultrafast API pricing. Pi cost estimates may omit this premium. " +
	"This command does not grant access or change authentication.";

type ModelLike = {
	provider?: string;
	id?: string;
	api?: string;
};

export type FastModeController = {
	getMode(): SpeedMode;
	setMode(mode: SpeedMode): void;
	updateStatus(ctx: ExtensionContext, model?: ModelLike): void;
	applyPayload(payload: unknown, model?: ModelLike): unknown | undefined;
	statusText(model?: ModelLike): string;
};

export type ChangeSpeedMode = (ctx: ExtensionContext, mode: SpeedMode) => Promise<void>;

export function speedModeFromSettings(settings: FastModeSettings): SpeedMode {
	if (!settings.enabled) return "standard";
	return settings.tier === "ultrafast" ? "ultrafast" : "fast";
}

export function isCodexModel(model: ModelLike | undefined): boolean {
	if (!model) return false;
	return model.provider === CODEX_PROVIDER || model.id?.includes("codex") === true;
}

/** Primary gate: verified openai-codex + openai-codex-responses only. */
export function isVerifiedCodexResponsesModel(model: ModelLike | undefined): boolean {
	return model?.provider === CODEX_PROVIDER && model.api === CODEX_RESPONSES_API;
}

export function isUltrafastModel(model: ModelLike | undefined): boolean {
	return (
		(isVerifiedCodexResponsesModel(model) ||
			(model?.provider === "openai" && model.api === "openai-responses")) &&
		ULTRAFAST_MODELS.some((id) => id === model?.id)
	);
}

/** Secondary payload sanity check. Must not alone authorize priority tier injection. */
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
	if (!isVerifiedCodexResponsesModel(model)) return undefined;
	if (!isOpenAICodexResponsesPayload(payload)) return undefined;
	return { ...payload, service_tier: SERVICE_TIER };
}

export function injectUltrafastServiceTier(
	payload: unknown,
	model?: ModelLike,
): Record<string, unknown> | undefined {
	if (!isUltrafastModel(model) || !isRecord(payload) || payload.model !== model?.id) {
		return undefined;
	}
	return { ...payload, service_tier: ULTRAFAST_SERVICE_TIER };
}

export function createFastModeController(initial: FastModeSettings): FastModeController {
	let mode = speedModeFromSettings(initial);

	const statusText = (model?: ModelLike) => {
		const summary = `OpenAI Codex fast mode is ${mode === "fast" ? "on" : "off"}. Ultrafast mode is ${mode === "ultrafast" ? "on" : "off"}.`;
		if (mode === "ultrafast" && !isUltrafastModel(model)) {
			return `${summary} Ultrafast is inactive for this model/provider; requests are unchanged. Select ${ULTRAFAST_MODELS.join(" or ")} on OpenAI Responses or Codex Responses.`;
		}
		return summary;
	};

	const updateStatus = (ctx: ExtensionContext, model: ModelLike | undefined = ctx.model) => {
		if (mode === "ultrafast") {
			const supported = isUltrafastModel(model);
			ctx.ui.setStatus(
				FAST_MODE_STATUS_KEY,
				ctx.ui.theme.fg(
					supported ? "accent" : "warning",
					supported ? "⚡ ultrafast:on" : "⚡ ultrafast:inactive (unsupported model)",
				),
			);
			return;
		}
		if (!isCodexModel(model)) {
			ctx.ui.setStatus(FAST_MODE_STATUS_KEY, undefined);
			return;
		}
		const enabled = mode === "fast";
		const label = `⚡ fast:${enabled ? "on" : "off"}`;
		ctx.ui.setStatus(
			FAST_MODE_STATUS_KEY,
			enabled ? ctx.ui.theme.fg("accent", label) : ctx.ui.theme.fg("dim", label),
		);
	};

	return {
		getMode: () => mode,
		setMode(next) {
			mode = next;
		},
		updateStatus,
		applyPayload(payload, model) {
			if (mode === "ultrafast") return injectUltrafastServiceTier(payload, model);
			if (mode === "fast") return injectPriorityServiceTier(payload, model);
			return undefined;
		},
		statusText,
	};
}

export function registerFastMode(
	pi: ExtensionAPI,
	controller: FastModeController,
	options: { cwd?: string } = {},
): ChangeSpeedMode {
	const changeMode: ChangeSpeedMode = async (ctx, mode) => {
		if (mode === controller.getMode()) {
			controller.updateStatus(ctx);
			ctx.ui.notify(controller.statusText(ctx.model), "info");
			return;
		}
		if (mode === "ultrafast" && !isUltrafastModel(ctx.model)) {
			ctx.ui.notify(
				`Ultrafast requires ${ULTRAFAST_MODELS.join(" or ")} on OpenAI Responses or Codex Responses. Speed mode unchanged.`,
				"warning",
			);
			return;
		}
		if (mode === "ultrafast") {
			ctx.ui.notify(ULTRAFAST_COST_WARNING, "warning");
		}
		try {
			await updateFastModeSetting(mode !== "standard", options.cwd ?? ctx.cwd, {
				isProjectTrusted: ctx.isProjectTrusted(),
				tier: mode === "ultrafast" ? "ultrafast" : "priority",
			});
		} catch (error) {
			ctx.ui.notify(
				`Failed to save OpenAI speed mode: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return;
		}
		controller.setMode(mode);
		controller.updateStatus(ctx);
		ctx.ui.notify(controller.statusText(ctx.model), "info");
	};

	for (const name of ["fast", "ultrafast", "utrafast"] as const) {
		const target = name === "fast" ? "fast" : "ultrafast";
		pi.registerCommand(name, {
			description: `Toggle OpenAI ${target === "fast" ? "Codex priority" : "Ultrafast"} service tier. Usage: /${name} [toggle|on|off|status]. No args toggles.`,
			getArgumentCompletions: (prefix) => {
				const commands = ["toggle", "on", "off", "status"];
				const filtered = commands.filter((command) => command.startsWith(prefix.trim()));
				return filtered.length > 0
					? filtered.map((command) => ({ value: command, label: command }))
					: null;
			},
			handler: async (args, ctx: ExtensionCommandContext) => {
				if (guardObservableCommand(`/${name}`, ctx) === "stop") return;
				const action = args.trim().toLowerCase() || "toggle";
				const current = controller.getMode();
				if (action === "status") {
					controller.updateStatus(ctx);
					ctx.ui.notify(controller.statusText(ctx.model), "info");
					return;
				}
				if (action === "on" || action === "off" || action === "toggle") {
					let next = current;
					if (action === "on" || (action === "toggle" && current !== target)) {
						next = target;
					} else if (current === target) {
						next = "standard";
					}
					await changeMode(ctx, next);
					return;
				}
				ctx.ui.notify(`Usage: /${name} [toggle|on|off|status]`, "warning");
			},
		});
	}

	pi.registerShortcut("alt+shift+f", {
		description: "Toggle OpenAI Codex fast mode",
		handler: async (ctx) => {
			await changeMode(ctx, controller.getMode() === "fast" ? "standard" : "fast");
		},
	});

	pi.on("model_select", async (event, ctx) => {
		controller.updateStatus(ctx, event.model);
		if (controller.getMode() === "ultrafast" && !isUltrafastModel(event.model)) {
			ctx.ui.notify(controller.statusText(event.model), "warning");
		}
	});
	return changeMode;
}
