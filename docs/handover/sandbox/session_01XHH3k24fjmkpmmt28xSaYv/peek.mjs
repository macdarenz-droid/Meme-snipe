import fs from 'node:fs'; import zlib from 'node:zlib';
const f=process.argv[2], n=+process.argv[3]||3;
const t=zlib.zstdDecompressSync(fs.readFileSync(f)).toString().split('\n');
console.log(t.length-1,'lines'); for(const l of t.slice(0,n)) console.log(l);
