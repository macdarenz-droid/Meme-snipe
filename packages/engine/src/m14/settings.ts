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
  healthDownAfterMs: number;
  degradedEnterAfterMs: number;
  degradedExitAfterMs: number;
  burnAlertBps: number;
  /** Rolling 31-day account caps by provider label (A-M14-05). */
  accountCaps: ReadonlyMap<string, number>;
  reserveBlockUnits: number;
  allocationFile: string;
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
    healthDownAfterMs: configValue(config, 'rpc.health.down_after_ms'),
    degradedEnterAfterMs: configValue(config, 'rpc.degraded.enter_after_ms'),
    degradedExitAfterMs: configValue(config, 'rpc.degraded.exit_after_ms'),
    burnAlertBps: configValue(config, 'rpc.burn.alert_bps'),
    accountCaps: new Map([
      ['chainstack', configValue(config, 'rpc.chainstack.rolling_31d_ru_cap')],
      ['helius', configValue(config, 'rpc.helius.rolling_31d_credit_cap')],
    ]),
    reserveBlockUnits: configValue(config, 'rpc.reserve_block_units'),
    allocationFile: configValue(config, 'rpc.allocation_file'),
  };
}
