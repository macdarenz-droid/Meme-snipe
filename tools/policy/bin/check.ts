import { main } from '../check.ts';

process.exitCode = main(process.argv.slice(2), process.env, { out: (s) => console.log(s), err: (s) => console.error(s) });
