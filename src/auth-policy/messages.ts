export const STALE_OPENAI_BLOCK_MESSAGE =
	"Direct OpenAI API-key models are disabled while Codex OAuth is logged in. Select an openai-codex model or disable auth.disableApiKeyWhenCodexAuthenticated.";

export const UNKNOWN_AUTH_BLOCK_MESSAGE =
	"Cannot determine Codex OAuth auth state; direct OpenAI API-key models are blocked. Fix auth storage or disable auth.disableApiKeyWhenCodexAuthenticated.";

export const PROVIDER_CONFLICT_MESSAGE =
	"openai provider registration changed while pi-codex-compat auth policy owned it. Reload or remove the conflicting registration; request blocking stays active.";

export function formatDirectOpenAIStatus(blocked: boolean): string {
	return blocked
		? "Direct OpenAI API key: blocked while Codex is logged in"
		: "Direct OpenAI API key: allowed";
}

export function formatAuthPolicySetting(enabled: boolean): string {
	return `Block OpenAI API key when Codex logged in: ${enabled ? "on" : "off"}`;
}
