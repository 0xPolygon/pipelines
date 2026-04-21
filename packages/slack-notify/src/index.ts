import type { Endpoints } from '@octokit/types';
import type { IncomingWebhookSendArguments } from '@slack/webhook';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { IncomingWebhook } from '@slack/webhook';

type PullRequest = Endpoints['GET /repos/{owner}/{repo}/pulls/{pull_number}']['response']['data'];

const slackUrl = process.env['SLACK_URL'];
const isTest = process.env['IS_TEST'] === 'true';
const developerNote = process.env['DEVELOPER_NOTE'] ?? '';

if (!slackUrl) {
  throw new Error('SLACK_URL env var is required');
}

const pr = JSON.parse(
  readFileSync(join(process.env['GITHUB_WORKSPACE'] ?? '.', 'pr.json'), 'utf8')
) as PullRequest;

if (!pr.merged_by) {
  throw new Error('pr.merged_by is null — PR must be merged before notifying');
}

const repoName = pr.base.repo.name;
const header = isTest ? `:test_tube: [TEST] ${repoName} updated` : `${repoName} updated`;

const webhook = new IncomingWebhook(slackUrl);

const blocks: IncomingWebhookSendArguments['blocks'] = [
  {
    type: 'header',
    text: { type: 'plain_text', text: header }
  },
  {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*#${pr.number}: ${pr.title}* <${pr.html_url}|:link:>`
    }
  },
  {
    type: 'context',
    elements: [
      { type: 'mrkdwn', text: `*Repo:* \`${pr.base.repo.full_name}\`` },
      { type: 'mrkdwn', text: `*Author:* ${pr.user.login}` },
      { type: 'mrkdwn', text: `*Merged by:* ${pr.merged_by.login}` },
      {
        type: 'mrkdwn',
        text: `*Changes:* 🟢 +${pr.additions}  🔴 -${pr.deletions}  across ${pr.changed_files} files`
      }
    ]
  }
];

if (developerNote) {
  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `:arrow_down: *Developers:* ${developerNote}`
    }
  });
}

async function main() {
  await webhook.send({ blocks });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
