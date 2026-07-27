# Codex subscription auth policy design

## Purpose

Add an opt-in cost-safety policy to `@bumpyclock/pi-codex-compat`: while an OpenAI Codex subscription OAuth credential exists, hide direct OpenAI API-key models and prevent stale sessions from sending direct OpenAI API-key requests.

## Scope and requirements

- Add canonical setting:

  ```json
  {
    "auth": {
      "disableApiKeyWhenCodexAuthenticated": false
    }
  }
  ```

- Default remains `false` for backward compatibility.
- When enabled and a Codex OAuth login exists:
  - Hide every model from exact provider `openai`, including built-in and `models.json` additions.
  - Keep `openai-codex` models available.
  - Block a stale or restored session whose selected model still uses provider `openai` before any provider request.
  - Do not automatically switch models.
  - Show an actionable message directing the user to select an `openai-codex` model or disable the policy.
- When enabled but no Codex OAuth login exists, leave direct `openai` models and API-key behavior unchanged.
- When disabled or after logout, restore the prior `openai` provider registration and model catalog.
- Do not mutate, delete, or mask `OPENAI_API_KEY`; enforcement belongs inside Pi’s model/provider layer and remains scoped to this Pi process.
- Do not affect Azure OpenAI, OpenRouter, GitHub Copilot, or other providers.

## What counts as authenticated

A Codex subscription login exists when either source is present:

1. Pi’s default stored `openai-codex` credential has type `oauth` in `auth.json`.
2. A named `openai-codex` account managed by this extension is selected.

Presence detection must not resolve, refresh, or derive auth. Use an extension-owned, read-only `auth.json` presence reader with the existing `proper-lockfile` dependency and Pi 0.82.1 lock protocol; inspect only whether the `openai-codex` credential type is `oauth`. Do not use Pi’s `readStoredCredential`, because it collapses read and parse errors into absence. The reader must never create or write `auth.json`. Read only active-account metadata from the named-account store. Never return or log token fields.

A stored or selected credential still counts when token refresh or auth derivation fails. If either credential store cannot be read, parsed, or locked, auth presence is `unknown`; while the option is enabled, `unknown` remains fail-closed and produces an actionable redacted error. This can temporarily hide direct OpenAI models when auth storage is corrupt, but it cannot silently resume API billing.

Ambient runtime API keys that are not owned by this extension do not independently prove Codex OAuth authentication.

## Architecture

Add an auth-policy controller owned by the unified extension factory.

- The accounts module exposes redacted Codex auth state: default credential present, named account selected, refresh error, absent, or unknown. It never exposes token values.
- Startup order is explicit: load trusted settings, synchronize accounts, then reconcile policy. Refreshed settings must reach the policy before reconciliation.
- Register the policy’s `session_before_compact` and `session_before_tree` gates before native-compaction handlers, because Pi executes extension handlers in registration order.
- The policy controller reconciles settings plus auth state during:
  - `session_start`, after trusted settings load and account synchronization;
  - named-account login, switch, removal, and logout;
  - `model_select`;
  - every `turn_start`, before provider streaming, so external auth/settings changes during a multi-turn agent run cannot bypass the policy;
  - auth-policy setting changes.
- Hiding uses Pi’s documented provider override behavior: registering `openai` with `models: []` replaces the effective catalog, including `models.json` custom models.
- Before taking ownership, the controller snapshots mutually exclusive OpenAI provider state: legacy extension config from `getRegisteredProviderConfig`, native extension provider from `getRegisteredNativeProvider`, or no extension override (built-in only). Applying the empty-model legacy config can displace a native override, so native state must be restorable with the complete provider object.
- The controller records its complete applied config. It restores the matching legacy config, native provider, or built-in state only while current config/native state still matches what it applied. It must never unregister or overwrite an unknown conflicting registration.
- If another extension changes the `openai` registration while this policy owns it, the controller keeps request blocking active, reports the conflict, and requires reload or conflict removal.
- On each `turn_start`, stale `openai` selections are aborted before provider activity. `session_before_compact` cancels compaction for a stale `openai` selection. `session_before_tree` cancels only tree navigation that requested branch summarization; non-summarizing navigation remains allowed. These gates prevent native/custom summary requests from using direct OpenAI auth.
- Provider registration changes are process-local and reversible. No environment or credential file is edited.

Default Pi `/login` changes may not emit a dedicated extension auth-change event. Therefore every `turn_start`, compaction, and summarizing tree-navigation gate rechecks raw auth presence before model work. Model-list visibility refreshes at the next lifecycle reconciliation (`model_select`, session reload/start, `/codex`, or account action); enforcement does not wait for visibility refresh.

## User experience

- Add `Direct OpenAI API key: allowed|blocked while Codex is logged in` to `/codex status`.
- Add `Block OpenAI API key when Codex logged in: on|off` to `/codex` → Settings.
- Update `/codex help` and README settings/security sections.
- When blocking a stale selection, report:

  `Direct OpenAI API-key models are disabled while Codex OAuth is logged in. Select an openai-codex model or disable auth.disableApiKeyWhenCodexAuthenticated.`

- Non-TUI modes receive the same enforcement; no prompt or model picker is required.

## Settings and persistence

- Validate `auth.disableApiKeyWhenCodexAuthenticated` as a boolean.
- Preserve unknown fields and existing settings precedence: defaults → canonical user settings → trusted canonical project settings, alongside existing legacy layers.
- Persist toggles through the existing atomic `updatePackageSettings` path.
- No legacy migration or environment override is added for this new setting.

## Testing and acceptance

- Settings default, validation, user/project precedence, unknown-field preservation, and persistence.
- Policy off leaves `openai` unchanged.
- Policy on plus no Codex credential leaves `openai` unchanged.
- Default Pi Codex OAuth hides and restores `openai` models; the read-only presence reader neither creates nor writes `auth.json`.
- Selected named Codex account hides and restores `openai` models.
- Refresh/derivation failure remains hidden and blocked.
- Default or named auth-store read/parse/lock failure is represented as unknown and remains hidden and blocked with a redacted error.
- `models.json` OpenAI additions are hidden by the effective empty catalog.
- `openai-codex` and unrelated providers remain available.
- Stale `openai` selection aborts each agent turn, cancels compaction, and cancels summarizing tree navigation before network activity; non-summarizing tree navigation remains allowed.
- Auth or settings changes between tool turns are enforced on the next `turn_start`.
- No automatic model switch and no mutation of `OPENAI_API_KEY` or auth files.
- Existing legacy-config, native-provider, or built-in-only `openai` state is restored exactly; conflicting runtime registration is not clobbered.
- `/codex` Settings, Status, and Help expose the policy correctly across supported modes.
- Full `npm run check`, package dry-run, and Pi smoke test pass.

## Non-goals

- Automatic mapping or switching from `openai` to `openai-codex` models.
- Removing OpenAI credentials from the shell or Pi credential storage.
- Blocking non-OpenAI providers that happen to use OpenAI-compatible APIs.
- Polling auth state in a background timer.
