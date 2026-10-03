import type { BacktestReport, Envelope } from './contract.ts';
import { DataError } from './modes.ts';
import { parseReport } from './reportSchema.ts';

/** The newest report, published by the backtest workflow as a release asset. */
export const REPORT_URL = 'https://github.com/macdarenz-droid/Meme-snipe/releases/download/backtest/latest-report.json';

/** What a getter returns: an HTTP status and, for 200, the body as text. */
export interface Got {
  status: number;
  body?: string;
}

export type Getter = (url: string) => Promise<Got>;

/** Longest wait for an answer before a request counts as failed (an unreachable tailnet address can hang). */
export const REQUEST_TIMEOUT_MS = 8_000;

/**
 * Used for the report file and for the worker. GitHub answers a release download with a 302 to release-assets.githubusercontent.com
 * and neither response carries Access-Control-Allow-Origin, so a WebView fetch is
 * blocked by CORS. Inside the Android app the request goes through Capacitor's native
 * HTTP (part of @capacitor/core, loaded only there); in a browser it uses fetch. The same
 * path reaches the worker on the tailnet without the worker having to send CORS headers.
 */
export async function defaultGetter(url: string): Promise<Got> {
  const cap = (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  if (cap?.isNativePlatform?.()) {
    const { CapacitorHttp } = await import('@capacitor/core');
    const res = await CapacitorHttp.get({ url, responseType: 'text', headers: { accept: 'application/json' }, connectTimeout: REQUEST_TIMEOUT_MS, readTimeout: REQUEST_TIMEOUT_MS });
    return { status: res.status, body: typeof res.data === 'string' ? res.data : JSON.stringify(res.data) };
  }
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  return res.ok ? { status: res.status, body: await res.text() } : { status: res.status };
}

/**
 * Loads the report file. 404 means no backtest yet (null). A network failure,
 * any other status, unreadable JSON or a file that fails the strict
 * schema throws, and the screen shows an error, never part of the file.
 */
export async function loadReport(url: string = REPORT_URL, get: Getter = defaultGetter): Promise<Envelope<BacktestReport | null>> {
  let got: Got;
  try {
    got = await get(url);
  } catch {
    // Not "offline": the report is a file, not the worker. The screen says it could not load.
    throw new Error('report not reachable');
  }
  if (got.status === 404) return { mode: 'backtest', asOf: new Date().toISOString(), data: null };
  if (got.status !== 200) throw new Error(`report answered ${got.status}`);
  let body: unknown;
  try {
    body = JSON.parse(got.body ?? '');
  } catch {
    throw new DataError('bad-shape', 'report is not JSON');
  }
  const report = parseReport(body);
  return { mode: 'backtest', asOf: report.generatedAt, data: report };
}
