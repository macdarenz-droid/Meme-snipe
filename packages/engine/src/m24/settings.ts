// M24 settings read from the active config (wiring of B-M24-01 at engine start).
import type { Config } from '@bot/types';
import { configValue } from '../m25/registry.ts';

export function m24Settings(config: Config): { dbPath: string; synchronous: string } {
  return { dbPath: configValue(config, 'm24.db_path'), synchronous: configValue(config, 'm24.synchronous') };
}
