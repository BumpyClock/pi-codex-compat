# @bumpyclock/pi-codex-compat

One Pi extension that consolidates OpenAI/Codex-focused behavior:

- `/fast` priority service tier (`service_tier: "priority"`) for verified OpenAI Codex Responses requests
- Optional `/ultrafast` service tier for supported OpenAI/Codex models (`/utrafast` alias), off by default
- OpenAI native compaction replay for `openai` and `openai-codex` Responses APIs
- Named OpenAI Codex OAuth accounts (`/accounts`)
- Live Codex subscription quota (`/usage`)
- Historical Pi/Codex CLI cost report (`/usage-history`)
- Token throughput status (all providers)
- Unified `/codex` manager menu

Minimum tested Pi release: **0.82.1** (`@earendil-works/*`).

## Install

```bash
pi install npm:@bumpyclock/pi-codex-compat
```

Or from a local checkout:

```bash
pi install /absolute/path/to/pi-codex-compat
```

## Important migration notes

Do **not** load this package together with:

- local `openai-codex-fast-mode.ts`
- local `openai-compaction`
- local `usage.ts` / `token-rate-status.ts`
- `pi-accounts` / `pi-codex-accounts`
- `pi-usage` / `pi-codex-usage`

Duplicate extensions can refresh the same rotating credential or register conflicting commands.

Disable or remove those local/extension copies before enabling this package.

## Commands

| Command | Modes | Behavior |
| --- | --- | --- |
| `/codex` | TUI menu | Accounts, Quota, Fast mode, Ultrafast mode, Historical usage, Settings, Status, Help |
| `/codex status` | TUI, RPC | Feature status |
| `/codex help` | TUI, RPC | Help text |
| `/accounts` | TUI | Named Codex OAuth account manager |
| `/usage` | TUI | Live Codex subscription quota |
| `/usage-history` | TUI, RPC | Agent-driven historical cost report |
| `/fast [toggle\|on\|off\|status]` | TUI, RPC | Priority tier toggle |
| `/ultrafast [toggle\|on\|off\|status]` | TUI, RPC | Opt-in Ultrafast tier toggle; `/utrafast` alias |
| `Alt+Shift+F` | TUI | Toggle fast mode |

Print and JSON modes throw a clear unsupported-mode error for these commands because Pi 0.82.1 has no observable extension-command output channel there. RPC receives a notification for TUI-only menus.

## Settings

Canonical user settings:

```text
~/.pi/agent/pi-codex-compat.json
```

Trusted project overrides (non-secret only):

```text
<workspace>/.pi/pi-codex-compat.json
```

Private Codex account credentials:

```text
~/.pi/agent/pi-codex-compat-accounts.json
```

Example:

```json
{
  "fastMode": { "enabled": false, "tier": "priority" },
  "openaiNativeCompaction": {
    "enabled": true,
    "debug": false,
    "redactSensitiveData": true,
    "supportedProviders": ["openai", "openai-codex"],
    "supportedApis": ["openai-responses", "openai-codex-responses"]
  },
  "tps": {
    "enabled": true,
    "notifyOnComplete": true
  },
  "auth": {
    "disableApiKeyWhenCodexAuthenticated": false
  }
}
```

### Ultrafast mode

Select `gpt-6-astra` or `gpt-6.1-sol`, then run `/ultrafast on` (or `/utrafast on`). Run `/ultrafast off` to disable it, or `/ultrafast status` to inspect the selected mode. Commands and the `/codex` menu share validation, persistence, and cost warnings.

Ultrafast injects `service_tier: "ultrafast"` only for these exact model IDs on `openai` / `openai-responses` or `openai-codex` / `openai-codex-responses`. Other providers, APIs, and models are unchanged. Unsupported selections cannot enable Ultrafast. Switching to an unsupported model after enabling it leaves the preference saved, but marks Ultrafast inactive in status and leaves requests unchanged. Returning to a supported model resumes Ultrafast requests.

Speed modes are mutually exclusive. `/fast on` replaces Ultrafast with priority mode; `/ultrafast on` replaces priority mode. Each command's `off` disables only its own mode. `Alt+Shift+F` continues to toggle priority mode, replacing Ultrafast when pressed. Neither mode changes reasoning effort, selects a different model, switches accounts, or falls back to API-key billing.

Settings stay backward compatible. Existing `fastMode.enabled` values retain their meaning, and an absent `tier` defaults to `"priority"`. Enabling Ultrafast saves `"fastMode": { "enabled": true, "tier": "ultrafast" }` in the canonical user file. `enabled: false` disables both tiers. Recognized fields inherit through the existing trusted-project precedence rules. Commands change the current session immediately after a successful user-setting write; trusted project overrides can take effect again on a settings reload or new session.

**Eligibility and cost.** OpenAI currently lists GPT-6 Astra and GPT-6.1 Sol Ultrafast for Pro $500 and eligible Enterprise/Edu workspaces when signed in through ChatGPT. Plus, Pro $100, Pro $200, and Business do not include it at launch, even with purchased credits. Pro $500 consumes included allowance at 8x Standard, then purchased credits at 6x Standard. Enterprise/Edu billing follows the workspace agreement. API-key access has separate Ultrafast pricing and rate limits. These are usage multipliers, not speed guarantees.

Pi 0.82.1 does not apply an Ultrafast service-tier cost multiplier. Pi cost estimates and historical reports can understate charges. Use OpenAI usage/billing for actual cost.

This extension requests a tier; it does not grant plan access or verify entitlement from plan-name strings. Provider access/rate-limit errors remain visible through Pi, with no automatic tier or authentication fallback. A successful command means the preference was saved, not that OpenAI accepted an Ultrafast request.

OpenAI supports HTTP and recommends persistent WebSockets for tool-heavy agents. No transport change is required to request the tier. Live acceptance and latency with an eligible Codex OAuth account have not been verified here.

Official references:

- [Ultrafast API guide](https://developers.openai.com/api/docs/guides/ultrafast-mode).
- [ChatGPT Work and Codex eligibility and usage](https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex).
- [Fast mode and Ultrafast FAQ](https://help.openai.com/en/articles/11647665-fast-mode-faq).

### Auth cost-safety policy

`auth.disableApiKeyWhenCodexAuthenticated` (default `false`) is an opt-in guard:

- When **on** and a Codex OAuth login exists (default Pi `openai-codex` OAuth in `auth.json`, or a named account selected by this extension), every exact provider `openai` model is hidden — including built-ins and `models.json` additions.
- Stale sessions still selecting `openai` are blocked on each turn, compaction, and summarizing tree navigation. Non-summarizing tree navigation stays allowed.
- `openai-codex` and unrelated providers are unchanged. The policy never auto-switches models and never mutates `OPENAI_API_KEY` or credential files.
- When auth storage cannot be read, presence is treated as unknown and the policy fails closed while enabled.
- Toggle from `/codex` → Settings. Status shows `Direct OpenAI API key: allowed|blocked while Codex is logged in`.

### Precedence

Defaults → old package-local compaction settings → legacy global `settings.json` → canonical user settings → legacy project `settings.json` → canonical project settings → `PI_OPENAI_NATIVE_COMPACTION_*` environment overrides.

Canonical values win over legacy values at the same scope. Environment overrides win over all files. Validated recognized values are migrated into canonical files; legacy sources are retained for rollback.

Legacy sources consulted when canonical values are absent:

- `~/.pi/agent/settings.json` → `extensionSettings.openaiCodexFastMode`
- `~/.pi/agent/extensions/openai-compaction/settings.json`
- `openaiNativeCompaction` in global/project `settings.json`
- `PI_OPENAI_NATIVE_COMPACTION_*`
- `pi-accounts.json` → only the `openai-codex` provider section
- `pi-codex-accounts.json` / `codex-accounts.json`

## Security and failure behavior

- Account activation failures fail closed for `openai-codex` (no silent fallback credential).
- When `auth.disableApiKeyWhenCodexAuthenticated` is enabled, unknown/corrupt Codex auth storage fails closed for direct `openai` API-key use (hide/block with a redacted error).
- The auth.json presence reader is extension-owned and read-only: it never creates or writes `auth.json`, and never logs token fields.
- Compaction failures fail open to Pi's normal compaction.
- Quota requests send credentials only to the official ChatGPT origin (`https://chatgpt.com`) and use bounded response reads.
- Debug artifacts redact authorization headers, API keys, JWT-like values, and exact credential strings.
- Credential files use private directory permissions and mode `0600` on POSIX.
- **Pi extensions run with full user permissions.** Only install packages you trust. See Pi's unsandboxed extension trust model.

## Development

```bash
npm install
npm run format
npm run check
npm run pack:dry
npm run smoke:pi
```

## Releases

Merges to `main` update a Release Please pull request. Merging that release pull request creates a GitHub release and publishes the matching package version through `.github/workflows/release.yml`.

The workflow uses npm trusted publishing with GitHub Actions OIDC and provenance; it does not require a long-lived npm token. Manual runs default to a dry run. Choose `release` only when `package.json` contains the version to release.

## License

MIT. See [LICENSE](./LICENSE) and [NOTICES.md](./NOTICES.md) for adapted upstream attribution (Jordy Van Domselaar; narumiruna).
