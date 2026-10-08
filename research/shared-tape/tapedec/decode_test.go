package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Decoder counts on the 3 testdata blocks match the plan's independent recount
// (research/SHARED_TAPE_PLAN.md, BUILD): 2,951 transactions, 226 failed, 154 calling
// pump or PumpSwap, 12 of those failed, 5 slippage failures, 3 truncated logs. Counts
// only: these blocks are inside the sealed window.
func TestDecoderCountsOnTestdata(t *testing.T) {
	out := filepath.Join(t.TempDir(), "u")
	ds, err := decodeUnit("../../historical/rpcscan/testdata/rpc", 0, 1<<62, "", out, false, 2)
	if err != nil {
		t.Fatal(err)
	}
	c := ds.Counts
	if ds.Blocks != 3 || c.Txs != 2951 || c.Failed != 226 || c.PumpTxs != 154 || c.PumpFailed != 12 ||
		c.Classes[clsSlippage] != 5 || c.Truncated != 3 || c.DecodeErrors != 0 || ds.ScanDecodeErr != 0 {
		t.Fatalf("counts %+v (blocks %d, scanner decode failures %d)", c, ds.Blocks, ds.ScanDecodeErr)
	}
	if ds.Rows[fFailed] != 12 {
		t.Fatalf("F rows %d, want 12", ds.Rows[fFailed])
	}
	if _, err := os.Stat(filepath.Join(out, "stats.json")); err != nil {
		t.Fatal(err)
	}
}

// Blocks outside -day are dropped whole and counted (no row from another day).
func TestDecoderDropsOtherDays(t *testing.T) {
	ds, err := decodeUnit("../../historical/rpcscan/testdata/rpc", 0, 1<<62, "2026-09-11", filepath.Join(t.TempDir(), "u"), false, 2)
	if err != nil {
		t.Fatal(err)
	}
	if ds.Blocks != 0 || ds.DroppedBlocks != 3 || len(ds.Rows) != 0 && ds.Rows[fCurve]+ds.Rows[fFailed]+ds.Rows[fTransfers] != 0 {
		t.Fatalf("stats %+v", ds)
	}
}

// With the manifest required, a spooled file whose sha256 differs is refused.
func TestDecoderManifestMismatch(t *testing.T) {
	dir := t.TempDir()
	raw, _ := os.ReadFile("../../historical/rpcscan/testdata/rpc/452277009.json.zst")
	os.WriteFile(filepath.Join(dir, "452277009.json.zst"), raw, 0o644)
	os.WriteFile(filepath.Join(dir, "MANIFEST.tsv"), []byte("452277009\t"+string(bytes.Repeat([]byte("0"), 64))+"\t1\n"), 0o644)
	if _, err := decodeUnit(dir, 0, 1<<62, "", filepath.Join(dir, "u"), true, 1); err == nil {
		t.Fatal("a mismatched sha256 was accepted")
	}
}

// The IDL copies (go:embed cannot read through a symlink) equal the scanner's.
func TestIDLCopiesMatchScanner(t *testing.T) {
	for _, f := range []string{"pump.json", "pump_amm.json"} {
		a, _ := os.ReadFile(filepath.Join("idl", f))
		b, err := os.ReadFile(filepath.Join("../../historical/scanner/idl", f))
		if err != nil || !bytes.Equal(a, b) {
			t.Fatalf("idl/%s differs from the scanner's", f)
		}
	}
}

// A program's own log line that says "failed" is not a failure line.
func TestFailureLineIsAProgramLine(t *testing.T) {
	if reFailed.MatchString("Program log: transfer failed: insufficient") {
		t.Fatal("a log line matched as a failure line")
	}
	if !reFailed.MatchString("Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P failed: custom program error: 0x1772") {
		t.Fatal("a failure line did not match")
	}
}

// S rows carry the plan's top_program and cu_price (tx_fee, cu and jito_tip are the
// scanner's own columns).
func TestSRowsCarryTopProgramAndCUPrice(t *testing.T) {
	out := filepath.Join(t.TempDir(), "u")
	if _, err := decodeUnit("../../historical/rpcscan/testdata/rpc", 0, 1<<62, "", out, false, 2); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(out, fAmm))
	b, err := zstdDec.DecodeAll(raw, nil)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	head := strings.Split(lines[0], ",")
	ti, ci := -1, -1
	for i, h := range head {
		switch h {
		case "top_program":
			ti = i
		case "cu_price":
			ci = i
		}
	}
	for _, need := range []string{"tx_fee", "cu", "jito_tip"} {
		if !strings.Contains(lines[0], ","+need+",") {
			t.Fatalf("no %s column", need)
		}
	}
	if ti < 0 || ci < 0 {
		t.Fatalf("columns missing: %s", lines[0])
	}
	top, price := 0, 0
	for _, l := range lines[1:] {
		f := strings.Split(l, ",")
		if len(f) != len(head) {
			continue // a quoted field; the counts below need only most rows
		}
		if f[ti] != "" {
			top++
		}
		if f[ci] != "" {
			price++
		}
	}
	// Exact: an outer_ix off by one would move these counts (the testdata's trades:
	// 104 under a top-level PumpSwap instruction, 6 under Jupiter).
	if n := strings.Count(string(b), ",pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA,"); n < 104 {
		t.Fatalf("top_program PumpSwap rows %d", n)
	}
	amm, jup := 0, 0
	for _, l := range lines[1:] {
		f := strings.Split(l, ",")
		if len(f) == len(head) && f[ti] == "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA" {
			amm++
		}
		if len(f) == len(head) && f[ti] == "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" {
			jup++
		}
	}
	if amm != 104 || jup != 6 {
		t.Fatalf("top_program: PumpSwap %d (want 104), Jupiter %d (want 6)", amm, jup)
	}
	if top < 100 || price < 50 {
		t.Fatalf("top_program filled %d, cu_price filled %d of %d", top, price, len(lines)-1)
	}
	if dropEvents["CollectCreatorFeeEvent"] || dropEvents["CollectCoinCreatorFeeEvent"] {
		t.Fatal("creator-fee events are still dropped")
	}
}

// Creator-fee events become CF rows with the creator and the amount in lamports.
func TestCreatorFeeRow(t *testing.T) {
	l := `{"slot":5,"block_time":9,"tx_idx":2,"ev_idx":1,"outer_ix":3,"inner_ix":0,"signature":"sig","signer":"s","program":"amm",` +
		`"event":"CollectCoinCreatorFeeEvent","fields":{"coin_creator":"C","coin_creator_fee":"12345","coin_creator_vault_ata":"V","coin_creator_token_account":"A"}}`
	r, ok := creatorFeeRow(l)
	if !ok || r[10] != "C" || r[11] != "12345" || r[13] != "V" || r[14] != "A" || r[0] != "5" {
		t.Fatalf("row %v", r)
	}
	l = `{"slot":5,"event":"CollectCreatorFeeEvent","fields":{"creator":"P","creator_fee":"7","quote_mint":"Q"}}`
	if r, ok = creatorFeeRow(l); !ok || r[10] != "P" || r[11] != "7" || r[12] != "Q" {
		t.Fatalf("row %v", r)
	}
	if _, ok = creatorFeeRow(`{"event":"TradeEvent"}`); ok {
		t.Fatal("a trade became a CF row")
	}
}
