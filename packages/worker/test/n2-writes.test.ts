// #159 review N2, re-rated blocking under the owner's golden rule: a short write on a nearly full disk must never rename
// a cut file over a good one (a cut deployers.jsonl could let H14 pass a deployer who rugged). Every write's count is
// checked, the temp file's size on disk must equal the bytes written, and a failure leaves the old file whole with no
// temp file left behind, for atomicWrite, the deployer state save and the deployer store rewrite.
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MarketEvent } from '../../core/src/engine/index.ts';
import { LOG_CREATE_PREFIX } from '../../core/src/gates/index.ts';
import { saveState, STATE_VERSION } from '../src/persist/index.ts';
import { DeployerStore } from '../src/run/deployer-store.ts';
import { typedText } from '../src/run/json.ts';
import { atomicWrite, type WriteFn } from '../src/run/state.ts';

const temp = (): string => mkdtempSync(join(tmpdir(), 'n2-'));

/** A disk that takes `room` bytes and then no more. */
const stops = (room: number): WriteFn => {
  let left = room;
  return (fd, buf, off, len) => {
    const n = Math.min(left, len);
    left -= n;
    return n === 0 ? 0 : writeSync(fd, buf, off, n);
  };
};
/** A write that reports every byte but puts only half of them on disk (what only the size check catches). */
const lies: WriteFn = (fd, buf, off, len) => {
  writeSync(fd, buf, off, Math.ceil(len / 2));
  return len;
};
const oneByte: WriteFn = (fd, buf, off) => writeSync(fd, buf, off, 1);

describe('atomicWrite', () => {
  it('a write that stops, or one that reports bytes it did not write, throws before the rename: the old file whole, no temp left', () => {
    const dir = temp();
    const p = join(dir, 'f.json');
    writeFileSync(p, 'old good content');
    expect(() => atomicWrite(p, 'new content that does not fit', stops(5))).toThrow(/short write: 5 of 29 bytes/);
    expect(readdirSync(dir)).toEqual(['f.json']); // the temp is removed by the failing call itself
    expect(() => atomicWrite(p, 'new content that does not fit', lies)).toThrow(/f\.json\.tmp holds 15 bytes, 29 were written/);
    expect(readdirSync(dir)).toEqual(['f.json']); // the temp is removed by the failing call itself
    expect(readFileSync(p, 'utf8')).toBe('old good content');
    expect(readdirSync(dir)).toEqual(['f.json']);
  });
  it('a write that progresses a byte at a time completes, multi-byte text intact', () => {
    const p = join(temp(), 'f.json');
    atomicWrite(p, 'é new 🙂', oneByte);
    expect(readFileSync(p, 'utf8')).toBe('é new 🙂');
  });
});

describe('the deployer state save', () => {
  const state = () => ({
    asOf: { slot: 10n, txIndex: 0, ixIndex: 0, receivedAt: 1_000 },
    index: { asOf: { slot: 10n, txIndex: 0, ixIndex: 0, receivedAt: 1_000 }, first: null, last: null, seeded: false, mints: [['Dev', [['Mint', 900]]]] as never, rugs: [], unjudged: [], createVias: [], lost: [] },
    labeller: { version: 'x' } as never,
    coverage: [],
  });
  it('a short or misreported write leaves the saved file as it was; a byte-at-a-time write saves', () => {
    const dir = temp();
    const p = join(dir, 'deployer-state.json');
    writeFileSync(p, 'the previous good save');
    expect(() => saveState(p, state(), stops(40))).toThrow(/short write/);
    expect(readdirSync(dir)).toEqual(['deployer-state.json']); // the temp is removed by the failing call itself
    expect(() => saveState(p, state(), lies)).toThrow(/holds \d+ bytes, \d+ were written/);
    expect(readdirSync(dir)).toEqual(['deployer-state.json']); // the temp is removed by the failing call itself
    expect(readFileSync(p, 'utf8')).toBe('the previous good save');
    expect(readdirSync(dir)).toEqual(['deployer-state.json']);
    saveState(p, state(), oneByte);
    expect(readFileSync(p, 'utf8')).toContain(`"version":${STATE_VERSION}`);
  });
});

describe('the deployer store rewrite', () => {
  const lines = Array.from({ length: 20 }, (_, k) => typedText({
    kind: 'market', id: `log:s${k}:00001`, moment: { slot: BigInt(k + 1), txIndex: 0, ixIndex: 0, receivedAt: 1_000 + k },
    key: `${LOG_CREATE_PREFIX}M${k}`, value: { event: { name: 'CreateEvent', program: 'pump', data: { mint: `M${k}`, creator: 'D', timestamp: 1n } } },
  } as MarketEvent)).join('\n') + '\n';
  it('a short or misreported write stops the load with the error and leaves deployers.jsonl whole; a byte-at-a-time write rewrites it', () => {
    const dir = temp();
    const path = join(dir, 'deployers.jsonl');
    writeFileSync(path, lines);
    expect(() => new DeployerStore(dir, stops(100)).load(0)).toThrow(/short write/);
    expect(readdirSync(dir)).toEqual(['deployers.jsonl']); // the temp is removed by the failing call itself
    expect(() => new DeployerStore(dir, lies).load(0)).toThrow(/deployers\.jsonl\.tmp holds \d+ bytes, \d+ were written/);
    expect(readdirSync(dir)).toEqual(['deployers.jsonl']); // the temp is removed by the failing call itself
    expect(readFileSync(path, 'utf8')).toBe(lines);
    expect(readdirSync(dir)).toEqual(['deployers.jsonl']);
    expect(new DeployerStore(dir, oneByte).load(0).creates).toHaveLength(20);
    expect(readFileSync(path, 'utf8')).toBe(lines);
  });
});
