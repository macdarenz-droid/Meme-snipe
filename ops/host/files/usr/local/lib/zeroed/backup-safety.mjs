#!/usr/bin/env node
// Host backup boundary. Built-in Node modules only; never trusts tar paths, modes, links or manifests.
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
const names = new Set(['ledger.sqlite','account.json','exits.json','entry-seeds.json','paper.json','deployer-state.json','deployers.jsonl','deployers.jsonl.reserve','fill-budget.json','credits.json','control.json','exposure.json','cold_start']);
const allowed = p => names.has(p) || /^chain-volume\/data-volume-\d{4}-\d{2}-\d{2}\.json$/.test(p);
const legacy = p => p === 'journal.jsonl.reserve';
const limit = Number(process.env.ZEROED_BACKUP_SNAPSHOT_BYTES ?? 134217728);
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 134217728) throw Error('invalid snapshot limit');
const regular = (p, max = limit) => {
  const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { const s = fs.fstatSync(fd); if (!s.isFile() || s.nlink !== 1 || s.size > max) throw Error('nonregular or oversized state input'); return fd; }
  catch (e) { fs.closeSync(fd); throw e; }
};
const root = p => { const s = fs.lstatSync(p); if (!s.isDirectory() || s.isSymbolicLink()) throw Error('state root must be a real directory'); };
const directory = p => fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
const source = (dir, rel, max=Number.MAX_SAFE_INTEGER) => {
  if (!allowed(rel) && rel !== 'ledger.sqlite-wal') throw Error('unexpected state source');
  const dirs=[directory(dir)];
  try { let path='/proc/self/fd/'+dirs[0]; if(rel.startsWith('chain-volume/')){dirs.push(directory(path+'/chain-volume'));path='/proc/self/fd/'+dirs[1];}return regular(path+'/'+rel.split('/').at(-1),max); }
  finally {for(const fd of dirs)fs.closeSync(fd);}
};
const bounded = () => { let bytes = 0; return new Transform({ transform(chunk, _, cb) { bytes += chunk.length; cb(bytes > limit ? Error('snapshot limit exceeded') : null, chunk); } }); };
const hashRange = (fd, at, size, output) => {
  const hash = createHash('sha256'), chunk = Buffer.alloc(65536);
  for (let n = 0; n < size;) {
    const got = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - n), at + n);
    if (!got) throw Error('archive truncated');
    hash.update(chunk.subarray(0, got)); if (output !== undefined) fs.writeSync(output, chunk, 0, got); n += got;
  }
  return hash.digest('hex');
};
const markerName='deployers.jsonl.reserve';
const markerDirty = p => {
  const fd=regular(p,65536);
  try {const b=fs.readFileSync(fd);if(b.length===0)return true;if(b.length!==65536||b[0]>1||b.subarray(1).some(v=>v!==0))throw Error('invalid deployer uncertainty marker');return b[0]===1;}
  finally{fs.closeSync(fd);}
};
const lexists = p => {try{fs.lstatSync(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
const hasSaved = dir => ['deployers.jsonl','deployer-state.json'].some(rel=>fs.existsSync(join(dir,rel)));
function mergeMarker(stage,prior,create) {
  const target=join(stage,markerName), old=join(prior,markerName);
  const stageDirty=lexists(target)?markerDirty(target):hasSaved(stage);
  const priorDirty=lexists(old)?markerDirty(old):hasSaved(prior);
  const dirty=stageDirty||priorDirty;
  if(!lexists(target)) {
    if(!create)throw Error('staged deployer marker missing');
    const b=Buffer.alloc(65536);b[0]=dirty?1:0;fs.writeFileSync(target,b,{flag:'wx',mode:0o600});
    const fd=regular(target,65536);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  } else if(dirty&&fs.statSync(target).size!==0){const fd=fs.openSync(target,fs.constants.O_RDWR|fs.constants.O_NOFOLLOW);try{if(fs.writeSync(fd,Buffer.from([1]),0,1,0)!==1)throw Error('uncertainty marker short write');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
}
function selected(dir) {
  root(dir); const found=[];
  for(const rel of names){if(!lexists(join(dir,rel)))continue;const fd=source(dir,rel);fs.closeSync(fd);found.push(rel);}
  if(lexists(join(dir,'chain-volume'))){root(join(dir,'chain-volume'));for(const name of fs.readdirSync(join(dir,'chain-volume'))){const rel='chain-volume/'+name;if(allowed(rel)){const fd=source(dir,rel);fs.closeSync(fd);found.push(rel);}}}
  if(found.length>4096)throw Error('too many state files');
  return found.sort();
}
function generation(dir) {
  const found=selected(dir), wal=found.includes('ledger.sqlite')&&lexists(join(dir,'ledger.sqlite-wal'));
  const hash=createHash('sha256');
  const metadata=s=>[s.dev,s.ino,s.size,s.nlink,s.mtimeNs,s.ctimeNs].join(':');
  for(const rel of [...found,...(wal?['ledger.sqlite-wal']:[])]){
    const fd=source(dir,rel,limit);
    try {const before=fs.fstatSync(fd,{bigint:true}),meta=metadata(before);hash.update(rel+'\0'+meta+'\0'+hashRange(fd,0,Number(before.size))+'\n');if(metadata(fs.fstatSync(fd,{bigint:true}))!==meta)throw Error('source changed during generation scan');}
    finally{fs.closeSync(fd);}
  }
  if(JSON.stringify(selected(dir))!==JSON.stringify(found)||(found.includes('ledger.sqlite')&&lexists(join(dir,'ledger.sqlite-wal')))!==wal)throw Error('source allowlist/WAL changed during generation scan');
  return {names:found,stamp:hash.digest('hex')};
}
async function validate(p, rel) {
  const fd = regular(p); let input;
  try {
    if (rel === markerName) markerDirty(p);
    else if (rel === 'deployer-state.json') {
      input = fs.createReadStream(p, {fd, autoClose:true});
      const lines = createInterface({ input, crlfDelay: Infinity });
      const it = lines[Symbol.asyncIterator]();
      const first = await it.next(); const head = JSON.parse(first.value ?? '');
      if (head.format === 'zeroed-deployer-state') {
        if (head.version !== 2) throw Error('saved state version invalid');
        const hash = createHash('sha256'); let count = 0, previous;
        for (let line = await it.next(); !line.done; line = await it.next()) {
          if (previous !== undefined) { JSON.parse(previous); hash.update(previous + '\n'); count++; }
          previous = line.value;
        }
        const footer = JSON.parse(previous ?? '');
        if (!count || footer.lines !== count || footer.sha256 !== hash.digest('hex')) throw Error('saved state footer/hash/count invalid');
      } else {
        let text = first.value; for (let line = await it.next(); !line.done; line = await it.next()) text += '\n' + line.value; const v = JSON.parse(text);
        if (v.version !== 1 || typeof v.payload !== 'string' || createHash('sha256').update(v.payload).digest('hex') !== v.sha256) throw Error('saved state checksum/version invalid');
        JSON.parse(v.payload);
      }
      lines.close();
    } else if (rel === 'ledger.sqlite') {
      const check=spawnSync('sqlite3',['-readonly',p,'PRAGMA integrity_check;'],{encoding:'utf8',maxBuffer:65536});
      if(check.status!==0||check.stdout.trim()!=='ok')throw Error('SQLite integrity check failed');
    } else if (rel.endsWith('.json')) JSON.parse(fs.readFileSync(fd, 'utf8'));
  } catch (e) { throw Error(rel + ' is not valid JSON or versioned state'); }
  finally { if (input) input.destroy(); else fs.closeSync(fd); }
}
async function pack(snap, recipients, dest) {
  const tar=spawn('tar',['-C',snap,'-c','.'],{stdio:['ignore','pipe','ignore']});
  const age=spawn('age',['-R',recipients],{stdio:['pipe','pipe','ignore']});
  const exit=child=>new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('archive/encryption failed')));});
  const jobs=[exit(tar),exit(age),pipeline(tar.stdout,bounded(),createGzip(),age.stdin),pipeline(age.stdout,bounded(),fs.createWriteStream(dest,{flags:'wx',mode:0o600}))];
  try { await Promise.all(jobs); } catch(e) { tar.kill();age.kill();await Promise.allSettled(jobs);throw e; }
}
async function prepare(identity, archive, dest) {
  root(dest);
  const pause=Number(process.env.ZEROED_DISK_RECORDER_PAUSE_BYTES ?? 1610612736);
  if(!Number.isSafeInteger(pause)||pause<1)throw Error('invalid disk pause line');
  const room=fs.statfsSync(dest,{bigint:true});
  if(room.bavail*room.bsize<BigInt(pause)+BigInt(limit)*2n+65536n)throw Error('insufficient free disk above recorder pause line');
  const input = regular(archive), compressed = join(dest, '.compressed'), raw = join(dest, '.raw');
  const child = spawn('age', ['-d','-i',identity], {stdio:[input,'pipe','ignore']});
  const exited = new Promise((resolve,reject) => { child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(Error('decryption failed'))); });
  // Attach immediately so a pipeline failure cannot leave an unhandled rejection.
  exited.catch(() => {});
  try {
    await pipeline(child.stdout, bounded(), fs.createWriteStream(compressed, {flags:'wx',mode:0o600}));
    await exited;
  } catch (e) { child.kill(); await exited.catch(() => {}); throw e; }
  finally { fs.closeSync(input); }
  const magic = Buffer.alloc(2), cfd = regular(compressed); fs.readSync(cfd, magic, 0, 2, 0); fs.closeSync(cfd);
  if (magic[0] === 31 && magic[1] === 139) await pipeline(fs.createReadStream(compressed), createGunzip(), bounded(), fs.createWriteStream(raw,{flags:'wx',mode:0o600}));
  else fs.renameSync(compressed, raw);
  fs.rmSync(compressed,{force:true});
  const fd = regular(raw), length = fs.fstatSync(fd).size, members = new Map();
  try {
    if (length % 512) throw Error('invalid tar length');
    const header = Buffer.alloc(512); let offset = 0, ended = false;
    const field = (start,size) => { const b = header.subarray(start,start+size); const zero=b.indexOf(0); if (zero !== -1 && b.subarray(zero).some(v=>v!==0)) throw Error('invalid tar text'); const text=b.subarray(0,zero===-1?size:zero).toString('utf8'); if (!/^[\x20-\x7e]*$/.test(text)) throw Error('invalid tar text'); return text; };
    const octal = (start,size) => { const text=header.subarray(start,start+size).toString('ascii').replace(/[\0 ]+$/,'').trim(); if (!/^[0-7]+$/.test(text)) throw Error('invalid tar number'); const n=parseInt(text,8); if (!Number.isSafeInteger(n)) throw Error('invalid tar number'); return n; };
    while (offset < length) {
      fs.readSync(fd,header,0,512,offset);
      if (header.every(v=>v===0)) {
        if (length-offset < 1024) throw Error('missing tar end');
        const tail=Buffer.alloc(65536); for(let at=offset;at<length;) {const n=fs.readSync(fd,tail,0,Math.min(tail.length,length-at),at); if(!n||tail.subarray(0,n).some(v=>v!==0)) throw Error('data after tar end');at+=n;} ended=true;break;
      }
      const expected=octal(148,8); let sum=0;for(let i=0;i<512;i++)sum+=i>=148&&i<156?32:header[i];if(sum!==expected)throw Error('tar checksum invalid');
      const magic=field(257,6); if(magic!==''&&magic!=='ustar'&&magic!=='ustar ')throw Error('tar format unsupported');
      const prefix=magic==='ustar'?field(345,155):''; let name=(prefix?prefix+'/':'')+field(0,100), type=header[156];
      const size=octal(124,12); if(size>limit||offset+512+Math.ceil(size/512)*512>length)throw Error('tar member exceeds boundary');
      if(name.startsWith('./'))name=name.slice(2);
      if(type===53) {if(size!==0||!['','chain-volume/','chain-volume'].includes(name))throw Error('unexpected archive directory');}
      else {
        if(type!==0&&type!==48)throw Error('links/special archive members forbidden');
        if(name!=='MANIFEST.sha256'&&!allowed(name)&&!legacy(name))throw Error('unexpected archive member');
        if(members.has(name)||members.size>=4096)throw Error('duplicate/too many archive members');
        if(name==='MANIFEST.sha256'&&size>65536)throw Error('manifest too large');
        const at=offset+512; members.set(name,{at,size,hash:hashRange(fd,at,size)});
      }
      offset+=512+Math.ceil(size/512)*512;
    }
    if(!ended)throw Error('missing tar end');
    const manifest=members.get('MANIFEST.sha256');if(!manifest)throw Error('manifest missing');
    const body=Buffer.alloc(manifest.size);fs.readSync(fd,body,0,body.length,manifest.at);
    const rows=body.toString('utf8').split('\n');if(rows.pop()!=='')throw Error('manifest final newline missing');
    const selected=new Set();
    for(const row of rows){const m=/^([a-f0-9]{64})  (.+)$/.exec(row);if(!m||(!allowed(m[2])&&!legacy(m[2]))||selected.has(m[2]))throw Error('invalid manifest path or duplicate');const member=members.get(m[2]);if(!member||member.hash!==m[1])throw Error('manifest integrity mismatch');selected.add(m[2]);}
    if(!selected.size||members.size!==selected.size+1)throw Error('manifest/archive member mismatch');
    let restored=0;
    for(const rel of selected){const m=members.get(rel);if(legacy(rel)){if(m.size!==0&&m.size!==65536)throw Error('invalid legacy reserve');const b=Buffer.alloc(m.size);fs.readSync(fd,b,0,b.length,m.at);if(b.some(v=>v!==0))throw Error('invalid legacy reserve');continue;}
      if(rel.startsWith('chain-volume/'))fs.mkdirSync(join(dest,'chain-volume'),{mode:0o700,recursive:true});
      const out=fs.openSync(join(dest,rel),'wx',0o600);try{hashRange(fd,m.at,m.size,out);fs.fsyncSync(out);}finally{fs.closeSync(out);}await validate(join(dest,rel),rel);restored++;
    }
    if(!restored)throw Error('archive holds no durable state');
    // Older snapshots cannot certify whether saves lost same-slot events. Carry conservative uncertainty.
    if(hasSaved(dest)&&!selected.has(markerName)){const b=Buffer.alloc(65536);b[0]=1;fs.writeFileSync(join(dest,markerName),b,{flag:'wx',mode:0o600});}
    for(const name of ['',...(fs.existsSync(join(dest,'chain-volume'))?['chain-volume']:[])]){const dfd=directory(join(dest,name));try{fs.fsyncSync(dfd);}finally{fs.closeSync(dfd);}}
    console.log(restored);
  }finally{fs.closeSync(fd);fs.rmSync(raw,{force:true});}
}
try {
  const [cmd,...args]=process.argv.slice(2);
  if(cmd==='list')console.log(selected(args[0]).join('\n'));
  else if(cmd==='generation')console.log(JSON.stringify(generation(args[0])));
  else if(cmd==='copy'){const [dir,rel,dest]=args, max=Number(args[3]);const fd=source(dir,rel);try{const out=fs.openSync(dest,'wx',0o600);try{const size=fs.fstatSync(fd).size;if(size>max)throw Error('snapshot limit exceeded');hashRange(fd,0,size,out);if(fs.fstatSync(fd).size!==size)throw Error('state changed size during snapshot');}finally{fs.closeSync(out);}}finally{fs.closeSync(fd);}}
  else if(cmd==='check'){const fd=source(args[0],args[1]);fs.closeSync(fd);}
  else if(cmd==='validate')await validate(...args);
  else if(cmd==='prepare')await prepare(...args);
  else if(cmd==='pack')await pack(...args);
  else if(cmd==='stage-marker')mergeMarker(args[0],args[1],true);
  else if(cmd==='merge-marker')mergeMarker(args[0],args[1],false);
  else throw Error('unknown backup safety command');
}catch(e){console.error('Backup safety FAIL: '+(e.code ?? e.message));process.exitCode=1;}
