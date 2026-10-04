import subprocess
K='packages/core/src/facts/volume.ts'; W='packages/worker/src/facts/readers.ts'; V='packages/worker/src/facts/volume-hours.ts'
M=[
 (K,"  if (lines.at(-1) === '') lines.pop();\n",""),
 (K,"lines.length !== HOURS_PER_DAY + 1 || ",""),
 (K," || lines[0] !== VOLUME_HOURS_HEADER",""),
 (K,"cells.length !== 3 || ",""),
 (K,"!U64.test(cells[1]!) || ",""),
 (K," || (cells[2] !== '0' && cells[2] !== '1')",""),
 (K,"cells[2] !== '0' && cells[2] !== '1'","cells[2] !== '0'"),
 (K,"if (cells[0] !== String(hourStartMs)) return null;",""),
 (K,"if (lamports > U64_MAX) return null;",""),
 (K,"covered: cells[2] === '1'","covered: true"),
 (K,".map((l) => l.replace(/\\r$/, ''))",""),
 (W,"if (!volumeCheckPassed(","if (false && !volumeCheckPassed("),
 (W,"if (rows === null) throw unknown('malformed asset');",""),
 (W,"      if (this.#volumeDays.has(day)) continue;\n",""),
 (W,"tried !== undefined && this.#o.timers.now() - tried < VOLUME_RETRY_MS","false"),
 (W,"Math.max(VOLUME_SERIES_START_DAY, today - regime.volumeLagDays - regime.volumeWindowDays + 1)","today - regime.volumeLagDays - regime.volumeWindowDays + 1"),
 (W,"Math.max(VOLUME_SERIES_START_DAY, today - regime.volumeLagDays - regime.volumeWindowDays + 1)","Math.max(VOLUME_SERIES_START_DAY, today - regime.volumeWindowDays + 1)"),
 (W,"day < today; day++","day <= today; day++"),
 (W,"        this.#volumeDays.add(day);\n",""),
 (V,"  } catch {\n    return false;\n  }","  } catch {\n    return true;\n  }"),
 (V,"  if (v === null) return false;\n",""),
 (V,"Array.isArray(o['mismatches']) && o['mismatches'].length === 0 && ",""),
 (V," && Array.isArray(o['problems']) && o['problems'].length === 0",""),
 (V,"o['mismatches'].length === 0","true"),
 (V,"o['problems'].length === 0","true"),
 (V,"dayName(ms / DAY_MS) === name ? ms / DAY_MS : null","ms / DAY_MS"),
]
tests=['packages/core/test/facts/volume-hours.test.ts','packages/worker/test/volume-hours.test.ts']
for i,(f,a,b) in enumerate(M):
    if i != 20: continue
    s=open(f).read()
    if s.count(a)!=1: print(i,'NOMATCH',a); continue
    open(f,'w').write(s.replace(a,b))
    r=subprocess.run(['npx','vitest','run',*tests],capture_output=True,text=True)
    open(f,'w').write(s)
    print(i,'KILLED' if r.returncode!=0 else 'SURVIVED',f.split('/')[-1],a[:60].replace('\n',' '),flush=True)
