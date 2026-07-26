# @bumpyclock/pi-codex-compat

One Pi extension that consolidates OpenAI/Codex-focused behavior:

- `/fast` priority service tier (`service_tier: "priority"`) for verified OpenAI Codex Responses requests
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
| `/codex` | TUI menu | Accounts, Quota, Fast mode, Historical usage, Settings, Status, Help |
| `/codex status` | TUI, RPC | Feature status |
| `/codex help` | TUI, RPC | Help text |
| `/accounts` | TUI | Named Codex OAuth account manager |
| `/usage` | TUI | Live Codex subscription quota |
| `/usage-history` | TUI, RPC | Agent-driven historical cost report |
| `/fast [toggle\|on\|off\|status]` | TUI, RPC | Priority tier toggle |
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
  "fastMode": { "enabled": false },
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
  }
}
```

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

## License

MIT. See [LICENSE](./LICENSE) and [NOTICES.md](./NOTICES.md) for adapted upstream attribution (Jordy Van Domselaar; narumiruna).
