// HOLD-COMPACT: a held log notification keeps only the lines the log reader uses, each at its own index. The reader
// must give exactly the same answer, refusals included, for every input.
import { describe, expect, it } from 'vitest';
import { PUMP_AMM_PROGRAM, PUMP_PROGRAM } from '../../src/chain/index.ts';
import { compactLogs, logEvents } from '../../src/chain/transaction.ts';
import { TRANSACTIONS } from './helpers.ts';

const read = (logs: readonly string[], err: unknown = null): string => {
  try {
    return JSON.stringify(logEvents(logs, err), (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
  } catch (e) {
    return `throws ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`;
  }
};

describe('compactLogs keeps every answer of the log reader', () => {
  it('on every recorded transaction: the same events, at the same indices, from far fewer lines', () => {
    let kept = 0;
    let total = 0;
    for (const t of TRANSACTIONS) {
      const logs = t.base64.meta.logMessages ?? [];
      const c = compactLogs(logs);
      expect(c.length, t.label).toBe(logs.length);
      expect(read(c, t.base64.meta.err), t.label).toBe(read(logs, t.base64.meta.err));
      c.forEach((l, i) => expect(l === '' || l === logs[i], `${t.label} line ${i}`).toBe(true));
      kept += c.filter((l) => l !== '').length;
      total += logs.length;
    }
    expect(kept * 5).toBeLessThan(total);
  });

  it('over 5,000 random call trees, odd lines and broken ones: the same events or the same refusal', () => {
    let x = 0x1234567;
    const r = (n: number): number => {
      x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
      return x % n;
    };
    // Real event bytes of both programs, so kept data lines decode, plus one that does not decode.
    const data = TRANSACTIONS.flatMap((t) => (t.base64.meta.logMessages ?? []).filter((l) => l.startsWith('Program data: ')));
    expect(data.length).toBeGreaterThan(2);
    const programs = [PUMP_PROGRAM, PUMP_AMM_PROGRAM, 'ComputeBudget111111111111111111111111111111', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', '11111111111111111111111111111111'];
    let changed = 0;
    for (let k = 0; k < 5_000; k++) {
      const lines: string[] = [];
      const call = (depth: number): void => {
        const p = programs[r(programs.length)]!;
        lines.push(`Program ${p} invoke [${depth}]`);
        for (let n = r(4); n > 0; n--) {
          const kind = r(10);
          if (kind < 3 && depth < 4) call(depth + 1);
          else if (kind < 6) lines.push(data[r(data.length)]!);
          else if (kind < 7) lines.push('Program data: AAAA AAAA');
          else if (kind < 9) lines.push('Program log: Instruction: Buy');
          else lines.push(`Program ${p} consumed 1234 of 200000 compute units`);
        }
        lines.push(r(12) === 0 ? `Program ${p} failed: custom program error: 0x1` : `Program ${p} success`);
      };
      for (let n = 1 + r(3); n > 0; n--) call(1);
      // Sometimes broken as the node can deliver it: cut, a wrong depth, an unclosed call, a stray close.
      const breakage = r(10);
      if (breakage === 0) lines.splice(r(lines.length), 0, 'Log truncated');
      else if (breakage === 1) lines.splice(r(lines.length), 0, `Program ${programs[r(programs.length)]} invoke [9]`);
      else if (breakage === 2) lines.splice(r(lines.length), 1);
      else if (breakage === 3) lines.splice(r(lines.length), 0, `Program ${programs[r(programs.length)]} success`);
      const err = r(20) === 0 ? { InstructionError: [0, 'Custom'] } : null;
      const c = compactLogs(lines);
      expect(c.length).toBe(lines.length);
      expect(read(c, err), `tree ${k}: ${JSON.stringify(lines)}`).toBe(read(lines, err));
      if (c !== lines) changed++;
    }
    // Most trees were compacted, not passed through.
    expect(changed).toBeGreaterThan(3_000);
  });

  it('a log it would refuse or stop on comes back unchanged', () => {
    const p = PUMP_AMM_PROGRAM;
    for (const logs of [
      [`Program ${p} invoke [1]`, 'Log truncated'],
      [`Program ${p} invoke [2]`, `Program ${p} success`],
      [`Program ${p} invoke [1]`, 'Program log: x'],
      [`Program ${p} success`],
      // Cut inside a call that still closes: passed through as cut, never compacted.
      [`Program ${p} invoke [1]`, 'Log truncated', `Program ${p} success`],
    ]) expect(compactLogs(logs)).toBe(logs);
  });

  it('keeps nothing of a call with no pump or PumpSwap event data, its own data lines included', () => {
    const token = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    const logs = [`Program ${token} invoke [1]`, 'Program data: AAAA', 'Program log: x', `Program ${token} success`];
    expect(compactLogs(logs)).toEqual(['', '', '', '']);
  });
});
