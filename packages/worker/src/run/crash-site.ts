// RESTART-ALERT: where a crash happened, safe to send off the host. The error's name, the first stack frame inside
// packages/ (file:line), and the kind of event an engine step was handling. Never the error's message: an RPC error can
// carry a URL with its API key, and a query string can carry anything.

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const FRAME = /packages\/[A-Za-z0-9_.\/-]+\.[cm]?[jt]s:\d+/;

/**
 * The kind of an engine event from its key (`logs:pump:CreateEvent:<mint>` → `logs:pump:CreateEvent`), at most 3 parts.
 * A segment over 24 characters is left out: mints, signatures and addresses are 32 or more, and the kind is enough.
 */
export const eventKind = (key: string): string =>
  key.split(':').filter((s) => s !== '' && s.length <= 24 && /^[A-Za-z0-9_.\/-]+$/.test(s)).slice(0, 3).join(':') || 'unnamed';

export const crashSite = (e: unknown, during?: string | null): string => {
  const name = e instanceof Error && NAME.test(e.name) ? e.name : e instanceof Error ? 'Error' : 'non-error';
  const stack = e instanceof Error && typeof e.stack === 'string' ? e.stack : '';
  // The stack starts with "<name>: <message>", and a message can span lines and imitate frames: that head is cut off
  // exactly, and only V8 frame lines ("    at …") after it are searched.
  const head = e instanceof Error ? (e.message === '' ? String(e.name) : `${String(e.name)}: ${e.message}`) : '';
  const frames = stack.startsWith(head) ? stack.slice(head.length) : '';
  const frame = frames.split('\n').slice(1).filter((l) => /^\s+at /.test(l)).map((l) => FRAME.exec(l)?.[0]).find((f) => f !== undefined) ?? 'no frame in packages/';
  return `${name} at ${frame}${during ? ` during ${eventKind(during)}` : ''}`;
};
