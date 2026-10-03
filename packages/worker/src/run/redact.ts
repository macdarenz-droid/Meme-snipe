// Every line the worker writes out (stdout, stderr, the journal, the recorder) passes through `redact`: the credential
// values read at start, and any key-shaped URL part (Helius `api-key=`, Alchemy `/v2/<key>`, a Telegram bot token), are
// replaced before the line leaves the process. Never a key in logs (AGENTS.md).
const MARK = '[redacted]';
const PATTERNS: readonly RegExp[] = [
  /([?&](?:api[-_]?key|apikey|key|token|access[-_]?token)=)[^&\s"'\\]+/gi,
  /(\.alchemy\.com\/v2\/)[^\s"'\\/?#]+/gi,
  /(\/bot)\d+:[A-Za-z0-9_-]+/g,
];

let values: readonly string[] = [];

/** The credential values to remove (longest first, so one that contains another goes whole). Short values are skipped. */
export const setSecretValues = (vs: readonly (string | null)[]): void => {
  values = [...new Set(vs.filter((v): v is string => v !== null && v.length >= 8))].sort((a, b) => b.length - a.length);
};

export const redact = (text: string): string => {
  let out = text;
  for (const v of values) if (out.includes(v)) out = out.split(v).join(MARK);
  for (const p of PATTERNS) out = out.replace(p, `$1${MARK}`);
  return out;
};
