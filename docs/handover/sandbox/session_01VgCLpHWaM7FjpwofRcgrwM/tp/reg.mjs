import { createServer } from 'node:http'; import { readFileSync, createReadStream } from 'node:fs'; import { createHash } from 'node:crypto';
const tgz = readFileSync('zz.tgz'); const sha = createHash('sha1').update(tgz).digest('hex'); const integrity = 'sha512-' + createHash('sha512').update(tgz).digest('base64');
const port = 48731, base = `http://127.0.0.1:${port}`;
const v = (ver, prov) => ({ name: 'zz', version: ver, dist: { tarball: `${base}/zz/-/zz.tgz`, shasum: sha, integrity, ...(prov ? { attestations: { provenance: { predicateType: 'https://slsa.dev/provenance/v1' } } } : {}) } });
const meta = { name: 'zz', 'dist-tags': { latest: '1.0.1' }, versions: { '1.0.0': v('1.0.0', true), '1.0.1': v('1.0.1', false) }, time: { created: '2026-01-01T00:00:00Z', modified: '2026-02-01T00:00:00Z', '1.0.0': '2026-01-01T00:00:00Z', '1.0.1': '2026-02-01T00:00:00Z' } };
createServer((q, r) => { if (q.url.startsWith('/zz/-/')) { r.writeHead(200); r.end(tgz); } else if (q.url === '/zz') { r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify(meta)); } else { r.writeHead(404); r.end('{}'); } }).listen(port);
