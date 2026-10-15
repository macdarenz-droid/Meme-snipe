// Disk management and verified-pull deletion (SPEC-A A-M07-03 logic 2 and 4, card Z08; ruling Z08-3). Adapted from
// Zeroed's recorder budget (`packages/worker/src/run/recorder-budget.ts`), whose budget pass deleted sealed recordings
// "whether or not they were uploaded" (MIGRATION A-M07-03): here nothing is ever deleted without a valid PullReceipt.
//
// Every `recorder.disk_check_ms` (60 s) on the filesystem holding the data folder, both rule sets apply and the
// stricter wins (ruling Z08-3: SPEC-A's percentages and DISKBUDGET ruling 2's byte figures):
// - pressure: used > `recorder.disk_warn_pct` (80%), or the recorder's segments above `recorder.max_bytes` (8 GiB), or
//   free below `recorder.min_free_bytes` (3 GiB) → delete the oldest segments that have a valid receipt whose sha256
//   equals the manifest's, until the pressure is gone;
// - retention: a receipted segment older than `recorder.retention_days` (7) is deleted; an unreceipted one is kept and
//   alerted on once a UTC day;
// - halt: still used > `recorder.disk_stop_pct` (95%), or still above the byte cap, or still below the free floor with
//   no receipted segment left → every stream but `universe_manifest` and `coverage` stops (critical alert); trading
//   is not touched (its journal writes have priority). Recording resumes when every limit is met again.
// Receipts are swept first (receipts.ts): anything in the folder that is not a valid receipt is deleted and alerted on
// (`security`, warning); a forged or foreign-key receipt never deletes a segment.
import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import type { KeyObject } from 'node:crypto';
import type { UnixMs } from '@bot/types';
import { hourOf, isDayName, isHourName, isManifest, manifestNameOf, parseSegmentName } from './manifest.ts';
import { verifyReceipt } from './receipt-sig.ts';
import { RECEIPT_CAPS, receiptFileName, sweepReceipts, type ReceiptCaps } from './receipts.ts';

export const GIB = 1_073_741_824;
export const DAY_MS = 86_400_000;

export interface DiskPolicy {
  warnPct: number; stopPct: number; maxBytes: number; minFreeBytes: number; retentionDays: number;
}
/** SPEC-A A-M07-03 config, with DISKBUDGET ruling 2's byte cap and free floor and ruling Z08-3's 7-day retention. */
export const DEFAULT_DISK_POLICY: DiskPolicy = { warnPct: 80, stopPct: 95, maxBytes: 8 * GIB, minFreeBytes: 3 * GIB, retentionDays: 7 };

export interface DiskUsage { totalBytes: number; freeBytes: number }
export type DiskLevel = 'info' | 'warning' | 'error' | 'critical';

export interface DiskDeps {
  dataDir: string;
  receiptsDir: string;
  /** The research public key (root-owned config, `recorder.research_pubkey`). */
  publicKey: KeyObject;
  policy: DiskPolicy;
  /** Total and free bytes of the filesystem holding `dataDir` (production: `fs.statfsSync`). */
  usage: () => DiskUsage;
  writer: { halt(reason: string): void; resume(): void; isHalted(): boolean; haltReason(): string | null; openPaths(): string[] };
  nowMs: () => UnixMs;
  log: (level: DiskLevel, code: string, fields: Record<string, string | number>) => void;
  fs?: Pick<typeof nodeFs, 'readdirSync' | 'readFileSync' | 'existsSync' | 'statSync' | 'unlinkSync' | 'rmdirSync'>;
  receiptCaps?: ReceiptCaps;
}

export interface Segment { path: string; sha256: string; bytes: number; hourStartMs: UnixMs }
export interface DiskCheck {
  usedPct: number; freeBytes: number; recorderBytes: number; receipted: number; unreceipted: number;
  deleted: string[]; halted: boolean; reasons: string[];
}

export function checkPolicy(p: DiskPolicy): string | null {
  if (!(Number.isInteger(p.warnPct) && p.warnPct >= 50 && p.warnPct < p.stopPct && p.stopPct <= 99)) return 'disk_warn_pct must be ≥ 50 and below disk_stop_pct (≤ 99)';
  if (!(Number.isSafeInteger(p.maxBytes) && p.maxBytes > 0 && Number.isSafeInteger(p.minFreeBytes) && p.minFreeBytes >= 0)) return 'max_bytes and min_free_bytes must be whole byte counts';
  if (!(Number.isInteger(p.retentionDays) && p.retentionDays >= 7 && p.retentionDays <= 365)) return 'retention_days must be 7-365';
  return null;
}

export class DiskManager {
  private readonly deps: DiskDeps;
  private readonly fs: NonNullable<DiskDeps['fs']>;
  private unpulledAlertDay: string | null = null;

  constructor(deps: DiskDeps) {
    const problem = checkPolicy(deps.policy);
    if (problem !== null) throw new RangeError(problem);
    this.deps = deps;
    this.fs = deps.fs ?? nodeFs;
  }

  /** Segments that have a manifest (closed), oldest first. The open hour's segments have none and are never touched. */
  segments(): { closed: Segment[]; totalBytes: number } {
    const closed: Segment[] = [];
    let totalBytes = 0;
    const root = this.deps.dataDir;
    if (!this.fs.existsSync(root)) return { closed, totalBytes };
    for (const day of (this.fs.readdirSync(root) as string[]).filter(isDayName).sort()) {
      for (const hour of (this.fs.readdirSync(join(root, day)) as string[]).filter(isHourName).sort()) {
        const dir = join(root, day, hour);
        for (const name of (this.fs.readdirSync(dir) as string[]).sort()) {
          const seg = parseSegmentName(name);
          if (seg === null) continue;
          const bytes = this.fs.statSync(join(dir, name)).size;
          totalBytes += bytes;
          const mPath = join(dir, manifestNameOf(name) as string);
          if (!this.fs.existsSync(mPath)) continue;
          let m: unknown;
          try {
            m = JSON.parse(this.fs.readFileSync(mPath, 'utf8') as string);
          } catch {
            continue;                                                     // unreadable manifest: never deleted
          }
          if (!isManifest(m)) continue;
          closed.push({ path: `${day}/${hour}/${name}`, sha256: m.sha256, bytes, hourStartMs: Date.parse(`${day}T${hour}:00:00Z`) as UnixMs });
        }
      }
    }
    return { closed, totalBytes };
  }

  /** Valid receipts by segment path (after the sweep removed everything else). */
  private receipts(): Map<string, string> {
    const sweep = sweepReceipts(this.deps.receiptsDir, (b) => verifyReceipt(b, this.deps.publicKey)?.path ?? null, this.deps.receiptCaps ?? RECEIPT_CAPS);
    if (sweep.alert) {
      this.deps.log('warning', 'M07.receipts_swept', {
        category: 'security', deleted: sweep.deleted.length, stuck: sweep.stuck.length, over_cap: sweep.overCap ? 1 : 0,
      });
    }
    const out = new Map<string, string>();
    for (const name of this.fs.readdirSync(this.deps.receiptsDir) as string[]) {
      let r = null;
      try {
        r = verifyReceipt(this.fs.readFileSync(join(this.deps.receiptsDir, name)) as Buffer, this.deps.publicKey);
      } catch {
        r = null;
      }
      if (r !== null && name === receiptFileName(r.path)) out.set(r.path, r.sha256);
    }
    return out;
  }

  private remove(seg: Segment): boolean {
    const root = this.deps.dataDir;
    try {
      this.fs.unlinkSync(join(root, seg.path));
      this.fs.unlinkSync(join(root, seg.path.slice(0, 13), manifestNameOf(seg.path.slice(14)) as string));
      const receipt = join(this.deps.receiptsDir, receiptFileName(seg.path));
      if (this.fs.existsSync(receipt)) this.fs.unlinkSync(receipt);
      try { this.fs.rmdirSync(join(root, seg.path.slice(0, 13))); } catch { /* not empty */ }
      this.deps.log('info', 'M07.segment_deleted', { path: seg.path, sha256: seg.sha256 });
      return true;
    } catch (e) {
      this.deps.log('error', 'M07.segment_delete_failed', { path: seg.path, code: typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : 'unknown' });
      return false;
    }
  }

  check(): DiskCheck {
    const p = this.deps.policy;
    const now = this.deps.nowMs();
    const receipts = this.receipts();
    const { closed, totalBytes } = this.segments();
    let recorderBytes = totalBytes;
    let { freeBytes } = this.deps.usage();
    const { totalBytes: fsTotal } = this.deps.usage();
    const usedPct = (): number => (fsTotal <= 0 ? 100 : ((fsTotal - freeBytes) * 100) / fsTotal);
    const pressured = (): boolean => usedPct() > p.warnPct || recorderBytes > p.maxBytes || freeBytes < p.minFreeBytes;
    // Ruling Z08-16: the current UTC hour and every file the writer has open are never touched, whatever a receipt says.
    const currentHour = hourOf(now).startMs;
    const open = new Set(this.deps.writer.openPaths());
    const pulled = (s: Segment): boolean => s.hourStartMs < currentHour && !open.has(s.path) && receipts.get(s.path) === s.sha256;
    const deleted: string[] = [];
    const drop = (s: Segment): void => {
      if (this.remove(s)) { deleted.push(s.path); recorderBytes -= s.bytes; freeBytes += s.bytes; }
    };
    const cutoff = now - p.retentionDays * DAY_MS;
    for (const s of closed) if (s.hourStartMs + 3_600_000 <= cutoff && pulled(s)) drop(s);
    for (const s of closed) {
      if (!pressured()) break;
      if (!deleted.includes(s.path) && pulled(s)) drop(s);
    }
    const left = closed.filter((s) => !deleted.includes(s.path));
    const unreceiptedOld = left.filter((s) => !pulled(s) && s.hourStartMs + 3_600_000 <= cutoff).length;
    const day = new Date(now).toISOString().slice(0, 10);
    if (unreceiptedOld > 0 && this.unpulledAlertDay !== day) {
      this.unpulledAlertDay = day;
      this.deps.log('warning', 'M07.unpulled_segments', { count: unreceiptedOld, retention_days: p.retentionDays });
    }
    const reasons: string[] = [];
    if (usedPct() > p.stopPct) reasons.push('disk_stop_pct');
    if (recorderBytes > p.maxBytes) reasons.push('max_bytes');
    if (freeBytes < p.minFreeBytes) reasons.push('min_free_bytes');
    if (reasons.length > 0) {
      if (!this.deps.writer.isHalted()) this.deps.writer.halt(`disk:${reasons.join(',')}`);
      this.deps.log('critical', 'M07.disk_full', { used_pct: Math.round(usedPct()), free_bytes: freeBytes, recorder_bytes: recorderBytes, reasons: reasons.join(',') });
    } else if (this.deps.writer.isHalted()) {
      // Ruling Z08-15: once every limit is met, a halt resumes, whether this check or a failed write made it. A write that
      // fails again halts again (one critical alert per episode).
      this.deps.log('info', 'M07.disk_ok_resume', { reason: this.deps.writer.haltReason() ?? 'unknown' });
      this.deps.writer.resume();
    }
    return {
      usedPct: usedPct(), freeBytes, recorderBytes, receipted: left.filter(pulled).length, unreceipted: left.filter((s) => !pulled(s)).length,
      deleted, halted: this.deps.writer.isHalted(), reasons,
    };
  }
}
