// M15 settings read from the active config (fields in config.ts).
import type { Config } from '@bot/types';
import { configValue } from '../m25/registry.ts';

export interface M15Settings { heightPollMs: number; heightTimeoutMs: number; maxFutureSlotJump: number; slotMsInitial: number }

export function m15Settings(config: Config): M15Settings {
  return {
    heightPollMs: configValue(config, 'm15.height_poll_ms'),
    heightTimeoutMs: configValue(config, 'm15.height_timeout_ms'),
    maxFutureSlotJump: configValue(config, 'm15.max_future_slot_jump'),
    slotMsInitial: configValue(config, 'm15.slot_ms_initial'),
  };
}
