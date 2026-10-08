// Records a frozen package's FREEZE.json after a reviewed, signed-off change: node tools/policy/bin/freeze.ts packages/types
import { freezeMain } from '../freeze.ts';

process.exitCode = freezeMain(process.argv.slice(2), process.cwd(), { out: (s) => console.log(s), err: (s) => console.error(s) });
