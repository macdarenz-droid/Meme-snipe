// RESTART-ALERT: where a crash happened, safe to send off the host. The error's name, the first stack frame inside
// packages/ (file:line), and the kind of event an engine step was handling. Never the error's message: an RPC error can
// carry a URL with its API key, and a query string can carry anything.

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const FRAME = /packages\/[A-Za-z0-9_.\/-]+\.[cm]?[jt]s:\d+/;
/** A key segment that names a mint, a signature or an address is left out: the kind is enough. */
const ID = /^[1-9A-HJ-NP-Za-km-z]{32,}$/;

/** The kind of an engine event from its key (`logs:pump:CreateEvent:<mint>` → `logs:pump:CreateEvent`), at most 3 parts. */
export const eventKind = (key: string): string =>
  key.split(':').filter((s) => s !== '' && s.length <= 24 && !ID.test(s) && /^[A-Za-z0-9_.\/-]+$/.test(s)).slice(0, 3).join(':') || 'unnamed';

export const crashSite = (e: unknown, during?: string | null): string => {
  const name = e instanceof Error && NAME.test(e.name) ? e.name : e instanceof Error ? 'Error' : 'non-error';
  const stack = e instanceof Error && typeof e.stack === 'string' ? e.stack : '';
  // The stack's first line is "<name>: <message>": only the frames after it are searched.
  const frame = stack.split('\n').slice(1).map((l) => FRAME.exec(l)?.[0]).find((f) => f !== undefined) ?? 'no frame in packages/';
  return `${name} at ${frame}${during ? ` during ${eventKind(during)}` : ''}`;
};
