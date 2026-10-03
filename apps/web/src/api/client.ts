import { PATHS, type DashboardApi, type Envelope, type Mode } from './contract.ts';
import { PREVIEW } from '../lib/preview.ts';
import { checkEnvelope } from './modes.ts';
import { loadReport } from './reportLoader.ts';
import { parseReport } from './reportSchema.ts';

export class OfflineError extends Error {}

const offline = () => Promise.reject(new OfflineError('worker not connected'));

/** Used until a worker address is configured: every call fails as offline. */
export const offlineApi: DashboardApi = {
  status: offline,
  funnel: offline,
  decisions: offline,
  position: offline,
  calendar: offline,
  trades: offline,
  charts: offline,
  stats: offline,
  backtestReport: offline,
};

/** Reads the worker over HTTP; every response passes checkEnvelope before use. */
export function httpApi(base: string, fetcher: typeof fetch = fetch): DashboardApi {
  async function get<T>(path: string, mode: Mode): Promise<Envelope<T>> {
    let res: Response;
    try {
      res = await fetcher(base.replace(/\/$/, '') + path, { headers: { accept: 'application/json' } });
    } catch {
      throw new OfflineError('worker not reachable');
    }
    if (!res.ok) throw new Error(`worker answered ${res.status}`);
    return checkEnvelope<T>(await res.json(), mode);
  }
  return {
    status: (m) => get(PATHS.status(m), m),
    funnel: (m) => get(PATHS.funnel(m), m),
    decisions: (m) => get(PATHS.decisions(m), m),
    position: (m) => get(PATHS.position(m), m),
    calendar: (m, month) => get(PATHS.calendar(m, month), m),
    trades: (m) => get(PATHS.trades(m), m),
    charts: (m) => get(PATHS.charts(m), m),
    stats: (m) => get(PATHS.stats(m), m),
    backtestReport: async () => {
      const env = await get<unknown>(PATHS.backtestReport(), 'backtest');
      return { ...env, data: env.data === null ? null : parseReport(env.data) };
    },
  };
}

/**
 * VITE_WORKER_URL points the app at a worker; without it the app shows the offline state.
 * The preview build reads the newest backtest report file from its release URL, so real
 * backtest results show before the worker runs.
 */
export function defaultApi(): DashboardApi {
  const url = import.meta.env['VITE_WORKER_URL'] as string | undefined;
  const base = url ? httpApi(url) : offlineApi;
  return PREVIEW ? { ...base, backtestReport: () => loadReport() } : base;
}
