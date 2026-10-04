import subprocess,sys
R='packages/core/src/gates/regime.ts'; W='packages/worker/src/facts/readers.ts'; V='packages/worker/src/facts/volume-hours.ts'; C='packages/core/src/config/validate.ts'
M=[
 (R,"Math.floor(at / DAY_MS) - p.volumeLagDays","Math.floor(at / DAY_MS) - 1"),
 (R,"Math.max(VOLUME_SERIES_START_DAY, lastDay - p.volumeWindowDays + 1)","lastDay - p.volumeWindowDays + 1"),
 (R,"Math.max(VOLUME_SERIES_START_DAY, lastDay - p.volumeWindowDays + 1)","VOLUME_SERIES_START_DAY"),
 (R,"if (lastDay - firstDay + 1 < p.volumeMinDays) {","if (false) {"),
 (R,"if (lastDay - firstDay + 1 < p.volumeMinDays) {","if (lastDay - firstDay < p.volumeMinDays) {"),
 (R,"if ((d.day + 1) * DAY_MS <= at) byDay","byDay"),
 (R,"if (x === undefined) return unknown('volume', 'curve-volume', 'not-covered', `no curve volume for UTC day ${day}`);","if (x === undefined) continue;"),
 (C,"need(regime.volumeLagDays >= 1,","need(true,"),
 (C,"regime.volumeMinDays >= 1 && ",""),
 (C," && regime.volumeMinDays <= regime.volumeWindowDays",""),
 (W,"      if (this.#volumeDays.has(day)) continue;\n",""),
 (W,"tried !== undefined && this.#o.timers.now() - tried < VOLUME_RETRY_MS","false"),
 (W,"Math.max(VOLUME_SERIES_START_DAY, today - regime.volumeLagDays - regime.volumeWindowDays + 1)","today - regime.volumeLagDays - regime.volumeWindowDays + 1"),
 (W,"Math.max(VOLUME_SERIES_START_DAY, today - regime.volumeLagDays - regime.volumeWindowDays + 1)","Math.max(VOLUME_SERIES_START_DAY, today - regime.volumeWindowDays + 1)"),
 (W,"day < today; day++","day <= today; day++"),
 (W,"if (sha256Hex(text) !== want) throw unknown('checksum does not match');",""),
 (W,"if (want === null) throw unknown(`${volumeSumsAsset(name)} does not list ${volumeHoursAsset(name)}`);",""),
 (W,"if (rows === null) throw unknown('malformed asset');",""),
 (W,"        this.#volumeDays.add(day);\n",""),
 (V,"if (lines[0] !== VOLUME_HOURS_HEADER) return null;",""),
 (V,"cells.length !== 2 || ",""),
 (V,"!U64.test(cells[0]!) || ",""),
 (V," || !U64.test(cells[1]!)",""),
 (V,"hourStartMs % HOUR_MS !== 0 || ",""),
 (V,"Math.floor(hourStartMs / DAY_MS) !== d || ",""),
 (V,"seen.has(hourStartMs) || ",""),
 (V," || lamports > U64_MAX",""),
 (V,"if (d === null) return null;",""),
 (V,"  if (lines.at(-1) === '') lines.pop();\n",""),
 (V,"dayName(ms / DAY_MS) === name ? ms / DAY_MS : null","ms / DAY_MS"),
 (V,"if (m !== null && m[2] === asset) return m[1]!;","if (m !== null) return m[1]!;"),
]
tests=['packages/core/test/gates/regime-volume.test.ts','packages/core/test/gates/regime.test.ts','packages/worker/test/volume-hours.test.ts','packages/core/test/config']
only=[16,17,21,27]
for i,(f,a,b) in enumerate(M):
    if i not in only: continue
    s=open(f).read()
    if s.count(a)!=1: print(i,'NOMATCH',a); continue
    open(f,'w').write(s.replace(a,b))
    r=subprocess.run(['npx','vitest','run',*tests],capture_output=True,text=True)
    open(f,'w').write(s)
    print(i,'KILLED' if r.returncode!=0 else 'SURVIVED',f.split('/')[-1],a[:70].replace('\n',' '),flush=True)
