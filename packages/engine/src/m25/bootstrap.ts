// Config bootstrap (B-M25-01 logic 3-4; ARCH M25): at start, the ceilings file must be root-owned and read-only to
// the engine and must parse; then the active config is the newest `config_version` row, or, on the very first start,
// the root-owned /etc/bot/config.json, validated against the schema and stored as config_version 1 (`config_version`
// = sha256 of its canonical JSON). Later versions exist only in the database (immutable rows, written by B-M25-03);
// a changed config file is then ignored and logged. Keys missing from a file or a stored version take their default.
//
// A refusal maps to the engine's `start_refused` reason (`ceilings_untrusted`, `ceilings_invalid`, `config_untrusted`,
// `config_invalid`); an invalid stored version is B-M25-03's case (exits_only with the last valid version).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalJson, type Actor, type Clock, type Config, type ConfigFieldSchema, type Result } from '@bot/types';
import type { Db } from '../m24/db.ts';
import type { ConfigVersionsRepo } from '../m24/repos.ts';
import type { Logger } from '../m27/log.ts';
import type { GaugeHandle } from '../m27/metrics.ts';
import { parseCeilings, type Ceilings } from './ceilings.ts';
import { valueProblem, type ConfigFieldDef } from './fields.ts';
import { lstatOrNull, trustProblem, type StatFn } from './files.ts';
import { CONFIG_FIELDS, schema } from './registry.ts';

export const CEILINGS_PATH = '/etc/bot/ceilings.json';
export const CONFIG_PATH = '/etc/bot/config.json';
export const SYSTEM_ACTOR: Actor = { type: 'system', id: 'm25.bootstrap', display: 'config bootstrap' };

export const M25_LOG_CODES = {
  'm25.bootstrap': { fields: { config_version: 'string', version_no: 'integer' } },
  'm25.loaded': { fields: { config_version: 'string', version_no: 'integer' } },
  'm25.config_file_ignored': { fields: { file_sha256: 'string', config_version: 'string' } },
  'm25.start_refused': { fields: { reason: 'string', error_code: 'string', message: 'string' } },
} as const;

export type RefusalReason = 'ceilings_untrusted' | 'ceilings_invalid' | 'config_untrusted' | 'config_invalid';
export interface StartRefusal { code: string; reason: RefusalReason; message: string; errors: Array<{ key: string; code: string }> }

export interface ConfigService {
  schema(): ConfigFieldSchema[];
  current(): Readonly<Config>;
  ceilings(): Readonly<Ceilings>;
  readonly versionNo: number;
}

export interface BootstrapOptions {
  db: Db;
  repo: ConfigVersionsRepo;
  clock: Clock;
  /** The process's effective user ID (`process.geteuid()`). */
  euid: number;
  ceilingsPath?: string;
  configPath?: string;
  stat?: StatFn;
  readFile?: (path: string) => string;
  log?: Logger;
  /** `config_version_info{version}`: set to 1 for the active version. */
  versionInfo?: (version: string) => GaugeHandle;
  fields?: readonly ConfigFieldDef[];
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Resolves a flat `{ key: value }` object against the fields: unknown keys, secrets and bad values are errors. */
export function resolveConfig(json: unknown, fields: readonly ConfigFieldDef[]): Result<Record<string, unknown>, { code: 'E_CONFIG_INVALID'; errors: Array<{ key: string; code: string }> }> {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return { ok: false, error: { code: 'E_CONFIG_INVALID', errors: [{ key: '', code: 'E_NOT_OBJECT' }] } };
  const given = json as Record<string, unknown>;
  const errors: Array<{ key: string; code: string }> = [];
  for (const key of Object.keys(given).sort()) if (!fields.some((f) => f.key === key)) errors.push({ key, code: 'E_UNKNOWN_KEY' });
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.secret) {
      if (Object.hasOwn(given, f.key)) errors.push({ key: f.key, code: 'E_SECRET' });
      continue;
    }
    const value = Object.hasOwn(given, f.key) ? given[f.key] : f.default;
    const problem = valueProblem(f, value);
    if (problem !== null) errors.push({ key: f.key, code: problem });
    out[f.key] = value;
  }
  return errors.length === 0 ? { ok: true, value: out } : { ok: false, error: { code: 'E_CONFIG_INVALID', errors } };
}

function tryRead(read: (path: string) => string, path: string): string | null {
  try {
    return read(path);
  } catch {
    return null;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Runs the start-up checks and returns the config service, or the reason the start is refused. */
export function bootstrapConfig(opts: BootstrapOptions): Result<ConfigService, StartRefusal> {
  const stat = opts.stat ?? lstatOrNull;
  const read = opts.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const fields = opts.fields ?? CONFIG_FIELDS;
  const ceilingsPath = opts.ceilingsPath ?? CEILINGS_PATH;
  const configPath = opts.configPath ?? CONFIG_PATH;
  const refuse = (reason: RefusalReason, code: string, message: string, errors: StartRefusal['errors'] = []): Result<ConfigService, StartRefusal> => {
    opts.log?.event('critical', 'm25.start_refused', { reason, error_code: code, message });
    return { ok: false, error: { code, reason, message, errors } };
  };

  const ceilingsTrust = trustProblem(ceilingsPath, opts.euid, stat);
  if (ceilingsTrust !== null) return refuse('ceilings_untrusted', ceilingsTrust.code, ceilingsTrust.message);
  const ceilingsText = tryRead(read, ceilingsPath);
  if (ceilingsText === null) return refuse('ceilings_invalid', 'E_CEILINGS_UNREADABLE', `${ceilingsPath} cannot be read`);
  const ceilings = parseCeilings(ceilingsText);
  if (!ceilings.ok) return refuse('ceilings_invalid', ceilings.error.code, ceilings.error.message);

  const latest = opts.db.withTx((tx) => opts.repo.find(tx, {}, { orderBy: 'versionNo', desc: true, limit: 1 }))[0];
  let active: { configVersion: string; versionNo: number; values: Record<string, unknown> };
  if (latest !== undefined) {
    const stored = resolveConfig(JSON.parse(latest.json), fields);
    if (!stored.ok) return refuse('config_invalid', 'E_CONFIG_STORED_INVALID', `config_version ${latest.versionNo} does not match the schema`, stored.error.errors);
    active = { configVersion: latest.configVersion, versionNo: latest.versionNo, values: stored.value };
    const fileText = tryRead(read, configPath);
    if (fileText !== null) {
      const fromFile = resolveConfig(parseJson(fileText), fields);
      if (!fromFile.ok || sha256(canonicalJson(fromFile.value)) !== latest.configVersion) {
        opts.log?.event('info', 'm25.config_file_ignored', { file_sha256: sha256(fileText), config_version: latest.configVersion });
      }
    }
    opts.log?.event('info', 'm25.loaded', { config_version: active.configVersion, version_no: active.versionNo });
  } else {
    const configTrust = trustProblem(configPath, opts.euid, stat);
    if (configTrust !== null) return refuse('config_untrusted', configTrust.code, configTrust.message);
    const text = tryRead(read, configPath);
    if (text === null) return refuse('config_invalid', 'E_CONFIG_UNREADABLE', `${configPath} cannot be read`);
    const resolved = resolveConfig(parseJson(text), fields);
    if (!resolved.ok) return refuse('config_invalid', 'E_CONFIG_INVALID', `${configPath} does not match the schema`, resolved.error.errors);
    const json = canonicalJson(resolved.value);
    const now = opts.clock.nowMs();
    active = { configVersion: sha256(json), versionNo: 1, values: resolved.value };
    opts.db.withTx((tx) => opts.repo.insert(tx, { configVersion: active.configVersion, versionNo: 1, json, appliedAt: now, appliedBy: canonicalJson(SYSTEM_ACTOR), createdAt: now }));
    opts.log?.event('info', 'm25.bootstrap', { config_version: active.configVersion, version_no: 1 });
  }

  opts.versionInfo?.(active.configVersion).set(1);
  const config = Object.freeze({ ...active.values, version: active.configVersion }) as Config;
  return {
    ok: true,
    value: { schema: () => schema(), current: () => config, ceilings: () => ceilings.value, versionNo: active.versionNo },
  };
}
