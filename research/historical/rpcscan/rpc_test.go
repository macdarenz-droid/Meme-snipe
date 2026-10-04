package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gagliardetto/solana-go"
	"github.com/klauspost/compress/zstd"
)

// The archive's stored TransactionError bytes, as written in the comparison unit's
// failed rows, against the RPC JSON of the same errors.
func TestTxErrorBincodeMatchesArchiveBytes(t *testing.T) {
	cases := map[string]string{
		`{"InstructionError":[0,{"Custom":7}]}`:              "08000000001900000007000000",
		`{"InstructionError":[3,{"Custom":6042}]}`:           "0800000003190000009a170000",
		`{"InstructionError":[4,"ProgramFailedToComplete"]}`: "080000000428000000",
		`{"InstructionError":[3,"IllegalOwner"]}`:            "080000000331000000",
		`"AccountInUse"`:                                                "00000000",
		`"BlockhashNotFound"`:                                           "07000000",
		`{"DuplicateInstruction":2}`:                                    "1e00000002",
		`{"InsufficientFundsForRent":{"account_index":3}}`:              "1f00000003",
		`{"ProgramExecutionTemporarilyRestricted":{"account_index":1}}`: "2300000001",
		`{"InstructionError":[1,{"BorshIoError":"ab"}]}`:                "08000000012c000000" + "0200000000000000" + "6162",
		`{"InstructionError":[1,"BorshIoError"]}`:                       "08000000012c000000",
	}
	for in, want := range cases {
		got, err := txErrorBincode(json.RawMessage(in))
		if err != nil {
			t.Fatalf("%s: %v", in, err)
		}
		if hex.EncodeToString(got) != want {
			t.Fatalf("%s: got %x, want %s", in, got, want)
		}
	}
}

func TestTxErrorBincodeRefusesUnknownShapes(t *testing.T) {
	for _, in := range []string{`"NoSuchError"`, `"InstructionError"`, `{"InstructionError":[0,{"NoSuch":1}]}`,
		`{"InstructionError":[300,"GenericError"]}`, `{"InstructionError":[0,"Custom"]}`, `{"InstructionError":[0]}`,
		`{"AccountInUse":1}`, `{"DuplicateInstruction":"x"}`, `{"InsufficientFundsForRent":{}}`, `42`, `{"A":1,"B":2}`} {
		if b, err := txErrorBincode(json.RawMessage(in)); err == nil {
			t.Fatalf("%s: accepted as %x", in, b)
		}
	}
}

// The re-encoded meta reads back through the archive parser with every field the
// scanner uses, including the not-recorded flags and absent stack heights.
func TestRPCMetaProtoRoundTrip(t *testing.T) {
	w1 := mustPKpub(attrMint)
	sh := `2`
	meta := `{"err":{"InstructionError":[1,{"Custom":6001}]},"fee":5000,"preBalances":[10,0,7],"postBalances":[4,6,7],
	"innerInstructions":[{"index":1,"instructions":[{"programIdIndex":2,"accounts":[0,1],"data":"3Bxs4h24hBtQy9rw","stackHeight":` + sh + `},{"programIdIndex":2,"accounts":[],"data":"","stackHeight":null}]}],
	"logMessages":[],"preTokenBalances":[{"accountIndex":1,"mint":"` + attrMint + `","owner":"` + w1.String() + `","programId":"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA","uiTokenAmount":{"amount":"0","decimals":6,"uiAmount":null,"uiAmountString":"0"}}],
	"postTokenBalances":[{"accountIndex":1,"mint":"` + attrMint + `","uiTokenAmount":{"amount":"12","decimals":6}}],
	"loadedAddresses":{"writable":["` + w1.String() + `"],"readonly":[]},"computeUnitsConsumed":777,"rewards":[],"status":{"Err":{}}}`
	var mj rpcMetaJSON
	if err := json.Unmarshal([]byte(meta), &mj); err != nil {
		t.Fatal(err)
	}
	b, err := rpcMetaProto(&mj)
	if err != nil {
		t.Fatal(err)
	}
	m, err := fullMeta(b)
	if err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(m.Err.Err) != "08000000011900000071170000" {
		t.Fatalf("err %x", m.Err.Err)
	}
	if m.Fee != 5000 || fmt.Sprint(m.PreBalances) != "[10 0 7]" || fmt.Sprint(m.PostBalances) != "[4 6 7]" {
		t.Fatalf("fee/balances %d %v %v", m.Fee, m.PreBalances, m.PostBalances)
	}
	if m.InnerInstructionsNone || m.LogMessagesNone || m.LogMessages != nil {
		t.Fatalf("recorded-and-empty logs and recorded inner instructions must not be flagged none")
	}
	ii := m.InnerInstructions
	if len(ii) != 1 || ii[0].Index != 1 || len(ii[0].Instructions) != 2 {
		t.Fatalf("inner %+v", ii)
	}
	a, z := ii[0].Instructions[0], ii[0].Instructions[1]
	if a.ProgramIdIndex != 2 || hex.EncodeToString(a.Accounts) != "0001" || a.StackHeight == nil || *a.StackHeight != 2 || len(a.Data) == 0 {
		t.Fatalf("inner 0 %+v", a)
	}
	if z.StackHeight != nil || len(z.Data) != 0 || len(z.Accounts) != 0 {
		t.Fatalf("inner 1: null stack height must stay absent, empty data empty: %+v", z)
	}
	if len(m.PreTokenBalances) != 1 || m.PreTokenBalances[0].Owner != w1.String() || m.PreTokenBalances[0].UiTokenAmount.Amount != "0" || m.PreTokenBalances[0].UiTokenAmount.Decimals != 6 {
		t.Fatalf("pre token %+v", m.PreTokenBalances[0])
	}
	if m.PostTokenBalances[0].Owner != "" || m.PostTokenBalances[0].ProgramId != "" || m.PostTokenBalances[0].UiTokenAmount.Amount != "12" {
		t.Fatalf("post token: omitted owner and program stay empty: %+v", m.PostTokenBalances[0])
	}
	if len(m.LoadedWritableAddresses) != 1 || string(m.LoadedWritableAddresses[0]) != string(w1[:]) || len(m.LoadedReadonlyAddresses) != 0 {
		t.Fatalf("loaded addresses")
	}
	if m.ComputeUnitsConsumed == nil || *m.ComputeUnitsConsumed != 777 {
		t.Fatalf("cu")
	}
	// Not recorded (null or absent) is flagged, as the archive does.
	var none rpcMetaJSON
	json.Unmarshal([]byte(`{"err":null,"fee":1,"preBalances":[],"postBalances":[],"innerInstructions":null}`), &none)
	b, _ = rpcMetaProto(&none)
	m, _ = fullMeta(b)
	if !m.InnerInstructionsNone || !m.LogMessagesNone || m.Err != nil {
		t.Fatalf("null inner instructions and absent logs must be flagged not recorded, null err no error")
	}
}

func TestRPCBlockRefusesIncompleteBlocks(t *testing.T) {
	for _, in := range []string{`{"parentSlot":1,"transactions":[]}`, `{"blockTime":1,"transactions":[]}`,
		`{"blockTime":1,"parentSlot":1,"signatures":["x"]}`, `{"blockTime":1,"parentSlot":1,"transactions":[{"transaction":"AAAA","meta":null}]}`,
		`{"blockTime":1,"parentSlot":1,"transactions":[{"transaction":["AAAA","base58"],"meta":null}]}`} {
		if _, err := rpcBlock(5, []byte(in)); err == nil {
			t.Fatalf("accepted %s", in)
		}
	}
	b, err := rpcBlock(5, []byte(`{"blockTime":9,"parentSlot":3,"transactions":[]}`))
	if err != nil || b.parent != 3 || b.blockTime != 9 || b.txNodes == nil || len(b.txNodes) != 0 || b.frames == nil {
		t.Fatalf("an empty block is a block: %+v %v", b, err)
	}
}

// An encoded Transaction node reads back through the scanner's txNode: payloads of
// every CBOR length form, the position, and an empty (missing) meta.
func TestArchiveTxNodeReadsBackThroughTxNode(t *testing.T) {
	get := func(string) (*frame, error) { return nil, errors.New("no frames") }
	for _, n := range []int{0, 23, 24, 255, 256, 65535, 65536, 300000} {
		tx := make([]byte, n)
		for i := range tx {
			tx[i] = byte(i * 7)
		}
		meta := append([]byte("meta"), tx...)
		for _, idx := range []int{0, 23, 1000, 70000} {
			d, m, i, err := txNode(archiveTxNode(452277009, idx, tx, meta), get)
			if err != nil || string(d) != string(tx) || string(m) != string(meta) || i != idx {
				t.Fatalf("n=%d idx=%d: %v (index %d)", n, idx, err, i)
			}
		}
	}
	if _, m, _, err := txNode(archiveTxNode(1, 0, []byte{1}, nil), get); err != nil || len(m) != 0 {
		t.Fatalf("empty meta: %v %d", err, len(m))
	}
}

// Length-prefixed lines: the same bytes split differently never hash alike.
func TestHashLinesSplitsDiffer(t *testing.T) {
	if hashLines([]string{"ab", "c"}) == hashLines([]string{"a", "bc"}) || hashLines([]string{"a\nb"}) == hashLines([]string{"a", "b"}) {
		t.Fatalf("different line splits hash alike")
	}
}

// Real blocks of the comparison unit, as the public mainnet RPC returned them
// (getBlock, base64, full, maxSupportedTransactionVersion 1), give exactly the
// archive's rows: every table's per-block digest equals the committed baseline's
// (made from the archive unit), except raw records whose log the RPC cut at its size
// limit, and each of those must be explained record by record. 452277901 holds such a
// record. RPC_FIXTURES=DIR runs the same check over more recorded blocks.
func TestRPCBlocksMatchArchiveRows(t *testing.T) {
	defer func(s float64) { sampleRate = s }(sampleRate)
	sampleRate = 0.05 // the baseline unit's sample
	base, err := readDigest("../pilot/baseline-1046-452277000-452281499.json.zst")
	if err != nil {
		t.Fatal(err)
	}
	dir := "testdata/rpc"
	if d := os.Getenv("RPC_FIXTURES"); d != "" {
		dir = d
	}
	slots, err := dirSource{dir}.producedSlots(context.Background(), 0, 1<<62)
	if err != nil || len(slots) == 0 {
		t.Fatalf("fixtures: %v", err)
	}
	out := t.TempDir()
	compared, explained := 0, 0
	for _, slot := range slots {
		udir := filepath.Join(out, fmt.Sprint(slot))
		st, err := RPCUnit(context.Background(), dirSource{dir}, 1046, slot, slot, udir, 2, 2)
		if err != nil {
			t.Fatal(err)
		}
		if st.Blocks != 1 || st.SkippedSlots != 0 || st.DecodeFailures != 0 || st.MissingMeta != 0 {
			t.Fatalf("slot %d: %+v", slot, st)
		}
		d, err := digestUnit(udir)
		if err != nil {
			t.Fatal(err)
		}
		s := fmt.Sprint(slot)
		for _, tb := range []string{"blocks", "curve_trades", "amm_trades", "failed", "movements", "raw", "events"} {
			want, got := base.Tables[tb].Blocks[s], d.Tables[tb].Blocks[s]
			if want != "" {
				compared++
			}
			if want == got {
				continue
			}
			if tb != "raw" || !rawDiffExplained(base.Tables["raw"], d.Tables["raw"], []string{s}) {
				t.Fatalf("slot %d %s: block digest %q, archive %q", slot, tb, got, want)
			}
			explained++
		}
	}
	if compared < 10 || (dir == "testdata/rpc" && explained != 1) {
		t.Fatalf("compared %d table blocks, %d explained by truncated logs", compared, explained)
	}
	t.Logf("%d blocks: %d table blocks compared, %d raw blocks explained by truncated logs", len(slots), compared, explained)
}

func TestDirSourceAndSkippedSlots(t *testing.T) {
	dir := t.TempDir()
	write := func(slot uint64, body string) {
		os.WriteFile(filepath.Join(dir, fmt.Sprintf("%d.json", slot)), []byte(body), 0o644)
	}
	write(10, `{"jsonrpc":"2.0","result":{"blockTime":100,"parentSlot":8,"transactions":[]},"id":1}`)
	write(12, `{"jsonrpc":"2.0","result":{"blockTime":101,"parentSlot":10,"transactions":[]},"id":1}`)
	st, err := RPCUnit(context.Background(), dirSource{dir}, 0, 9, 13, filepath.Join(dir, "u"), 3, 1)
	if err != nil {
		t.Fatal(err)
	}
	if st.Blocks != 2 || st.SkippedSlots != 3 || st.FirstBlockSlot != 10 || st.FirstParentSlot != 8 || st.LastBlockSlot != 12 {
		t.Fatalf("%+v", st)
	}
	if _, err := os.Stat(filepath.Join(dir, "u", "stats.json")); err != nil {
		t.Fatal(err)
	}
	// A listed slot whose block is reported skipped is a gap, not a skip.
	write(13, `{"jsonrpc":"2.0","error":{"code":-32009,"message":"Slot 13 was skipped, or missing in long-term storage"},"id":1}`)
	_, err = RPCUnit(context.Background(), dirSource{dir}, 0, 9, 13, filepath.Join(dir, "v"), 2, 1)
	if err == nil || !errors.Is(err, errSlotSkipped) || !strings.Contains(err.Error(), "listed as produced") {
		t.Fatalf("want a gap error, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "v")); !os.IsNotExist(err) {
		t.Fatalf("a failed unit must leave no unit directory")
	}
	// A parent link that skips a produced block is a chain break.
	os.Remove(filepath.Join(dir, "13.json"))
	write(14, `{"jsonrpc":"2.0","result":{"blockTime":102,"parentSlot":11,"transactions":[]},"id":1}`)
	if _, err := RPCUnit(context.Background(), dirSource{dir}, 0, 9, 14, filepath.Join(dir, "w"), 2, 1); err == nil || !strings.Contains(err.Error(), "parent-link") {
		t.Fatalf("want a parent-link break, got %v", err)
	}
}

// A many-block unit read with more fetchers than the window is ever short of: blocks
// arrive out of order (later slots answer first) and are still written in slot order.
func TestRPCUnitOrdersOutOfOrderFetches(t *testing.T) {
	src := &slowSource{n: 60}
	st, err := RPCUnit(context.Background(), src, 0, 0, 59, filepath.Join(t.TempDir(), "u"), 7, 3)
	if err != nil {
		t.Fatal(err)
	}
	if st.Blocks != 60 || len(st.ChainBreaks) != 0 {
		t.Fatalf("%+v", st)
	}
}

type slowSource struct{ n uint64 }

func (s *slowSource) producedSlots(context.Context, uint64, uint64) ([]uint64, error) {
	out := make([]uint64, s.n)
	for i := range out {
		out[i] = uint64(i)
	}
	return out, nil
}

func (s *slowSource) block(_ context.Context, slot uint64) ([]byte, error) {
	time.Sleep(time.Duration((s.n-slot)%7) * time.Millisecond)
	parent := slot - 1
	if slot == 0 {
		parent = 0
	}
	return []byte(fmt.Sprintf(`{"blockTime":%d,"parentSlot":%d,"transactions":[]}`, 1000+slot, parent)), nil
}

// The Helius client: the key never appears in an error, 429s back off (Retry-After or
// doubling) and are counted, the credit cap stops before sending, and the back-off
// budget stops resumably.
func TestHeliusClientKeyCapAndBackoff(t *testing.T) {
	const key = "sekret-key-123"
	var hits atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("api-key") != key {
			t.Errorf("key not sent as api-key")
		}
		n := hits.Add(1)
		switch {
		case n == 1:
			w.Header().Set("Retry-After", "1")
			w.WriteHeader(429)
		case n == 2:
			w.Write([]byte(`{"jsonrpc":"2.0","error":{"code":429,"message":"Too many requests for a specific RPC call"},"id":1}`))
		case n == 3:
			w.Write([]byte(`{"jsonrpc":"2.0","result":[5,7],"id":1}`))
		default:
			w.WriteHeader(500)
		}
	}))
	defer srv.Close()
	t.Setenv("HELIUS_API_KEY", key)
	mk := func(credits int64, backoff time.Duration) *heliusClient {
		fs := newTestFlagSet()
		hc := heliusFlags(fs)
		fs.Parse([]string{"-helius-url", srv.URL + "/", "-max-credits", fmt.Sprint(credits), "-rps", "100", "-max-backoff", backoff.String()})
		h, err := hc.client()
		if err != nil {
			t.Fatal(err)
		}
		return h
	}
	h := mk(10, time.Minute)
	slots, err := h.producedSlots(context.Background(), 1, 9)
	if err != nil || fmt.Sprint(slots) != "[5 7]" {
		t.Fatalf("%v %v", slots, err)
	}
	u := h.usage()
	if u.Credits != 3 || u.Status429 != 2 || u.Retries != 2 || u.Requests != 1 || u.WaitedSeconds < 2 {
		t.Fatalf("usage %+v", u)
	}
	// Past the cap nothing is sent.
	before := hits.Load()
	hc := mk(1, time.Minute)
	hc.Credits.Store(1)
	if _, err := hc.producedSlots(context.Background(), 1, 2); !errors.Is(err, errCreditCap) || hits.Load() != before {
		t.Fatalf("cap: %v, sent %d", err, hits.Load()-before)
	}
	// 5xx keeps failing: the back-off budget ends the call resumably, and the error
	// carries no key.
	hb := mk(100, 2*time.Second)
	_, err = hb.block(context.Background(), 3)
	if !errors.Is(err, errBackoffBudget) || strings.Contains(err.Error(), key) {
		t.Fatalf("budget: %v", err)
	}
	// A connection error names no URL and no key.
	t.Setenv("HELIUS_API_KEY", key)
	fs := newTestFlagSet()
	hcfg := heliusFlags(fs)
	fs.Parse([]string{"-helius-url", "http://127.0.0.1:1/", "-max-credits", "5", "-max-backoff", "1s"})
	hd, _ := hcfg.client()
	_, err = hd.block(context.Background(), 3)
	if err == nil || strings.Contains(err.Error(), key) || strings.Contains(err.Error(), "127.0.0.1:1/?") {
		t.Fatalf("connection error leaks: %v", err)
	}
	// A refusal whose body echoes the request (and so the key) is scrubbed.
	echo := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		w.Write([]byte("invalid api key " + r.URL.Query().Get("api-key")))
	}))
	defer echo.Close()
	fs3 := newTestFlagSet()
	h3 := heliusFlags(fs3)
	fs3.Parse([]string{"-helius-url", echo.URL + "/", "-max-credits", "5"})
	he, _ := h3.client()
	_, err = he.block(context.Background(), 3)
	if err == nil || strings.Contains(err.Error(), key) || !strings.Contains(err.Error(), "401") {
		t.Fatalf("refusal leaks or is lost: %v", err)
	}
	// Without a key, or without a cap, the client is refused.
	t.Setenv("HELIUS_API_KEY", "")
	if _, err := hcfg.client(); err == nil {
		t.Fatalf("no key accepted")
	}
	t.Setenv("HELIUS_API_KEY", key)
	fs2 := newTestFlagSet()
	h2 := heliusFlags(fs2)
	fs2.Parse(nil)
	if _, err := h2.client(); err == nil {
		t.Fatalf("no credit cap accepted")
	}
}

// compareDigests names the table, column and block of a difference, and explains a
// raw-record difference only when, record by record, the candidate's log is exactly
// the archive's log under Agave's log limit and nothing else differs (review of
// 1697ddd: every condition pinned; each case below is in a block with a truncated log).
func TestCompareDigestsLocatesAndExplains(t *testing.T) {
	long := make([]string, 200) // 200 lines of 60 bytes: past the 10,000-byte limit
	for i := range long {
		long[i] = fmt.Sprintf("Program log: line %03d %s", i, strings.Repeat("x", 37))
	}
	cut := agaveLogCut(long, logLimitBytes)
	if len(cut) >= len(long) || cut[len(cut)-1] != logTruncated {
		t.Fatalf("fixture log not cut: %d lines", len(cut))
	}
	jl := func(l []string) string { b, _ := json.Marshal(l); return string(b) }
	type rec struct {
		slot, idx int
		fee       int
		logs      string
		extra     string // extra meta key
	}
	mk := func(curveFee string, recs []rec) *unitDigest {
		dir := t.TempDir()
		st := map[string]any{"epoch": 0, "from_slot": 1, "to_slot": 2, "blocks": 2, "root_cid": "x", "sample_rate": 0.05}
		b, _ := json.Marshal(st)
		os.WriteFile(filepath.Join(dir, "stats.json"), b, 0o644)
		enc, _ := zstd.NewWriter(nil)
		put := func(name, body string) {
			os.WriteFile(filepath.Join(dir, name), enc.EncodeAll([]byte(body), nil), 0o644)
		}
		put("curve_trades.csv.zst", "slot,fee,mint\n1,10,a\n2,"+curveFee+",b\n")
		var raw strings.Builder
		for _, r := range recs {
			fmt.Fprintf(&raw, `{"slot":%d,"txIndex":%d,"signature":"s%d","meta":{"fee":%d%s,"logMessages":%s}}`+"\n", r.slot, r.idx, r.idx, r.fee, r.extra, r.logs)
		}
		put("raw.jsonl.zst", raw.String())
		d, err := digestUnit(dir)
		if err != nil {
			t.Fatal(err)
		}
		return d
	}
	baseRecs := []rec{{1, 0, 5, jl(long), ""}, {1, 1, 5, `["a","b"]`, ""}, {2, 0, 5, `["c"]`, ""}}
	base := mk("20", baseRecs)
	status := func(c *digestComparison, table string) string {
		for _, tc := range c.Tables {
			if tc.Table == table {
				return tc.Status
			}
		}
		return "absent"
	}
	if c := compareDigests(base, mk("20", baseRecs)); !c.Equal {
		t.Fatalf("equal units differ: %+v", c)
	}
	// A curve difference is located by column and block.
	c := compareDigests(base, mk("21", baseRecs))
	for _, tc := range c.Tables {
		if tc.Table == "curve_trades" && (tc.Status != "differs" || fmt.Sprint(tc.ColumnsDiffer) != "[fee]" || fmt.Sprint(tc.BlocksSample) != "[2]") {
			t.Fatalf("curve difference not located: %+v", tc)
		}
	}
	// The one explained case: record 1:0's log is exactly Agave's cut of the archive's.
	truncated := []rec{{1, 0, 5, jl(cut), ""}, {1, 1, 5, `["a","b"]`, ""}, {2, 0, 5, `["c"]`, ""}}
	if c := compareDigests(base, mk("20", truncated)); !c.Equal || status(c, "raw") != "explained" {
		t.Fatalf("an exact log cut must be explained: %+v", c)
	}
	cases := map[string]struct {
		curveFee string
		recs     []rec
		table    string
	}{
		"logMessages and a second meta column differ":    {"20", []rec{{1, 0, 6, jl(cut), ""}, {1, 1, 5, `["a","b"]`, ""}, {2, 0, 5, `["c"]`, ""}}, "raw"},
		"raw row counts differ":                          {"20", []rec{{1, 0, 5, jl(cut), ""}, {1, 1, 5, `["a","b"]`, ""}, {1, 2, 5, `["z"]`, ""}, {2, 0, 5, `["c"]`, ""}}, "raw"},
		"a column on one side only":                      {"20", []rec{{1, 0, 5, jl(cut), `,"returnData":null`}, {1, 1, 5, `["a","b"]`, ""}, {2, 0, 5, `["c"]`, ""}}, "raw"},
		"a non-raw table differs":                        {"21", truncated, "curve_trades"},
		"another record's log differs in the same block": {"20", []rec{{1, 0, 5, jl(cut), ""}, {1, 1, 5, `["a","B"]`, ""}, {2, 0, 5, `["c"]`, ""}}, "raw"},
		"a truncated log that is not the archive's cut":  {"20", []rec{{1, 0, 5, jl(append(append([]string{}, cut[:len(cut)-2]...), logTruncated)), ""}, {1, 1, 5, `["a","b"]`, ""}, {2, 0, 5, `["c"]`, ""}}, "raw"},
		"a log cut where the archive's was short":        {"20", []rec{{1, 0, 5, jl(cut), ""}, {1, 1, 5, `["a","Log truncated"]`, ""}, {2, 0, 5, `["c"]`, ""}}, "raw"},
	}
	for name, k := range cases {
		c := compareDigests(base, mk(k.curveFee, k.recs))
		if c.Equal || status(c, k.table) != "differs" {
			t.Fatalf("%s: must differ (%s %s): %+v", name, k.table, status(c, k.table), c)
		}
	}
}

func newTestFlagSet() *flag.FlagSet { return flag.NewFlagSet("t", flag.ContinueOnError) }

// fakeHelius answers getFirstAvailableBlock, getBlocks and getBlock from recorded
// responses in dir.
func fakeHelius(t *testing.T, dir string) *httptest.Server {
	src := dirSource{dir}
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Method string            `json:"method"`
			Params []json.RawMessage `json:"params"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		reply := func(v any) {
			b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "result": v})
			w.Write(b)
		}
		switch req.Method {
		case "getFirstAvailableBlock":
			reply(123)
		case "getBlocks":
			var a, b uint64
			json.Unmarshal(req.Params[0], &a)
			json.Unmarshal(req.Params[1], &b)
			s, _ := src.producedSlots(context.Background(), a, b)
			if s == nil {
				s = []uint64{}
			}
			reply(s)
		case "getBlock":
			var s uint64
			json.Unmarshal(req.Params[0], &s)
			res, err := src.block(context.Background(), s)
			if err != nil {
				t.Errorf("getBlock %d: %v", s, err)
			}
			w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":` + string(res) + `}`))
		default:
			t.Errorf("unexpected method %s", req.Method)
		}
	}))
}

func TestPilotReportsParityAndUsage(t *testing.T) {
	defer func(s float64) { sampleRate = s }(sampleRate)
	sampleRate = 0.05
	tmp := t.TempDir()
	// Baseline: the same two blocks read from the recorded files (stand-in for the
	// archive unit), so the pilot over the fake Helius must find parity.
	unit := filepath.Join(tmp, "base")
	if _, err := RPCUnit(context.Background(), dirSource{"testdata/rpc"}, 1046, 452277009, 452277012, unit, 1, 1); err == nil {
		t.Fatalf("the two recorded blocks are not consecutive: a unit spanning them must break the parent chain")
	}
	// Use one block as the comparison unit.
	if _, err := RPCUnit(context.Background(), dirSource{"testdata/rpc"}, 1046, 452277009, 452277009, unit, 1, 1); err != nil {
		t.Fatal(err)
	}
	d, err := digestUnit(unit)
	if err != nil {
		t.Fatal(err)
	}
	basePath := filepath.Join(tmp, "base.json.zst")
	writeDigest(basePath, d)
	srv := fakeHelius(t, "testdata/rpc")
	defer srv.Close()
	t.Setenv("HELIUS_API_KEY", "pilot-key-xyz")
	run := func(credits int64) *pilotReport {
		fs := newTestFlagSet()
		hc := heliusFlags(fs)
		fs.Parse([]string{"-helius-url", srv.URL + "/", "-max-credits", fmt.Sprint(credits), "-rps", "200"})
		h, err := hc.client()
		if err != nil {
			t.Fatal(err)
		}
		reportPath := filepath.Join(tmp, fmt.Sprintf("report-%d.json", credits))
		rep, err := runPilot(context.Background(), h, 2, 2, defaultPilotUnits(5, 1046, 452277009, 452277009), basePath, filepath.Join(tmp, "work"), reportPath)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := os.ReadFile(reportPath)
		if strings.Contains(string(b), "pilot-key-xyz") {
			t.Fatalf("the report holds the key")
		}
		return rep
	}
	rep := run(100)
	if rep.Comparison == nil || !rep.Comparison.Equal || !strings.HasPrefix(rep.Verdict, "parity") {
		t.Fatalf("verdict %q %+v %s", rep.Verdict, rep.Comparison, rep.ComparisonError)
	}
	if rep.FirstAvailableBlock == nil || *rep.FirstAvailableBlock != 123 || len(rep.Probes) != 3 {
		t.Fatalf("report %+v", rep)
	}
	// first available + (getBlocks per probe) + the comparison unit's one block
	if rep.Usage.Credits != 1+3+1 || rep.Projection == nil || rep.Projection.BlocksEstimate <= 0 {
		t.Fatalf("usage %+v projection %+v", rep.Usage, rep.Projection)
	}
	if _, err := os.Stat(filepath.Join(tmp, "work", "units", "1046")); err == nil {
		entries, _ := os.ReadDir(filepath.Join(tmp, "work", "units", "1046"))
		if len(entries) > 0 {
			t.Fatalf("the pilot must not keep the units it read")
		}
	}
	// A credit cap below the run's need: the comparison never completes, no parity.
	rep = run(3)
	if rep.Comparison != nil || strings.HasPrefix(rep.Verdict, "parity") || rep.Usage.Credits > 3 {
		t.Fatalf("capped run: %q credits %d", rep.Verdict, rep.Usage.Credits)
	}
}

// planRPCUnits on synthetic chains (every slot produced, epochs complete up to 1002):
// at 0.4 s a slot planUnits' October estimate (0.267 s) starts the walk dozens of
// epochs before the window, at 0.2 s past the RPC's head; both walks must land on the
// archive planner's units for the window's epochs.
func TestPlanRPCUnits(t *testing.T) {
	for _, msPerSlot := range []int64{400, 200} {
		t.Run(fmt.Sprint(msPerSlot), func(t *testing.T) { planRPCCase(t, msPerSlot) })
	}
}

func planRPCCase(t *testing.T, msPerSlot int64) {
	const head = uint64(1003 * 432000) // epochs up to 1002 complete
	timeOf := func(s uint64) int64 { return 1790914653 + (int64(s)-452500000)*msPerSlot/1000 }
	var calls atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var req struct {
			Method string            `json:"method"`
			Params []json.RawMessage `json:"params"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		var a, b uint64
		json.Unmarshal(req.Params[0], &a)
		if len(req.Params) > 1 {
			json.Unmarshal(req.Params[1], &b)
		}
		var res any
		switch req.Method {
		case "getBlocksWithLimit":
			out := []uint64{}
			for s := a; s < a+b && s < head; s++ {
				out = append(out, s)
			}
			res = out
		case "getBlocks":
			out := []uint64{}
			for s := a; s <= b && s < head; s++ {
				out = append(out, s)
			}
			res = out
		case "getBlockTime":
			res = timeOf(a)
		}
		j, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "result": res})
		w.Write(j)
	}))
	defer srv.Close()
	t.Setenv("HELIUS_API_KEY", "k")
	fs := newTestFlagSet()
	hc := heliusFlags(fs)
	fs.Parse([]string{"-helius-url", srv.URL + "/", "-max-credits", "100000", "-rps", "500"})
	h, _ := hc.client()
	// A window inside epochs 995..997.
	t0 := timeOf(995*432000 + 1000)
	t1 := timeOf(997*432000 + 5000)
	units, err := planRPCUnits(context.Background(), h, t0, t1)
	if err != nil {
		t.Fatal(err)
	}
	var want []unitSpec
	for e := uint64(995); e <= 997; e++ {
		want = append(want, epochUnits(e, &blockRef{Slot: epochFirstSlot(e), BlockTime: timeOf(epochFirstSlot(e))},
			&blockRef{Slot: epochLastSlot(e), BlockTime: timeOf(epochLastSlot(e))}, t0, t1)...)
	}
	if fmt.Sprint(units) != fmt.Sprint(want) || len(units) == 0 {
		t.Fatalf("planned %d units, want %d", len(units), len(want))
	}
	if units[0].epoch != 995 || units[len(units)-1].epoch != 997 || units[0].from > 995*432000+1000 {
		t.Fatalf("window not covered: first %v last %v", units[0], units[len(units)-1])
	}
	if n := calls.Load(); n > 200 {
		t.Fatalf("%d calls to plan three epochs", n)
	}
	// A window reaching an epoch the RPC does not have complete is refused.
	if _, err := planRPCUnits(context.Background(), h, t0, timeOf(1004*432000)); !errors.Is(err, errEpochIncomplete) {
		t.Fatalf("want errEpochIncomplete, got %v", err)
	}
}

// The pilot's plan comparison: the free plan waits for monthly credits and buys none,
// Developer buys the credits beyond its 10M; latency can cap the rate below the limit.
func TestPlanCosts(t *testing.T) {
	p := planCosts(18_600_000, 0.2)
	free, dev := p[0], p[1]
	if free.Plan != "free" || free.CostUSD != 0 || free.ExtraCredits != 0 || free.MonthsOfCredits < 18.5 || free.CalendarDays < 18*30 {
		t.Fatalf("free %+v", free)
	}
	if dev.Plan != "developer" || dev.ExtraCredits != 8_600_000 || dev.CostUSD != 49+43 || dev.RequestsPerSec != 40 {
		t.Fatalf("developer %+v", dev)
	}
	if h := dev.Hours; h < 129 || h > 130 { // 18.6M / 40 per second
		t.Fatalf("developer hours %v", h)
	}
	slow := planCosts(1000, 4)[1] // 64 fetchers at 4 s each: 16 requests/s
	if slow.RequestsPerSec != 16 || slow.ExtraCredits != 0 || slow.CostUSD != 49 {
		t.Fatalf("latency-bound %+v", slow)
	}
	if !strings.Contains(free.Summary, "none can be bought") || !strings.Contains(dev.Summary, "US$92") {
		t.Fatalf("summaries: %q / %q", free.Summary, dev.Summary)
	}
}

const attrMint = "8rjKP44zZewzNGx6DyF3Ck1Ub6y45pXbures2Dx3pump"

func mustPKpub(s string) solana.PublicKey { return solana.MustPublicKeyFromBase58(s) }

// agaveLogCut is Agave's LogCollector rule, as measured on the public RPC (block
// 452277384, tx 645: a long "Program data:" line dropped, the next two short lines
// kept): a message reaching the limit is dropped, the first drop writes "Log
// truncated" once, later messages that still fit are kept.
func TestAgaveLogCut(t *testing.T) {
	if logLimitBytes != 10000 {
		t.Fatalf("Agave's default log limit is 10,000 bytes, not %d", logLimitBytes)
	}
	line := func(n int) string { return strings.Repeat("x", n) }
	logs := []string{line(9796), line(210), line(50), line(75), line(100), line(1)}
	got := agaveLogCut(logs, logLimitBytes)
	want := []string{line(9796), logTruncated, line(50), line(75), line(1)}
	if fmt.Sprint(len(got)) != fmt.Sprint(len(want)) || jsonEq(got, want) == false {
		t.Fatalf("cut %v", lens(got))
	}
	// Reaching the limit exactly is past it: limit-1 bytes, then 1 more, is dropped.
	if got := agaveLogCut([]string{line(logLimitBytes - 1), line(1)}, logLimitBytes); !jsonEq(got, []string{line(logLimitBytes - 1), logTruncated}) {
		t.Fatalf("boundary %v", lens(got))
	}
	// A log within the limit is unchanged.
	short := []string{"a", "b"}
	if got := agaveLogCut(short, logLimitBytes); !jsonEq(got, short) {
		t.Fatalf("short %v", got)
	}
}

func jsonEq(a, b []string) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return string(x) == string(y)
}

func lens(l []string) []int {
	out := make([]int, len(l))
	for i, s := range l {
		out[i] = len(s)
	}
	return out
}

// The usage file rpc-run writes is the one ci/rpc-credits.sh books: a credit count
// that is not read back would let the day's cap be passed.
func TestUsageFileBooksInRpcCredits(t *testing.T) {
	h := &heliusClient{}
	h.Credits.Store(4242)
	dir := t.TempDir()
	writeUsage(filepath.Join(dir, "u.json"), h)
	cmd := exec.Command("bash", "../ci/rpc-credits.sh", "add", dir, filepath.Join(dir, "u.json"))
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("rpc-credits add: %v %s", err, out)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "rpc-credits-used")); strings.TrimSpace(string(b)) != "4242" {
		t.Fatalf("booked %q", b)
	}
	if rpcExitCode(fmt.Errorf("x: %w", errCreditCap)) != 3 || rpcExitCode(fmt.Errorf("x: %w", errBackoffBudget)) != 75 || rpcExitCode(errors.New("x")) != 1 {
		t.Fatalf("exit codes")
	}
}
