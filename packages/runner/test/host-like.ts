// The host's tabletop for tests: a stand-in for the hourly backup (the live state dir copied when the tabletop starts)
// and, from the `namedFrom`-th tabletop on, the backup's time. That time is a sampled moment the runner can compare
// (CI-1): under load the runner's own samples can slip, and a time placed on the wall clock could fall in a gap, which
// tests the gap rule (units) instead of the comparison these tests are about.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LocalControl, snapshotState, type Tabletop } from '../src/control.ts';
import type { Sample } from '../src/report.ts';
import { keptAt } from '../src/runner.ts';

export interface HostLikeOptions {
  readonly backupDir: string;
  readonly evidenceDir: string;
  /** The backup holds nothing (a restore that lost the state). */
  readonly restoreEmpty?: boolean;
  /** From this tabletop on (1-based), the backup's time is given; before it, unknown. */
  readonly namedFrom: number;
  readonly sampleMs: number;
  readonly windowMs: number;
}

export class HostLike extends LocalControl {
  readonly h: HostLikeOptions;
  readonly liveDir: string;
  readonly since = Date.now();
  calls = 0;
  constructor(o: ConstructorParameters<typeof LocalControl>[0], h: HostLikeOptions) {
    super(o);
    this.h = h;
    this.liveDir = o.stateDir!;
  }
  override async tabletop(o: { readonly restore: boolean; readonly restoreFrom?: string }): Promise<Tabletop> {
    this.calls += 1;
    if (!this.h.restoreEmpty) snapshotState(this.liveDir, this.h.backupDir);
    const t = await super.tabletop({ restore: o.restore, restoreFrom: this.h.backupDir });
    if (this.calls < this.h.namedFrom) return t;
    return { ...t, backup: { name: `zeroed-stand-in-${this.calls}.tar.age`, at: this.comparableMoment() ?? Date.now() - 50 } };
  }
  /** The latest sample (this control's own segment) whose backup window the runner's samples cover. */
  comparableMoment(): number | null {
    const path = join(this.h.evidenceDir, 'samples.jsonl');
    if (!existsSync(path)) return null;
    const samples = readFileSync(path, 'utf8').trim().split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Sample).filter((s) => s.t >= this.since);
    for (let i = samples.length - 1; i >= 0; i--) {
      if ('kept' in keptAt(samples, samples[i]!.t, this.h.sampleMs, this.h.windowMs)) return samples[i]!.t;
    }
    return null;
  }
}
