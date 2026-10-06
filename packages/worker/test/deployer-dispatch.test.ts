import { it } from 'vitest';
import assert from 'node:assert/strict';
import { appendFileSync, rmSync } from 'node:fs';
import { makeWorker, passingMarket, MINT } from './worker-harness.ts';
import { simKey } from '../../core/src/gates/index.ts';
it('blocks the first entry broadcast in the same drain after any deployer append loses evidence',async()=>{
let full=false;let h:any;const failures:any[]=[];
const append=(p:string,t:string)=>{
  if(full && p.endsWith('/deployers.jsonl')){failures.push({legs:h.legs.length,attempts:h.worker.apiInputs().attempts.size,at:h.timers.now()});throw Object.assign(new Error('ENOSPC'),{code:'ENOSPC'});}appendFileSync(p,t);
};
h=makeWorker({append});
try {
  assert.deepEqual(await h.worker.reconcile(),{ok:true});
  const m=await passingMarket(h,{omit:[simKey(MINT)]});
  await m.run(1500,100,()=>m.pool());
  assert.equal(h.legs.length,0);
  full=true;
  m.fact('rug:Probe',{mint:'Probe',creator:'other',rule:'collapse'});
  m.omit=new Set();m.pool();
  await m.run(2500,100,()=>m.pool());
  assert.equal(failures[0].legs,0);assert.equal(failures[0].attempts,0);
  assert.equal(h.legs.filter((l:any)=>l.leg==='entry').length,0);assert.equal(h.worker.apiInputs().attempts.size,0);
  assert.equal(h.worker.health().halt_reasons.includes('disk low'),true);
} finally {full=false;await h.worker.stop();rmSync(h.stateDir,{recursive:true,force:true});}

});
