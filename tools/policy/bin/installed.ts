// Installed-package scan, run by CI right after `pnpm install --frozen-lockfile`: node tools/policy/bin/installed.ts [root]
import { main } from '../installed.ts';

process.exitCode = main(process.argv.slice(2), { out: (s) => console.log(s), err: (s) => console.error(s) });
