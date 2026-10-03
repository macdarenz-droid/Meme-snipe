package main

import (
	"encoding/binary"
	"testing"

	"github.com/gagliardetto/solana-go"
)

func amountData(op byte, v uint64) []byte {
	b := make([]byte, 9)
	b[0] = op
	binary.LittleEndian.PutUint64(b[1:], v)
	return b
}

func TestMovementRowsOutsideSwapsOnly(t *testing.T) {
	agg := solana.NewWallet().PublicKey()
	var aggK [32]byte
	copy(aggK[:], agg[:])
	mint := "8rjKP44zZewzNGx6DyF3Ck1Ub6y45pXbures2Dx3pump"
	keys := make([][32]byte, 9)
	keys[0], keys[1], keys[2], keys[3] = mustPK("11111111111111111111111111111111"), tokenProgram, pumpProgram, aggK
	keys[8] = mustPK(mint)
	for i := 4; i < 8; i++ {
		w := solana.NewWallet().PublicKey()
		copy(keys[i][:], w[:])
	}
	u32 := func(v uint32) *uint32 { return &v }
	_ = u32
	h2, h3 := 2, 3
	groups := [][]ixRef{
		// 0: a plain top-level transfer 4 -> 5 (kept)
		{{program: tokenProgram, accts: []int{4, 5, 0}, data: amountData(3, 100), height: 1}},
		// 1: a pump instruction whose inner transfer is the swap (skipped)
		{{program: pumpProgram, accts: []int{}, data: []byte{1}, height: 1}, {program: tokenProgram, accts: []int{5, 6, 0}, data: amountData(3, 7), height: h2}},
		// 2: an aggregator that calls pump (skipped below it) and transfers itself (kept), then burns (kept)
		{{program: aggK, accts: []int{}, data: []byte{9}, height: 1},
			{program: pumpProgram, accts: []int{}, data: []byte{1}, height: h2},
			{program: tokenProgram, accts: []int{6, 7, 0}, data: amountData(3, 8), height: h3},
			{program: tokenProgram, accts: []int{7, 4, 0}, data: amountData(3, 9), height: h2},
			{program: tokenProgram, accts: []int{7, 8, 0}, data: amountData(8, 2), height: h2}},
	}
	tb := func(i uint32, owner string) *TokenBalance {
		return &TokenBalance{AccountIndex: i, Mint: mint, Owner: owner}
	}
	m := &TransactionStatusMeta{PreTokenBalances: []*TokenBalance{tb(4, "A"), tb(5, "B")}, PostTokenBalances: []*TokenBalance{tb(6, "C"), tb(7, "D")}}
	if !hasMovementOutsideSwaps(groups) {
		t.Fatalf("movements outside swaps not seen")
	}
	rows := movementRows("100", "1700", 3, keys, groups, m, pumpSuffix)
	type mv struct{ outer, inner, kind, from, to, amount string }
	var got []mv
	for _, r := range rows {
		got = append(got, mv{r[3], r[4], r[6], r[7], r[8], r[9]})
	}
	want := []mv{{"0", "", "transfer", "A", "B", "100"}, {"2", "2", "transfer", "D", "A", "9"}, {"2", "3", "burn", "D", "", "2"}}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("row %d: got %v, want %v", i, got[i], want[i])
		}
	}
	if rows := movementRows("100", "1700", 3, keys, groups, m, func(string) bool { return false }); len(rows) != 0 {
		t.Fatalf("mint filter ignored")
	}
}
