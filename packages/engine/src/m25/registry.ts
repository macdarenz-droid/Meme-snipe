// Config schema registry (B-M25-01 logic 1): the fields of every module, merged once. A duplicate key or a malformed
// field throws when this module loads, so the build's tests fail ("fails the build on duplicate keys"). Code reads a
// config value only through `configValue(config, 'key')`, whose key type is the union of registered keys, so `tsc`
// rejects an unknown key; a test also scans the sources for every `configValue` call (static key-usage check).
// A module built later adds its field list to FIELD_LISTS, in review.
import type { Config, ConfigFieldSchema } from '@bot/types';
import { M14_CONFIG } from '../m14/config.ts';
import { M24_CONFIG } from '../m24/config.ts';
import { M27_CONFIG } from '../m27/config.ts';
import { fieldProblem, type ConfigFieldDef } from './fields.ts';

const FIELD_LISTS = [M14_CONFIG, M24_CONFIG, M27_CONFIG] as const;
type Field = (typeof FIELD_LISTS)[number][number];

/** Every registered key. */
export type ConfigKey = Field['key'];
type TypeOf<K extends ConfigKey> = Extract<Field, { key: K }>['type'];
/** The JSON value type of a key. */
export type ConfigValueOf<K extends ConfigKey> = TypeOf<K> extends 'int' | 'bps' | 'duration_ms' ? number
  : TypeOf<K> extends 'bool' ? boolean : TypeOf<K> extends 'list' ? readonly string[] : string;

/** Merges field lists; throws on a duplicate key or an invalid field definition. */
export function mergeFields(...lists: ReadonlyArray<readonly ConfigFieldDef[]>): readonly ConfigFieldDef[] {
  const seen = new Set<string>();
  const out: ConfigFieldDef[] = [];
  for (const field of lists.flat()) {
    if (seen.has(field.key)) throw new TypeError(`config key "${field.key}" is defined twice`);
    const problem = fieldProblem(field);
    if (problem !== null) throw new TypeError(problem);
    seen.add(field.key);
    out.push(field);
  }
  return Object.freeze(out.sort((a, b) => (a.key < b.key ? -1 : 1)));
}

export const CONFIG_FIELDS: readonly ConfigFieldDef[] = mergeFields(...FIELD_LISTS);

/** `schema()` (ARCH M25): the ConfigFieldSchema of every key, without the registry's extra properties. */
export function schema(): ConfigFieldSchema[] {
  return CONFIG_FIELDS.map((f) => ({
    key: f.key, type: f.type, unit: f.unit, displayUnit: f.displayUnit, min: f.min, max: f.max, step: f.step,
    enumValues: f.enumValues === null ? null : [...f.enumValues], secret: f.secret, requiresRestart: f.requiresRestart,
    riskDirectionOnIncrease: f.riskDirectionOnIncrease, affectsReturns: f.affectsReturns, modeScope: [...f.modeScope],
  }));
}

/** The value of a registered key in a resolved config (every key is present after bootstrap). */
export function configValue<K extends ConfigKey>(config: Config, key: K): ConfigValueOf<K> {
  if (!Object.hasOwn(config, key)) throw new TypeError(`config has no value for "${key}"`);
  return config[key] as ConfigValueOf<K>;
}
