import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AsOfStore, SimClock, compareMoments } from '../../core/src/engine/index.ts';
import { DeployerIndex, DAY_MS, evaluateHardRejects, createsCoverage, rugCheckFromMs } from '../../core/src/gates/index.ts';
import { RUG_CHECK_CONFIG, RUG_CONFIG } from '../../core/src/config/index.ts';
import { DeployerChecks } from '../src/facts/deployer-checks.ts';
import { DEV, MINT, NOW, SLOT, T, deps, passingFacts, request, session } from '../../core/test/gates/world.ts';
import { DeployerStore, liveWatchToClose } from '../src/run/deployer-store.ts';
import { buildSeed } from '../src/seed/seed.ts';

const root = mkdtempSync('/tmp/ops149-facts-fixture-');
const at = (slot: bigint, ms: number, ix=0) => ({slot, txIndex:0, ixIndex:ix, receivedAt:ms});
const ev = (id: string,key: string,value: unknown,moment: ReturnType<typeof at>) => ({kind:'market' as const,id,key,value,moment});
const starts = [
  ev('creates-start','coverage:creates:start',{value:{fromSlot:SLOT-6_000_000n,via:'logs:creates'},source:'worker',backfilled:false,seq:0},at(SLOT-6_000_000n,T-30*DAY_MS)),
  ev('rugs-start','coverage:rugs:start',{value:{fromSlot:SLOT-6_000_000n,via:'rug-labeller'},source:'worker',backfilled:false,seq:0},at(SLOT-5_999_999n,T-30*DAY_MS+1)),
];
const savedCreate=ev('saved-create','pump:CreateEvent:Old',{event:{name:'CreateEvent',program:'pump',data:{mint:'Old',creator:DEV,timestamp:BigInt((T-DAY_MS)/1000)}}},at(SLOT-100n,T-10_000));
const lostRug=ev('lost-rug','rug:Old',{mint:'Old',creator:DEV,rule:'collapse'},at(SLOT-100n,T-9_999,1));
function ctx(idx: DeployerIndex, coverage: typeof starts) {
  const f=passingFacts(); f.delete('coverage:creates:start'); f.delete('coverage:rugs:start');
  const rows=[...[...f].map(([key,v])=>({key,value:v.value,moment:v.moment})),...coverage].sort((a,b)=>compareMoments(a.moment,b.moment));
  const clock=new SimClock(at(0n,Number.MIN_SAFE_INTEGER)); const store=new AsOfStore(clock);
  for (const e of rows) {clock.advanceTo(e.moment);store.record(e.key,e.value,e.moment,e.key);}
  clock.advanceTo(NOW);
  return {now:NOW,observedTip:NOW.slot,lookup:(k:string,a:any)=>store.lookup(k,a),history:(k:string,f:number,t:any)=>store.history(k,f,t),deployers:idx};
}
function h14(idx: DeployerIndex, coverage: typeof starts) {
  return evaluateHardRejects(ctx(idx,coverage),deps('live',session(),'RUG-1'),request(),{only:['H14']});
}
describe('durable deployer-loss coverage', () => {
it('keeps real H14 unknown for zero-byte/torn rug loss, lost same-slot creates and a successful retry', async () => {
try {
  for (const part of [0,15]) {
    const d=mkdtempSync(join(root,'case-'));let full=false;
    const store=new DeployerStore(d,undefined,{append:(p,t)=>{if(full){if(part)appendFileSync(p,t.slice(0,part));throw Object.assign(new Error('ENOSPC'),{code:'ENOSPC'});}appendFileSync(p,t);}});
    for(const e of [...starts,savedCreate])store.keep(e);
    const original=new DeployerIndex();for(const e of [...starts,savedCreate,lostRug])original.observe(e);
    full=true;store.keep(lostRug);assert.equal(store.failing,true);
    // A new instance models death before a successful append; no clean stop saves the index.
    const restartedStore=new DeployerStore(d);const saved=restartedStore.load(T-15*DAY_MS);
    assert.equal(restartedStore.failing,true);assert.equal(saved.last!.slot,lostRug.moment.slot);assert.equal(saved.rugs.length,0);assert.equal(saved.coverage.filter(e=>e.key.endsWith(':gap')&&(e.value as any).value.toSlot===null).length,2);
    const liveStart=at(saved.last!.slot,T-1000,99);
    const fill=await buildSeed({days:[],untilSlot:saved.last!.slot,asOf:NOW,fill:{fromSlot:saved.last!.slot+1n,fromMs:saved.last!.ms,close:liveWatchToClose(saved.coverage)!,liveStart}});
    assert.equal(fill.report.gaps.length,0);assert.equal(fill.report.rpc,null);
    const restarted=new DeployerIndex();restarted.seed(saved.creates,saved.coverage.filter(e=>e.key.startsWith('coverage:creates:')),NOW);for(const e of saved.rugs)restarted.observe(e);
    const before=h14(original,starts);const after=h14(restarted,[...saved.coverage,...fill.coverage] as typeof starts);
    assert.equal(before.reasons.some(r=>r.code==='prior-rug'),true);assert.equal(after.pass,false);assert.equal(after.passed.includes('H14'),false);const context=ctx(restarted,[...saved.coverage,...fill.coverage] as typeof starts);assert.equal(createsCoverage(context.history,NOW,T-14*DAY_MS,'rugs').covered,false);
  }
  // Free-plan path: no global rug coverage. Its actual on-demand producer lists only prior mints known to the index.
  {
    const d=mkdtempSync(join(root,'creates-'));let full=false;
    const s=new DeployerStore(d,undefined,{append:(p,t)=>{if(full)throw Object.assign(new Error('ENOSPC'),{code:'ENOSPC'});appendFileSync(p,t);}});
    const candidate=ev('candidate-create','pump:CreateEvent:'+MINT,{event:{name:'CreateEvent',program:'pump',data:{mint:MINT,creator:DEV,timestamp:BigInt((T-2*3600000)/1000)}}},at(SLOT-100n,T-10000));
    const missing=['PriorA','PriorB'].map((mint,i)=>ev('lost-'+mint,'pump:CreateEvent:'+mint,{event:{name:'CreateEvent',program:'pump',data:{mint,creator:DEV,timestamp:BigInt((T-3600000)/1000)}}},at(SLOT-100n,T-9999+i,i+1)));
    const original=new DeployerIndex();for(const e of [starts[0],candidate,...missing])original.observe(e);
    s.keep(starts[0]);s.keep(candidate);full=true;for(const e of missing)s.keep(e);
    const saved=new DeployerStore(d).load(T-15*DAY_MS);const restarted=new DeployerIndex();restarted.seed(saved.creates,saved.coverage.filter(e=>e.key.startsWith('coverage:creates:')),NOW);
    const fromMs=rugCheckFromMs(T-14*DAY_MS,RUG_CONFIG);
    const prior=restarted.factFor(DEV,NOW,T-30*DAY_MS).mints.filter(m=>m.mint!==MINT&&m.createdAtMs>=fromMs);
    const checks=new DeployerChecks({history:{cost:{signatures:1,transaction:1},signatures:async()=>{throw new Error('Unexpected network read');},transaction:async()=>{throw new Error('Unexpected network read');}},rugs:RUG_CONFIG,config:RUG_CHECK_CONFIG,minGapMs:60000});
    const produced=await checks.check({creator:DEV,mints:prior,fromMs,asOf:NOW,asOfMs:T},T);
    assert.equal(produced.covered,true);assert.equal(produced.credits,0);assert.equal(produced.read.length,0);
    const coverage=[...saved.coverage,...produced.facts.map((f,i)=>ev('check-'+i,f.key,f.value,at(NOW.slot,T,100+i)))];
    const before=h14(original,coverage.filter(e=>!(e.value as any)?.value?.via?.includes('uncertain')) as typeof starts);const after=h14(restarted,coverage as typeof starts);
    assert.equal(before.reasons.some(r=>r.code==='serial-deployer'),true);assert.equal(after.pass,false);
  }
  // Successful retry before death does retain both gaps and prevents H14 from trusting the lost labels.
  const d=mkdtempSync(join(root,'recover-'));let full=false;
  const s=new DeployerStore(d,undefined,{append:(p,t)=>{if(full)throw Object.assign(new Error('ENOSPC'),{code:'ENOSPC'});appendFileSync(p,t);}});
  for(const e of [...starts,savedCreate])s.keep(e);full=true;s.keep(lostRug);full=false;s.keep(ev('later','pump:CreateEvent:Later',{event:{name:'CreateEvent',program:'pump',data:{mint:'Later',creator:'other',timestamp:BigInt((T-1000)/1000)}}},at(SLOT-90n,T-1000)));
  const restartedStore=new DeployerStore(d);assert.equal(restartedStore.failing,true);const saved=restartedStore.load(T-15*DAY_MS);const idx=new DeployerIndex();idx.seed(saved.creates,saved.coverage.filter(e=>e.key.startsWith('coverage:creates:')),NOW);for(const e of saved.rugs)idx.observe(e);const gate=h14(idx,saved.coverage as typeof starts);assert.equal(gate.pass,false);assert.equal(gate.reasons[0]!.neededBy,'H14');
  // Approved journal reserve preserves unknown loss across process death, unlike DeployerStore.
} finally {rmSync(root,{recursive:true,force:true});}

});
});
