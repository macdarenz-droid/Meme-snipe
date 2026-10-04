import { PATHS, type DashboardApi, type Envelope, type Mode } from './contract.ts';
import { PREVIEW } from '../lib/preview.ts';
import { checkEnvelope, DataError } from './modes.ts';
import { defaultGetter, loadReport, type Got, type Getter } from './reportLoader.ts';
import { reportData } from './reportSchema.ts';
import type { Check } from './schema.ts';
import { schemaFor } from './schemas.ts';

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
  discovered: offline,
  backtestReport: offline,
};

/** What httpApi tells about each request: good data, an answer that failed (HTTP error or bad data), or not reachable. */
export interface Reachability {
  /** `endpoint` names the request (its path), so one failing endpoint is not hidden by others answering well. */
  reportOk(origin: string, at: string, endpoint: string): void;
  reportBad(origin: string, at: string, endpoint: string): void;
  reportOffline(origin: string): void;
}

/**
 * Reads the worker at `origin` (a checked tailnet address, src/api/server.ts). Read-only: every
 * call is a GET with no credentials. Every response passes checkEnvelope before use.
 */
export function httpApi(origin: string, get: Getter = defaultGetter, reach?: Reachability, now: () => number = Date.now): DashboardApi {
  const base = origin.replace(/\/$/, '');
  async function call<T>(path: string, mode: Mode, check: Check, endpoint: string = path): Promise<Envelope<T>> {
    let res: Got;
    try {
      res = await get(base + path);
    } catch {
      reach?.reportOffline(origin);
      throw new OfflineError('worker not reachable');
    }
    // Only data that passes every check counts as an update; any other answer only shows the server is up.
    const at = new Date(now()).toISOString();
    try {
      if (res.status !== 200) throw new Error(`worker answered ${res.status}`);
      let body: unknown;
      try {
        body = JSON.parse(res.body ?? '');
      } catch {
        throw new DataError('bad-shape', 'response is not JSON');
      }
      const env = checkEnvelope<T>(body, mode, check);
      reach?.reportOk(origin, at, endpoint);
      return env;
    } catch (e) {
      reach?.reportBad(origin, at, endpoint);
      throw e;
    }
  }
  return {
    status: (m) => call(PATHS.status(m), m, schemaFor('status', m)),
    funnel: (m) => call(PATHS.funnel(m), m, schemaFor('funnel', m)),
    decisions: (m) => call(PATHS.decisions(m), m, schemaFor('decisions', m)),
    position: (m) => call(PATHS.position(m), m, schemaFor('position', m)),
    // One key for every month, so a month the screen moved away from does not keep its old answer.
    calendar: (m, month) => call(PATHS.calendar(m, month), m, schemaFor('calendar', m), `/api/v1/${m}/calendar`),
    trades: (m) => call(PATHS.trades(m), m, schemaFor('trades', m)),
    charts: (m) => call(PATHS.charts(m), m, schemaFor('charts', m)),
    stats: (m) => call(PATHS.stats(m), m, schemaFor('stats', m)),
    discovered: (m) => call(PATHS.discovered(m), m, schemaFor('discovered', m)),
    backtestReport: () => call(PATHS.backtestReport(), 'backtest', reportData),
  };
}

/**
 * The saved server address (Snipe screen) points the app at the worker; without one the app shows
 * the offline state. The preview build reads the newest backtest report file from its release URL,
 * so real backtest results show with or without a server.
 */
export function apiFor(origin: string | null, reach?: Reachability): DashboardApi {
  const base = origin ? httpApi(origin, defaultGetter, reach) : offlineApi;
  return PREVIEW ? { ...base, backtestReport: () => loadReport() } : base;
}
