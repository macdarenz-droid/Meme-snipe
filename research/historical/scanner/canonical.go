package main

// Canonical PumpSwap pools: the pools the pump program's migrate instruction creates
// for completed bonding curves (pump-public-docs, PUMP_SWAP_CREATOR_FEE_README). A
// pool is canonical when it is the pump_amm PDA of
//   ["pool", u16 index 0 (LE), creator, base_mint, quote_mint]
// with creator = the pump PDA ["pool-authority", base_mint]. It is decided from the
// trade alone, so retention never depends on any other day or on the future.

import (
	"sync"

	"github.com/gagliardetto/solana-go"
)

// retentionPolicy: units keep every curve trade, every trade in a canonical pool, and
// other pools' trades, failed rows and raw records of hash-sampled mints only.
const retentionPolicy = "curve-all,canonical-all,sample"

var canonicalCache sync.Map // pool|base|quote -> bool

func isCanonicalPool(pool, base, quote string) bool {
	if pool == "" || base == "" || quote == "" {
		return false
	}
	key := pool + "|" + base + "|" + quote
	if v, ok := canonicalCache.Load(key); ok {
		return v.(bool)
	}
	ok := canonicalPool(base, quote) == pool
	canonicalCache.Store(key, ok)
	return ok
}

// canonicalPool returns the canonical pool address for a base and quote mint ("" if
// either is not a public key).
func canonicalPool(base, quote string) string {
	b, err := solana.PublicKeyFromBase58(base)
	if err != nil {
		return ""
	}
	q, err := solana.PublicKeyFromBase58(quote)
	if err != nil {
		return ""
	}
	authority, _, err := solana.FindProgramAddress([][]byte{[]byte("pool-authority"), b[:]}, solana.PublicKeyFromBytes(pumpProgram[:]))
	if err != nil {
		return ""
	}
	pool, _, err := solana.FindProgramAddress([][]byte{[]byte("pool"), {0, 0}, authority[:], b[:], q[:]}, solana.PublicKeyFromBytes(ammProgram[:]))
	if err != nil {
		return ""
	}
	return pool.String()
}
