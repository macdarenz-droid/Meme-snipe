// Insider links from first-funder reads (H13, docs/ARCHITECTURE.md §16.3). One function for the live producer and the
// backtest supplement, so a cached lookup gives BT-2 exactly what live would have decided.
import type { FunderRead } from './raw.ts';

export interface InsiderLinks {
  /** First buyers the dev funded directly. */
  readonly funded: readonly string[];
  /** The dev's linked cluster: funded, plus first buyers funded by the dev's own first funder. */
  readonly devCluster: readonly string[];
  /** When the last read used was known (the latest funding time), null when none had one. */
  readonly knownAtMs: number | null;
}

/**
 * Links among `wallets` (the first buyers) from complete funder reads, or null when the dev or any first buyer has no
 * complete read: an incomplete lookup is never "not linked". A shared funder can be an exchange hot wallet, which
 * over-links; that only adds rejects.
 */
export const insiderLinks = (creator: string, wallets: readonly string[], funderOf: (wallet: string) => FunderRead | undefined): InsiderLinks | null => {
  const dev = funderOf(creator);
  const reads = wallets.map(funderOf);
  if (dev === undefined || !dev.complete || reads.some((r) => r === undefined || !r.complete)) return null;
  const devFunder = dev.funder;
  const others = wallets.filter((w) => w !== creator);
  const funded = others.filter((w) => funderOf(w)!.funder === creator).sort();
  const devCluster = others.filter((w) => {
    const f = funderOf(w)!.funder;
    return f === creator || (devFunder !== null && f === devFunder);
  }).sort();
  const times = [dev, ...reads].map((r) => r!.atMs).filter((t): t is number => t !== null);
  return { funded, devCluster, knownAtMs: times.length === 0 ? null : Math.max(...times) };
};
