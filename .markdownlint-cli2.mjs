import { markdownlint } from '@polygonlabs/apps-team-lint/markdownlint';

// Extend base ignores with pre-existing pipelines content not owned by the
// Apps Team. Apps-team-migrated docs still get linted.
export default markdownlint({
  ignores: [
    '**/node_modules/**',
    '**/.claude/**',
    '**/CHANGELOG.md',
    'SECURITY.md',
    '.github/PULL_REQUEST_TEMPLATE.md',
    'Support/**'
  ]
});
