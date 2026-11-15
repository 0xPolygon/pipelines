import { CALLEE_PATH } from './canonical.ts';
import { runChecks } from './engine.ts';

export { CALLEE_PATH, runChecks };

const VERSION = '1.0.0';

if (process.argv.includes('--version')) {
  console.log(`release-conformance ${VERSION}`);
}
