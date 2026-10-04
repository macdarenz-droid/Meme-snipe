import { createSolanaRpc, getProgramDerivedAddress, getAddressEncoder, address } from "@solana/kit";
const rpc = createSolanaRpc("https://api.mainnet-beta.solana.com");
const enc = getAddressEncoder();
const PUMP = address("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const AMM = address("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const sigs = await rpc.getSignaturesForAddress(AMM,{limit:25}).send();
let done=0;
for (const s of sigs) {
  if (s.err) continue;
  const t = await rpc.getTransaction(s.signature,{maxSupportedTransactionVersion:1,encoding:"json"}).send();
  const payer = t.transaction.message.accountKeys[0];
  for (const [n,p] of [["pump",PUMP],["amm",AMM]]) {
    const [pda] = await getProgramDerivedAddress({programAddress:p, seeds:["user_volume_accumulator", enc.encode(payer)]});
    const ai = await rpc.getAccountInfo(pda,{encoding:"base64"}).send();
    console.log(n, payer.slice(0,6), ai.value ? `space=${ai.value.space} lamports=${ai.value.lamports}` : "none");
  }
  if (++done>=4) break;
}
