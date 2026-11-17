# pipelines

Shared CI/CD workflows and composite actions for Polygon repositories.
The contents fall into two families:

- **Apps Team reusable workflows + composite actions** — prefixed
  `apps-*.yml` in `.github/workflows/` and living under `.github/actions/`.
  Migrated here from `0xPolygon/apps-team-workflows` so that
  public-visibility consuming repos can call them directly (GitHub
  forbids private → public workflow calls).
- **Shared org infrastructure workflows** — image release, versioning,
  security scanning, and legacy AWS/ECS deploys used by services across
  the orgs.

All workflows here are `on: workflow_call`. Consumers supply the event
trigger via a thin trigger file in their own repo.

---

## Apps Team shared workflows

### Reusable workflows

Called via
`uses: 0xPolygon/pipelines/.github/workflows/<name>.yml@main` (or via a
local copy for public repos that prefer vendored workflows). Each runs
in its own separate GitHub Actions job with its own runner.

| Workflow | Purpose | Required secrets |
|----------|---------|-----------------|
| `apps-ci.yml` | Lint, typecheck, and test on PRs | _(none)_ |
| `apps-changeset-check.yml` | PR gate: requires a changeset (posts/deletes instructions comment) and that intra-workspace dependencies use `workspace:` | _(none)_ |
| `apps-codegen-drift-check.yml` | PR gate: runs `pnpm -r --include-workspace-root run --if-present codegen-drift-check` (no-op when no package defines the script) | _(none)_ |
| `apps-npm-release.yml` | Changesets release pipeline in jobs `version` (release PR), `build` (pack tarballs), `publish` (approval-gated npm publish via the `npm-publish` environment), `collect-tags` (3.x only: create the local tags with no write token), `finalize` (git tags and GitHub Releases), plus on-demand snapshot publish via the `snapshot_tag` input and an opt-in `version_script` input. See [npm release](#npm-release-what-a-consuming-repository-must-configure) | `CHANGESET_RELEASE_BOT_APP_ID`, `CHANGESET_RELEASE_BOT_APP_PRIVATE_KEY` |
| `apps-release-conformance.yml` | PR and merge-queue gate: checks that a repository's npm release workflows follow the shared release standard. Also callable with `workflow_call`. See [Release workflow conformance](#release-workflow-conformance) | _(none)_ |
| `apps-docker-release.yml` | GCP image push on version tag (delegates to `gcp_pipeline_release_image.yaml`) | `build_params_gh_secret_keys` |
| `apps-pr-labeler.yml` | Labels `.github/`-only PRs as `do-not-notify`; removes label when non-`.github/` changes are added | _(none)_ |
| `apps-slack-merge-notify.yml` | Posts a Slack Block Kit message when a PR is merged | `SLACK_WEBHOOK_URL` |
| `apps-claude-code-review.yml` | Automated Claude Code PR review | `CLAUDE_API_KEY` |
| `apps-claude.yml` | Interactive Claude Code agent (triggered by @claude mentions) | `CLAUDE_API_KEY` |

Trigger file examples for each of the above live alongside them as
`apps-*-trigger.yml` and also serve as canonical templates for consuming
repos.

### Composite actions

Called via `uses: 0xPolygon/pipelines/.github/actions/<name>@main` as a
**step** inside a job. Composite actions run in the calling job's
environment — they inherit the job's `env:` block, runners, and file
system state automatically.

| Action | Purpose | Has compiled dist? |
|--------|---------|-------------------|
| `actions/ci` | Checkout, install, lint, typecheck, test | No — pure shell |
| `actions/check-dockerfile` | Pre-flight gate: resolve a changeset tag and report whether the package ships a Dockerfile | No — pure shell |
| `actions/check-workspace-protocol` | Fail when a workspace package depends on a sibling through a plain version range instead of `workspace:` | No — dependency-free Node script |
| `actions/docker-test` | Resolve service from tag, build image, start container, run tests, stop | No — pure shell |
| `actions/npm-pack` | Pack every public workspace package whose version is not on npm into tarballs and write `manifest.json`; holds no publish credential | No — dependency-free Node script |
| `actions/npm-publish-tarballs` | Publish the tarballs listed in `manifest.json` after checking each file's SHA-256 and the npm client version, then verify every publish by reading all versions back from the registry (staged publishing is not supported yet), so tags and GitHub Releases are created only after the version is readable from the registry; needs no checkout or install | No — dependency-free Node script |
| `actions/check-changesets-cli` | Fail unless the repository's resolved `@changesets/cli` is 2.x or 3.x, report which, and on 3.x require an explicit `privatePackages` setting (`true`, `false` or an object with boolean `version` and `tag`) when private packages exist | No — dependency-free Node script |
| `actions/workspace-patterns` | Shared module (not a step): evaluates `pnpm-workspace.yaml` as data (settings-only file or no file = root only; block or one-line list; `!` exclusions; `dir/*`, `dir/**`, literal paths) and throws on any other pattern shape; used by `check-changesets-cli` (version job, before a release PR), and by `validate-tags` and `check-release-tags` (finalize, which runs no package manager) | No — dependency-free Node script |
| `actions/tag-and-release` | `@changesets/cli` 3.x: run `changeset git-tag` with no token in the `collect-tags` job, validate the resulting tags file with plain Node, then push the tags and create a GitHub Release for each in `finalize`; holds no publish credential | No — dependency-free Node script |
| `actions/check-version-script` | When the version hook is enabled, fail unless the root `package.json` defines `ci:version` | No — dependency-free Node script |
| `actions/release-guard` | Fail unless the run is a push to the repository's default branch | No — dependency-free Node script |
| `actions/check-release-tags` | Confirm the end state of a release run, read through the GitHub REST API: every package in `manifest.json` and every created tag has its git tag and, where a changelog applies, a GitHub Release; on `@changesets/cli` 3.x also every expected tag, and a package published in the run must be tagged at the run's commit | No — dependency-free Node script |
| `actions/check-cli-major` | Fail unless the detected `@changesets/cli` major is exactly 2 or 3, so an empty or unexpected detector output cannot select no arm | No — dependency-free Node script |
| `actions/release-conformance` | Check a repository's npm release workflow files against the shared release standard; reads files only | Yes — ncc bundle |
| `actions/slack-notify` | Post Slack Block Kit message from `pr.json` | Yes — ncc bundle |
| `actions/upsert-changeset-comment` | Post or remove changeset nag comment on a PR | Yes — ncc bundle |

### `actions/ci`

Runs `pnpm run lint`, `pnpm run --if-present typecheck`, and `pnpm run --if-present test`
in the calling job. Because it runs as a step (not a separate runner), any env vars
composed from secrets in the trigger's `job.env:` block are automatically available
to `pnpm test` — no secret-passing mechanism needed:

```yaml
jobs:
  ci:
    name: CI - lint / typecheck / test
    runs-on: ubuntu-latest
    env:
      MY_RPC: https://rpc.example.com?token=${{ secrets.MY_TOKEN }}
    steps:
      - uses: 0xPolygon/pipelines/.github/actions/ci@main
```

Repositories with no test env var requirements omit the `env:` block entirely.

### `apps-codegen-drift-check.yml`

A discrete PR gate for "edited the schema but forgot to regenerate" bugs.
Runs `pnpm -r --include-workspace-root run --if-present codegen-drift-check`
across the workspace in topological order. Two patterns both work:

- **Root-only** — a repo with no workspace children (e.g. `apps-team-ops`,
  where `pnpm-workspace.yaml` has no `packages:` field) defines the script
  at the root. `--include-workspace-root` is required so plain `pnpm -r`
  doesn't skip it.
- **Per-package** — a monorepo where each package owns its own check
  (e.g. an orval client that regenerates from a schemas package's
  `openapi.json`). Topological order means schemas regenerate before
  downstream clients — drift produced by one step is visible to the next.

The `codegen-drift-check` convention: regenerate the artifacts in place
and exit non-zero when `git diff` reports any change.

A separate workflow rather than another step in `actions/ci`, so the
failure surfaces under its own PR check name — easy to make a required
status on `main` and trivial to triage at a glance. The `--if-present`
keeps it a fast green no-op for repos that ship no codegen, so the
canonical CI trigger can carry the job even before every consumer has
something to check.

The canonical `apps-ci-trigger.yml` already wires this in as a second
job alongside `lint-typecheck-test` — adopting team-wide is a single
trigger file in each consumer repo, not two.

### `actions/check-dockerfile`

Resolves a changeset tag to a workspace package directory and reports whether
that package contains a `Dockerfile`. Triggers that pay for expensive setup
(Firestore emulator, OIDC auth, fixture seeding) before invoking `docker-test`
use this as a pre-flight to short-circuit library-only release tags
(`spol-contracts-sdk@…`, `spol-db@…`) — the trigger gates every
Dockerfile-dependent step on `steps.gate.outputs.has_dockerfile == 'true'`.

`docker-test` already returns `should_build=false` for the same library case,
but it does so after `actions/checkout`, `pnpm install`, and the buildx setup
have run. For triggers with no expensive pre-test steps (e.g. the
`example-rest-api` template) this action is unnecessary; reach for it only
when the trigger has setup that's wasted on a library tag.

Self-contained — does its own `actions/checkout` and `pnpm/action-setup`,
matching the `docker-test` convention. Discovers the package directory via
`pnpm --filter ls --json`, so it works regardless of workspace layout
(`packages/*`, `apps/*`, nested, root-level — anything `pnpm-workspace.yaml`
declares). Outputs `has_dockerfile`, `service`, and `package_dir`.

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    env:
      FIRESTORE_EMULATOR_HOST: 172.17.0.1:8080
      # ... other env vars
    steps:
      - id: gate
        uses: 0xPolygon/pipelines/.github/actions/check-dockerfile@main
        with:
          tag: ${{ inputs.tag || '' }}

      - if: steps.gate.outputs.has_dockerfile == 'true'
        run: docker compose -f ./docker-compose.test.yml up -d --wait

      - id: docker-test
        if: steps.gate.outputs.has_dockerfile == 'true'
        uses: 0xPolygon/pipelines/.github/actions/docker-test@main
        with:
          tag: ${{ inputs.tag || '' }}
          test_vars: FIRESTORE_EMULATOR_HOST # ...
```

### `actions/check-workspace-protocol`

Fails when any workspace package declares a sibling workspace package in
`dependencies`, `devDependencies` or `optionalDependencies` with a range that
does not start with `workspace:`. `changeset version` leaves `workspace:`
ranges alone and pnpm replaces them with real versions at publish, so the
lockfile committed with a release PR stays current and the release job can
install it frozen. A plain range on a sibling breaks that: pnpm resolves it
from the registry instead of the repo, and the frozen install fails once the
range is bumped. `peerDependencies` are exempt, since a semver peer range is
how a published library states which sibling versions it supports.

Runs in both `apps-changeset-check.yml` (so the PR fails first) and the
`apps-npm-release.yml` `version` job (before its frozen install). It expects a
checked-out repo with pnpm and Node set up, and needs no `pnpm install`. The
script has no dependencies, so it ships as plain source in the action
directory rather than as a compiled bundle.

### npm release: what a consuming repository must configure

`apps-npm-release.yml` runs from a push to the default branch only; any other
event with an empty `snapshot_tag` fails. Its jobs are `version`, `build`,
`collect-tags` (3.x only), `publish` and `finalize` (formerly a single `release` job, so anything keyed
on the old job name needs updating). A repository with only private packages
skips `publish` and is tagged by `finalize` without any approval.

- **`@changesets/cli` 2.x or 3.x.** The workflow reads the resolved
  `@changesets/cli` major from the installed repository and runs the matching
  arm; any other major fails the `version` and `finalize` jobs, including
  runs that publish nothing. See "Moving to `@changesets/cli` 3.x" below.
  After a run that had something to tag, `finalize` checks that each package
  published or tagged in the run has a git tag, and a GitHub Release when
  changelogs are enabled (`.changeset/config.json` `changelog` is not `false`)
  and the package has a `CHANGELOG.md`, because changesets creates a Release
  from the changelog and none without it. The release fails when it had
  something to tag and a tag or Release is missing, also when nothing was
  published. Re-running the `finalize` job is safe: it passes once the tags
  and Releases exist. Re-running the failed job is the safe recovery: on 3.x a
  re-run also creates a Release that is missing for a tag already at the run's
  commit, and the end-state check fails while one is still missing.
- **`publishConfig.access`.** Set it to `public` on every public package. A
  public package that resolves to restricted access fails the pack step.
- **Public npm registry only.** Every registry lookup and publish names
  `https://registry.npmjs.org/` explicitly. A selected package that sets
  `publishConfig.registry`, or a scoped `publishConfig."<scope>:registry"`, to
  any other registry fails the pack step and, checked again on the tarball's
  own `package.json`, the publish job before anything is published.
- **Root as a workspace member.** As in changesets, the root package is
  published only when the repository is a single package, or when
  `pnpm-workspace.yaml` (or `workspaces`) lists the root itself (`.`).
- **Node.** The `publish` job uses an exact Node version pinned by the
  workflow, not the repository's `.nvmrc`, and its bundled npm must meet the
  trusted-publishing minimum.
- **Lifecycle scripts.** `build` runs `prepublishOnly` (if present) and
  `pnpm pack`, which runs `prepack` and `prepare`. A package's `publish` and
  `postpublish` scripts do not run. The publish step runs with
  `--ignore-scripts`. Packing happens with nothing in the workspace but the
  repository: the workflow's own checkout is removed first, and the pack step
  fails if a tarball contains a `.pipelines/` path.
- **`ignore` (3.x).** On `@changesets/cli` 3.x, packages listed under `ignore` in
  `.changeset/config.json` are neither packed nor tagged; on 2.x `ignore` does not change the pack.
- **`npm-publish` environment.** Create it in the repository with required
  reviewers, "prevent self-review" on, administrator bypass off, and
  deployment branches limited to the default branch. The workflow does not
  create or configure the environment; verify it with
  `scripts/check-publish-environment.sh <owner>/<repo>`. The script cannot
  check two conditions, which need a human: that the required reviewers hold
  no npm publish rights, and that only organisation admins can edit the
  environment's protection rules.
- **Trust config.** Each package's npm trusted-publisher configuration names
  the repository's release trigger workflow file and the environment
  `npm-publish`. Verify the environment with the script **before** recreating
  a package's trust config with the environment pin. Once a package's trust
  config names the environment, the snapshot path (which runs without an
  environment) fails for that package until the snapshot path changes.
- **Two people per release.** With self-review prevented, the person whose
  merge started the run cannot approve the publish. If another push lands
  while a release waits for approval, a second approval request can appear
  for the same versions; the second run finds them already published and
  skips them.
- **Publishes run one at a time, normally in arrival order.** The `publish`
  job (only that job) shares one concurrency group per repository and ref with
  `queue: max` and `cancel-in-progress: false`; GitHub keeps up to 100 pending
  publishes. GitHub says queue ordering "is not guaranteed", so the dist-tag
  choice below, not the order, is what protects `latest`. A run waiting for
  approval is expected to keep its place in the group, but GitHub does not
  document this; it will be confirmed on a real run. If it holds, a publish
  left awaiting approval holds the repository's publish queue: approve or
  reject the oldest pending one first, or later publishes wait behind it. The
  `version` job and
  releases with nothing public to publish never wait on it. Runs on different
  refs are not serialized, and the registry's package document can lag a
  fresh publish, so a publish that starts immediately after another may still
  read a stale `latest`.
- **Dist-tags are chosen at publish time.** Just before each `npm publish`
  the registry's current `latest` is read (unauthenticated), and the tag is
  passed with `--tag`; no dist-tag is changed afterwards. Releases approved
  out of order do not move `latest` backwards, except in one narrow case: the
  registry's package document can lag a fresh publish, so a publish straight
  after another may read a stale `latest`. A failed read is tried three times
  (with a short wait) before that package fails closed; only a network error,
  a timeout or a 5xx is retried, so a 403 or 429 fails at once. When the
  registry hangs, each attempt can run to its 30 s timeout, so a package can
  wait about 96 s (3 × 30 s plus the 2 s and 4 s waits) before its publish,
  and a release of a dozen or more packages could reach the publish job's
  20-minute limit; that fails closed, and a re-run skips what was published.
  A stable version above `latest` (or any stable version while `latest` is a prerelease), or a
  package's first publish, gets `latest`. An older (or
  equal) stable version gets `previous`; `previous` always names the most recently
  published older stable version. A prerelease never gets `latest`: it keeps the tag recorded at pack time (changesets' pre tag; when only
  prereleases have been published so far, the manifest's `preTag` from
  `.changeset/pre.json` is used instead), and fails if neither is available. A recorded tag other than `latest` is kept; an
  explicit `latest` cannot be told from the default, so an older stable version
  still gets `previous`, and a prerelease fails. If
  the registry cannot be read, nothing is published for that package. The
  read-back checks the version document and its integrity, so a version
  published under `previous` passes it like any other.
- **A non-highest Release is not left as Latest.** After a run creates
  at least one Release, on either `@changesets/cli` major (a push with
  nothing to release never touches Latest),
  `finalize` checks the release tags and then judges the current Latest Release from current state:
  if it is its package's highest stable version (from the package's tags;
  per package, so multi-package repositories need no primary package) it
  stays. Otherwise Latest goes to the Release recorded before the run if that
  is still its package's highest stable version, else to that package's
  highest stable tag that has a Release (falling down the tags past any
  without one), else it is left unset. A Latest whose tag is not a version tag
  is left alone. A re-run of a `finalize` whose correction failed creates no
  new Release, so it does not run the correction again and goes green with
  Latest still wrong; a wrong Latest can be set by hand, or waits for the next
  release. The decision uses current state, so the next release's `finalize`
  repairs a wrong Latest,
  including the rare case where two `finalize` runs overlap tightly and leave
  an older Release as Latest. Git tags are not changed.
- **Artifact retention.** The tarballs are kept for 7 days. If approval or a
  re-run of `finalize` comes later, re-run all jobs to pack them again.
- **Version hook (`version_script`, default `false`).** Set the input to
  `true` to have the `version` job run `pnpm run ci:version` from the root
  `package.json` in place of the default `changeset version`. It is never
  detected automatically. The job fails, before the release token is minted,
  if the script is missing, and the script must itself run `changeset
  version`. `ci:version` is release-path code that runs with the release app
  token, like changesets' configured plugins, and is reviewed like the
  workflow. Only the `version` job runs it; that job has no `id-token`
  permission. The `snapshot` job does not run the hook; it uses plain
  `changeset version --snapshot`. Pass a YAML boolean `true`, not a string; a
  string expression is not supported.
- **Trigger permissions.** Copy `apps-npm-release-trigger.yml`; its top-level
  `permissions` must cover every scope the called jobs request.

### Moving to `@changesets/cli` 3.x

No trigger change is needed: the workflow picks its arm from the installed
CLI, so a repository moves by changing its own dependencies and config.

- Set `privatePackages` explicitly in `.changeset/config.json`: `true`,
  `false`, or an object with boolean `version` and `tag`, for example
  `"privatePackages": { "version": true, "tag": true }`. 3.x neither versions
  nor tags private packages by default, so services would never be tagged. A
  repository with private packages and no explicit setting fails early.
- Use `@changesets/changelog-github` 1.x with the 3.x CLI.
- The 3.x CLI needs Node `^22.11 || ^24 || >=26` and pnpm `>=10.0.0`.
- A push whose pending changesets are all empty opens no release PR on 3.x.
  The empty changesets are consumed with the next real one.
- A peer-dependency bump is a patch bump for the dependents.
- The tag command is `changeset git-tag`; the `collect-tags` job runs it with
  a read-only token and uploads the tags it created. The `finalize` job
  validates that file against the checkout with plain Node, then
  `actions/tag-and-release` pushes the tags and creates the GitHub Releases.
  The collect step fetches existing tags into its clone, so a package an
  earlier release already tagged is not tagged again on a private repository.
  The validation also holds the file to the repository's configuration, read as
  data: every created tag is also an expected tag, every entry is a workspace
  package, and a package named literally under `ignore`, or a private package
  when `privatePackages` does not turn tagging on, is refused.
- **Repository code while the release token exists.** The `version` job runs
  the repository's release tooling (the changesets CLI and its changelog
  plugin) with the release token available, as it does today, on either CLI
  major. The tag list is produced by a job that runs the repository's
  dependencies; `finalize` validates every entry against the repository before
  creating tags.

### Release workflow conformance

`apps-release-conformance.yml` reads every workflow file under
`.github/workflows` and checks the ones that release to npm. It needs
`contents: read` only and runs no code from the repository it reads. The
logic lives in `packages/release-conformance` and is bundled into
`.github/actions/release-conformance/dist/`.

The file declares `pull_request` and `merge_group` as well as
`workflow_call`, unlike the other reusable workflows here: a repository
ruleset can only require a workflow whose own file declares a pull request
or merge group trigger. It has no path filters, so its status is always
reported.

#### What this check is for

It enforces the shared release shape and catches drift and honest mistakes
in release workflows. It is not a defence against a determined author with
write access to the repository: human review of workflow changes, the rules
that cannot be waived, and the npm trusted-publisher binding are the
controls for that. Indirection the check cannot read, such as script files
and third-party release tools, is not analysed: in a job that holds an OIDC
token or an npm token it is reported as a notice, and a local action the
check cannot read in such a job is an error.

A workflow file is classified first:

- **Shared caller**: a job that calls the shared npm release workflow.
- **Bespoke publisher**: any other workflow with a job that both holds an
  npm publishing credential (`id-token: write`, or an npm token secret) and
  runs an explicit publish command (`npm`, `pnpm`, `yarn`, `lerna` or `bun`
  `publish`, `changeset publish`, or a `changesets/action` `publish` input).
  A `<manager> run <script>` counts only when that script's body, read from
  the repository's `package.json` files, holds an explicit publish command;
  a script's name alone never does, and only one level of script is read.
- Everything else is not in scope and is listed in the job summary.

Rules for shared callers:

| Rule | Requirement |
|------|-------------|
| `caller/callee` | Calls the shared release workflow at an allowed ref (`main`); a commit SHA is rejected |
| `caller/events` | Only events the canonical trigger has; `push` only on the default branch with no tags; `workflow_dispatch` inputs are a subset of the canonical's |
| `caller/pull-request-target` | No `pull_request_target` trigger |
| `caller/permissions-ceiling` | A top-level `permissions` block exists and no scope, at top level or on the calling job, exceeds the canonical's |
| `caller/permissions-floor` | The calling job grants every scope the release workflow's jobs declare |
| `caller/publish-permission-scope` | `id-token: write` is held only by the job that calls the release workflow |
| `caller/secrets-inherit` | No `secrets: inherit` |
| `caller/secrets` | Secret names are a subset of the canonical's |
| `caller/inputs` | `with:` keys are a subset of the canonical's |

Rules for bespoke publishers:

| Rule | Requirement |
|------|-------------|
| `publisher/split` | The publishing credential is granted at job level, only to jobs that install dependencies, build, test or lint nothing and hold no other write scope |
| `publisher/no-cache` | No job sets a `cache:` input on a setup action or uses `actions/cache`; `actions/setup-node` from v5 (or a ref whose version cannot be told; a commit SHA takes its version from the trailing `# vX.Y.Z` comment) caches dependencies on its own, so it needs `package-manager-cache: false` |
| `publisher/environment` | Every publishing job declares a literal `environment:` name |
| `publisher/events` | Starts only on `push` to the default branch without `tags` or `tags-ignore`, or `release` of type `published`; a reusable publisher with no caller in the repository fails because the events that start it cannot be checked |
| `publisher/publishing-dispatch` | No `workflow_dispatch` start for a publishing workflow |
| `publisher/pull-request-target` | No `pull_request_target` trigger |
| `publisher/id-token-with-code` | `id-token: write` is not held by a job that runs repository or dependency code |
| `publisher/token-with-code` | An npm token is not held by a job that runs repository or dependency code |
| `publisher/unreadable-local-action` | A job that holds a publishing credential does not use a local action the check cannot read: one outside `.github/actions/`, missing, not a composite action, or using a further local action |
| `publisher/possible-publish` | A job that holds `id-token: write` names a package publish only in text that may not run one: an `echo` or `printf` argument that is not piped or substituted, or a word between `pnpm`, `yarn` or `bun` and `publish` that no `package.json` script explains (`pnpm wrangler publish`). Any other `<tool> [flags] publish` (`npm`, `pnpm`, `yarn`, `lerna`, `bun`, `changeset`), in a command, a quoted string or an action input, is a publish, not this finding. A code-owner-reviewed marker may waive this one |

Three further results are informational: `publisher/unclassified-id-token`
and `publisher/unclassified-npm-token` (notices for a job that holds
`id-token: write` or an npm token but is not recognised as a release job;
the notice names any script it runs that no `package.json` defines) and
`workflow/unparseable` (an error when the file mentions the release
workflow or a publish command, or when it was not read at all: over the size
limit, or not a regular file).

The shared release workflow is the reference the profile is derived from.
When this repository checks itself, only `publisher/publishing-dispatch`,
`publisher/id-token-with-code` and `publisher/environment` on that one file
are reported as notices; every other rule and file, and any other publisher
finding on that file, is checked normally.

#### Exceptions

A finding can be suppressed for a limited time with a comment in the
workflow file it applies to:

```yaml
# release-conformance-exception: publisher/no-cache until 2027-01-31 Cache is needed until the build is split
```

The rule id must exist, the date must not be in the past (UTC) and must be
at most 366 days ahead, and the reason must not be empty. An invalid or
expired marker is itself an error (`exception/invalid`). Active exceptions
and their end dates are listed in the job summary. The rules behind
`caller/secrets-inherit`, `caller/pull-request-target`,
`caller/publish-permission-scope`, `publisher/pull-request-target`,
`publisher/id-token-with-code` and `publisher/token-with-code` cannot be
waived.

#### Calling the check from a repository

A repository that cannot be reached by an organization ruleset calls the
workflow from its own trigger file:

```yaml
name: Release workflow conformance

on:
  pull_request:
  merge_group:

permissions:
  contents: read

jobs:
  conformance:
    uses: 0xPolygon/pipelines/.github/workflows/apps-release-conformance.yml@main
```

The check reads workflow files only. Whether the `npm-publish` environment
is protected is repository configuration, which the check does not read.

### `actions/docker-test`

Resolves a deployable service from a changeset git tag, builds its Docker image,
starts the container, waits for `health_path` (default `/health-check`) to answer 2xx (redirects count as not ready), runs the
test suite via `TEST_BASE_URL`, then stops the container. Outputs the resolved `image_name`,
`image_tag`, `dockerfile_path`, `checkout_ref`, and `should_build` for use by the
subsequent `release` job. Packages without a `Dockerfile` in their package directory
exit cleanly with `should_build=false`.

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    outputs:
      image_name: ${{ steps.docker-test.outputs.image_name }}
      # ... other outputs
    steps:
      - id: docker-test
        uses: 0xPolygon/pipelines/.github/actions/docker-test@main
        with:
          tag: ${{ inputs.tag || '' }}
          # test_vars: MY_RPC   # space-separated env var names to forward to container
          # health_path: /api/health   # readiness path; defaults to /health-check
```

### `actions/slack-notify` and `actions/upsert-changeset-comment`

Used internally by `apps-slack-merge-notify.yml` and `apps-changeset-check.yml`
respectively. Both contain logic that runs across repository boundaries inside a
reusable workflow context, so they must be compiled ncc bundles (raw
`.github/scripts/` files are not accessible in the calling repo's workspace).
See [Adding a new composite action with compiled dist](#adding-a-new-composite-action-with-compiled-dist).

---

## Pinning callers

The examples above use `@main` for brevity. `@main` is a moving target: every
merge here is picked up by every caller on its next run, including workflows
that receive secrets and run with `id-token`/`contents: write`. Callers should
pin to an immutable ref instead, for both reusable workflows and composite
actions:

```yaml
jobs:
  check:
    # Prefer a full commit SHA; keep a human-readable comment with the version
    uses: 0xPolygon/pipelines/.github/workflows/apps-ci.yml@<full-40-char-sha> # <tag or date>
```

- **Full commit SHA** is the only ref that cannot be moved. Prefer it.
- **A release tag** (`@vX.Y.Z`) is acceptable when it is protected against
  re-pointing. Tags are only as immutable as the repo's tag protection.
- Bump the pin deliberately (Dependabot's `github-actions` ecosystem or
  Renovate can open the PRs) rather than tracking `@main`.
- Pin the `uses:` of every job and step in the trigger file. A pinned
  reusable workflow runs this repo's composite actions from the same commit:
  each reusable workflow checks out `${{ job.workflow_repository }}` at
  `${{ job.workflow_sha }}` into `.pipelines/` and calls
  `./.pipelines/.github/actions/<name>`, never `@main`. Composite actions
  you call directly from a trigger file are pinned by your own `uses:` ref.
  (`job.workflow_*` is not available on GitHub Enterprise Server.)

> **Status:** this repo does not yet publish release tags that contain the
> current `apps-*` workflows (the existing `v1`–`v3` tags predate them), so the
> trigger templates in this repo still show `@main`. Until a tag is cut,
> callers should pin to a commit SHA of this repo.

---

## Security gates

Reusable workflows for the CI security standard for GitHub Actions (npm and Go). They hold
the audited action pins, tool versions and licence allowlist in one place, so a consuming repo
carries a short trigger pinned to a commit of this repo instead of its own copy. `pipelines` is
public, so repos in any org can call them; an org that restricts allowed actions has to allow
`0xPolygon/pipelines/*`.

| Workflow | When the caller runs it | Purpose |
|----------|-------------------------|---------|
| `security-dependency-review.yml` | `pull_request` | Fails on a new dependency with a high-severity advisory (runtime, development or unknown scope) or a licence outside the shared allowlist |
| `security-zizmor.yml` | `pull_request` (no path filter) + weekly `schedule` | Lints workflows, composite actions and Dependabot config with zizmor; reports to code scanning |
| `security-go-mod-check.yml` | `pull_request` (no path filter) | `go mod verify` and `go mod tidy -diff` with `GOFLAGS=-mod=readonly` |
| `security-govulncheck.yml` | weekly `schedule` + `pull_request` on `go.mod`/`go.sum` | govulncheck on the caller's module |

`security-dependency-review-trigger.yml` and `security-zizmor-trigger.yml` are the canonical
triggers and run on this repo too. A Go repo adds:

```yaml
name: Go security

on:
  pull_request:
  schedule:
    - cron: '23 6 * * 1'

permissions: {}

jobs:
  go-mod:
    if: github.event_name == 'pull_request'
    permissions:
      contents: read
    uses: 0xPolygon/pipelines/.github/workflows/security-go-mod-check.yml@<full-40-char-sha> # <tag or date>
  govulncheck:
    permissions:
      contents: read
    uses: 0xPolygon/pipelines/.github/workflows/security-govulncheck.yml@<full-40-char-sha> # <tag or date>
```

Run govulncheck on every PR as above, or add a separate trigger with
`paths: [go.mod, go.sum]` if it is too slow for that.

Both Go workflows take the Go version from the caller's `go.mod`; `go mod tidy -diff` needs
Go 1.23 or later. Private modules are not supported: the workflows set no `GOPRIVATE` and pass
no credentials.

**Blocking on zizmor findings.** By default `security-zizmor.yml` uploads its findings to code
scanning and the job passes, so a required check on it alone blocks nothing. To block a PR on
the findings it introduces, add a **Require code scanning results** rule to the branch ruleset
with tool `zizmor` and the threshold you want (for example security alerts medium or higher,
alerts errors). Findings already on the default branch do not block. Repos without code
scanning (private repos without GitHub Code Security) pass `advanced-security: false`; the job
then fails on every finding at or above `min-severity`/`min-confidence`, existing ones included.

**Licences.** The allowlist in `security-dependency-review.yml` is shared. A package that is
already in a repo's tree under a licence outside it (LGPL `sharp-libvips`, GPL `go-ethereum`,
licence data GitHub cannot parse) is exempted by name in that repo's trigger, so bumping it does
not fail the check while a new dependency under that licence still does:

```yaml
    with:
      allow-dependencies-licenses: >-
        pkg:npm/@img/sharp-libvips-linux-x64,
        pkg:golang/github.com/ethereum/go-ethereum
```

To find the packages a repo needs to exempt, evaluate its dependency-graph SBOM
(`GET /repos/{owner}/{repo}/dependency-graph/sbom`) against the allowlist. Packages without
licence data only produce a warning.

Advisories fail the check in the `runtime`, `development` and `unknown` scopes, because dev and
tooling dependencies run in CI too. A caller can narrow that with the `fail-on-scopes` input.

**Versions.** Dependabot keeps the action pins here current (`.github/dependabot.yml`, 7-day
cooldown; minor and patch updates grouped, majors as separate PRs). The zizmor version (`version:` input) and the govulncheck version (`go install`) are
pinned by hand and bumped deliberately.

## Shared org infrastructure workflows

### Current

| Workflow | Purpose |
|----------|---------|
| `gcp_pipeline_release_image.yaml` | Canonical Docker image build + push to GCP Artifact Registry with OIDC auth. Builds each platform in `platforms` natively on its own runner (`runner_amd64` / `runner_arm64` inputs; arm64 defaults to GitHub's `ubuntu-24.04-arm`) and merges the per-platform digests into one tagged multi-platform manifest — no QEMU emulation. The Apps Team `apps-docker-release.yml` delegates to this. |
| `generate_version.yaml` | Produces a deterministic version string `<iso-date>-<short-sha>-<run-id>-<run-number>` for consumers that need a build identifier. |
| `codeql.yml` | GitHub CodeQL security scanning. Generic template — consumers customise language matrix. |
| `slack-pr-merged.yml` | Reacts `:git-merged:` on Slack messages, in one or more channels, that link a merged PR, and posts a thread reply with each PR's state (`:git-merged:`, `:github-closed:`, `:hourglass_flowing_sand:`) when the message links several PRs. Uses the action `actions/slack-pr-merged`. Needs the `SLACK_BOT_TOKEN` org secret (scopes `channels:history`, `reactions:write`, `chat:write`, plus `groups:history` for private channels) and a `SLACK_PR_MERGED_CHANNEL_IDS` variable (channel IDs separated by spaces, commas or newlines). The bot must be invited to every listed channel. Without either one, it is a no-op. The optional `PR_READ_TOKEN` secret lets it read PRs in other repos. Don't give it to a public repo: its workflows would hold a credential that reads private PRs, and those links stay `?` without it. Wire it with `slack-pr-merged-trigger.yml`. |

### Deprecated / Legacy (AWS/ECS)

Kept for consumers that have not yet migrated off AWS ECS. New services
should use the GCP pipeline instead.

| Workflow | Purpose |
|----------|---------|
| `ecs_deploy_docker_taskdef.yaml` | Build Docker image and deploy to ECS via templated taskdef. |
| `npm_build_deploy_default.yaml` | npm install + build + Docker image + ECS deploy using the repo's root `Dockerfile`. |

Supporting scripts for the ECS pipeline live under `Support/`
(taskdef templating, OpenAPI condensing, terraform plan automation).

---

## When to use which (Apps Team workflows)

### Use a composite action when

- **The logic needs the calling job's environment.** Composite actions run as steps
  in the caller's job, so `env:` vars, secrets composed by the trigger, and the
  checked-out file system are all present automatically. `actions/ci` uses this to
  receive test env vars (RPC URLs, API keys) without any secret-passing.

- **The output feeds another job in the same trigger file.** `actions/docker-test`
  resolves service metadata and outputs it for the `release` job to consume — this
  requires sharing state within the same workflow run, not a separate runner.

- **The logic is a sequence of shell steps** with no complex job-level concerns
  (no matrix, no needs:, no job-level permissions beyond what the caller grants).

### Use a reusable workflow when

- **The logic needs its own isolated runner.** Reusable workflows spin up a fresh
  runner with their own environment. `apps-changeset-check.yml` and `apps-npm-release.yml`
  need their own checkout of the calling repo, their own `pnpm install`, and their
  own job-level configuration.

- **The logic is a complete, self-contained unit** that should appear as a distinct
  check in the PR status (e.g. "Changeset check / Require changeset"). Composite
  action steps roll up into the calling job's check, not their own.

- **The logic calls another reusable workflow** (only workflows can call workflows —
  composite actions cannot). `apps-docker-release.yml` delegates to
  `gcp_pipeline_release_image.yaml`, which is itself a reusable workflow.

---

## Adding a new Apps Team reusable workflow

1. Add `.github/workflows/apps-<name>.yml` with `on: workflow_call:` as the only trigger.
2. Declare required secrets in the `workflow_call: secrets:` block.
3. Add `permissions:` at the workflow level with least-privilege scopes.
4. Keep all job logic in this file — trigger files must be thin wrappers.
5. Add a trigger file template (`apps-<name>-trigger.yml`) and update the tables above.

**Trigger file permissions:** A trigger file's `permissions:` must be a superset of
every scope the called workflow's jobs declare. Mismatches cause a `startup_failure`
before any step runs. The canonical trigger files already have the correct
permissions.

## Adding a new composite action (shell-only)

1. Create `.github/actions/<name>/action.yml` with `using: composite`.
2. No dist or build step needed — GitHub executes composite action steps directly.
3. Add the action to the tables above.

## Adding a new composite action with compiled dist

Required when the action is called from inside a reusable workflow that runs
cross-repo — raw scripts under `.github/scripts/` are not accessible in the calling
repo's workspace.

1. Create `packages/<name>/` with `src/index.ts`, `package.json`, and `tsconfig.json`
   (see existing packages — the per-package tsconfig is required for ncc compatibility).
2. Create `.github/actions/<name>/action.yml` referencing `dist/index.js`.
3. Add `"build:<name>": "ncc build packages/<name>/src/index.ts -o .github/actions/<name>/dist"`
   to root `package.json`.
4. Run `pnpm run build:<name>` locally and commit the `dist/`.
5. Add `.github/actions/<name>/dist/** -diff linguist-generated=true` to `.gitattributes`.
6. Add a job to `apps-build-actions.yml` so the dist rebuilds automatically on `main`.
