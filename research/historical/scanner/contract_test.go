package main

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/gagliardetto/solana-go"
	"google.golang.org/protobuf/encoding/protowire"
)

func voteLikeTx(t *testing.T, extra ...solana.Instruction) []byte {
	t.Helper()
	payer := solana.NewWallet().PublicKey()
	vote := solana.NewInstruction(solana.PublicKeyFromBytes(voteProgram[:]),
		solana.AccountMetaSlice{solana.Meta(payer).WRITE().SIGNER()}, []byte{2, 0, 0, 0})
	tx, err := solana.NewTransaction(append([]solana.Instruction{vote}, extra...), solana.Hash{}, solana.TransactionPayer(payer))
	if err != nil {
		t.Fatal(err)
	}
	b, _ := tx.MarshalBinary()
	return b
}

func TestVoteFilterChecksInstructions(t *testing.T) {
	if !isVoteTx(voteLikeTx(t)) {
		t.Fatalf("plain vote not recognised")
	}
	cb := solana.NewInstruction(solana.PublicKeyFromBytes(computeBudgetProgram[:]), nil, []byte{2, 1, 0, 0, 0})
	if !isVoteTx(voteLikeTx(t, cb)) {
		t.Fatalf("vote with a compute budget instruction not recognised")
	}
	// The vote program's id appears in the transaction, but a pump instruction runs too:
	// the old byte search dropped it as a vote.
	pump := solana.NewInstruction(solana.PublicKeyFromBytes(pumpProgram[:]), solana.AccountMetaSlice{}, []byte{1})
	if isVoteTx(voteLikeTx(t, pump)) {
		t.Fatalf("a transaction calling pump was classed as a vote")
	}
	if isVoteTx([]byte{1, 2, 3}) {
		t.Fatalf("garbage classed as a vote")
	}
}

func metaProto(innerNone, logsNone bool, pre []string) []byte {
	var b []byte
	b = protowire.AppendTag(b, 2, protowire.VarintType)
	b = protowire.AppendVarint(b, 5000)
	for _, m := range pre {
		var tb []byte
		tb = protowire.AppendTag(tb, 1, protowire.VarintType)
		tb = protowire.AppendVarint(tb, 1)
		tb = protowire.AppendTag(tb, 2, protowire.BytesType)
		tb = protowire.AppendString(tb, m)
		b = protowire.AppendTag(b, 7, protowire.BytesType)
		b = protowire.AppendBytes(b, tb)
	}
	if innerNone {
		b = protowire.AppendTag(b, 10, protowire.VarintType)
		b = protowire.AppendVarint(b, 1)
	}
	if logsNone {
		b = protowire.AppendTag(b, 11, protowire.VarintType)
		b = protowire.AppendVarint(b, 1)
	}
	return b
}

func rawMetaJSON(t *testing.T, innerNone, logsNone bool) map[string]json.RawMessage {
	t.Helper()
	m, err := fullMeta(metaProto(innerNone, logsNone, nil))
	if err != nil {
		t.Fatal(err)
	}
	var rec struct {
		Meta map[string]json.RawMessage `json:"meta"`
	}
	if err := json.Unmarshal([]byte(buildRawRecord(1, 2, 0, "sig", []byte{0}, m, nil)), &rec); err != nil {
		t.Fatal(err)
	}
	return rec.Meta
}

func TestRawRecordNullOnlyWhenNotRecorded(t *testing.T) {
	m := rawMetaJSON(t, false, false)
	if string(m["innerInstructions"]) != "[]" || string(m["logMessages"]) != "[]" {
		t.Fatalf("recorded but empty must be []: inner=%s logs=%s", m["innerInstructions"], m["logMessages"])
	}
	m = rawMetaJSON(t, true, true)
	if string(m["innerInstructions"]) != "null" || string(m["logMessages"]) != "null" {
		t.Fatalf("not recorded must be null: inner=%s logs=%s", m["innerInstructions"], m["logMessages"])
	}
}

func TestSampledMintsSeesPreBalancesOnly(t *testing.T) {
	var in string
	for i := 0; i < 5000 && in == ""; i++ {
		if m := solana.NewWallet().PublicKey().String(); inSample(m) {
			in = m
		}
	}
	m, err := fullMeta(metaProto(false, false, []string{in}))
	if err != nil {
		t.Fatal(err)
	}
	if got := sampledMints(m); len(got) != 1 || got[0] != in {
		t.Fatalf("mint only in pre-token balances missed: %v", got)
	}
	// addRaw gets the lean meta from processTx; it must still write the record.
	raw := metaProto(false, false, []string{in})
	lean, _ := leanMeta(raw)
	r := &blockResult{agg: map[aggKey]*aggVal{}}
	st := &UnitStats{}
	r.addRaw(st, &blockData{slot: 1, blockTime: 2}, 0, "sig", []byte{0}, raw, lean, nil)
	if len(r.raw) != 1 || !strings.Contains(r.raw[0], in) {
		t.Fatalf("no raw record for a mint seen only in pre-token balances")
	}
}

func TestCreateKeepsRawRecordForAnyMint(t *testing.T) {
	var out string
	for i := 0; i < 5000 && out == ""; i++ {
		if m := solana.NewWallet().PublicKey().String(); !inSample(m) {
			out = m
		}
	}
	raw := metaProto(false, false, nil)
	lean, _ := leanMeta(raw)
	r := &blockResult{agg: map[aggKey]*aggVal{}}
	st := &UnitStats{}
	r.addRaw(st, &blockData{slot: 1, blockTime: 2}, 0, "sig", []byte{0}, raw, lean, nil, out)
	if len(r.raw) != 0 {
		t.Fatalf("a transaction of an unsampled mint got a raw record")
	}
	r.addRaw(st, &blockData{slot: 1, blockTime: 2}, 0, "sig", []byte{0}, raw, lean, []string{out}, out)
	if len(r.raw) != 1 || !strings.Contains(r.raw[0], `"mints":["`+out+`"]`) {
		t.Fatalf("the create of an unsampled mint must keep its raw record listing the mint: %v", r.raw)
	}
}
