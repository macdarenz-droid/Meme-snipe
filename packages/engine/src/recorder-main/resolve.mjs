// The recorder's entry on the host (card Z10): worker-start and worker-smoke run this file. It installs the module
// resolution of resolve-hooks.mjs (workspace sources only, no npm package), then loads main.ts (Node 22 strips the
// types).
import './resolve-hooks.mjs';

await import('./main.ts');
