# Opt-in pre-push validation

Prepare Node 24 and run `npm ci`. Enable the tracked hook explicitly with
`bash scripts/install-git-hooks.sh`. Nothing installs itself. The installer is
idempotent and refuses to hide unrelated active hooks or replace another
`core.hooksPath`. It sets repository-local `.githooks`, relative to each checkout,
including linked worktrees. This Git setting is shared by the repository's
worktrees. Review that scope before opting in.

The hook requires a clean checkout at the pushed commit. It never stashes or
rewrites source. Pushing another commit fails with instructions to use its clean
checkout. Multiple refs must all resolve to HEAD. Deletion-only pushes need no
source validation. Missing history, new branches, source renames/deletions,
config/lock changes and empty input run the full existing nonmutating Biome
check and both production/test TypeScript projects. Full scope deliberately
avoids an incomplete affected-file graph.

Missing prepared tools fail with setup instructions. Hooks do not run `npx`,
install dependencies, publish, request credentials or perform live account
operations. Package smoke, audit and the full test suite remain CI checks.

`python3 scripts/test-git-hooks.py` executes the real hook and installer in
throwaway Git fixtures with stubbed tools. It never performs an outbound push.
These fixtures prove ref handling and exit propagation, not project correctness.
Real project checks must still pass under `npm run check`.

Compatible Linux CI/release jobs now select Boat. Tokenless npm publishing stays
on `ubuntu-latest` because npm trusted publishers require GitHub-hosted runners.
OIDC permissions and provenance are preserved. No long-lived token is added.
Existing job names, triggers,
permissions, dependency graph, environment/OIDC and publishing guards remain
unchanged. Owner-only public execution policy is configured separately; this
source change does not dispatch CI or repair provider billing.
