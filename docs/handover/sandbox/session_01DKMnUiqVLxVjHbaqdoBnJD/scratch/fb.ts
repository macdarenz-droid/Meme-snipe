import { compareVolumeHours } from '/home/user/Meme-snipe/packages/backtest/src/dataset/oldvol.ts';
import { csvObjects } from '/home/user/Meme-snipe/packages/backtest/src/dataset/parity.ts';
const DAY='2026-09-20', T0=Date.parse(DAY+'T00:00:00Z')/1000;
const sums=new Map<number,bigint>([[T0+5*3600,1123n]]);
const ok=['hour_start_ms,lamports,covered',...Array.from({length:24},(_,i)=>`${(T0+i*3600)*1000},${i===5?'1123':'0'},1`)].join('\n')+'\n';
const lines=ok.trimEnd().split('\n');
const cases:{[k:string]:string}={ '23 hours':lines.slice(0,24).join('\n'), 'covered yes':ok.replace(',0,1\n',',0,yes\n'), header:ok.replace('hour_start_ms,','hour,'), order:[lines[0],lines[2],lines[1],...lines.slice(3)].join('\n'), u64:ok.replace(/\n\d+,1123,1/,`\n${(T0+5*3600)*1000},18446744073709551616,1`)};
for (const [k,c] of Object.entries(cases)) { const r=compareVolumeHours(DAY, csvObjects(c), sums, false); console.log(k, 'problems', r.problems.length, 'mismatches', r.mismatches.length); }
