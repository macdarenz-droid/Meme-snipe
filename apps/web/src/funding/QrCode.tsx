import { useMemo } from 'react';
import { encodeQr } from './qr.ts';

const QUIET = 4;

/**
 * Black modules on white with a four-module quiet zone, in both themes: scanners
 * read dark-on-light, so the code does not follow the theme.
 */
export function QrCode({ text, label }: { text: string; label: string }) {
  const { size, path } = useMemo(() => {
    const m = encodeQr(text);
    let d = '';
    m.forEach((row, y) => {
      let x = 0;
      while (x < row.length) {
        if (!row[x]) {
          x++;
          continue;
        }
        let w = 1;
        while (row[x + w]) w++;
        d += `M${x + QUIET} ${y + QUIET}h${w}v1h-${w}z`;
        x += w;
      }
    });
    return { size: m.length + QUIET * 2, path: d };
  }, [text]);
  return (
    <svg className="qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#FFFFFF" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
