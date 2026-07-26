import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type PiMode = ExtensionContext["mode"];

export function isInteractiveUiMode(ctx: Pick<ExtensionContext, "mode" | "hasUI">): boolean {
	return ctx.hasUI && (ctx.mode === "tui" || ctx.mode === "rpc");
}

export function isTuiMode(ctx: Pick<ExtensionContext, "mode">): boolean {
	return ctx.mode === "tui";
}

export function unsupportedModeError(command: string, mode: PiMode): Error {
	return new Error(
		`${command} is not supported in ${mode} mode. Use TUI or RPC for observable extension-command output.`,
	);
}

export function requireObservableCommandMode(command: string, ctx: ExtensionCommandContext): void {
	if (ctx.mode === "print" || ctx.mode === "json") {
		throw unsupportedModeError(command, ctx.mode);
	}
}

export function tuiOnlyMenuNotice(command: string): string {
	return `${command} opens an interactive menu and requires TUI mode.`;
}

/**
 * TUI-only menus: TUI runs the menu; RPC gets an observable notification;
 * print/json throw because Pi 0.82.1 has no observable extension-command output there.
 */
export function guardTuiOnlyMenu(command: string, ctx: ExtensionCommandContext): "run" | "stop" {
	if (ctx.mode === "print" || ctx.mode === "json") {
		throw unsupportedModeError(command, ctx.mode);
	}
	if (ctx.mode === "rpc" || !ctx.hasUI) {
		ctx.ui.notify(tuiOnlyMenuNotice(command), "warning");
		return "stop";
	}
	return "run";
}

/**
 * Commands that support TUI + RPC observable output, but not print/json.
 */
export function guardObservableCommand(
	command: string,
	ctx: ExtensionCommandContext,
): "run" | "stop" {
	requireObservableCommandMode(command, ctx);
	return "run";
}
