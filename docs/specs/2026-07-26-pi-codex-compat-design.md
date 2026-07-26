# pi-codex-compat design

## Purpose

Create and publish `@bumpyclock/pi-codex-compat` as one Pi package with one extension entrypoint that consolidates Aditya Sharma's local OpenAI/Codex behavior and selected Codex functionality from `narumiruna/pi-extensions`.

Target checkout: `~/Projects/pi-codex-compat`.

## Scope

### Included

1. **Priority fast mode** from `extensions/openai-codex-fast-mode.ts`.
   - Preserve `/fast [toggle|on|off|status]`.
   - Preserve `Alt+Shift+F`.
   - Add `service_tier: "priority"` only to verified `openai-codex-responses` requests.

2. **OpenAI native compaction** from `extensions/openai-compaction/`, originally based on `@jordyvd/pi-openai-compaction`.
   - Support `openai` and `openai-codex` Responses APIs.
   - Preserve standalone `/responses/compact` behavior, opaque-window persistence, request replay, fail-open behavior, redacted debug artifacts, and existing session compatibility.

3. **Codex named OAuth accounts** adapted from the current `@narumitw/pi-accounts` implementation.
   - Include only `openai-codex`; exclude Anthropic and GitHub Copilot.
   - Preserve provider-owned OAuth, rotating-token refresh, cross-process locking, atomic private storage, runtime auth verification, fail-closed behavior, and Codex WebSocket invalidation.
   - Expose `/accounts` as a compatibility alias and an Accounts action in `/codex`.

4. **Live Codex subscription quota** adapted from the current `@narumitw/pi-usage` implementation.
   - Query only the official Codex usage endpoint using Pi's resolved runtime auth.
   - Validate official auth origin before forwarding credentials.
   - Keep credential-isolated in-memory caching, bounded responses, timeout/cancellation, quota formatting, and a live status item.
   - `/usage` becomes the live quota command.

5. **Historical Pi/Codex CLI cost report** from local `extensions/usage.ts`.
   - Preserve existing agent-driven report behavior under `/usage-history`.
   - This is intentionally separate from live subscription quota because the two reports have different semantics.

6. **Token throughput status** from local `extensions/token-rate-status.ts`.
   - Include TPS status and completion notification for all providers, as explicitly requested.
   - Make it configurable and clean up status on session shutdown.

7. **Unified manager command**.
   - `/codex` with no arguments opens a TUI menu for Accounts, Quota, Fast mode, Historical usage, Settings, Status, and Help.
   - `/codex` accepts only `status` and `help` as textual routes; every other argument is rejected.
   - `/codex` without arguments, `/accounts`, and `/usage` are TUI-only menus. RPC receives an observable notification explaining that the menu requires TUI. Print and JSON modes throw a clear unsupported-mode error.
   - `/codex status`, `/codex help`, `/fast [toggle|on|off|status]`, and `/usage-history` support TUI and RPC. Print and JSON modes throw a clear unsupported-mode error because Pi 0.82.1 has no observable extension-command output channel there.

### Excluded

- Anthropic and GitHub Copilot account management.
- OpenRouter usage.
- Generic extensions unrelated to the requested bundle, such as personality switching, title generation, shell wrapping, notifications, subagents, or tool display.
- Automatic account rotation to evade quotas.
- Reading or modifying Codex CLI auth files.
- Bundling `@narumitw/pi-accounts` or `@narumitw/pi-usage` as nested Pi extensions. Relevant Codex code will be adapted into one factory and one package boundary.

## Architecture

```text
pi-codex-compat/
├── index.ts                         # stable Pi entrypoint; forwards default factory
├── src/
│   ├── pi-codex-compat.ts           # registration and lifecycle ownership
│   ├── commands/                    # /codex manager and compatibility commands
│   ├── fast-mode/                   # priority-tier state and payload transform
│   ├── compaction/                  # native compact client, replay, serializer, details
│   ├── accounts/                    # Codex-only OAuth store and runtime overlay
│   ├── quota/                       # Codex quota query, cache, format, status
│   ├── usage-history/               # historical report prompt
│   ├── tps/                         # streamed-token rate tracking
│   └── settings/                    # validation, precedence, atomic persistence, migration
├── test/                            # deterministic unit and lifecycle tests
├── docs/                            # behavior and release documentation only where useful
├── .github/workflows/               # CI and OIDC npm publishing
├── NOTICES.md                       # upstream attribution and adapted-source notices
├── LICENSE
├── README.md
├── package.json
└── tsconfig.json
```

One factory owns all registrations. Fast mode and compaction share one deterministic `before_provider_request` pipeline: native replay first, then priority-tier injection. This avoids extension load-order coupling while preserving unrelated payload fields.

Long-lived timers start during `session_start` and are cleared during `session_shutdown`. Status keys are stable and every key is cleared by its owner.

## Settings and state

Canonical user settings:

```text
~/.pi/agent/pi-codex-compat.json
```

Trusted project overrides, for non-secret settings only:

```text
<workspace>/.pi/pi-codex-compat.json
```

Codex account credentials use a separate private state file with a storage-specific name:

```text
~/.pi/agent/pi-codex-compat-accounts.json
```

Rules:

- Resolve settings as defaults → user settings → trusted project overrides.
- Use `getAgentDir()` and `CONFIG_DIR_NAME` rather than hard-coded config roots.
- Require JSON objects and validate recognized values at runtime.
- Warn and retain invalid files; never silently overwrite them.
- Preserve unknown fields.
- Write atomically and serialize writes.
- Store credential files with private directory permissions and mode `0600` on POSIX.
- Never emit credentials in UI, logs, errors, or test snapshots.

Compatibility reads/migrations when canonical values are absent:

- `~/.pi/agent/settings.json` → `extensionSettings.openaiCodexFastMode`.
- The known old local path `~/.pi/agent/extensions/openai-compaction/settings.json`, if present.
- `~/.pi/agent/settings.json` and trusted project `.pi/settings.json` → `openaiNativeCompaction`.
- Existing `PI_OPENAI_NATIVE_COMPACTION_*` environment variables.
- `pi-accounts.json` → only the `openai-codex` provider section.
- `pi-codex-accounts.json` and older `codex-accounts.json` → Codex account data.

Native-compaction resolution is explicit: code defaults → old package-local settings, if present → legacy global settings → canonical user settings → legacy trusted-project settings → canonical trusted-project settings → existing environment overrides. Canonical values win over legacy values at the same scope; environment overrides win over all files. Migration copies effective recognized values into canonical config without deleting legacy sources.

Migrations copy only missing, validated fields from the same scope into canonical files; environment and project values never leak into user settings, and user values never leak into project settings. Source files remain for rollback. The package will document that it must not be loaded with `pi-accounts`, `pi-codex-accounts`, `pi-usage`, or `pi-codex-usage`, because duplicate extensions can refresh the same rotating credential or register conflicting commands.

## Security and failure behavior

- Account activation failures fail closed for `openai-codex`; they do not silently fall back to another credential.
- Compaction failures fail open to Pi's normal compaction because compaction is an optimization, not an auth boundary.
- Quota requests send credentials only to the expected official ChatGPT origin and use bounded response reads.
- Debug artifacts redact authorization headers, OpenAI keys, JWT-like values, account IDs where sensitive, and exact credential strings.
- Extension code runs with full user permissions; README will state Pi's unsandboxed extension trust model.

## Packaging and publishing

- Package name: `@bumpyclock/pi-codex-compat`.
- GitHub identity: `BumpyClock/pi-codex-compat`.
- Package ships TypeScript source; Pi loads it through jiti. No runtime build step.
- `package.json` includes `keywords: ["pi-package", ...]`, a narrow `files` allowlist, `pi.extensions: ["./index.ts"]`, MIT license, full repository metadata, Node engine requirement, and public publish configuration.
- Pi core packages imported at runtime are peer dependencies and are not bundled. `proper-lockfile` is a runtime dependency for rotating credential safety.
- `NOTICES.md` and license text retain MIT attribution for Jordy Van Domselaar and narumiruna where substantial code is adapted.
- CI runs formatting/lint, typecheck, tests, package dry-run, and a local Pi entrypoint smoke.
- npm release uses GitHub-hosted Actions with OIDC trusted publishing and provenance, not a long-lived automation token. Initial npm bootstrap and GitHub repository creation occur only after all local gates pass and authenticated account/package-name checks succeed.

## Testing and acceptance

### Deterministic tests

- Fast-mode settings, command behavior, model/API gating, and payload composition.
- Native compaction URL/header/auth resolution, serialization parity, opaque-window persistence, branch/reload behavior, aborts, and fail-open paths.
- A serialized pre-upgrade compaction fixture pins `strategy: "openai-native-compact-v1"`, shim summary `"[OpenAI native compaction checkpoint]"`, provider/API/model/base-URL identity matching, and opaque `compactedWindow` replay so existing sessions continue using native replay after upgrade.
- Legacy compaction package-local/global/project/environment precedence and canonical migration behavior.
- Account-name validation, private/atomic storage, migrations, lock behavior, OAuth refresh, runtime overlay restore, fail-closed behavior, and secret redaction.
- Codex quota normalization, official-origin checks, bounded response handling, account-isolated caching, refresh, status formatting, timeout, and cancellation.
- `/usage` live-quota route and `/usage-history` historical-report route.
- TPS reset, streamed estimate, official-token replacement, multi-message aggregation, disabled state, and shutdown cleanup.
- Every documented `/codex`, `/accounts`, `/usage`, `/fast`, and `/usage-history` route across TUI, RPC, JSON, and print modes, including observable rejection and unknown-route behavior.
- Combined `before_provider_request` pipeline proves compaction replay and `service_tier: "priority"` survive together.

### Final gates

1. Format/lint clean.
2. Typecheck clean under strict TypeScript.
3. Full tests pass.
4. `npm pack --dry-run --json` contains only intended runtime/docs files.
5. Pi loads the packaged entrypoint without registration errors.
6. Independent review reports no blocking correctness, security, licensing, or packaging findings.
7. GitHub/npm publication follows only after local evidence is clean and account/name checks pass.

## Risks and decisions

- This is a large consolidation. Keeping feature modules separate reduces cross-feature regression risk while still exposing one extension factory.
- Accounts and quota code depend on current Pi auth APIs; README will state the minimum tested Pi release, while package peers follow Pi package guidance.
- `/usage` changes meaning from historical cost analysis to live subscription quota. `/usage-history` preserves old behavior by explicit user choice.
- TPS is provider-generic but included by explicit user choice.
- Existing local extension files remain unchanged during this project. Installing the package alongside them would duplicate hooks and commands, so migration docs will require disabling/removing the local copies before use.
