package main

import (
	"encoding/binary"
	"strings"
	"testing"

	"github.com/gagliardetto/solana-go"
)

// Accounts: 1 token program, 2 pump, 3 mint ("pump"), 4 holder account (owner A),
// 5 delegate, 6 new authority, 7 another mint's account (owner B), 8 temp account.
func delegationFixture() ([][32]byte, *TransactionStatusMeta, string, string, string) {
	mint := "8rjKP44zZewzNGx6DyF3Ck1Ub6y45pXbures2Dx3pump"
	keys := make([][32]byte, 10)
	keys[1], keys[2], keys[3] = tokenProgram, pumpProgram, mustPK(mint)
	for _, i := range []int{4, 5, 6, 7, 8, 9} {
		w := solana.NewWallet().PublicKey()
		copy(keys[i][:], w[:])
	}
	other := solana.NewWallet().PublicKey().String()
	m := &TransactionStatusMeta{
		PreTokenBalances:  []*TokenBalance{{AccountIndex: 4, Mint: mint, Owner: "A"}, {AccountIndex: 7, Mint: other, Owner: "B"}},
		PostTokenBalances: []*TokenBalance{{AccountIndex: 4, Mint: mint, Owner: "A"}, {AccountIndex: 7, Mint: other, Owner: "B"}},
	}
	return keys, m, mint, solana.PublicKeyFromBytes(keys[5][:]).String(), solana.PublicKeyFromBytes(keys[6][:]).String()
}

func setAuthority(kind byte, to *[32]byte) []byte {
	if to == nil {
		return []byte{6, kind, 0}
	}
	return append([]byte{6, kind, 1}, to[:]...)
}

func TestDelegationRowsEveryKind(t *testing.T) {
	keys, m, mint, delegate, newAuth := delegationFixture()
	tempOwner := solana.NewWallet().PublicKey()
	checked := make([]byte, 10)
	checked[0] = 13
	binary.LittleEndian.PutUint64(checked[1:9], 77)
	groups := [][]ixRef{
		{{program: tokenProgram, accts: []int{4, 5, 0}, data: amountData(4, 500), height: 1}},
		{{program: token2022Program, accts: []int{4, 3, 5, 0}, data: checked, height: 1}},
		{{program: tokenProgram, accts: []int{4, 0}, data: []byte{5}, height: 1}},
		{{program: tokenProgram, accts: []int{4, 0}, data: setAuthority(2, &keys[6]), height: 1}},
		{{program: tokenProgram, accts: []int{4, 0}, data: setAuthority(3, nil), height: 1}},
		// another mint's account: filtered out by want
		{{program: tokenProgram, accts: []int{7, 5, 0}, data: amountData(4, 1), height: 1}},
		// a mint authority change (type 0) is not a token-account authority: no row
		{{program: tokenProgram, accts: []int{3, 0}, data: setAuthority(0, &keys[6]), height: 1}},
		// inside pump: skipped
		{{program: pumpProgram, accts: []int{}, data: []byte{1}, height: 1}, {program: tokenProgram, accts: []int{4, 5, 0}, data: amountData(4, 9), height: 2}},
		// a temp account opened in the transaction, then approved: owner from InitializeAccount3
		{{program: tokenProgram, accts: []int{8, 3}, data: append([]byte{18}, tempOwner[:]...), height: 1}},
		{{program: tokenProgram, accts: []int{8, 5, 0}, data: amountData(4, 3), height: 1}},
	}
	if !hasMovementOutsideSwaps(groups[:1]) {
		t.Fatalf("an approve alone must trigger the full-meta parse")
	}
	rows := delegationRows("100", "1700", 2, keys, groups, m, pumpSuffix)
	acct := solana.PublicKeyFromBytes(keys[4][:]).String()
	temp := solana.PublicKeyFromBytes(keys[8][:]).String()
	want := [][]string{
		{"100", "1700", "2", "0", "", mint, "approve", acct, "A", delegate, "500"},
		{"100", "1700", "2", "1", "", mint, "approve_checked", acct, "A", delegate, "77"},
		{"100", "1700", "2", "2", "", mint, "revoke", acct, "A", "", ""},
		{"100", "1700", "2", "3", "", mint, "set_owner", acct, "A", newAuth, ""},
		{"100", "1700", "2", "4", "", mint, "set_close_authority", acct, "A", "", ""},
		{"100", "1700", "2", "9", "", mint, "approve", temp, tempOwner.String(), delegate, "3"},
	}
	if len(rows) != len(want) {
		t.Fatalf("got %d rows %v, want %d", len(rows), rows, len(want))
	}
	for i := range want {
		if strings.Join(rows[i], ",") != strings.Join(want[i], ",") {
			t.Fatalf("row %d:\n got %v\nwant %v", i, rows[i], want[i])
		}
	}
	if len(delegationCols) != len(want[0]) {
		t.Fatalf("delegationCols has %d columns, rows %d", len(delegationCols), len(want[0]))
	}
}

func TestPlainApproveTransactionWritesDelegation(t *testing.T) {
	// A plain token transaction (no pump instruction) approving a delegate on a "pump"
	// mint's account reaches the mint-only path and writes a delegation row.
	payer, src, delegate := solana.NewWallet().PublicKey(), solana.NewWallet().PublicKey(), solana.NewWallet().PublicKey()
	tokenPK := solana.PublicKeyFromBytes(tokenProgram[:])
	ix := solana.NewInstruction(tokenPK, solana.AccountMetaSlice{solana.Meta(src).WRITE(), solana.Meta(delegate), solana.Meta(payer).SIGNER()}, amountData(4, 1234))
	tx, err := solana.NewTransaction([]solana.Instruction{ix}, solana.Hash{}, solana.TransactionPayer(payer))
	if err != nil {
		t.Fatal(err)
	}
	tx.Signatures = []solana.Signature{{1}}
	txBytes, _ := tx.MarshalBinary()
	si := -1
	for i, k := range tx.Message.AccountKeys {
		if k.Equals(src) {
			si = i
		}
	}
	meta := fullMetaProto(len(tx.Message.AccountKeys), nil, nil, [][3]string{{attrMint, "OwnerA"}}, []uint32{uint32(si)})
	r := &blockResult{agg: map[aggKey]*aggVal{}}
	st := &UnitStats{EventCounts: map[string]int{}, UnknownEvents: map[string]int{}, NewerLayouts: map[string]int{}, OlderLayouts: map[string]int{}, ExtraBytes: map[string]int{}, FirstSeen: map[string]uint64{}}
	mintOnlyTxRaw(r, st, &blockData{slot: 7, blockTime: 9}, 0, txBytes, meta)
	if len(r.delegs) != 1 || r.delegs[0][6] != "approve" || r.delegs[0][8] != "OwnerA" || r.delegs[0][9] != delegate.String() || r.delegs[0][10] != "1234" {
		t.Fatalf("want one approve row OwnerA -> %s 1234, got %v (decode errors %v)", delegate, r.delegs, st.DecodeErrors)
	}
}
