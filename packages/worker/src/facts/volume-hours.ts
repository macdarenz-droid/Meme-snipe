// Regime chain volume, live (FACTS-1d, §6.4): DATA-1c publishes each UTC day as release `data-volume-DAY` with
// `volume-hours-DAY.csv` and `volume-check-DAY.json`. The reader lists releases through the GitHub API, checks each
// one's provenance, downloads both assets from github.com against their published sha256, and ingests the CSV's rows (core `parseVolumeHoursCsv`,
// shared with the backtest) as `read:chain-volume-hour`, so core's `dailyChainVolume` and the regime read one series in
// both. A day whose release is missing, whose check did not pass, or whose CSV is malformed ingests nothing: unknown.
import { createHash } from 'node:crypto';
import { DAY_MS } from '../../../core/src/config/time.ts';

/** The `YYYY-MM-DD` name of a UTC day number. */
export const dayName = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10);

/** The UTC day number of a `YYYY-MM-DD` name, or null when it is not a real date. */
export const dayNumber = (name: string): number | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) return null;
  const ms = Date.parse(`${name}T00:00:00Z`);
  return Number.isFinite(ms) && dayName(ms / DAY_MS) === name ? ms / DAY_MS : null;
};

export const volumeRelease = (day: string): string => `data-volume-${day}`;
export const volumeHoursAsset = (day: string): string => `volume-hours-${day}.csv`;
export const volumeCheckAsset = (day: string): string => `volume-check-${day}.json`;

/** The account GitHub Actions publishes as: DATA-1c's workflow creates the release and uploads both assets. */
export const ACTIONS_BOT = { login: 'github-actions[bot]', id: 41_898_282 } as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const byActions = (u: unknown): boolean => isObj(u) && u['login'] === ACTIONS_BOT.login && u['id'] === ACTIONS_BOT.id;

/** A release asset whose provenance held: its id, its sha256 (hex, from the API's `digest`) and where to download it. */
export interface VolumeAssetRef {
  readonly id: number;
  readonly sha256: string;
  readonly url: string;
}

export const VOLUME_TAG = /^data-volume-(\d{4}-\d{2}-\d{2})$/;
const DIGEST = /^sha256:([0-9a-f]{64})$/;

/**
 * Day `day`'s two assets from one release object of the GitHub API (`GET /repos/{o}/{r}/releases`), or null unless its
 * provenance holds: the exact tag, published by GitHub Actions, not a draft and a prerelease (as publish-volume.sh
 * makes it), and exactly one `volume-hours-DAY.csv` and one `volume-check-DAY.json`, each fully uploaded by GitHub
 * Actions, with a sha256 `digest` and a `browser_download_url` that is exactly this repository's download path for
 * it (`downloadBase`). Anyone else's release or asset could forge a series that turns the regime on, so anything else
 * leaves the day unknown.
 */
export const volumeReleaseAssets = (v: unknown, day: string, downloadBase: string): { readonly hours: VolumeAssetRef; readonly check: VolumeAssetRef } | null => {
  if (!isObj(v) || v['tag_name'] !== volumeRelease(day) || !byActions(v['author']) || v['draft'] !== false || v['prerelease'] !== true || !Array.isArray(v['assets'])) return null;
  const assets = v['assets'] as unknown[];
  const ref = (name: string): VolumeAssetRef | null => {
    const named = assets.filter((x) => isObj(x) && x['name'] === name);
    const a = named[0];
    if (named.length !== 1 || !isObj(a) || a['state'] !== 'uploaded' || !byActions(a['uploader']) || !Number.isSafeInteger(a['id']) || (a['id'] as number) <= 0) return null;
    const d = typeof a['digest'] === 'string' ? DIGEST.exec(a['digest']) : null;
    const url = `${downloadBase}/releases/download/${volumeRelease(day)}/${name}`;
    if (d === null || a['browser_download_url'] !== url) return null;
    return { id: a['id'] as number, sha256: d[1]!, url };
  };
  const hours = ref(volumeHoursAsset(day));
  const check = ref(volumeCheckAsset(day));
  return hours === null || check === null ? null : { hours, check };
};

export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** True only for DATA-1c's passing cross-check of day `day`: that day, 24 hours, `mismatches` and `problems` both empty. */
export const volumeCheckPassed = (text: string, day: string): boolean => {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return false;
  }
  if (!isObj(v)) return false;
  return v['day'] === day && v['hours'] === 24
    && Array.isArray(v['mismatches']) && v['mismatches'].length === 0 && Array.isArray(v['problems']) && v['problems'].length === 0;
};
