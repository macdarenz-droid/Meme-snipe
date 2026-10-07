// RED TEAM C: a boot whose clock reads another UTC month (a VM restore, an RTC off by a month, an NTP step at the
// month's edge) must never wipe this month's provider credit count: the 70% halt (Alchemy) would start again from 0.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CreditBook } from '../../src/run/sources.ts';
import { tempState, virtualTimers } from '../worker-harness.ts';

const OCT_7 = Date.UTC(2026, 9, 7, 3);
const SEP_30 = Date.UTC(2026, 8, 30, 23, 59);

describe('red team C: credits.json across a clock step', () => {
  it('a boot with the clock one month back keeps October\'s count for the next boot on the right clock', () => {
    const dir = tempState();
    writeFileSync(join(dir, 'credits.json'), `${JSON.stringify({ month: '2026-10', used: { alchemy: 20_000_000 } })}\n`);
    // Boot 1: the clock reads 30 September (stepped back). Its own count may be separate, but October's must survive.
    const back = new CreditBook(dir, virtualTimers(SEP_30));
    back.flush();
    // Boot 2: the clock is right again (7 October).
    const right = new CreditBook(dir, virtualTimers(OCT_7));
    expect(right.used['alchemy'], `credits.json after the stepped boot: ${readFileSync(join(dir, 'credits.json'), 'utf8').trim()}`).toBe(20_000_000);
  });

  it('a boot with the clock a month ahead does not wipe the current month either', () => {
    const dir = tempState();
    writeFileSync(join(dir, 'credits.json'), `${JSON.stringify({ month: '2026-10', used: { alchemy: 20_000_000 } })}\n`);
    new CreditBook(dir, virtualTimers(Date.UTC(2026, 10, 2))).flush();
    expect(new CreditBook(dir, virtualTimers(OCT_7)).used['alchemy']).toBe(20_000_000);
  });
});
