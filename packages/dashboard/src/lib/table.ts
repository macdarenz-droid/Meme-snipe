// DataTable logic (UI-T06, C23): exact sorting of view-model values (big integers as decimal strings, never through a
// JS number), the value-flash throttle, streamed-insert counting, keyboard row moves and resizing, column groups and
// the copy-as-JSON text.
import { parseDecimalStr, type Decimal } from './money.ts';

export type SortType = 'bigint' | 'decimal' | 'number' | 'text' | 'time';
export type CellValue = string | number | null | undefined;

const order = <V>(x: V, y: V): number => (x < y ? -1 : x > y ? 1 : 0);

/** Malformed values (a contract violation the schema check refuses upstream) sort after valid ones instead of throwing. */
function exact<V>(x: V | null, y: V | null, cmp: (p: V, q: V) => number): number {
  if (x === null || y === null) return x === null ? (y === null ? 0 : 1) : -1;
  return cmp(x, y);
}

const bigintOf = (v: string | number): bigint | null => (/^-?[0-9]+$/.test(String(v)) ? BigInt(v) : null);

function decimalOf(v: string | number): Decimal | null {
  try {
    return parseDecimalStr(String(v));
  } catch {
    return null;
  }
}

/** Two exact decimals compared at their common scale. */
const decimalOrder = (x: Decimal, y: Decimal): number => {
  const scale = Math.max(x.scale, y.scale);
  return order(x.units * 10n ** BigInt(scale - x.scale), y.units * 10n ** BigInt(scale - y.scale));
};

/** Ascending comparison of two present values of `type` (missing values are placed by the table: always last). */
export function compareValues(a: string | number, b: string | number, type: SortType): number {
  switch (type) {
    case 'bigint': return exact(bigintOf(a), bigintOf(b), order);
    case 'decimal': return exact(decimalOf(a), decimalOf(b), decimalOrder);
    case 'number': return order(Number(a), Number(b));
    case 'text': return order(String(a).toLowerCase(), String(b).toLowerCase());
    case 'time': return order(String(a), String(b));
  }
}

/** A cell may flash again only 1000 ms after its last flash (DS Motion: at most one flash per cell per second). */
export const FLASH_INTERVAL_MS = 1000;
/** How long a new row keeps its marker. */
export const NEW_ROW_MS = 2000;

export function shouldFlash(lastFlashMs: number | undefined, nowMs: number): boolean {
  return lastFlashMs === undefined || nowMs - lastFlashMs >= FLASH_INTERVAL_MS;
}

/**
 * How many ids of `next` are new against `prev` and sit above `anchor`. When the anchor row itself is gone, the view
 * anchors to the next row of `prev` after it that survives (or, when none follows, the last survivor before it) and
 * counts only the inserts above that row. No anchor, an anchor `prev` never had, or no surviving row counts nothing.
 */
export function insertedAbove(prev: readonly string[], next: readonly string[], anchor: string | null): number {
  if (anchor === null) return 0;
  const present = new Set(next);
  let target = anchor;
  if (!present.has(anchor)) {
    const at = prev.indexOf(anchor);
    if (at < 0) return 0;
    const survivor = prev.slice(at + 1).find((id) => present.has(id)) ?? prev.slice(0, at).findLast((id) => present.has(id));
    if (survivor === undefined) return 0;
    target = survivor;
  }
  const before = new Set(prev);
  return next.slice(0, next.indexOf(target)).filter((id) => !before.has(id)).length;
}

export type RowKey = 'ArrowDown' | 'ArrowUp' | 'j' | 'k' | 'J' | 'K' | 'Home' | 'End';

/** The row index after `key` among `count` rows (no wrap); null for other keys. */
export function nextRowIndex(index: number, key: string, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case 'ArrowDown': case 'j': case 'J': return Math.min(index + 1, count - 1);
    case 'ArrowUp': case 'k': case 'K': return Math.max(index - 1, 0);
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
}

/** A column width after a keyboard resize: arrows by 8 px (32 px with Shift), Home and End to the bounds; null for other keys. */
export function resizeByKey(size: number, key: string, shift: boolean, min: number, max: number): number | null {
  const step = shift ? 32 : 8;
  const next = key === 'ArrowLeft' ? size - step : key === 'ArrowRight' ? size + step : key === 'Home' ? min : key === 'End' ? max : null;
  return next === null ? null : Math.min(max, Math.max(min, next));
}

/** Consecutive runs of the same group label over the visible columns, for the grouped header row. */
export function columnGroups(groups: ReadonlyArray<string | undefined>): Array<{ label: string; span: number }> {
  const out: Array<{ label: string; span: number }> = [];
  for (const g of groups) {
    const label = g ?? '';
    const last = out.at(-1);
    if (last !== undefined && last.label === label) last.span += 1;
    else out.push({ label, span: 1 });
  }
  return out;
}

/** The raw view-model entity as JSON; a stray bigint is written as its decimal string, never as a number. */
export function rowCopyText(entity: unknown): string {
  return JSON.stringify(entity, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2);
}
