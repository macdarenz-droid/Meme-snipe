import { useEffect, useState } from 'react';
import { MINT_RE } from '../api/schemas.ts';

/**
 * A token's Pump.fun page (APP-TRADE 6), built only from a mint that passes the API's mint check (base58, 32–44
 * characters), so the URL can hold nothing else; never from free text or a URL the server sends. Else null: no button.
 */
export const pumpFunUrl = (mint: string): string | null => (MINT_RE.test(mint) ? `https://pump.fun/coin/${mint}` : null);

/**
 * Copies text: the Clipboard API, else the older copy command on a hidden field (some webviews block the API).
 * True only when one of them reports success, so the app never says "Copied" for a copy that did not happen.
 */
export async function copyText(text: string, page?: Document): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Blocked or refused: try the copy command below.
  }
  try {
    const doc = page ?? document;
    const field = doc.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    doc.body.appendChild(field);
    field.select();
    const ok = doc.execCommand('copy');
    field.remove();
    return ok;
  } catch {
    return false;
  }
}

interface Stoppable { stopPropagation(): void }

/** The copy button's click: stops at the button (the row keeps its own action), copies the full mint, reports. */
export const copyClick = (mint: string, copy: (text: string) => Promise<boolean>, done: (ok: boolean) => void) => async (e: Stoppable): Promise<void> => {
  e.stopPropagation();
  done(await copy(mint));
};

/** The link's click: stops at the link; the browser follows it. */
export const stopRow = (e: Stoppable): void => e.stopPropagation();

/** How long "Copied" or "Copy failed" stays. */
export const COPY_NOTE_MS = 2_000;

const COPY = 'M7 7V4.5A1.5 1.5 0 0 1 8.5 3h7A1.5 1.5 0 0 1 17 4.5v7a1.5 1.5 0 0 1-1.5 1.5H13M4.5 7h7A1.5 1.5 0 0 1 13 8.5v7a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 15.5v-7A1.5 1.5 0 0 1 4.5 7z';
const OPEN = 'M11 3h6v6M17 3l-8 8M14 12v3.5a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 3 15.5v-8A1.5 1.5 0 0 1 4.5 6H8';

const Icon = ({ d }: { d: string }) => (
  <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
    <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/**
 * "Copy address" (the full mint) and "Open in Pump.fun" for a token. Clicks stop here, so a row that opens its own
 * detail does not also open. The link leaves the app: the Android webview hands any address off the app's own host to
 * the phone (the browser or the Pump.fun app), as with the Solscan links.
 */
export function TokenActions({ mint, copy = copyText }: { mint: string; copy?: (text: string) => Promise<boolean> }) {
  const [note, setNote] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (note === 'idle') return;
    const t = setTimeout(() => setNote('idle'), COPY_NOTE_MS);
    return () => clearTimeout(t);
  }, [note]);
  const url = pumpFunUrl(mint);
  if (url === null) return null;
  const onCopy = copyClick(mint, copy, (ok) => setNote(ok ? 'copied' : 'failed'));
  return (
    <span className="token-actions">
      <button type="button" className="icon-button token-action" aria-label="Copy address" onClick={(e) => void onCopy(e)}>
        <Icon d={COPY} />
      </button>
      <a className="icon-button token-action" href={url} target="_blank" rel="noopener noreferrer" aria-label="Open in Pump.fun" onClick={stopRow}>
        <Icon d={OPEN} />
      </a>
      <span role="status" className={note === 'failed' ? 'loss small' : 'muted small'}>
        {note === 'copied' ? 'Copied' : note === 'failed' ? 'Copy failed' : ''}
      </span>
    </span>
  );
}
