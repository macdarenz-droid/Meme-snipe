// Node version guard for the dashboard tooling (UI-T01 edge case). The bundler, Vite 8.3.2, declares engines
// `^20.19.0 || >=22.12.0` (UI-F32); the repository itself requires `>=22.18.0 <23` with engine-strict, so
// `pnpm install` already refuses an older Node. build.ts and serve.ts call this first so
// a direct `node test/tooling/...` run on an older Node also stops with a clear message.

export const BUNDLER_NODE_RANGE = '^20.19.0 || >=22.12.0';

/** Null when `version` (e.g. "22.23.2" or "v22.23.2") satisfies BUNDLER_NODE_RANGE; otherwise the message to print. */
export function unsupportedNode(version: string): string | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  const [major, minor] = m === null ? [0, 0] : [Number(m[1]), Number(m[2])];
  const ok = (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22;
  return ok ? null : `dashboard tooling needs Node ${BUNDLER_NODE_RANGE} (the bundler's engines); this is Node ${version}. `
    + 'Install the version in .node-version (22.23.2) and run npm ci again.';
}

/** Exits the process with the message when the running Node is unsupported. */
export function requireSupportedNode(version: string, exit: (code: number) => never, write: (s: string) => void): void {
  const message = unsupportedNode(version);
  if (message !== null) {
    write(`${message}\n`);
    exit(1);
  }
}
