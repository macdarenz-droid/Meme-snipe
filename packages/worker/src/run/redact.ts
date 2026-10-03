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

/** The text with every credential replaced, and how many replacements were made. */
export const redactCounted = (text: string): { readonly text: string; readonly count: number } => {
  let out = text;
  let count = 0;
  for (const v of values) {
    if (!out.includes(v)) continue;
    const parts = out.split(v);
    count += parts.length - 1;
    out = parts.join(MARK);
  }
  for (const p of PATTERNS) {
    out = out.replace(p, (_m, prefix: string) => {
      count++;
      return `${prefix}${MARK}`;
    });
  }
  return { text: out, count };
};

export const redact = (text: string): string => redactCounted(text).text;
