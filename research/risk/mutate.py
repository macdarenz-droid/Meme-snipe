"""Single-edit mutation testing for packages/core/src/risk (RISK-1 review evidence). Standard library only.

python3 research/risk/mutate.py [--only FILE:LINE,...] [--workers N] [--out DIR]
Each mutant changes one line of evaluate.ts, melbourne.ts or reservation.ts; it is killed when
`vitest run packages/core/test/risk` fails. Survivors go to DIR/survivors.txt (file:line | operator | line).
Workers run in copies of the repo under DIR (default: a temporary folder).
"""
import os, re, subprocess, sys, shutil, json
from concurrent.futures import ThreadPoolExecutor

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
HERE = os.environ.get('MUTATE_DIR') or os.path.join(__import__('tempfile').gettempdir(), 'risk-mutants')
FILES = ['packages/core/src/risk/evaluate.ts', 'packages/core/src/risk/melbourne.ts', 'packages/core/src/risk/reservation.ts']
TEST = 'packages/core/test/risk'

def skip(line):
    t = line.strip()
    return (not t or t.startswith('//') or t.startswith('*') or t.startswith('/*') or t.startswith('import ')
            or t.startswith('export {') or t.startswith('export type') or t.startswith('export interface')
            or t.startswith('readonly ') or t.startswith('type ') or t.startswith('|') or 'from \'' in t)

def code_part(line):
    # Strip a trailing // comment and string/template contents so operators inside text are not mutated.
    i = line.find('//')
    return line if i < 0 else line[:i]

OPS = []
def op(name, pattern, repl):
    OPS.append((name, re.compile(pattern), repl))

op('lt->le', r'(?<=\s)<(?=\s)', '<=')
op('le->lt', r'(?<=\s)<=(?=\s)', '<')
op('gt->ge', r'(?<=\s)>(?=\s)', '>=')
op('ge->gt', r'(?<=\s)>=(?=\s)', '>')
op('eq->ne', r'===', '!==')
op('ne->eq', r'!==', '===')
op('and->or', r'&&', '||')
op('or->and', r'\|\|', '&&')
op('ceil->floor', r"'ceil'", "'floor'")
op('floor->ceil', r"'floor'", "'ceil'")
op('minus->plus', r'(?<=\s)-(?=\s)', '+')
op('plus->minus', r'(?<=\s)\+(?=\s)', '-')
op('max->min', r'\bmaxBig\(', 'minBig(')
op('min->max', r'\bminBig\(', 'maxBig(')
op('Mathmax->min', r'\bMath\.max\(', 'Math.min(')
op('drop-minus-term', r'\s-\s[A-Za-z_][\w.]*(\([^()]*\))?', '')
op('drop-plus-term', r'\s\+\s[A-Za-z_][\w.]*(\([^()]*\))?', '')
op('drop-or-term', r'\s\|\|\s[^|&)]+?(?=\)|\s\|\||\s&&|;|$)', '')
op('drop-and-term', r'\s&&\s[^|&)]+?(?=\)|\s\|\||\s&&|;|$)', '')
op('not-drop', r'!(?=[A-Za-z(])', '')
op('if-false', r'\bif \(', 'if (false && ')
op('if-true', r'\bif \(', 'if (true || ')
op('0n->1n', r'\b0n\b', '1n')
op('1->2', r'(?<![\w.])1(?![\w.n])', '2')
op('true->false', r'\btrue\b', 'false')
op('false->true', r'\bfalse\b', 'true')

def mutants():
    out = []
    for f in FILES:
        lines = open(os.path.join(REPO, f)).read().split('\n')
        for i, line in enumerate(lines):
            if skip(line):
                continue
            code = code_part(line)
            # mask string literals and templates
            masked = re.sub(r"'[^']*'|`[^`]*`", lambda m: '\0' * len(m.group(0)), code)
            for name, rx, repl in OPS:
                pat_on = masked if name not in ('ceil->floor', 'floor->ceil') else code
                for m in rx.finditer(pat_on):
                    new = line[:m.start()] + (repl if isinstance(repl, str) else repl(m)) + line[m.end():]
                    if new != line:
                        out.append((f, i + 1, name, new))
            # delete a whole statement line
            t = line.strip()
            if t.endswith(';') and not t.startswith(('return', 'const ', 'let ', 'export const')) and '=>' not in t:
                out.append((f, i + 1, 'delete-line', ''))
            if re.match(r'\s*(if|else if) \(.*\) \w', line) and t.endswith(';'):
                out.append((f, i + 1, 'delete-if-stmt', ''))
    return out

def worker_dir(k):
    d = os.path.join(HERE, f'mut-{k}')
    if not os.path.exists(d):
        os.makedirs(d)
        subprocess.run(f"tar -C {REPO} --exclude=.git -cf - . | tar -C {d} -xf -", shell=True, check=True)
    for f in FILES:
        shutil.copy2(os.path.join(REPO, f), os.path.join(d, f))
    shutil.rmtree(os.path.join(d, TEST))
    shutil.copytree(os.path.join(REPO, TEST), os.path.join(d, TEST))
    return d

def run_one(args):
    k, (f, ln, name, new) = args
    d = os.path.join(HERE, f'mut-{k}')
    path = os.path.join(d, f)
    orig = open(os.path.join(REPO, f)).read().split('\n')
    lines = list(orig)
    lines[ln - 1] = new
    open(path, 'w').write('\n'.join(lines))
    try:
        r = subprocess.run(['npx', 'vitest', 'run', TEST, '--bail=1', '--reporter=dot'], cwd=d, capture_output=True, timeout=90)
        killed = r.returncode != 0
    except subprocess.TimeoutExpired:
        killed = True
    open(path, 'w').write('\n'.join(orig))
    return (f, ln, name, new, killed)

if __name__ == '__main__':
    workers = 4
    only = None
    a = sys.argv[1:]
    if '--workers' in a: workers = int(a[a.index('--workers') + 1])
    if '--only' in a: only = set(a[a.index('--only') + 1].split(','))
    if '--out' in a: HERE = a[a.index('--out') + 1]
    os.makedirs(HERE, exist_ok=True)
    ms = mutants()
    if only:
        ms = [m for m in ms if f"{m[0].split('/')[-1]}:{m[1]}" in only]
    print(f'{len(ms)} mutants', flush=True)
    for k in range(workers):
        worker_dir(k)
    from queue import Queue
    import threading
    q = Queue()
    for m in ms: q.put(m)
    results = []
    lock = threading.Lock()
    def loop(k):
        while True:
            try: m = q.get_nowait()
            except Exception: return
            res = run_one((k, m))
            with lock:
                results.append(res)
                if len(results) % 25 == 0: print(len(results), flush=True)
    ts = [threading.Thread(target=loop, args=(k,)) for k in range(workers)]
    for t in ts: t.start()
    for t in ts: t.join()
    surv = sorted([r for r in results if not r[4]], key=lambda r: (r[0], r[1]))
    with open(os.path.join(HERE, 'survivors.txt'), 'w') as fh:
        for f, ln, name, new, _ in surv:
            fh.write(f"{f.split('/')[-1]}:{ln} | {name} | {new.strip()}\n")
    print(f'killed {len(results) - len(surv)} / {len(results)}; survivors {len(surv)}')
