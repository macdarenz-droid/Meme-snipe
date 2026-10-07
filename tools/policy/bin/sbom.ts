// Release SBOM (tools/policy/sbom.ts): node tools/policy/bin/sbom.ts > sbom.cdx.json
import { main } from '../sbom.ts';

process.exitCode = main(process.argv.slice(2), { out: (s) => console.log(s), err: (s) => console.error(s) });
