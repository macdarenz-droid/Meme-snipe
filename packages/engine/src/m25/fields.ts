// Config field definitions (B-M25-01 logic 1-2, 5; ARCH 5.0a `ConfigFieldSchema`, VM-15). Each module exports its
// fields; the registry (registry.ts) merges them. A field adds to the frozen `ConfigFieldSchema` its section, label,
// description and default. Values in the config file and in `config_version.json` are JSON: integers (`int`, `bps`,
// `duration_ms`) as numbers, lamports and base units as decimal strings (VM convention 2), decimals as exact decimal
// strings, `list` as an array of strings. Secret fields never hold a value (VM-15 `is_set`; values come from the
// secret store), so a secret key in a config file is an error.
import type { ConfigFieldSchema, Mode } from '@bot/types';

export type ConfigValue = string | number | boolean | readonly string[];
export interface ConfigFieldDef extends Omit<ConfigFieldSchema, 'enumValues' | 'modeScope'> {
  readonly enumValues: readonly string[] | null;
  readonly modeScope: readonly Mode[];
  readonly section: string;
  readonly label: string;
  readonly description: string;
  /** Null only for secret fields. */
  readonly default: ConfigValue | null;
}

export const ALL_MODES: readonly Mode[] = ['backtest', 'replay', 'paper', 'live_small', 'live'];
const KEY_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
const U64_RE = /^(0|[1-9][0-9]{0,19})$/;
const DECIMAL_RE = /^-?(0|[1-9][0-9]*)(\.[0-9]{1,30})?$/;
const U64_MAX = 18_446_744_073_709_551_615n;
const STRING_MAX = 4_096;
const LIST_MAX = 256;

/** A decimal string as a scaled integer (30 fractional digits), for exact comparisons. */
export function scaled(d: string): bigint {
  const negative = d.startsWith('-');
  const [int, frac = ''] = (negative ? d.slice(1) : d).split('.');
  const v = BigInt(int as string) * 10n ** 30n + BigInt(frac.padEnd(30, '0'));
  return negative ? -v : v;
}

function inBounds(field: ConfigFieldDef, v: bigint): boolean {
  return (field.min === null || v >= scaled(field.min)) && (field.max === null || v <= scaled(field.max));
}

/** Null when `value` is valid for the field; otherwise the error code. */
export function valueProblem(field: ConfigFieldDef, value: unknown): 'E_TYPE' | 'E_RANGE' | 'E_ENUM' | 'E_SECRET' | null {
  if (field.secret) return 'E_SECRET';
  switch (field.type) {
    case 'bool':
      return typeof value === 'boolean' ? null : 'E_TYPE';
    case 'enum':
      return typeof value !== 'string' ? 'E_TYPE' : (field.enumValues ?? []).includes(value) ? null : 'E_ENUM';
    case 'string':
      return typeof value === 'string' && value.length <= STRING_MAX ? null : 'E_TYPE';
    case 'list':
      return Array.isArray(value) && value.length <= LIST_MAX && value.every((s) => typeof s === 'string' && s.length <= STRING_MAX) ? null : 'E_TYPE';
    case 'int': case 'bps': case 'duration_ms':
      if (!Number.isSafeInteger(value) || (field.type === 'duration_ms' && (value as number) < 0)) return 'E_TYPE';
      return inBounds(field, BigInt(value as number) * 10n ** 30n) ? null : 'E_RANGE';
    case 'lamports': case 'base_units':
      if (typeof value !== 'string' || !U64_RE.test(value) || BigInt(value) > U64_MAX) return 'E_TYPE';
      return inBounds(field, BigInt(value) * 10n ** 30n) ? null : 'E_RANGE';
    case 'decimal':
      if (typeof value !== 'string' || !DECIMAL_RE.test(value)) return 'E_TYPE';
      return inBounds(field, scaled(value)) ? null : 'E_RANGE';
  }
}

/** Programmer errors in a field definition: a malformed key, a default that fails its own type, bounds or enum. */
export function fieldProblem(field: ConfigFieldDef): string | null {
  if (!KEY_RE.test(field.key)) return `config key "${field.key}" must be dotted snake_case`;
  if (!field.key.startsWith(`${field.section}.`)) return `config key "${field.key}" is outside its section "${field.section}"`;
  if (field.secret) return field.default === null ? null : `secret config key "${field.key}" must have no default value`;
  if (field.default === null) return `config key "${field.key}" needs a default`;
  const problem = valueProblem(field, field.default);
  return problem === null ? null : `config key "${field.key}": default fails ${problem}`;
}
