// Secrets scan of files outside git, such as the CI test log: node tools/policy/bin/secrets.ts <file>...
import { scanMain } from '../secrets.ts';

process.exitCode = scanMain(process.argv.slice(2), process.cwd(), { out: (s) => console.log(s), err: (s) => console.error(s) });
