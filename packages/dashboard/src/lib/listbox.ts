// Listbox logic for the Select / Combobox (UI-T04, C09): filtering, active-option moves and selection. Disabled
// options stay reachable (WAI-ARIA APG: a disabled option may receive the active descendant), so the reason can be
// read; they cannot be chosen.

export interface ListOption { value: string; label: string; disabled?: boolean; reason?: string }

/** Options whose label contains `query` (case-insensitive, trimmed); all of them for an empty query. */
export function filterOptions(options: readonly ListOption[], query: string): ListOption[] {
  const q = query.trim().toLowerCase();
  return q === '' ? [...options] : options.filter((o) => o.label.toLowerCase().includes(q));
}

export type MoveKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End';

/** The active index after `key` among `count` options (no wrap); -1 when there are none. */
export function moveActive(index: number, key: MoveKey, count: number): number {
  if (count === 0) return -1;
  switch (key) {
    case 'Home': return 0;
    case 'End': return count - 1;
    case 'ArrowDown': return Math.min(index + 1, count - 1);
    case 'ArrowUp': return index < 0 ? count - 1 : Math.max(index - 1, 0);
  }
}

/** The selection after choosing `value`: replaced (single) or toggled (multi). */
export function chooseValue(selected: readonly string[], value: string, multi: boolean): string[] {
  if (!multi) return [value];
  return selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value];
}

/** The option to make active on opening: the first selected one, else the first (`last` for ArrowUp and End). */
export function openingIndex(options: readonly ListOption[], selected: readonly string[], last: boolean): number {
  if (options.length === 0) return -1;
  const i = options.findIndex((o) => selected.includes(o.value));
  return i >= 0 ? i : last ? options.length - 1 : 0;
}
