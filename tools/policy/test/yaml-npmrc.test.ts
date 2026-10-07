// Unit tests: the YAML reader for workflows (C01 red-team finding m1) and pnpm's files, and the .npmrc and engines
// check (finding m4).
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import type { Finding } from '../finding.ts';
import { checkNpmrc, iniUnsafe, parseNpmrc } from '../npmrc.ts';
import { readLock } from '../lockfile.ts';
import { readRepo } from '../repo.ts';
import { parseYaml, YamlError } from '../yaml.ts';
import { codes, goodSnapshot, REPO_ROOT } from './helpers.ts';

/** The parsed value with plain objects (the reader builds null-prototype maps). */
const yaml = (text: string): unknown => JSON.parse(JSON.stringify(parseYaml(text)));

describe('parseYaml', () => {
  it('reads mappings, sequences, compact items, scalars, flow sequences and comments', () => {
    const text = [
      '# comment',
      'name: ci # trailing',
      "on: [push, 'pull_request', \"a, b\", '#x']",
      'empty:',
      '"quoted key": \'it\'\'s\'',
      "'single': \"a\\tb\\\\c\\\"d\\/\\n\\r\\0\"",
      'nested:',
      '  list:',
      '  - a',
      '  -   b: 1',
      '      c: 2',
      '  -',
      '    d: 3',
      '  - # comment',
      '    e: 4',
      '  - x # trailing',
      '  flow: []',
      '  hash: a#b',
      '  url: https://x.example/y',
      '',
      'last: "#not a comment" # comment',
    ].join('\r\n');
    assert.deepEqual(yaml(text), {
      name: 'ci', on: ['push', 'pull_request', 'a, b', '#x'], empty: null, 'quoted key': "it's", single: 'a\tb\\c"d/\n\r\0',
      nested: { list: ['a', { b: '1', c: '2' }, { d: '3' }, { e: '4' }, 'x'], flow: [], hash: 'a#b', url: 'https://x.example/y' },
      last: '#not a comment',
    });
    assert.equal(parseYaml(''), null);
    assert.equal(parseYaml('# only a comment\n'), null);
    assert.deepEqual(yaml('- a\n- b: c\n'), ['a', { b: 'c' }]);
    assert.deepEqual(yaml('a:\nb: 1\n'), { a: null, b: '1' });
    assert.deepEqual(yaml('a: # comment\n  b: 1\n'), { a: { b: '1' } });
    assert.deepEqual(yaml('a:\n  -\nb: 1\n'), { a: [null], b: '1' });
    assert.deepEqual(yaml('a:\n  - \n'), { a: [null] });
  });

  it('reads literal and folded block scalars, with or without the final newline', () => {
    assert.deepEqual(yaml('run: |\n  echo a\n    indented # kept\n\n  echo b\n\nnext: x\n'), { run: 'echo a\n  indented # kept\n\necho b\n', next: 'x' });
    assert.deepEqual(yaml('run: |-\n  a\n  b\n'), { run: 'a\nb' });
    assert.deepEqual(yaml('run: >\n  a\n  b\n\n  c\n'), { run: 'a b\n\nc\n' });
    assert.deepEqual(yaml('run: >-\n  a\n  b\n'), { run: 'a b' });
    assert.deepEqual(yaml('run: |\nnext: x\n'), { run: '', next: 'x' });
    assert.deepEqual(yaml('- |\n  a\n- b\n'), ['a\n', 'b']);
    assert.throws(() => parseYaml('run: |\n    a\n  b: 1\n'), /unexpected content/);
  });

  it('fails closed on what it does not read', () => {
    const bad: Array<[string, RegExp]> = [
      ['a: &x 1\n', /unsupported YAML construct "&"/],
      ['a: *x\n', /unsupported YAML construct/],
      ['a: !!str 1\n', /unsupported YAML construct/],
      ['a: {b: 1}\n', /unsupported YAML construct/],
      ['a: |+\n  x\n', /unsupported YAML construct/],
      ['a: |2\n  x\n', /unsupported YAML construct/],
      ['---\na: 1\n', /expected "key: value"/],
      ['? a\n: b\n', /expected "key: value"/],
      ['a: 1\na: 2\n', /duplicate key "a"/],
      ['a: b: c\n', /may not contain ": "/],
      ['a: 1\n  b: 2\n', /unexpected content/],
      ['a:\n\tb: 1\n', /tab in indentation/],
      ['a: "x\n', /unterminated quoted scalar/],
      ["a: 'x' y\n", /unterminated or multi-line/],
      ['a: [x\n', /must end on its line/],
      ["a: ['x\n", /unterminated quoted scalar/],
      ['a: [[x]]\n', /unsupported flow sequence item/],
      ['a: [x, , y]\n', /unsupported flow sequence item/],
      ["a: ['x' y]\n", /expected ","/],
      ['a: "\\q"\n', /unsupported escape/],
      ['- a\nb: 1\n', /unexpected content/],
      ['a:\n- b\n- c\nd\n', /expected "key: value"/],
      ['"\\q": 1\n', /unsupported escape/],
    ];
    for (const [text, message] of bad) {
      assert.throws(() => parseYaml(text), (e: unknown) => e instanceof YamlError && message.test(e.message) && e.line > 0, text);
    }
  });

  it('reads one-line flow mappings only when asked (pnpm-lock.yaml), and keys with a colon not followed by a space', () => {
    const flow = (text: string): unknown => JSON.parse(JSON.stringify(parseYaml(text, { flowMappings: true })));
    assert.deepEqual(flow("a: {integrity: sha512-x==}\nb: {}\nc: {node: '>=18, <20', 'q k': \"v, w\", x: ^1 || >=2} # c\nd: { }\n"),
      { a: { integrity: 'sha512-x==' }, b: {}, c: { node: '>=18, <20', 'q k': 'v, w', x: '^1 || >=2' }, d: {} });
    assert.deepEqual(flow("tarball: {tarball: https://x.example/a.tgz, type: 'it''s'}\n"), { tarball: { tarball: 'https://x.example/a.tgz', type: "it's" } });
    assert.deepEqual(flow('has-postinstall@file:dep:\n  resolution: {directory: dep, type: directory}\n'),
      { 'has-postinstall@file:dep': { resolution: { directory: 'dep', type: 'directory' } } });
    assert.deepEqual(flow('a: {"b\\"c": 1}\n'), { a: { 'b"c': '1' } });
    const bad: Array<[string, RegExp]> = [
      ['a: {b: 1\n', /a flow mapping must end on its line/],
      ['a: {b: {c: 1}}\n', /nested flow collections/],
      ['a: {b: [1]}\n', /nested flow collections/],
      ['a: {b: 1, b: 2}\n', /duplicate key "b"/],
      ['a: {b}\n', /expected "key: value" in a flow mapping/],
      ['a: {b: 1, , c: 2}\n', /empty flow collection item/],
      ["a: {b: 'x}\n", /unterminated quoted scalar/],
      ["a: {b: 'x' y}\n", /unterminated quoted scalar/],
      ['a: {b: &x}\n', /unsupported YAML construct/],
    ];
    for (const [text, message] of bad) {
      assert.throws(() => parseYaml(text, { flowMappings: true }), (e: unknown) => e instanceof YamlError && message.test(e.message), text);
    }
  });

  it('reads the repository workflows, lockfile and workspace file', () => {
    const ci = parseYaml(readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8')) as { jobs: { check: { steps: unknown[] } } };
    assert.equal(ci.jobs.check.steps.length, 13);
    assert.ok('lock' in readLock(readFileSync(join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8')), 'pnpm-lock.yaml');
    assert.deepEqual((parseYaml(readFileSync(join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8')) as { packages: unknown }).packages, ['packages/*', 'apps/*', 'tools']);
    const guard = parseYaml(readFileSync(join(REPO_ROOT, '.github/workflows/guard.yml'), 'utf8')) as { on: Record<string, unknown> };
    assert.deepEqual(Object.keys(guard.on), ['pull_request_target']);
  });
});

describe('.npmrc and engines (C01 red-team m4)', () => {
  const npmrc = (text: string | null) => ({ ...goodSnapshot(), npmrc: text });

  it('passes the good fixture and this repository', () => {
    assert.deepEqual(checkNpmrc(goodSnapshot(), ['.npmrc', 'tools/policy/test/fixtures/good/.npmrc']), []);
    assert.deepEqual(checkNpmrc(readRepo(REPO_ROOT).snapshot, ['.npmrc']), []);
  });

  it('requires ignore-scripts=true and engine-strict=true', () => {
    assert.deepEqual(codes(checkNpmrc(npmrc(null), [])), ['E_NPMRC']);
    for (const text of ['engine-strict=true\n', 'ignore-scripts=false\nengine-strict=true\n', 'ignore-scripts=true\n', 'ignore-scripts = true\nengine-strict=1\n']) {
      assert.deepEqual(codes(checkNpmrc(npmrc(text), [])), ['E_NPMRC'], text);
    }
    assert.deepEqual(checkNpmrc(npmrc('; comment\n# comment\n\nignore-scripts = true\nengine-strict\n'), []), [], 'a bare key means true');
    assert.deepEqual(codes(checkNpmrc(npmrc('IGNORE-SCRIPTS=true\nengine-strict=true\n'), [])), ['E_NPMRC'], 'keys are read as written');
    assert.deepEqual(codes(checkNpmrc(npmrc('ignore-scripts=true\nengine-strict=true\nRegistry=https://evil.example/\n'), [])), ['E_NPMRC'], 'forbidden in any case');
  });

  it('refuses another registry, credentials, the script shell, Node options, git and duplicate keys', () => {
    for (const line of ['registry=https://evil.example/', '@solana:registry=https://evil.example/', '//registry.npmjs.org/:_authToken=x',
      '_auth=x', '@s:_password=x', 'script-shell=/bin/x', 'node-options=--require ./x.js', 'git=/tmp/git', 'ignore-scripts=true']) {
      const findings = checkNpmrc(npmrc(`ignore-scripts=true\nengine-strict=true\n${line}\n`), []);
      assert.deepEqual(codes(findings), ['E_NPMRC'], line);
    }
    assert.equal(parseNpmrc('a=1\na=2\n', []).get('a'), '2');
  });

  it('reads keys and values as npm\'s ini parser does and refuses a key not written plain (C01 review R4)', () => {
    const base = 'ignore-scripts=true\nengine-strict=true\n';
    for (const line of ['"ignore-scripts"=false', "'ignore-scripts'=false", '"registry"=https://example.invalid/', 'ignore-scripts;x=false',
      'ignore-scripts #x=false', '"node-version"=99.0.0', 'userconfig=./x', 'ignore-scripts[]=false', '[section]', 'IGNORE-SCRIPTS=false', 'ignore_scripts=false',
      '${KEY}=false', 'fund\rregistry=https://example.invalid/']) {
      const findings = checkNpmrc(npmrc(`${base}${line}\n`), []);
      assert.deepEqual(codes(findings), ['E_NPMRC'], line);
    }
    const findings: Finding[] = [];
    const settings = parseNpmrc('ignore-scripts=true\r\n"ignore-scripts"=false\rfund ; comment\n=skipped\nsave-exact = "true" # c\n', findings);
    assert.deepEqual([...settings], [['ignore-scripts', 'false'], ['fund', 'true'], ['save-exact', '"true"']], 'a quoted value followed by a comment keeps its quotes, as in ini');
    assert.deepEqual(findings.map((f) => `${f.file} ${f.message}`), [
      '.npmrc:2 ""ignore-scripts"" is not a plain key; npm reads it as "ignore-scripts"', '.npmrc:2 "ignore-scripts" is set twice',
      '.npmrc:3 "fund ; comment" is not a plain key; npm reads it as "fund"',
    ]);
    assert.deepEqual(parseNpmrc('a[]=1\n[s]\n', findings).get('a'), '1');
    assert.match(findings.at(-2)?.message ?? '', /npm reads it as "a" \(a list\)$/);
    assert.equal(findings.at(-1)?.message, 'sections are not allowed');
    assert.deepEqual(checkNpmrc(npmrc(`${base}save-exact=true\nfund=false\n`), []), [], 'the reviewed keys');
  });

  it('decodes a value like ini 5.0.0 unsafe', () => {
    const cases: Array<[string, string]> = [
      ['  plain  ', 'plain'], ['"quoted ; kept"', 'quoted ; kept'], ["'single'", 'single'], ['"bad json', '"bad json'], ['"\\u0041"', 'A'],
      ["'1'", '1'], ['"', '"'], ['a ; comment', 'a'], ['a # comment', 'a'], ['a\\;b\\#c\\\\d', 'a;b#c\\d'], ['a\\xb', 'a\\xb'], ['trailing\\', 'trailing\\'],
    ];
    for (const [raw, value] of cases) assert.equal(iniUnsafe(raw), value, raw);
  });

  it('allows only the root .npmrc', () => {
    assert.deepEqual(checkNpmrc(goodSnapshot(), ['packages/engine/.npmrc']).map((f) => f.file), ['packages/engine/.npmrc']);
  });

  it('requires .node-version to be exact and engines.node to be ">=<floor> <next major>" with the floor at or below it', () => {
    // Adapted from C01, which required the floor to equal .node-version: here the floor is the lowest release the code
    // needs, because pnpm refuses to install a project whose engines the running Node does not meet (npmrc.ts).
    const s = goodSnapshot();
    assert.deepEqual(codes(checkNpmrc({ ...s, nodeVersion: null }, [])), ['E_ENGINES']);
    assert.deepEqual(codes(checkNpmrc({ ...s, nodeVersion: 'v22' }, [])), ['E_ENGINES']);
    assert.deepEqual(checkNpmrc({ ...s, nodeVersion: '22.18.0' }, []), [], 'the floor itself');
    assert.deepEqual(codes(checkNpmrc({ ...s, nodeVersion: '22.17.9' }, [])), ['E_ENGINES'], 'CI below the floor');
    assert.deepEqual(codes(checkNpmrc({ ...s, nodeVersion: '23.0.0' }, [])), ['E_ENGINES'], 'another major');
    const t = goodSnapshot();
    const engines = (node: string | undefined): void => {
      const json = (t.manifests[0] as { json: { engines?: Record<string, string> } }).json;
      if (node === undefined) delete json.engines; else json.engines = { node };
    };
    for (const node of ['>=22.24.0 <23', '>=22.18.0', '>=22.18.0 <24', '>=21.0.0 <22', '>=22.18 <23', '^22.18.0', '>=22.18.0 <23 || >=24']) {
      engines(node);
      assert.deepEqual(codes(checkNpmrc(t, [])), ['E_ENGINES'], node);
    }
    engines('>=22.24.0 <23');
    assert.match(checkNpmrc(t, [])[0]?.message ?? '', /engines\.node must be ">=22\.x\.y <23" with x\.y\.z no higher than \.node-version 22\.23\.3; found ">=22\.24\.0 <23"/);
    engines(undefined);
    assert.match(checkNpmrc(t, [])[0]?.message ?? '', /found "undefined"/);
    assert.deepEqual(codes(checkNpmrc({ ...goodSnapshot(), manifests: [] }, [])), ['E_ENGINES']);
  });
});
