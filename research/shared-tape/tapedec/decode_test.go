package main

import (
	"bytes"
	"os"
	"path/filepath"
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
