// The one place the worker reads its environment and credentials (the worker's src/ never does: test/guard.test.ts).
// Keys come from systemd credentials (`$CREDENTIALS_DIRECTORY/<lower-case name>`, OPS-1) or, in the GitHub Actions
// rehearsal, from the upper-case environment variables. They are handed on only as a Secrets object: never printed,
// journaled, recorded or put in a URL that is logged.
import { existsSync, readFileSync, readlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { KEY_ENV } from '../../runner/src/contract.ts';
import type { Secrets } from '../src/providers/index.ts';
import { UNREADABLE } from '../src/run/config.ts';

export const ENV_NAMES = [
  'STATE_DIRECTORY', 'ZEROED_STATE_DIR', 'ZEROED_MODE', 'ZEROED_RECORDER', 'ZEROED_SIMULATE', 'ZEROED_HEALTH_ADDR', 'ZEROED_DRILLS',
  'ZEROED_RUN_ID', 'ZEROED_RUN_LABEL', 'ZEROED_GIT_SHA', 'WATCHDOG_URL', 'ZEROED_HEARTBEAT_MS', 'ZEROED_SUMMARY_MS', 'ZEROED_WALLET', 'ZEROED_STANDINS', 'ZEROED_API_ADDR',
  'ZEROED_STRATEGY', 'ZEROED_PAPER_EDGE_PPM', 'ZEROED_S0_DIAGNOSTIC', 'ZEROED_WATCH_EVERY_MS', 'ZEROED_WATCH_STALE_MS', 'ZEROED_WATCH_LATENCY_MS',
] as const;

const KEYS = ['HELIUS_API_KEY', 'ALCHEMY_API_KEY', 'JUPITER_API_KEY'] as const;
/** Host-only credentials (OPS-1): not provider keys, so not in Secrets. */
const HOST = ['telegram_chat_id', 'heartbeat_hmac_key'] as const;

export interface Environment {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly secrets: Secrets;
  /** Which provider keys are present (names only). */
  readonly present: readonly string[];
  readonly host: Readonly<Record<(typeof HOST)[number], string | null>>;
  readonly release: () => string | null;
  /** Environment names that look like key material (the worker refuses to start with any). */
  readonly keyMaterial: readonly string[];
  readonly argv: readonly string[];
  /**
   * The qualifying run's name from the release's `packages/runner/qualifying-run.json` (`{"run": "<name>"}`), null when
   * the file is absent; UNREADABLE when it is there but cannot be read (the worker then refuses to start).
   */
  readonly qualifyingRun: () => string | null | typeof UNREADABLE;
  /** Every credential value present, for the output redaction (never printed). */
  readonly secretValues: () => readonly string[];
}

export const readEnvironment = (): Environment => {
  const all = process.env;
  const env: Record<string, string | undefined> = {};
  for (const n of ENV_NAMES) env[n] = all[n];
  const dir = all['CREDENTIALS_DIRECTORY'];
  const fromFile = (name: string): string | null => {
    if (dir === undefined) return null;
    const p = join(dir, name);
    if (!existsSync(p)) return null;
    const v = readFileSync(p, 'utf8').trim();
    return v === '' ? null : v;
  };
  const value = (name: (typeof KEYS)[number]): string | null => fromFile(name.toLowerCase()) ?? fromFile(name) ?? (dir === undefined ? (all[name] ?? null) : null);
  const secrets: Secrets = {
    get: (name) => {
      if (!(KEYS as readonly string[]).includes(name)) throw new RangeError('unknown secret name');
      const v = value(name as (typeof KEYS)[number]);
      if (v === null) throw new Error(`credential ${name} is missing`);
      return v;
    },
  };
  return {
    env,
    secrets,
    present: KEYS.filter((k) => value(k) !== null),
    host: { telegram_chat_id: fromFile('telegram_chat_id'), heartbeat_hmac_key: fromFile('heartbeat_hmac_key') },
    keyMaterial: Object.keys(all).filter((n) => KEY_ENV.test(n)),
    argv: process.argv.slice(2),
    qualifyingRun: () => {
      const p = join(import.meta.dirname, '..', '..', 'runner', 'qualifying-run.json');
      if (!existsSync(p)) return null;
      try {
        const run = (JSON.parse(readFileSync(p, 'utf8')) as { run?: unknown }).run;
        return typeof run === 'string' && run !== '' ? run : UNREADABLE;
      } catch {
        return UNREADABLE;
      }
    },
    secretValues: () => [...KEYS.map(value), ...HOST.map(fromFile)].filter((v): v is string => v !== null),
    release: () => {
      try {
        return basename(readlinkSync('/opt/zeroed/current'));
      } catch {
        return null;
      }
    },
  };
};
