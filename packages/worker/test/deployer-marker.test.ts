import { spawnSync } from 'node:child_process';
import { appendFileSync, fsyncSync, mkdtempSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DeployerIndex, RugLabeller } from '../../core/src/gates/index.ts';
import type { MarketEvent } from '../../core/src/engine/index.ts';
import { RUG_CONFIG } from '../../core/src/config/rugs.ts';
import { loadState, saveState } from '../src/persist/state.ts';
import { DeployerStore, type SavedDeployers } from '../src/run/deployer-store.ts';
import { makeWorker, Market, SLOT, T, virtualTimers } from './worker-harness.ts';
const temp=mkdtempSync(join(tmpdir(),'deployer-marker-'));
afterAll(()=>rmSync(temp,{recursive:true,force:true}));
const dir=()=>mkdtempSync(join(temp,'case-'));
const event: MarketEvent={kind:'market',id:'create',key:'pump:CreateEvent:old',moment:{slot:SLOT-100n,txIndex:0,ixIndex:0,receivedAt:T-10000},value:{event:{name:'CreateEvent',program:'pump',data:{mint:'Old',creator:'Creator',timestamp:BigInt(Math.floor(T/1000)-10)}}}};
const lost: MarketEvent={...event,id:'lost-rug',key:'rug:Old',moment:{...event.moment,ixIndex:1},value:{mint:'Old',creator:'Creator',rule:'collapse'}};
const gaps=(saved:SavedDeployers)=>saved.coverage.filter(e=>e.key.endsWith(':gap')&&(e.value as {value:{toSlot:bigint|null}}).value.toSlot===null).map(e=>e.key);
describe('durable deployer write-ahead marker',()=>{
  it('preserves uncertainty through actual process death before a zero-byte append',()=>{
    const state=dir();const s=new DeployerStore(state);s.keep(event);
    const code=`import { DeployerStore } from ${JSON.stringify(new URL('../src/run/deployer-store.ts',import.meta.url).pathname)};new DeployerStore(${JSON.stringify(state)},undefined,{append:()=>process.exit(77)}).keep({kind:'market',id:'lost',key:'rug:Old',moment:{slot:${SLOT-100n}n,txIndex:0,ixIndex:1,receivedAt:${T-9999}},value:{mint:'Old',creator:'Creator',rule:'collapse'}});`;
    expect(spawnSync(process.execPath,['--no-warnings','--input-type=module','-e',code]).status).toBe(77);
    expect(readFileSync(join(state,'deployers.jsonl.reserve'))[0]).toBe(1);
    const next=new DeployerStore(state);expect(next.failing).toBe(true);expect(gaps(next.load(0))).toEqual(['coverage:creates:gap','coverage:rugs:gap']);
  });
  it.each(['write','fsync'])('persists unknown on a write-ahead %s failure and never calls append',kind=>{
    const state=dir();let armed=false,failed=false,appends=0;
    const s=new DeployerStore(state,undefined,{markerWrite:(fd,b,o,n)=>armed&&kind==='write'?0:writeSync(fd,b,o,n),sync:fd=>{if(armed&&kind==='fsync'&&!failed){failed=true;throw Object.assign(new Error('ENOSPC'),{code:'ENOSPC'});}fsyncSync(fd);},append:(p,t)=>{appends++;appendFileSync(p,t);}});
    armed=true;if(kind==='write')expect(()=>s.keep(event)).toThrow('short write');else s.keep(event);
    expect(appends).toBe(0);expect(s.failing).toBe(true);expect(readFileSync(join(state,'deployers.jsonl.reserve'))).toHaveLength(0);
    const next=new DeployerStore(state);expect(next.failing).toBe(true);expect(gaps(next.load(0))).toEqual(['coverage:creates:gap','coverage:rugs:gap']);
  });
  it.each([Buffer.alloc(0),Buffer.from([1]),Buffer.alloc(65536,2)])('holds entries for a missing or torn diagnostic marker',bytes=>{
    const state=dir();writeFileSync(join(state,'deployers.jsonl'),'');writeFileSync(join(state,'deployers.jsonl.reserve'),bytes);
    const next=new DeployerStore(state);expect(next.failing).toBe(true);expect(gaps(next.load(0))).toEqual(['coverage:creates:gap','coverage:rugs:gap']);
  });
  it('migration without a marker beside saved data remains unknown after ordinary writes',()=>{
    const state=dir();writeFileSync(join(state,'deployers.jsonl'),'');const s=new DeployerStore(state);expect(s.failing).toBe(true);s.keep(event);expect(s.failing).toBe(true);expect(new DeployerStore(state).failing).toBe(true);
  });
  it('preserves both open gaps when a valid saved-state restore replaces store coverage',async()=>{
    const state=dir();let full=false;
    const s=new DeployerStore(state,undefined,{append:(p,t)=>{if(full)throw Object.assign(new Error('ENOSPC'),{code:'ENOSPC'});appendFileSync(p,t);}});
    s.keep(event);const index=new DeployerIndex();index.observe(event);
    const path=join(state,'deployer-state.json');saveState(path,{asOf:event.moment,index:index.snapshot(event.moment),labeller:new RugLabeller(RUG_CONFIG).snapshot(),coverage:[]});expect(loadState(path,RUG_CONFIG).ok).toBe(true);
    full=true;s.keep(lost);let captured:SavedDeployers|null=null;
    const h=makeWorker({stateDir:state,timers:virtualTimers(T),seed:async r=>{captured=r.saved;return {mode:'fill',creates:[],coverage:[],report:'empty complete same-slot fill'};}});
    try{
      const m=new Market(h),started=h.worker.start();while(!h.order.includes('start helius-ws'))await new Promise<void>(r=>setImmediate(r));m.slot();m.offchain('coverage:creates:start',{fromSlot:SLOT,via:'logs:creates'});expect(await started).toEqual({ok:true});
      expect(captured).not.toBeNull();expect(gaps(captured!)).toEqual(['coverage:creates:gap','coverage:rugs:gap']);
      expect(h.logs.some(l=>l.startsWith('Saved state restored'))).toBe(true);expect(h.worker.health().halt_reasons).toContain('disk low');expect(h.legs).toHaveLength(0);
      await m.run(1000,100,()=>m.slot());expect(h.worker.health().halt_reasons).toContain('disk low');
    }finally{await h.worker.stop();}
  });
});
