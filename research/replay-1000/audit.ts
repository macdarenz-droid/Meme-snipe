// REPLAY-1000 lookahead audit: every frame the bot recorded (everything it was handed: slots, log sightings,
// transactions, read answers) is checked against the moment it was received. A frame that names a slot produced
// after its receipt time (on the replay's slot clock) is data from the future and fails the audit.
//   node research/replay-1000/audit.ts <state-dir>
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { loadIndex } from './coins.ts';
import { SlotClock } from './world/chain.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A slot written as the recorder writes bigints ({"$n": "..."}), or a plain number. */
const slotOf = (v: unknown): number | null => (isObj(v) && typeof v['$n'] === 'string' ? Number(v['$n']) : typeof v === 'number' ? v : null);

/** Every chain slot a frame body names. */
export const slotsIn = (body: Obj): number[] => {
  const out: number[] = [];
  const t = body['type'];
  if (t === 'slot' || t === 'seen' || t === 'logs') {
    const s = slotOf(body['slot']);
    if (s !== null) out.push(s);
  } else if (t === 'tx' && isObj(body['record'])) {
    const s = slotOf(body['record']['slot']);
    if (s !== null) out.push(s);
  } else if ((t === 'offchain' || t === 'fact') && isObj(body['value'])) {
    const v = body['value'];
    for (const k of ['slot', 'mintSlot']) {
      const s = slotOf(v[k]);
      if (s !== null) out.push(s);
    }
  }
  return out;
};

export interface AuditResult {
  readonly frames: number;
  readonly checked: number;
  readonly future: { seq: number; receivedAt: number; type: string; key: string | null; slot: number; producedAt: number }[];
}

export const auditRecording = (stateDir: string, clock: SlotClock): AuditResult => {
  const root = join(stateDir, 'recorder');
  let frames = 0;
  let checked = 0;
  const future: AuditResult['future'] = [];
  for (const boot of readdirSync(root)) {
    const days = join(root, boot, 'days');
    for (const day of readdirSync(days).sort()) {
      for (const f of readdirSync(join(days, day)).filter((x) => x.startsWith('frames-')).sort()) {
        const p = join(days, day, f);
        const text = f.endsWith('.zst') ? zstdDecompressSync(readFileSync(p)).toString('utf8') : readFileSync(p, 'utf8');
        for (const line of text.split('\n')) {
          if (line === '') continue;
          frames++;
          const fr = JSON.parse(line) as { seq: number; receivedAt: number; body: Obj };
          const slots = slotsIn(fr.body);
          if (slots.length > 0) checked++;
          for (const s of slots) {
            const producedAt = clock.timeOf(s);
            if (producedAt > fr.receivedAt) future.push({ seq: fr.seq, receivedAt: fr.receivedAt, type: String(fr.body['type']), key: typeof fr.body['key'] === 'string' ? fr.body['key'] : null, slot: s, producedAt });
          }
        }
      }
    }
  }
  return { frames, checked, future };
};

const main = () => {
  const r = auditRecording(process.argv[2]!, new SlotClock(loadIndex()));
  console.log(JSON.stringify({ frames: r.frames, checked: r.checked, future: r.future.length, first: r.future.slice(0, 5) }, null, 1));
  process.exit(r.future.length === 0 ? 0 : 1);
};

if (process.argv[1] === new URL(import.meta.url).pathname) main();
