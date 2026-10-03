package main

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gagliardetto/solana-go"
	"github.com/klauspost/compress/zstd"
)

// fixture writes scanner units into a temp dir.
type fixture struct {
	t   *testing.T
	out string
}

type fxUnit struct {
	epoch, from, to uint64
	t0              int64 // block time of the first block; one block per slot, 1 s apart
	blocks          int
	events          []map[string]any
	curve           [][]string
	rev             string
	skipRows        bool // events-only unit (as shipped for lead-in days)
	curveHeader     []string
}

func writeZst(t *testing.T, path string, data []byte) {
	t.Helper()
	var buf bytes.Buffer
	zw, _ := zstd.NewWriter(&buf)
	zw.Write(data)
	zw.Close()
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
}

func csvBytes(header []string, rows [][]string) []byte {
	var b bytes.Buffer
	w := csv.NewWriter(&b)
	w.Write(header)
	w.WriteAll(rows)
	return b.Bytes()
}

func (f *fixture) unit(u fxUnit) {
	t := f.t
	dir := filepath.Join(f.out, "units", strconv.FormatUint(u.epoch, 10), strconv.FormatUint(u.from, 10)+"-"+strconv.FormatUint(u.to, 10))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	var blocks [][]string
	for i := 0; i < u.blocks; i++ {
		s := u.from + uint64(i)
		blocks = append(blocks, []string{strconv.FormatUint(s, 10), strconv.FormatInt(u.t0+int64(i), 10), strconv.FormatUint(s-1, 10), "1", "0", "0", "0", "0", "0"})
	}
	writeZst(t, filepath.Join(dir, "blocks.csv.zst"), csvBytes(blockCols, blocks))
	var ev []byte
	for _, e := range u.events {
		b, _ := json.Marshal(e)
		ev = append(append(ev, b...), '\n')
	}
	writeZst(t, filepath.Join(dir, "events.jsonl.zst"), ev)
	if !u.skipRows {
		h := u.curveHeader
		if h == nil {
			h = curveCols
		}
		writeZst(t, filepath.Join(dir, "curve_trades.csv.zst"), csvBytes(h, u.curve))
		writeZst(t, filepath.Join(dir, "amm_trades.csv.zst"), csvBytes(ammCols, nil))
		writeZst(t, filepath.Join(dir, "failed.csv.zst"), csvBytes(failedCols, nil))
		writeZst(t, filepath.Join(dir, "agg_hourly.csv.zst"), csvBytes(aggCols, nil))
		writeZst(t, filepath.Join(dir, "raw.jsonl.zst"), nil)
	}
	rev := u.rev
	if rev == "" {
		rev = "r1"
	}
	st := UnitStats{Schema: schemaVersion, Epoch: u.epoch, FromSlot: u.from, ToSlot: u.to, Blocks: u.blocks,
		FirstBlockSlot: u.from, LastBlockSlot: u.from + uint64(u.blocks) - 1, FirstBlockTime: u.t0, LastBlockTime: u.t0 + int64(u.blocks) - 1,
		ScannerRevision: rev, SampleRate: 0.05}
	b, _ := json.Marshal(&st)
	if err := os.WriteFile(filepath.Join(dir, "stats.json"), b, 0o644); err != nil {
		t.Fatal(err)
	}
}

func day(s string) int64 { d, _ := time.Parse("2006-01-02", s); return d.Unix() }

// sampledMint returns a mint inside every 5% universe.
func sampledMint(t *testing.T) string {
	for i := 0; i < 20000; i++ {
		if m := solana.NewWallet().PublicKey().String(); func() bool { h, _ := mintHashFraction(m); return h < 0.05 }() {
			return m
		}
	}
	t.Fatal("no sampled mint")
	return ""
}

func curveRow(slot uint64, bt int64, mint string) []string {
	r := make([]string, len(curveCols))
	r[0], r[1], r[2], r[3], r[4], r[8], r[9], r[10], r[11] = strconv.FormatUint(slot, 10), strconv.FormatInt(bt, 10), "0", "0", "sig", mint, "1", "100", "1000"
	return r
}

// twoDays builds one unit per day for days d0 and d0+1 (slots 1000.., 2 blocks per day
// edge) so coverage spans both whole days.
func readDataset(t *testing.T, ds string) (manifest map[string]any, rows map[string][][]string) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(ds, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	json.Unmarshal(b, &manifest)
	rows = map[string][][]string{}
	files, _ := filepath.Glob(filepath.Join(ds, "days", "*", "curve_trades-*.csv.zst"))
	for _, f := range files {
		first := true
		readCSVZst(f, func(rec []string) error {
			if !first {
				rows["curve"] = append(rows["curve"], append([]string(nil), rec...))
			}
			first = false
			return nil
		})
	}
	return
}

// span: a unit whose blocks cover [start, end] once per 3600 s (enough for coverage).
func spanUnit(epoch, from uint64, start, end int64) fxUnit {
	n := int((end-start)/3600) + 1
	u := fxUnit{epoch: epoch, from: from, to: from + uint64(n) - 1, t0: start, blocks: n}
	return u
}

// hourly blocks: rewrite block times so block i is at start+i*3600.
func (f *fixture) spanUnit(u fxUnit) {
	f.unit(u)
	dir := filepath.Join(f.out, "units", strconv.FormatUint(u.epoch, 10), strconv.FormatUint(u.from, 10)+"-"+strconv.FormatUint(u.to, 10))
	var blocks [][]string
	for i := 0; i < u.blocks; i++ {
		s := u.from + uint64(i)
		blocks = append(blocks, []string{strconv.FormatUint(s, 10), strconv.FormatInt(u.t0+int64(i)*3600, 10), strconv.FormatUint(s-1, 10), "1", "0", "0", "0", "0", "0"})
	}
	writeZst(f.t, filepath.Join(dir, "blocks.csv.zst"), csvBytes(blockCols, blocks))
	var st UnitStats
	b, _ := os.ReadFile(filepath.Join(dir, "stats.json"))
	json.Unmarshal(b, &st)
	st.LastBlockTime = u.t0 + int64(u.blocks-1)*3600
	b, _ = json.Marshal(&st)
	os.WriteFile(filepath.Join(dir, "stats.json"), b, 0o644)
}

func TestFinalizeNoLookAheadForGraduates(t *testing.T) {
	// A mint sampled for launch and grad graduates 100 h after creation. Its row at
	// +80 h lies after the 72 h launch tape and before graduation: a non-graduating
	// launch mint would have no row there, so it must be excluded. The old single
	// span (creation to graduation + 15 days) kept it.
	f := &fixture{t: t, out: t.TempDir()}
	m := sampledMint(t)
	start := day("2026-09-01") - 3600
	end := day("2026-09-07")
	u := spanUnit(1, 1000, start, end)
	created := day("2026-09-01") + 3600
	graduated := created + 100*3600
	u.events = []map[string]any{
		{"slot": 1001, "block_time": created, "tx_idx": 0, "event": "CreateEvent", "fields": map[string]string{"mint": m}},
		{"slot": 1100, "block_time": graduated, "tx_idx": 0, "event": "CompletePumpAmmMigrationEvent", "fields": map[string]string{"mint": m, "pool": "P"}},
	}
	u.curve = [][]string{curveRow(1010, created+10*3600, m), curveRow(1080, created+80*3600, m), curveRow(1101, graduated+3600, m)}
	f.spanUnit(u)
	ds := t.TempDir()
	if err := Finalize(f.out, ds, "2026-09-01", "2026-09-07", finalizeOpts{}); err != nil {
		t.Fatal(err)
	}
	_, rows := readDataset(t, ds)
	got := map[string]bool{}
	for _, r := range rows["curve"] {
		got[r[1]] = true
	}
	if got[strconv.FormatInt(created+80*3600, 10)] {
		t.Fatalf("row between the launch tape and graduation is in the dataset (look-ahead)")
	}
	if !got[strconv.FormatInt(created+10*3600, 10)] || !got[strconv.FormatInt(graduated+3600, 10)] {
		t.Fatalf("rows inside the launch or grad tape missing: %v", got)
	}
}

func TestFinalizeDeterministicAndListsEveryDay(t *testing.T) {
	f := &fixture{t: t, out: t.TempDir()}
	m := sampledMint(t)
	end := day("2026-09-02") - 1 // covers 1 Sep only: no block on 2 Sep
	u := spanUnit(1, 1000, end-25*3600, end)
	u.events = []map[string]any{{"slot": 1002, "block_time": day("2026-09-01") + 100, "tx_idx": 0, "event": "CreateEvent", "fields": map[string]string{"mint": m}}}
	u.curve = [][]string{curveRow(1002, day("2026-09-01")+100, m), curveRow(1003, day("2026-09-01")+200, m)}
	u.curve[1][2] = "1"
	f.spanUnit(u)
	var sums []string
	for i := 0; i < 2; i++ {
		ds := t.TempDir()
		if err := Finalize(f.out, ds, "2026-09-01", "2026-09-03", finalizeOpts{}); err != nil {
			t.Fatal(err)
		}
		man, rows := readDataset(t, ds)
		if len(rows["curve"]) != 2 {
			t.Fatalf("got %d curve rows", len(rows["curve"]))
		}
		days := man["days"].([]any)
		if len(days) != 2 {
			t.Fatalf("window has 2 days, manifest lists %d", len(days))
		}
		d2 := days[1].(map[string]any)
		if d2["day"] != "2026-09-02" || d2["complete"] != false {
			t.Fatalf("day without full coverage must be listed as incomplete: %v", d2)
		}
		mb, _ := os.ReadFile(filepath.Join(ds, "manifest.json"))
		if bytes.Contains(mb, []byte("generated_at")) {
			t.Fatalf("manifest carries a timestamp")
		}
		var all []string
		filepath.Walk(ds, func(p string, fi os.FileInfo, err error) error {
			if fi.Mode().IsRegular() {
				s, _ := fileSum(p)
				rel, _ := filepath.Rel(ds, p)
				all = append(all, rel+" "+s.sum)
			}
			return nil
		})
		sums = append(sums, strings.Join(all, "\n"))
	}
	if sums[0] != sums[1] {
		t.Fatalf("finalize is not deterministic:\n%s\n---\n%s", sums[0], sums[1])
	}
}

func TestFinalizeLeadInAndRevisions(t *testing.T) {
	f := &fixture{t: t, out: t.TempDir()}
	f.spanUnit(spanUnit(1, 1000, day("2026-09-10")-3600, day("2026-09-11")+1800))
	ds := t.TempDir()
	if err := Finalize(f.out, ds, "2026-09-10", "2026-09-11", finalizeOpts{LeadInDays: 14}); err == nil || !strings.Contains(err.Error(), "lead-in") {
		t.Fatalf("missing lead-in accepted: %v", err)
	}
	if err := Finalize(f.out, ds, "2026-09-10", "2026-09-11", finalizeOpts{}); err != nil {
		t.Fatal(err)
	}
	u2 := spanUnit(1, 2000, day("2026-09-11")+1801, day("2026-09-11")+5000)
	u2.rev = "r2"
	f.spanUnit(u2)
	if err := Finalize(f.out, ds, "2026-09-10", "2026-09-11", finalizeOpts{AllowGaps: true}); err == nil || !strings.Contains(err.Error(), "revisions") {
		t.Fatalf("mixed scanner revisions accepted: %v", err)
	}
	if err := Finalize(f.out, ds, "2026-09-10", "2026-09-11", finalizeOpts{AllowGaps: true, AllowRevisions: []string{"r1", "r2"}}); err != nil {
		t.Fatalf("listed revisions refused: %v", err)
	}
}

func TestFinalizeHeaderCopyAndBeforeWindowUnits(t *testing.T) {
	f := &fixture{t: t, out: t.TempDir()}
	m := sampledMint(t)
	// Lead-in unit before the window: events only (no row files), as assembled.
	lead := spanUnit(1, 1000, day("2026-09-01")-3600, day("2026-09-02")-1)
	lead.skipRows = true
	lead.events = []map[string]any{{"slot": 1001, "block_time": day("2026-09-01") + 10, "tx_idx": 0, "event": "CreateEvent", "fields": map[string]string{"mint": m}}}
	f.spanUnit(lead)
	// Window unit written by an older scanner: its own, shorter curve header.
	old := append([]string(nil), curveCols[:12]...)
	win := spanUnit(1, lead.to+1, day("2026-09-02"), day("2026-09-03")+1800)
	win.curveHeader = old
	r := curveRow(win.from, day("2026-09-02")+60, m)[:12]
	win.curve = [][]string{r}
	f.spanUnit(win)
	// the window unit's first block must name the lead unit's last block
	ds := t.TempDir()
	if err := Finalize(f.out, ds, "2026-09-02", "2026-09-03", finalizeOpts{LeadInDays: 1}); err != nil {
		t.Fatal(err)
	}
	files, _ := filepath.Glob(filepath.Join(ds, "days", "2026-09-02", "curve_trades-*.csv.zst"))
	var header []string
	n := 0
	readCSVZst(files[0], func(rec []string) error {
		if header == nil {
			header = append([]string(nil), rec...)
		} else {
			n++
		}
		return nil
	})
	if strings.Join(header, ",") != strings.Join(old, ",") {
		t.Fatalf("header not copied from the units: %v", header)
	}
	if n != 1 {
		t.Fatalf("launch row created in the lead-in missing: %d rows", n)
	}
}

func TestFinalizeFirstSeenSlotIsMinimumOverUnits(t *testing.T) {
	f := &fixture{t: t, out: t.TempDir()}
	a := spanUnit(1, 1000, day("2026-09-01")-3600, day("2026-09-01")+3600)
	b := spanUnit(1, a.from+3, day("2026-09-01")+7200, day("2026-09-02")+1800)
	f.spanUnit(a)
	f.spanUnit(b)
	set := func(u fxUnit, fs map[string]uint64) {
		p := filepath.Join(f.out, "units", "1", strconv.FormatUint(u.from, 10)+"-"+strconv.FormatUint(u.to, 10), "stats.json")
		var st UnitStats
		bs, _ := os.ReadFile(p)
		json.Unmarshal(bs, &st)
		st.FirstSeen = fs
		bs, _ = json.Marshal(&st)
		os.WriteFile(p, bs, 0o644)
	}
	set(a, map[string]uint64{"unknown:pump:a943276d6686b6e8": 1002})
	set(b, map[string]uint64{"unknown:pump:a943276d6686b6e8": 1004, "extra:pump:TradeEvent:8": 1005})
	ds := t.TempDir()
	if err := Finalize(f.out, ds, "2026-09-01", "2026-09-02", finalizeOpts{}); err != nil {
		t.Fatal(err)
	}
	man, _ := readDataset(t, ds)
	fs := man["first_seen_slot"].(map[string]any)
	if fs["unknown:pump:a943276d6686b6e8"] != float64(1002) || fs["extra:pump:TradeEvent:8"] != float64(1005) {
		t.Fatalf("first_seen_slot %v", fs)
	}
}
