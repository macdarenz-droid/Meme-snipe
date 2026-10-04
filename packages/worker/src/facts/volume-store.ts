// The chain-volume days already verified (FACTS-1d review, supervisor ruling 2026-10-04): each day's two assets with
// their release tag, asset ids and sha256, kept in the worker's state dir so a restart reads only new days instead of
// the whole window. Public market data only (no keys, no personal data); the supervisor approved the shape. A record
// is trusted on load only after its text matches its sha256 again; a day whose release later shows another digest is
// marked tampered and never used again.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface StoredAsset {
  readonly id: number;
  readonly sha256: string;
  readonly text: string;
}

export interface StoredVolumeDay {
  readonly tag: string;
  readonly day: string;
  readonly hours: StoredAsset;
  readonly check: StoredAsset;
  readonly tampered: boolean;
}

export interface ChainVolumeStore {
  load(): StoredVolumeDay[];
  save(d: StoredVolumeDay): void;
}

/** The store's folder under the worker's state dir. */
export const CHAIN_VOLUME_DIR = 'chain-volume';

const isAsset = (v: unknown): v is StoredAsset => {
  const o = v as Record<string, unknown> | null;
  return typeof o === 'object' && o !== null && Number.isSafeInteger(o['id']) && typeof o['sha256'] === 'string' && typeof o['text'] === 'string';
};

/** One JSON file per release tag, written whole and renamed into place. An unreadable file is skipped (refetched). */
export const fileChainVolumeStore = (dir: string): ChainVolumeStore => ({
  load: () => {
    if (!existsSync(dir)) return [];
    const out: StoredVolumeDay[] = [];
    for (const f of readdirSync(dir).filter((n) => /^data-volume-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort()) {
      try {
        const v = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>;
        if (`${v['tag']}.json` !== f || typeof v['day'] !== 'string' || !isAsset(v['hours']) || !isAsset(v['check']) || typeof v['tampered'] !== 'boolean') continue;
        out.push(v as unknown as StoredVolumeDay);
      } catch {
        continue;
      }
    }
    return out;
  },
  save: (d) => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${d.tag}.json`);
    writeFileSync(`${path}.tmp`, `${JSON.stringify(d)}\n`);
    renameSync(`${path}.tmp`, path);
  },
});
