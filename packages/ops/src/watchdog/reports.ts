// Writes a checked daily summary (summary.ts) to the private reports repository through the GitHub Contents API:
// reports/<day>.json and reports/latest.json. Fails closed before any write: the repository must be named, the token
// present, GitHub must say the repository is private, and it must not be this public code repository (the same check
// DATA-STORE uses for helius days). Every failure is a short reason that names no value; the caller turns it into the
// watchdog's "summary" alert. Plain fetch only, so it runs in the Worker and in Node tests.

/** This public code repository: never a destination, compared case-insensitively. */
export const CODE_REPO = 'macdarenz-droid/Meme-snipe';
const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const API = 'https://api.github.com';

export interface ReportsEnv {
  readonly REPORTS_TOKEN?: string | undefined;
  readonly DATA_REPO?: string | undefined;
  readonly GITHUB_API?: string | undefined;
}

export type WriteResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const base64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

/** The destination check alone: a named, private repository that is not this one. */
export const checkDestination = async (env: ReportsEnv, f: Fetch, timeoutMs: number): Promise<WriteResult & { readonly repo?: string }> => {
  const repo = env.DATA_REPO ?? '';
  const token = env.REPORTS_TOKEN ?? '';
  if (repo === '') return { ok: false, reason: 'DATA_REPO is not set' };
  if (!REPO_RE.test(repo)) return { ok: false, reason: 'DATA_REPO is not owner/name' };
  if (repo.toLowerCase() === CODE_REPO.toLowerCase()) return { ok: false, reason: 'DATA_REPO is the public code repository' };
  if (token === '') return { ok: false, reason: 'REPORTS_TOKEN is not set' };
  let res: Response;
  try {
    res = await f(`${env.GITHUB_API ?? API}/repos/${repo}`, { method: 'GET', headers: headers(token), signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return { ok: false, reason: 'repository check did not answer' };
  }
  if (res.status !== 200) return { ok: false, reason: `repository check HTTP ${res.status}` };
  let meta: { private?: unknown; full_name?: unknown };
  try {
    meta = (await res.json()) as typeof meta;
  } catch {
    return { ok: false, reason: 'repository check unreadable' };
  }
  const full = typeof meta.full_name === 'string' ? meta.full_name : '';
  // A rename or transfer redirects the API to another name: only the exact repository named counts.
  if (full.toLowerCase() !== repo.toLowerCase()) return { ok: false, reason: 'repository check names another repository' };
  if (full.toLowerCase() === CODE_REPO.toLowerCase()) return { ok: false, reason: 'DATA_REPO is the public code repository' };
  if (meta.private !== true) return { ok: false, reason: 'DATA_REPO is not private' };
  return { ok: true, repo: full };
};

const headers = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'zeroed-watchdog',
});

/** Creates or replaces one file. */
const put = async (env: ReportsEnv, repo: string, path: string, text: string, message: string, f: Fetch, timeoutMs: number): Promise<WriteResult> => {
  const token = env.REPORTS_TOKEN ?? '';
  const url = `${env.GITHUB_API ?? API}/repos/${repo}/contents/${path}`;
  let sha: string | undefined;
  try {
    const cur = await f(url, { method: 'GET', headers: headers(token), signal: AbortSignal.timeout(timeoutMs) });
    if (cur.status === 200) {
      const j = (await cur.json()) as { sha?: unknown };
      if (typeof j.sha === 'string') sha = j.sha;
    } else if (cur.status !== 404) {
      return { ok: false, reason: `read ${path} HTTP ${cur.status}` };
    }
    const res = await f(url, {
      method: 'PUT',
      headers: { ...headers(token), 'content-type': 'application/json' },
      body: JSON.stringify({ message, content: base64(text), ...(sha === undefined ? {} : { sha }) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.status === 200 || res.status === 201 ? { ok: true } : { ok: false, reason: `write ${path} HTTP ${res.status}` };
  } catch {
    return { ok: false, reason: `write ${path} did not answer` };
  }
};

/** Checks the destination, then writes the day's file and (when `latest`) latest.json. Nothing is written when the check fails. */
export const writeReports = async (env: ReportsEnv, day: string, text: string, f: Fetch, timeoutMs = 10_000, latest = true): Promise<WriteResult> => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false, reason: 'bad day' };
  const dest = await checkDestination(env, f, timeoutMs);
  if (!dest.ok || dest.repo === undefined) return dest.ok ? { ok: false, reason: 'no repository' } : dest;
  const body = text.endsWith('\n') ? text : `${text}\n`;
  const a = await put(env, dest.repo, `reports/${day}.json`, body, `Summary ${day}`, f, timeoutMs);
  if (!a.ok || !latest) return a;
  return put(env, dest.repo, 'reports/latest.json', body, `Latest summary (${day})`, f, timeoutMs);
};
