import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { TRIAL_POLICY } from '/home/user/Meme-snipe/packages/core/src/config/index.ts';
import { RAW, producerOptions } from '/home/user/Meme-snipe/packages/core/src/facts/index.ts';
import { FactWorld, offchain } from '/home/user/Meme-snipe/packages/core/test/facts/helpers.ts';
it('t', () => {
  const D0 = 20_654, DAY = 86_400_000, HOUR = 3_600_000;
  const w = new FactWorld(producerOptions(TRIAL_POLICY));
  const t0 = performance.now();
  for (let i = 0; i < 365 * 24; i++) w.push(offchain(RAW.volumeHour, { hourStartMs: D0 * DAY + i * HOUR, lamports: 1n, covered: true }, BigInt(1 + i), (D0 + 366) * DAY));
  writeFileSync('/tmp/claude-0/-home-user-Meme-snipe/d94e7d09-e45c-557f-8a81-c430595aae8d/scratchpad/ms.txt', String(Math.round(performance.now() - t0)));
}, 900_000);
