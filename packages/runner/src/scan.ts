// Secret scan for everything the fallback publishes (artifacts and logs are world-readable: public repo).
// Looks for each secret value and its common encodings, and for anything shaped like a Solana keypair file.
// Reports names and paths only, never a value.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gunzipSync } from 'node:zlib';

export interface Finding {
  readonly path: string;
  readonly what: string;
}

/** Values shorter than this are not scanned (too many false hits); every real key is far longer. */
export const MIN_SECRET_LENGTH = 8;

const variants = (value: string): string[] => {
  const b = Buffer.from(value, 'utf8');
  return [
    value,
    encodeURIComponent(value),
    b.toString('base64'),
    b.toString('base64').replace(/=+$/, ''),
    b.toString('base64url'),
    b.toString('hex'),
    JSON.stringify(value).slice(1, -1),
  ];
};

// A JSON array of 64 integers 0..255: the solana-keygen keypair file format.
const KEYPAIR = /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/g;

const keypairIn = (text: string): boolean => {
  for (const m of text.matchAll(KEYPAIR)) {
    const nums = (JSON.parse(m[0]) as number[]);
    if (nums.every((n) => n >= 0 && n <= 255)) return true;
  }
  return false;
};

export const scanBuffer = (path: string, data: Buffer, secrets: ReadonlyMap<string, string>): Finding[] => {
  const findings: Finding[] = [];
  const bodies: Buffer[] = [data];
  if (data.length > 2 && data[0] === 0x1f && data[1] === 0x8b) {
    try {
      bodies.push(gunzipSync(data));
    } catch {
      findings.push({ path, what: 'unreadable gzip (cannot be checked)' });
    }
  }
  for (const body of bodies) {
    for (const [name, value] of secrets) {
      if (value.length < MIN_SECRET_LENGTH) continue;
      if (variants(value).some((v) => body.includes(v))) findings.push({ path, what: name });
    }
    if (keypairIn(body.toString('latin1'))) findings.push({ path, what: 'keypair-shaped array' });
  }
  return findings;
};

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return e.isFile() ? [p] : [];
  });

export const scanPaths = (roots: readonly string[], secrets: ReadonlyMap<string, string>): Finding[] =>
  roots.flatMap((root) => {
    const files = statSync(root).isDirectory() ? walk(root) : [root];
    return files.flatMap((f) => scanBuffer(relative(process.cwd(), f) || f, readFileSync(f), secrets));
  });

/** Secret values from the environment, by name. Missing or empty ones are skipped. */
export const secretsFromEnv = (names: readonly string[], env: NodeJS.ProcessEnv = process.env): Map<string, string> => {
  const m = new Map<string, string>();
  for (const n of names) {
    const v = env[n]?.trim();
    if (v) m.set(n, v);
  }
  return m;
};
