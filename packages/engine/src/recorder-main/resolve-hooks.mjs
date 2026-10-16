// The recorder's module resolution on the host (card Z10; imported by resolve.mjs and the soak runner). The release
// is a `git archive` of the repository with no node_modules (zeroed-update), so this maps the workspace packages
// `@bot/<name>` (and `@bot/venue/constants`) to their sources in the release and refuses every other bare import. No
// npm code can load: the recorder runs on Node built-ins and this repository only.
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packages = fileURLToPath(new URL('../../../', import.meta.url));
const SUBPATHS = { 'venue/constants': 'venue/src/constants.ts' };
registerHooks({
  resolve(specifier, context, next) {
    const m = /^@bot\/([a-z]+)(?:\/([a-z]+))?$/.exec(specifier);
    if (m !== null) {
      const rel = m[2] === undefined ? `${m[1]}/src/index.ts` : SUBPATHS[`${m[1]}/${m[2]}`];
      if (rel === undefined) throw new Error(`refused: ${specifier} is not a workspace entry point`);
      return { url: pathToFileURL(packages + rel).href, shortCircuit: true };
    }
    if (!specifier.startsWith('node:') && !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('file:')) {
      throw new Error(`refused: ${specifier} is not a Node built-in or a file of this release`);
    }
    return next(specifier, context);
  },
});
