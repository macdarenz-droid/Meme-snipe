// Card Z10: the soak's entry. The same module resolution as the recorder on the host (resolve-hooks.mjs: workspace
// sources only, no npm package), then the soak. Run with --expose-gc.
import '../../src/recorder-main/resolve-hooks.mjs';

await import('./soak.ts');
