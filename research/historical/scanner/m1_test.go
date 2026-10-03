package main

import (
	"encoding/binary"
	"testing"

	"github.com/gagliardetto/solana-go"
	"google.golang.org/protobuf/encoding/protowire"
)

// fullMetaProto: balances for nAccounts accounts, loaded addresses, pre/post token
// balances (index, mint, owner), no inner instructions recorded as empty.
func fullMetaProto(nAccounts int, loadedW, loadedR [][]byte, tbs [][3]string, idx []uint32) []byte {
	var b []byte
	b = protowire.AppendTag(b, 2, protowire.VarintType)
	b = protowire.AppendVarint(b, 5000)
	var packed []byte
	for i := 0; i < nAccounts; i++ {
		packed = protowire.AppendVarint(packed, 1000)
	}
	for _, f := range []protowire.Number{3, 4} {
		b = protowire.AppendTag(b, f, protowire.BytesType)
		b = protowire.AppendBytes(b, packed)
	}
	for _, f := range []protowire.Number{7, 8} {
		for i, t := range tbs {
			var tb []byte
			tb = protowire.AppendTag(tb, 1, protowire.VarintType)
			tb = protowire.AppendVarint(tb, uint64(idx[i]))
			tb = protowire.AppendTag(tb, 2, protowire.BytesType)
			tb = protowire.AppendString(tb, t[0])
			tb = protowire.AppendTag(tb, 4, protowire.BytesType)
			tb = protowire.AppendString(tb, t[1])
			b = protowire.AppendTag(b, f, protowire.BytesType)
			b = protowire.AppendBytes(b, tb)
		}
	}
	for _, a := range loadedW {
		b = protowire.AppendTag(b, 12, protowire.BytesType)
		b = protowire.AppendBytes(b, a)
	}
	for _, a := range loadedR {
		b = protowire.AppendTag(b, 13, protowire.BytesType)
		b = protowire.AppendBytes(b, a)
	}
	return b
}

func TestLookupTablePumpTxWithOnlyATransferWritesMovements(t *testing.T) {
	payer := solana.NewWallet().PublicKey()
	src, dst := solana.NewWallet().PublicKey(), solana.NewWallet().PublicKey()
	table := solana.NewWallet().PublicKey()
	pumpPK := solana.PublicKeyFromBytes(pumpProgram[:])
	mint := "8rjKP44zZewzNGx6DyF3Ck1Ub6y45pXbures2Dx3pump"
	data := make([]byte, 9)
	data[0] = 3
	binary.LittleEndian.PutUint64(data[1:], 42)
	tokenPK := solana.PublicKeyFromBytes(tokenProgram[:])
	ix := solana.NewInstruction(tokenPK, solana.AccountMetaSlice{solana.Meta(src).WRITE(), solana.Meta(dst).WRITE(), solana.Meta(payer).SIGNER(), solana.Meta(pumpPK)}, data)
	// The lookup table loads the pump program (read-only), so the transaction is checked
	// through its meta, but no instruction calls pump.
	tx, err := solana.NewTransaction([]solana.Instruction{ix}, solana.Hash{}, solana.TransactionPayer(payer),
		solana.TransactionAddressTables(map[solana.PublicKey]solana.PublicKeySlice{table: {pumpPK}}))
	if err != nil {
		t.Fatal(err)
	}
	if len(tx.Message.AddressTableLookups) == 0 {
		t.Fatal("fixture: solana-go did not load pump through the lookup table")
	}
	txBytes, _ := tx.MarshalBinary()
	keys := tx.Message.AccountKeys
	si, di := -1, -1
	for i, k := range keys {
		if k.Equals(src) {
			si = i
		}
		if k.Equals(dst) {
			di = i
		}
	}
	meta := fullMetaProto(len(keys)+1, nil, [][]byte{pumpPK[:]}, [][3]string{{mint, "OwnerA"}, {mint, "OwnerB"}}, []uint32{uint32(si), uint32(di)})
	r := &blockResult{agg: map[aggKey]*aggVal{}}
	st := &UnitStats{EventCounts: map[string]int{}, UnknownEvents: map[string]int{}, NewerLayouts: map[string]int{}, OlderLayouts: map[string]int{}, ExtraBytes: map[string]int{}, FirstSeen: map[string]uint64{}}
	var n int
	processTx(r, st, &blockData{slot: 7, blockTime: 9}, "7", "9", 0, txBytes, meta, &n)
	if len(r.moves) != 1 || r.moves[0][7] != "OwnerA" || r.moves[0][8] != "OwnerB" || r.moves[0][9] != "42" {
		t.Fatalf("want one movement OwnerA -> OwnerB 42, got %v (decode errors %v)", r.moves, st.DecodeErrors)
	}
}
