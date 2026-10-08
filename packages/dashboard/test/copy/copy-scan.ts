// Lexer for the copy guard, ported unchanged in behaviour from apps/web/test/copy-scan.ts (`stringLiterals`). The
// dashboard has no JSX (only .ts modules under packages/, E_SOURCE_TYPE), so its user-visible text is in string and
// template literals, which this reads straight from the TypeScript source. String-literal types are read too (stricter).

/** Lexes TypeScript or JavaScript source and returns the contents of its string and template literals. */
export function stringLiterals(js: string): string[] {
  const found: string[] = [];
  let i = 0;
  let lastSignificant = '';
  const n = js.length;

  const readQuoted = (q: string): string => {
    let s = '';
    i++;
    while (i < n && js[i] !== q) {
      if (js[i] === '\\') {
        s += js.slice(i, i + 2);
        i += 2;
        continue;
      }
      s += js[i];
      i++;
    }
    i++;
    return unescape(s);
  };

  const readTemplate = (): void => {
    i++;
    let s = '';
    while (i < n && js[i] !== '`') {
      if (js[i] === '\\') {
        s += js.slice(i, i + 2);
        i += 2;
      } else if (js[i] === '$' && js[i + 1] === '{') {
        found.push(unescape(s));
        s = '';
        i += 2;
        let depth = 1;
        const start = i;
        while (i < n && depth > 0) {
          const c = js[i];
          if (c === '{') depth++;
          else if (c === '}') depth--;
          else if (c === '"' || c === "'" || c === '`') {
            skipNested(c);
            continue;
          }
          i++;
        }
        found.push(...stringLiterals(js.slice(start, i - 1)));
      } else {
        s += js[i];
        i++;
      }
    }
    i++;
    found.push(unescape(s));
  };

  const skipNested = (q: string): void => {
    if (q === '`') {
      readTemplate();
      return;
    }
    found.push(readQuoted(q));
  };

  const readRegex = (): void => {
    i++;
    let inClass = false;
    while (i < n) {
      const c = js[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) break;
      i++;
    }
    i++;
    while (i < n && /[a-z]/i.test(js[i] ?? '')) i++;
  };

  while (i < n) {
    const c = js[i] ?? '';
    const next = js[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && js[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      const end = js.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
    } else if (c === '"' || c === "'") {
      found.push(readQuoted(c));
      lastSignificant = 'x';
    } else if (c === '`') {
      readTemplate();
      lastSignificant = 'x';
    } else if (c === '/' && (lastSignificant === '' || '(,=:[!&|?{};+-*%<>~^'.includes(lastSignificant))) {
      readRegex();
      lastSignificant = 'x';
    } else {
      if (!/\s/.test(c)) lastSignificant = /[\w$)\]]/.test(c) ? 'x' : c;
      i++;
    }
  }
  return found.filter((s) => s.trim() !== '');
}

function unescape(s: string): string {
  return s
    .replace(/\\u\{([0-9a-f]+)\}/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\u([0-9a-f]{4})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\(.)/g, '$1');
}
