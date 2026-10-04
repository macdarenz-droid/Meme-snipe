import subprocess
V='packages/worker/src/facts/volume-hours.ts'; W='packages/worker/src/facts/readers.ts'
M=[
 (V,"u['login'] === ACTIONS_BOT.login && ",""),
 (V," && u['id'] === ACTIONS_BOT.id",""),
 (V,"v['tag_name'] !== volumeRelease(day) || ",""),
 (V,"!byActions(v['author']) || ",""),
 (V,"v['draft'] !== false || ",""),
 (V,"v['prerelease'] !== false || ",""),
 (V," || !Array.isArray(v['assets'])",""),
 (V,"named.length !== 1 || ",""),
 (V,"a['state'] !== 'uploaded' || ",""),
 (V,"!byActions(a['uploader']) || ",""),
 (V,"!Number.isSafeInteger(a['id']) || ",""),
 (V," || (a['id'] as number) <= 0",""),
 (V,"return hours === null || check === null ? null","return hours === null ? null"),
 (V,"return hours === null || check === null ? null","return check === null ? null"),
 (V,"  } catch {\n    return null;\n  }","  } catch {\n    return { hours: 1, check: 2 };\n  }"),
 (V,"v['day'] === day && ",""),
 (V," && v['hours'] === 24",""),
 (V,"  if (!isObj(v)) return false;\n",""),
 (W,"if (ids === null) throw unknown('release provenance does not hold');",""),
 (W,"if (limited) return false;",""),
 (W,"e instanceof ScheduleRefused || ",""),
 (W," || e.status === 403",""),
 (W,"if (!volumeCheckPassed(await asset(ids.check), name))","if (!volumeCheckPassed(await asset(ids.check), dayName(day - 1)) && false)"),
 (W,"`${base}/releases/assets/${id}`, priority, { accept: 'application/octet-stream' }","`${base}/releases/assets/${id}`, priority"),
 (W,"priority, json), name)","priority), name)"),
]
for i,(f,a,b) in enumerate(M):
    if i != 20: continue
    s=open(f).read()
    if s.count(a)!=1: print(i,'NOMATCH',a); continue
    open(f,'w').write(s.replace(a,b))
    r=subprocess.run(['npx','vitest','run','packages/worker/test/volume-hours.test.ts','packages/worker/test/facts-source.test.ts'],capture_output=True,text=True)
    open(f,'w').write(s)
    print(i,'KILLED' if r.returncode!=0 else 'SURVIVED',a[:60].replace('\n',' '),flush=True)
