package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gagliardetto/solana-go"
	"google.golang.org/protobuf/encoding/protowire"
)

// A canonical pool from a real migration (canonical_test.go) and a non-canonical one.
const (
	k3Mint  = "8rjKP44zZewzNGx6DyF3Ck1Ub6y45pXbures2Dx3pump"
	k3Pool  = "62jTpYEzdU7a8ayjgedtU7J43fqesgYRfJAi8rX7VgJS"
	k3Mint2 = "ADM3KSHNhACDLTGLPNKBDPAvjykrfCKHQAZdijHYPYWB"
	k3Pool2 = "GVhfB8GTUrFiRE2JX5MZ6rk621kSc6aCXr54kpNYitYz"
)

// withRetention runs fn under a retention mode and sample rate 0 (no mint sampled, so
// raw.jsonl.zst stays empty and every canonical record goes to raw_canonical).
func withRetention(t *testing.T, mode, list string, fn func()) {
	t.Helper()
	defer func(m string, l map[string]k3Window, s string, r float64) {
		retentionMode, k3List, k3ListSha, sampleRate = m, l, s, r
	}(retentionMode, k3List, k3ListSha, sampleRate)
	retentionMode, k3List, k3ListSha = "", nil, ""
	if err := setRetention(mode, list); err != nil {
		t.Fatal(err)
	}
	clearSample := func() { sampleCache.Range(func(k, _ any) bool { sampleCache.Delete(k); return true }) }
	clearSample() // inSample caches per mint; a test that changes sampleRate must not leak
	defer clearSample()
	sampleRate = 0
	fn()
}

// metaBytes: a protobuf meta for keys (fee 5000, balances), failed when errBytes is set.
func metaBytes(nKeys int, failed bool) []byte {
	var b []byte
	if failed {
		var e []byte
		e = protowire.AppendTag(e, 1, protowire.BytesType)
		e = protowire.AppendBytes(e, []byte{1, 0, 0, 0})
		b = protowire.AppendTag(b, 1, protowire.BytesType)
		b = protowire.AppendBytes(b, e)
	}
	b = protowire.AppendTag(b, 2, protowire.VarintType)
	b = protowire.AppendVarint(b, 5000)
	var packed []byte
	for i := 0; i < nKeys; i++ {
		packed = protowire.AppendVarint(packed, 1000)
	}
	for _, fn := range []protowire.Number{3, 4} {
		b = protowire.AppendTag(b, fn, protowire.BytesType)
		b = protowire.AppendBytes(b, packed)
	}
	return b
}

// ammTxDisc: one PumpSwap instruction with discriminator disc in pool/base/quote.
func ammTxDisc(t *testing.T, pool, base string, disc []byte, signer byte) ([]byte, int) {
	return ammTxWith(t, pool, base, false, signer, disc)
}

// ammTx: one PumpSwap buy in pool/base/quote, global_config writable or not.
func ammTx(t *testing.T, pool, base string, cfgWritable bool, signer byte) ([]byte, int) {
	return ammTxWith(t, pool, base, cfgWritable, signer, ammTradeIx[0])
}

func ammTxWith(t *testing.T, pool, base string, cfgWritable bool, signer byte, disc []byte) ([]byte, int) {
	t.Helper()
	cfg := solana.PublicKeyFromBytes(func() []byte {
		for k, n := range configAccounts {
			if n == "pump_amm_global_config" {
				return append([]byte(nil), k[:]...)
			}
		}
		t.Fatal("no global_config")
		return nil
	}())
	cm := solana.Meta(cfg)
	if cfgWritable {
		cm = cm.WRITE()
	}
	user := solana.PublicKeyFromBytes(append(make([]byte, 31), 100+signer))
	accts := solana.AccountMetaSlice{solana.Meta(mustPKpub(pool)).WRITE(), solana.Meta(user).WRITE(), cm,
		solana.Meta(mustPKpub(base)), solana.Meta(mustPKpub(wsolMint))}
	ix := solana.NewInstruction(solana.PublicKeyFromBytes(ammProgram[:]), accts, append(append([]byte{}, disc...), make([]byte, 16)...))
	payer := solana.PublicKeyFromBytes(append(make([]byte, 31), signer))
	tx, err := solana.NewTransaction([]solana.Instruction{ix}, solana.Hash{}, solana.TransactionPayer(payer))
	if err != nil {
		t.Fatal(err)
	}
	tx.Signatures = []solana.Signature{{signer}}
	b, _ := tx.MarshalBinary()
	return b, len(tx.Message.AccountKeys)
}

// feeAdminTx: a pump_fees instruction that writes the pump FeeConfig (no pump or
// PumpSwap instruction).
func feeAdminTx(t *testing.T) ([]byte, int) {
	t.Helper()
	var fc solana.PublicKey
	for k, n := range configAccounts {
		if n == "pump_fee_config" {
			fc = solana.PublicKeyFromBytes(k[:])
		}
	}
	ix := solana.NewInstruction(solana.PublicKeyFromBytes(feeProgram[:]), solana.AccountMetaSlice{solana.Meta(fc).WRITE()}, []byte{1, 2, 3, 4, 5, 6, 7, 8})
	tx, err := solana.NewTransaction([]solana.Instruction{ix}, solana.Hash{}, solana.TransactionPayer(solana.NewWallet().PublicKey()))
	if err != nil {
		t.Fatal(err)
	}
	tx.Signatures = []solana.Signature{{9}}
	b, _ := tx.MarshalBinary()
	return b, len(tx.Message.AccountKeys)
}

func newResult() (*blockResult, *UnitStats) {
	return &blockResult{agg: map[aggKey]*aggVal{}}, &UnitStats{EventCounts: map[string]int{}, UnknownEvents: map[string]int{}, NewerLayouts: map[string]int{},
		OlderLayouts: map[string]int{}, ExtraBytes: map[string]int{}, FirstSeen: map[string]uint64{}}
}

// runTx processes one transaction at blockTime bt.
func runTx(t *testing.T, r *blockResult, st *UnitStats, txBytes []byte, nKeys int, failed bool, bt int64, idx int) {
	t.Helper()
	var n int
	processTx(r, st, &blockData{slot: 7, blockTime: bt}, "7", "9", idx, txBytes, metaBytes(nKeys, failed), &n)
	if len(st.DecodeErrors) > 0 {
		t.Fatalf("decode errors: %v", st.DecodeErrors)
	}
}

func writeList(t *testing.T, lines ...string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "list.txt")
	if err := os.WriteFile(p, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestRetentionFlagsRefusedBeforeAnyRequest(t *testing.T) {
	list := writeList(t, k3Mint+" 100 200")
	for _, c := range []struct{ mode, list string }{{"K1", ""}, {"k2", ""}, {"K3", ""}, {"K2", list}, {"", list}} {
		retentionMode = ""
		if err := setRetention(c.mode, c.list); err == nil {
			t.Errorf("retention %q list %q accepted", c.mode, c.list)
		}
	}
	for _, bad := range [][]string{
		{k3Mint2 + " 100 200", k3Mint + " 100 200"}, // unsorted
		{k3Mint + " 100 200", k3Mint + " 100 200"},  // duplicate
		{"notamint 100 200"}, {k3Mint + " 200 100"}, {k3Mint + " 0 100"}, {k3Mint + " 100"}, {k3Mint + "  100 200"},
	} {
		if _, _, err := loadMigrationList(writeList(t, bad...)); err == nil {
			t.Errorf("list %q accepted", bad)
		}
	}
	if _, _, err := loadMigrationList(filepath.Join(t.TempDir(), "empty")); err == nil {
		t.Error("missing list accepted")
	}
	withRetention(t, "K3", list, func() {
		if k3ListSha == "" || len(k3List) != 1 || unitRetention() != "K3" {
			t.Fatalf("K3 not set: %q %v", k3ListSha, k3List)
		}
	})
	withRetention(t, "", "", func() {
		if unitRetention() != retentionPolicy {
			t.Fatalf("default retention %q", unitRetention())
		}
	})
}

// P12: the derived config accounts match the FeeConfig read from chain
// (research/edge/snapshot/fee-configs.json, pump).
func TestConfigAccountsMatchSnapshot(t *testing.T) {
	want := map[string]string{"pump_fee_config": "8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt"}
	got := map[string]string{}
	for k, n := range configAccounts {
		got[n] = solana.PublicKeyFromBytes(k[:]).String()
	}
	if len(got) != 4 {
		t.Fatalf("config accounts %v", got)
	}
	for n, a := range want {
		if got[n] != a {
			t.Errorf("%s: derived %s, chain %s", n, got[n], a)
		}
	}
}

func TestCanonicalRawRecordsByRetention(t *testing.T) {
	type res struct{ canon, raw int }
	run := func(mode, list string, pool, base string, failed bool, bt int64) (r res, mints []string) {
		withRetention(t, mode, list, func() {
			br, st := newResult()
			tx, n := ammTx(t, pool, base, false, 1)
			runTx(t, br, st, tx, n, failed, bt, 0)
			r = res{len(br.rawCanon), len(br.raw)}
			if len(br.rawCanon) == 1 {
				var rec struct{ Mints []string }
				json.Unmarshal([]byte(br.rawCanon[0]), &rec)
				mints = rec.Mints
			}
			if len(br.config) != 0 {
				t.Errorf("a trade reading global_config made a config record")
			}
		})
		return
	}
	if r, _ := run("", "", k3Pool, k3Mint, false, 150); r != (res{0, 0}) {
		t.Errorf("default retention wrote %v", r)
	}
	if r, m := run("K2", "", k3Pool, k3Mint, false, 150); r != (res{1, 0}) || len(m) != 1 || m[0] != k3Mint {
		t.Errorf("K2 canonical trade: %v %v", r, m)
	}
	if r, _ := run("K2", "", k3Pool, k3Mint, true, 150); r != (res{1, 0}) {
		t.Errorf("K2 failed canonical trade: %v", r)
	}
	if r, _ := run("K2", "", k3Pool, k3Mint2, false, 150); r != (res{0, 0}) {
		t.Errorf("K2 non-canonical pool: %v", r)
	}
	in := writeList(t, k3Mint+" 100 200")
	if r, _ := run("K3", in, k3Pool, k3Mint, false, 150); r != (res{1, 0}) {
		t.Errorf("K3 listed mint inside its window: %v", r)
	}
	for _, bt := range []int64{99, 201} {
		if r, _ := run("K3", in, k3Pool, k3Mint, false, bt); r != (res{0, 0}) {
			t.Errorf("K3 listed mint outside its window (%d): %v", bt, r)
		}
	}
	if r, _ := run("K3", writeList(t, k3Mint2+" 100 200"), k3Pool, k3Mint, false, 150); r != (res{0, 0}) {
		t.Errorf("K3 mint not on the list: %v", r)
	}
	// A sampled mint's transaction is already in raw.jsonl.zst: never twice.
	withRetention(t, "K2", "", func() {
		sampleRate = 1
		sampleCache.Delete(k3Mint)
		br, st := newResult()
		tx, n := ammTx(t, k3Pool, k3Mint, false, 1)
		runTx(t, br, st, tx, n, true, 150, 0) // failed: its mint hint is the sampled base mint
		if len(br.raw) != 1 || len(br.rawCanon) != 0 {
			t.Errorf("a record in raw.jsonl.zst (%d) was written to raw_canonical too (%d)", len(br.raw), len(br.rawCanon))
		}
	})
}

func TestConfigChangeRecordsP12(t *testing.T) {
	withRetention(t, "K2", "", func() {
		br, st := newResult()
		tx, n := ammTx(t, k3Pool2, k3Mint2, true, 1) // an admin instruction that writes global_config
		runTx(t, br, st, tx, n, false, 150, 0)
		if len(br.config) != 1 {
			t.Fatalf("a GlobalConfig write made %d config records", len(br.config))
		}
		br, st = newResult()
		fx, fn := feeAdminTx(t)
		configOnlyTxRaw(br, st, &blockData{slot: 7, blockTime: 150}, 0, fx, metaBytes(fn, false))
		if len(br.config) != 1 || len(st.DecodeErrors) > 0 {
			t.Fatalf("a FeeConfig write made %d config records (%v)", len(br.config), st.DecodeErrors)
		}
		if !mayWriteConfig(fx) {
			t.Fatal("the pre-filter misses a pump_fees transaction")
		}
	})
	withRetention(t, "", "", func() {
		br, st := newResult()
		tx, n := ammTx(t, k3Pool2, k3Mint2, true, 1)
		runTx(t, br, st, tx, n, false, 150, 0)
		fx, fn := feeAdminTx(t)
		configOnlyTxRaw(br, st, &blockData{slot: 7, blockTime: 150}, 0, fx, metaBytes(fn, false))
		if len(br.config) != 0 || mayWriteConfig(fx) {
			t.Fatal("default retention wrote config records")
		}
	})
}

// scanFixtureUnit writes a unit from a fixed set of transactions under mode: canonical
// trades of two mints at several times, a failed one, and a config change.
func scanFixtureUnit(t *testing.T, mode, list, dir string) {
	t.Helper()
	withRetention(t, mode, list, func() {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		outs, err := openUnitFiles(dir)
		if err != nil {
			t.Fatal(err)
		}
		st := &UnitStats{Schema: schemaVersion, EventCounts: map[string]int{}, UnknownEvents: map[string]int{}, NewerLayouts: map[string]int{},
			OlderLayouts: map[string]int{}, ExtraBytes: map[string]int{}, FirstSeen: map[string]uint64{}, ScannerRevision: "rFixed", SampleRate: 0,
			Retention: unitRetention(), MigrationListSha256: k3ListSha}
		agg := map[aggKey]*aggVal{}
		for i, c := range []struct {
			pool, base string
			bt         int64
			failed     bool
			cfg        bool
		}{{k3Pool, k3Mint, 120, false, false}, {k3Pool, k3Mint, 150, true, false}, {k3Pool, k3Mint, 250, false, false},
			{k3Pool2, k3Mint2, 130, false, false}, {k3Pool2, k3Mint2, 140, false, true}, {k3Pool, k3Mint, 199, false, false}} {
			r, _ := newResult()
			r.slot = uint64(10 + i)
			r.blockRow = []string{"10", "1", "9", "1", "0", "1", "1", "0", "0"}
			tx, n := ammTx(t, c.pool, c.base, c.cfg, byte(i+1))
			runTx(t, r, st, tx, n, c.failed, c.bt, i)
			writeResult(outs, r, st, agg)
		}
		for _, o := range outs {
			if err := o.close(); err != nil {
				t.Fatal(err)
			}
		}
		sb, _ := json.MarshalIndent(st, "", "  ")
		if err := os.WriteFile(filepath.Join(dir, "stats.json"), sb, 0o644); err != nil {
			t.Fatal(err)
		}
	})
}

func dataFiles(t *testing.T, dir string) map[string][]byte {
	t.Helper()
	m := map[string][]byte{}
	es, _ := os.ReadDir(dir)
	for _, e := range es {
		if strings.HasSuffix(e.Name(), ".zst") {
			b, err := os.ReadFile(filepath.Join(dir, e.Name()))
			if err != nil {
				t.Fatal(err)
			}
			m[e.Name()] = b
		}
	}
	return m
}

// OF-3: a trimmed K2 unit equals a fresh K3 scan of the same unit, with the same pinned
// list, byte for byte; trimming twice gives identical bytes; no network request.
func TestTrimK2EqualsK3ScanAndIsDeterministic(t *testing.T) {
	list := writeList(t, k3Mint+" 100 200")
	base := t.TempDir()
	k2, k3 := filepath.Join(base, "k2"), filepath.Join(base, "k3")
	scanFixtureUnit(t, "K2", "", k2)
	scanFixtureUnit(t, "K3", list, k3)
	req0 := statHTTPRequests.Load()
	t1, t2 := filepath.Join(base, "t1"), filepath.Join(base, "t2")
	if err := TrimUnit(k2, t1, list); err != nil {
		t.Fatal(err)
	}
	if err := TrimUnit(k2, t2, list); err != nil {
		t.Fatal(err)
	}
	if statHTTPRequests.Load() != req0 {
		t.Fatal("the trim made a network request")
	}
	want, got, again := dataFiles(t, k3), dataFiles(t, t1), dataFiles(t, t2)
	if len(want) != 12 || len(got) != len(want) {
		t.Fatalf("files: K3 scan %d, trim %d", len(want), len(got))
	}
	for name, b := range want {
		if !bytes.Equal(got[name], b) {
			t.Errorf("%s: trimmed K2 differs from the K3 scan", name)
		}
		if !bytes.Equal(again[name], got[name]) {
			t.Errorf("%s: trimming twice differs", name)
		}
	}
	s1, _ := os.ReadFile(filepath.Join(t1, "stats.json"))
	s2, _ := os.ReadFile(filepath.Join(t2, "stats.json"))
	if !bytes.Equal(s1, s2) {
		t.Error("stats.json differs between two trims")
	}
	st, _ := readStats(t1)
	k3st, _ := readStats(k3)
	k2st, _ := readStats(k2)
	if st.Retention != "K3" || st.MigrationListSha256 != k3st.MigrationListSha256 || st.RawCanonicalRecords != k3st.RawCanonicalRecords {
		t.Errorf("trimmed stats %q %q %d, K3 scan %q %d", st.Retention, st.MigrationListSha256, st.RawCanonicalRecords, k3st.MigrationListSha256, k3st.RawCanonicalRecords)
	}
	// The fixture is not trivial: K2 keeps all 6 canonical transactions (one failed, one
	// that also writes GlobalConfig), K3 the 3 of the listed mint inside its window; the
	// config change is in both.
	if k2st.RawCanonicalRecords != 6 || k3st.RawCanonicalRecords != 3 || k2st.ConfigRecords != 1 || k3st.ConfigRecords != 1 {
		t.Errorf("fixture counts: K2 %d/%d, K3 %d/%d", k2st.RawCanonicalRecords, k2st.ConfigRecords, k3st.RawCanonicalRecords, k3st.ConfigRecords)
	}
	if err := TrimUnit(k3, filepath.Join(base, "t3"), list); err == nil || !strings.Contains(err.Error(), "only a K2 unit") {
		t.Errorf("a K3 unit was trimmed: %v", err)
	}
	if err := TrimUnit(k2, t1, list); err == nil || !strings.Contains(err.Error(), "exists") {
		t.Errorf("an existing trimmed unit was overwritten: %v", err)
	}
}

// trimmedDay writes K2 units at units/1046/{1-2,3-4} trimmed to K3 under out, and returns
// the per-unit log (unit lines, then the k2 lines of every K2 file).
func trimmedDay(t *testing.T, out, list string) []string {
	t.Helper()
	k2 := t.TempDir()
	var k2lines []string
	for _, u := range []string{"1-2", "3-4"} {
		src := filepath.Join(k2, "units", "1046", u)
		scanFixtureUnit(t, "K2", "", src)
		files, _ := filepath.Glob(filepath.Join(src, "*.zst"))
		for _, f := range files {
			h, err := fileSha256(f)
			if err != nil {
				t.Fatal(err)
			}
			k2lines = append(k2lines, "k2 "+h+" 1046/"+u+"/"+filepath.Base(f))
		}
		os.MkdirAll(filepath.Join(out, "units", "1046"), 0o755)
		if err := TrimUnit(src, filepath.Join(out, "units", "1046", u), list); err != nil {
			t.Fatal(err)
		}
	}
	lines, err := unitLog(out)
	if err != nil {
		t.Fatal(err)
	}
	return append(lines, k2lines...)
}

func writeLog(t *testing.T, lines []string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "units.log")
	if err := os.WriteFile(p, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// OF-3: a unit whose stats carry another list sha256 than the per-unit log is refused.
func TestUnitLogRefusesAnotherListSha(t *testing.T) {
	list, other := writeList(t, k3Mint+" 100 200"), writeList(t, k3Mint+" 100 201")
	out := t.TempDir()
	lines := trimmedDay(t, out, list)
	if err := checkUnitLog(out, writeLog(t, lines)); err != nil {
		t.Fatalf("a matching log refused: %v", err)
	}
	_, otherSha, _ := loadMigrationList(other)
	_, listSha, _ := loadMigrationList(list)
	if err := checkUnitLog(out, writeLog(t, strings.Split(strings.ReplaceAll(strings.Join(lines, "\n"), listSha, otherSha), "\n"))); err == nil || !strings.Contains(err.Error(), "mismatch") {
		t.Fatalf("another list sha256 accepted: %v", err)
	}
	if err := checkUnitLog(out, writeLog(t, lines[1:])); err == nil {
		t.Fatal("a unit missing from the log accepted")
	}
}

// OF-3 ruling 12: exactly one k2 line per K2 file of each K3 unit, and every copied file
// still has its K2 sha256.
func TestUnitLogK2LinesAreExact(t *testing.T) {
	list := writeList(t, k3Mint+" 100 200")
	out := t.TempDir()
	lines := trimmedDay(t, out, list)
	var k2i []int
	for i, l := range lines {
		if strings.HasPrefix(l, "k2 ") {
			k2i = append(k2i, i)
		}
	}
	if len(k2i) != 24 {
		t.Fatalf("%d k2 lines, want 12 files x 2 units", len(k2i))
	}
	drop := append(append([]string{}, lines[:k2i[0]]...), lines[k2i[0]+1:]...)
	dup := append(append([]string{}, lines...), lines[k2i[0]])
	var badSha []string
	for _, l := range lines {
		if strings.HasPrefix(l, "k2 ") && strings.HasSuffix(l, "/1-2/blocks.csv.zst") {
			l = "k2 " + strings.Repeat("0", 64) + " 1046/1-2/blocks.csv.zst"
		}
		badSha = append(badSha, l)
	}
	extra := append(append([]string{}, lines...), "k2 "+strings.Repeat("a", 64)+" 1046/9-9/blocks.csv.zst")
	for name, l := range map[string][]string{"missing": drop, "duplicate": dup, "copied file differs": badSha, "unknown unit": extra} {
		if err := checkUnitLog(out, writeLog(t, l)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if err := checkUnitLog(out, writeLog(t, lines)); err != nil {
		t.Fatalf("the exact log refused: %v", err)
	}
	// a K2 unit carries no k2 lines
	k2out := t.TempDir()
	scanFixtureUnit(t, "K2", "", filepath.Join(k2out, "units", "1046", "1-2"))
	ul, _ := unitLog(k2out)
	if err := checkUnitLog(k2out, writeLog(t, append(ul, "k2 "+strings.Repeat("a", 64)+" 1046/1-2/blocks.csv.zst"))); err == nil {
		t.Error("k2 lines on a K2 unit accepted")
	}
}

// OF-3 ruling 16: every reserve-changing PumpSwap instruction in a canonical pool is kept
// (K2), each by its discriminator; instructions that do not touch reserves are not.
func TestCanonicalKeepsEveryReserveChangingInstruction(t *testing.T) {
	want := map[string]bool{"buy": true, "sell": true, "buy_exact_quote_in": true, "deposit": true, "withdraw": true, "boost_buy_and_burn": true, "init_boost": true, "create_pool": true}
	got := map[string]bool{}
	for _, n := range poolReserveIx {
		got[n] = true
	}
	for n := range want {
		if !got[n] {
			t.Errorf("%s is not kept", n)
		}
	}
	if len(got) != len(want) {
		t.Errorf("kept %v, want %v", got, want)
	}
	for d, n := range poolReserveIx {
		withRetention(t, "K2", "", func() {
			br, st := newResult()
			tx, k := ammTxDisc(t, k3Pool, k3Mint, d[:], 1)
			runTx(t, br, st, tx, k, false, 150, 0)
			if len(br.rawCanon) != 1 {
				t.Errorf("%s in a canonical pool: %d records", n, len(br.rawCanon))
			}
		})
	}
	for _, d := range [][]byte{{45, 61, 165, 151, 104, 0, 49, 189}, {210, 149, 128, 45, 188, 58, 78, 175}} { // admin_cto_pool, set_coin_creator
		withRetention(t, "K2", "", func() {
			br, st := newResult()
			tx, k := ammTxDisc(t, k3Pool, k3Mint, d, 1)
			runTx(t, br, st, tx, k, false, 150, 0)
			if len(br.rawCanon) != 0 {
				t.Errorf("discriminator %v (no reserve change) kept", d)
			}
		})
	}
}

// OF-3: finalize refuses a day mixing K2 and K3 units, and lets K2/K3 units carry
// 100% launch and grad universes like retentionPolicy units.
func TestFinalizeRefusesMixedK2K3(t *testing.T) {
	f := &fixture{t: t, out: t.TempDir()}
	a := spanUnit(1, 1000, day("2026-09-01")-3600, day("2026-09-01")+3600)
	a.oldRetention, a.retention = true, "K2"
	f.spanUnit(a)
	b := spanUnit(1, 1003, day("2026-09-01")+7200, day("2026-09-02")+1800)
	b.oldRetention, b.retention = true, "K3"
	f.spanUnit(b)
	if err := Finalize(f.out, t.TempDir(), "2026-09-01", "2026-09-02", finalizeOpts{}); err == nil || !strings.Contains(err.Error(), "retention") {
		t.Fatalf("mixed K2/K3 accepted: %v", err)
	}
	g := &fixture{t: t, out: t.TempDir()}
	c := spanUnit(1, 1000, day("2026-09-01")-3600, day("2026-09-02")+1800)
	c.oldRetention, c.retention = true, "K3"
	g.spanUnit(c)
	if err := Finalize(g.out, t.TempDir(), "2026-09-01", "2026-09-02", finalizeOpts{}); err != nil {
		t.Fatalf("K3 units refused at 100%% universes: %v", err)
	}
}

// The list builder: first migration per mint, its window, sorted; a dir with no units
// is refused. Its output loads as a migration list.
func TestMigrationListFromUnits(t *testing.T) {
	out := t.TempDir()
	dir := filepath.Join(out, "units", "1046", "1-2")
	os.MkdirAll(dir, 0o755)
	ev := func(prog, name, mint string, bt int64) string {
		b, _ := json.Marshal(map[string]any{"block_time": bt, "program": prog, "event": name, "fields": map[string]string{"mint": mint}})
		return string(b)
	}
	lines := strings.Join([]string{ev("pump", "CompletePumpAmmMigrationEvent", k3Mint2, 500), ev("pump", "CreateEvent", k3Pool, 400),
		ev("pump", "CompletePumpAmmMigrationEvent", k3Mint, 300), ev("pump", "CompletePumpAmmMigrationEvent", k3Mint, 200), ev("amm", "CompletePumpAmmMigrationEvent", k3Pool2, 100)}, "\n") + "\n"
	writeZst(t, filepath.Join(dir, "events.jsonl.zst"), []byte(lines))
	os.WriteFile(filepath.Join(dir, "stats.json"), []byte("{}"), 0o644)
	got, err := migrationList([]string{out}, pmHorizonS, "", 0)
	want := []string{k3Mint + " 200 18200", k3Mint2 + " 500 18500"}
	if err != nil || strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("list %v %v", got, err)
	}
	p := writeList(t, got...)
	if l, _, err := loadMigrationList(p); err != nil || len(l) != 2 {
		t.Fatalf("built list does not load: %v", err)
	}
	if _, err := migrationList([]string{t.TempDir()}, pmHorizonS, "", 0); err == nil {
		t.Fatal("a dir without units accepted")
	}
}

// D's list = the earlier days' list (only windows reaching D) + D's own migrations; a mint
// already listed keeps its earlier migration; the horizon is PM-01's 300 min.
func TestMigrationListMergesPriorDays(t *testing.T) {
	if pmHorizonS != 18000 {
		t.Fatalf("horizon %d s, PM-01 PREREG §3 says 300 min", pmHorizonS)
	}
	out := t.TempDir()
	dir := filepath.Join(out, "units", "1046", "1-2")
	os.MkdirAll(dir, 0o755)
	b, _ := json.Marshal(map[string]any{"block_time": 100000, "program": "pump", "event": "CompletePumpAmmMigrationEvent", "fields": map[string]string{"mint": k3Mint2}})
	b2, _ := json.Marshal(map[string]any{"block_time": 100100, "program": "pump", "event": "CompletePumpAmmMigrationEvent", "fields": map[string]string{"mint": k3Mint}})
	writeZst(t, filepath.Join(dir, "events.jsonl.zst"), append(append(append(b, '\n'), b2...), '\n'))
	os.WriteFile(filepath.Join(dir, "stats.json"), []byte("{}"), 0o644)
	// prior: k3Mint migrated the day before (window reaches the day), k3Pool's mint ended before it.
	prior := writeList(t, k3Mint+" 90000 108000", k3Pool2+" 70000 80000")
	got, err := migrationList([]string{out}, pmHorizonS, prior, 86400*1+0)
	want := []string{k3Mint + " 90000 108000", k3Mint2 + " 100000 118000"}
	if err != nil || strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("merged list %v %v, want %v", got, err, want)
	}
}
