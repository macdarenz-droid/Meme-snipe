// Builds ops/install.sh from ops/host/install-main.sh plus every file under ops/host/files (written to the
// same path on the host), and writes its SHA-256 into ops/README.md. One self-contained script means the
// owner verifies one hash. `--check` changes nothing and fails if either file is out of date.
//   node ops/build-install.mjs [--check]
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ops = fileURLToPath(new URL('.', import.meta.url));
const filesDir = join(ops, 'host/files');
const MARK = '__ZEROED_FILE__';

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

export function build() {
  const main = readFileSync(join(ops, 'host/install-main.sh'), 'utf8');
  const blocks = walk(filesDir).map((path) => {
    const target = '/' + relative(filesDir, path).split('\\').join('/');
    const body = readFileSync(path, 'utf8');
    if (!body.endsWith('\n')) throw new Error(`${target}: must end with a newline`);
    if (body.split('\n').includes(MARK)) throw new Error(`${target}: contains the heredoc marker`);
    const mode = statSync(path).mode & 0o111 ? '0755' : '0644';
    return `install_file ${target} ${mode} <<'${MARK}'\n${body}${MARK}`;
  });
  if (!main.includes('\n# @@FILES@@\n')) throw new Error('install-main.sh: missing # @@FILES@@');
  return main.replace('\n# @@FILES@@\n', `\n${blocks.join('\n')}\n`);
}

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const HASH_LINE = /^(SHA-256 of `install\.sh`: `)[0-9a-f]{64}(`)$/m;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const script = build();
  const hash = sha256(script);
  const readmePath = join(ops, 'README.md');
  const readme = readFileSync(readmePath, 'utf8');
  if (!HASH_LINE.test(readme)) throw new Error('README.md: hash line not found');
  const nextReadme = readme.replace(HASH_LINE, `$1${hash}$2`).replaceAll(/(echo ')[0-9a-f]{64}(  install\.sh')/g, `$1${hash}$2`);
  if (process.argv.includes('--check')) {
    const current = readFileSync(join(ops, 'install.sh'), 'utf8');
    if (current !== script || readme !== nextReadme) {
      console.error('ops/install.sh or its hash in ops/README.md is out of date: run node ops/build-install.mjs');
      process.exit(1);
    }
    console.log(`install.sh up to date, sha256 ${hash}`);
  } else {
    writeFileSync(join(ops, 'install.sh'), script, { mode: 0o755 });
    writeFileSync(readmePath, nextReadme);
    console.log(`Wrote ops/install.sh, sha256 ${hash}`);
  }
}
