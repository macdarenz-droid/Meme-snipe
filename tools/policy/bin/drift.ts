// Review label check for the lockfile and policy files (tools/policy/drift.ts). CI runs it from the pull request
// (ci.yml) and from the base branch against the pull request (guard.yml). `--print-label` prints the label for HEAD.
import { main } from '../drift.ts';
import { gitAt } from '../git.ts';

process.exitCode = main(process.argv.slice(2), process.env, gitAt(process.cwd()), { out: (s) => console.log(s), err: (s) => console.error(s) });
