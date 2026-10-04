import { createSolanaRpc, getProgramDerivedAddress, getAddressEncoder, address } from "@solana/kit";
const rpc = createSolanaRpc("https://api.mainnet-beta.solana.com");
const enc = getAddressEncoder();
const PUMP = address("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const AMM = address("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const FEE = address("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
for (const n of [0n,82n,165n,170n,182n,200n,234n,300n]) {
  console.log("rent", n, await rpc.getMinimumBalanceForRentExemption(n).send());
}
for (const [name,prog] of [["pump",PUMP],["amm",AMM]]) {
  const [pda] = await getProgramDerivedAddress({programAddress: FEE, seeds:["fee_config", enc.encode(prog)]});
  const ai = await rpc.getAccountInfo(pda,{encoding:"base64"}).send();
  console.log(name, "fee_config", pda, ai.value ? ai.value.data[0].length : null);
  if (ai.value) (await import("fs")).writeFileSync(`feecfg_${name}.b64`, ai.value.data[0]);
}
const slot = await rpc.getSlot().send(); console.log("slot", slot);
const bh = await rpc.getLatestBlockhash().send(); console.log("bh", bh.value.lastValidBlockHeight, await rpc.getBlockHeight().send());
