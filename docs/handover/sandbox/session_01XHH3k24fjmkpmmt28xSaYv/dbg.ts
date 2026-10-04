import { decodeBase58, encodeBase58, PUMP_PROGRAM } from '/home/user/Meme-snipe/packages/core/src/chain/index.ts';
const k = encodeBase58(new Uint8Array(32).fill(1));
console.log(k, decodeBase58(k).length, decodeBase58(PUMP_PROGRAM).length);
const s = new Uint8Array(64); s[0]=7; console.log(encodeBase58(s), decodeBase58(encodeBase58(s)).length);
