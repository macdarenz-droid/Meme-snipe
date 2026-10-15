// M10 settings read from the active config (fields in config.ts), and loading the active parameter set.
import type { Config, Result } from '@bot/types';
import type { LogPort } from '../m14/types.ts';
import { configValue } from '../m25/registry.ts';
import { loadSimParamSet, modelVersions, type ModelVersions, type SimParamSet, type SimParamsError } from './params.ts';

export interface M10Settings { paramSet: string; latencyMultiplier: number }

export function m10Settings(config: Config): M10Settings {
  // The decimal string is validated against 1.0-10.0 by M25; as a double it is exact enough for a multiplier.
  return { paramSet: configValue(config, 'sim.param_set'), latencyMultiplier: Number(configValue(config, 'sim.latency_multiplier')) };
}

/**
 * Loads the set named by `sim.param_set` and logs `m10.param_set_loaded` with its versions. An error is
 * `E_SIM_PARAMS`: the engine or CLI refuses to start a simulation mode on it (A-M10-01 edge cases).
 */
export function loadActiveSimParams(settings: M10Settings, read: (fileName: string) => string, log: LogPort):
  Result<{ set: SimParamSet; versions: ModelVersions }, SimParamsError> {
  const r = loadSimParamSet(settings.paramSet, read);
  if (!r.ok) return r;
  const versions = modelVersions(r.value);
  log.event('info', 'm10.param_set_loaded', { name: r.value.name, fill_model_version: versions.fillModelVersion, cost_model_version: versions.costModelVersion });
  return { ok: true, value: { set: r.value, versions } };
}
