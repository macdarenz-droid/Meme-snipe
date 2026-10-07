// .npmrc and the Node range (B-M30-01 logic 2; C01 review findings m4 and R4). pnpm 10 reads settings from .npmrc as
// well as pnpm-workspace.yaml (pnpm 10.x docs, settings.md). The root .npmrc must keep `ignore-scripts=true` (installs
// run no lifecycle scripts) and `engine-strict=true` (no package that claims an incompatible Node is installed), and
// may set only the reviewed keys of config.ts NPMRC_ALLOWED, so it cannot point pnpm at another registry, carry
// credentials, or change the script shell or the Node options. Keys and values are read as the ini parser reads them
// (ini 5.0.0, as C01 read it: lines split at CR or LF, quotes removed, a `[]` suffix, a `;` or `#` comment cut off),
// and a key must be written exactly as it is read, so `"ignore-scripts"=false` cannot pass as another key. No .npmrc
// other than the root's may exist. .node-version holds the exact Node version CI runs (the host's pinned release,
// ops/host/install-main.sh) and the root `engines.node` is `>=<floor> <<major + 1>`, with a floor on the same major
// and no higher than .node-version. C01 made the floor equal to .node-version; here the floor stays the lowest
// release the code needs (type stripping, Node 22.18), because pnpm refuses to install a project whose `engines` the
// running Node does not meet, and the agents' sessions run an older 22.x than the host.
import { DATA_DIRS, NPMRC_ALLOWED, NPMRC_REQUIRED } from './config.ts';
import { finding, type Finding } from './finding.ts';
import type { RepoSnapshot } from './repo.ts';

const FILE = '.npmrc';
/** A key as npm config names its settings: lower case, digits and hyphens. */
const PLAIN_KEY = /^[a-z][a-z0-9-]*$/;

/** ini 5.0.0 `unsafe`: trim; a quoted text loses its quotes (and is JSON-decoded); otherwise cut at the first unescaped ; or #. */
export function iniUnsafe(raw: string): string {
  const val = raw.trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    const inner = val.startsWith("'") ? val.slice(1, -1) : val;
    try {
      return String(JSON.parse(inner));
    } catch {
      return inner;
    }
  }
  let out = '';
  let escaped = false;
  for (const c of val) {
    if (escaped) {
      out += ';#\\'.includes(c) ? c : `\\${c}`;
      escaped = false;
    } else if (c === ';' || c === '#') {
      break;
    } else if (c === '\\') {
      escaped = true;
    } else {
      out += c;
    }
  }
  return (escaped ? `${out}\\` : out).trim();
}

/**
 * key=value settings of an .npmrc as npm reads them (a bare key means true). Duplicate keys are findings, as npm keeps
 * the last; so are sections, `[]` array keys and keys not written as npm reads them.
 */
export function parseNpmrc(text: string, findings: Finding[]): Map<string, string> {
  const settings = new Map<string, string>();
  text.split(/\r\n|\r|\n/).forEach((raw, i) => {
    const where = `${FILE}:${i + 1}`;
    if (/^\s*$/.test(raw) || /^\s*[;#]/.test(raw)) return;
    if (/^\[[^\]]*\]\s*$/.test(raw)) {
      findings.push(finding('E_NPMRC', where, 'sections are not allowed'));
      return;
    }
    const m = /^([^=]+)(=(.*))?$/.exec(raw);
    if (m === null) return;                                             // npm skips a line it cannot read as key=value
    const written = (m[1] as string).trim();
    let key = iniUnsafe(written);
    const list = key.length > 2 && key.endsWith('[]');
    if (list) key = key.slice(0, -2);
    if (list || written !== key || !PLAIN_KEY.test(key)) {
      findings.push(finding('E_NPMRC', where, `"${written}" is not a plain key; npm reads it as "${key}"${list ? ' (a list)' : ''}`));
    }
    if (settings.has(key)) findings.push(finding('E_NPMRC', where, `"${key}" is set twice`));
    settings.set(key, m[2] === undefined ? 'true' : iniUnsafe(m[3] as string));
  });
  return settings;
}

export function checkNpmrc(snapshot: RepoSnapshot, files: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    if (f.endsWith(`/${FILE}`) && !DATA_DIRS.some((d) => f.startsWith(d))) findings.push(finding('E_NPMRC', f, 'only the root .npmrc is allowed'));
  }
  if (snapshot.npmrc === null) {
    findings.push(finding('E_NPMRC', FILE, `the root .npmrc is missing; it must set ${Object.entries(NPMRC_REQUIRED).map(([k, v]) => `${k}=${v}`).join(' and ')}`));
  } else {
    const settings = parseNpmrc(snapshot.npmrc, findings);
    for (const [key, value] of Object.entries(NPMRC_REQUIRED)) {
      if (settings.get(key) !== value) findings.push(finding('E_NPMRC', FILE, `${key} must be ${value}`));
    }
    for (const key of settings.keys()) {
      if (!NPMRC_ALLOWED.includes(key)) findings.push(finding('E_NPMRC', FILE, `"${key}" is not allowed; the .npmrc may set only ${NPMRC_ALLOWED.join(', ')}`));
    }
  }
  const pinned = /^(\d+)\.(\d+)\.(\d+)$/.exec(snapshot.nodeVersion ?? '');
  const engines = snapshot.manifests.find((m) => m.dir === '')?.json.engines?.['node'];
  const range = /^>=(\d+)\.(\d+)\.(\d+) <(\d+)$/.exec(engines ?? '');
  if (pinned === null) {
    findings.push(finding('E_ENGINES', '.node-version', 'must hold the exact Node version CI uses (x.y.z)'));
  } else {
    const [major, minor, patch] = [1, 2, 3].map((i) => Number(pinned[i]));
    const floor = range === null ? null : [1, 2, 3].map((i) => Number(range[i]));
    const atOrBelow = floor !== null && (floor[1] as number) * 1e6 + (floor[2] as number) <= (minor as number) * 1e6 + (patch as number);
    if (range === null || floor?.[0] !== major || !atOrBelow || Number(range[4]) !== (major as number) + 1) {
      findings.push(finding('E_ENGINES', 'package.json', `engines.node must be ">=${major as number}.x.y <${(major as number) + 1}" with x.y.z no higher than .node-version ${snapshot.nodeVersion as string}; found "${String(engines)}"`));
    }
  }
  return findings;
}
