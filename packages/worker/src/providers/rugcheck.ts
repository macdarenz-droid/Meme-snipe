// RugCheck report summaries (safety.md §7): keyless `GET /v1/tokens/{mint}/report/summary`, ~0.4 s on fresh
// tokens. A cross-check only, never the gate of record (§6.1), and a live-only veto (§16.3). The answer enters the
// timeline as an off-chain fact.
import type { Priority, Scheduler } from '../scheduler/scheduler.ts';
import type { Timers } from '../scheduler/timers.ts';
import { isAddress } from './canonical.ts';
import { type HttpClient, parseJson, ProviderError, send } from './http.ts';
import type { LiveFeed } from './live-feed.ts';

export const RUGCHECK_BASE = 'https://api.rugcheck.xyz';

export interface RugCheckOptions {
  readonly http: HttpClient;
  readonly scheduler: Scheduler;
  readonly feed: LiveFeed;
  readonly timers: Timers;
  readonly timeoutMs: number;
  readonly base?: string;
}

export class RugCheckClient {
  readonly #o: RugCheckOptions;

  constructor(o: RugCheckOptions) {
    this.#o = o;
  }

  async summary(mint: string, priority: Priority): Promise<unknown> {
    if (!isAddress(mint)) throw new RangeError('summary needs a base58 mint');
    const o = this.#o;
    return o.scheduler.run(priority, 0, async () => {
      const res = await send(o.http, 'rugcheck', 'report/summary', { method: 'GET', url: `${o.base ?? RUGCHECK_BASE}/v1/tokens/${mint}/report/summary`, timeoutMs: o.timeoutMs });
      if (res.status === 429) {
        o.scheduler.penalize();
        throw new ProviderError('rugcheck', 'rate_limited', 'report/summary rate limited', 429);
      }
      if (res.status !== 200) throw new ProviderError('rugcheck', 'http', `report/summary returned HTTP ${res.status}`, res.status);
      const report = parseJson('rugcheck', 'report/summary', res.text);
      o.feed.ingest('rugcheck', { type: 'offchain', key: `rugcheck:${mint}`, value: report }, { receivedAt: o.timers.now() });
      return report;
    });
  }
}
