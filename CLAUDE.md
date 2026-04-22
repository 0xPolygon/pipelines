## Team Standards

**Skip this fetch if team-standards.md is already loaded in your context**
(this happens when running from the apps-team-workspace).
Otherwise, **at the start of every session**, before doing any other
work, use the WebFetch tool to retrieve the Polygon Apps Team standards
from:
<https://gist.githubusercontent.com/MaximusHaximus/4eb35e807f7470b1c4eab78a9152b2ef/raw/team-standards.md>

Follow all instructions in that document for the duration of this session.
If the fetch fails (network error, URL unreachable), inform the user that
team standards could not be loaded, then proceed with repo-specific rules
below.

---

# CLAUDE.md

## Repository Purpose

This repository hosts shared CI/CD workflows used across the Polygon GitHub
orgs. It mixes two generations of tooling:

- **Legacy AWS/ECS workflows** — `ecs_deploy_docker_taskdef.yaml`,
  `npm_build_deploy_default.yaml`. Not used by the Apps Team; kept for
  consumers that have not yet migrated off ECS.
- **Current GCP pipeline** — `gcp_pipeline_release_image.yaml` is the
  canonical Docker image build + push into GCP Artifact Registry.
- **Apps Team shared workflows** — prefixed `apps-*.yml`. These are the
  reusable workflows + composite actions the Apps Team uses across all its
  services. They were migrated here from `0xPolygon/apps-team-workflows`
  so that public-visibility consuming repos can call them directly
  (GitHub forbids private → public workflow calls).

The sections below cover the Apps Team subset only. For questions about
the legacy ECS or GCP-pipeline workflows, see the root `README.md`.

## Layout (Apps Team subset)

- **`.github/workflows/apps-*.yml`** — Apps Team reusable workflows and
  their trigger examples. Each reusable workflow uses `on: workflow_call`
  and contains logic only. Each trigger file (`apps-*-trigger.yml`) is
  the canonical example of how a consuming repo wires the event.
- **`.github/actions/`** — Custom GitHub Actions consumed via `uses:
  0xPolygon/pipelines/.github/actions/<name>@main` (or `./.github/actions/<name>`
  when called from this repo). Contains only `action.yml` and — for
  compiled actions — the committed `dist/` bundle.
- **`packages/`** — Source packages (pnpm workspace) that compile into
  the `dist/` bundles under `.github/actions/<name>/dist/`.
- **`.github/scripts/`** — TypeScript helpers executed directly by the
  `apps-build-actions.yml` workflow via `node <script>.ts`.

## The trigger pattern

Apps Team workflows follow a two-file pattern in consuming repositories:

### `apps-<name>.yml` (this repo — logic)

Contains the actual job steps. Always `on: workflow_call`. Declares
`permissions:` at the workflow level, and declares all required `secrets:`
in the `workflow_call` block so callers pass them explicitly.

### `<name>-trigger.yml` (consuming repo — event)

Contains only the event trigger, top-level `permissions:`, and a single
job that calls the shared workflow. For **private repos**:

```yaml
jobs:
  check:
    uses: 0xPolygon/pipelines/.github/workflows/apps-<name>.yml@main
    secrets:
      MY_SECRET: ${{ secrets.MY_SECRET }}
```

For **public repos** — now able to call across the visibility boundary
because `pipelines` is public, no local verbatim copy required:

```yaml
jobs:
  check:
    uses: 0xPolygon/pipelines/.github/workflows/apps-<name>.yml@main
    secrets:
      MY_SECRET: ${{ secrets.MY_SECRET }}
```

This was the whole point of moving the Apps Team workflows here.

## Trigger file permissions

A trigger file's top-level `permissions:` must be a superset of every scope the
called workflow's jobs declare. GitHub enforces this at startup — mismatches
produce an immediate `startup_failure` before any step runs.

When writing a trigger file, read the called workflow's job-level `permissions:`
block and mirror those scopes in the trigger. The canonical examples in
`apps-team-ts-template` already have the correct permissions for each workflow.

## Adding a new reusable workflow

1. Add `.github/workflows/apps-<name>.yml` with `on: workflow_call:` as
   the only trigger.
2. Declare all required secrets in the `workflow_call: secrets:` block.
3. Add `permissions:` at the workflow level with least-privilege scopes.
4. Keep all job logic in this file — trigger files must be thin wrappers.
5. Add a trigger file template (`apps-<name>-trigger.yml`) showing the
   canonical event wiring.
6. Document it in `README.md`.

## docker-release integration test gate

The `docker-test` composite action (`.github/actions/docker-test/`) is
the test gate. The trigger file in the consuming repo has two jobs:

- **`test`** — calls `docker-test`, which builds the Docker image, starts
  the container with `PORT` injected, waits for `/health-check` (30s
  timeout), runs `pnpm --filter <service> test` with
  `TEST_BASE_URL=http://localhost:<port>`, then stops the container.
- **`release`** (`needs: test`) — calls `apps-docker-release.yml` to push to GCP.

The GCP push only runs if the test job passes.

All services must respect the `PORT` environment variable so the action
can standardise the external port. The default port is `3000`; override
via the `port:` input when a service uses a different port.

Services that need runtime env vars in the test container declare them in
the trigger job's `env:` block and pass their names via the `test_vars`
input — the action forwards each named var to the container using
`docker run -e VAR` (copies from the job's process environment). No
secret-passing or escaping needed.

### Services with Firestore dependencies

Services that use Firestore must start the Firestore emulator as a sibling
container BEFORE calling `docker-test`. The emulator needs to be healthy
before the service container starts so its `/health-check` passes on the
first attempt.

Add an `actions/checkout` step and a `docker compose up` step before the
`docker-test` action in the trigger's `test` job:

```yaml
steps:
  - uses: actions/checkout@<pin>  # needed to access docker-compose.yml
  - name: Start Firestore emulator
    run: docker compose up -d --wait  # or -f path/to/docker-compose.yml
  - id: docker-test
    uses: 0xPolygon/pipelines/.github/actions/docker-test@main
    with:
      test_vars: FIRESTORE_EMULATOR_HOST GOOGLE_CLOUD_PROJECT_ID FIRESTORE_DATABASE_ID ...
```

Set `FIRESTORE_EMULATOR_HOST: 172.17.0.1:8080` in the job's `env:` block.
`172.17.0.1` is the Docker bridge gateway on GitHub Actions Ubuntu runners —
reachable from any container started on the default bridge network, so the
service container connects to the same emulator the test runner uses.

The test runner connects to the emulator at `127.0.0.1:8080` (via the
published port) to seed data before assertions run. The service container
connects at `172.17.0.1:8080`. Both reach the same emulator instance.

See `pos-airdrop` and `lst-api` for reference implementations.

## Adding a new custom action

1. Create `packages/<name>/` with `src/index.ts`, `package.json` (declare runtime deps here),
   and `tsconfig.json` (see existing packages for the template — required for ncc compatibility
   with the root tsconfig's `@tsconfig/node24` settings).
2. Create `.github/actions/<name>/action.yml` with `using: composite` — no `dist/` needed yet.
3. Add `"build:<name>": "ncc build packages/<name>/src/index.ts -o .github/actions/<name>/dist"`
   to root `package.json` scripts.
4. Run `pnpm run build:<name>` locally and commit the generated `dist/`.
5. Add `.github/actions/<name>/dist/** -diff linguist-generated=true` to `.gitattributes`.
6. Add the action to `apps-build-actions.yml` so `dist/` is automatically rebuilt and committed
   whenever `packages/<name>/src/index.ts` changes on `main`.

Actions are used locally within reusable workflows via `uses: ./.github/actions/<name>`
and externally via `uses: 0xPolygon/pipelines/.github/actions/<name>@main`. There is no
external versioning or tagging — the action is always consumed at the caller's chosen ref.

## GitHub script helpers

`.github/scripts/` contains TypeScript helper scripts executed directly by
`apps-build-actions.yml` via `run: node .github/scripts/<script>.ts`. These run
only within this repo (never cross-repo), so they can use raw Node 24 TypeScript
execution without a compiled dist. They import from devDependencies installed at
the repo root (currently `@octokit/rest`).
