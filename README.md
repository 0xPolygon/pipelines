# pipelines

Shared CI/CD workflows and composite actions for the Polygon GitHub orgs
(`0xPolygon`, `AggLayer`, `maticnetwork`). The contents fall into two
families:

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
| `apps-changeset-check.yml` | PR gate: requires a changeset; posts/deletes instructions comment | _(none)_ |
| `apps-npm-release.yml` | Changesets release pipeline: version bumps, npm publish, git tags | `CHANGESET_RELEASE_BOT_APP_ID`, `CHANGESET_RELEASE_BOT_APP_PRIVATE_KEY` |
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
| `actions/docker-test` | Resolve service from tag, build image, start container, run tests, stop | No — pure shell |
| `actions/npm-release` | Publish, tag, and release post-changesets merge | No — bash script |
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

### `actions/docker-test`

Resolves a deployable service from a changeset git tag, builds its Docker image,
starts the container, waits for `/health-check`, runs the test suite via
`TEST_BASE_URL`, then stops the container. Outputs the resolved `image_name`,
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
```

### `actions/slack-notify` and `actions/upsert-changeset-comment`

Used internally by `apps-slack-merge-notify.yml` and `apps-changeset-check.yml`
respectively. Both contain logic that runs across repository boundaries inside a
reusable workflow context, so they must be compiled ncc bundles (raw
`.github/scripts/` files are not accessible in the calling repo's workspace).
See [Adding a new composite action with compiled dist](#adding-a-new-composite-action-with-compiled-dist).

---

## Shared org infrastructure workflows

### Current

| Workflow | Purpose |
|----------|---------|
| `gcp_pipeline_release_image.yaml` | Canonical Docker image build + push to GCP Artifact Registry with OIDC auth. The Apps Team `apps-docker-release.yml` delegates to this. |
| `generate_version.yaml` | Produces a deterministic version string `<iso-date>-<short-sha>-<run-id>-<run-number>` for consumers that need a build identifier. |
| `codeql.yml` | GitHub CodeQL security scanning. Generic template — consumers customise language matrix. |
| `security-build.yml` | SonarCloud scan (`SONAR_TOKEN`) on push to `main`/`dev`/`staging` and on PRs. |

### Deprecated / Legacy (AWS/ECS)

Kept for consumers that have not yet migrated off AWS ECS. New services
should use the GCP pipeline instead.

| Workflow | Purpose |
|----------|---------|
| `ecs_deploy_docker_taskdef.yaml` | Build Docker image and deploy to ECS via templated taskdef. Used by `maticnetwork/open-api` apps. |
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
