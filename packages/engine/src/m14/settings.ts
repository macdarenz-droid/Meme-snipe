// M14 settings read from the active config (wiring of A-M14-01/02 at engine start; fields in config.ts).
import type { Config } from '@bot/types';
import { configValue } from '../m25/registry.ts';
import type { Priority } from './types.ts';

export interface M14Settings {
  providersFile: string;
  maxResponseBytes: number;
  p0ReserveBps: number;
  defaultTimeoutMs: Readonly<Record<Priority, number>>;
  sendEnabled: boolean;
}

export function m14Settings(config: Config): M14Settings {
  return {
    providersFile: configValue(config, 'rpc.providers_file'),
    maxResponseBytes: configValue(config, 'rpc.max_response_bytes'),
    p0ReserveBps: configValue(config, 'rpc.p0_reserve_bps'),
    defaultTimeoutMs: {
      0: configValue(config, 'rpc.default_timeout_ms.p0'),
      1: configValue(config, 'rpc.default_timeout_ms.p1'),
      2: configValue(config, 'rpc.default_timeout_ms.p2'),
      3: configValue(config, 'rpc.default_timeout_ms.p3'),
      4: configValue(config, 'rpc.default_timeout_ms.p4'),
    },
    sendEnabled: configValue(config, 'rpc.send_enabled'),
  };
}
