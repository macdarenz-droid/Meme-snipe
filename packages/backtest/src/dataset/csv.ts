// RFC 4180 CSV, as Go's encoding/csv writes it (DATA-1): quoted fields may hold commas, quotes ("") and newlines.

/** Calls `row` for every record in `text`, header included. */
export const parseCsv = (text: string, row: (fields: string[]) => void): void => {
  const n = text.length;
  let i = 0;
  while (i < n) {
    const fields: string[] = [];
    for (;;) {
      let value = '';
      if (text.charCodeAt(i) === 34) {
        i++;
        for (;;) {
          const q = text.indexOf('"', i);
          if (q < 0) throw new SyntaxError('unterminated quoted CSV field');
          value += text.slice(i, q);
          if (text.charCodeAt(q + 1) === 34) {
            value += '"';
            i = q + 2;
          } else {
            i = q + 1;
            break;
          }
        }
      } else {
        let j = i;
        while (j < n) {
          const c = text.charCodeAt(j);
          if (c === 44 || c === 10 || c === 13) break;
          j++;
        }
        value = text.slice(i, j);
        i = j;
      }
      fields.push(value);
      const c = text.charCodeAt(i);
      if (c === 44) {
        i++;
        continue;
      }
      if (c === 13) i++;
      if (text.charCodeAt(i) === 10) i++;
      break;
    }
    row(fields);
  }
};

/** Rows as objects keyed by the header, so readers never depend on column order. */
export const csvObjects = (text: string, each: (get: (column: string) => string) => void): void => {
  let header: Map<string, number> | null = null;
  let current: string[] = [];
  const get = (column: string): string => {
    const k = header!.get(column);
    if (k === undefined) throw new RangeError(`CSV has no column ${column}`);
    return current[k] ?? '';
  };
  parseCsv(text, (fields) => {
    if (header === null) {
      header = new Map(fields.map((f, k) => [f, k]));
      return;
    }
    current = fields;
    each(get);
  });
};

/** A column that may be missing in older files. */
export const hasColumn = (text: string, column: string): boolean => {
  const end = text.indexOf('\n');
  return (end < 0 ? text : text.slice(0, end)).replace('\r', '').split(',').includes(column);
};
