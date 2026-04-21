import { readFileSync } from 'node:fs';

import { Octokit } from '@octokit/rest';

const MARKER = '<!-- changeset-check-required -->';

const BODY = `${MARKER}

## Changeset required

This PR is missing a changeset. Please add one before merging.

**For a code change that should bump a package version:**
\`\`\`bash
pnpm exec changeset add
\`\`\`
Select the packages that changed and the bump type (\`patch\` / \`minor\` / \`major\`).

**For a chore, CI change, or other non-version-bumping change:**
\`\`\`bash
pnpm exec changeset add --empty
\`\`\``;

async function main(): Promise<void> {
  const octokit = new Octokit({ auth: process.env['GITHUB_TOKEN'] });
  const [owner, repo] = (process.env['GITHUB_REPOSITORY'] ?? '').split('/');
  const event = JSON.parse(readFileSync(process.env['GITHUB_EVENT_PATH']!, 'utf8'));
  const issue_number = event.pull_request.number as number;
  const passed = process.env['CHANGESET_PASSED'] === 'true';

  console.log(`PR #${issue_number} — changeset check ${passed ? 'passed' : 'failed'}`);

  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number
  });

  const existing = comments.find((c: { id: number; body?: string | null }) =>
    c.body?.startsWith(MARKER)
  );
  console.log(
    existing ? `Found existing nag comment (id: ${existing.id})` : 'No existing nag comment'
  );

  if (passed) {
    if (existing) {
      console.log(`Deleting nag comment ${existing.id} — changeset is now present`);
      await octokit.rest.issues.deleteComment({ owner, repo, comment_id: existing.id });
      console.log('Nag comment deleted');
    } else {
      console.log('No nag comment to clean up — nothing to do');
    }
  } else {
    if (existing) {
      console.log(`Updating existing nag comment ${existing.id}`);
      await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body: BODY });
      console.log('Nag comment updated');
    } else {
      console.log('Posting new nag comment');
      await octokit.rest.issues.createComment({ owner, repo, issue_number, body: BODY });
      console.log('Nag comment posted');
    }
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
