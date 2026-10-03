// Money written the way the owner writes it ("20", "0.015"), parsed exactly into integer units. No floats.
import { type Lamports, type MicroUsd, lamports, microUsd } from '../units/index.ts';

const scaled = (text: string, places: number, what: string): bigint => {
  const m = new RegExp(`^(\\d+)(?:\\.(\\d{1,${places}}))?$`).exec(text.trim());
  if (!m) throw new RangeError(`${what} must be a non-negative decimal with at most ${places} places, got "${text}"`);
  return BigInt(m[1] ?? '0') * 10n ** BigInt(places) + BigInt((m[2] ?? '').padEnd(places, '0'));
};

/** US dollars from a decimal string, e.g. usd('0.5'). */
export const usd = (text: string): MicroUsd => microUsd(scaled(text, 6, 'USD amount'));

/** SOL from a decimal string, e.g. sol('0.015'). */
export const sol = (text: string): Lamports => lamports(scaled(text, 9, 'SOL amount'));
