import subprocess
V='packages/worker/src/facts/volume-hours.ts'; W='packages/worker/src/facts/readers.ts'; K='packages/core/src/facts/volume.ts'; S='packages/worker/src/facts/volume-store.ts'
M=[
 (V,"if (d === null || a['browser_download_url'] !== url) return null;","if (d === null) return null;"),
 (V,"if (d === null || a['browser_download_url'] !== url) return null;","if (a['browser_download_url'] !== url) return null;"),
 (V,"const DIGEST = /^sha256:([0-9a-f]{64})$/;","const DIGEST = /^sha256:([0-9a-fA-F]{64})$/;"),
 (V,"const DIGEST = /^sha256:([0-9a-f]{64})$/;","const DIGEST = /([0-9a-f]{64})$/;"),
 (W,"if (day === null || d.tag !== volumeRelease(d.day)) continue;","if (day === null) continue;"),
 (W,"        if (d.tampered) {\n          this.#volumeTampered.add(day);\n          continue;\n        }\n",""),
 (W,"if (day < first || day >= today) continue;",""),
 (W,"sha256Hex(d.hours.text) === d.hours.sha256 && ",""),
 (W," && sha256Hex(d.check.text) === d.check.sha256",""),
 (W," && volumeCheckPassed(d.check.text, d.day)",""),
 (W,"listed.set(tag, listed.has(tag) ? null : r)","listed.set(tag, r)"),
 (W,"if (v.length < 100) break;","break;"),
 (W,"if (!Array.isArray(v)) throw","if (false) throw"),
 (W,"refs !== null && refs.hours.id === d.hours.id && refs.hours.sha256 === d.hours.sha256 && refs.check.id === d.check.id && refs.check.sha256 === d.check.sha256","refs !== null"),
 (W," && refs.hours.sha256 === d.hours.sha256",""),
 (W,"      for (const r of rows) this.#ingest('github', RAW.volumeHour, { ...r, covered: false });\n",""),
 (W,"      src.store?.save({ ...d, tampered: true });\n",""),
 (W,"      src.alert?.(detail);\n",""),
 (W,"      this.#volumeTampered.add(day);\n      src.store",  "      src.store"),
 (W,"if (!listed.has(d.tag)) continue;","if (!listed.has(d.tag) || true) continue;"),
 (W,"if (sha256Hex(text) !== ref.sha256) throw","if (false) throw"),
 (W,"        src.store?.save(stored);\n",""),
 (W,"if (!listed.has(tag)) throw unknown('not published');",""),
 (K,"    if (cutDay > this.#trimDay) {","    if (false) {"),
 (K,"      if (cutHere) changed = this.#settle(cutDay) || changed;\n",""),
 (K,"prev !== undefined && (prev.lamports !== r.lamports || prev.covered !== r.covered) ? { ...r, covered: false } : r","r"),
 (K,"    return before !== sum;","    return true;"),
 (K,"        changed = this.#complete.delete(d) || changed;","        this.#complete.delete(d);"),
 (S,"if (`${v['tag']}.json` !== f || ","if ("),
 (S,"    writeFileSync(`${path}.tmp`, `${JSON.stringify(d)}\\n`);\n    renameSync(`${path}.tmp`, path);","    writeFileSync(`${path}.tmp`, `${JSON.stringify(d)}\\n`);"),
]
tests=['packages/worker/test/volume-hours.test.ts','packages/worker/test/facts-source.test.ts','packages/core/test/facts']
for i,(f,a,b) in enumerate(M):
    if i != 6: continue
    s=open(f).read()
    if s.count(a)!=1: print(i,'NOMATCH',a[:50]); continue
    open(f,'w').write(s.replace(a,b))
    r=subprocess.run(['npx','vitest','run',*tests],capture_output=True,text=True)
    open(f,'w').write(s)
    print(i,'KILLED' if r.returncode!=0 else 'SURVIVED',f.split('/')[-1],a[:60].replace('\n',' '),flush=True)
