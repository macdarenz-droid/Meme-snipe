package main

// The research decoder: one unit's spooled getBlock answers into the research tables
// (research/SHARED_TAPE_PLAN.md, SCHEMA). The scanner's processBlock runs unchanged on
// every block with every mint kept (sample rate 1), and the extras (extras.go) add F,
// W and the S columns. Blocks outside -day are dropped whole and counted, so no row
// from another day (U1-B's holdout starts 2026-09-12) is written.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Research table files of one unit.
const (
	fCurve     = "S_curve.csv.zst"
	fAmm       = "S_amm.csv.zst"
	fFailed    = "F.csv.zst"
	fTransfers = "W.csv.zst"
	fMoves     = "T.csv.zst"
	fCoverage  = "T_coverage.csv.zst"
	fDelegs    = "D.csv.zst"
	fBlocks    = "B.csv.zst"
	fEvents    = "E.jsonl.zst" // every other pump and PumpSwap event: C (creates) and G (migrations, pool creations) by event name
	fHourly    = "H.csv.zst"
)

type decodeStats struct {
	Day           string           `json:"day"`
	FromSlot      uint64           `json:"from_slot"`
	ToSlot        uint64           `json:"to_slot"`
	Blocks        int64            `json:"blocks"`
	DroppedBlocks int64            `json:"dropped_blocks"` // block time outside -day
	SkippedFiles  int64            `json:"error_answers"`  // spooled answers that hold an RPC error
	ManifestOK    int64            `json:"manifest_verified"`
	Rows          map[string]int64 `json:"rows"`
	EventNames    map[string]int64 `json:"event_names"`
	Counts        decodeCounts     `json:"counts"`
	ScanDecodeErr int64            `json:"scanner_decode_failures"`
	CPUSeconds    float64          `json:"seconds"`
	Revision      string           `json:"decoder_revision"`
}

func readManifest(dir string) (map[uint64]string, error) {
	b, err := os.ReadFile(filepath.Join(dir, "MANIFEST.tsv"))
	if err != nil {
		return nil, err
	}
	m := map[uint64]string{}
	for _, l := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		f := strings.Split(l, "\t")
		if len(f) < 2 {
			continue
		}
		s, err := strconv.ParseUint(f[0], 10, 64)
		if err != nil {
			return nil, fmt.Errorf("manifest line %q", l)
		}
		m[s] = f[1] // the last answer for a slot wins (it is the file on disk)
	}
	return m, nil
}

func spoolSlots(dir string, from, to uint64) ([]uint64, error) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var out []uint64
	for _, e := range ents {
		name := strings.TrimSuffix(e.Name(), ".zst")
		if !strings.HasSuffix(name, ".json") {
			continue
		}
		s, err := strconv.ParseUint(strings.TrimSuffix(name, ".json"), 10, 64)
		if err == nil && s >= from && s <= to {
			out = append(out, s)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out, nil
}

func readSpooled(dir string, slot uint64) ([]byte, error) {
	p := filepath.Join(dir, fmt.Sprintf("%d.json", slot))
	b, err := os.ReadFile(p)
	if os.IsNotExist(err) {
		if b, err = os.ReadFile(p + ".zst"); err == nil {
			b, err = zstdDec.DecodeAll(b, nil)
		}
	}
	return b, err
}

var errAnswer = errors.New("the answer holds an RPC error")

func rpcResultOf(body []byte) ([]byte, error) {
	var r struct {
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		return nil, err
	}
	if r.Error != nil || len(r.Result) == 0 || string(r.Result) == "null" {
		return nil, errAnswer
	}
	return r.Result, nil
}

type decoded struct {
	slot    uint64
	dropped bool
	errAns  bool
	res     *blockResult
	ex      *blockExtras
	err     error
}

func decodeOne(dir string, slot uint64, manifest map[uint64]string, t0, t1 int64, st *UnitStats) decoded {
	d := decoded{slot: slot}
	body, err := readSpooled(dir, slot)
	if err != nil {
		d.err = err
		return d
	}
	if manifest != nil {
		sum := sha256.Sum256(body)
		if want, ok := manifest[slot]; !ok || want != hex.EncodeToString(sum[:]) {
			d.err = fmt.Errorf("slot %d: sha256 does not match the tee's manifest", slot)
			return d
		}
	}
	result, err := rpcResultOf(body)
	if errors.Is(err, errAnswer) {
		d.errAns = true
		return d
	}
	if err != nil {
		d.err = fmt.Errorf("slot %d: %w", slot, err)
		return d
	}
	b, err := rpcBlock(slot, result)
	if err != nil {
		d.err = err
		return d
	}
	if t1 > t0 && (b.blockTime < t0 || b.blockTime >= t1) {
		d.dropped = true
		return d
	}
	d.res = processBlock(b, st)
	d.ex, d.err = blockExtrasOf(slot, result)
	return d
}

// decodeUnit writes the research tables of slots [from, to] from spool to outDir
// (atomically: a .tmp directory renamed into place).
func decodeUnit(spool string, from, to uint64, day string, outDir string, useManifest bool, workers int) (*decodeStats, error) {
	start := time.Now()
	ds := &decodeStats{Day: day, FromSlot: from, ToSlot: to, Rows: map[string]int64{}, EventNames: map[string]int64{},
		Counts: decodeCounts{Classes: map[string]int64{}}, Revision: scannerRevision}
	var t0, t1 int64
	if day != "" {
		d, err := time.Parse("2006-01-02", day)
		if err != nil {
			return nil, err
		}
		t0, t1 = d.Unix(), d.Add(24*time.Hour).Unix()
	}
	var manifest map[uint64]string
	if useManifest {
		var err error
		if manifest, err = readManifest(spool); err != nil {
			return nil, err
		}
	}
	slots, err := spoolSlots(spool, from, to)
	if err != nil {
		return nil, err
	}
	sampleRate = 1 // every mint's rows kept (research tables are private and complete)
	st := &UnitStats{Schema: schemaVersion, FromSlot: from, ToSlot: to, EventCounts: map[string]int{}, UnknownEvents: map[string]int{},
		NewerLayouts: map[string]int{}, OlderLayouts: map[string]int{}, ExtraBytes: map[string]int{}, FirstSeen: map[string]uint64{},
		ScannerRevision: scannerRevision, SampleRate: sampleRate}

	tmp := outDir + ".tmp"
	os.RemoveAll(tmp)
	if err := os.MkdirAll(tmp, 0o755); err != nil {
		return nil, err
	}
	cols := map[string][]string{
		fCurve: append(append([]string{}, curveCols...), sAddCols...), fAmm: append(append([]string{}, ammCols...), sAddCols...),
		fFailed: tapeFailedCols, fTransfers: transferCols, fMoves: movementCols, fCoverage: movementCoverageCols,
		fDelegs: delegationCols, fBlocks: blockCols, fEvents: nil, fHourly: aggCols}
	outs := map[string]*csvOut{}
	for name, c := range cols {
		o, err := newCSV(filepath.Join(tmp, name), c)
		if err != nil {
			return nil, err
		}
		outs[name] = o
	}
	write := func(name string, row []string) { outs[name].row(row); ds.Rows[name]++ }

	// Blocks decode in parallel and are written in slot order.
	if workers < 1 {
		workers = 1
	}
	results := make([]chan decoded, len(slots))
	for i := range results {
		results[i] = make(chan decoded, 1)
	}
	sem := make(chan struct{}, workers)
	var wg sync.WaitGroup
	go func() {
		for i, s := range slots {
			sem <- struct{}{}
			wg.Add(1)
			go func(i int, s uint64) {
				defer wg.Done()
				results[i] <- decodeOne(spool, s, manifest, t0, t1, st)
				<-sem
			}(i, s)
		}
	}()
	agg := map[aggKey]*aggVal{}
	partial := map[string]bool{}
	var marks []coverageMark
	var firstErr error
	for i := range slots {
		d := <-results[i]
		if d.err != nil {
			if firstErr == nil {
				firstErr = d.err
			}
			continue
		}
		if manifest != nil {
			ds.ManifestOK++
		}
		switch {
		case d.errAns:
			ds.SkippedFiles++
			continue
		case d.dropped:
			ds.DroppedBlocks++
			continue
		}
		ds.Blocks++
		r, ex := d.res, d.ex
		ds.Counts.add(ex.counts)
		mergeAgg(agg, r.agg)
		for _, m := range r.partial {
			partial[m] = true
		}
		marks = append(marks, r.marks...)
		write(fBlocks, r.blockRow)
		for _, row := range r.curve {
			b := ex.sAdd[atoi(row[2])]
			write(fCurve, append(append([]string{}, row...), sAdd(b, row[len(curveCols)-1], row[8], "", protocolFlag(row[5], row[colIndex(curveCols, "user")], row[colIndex(curveCols, "ix_name")]))...))
		}
		for _, row := range r.amm {
			b := ex.sAdd[atoi(row[2])]
			canon := "0"
			if isCanonicalPool(row[8], row[9], row[10]) {
				canon = "1"
			}
			write(fAmm, append(append([]string{}, row...), sAdd(b, row[len(ammCols)-1], row[9], canon, protocolFlag(row[5], row[colIndex(ammCols, "user")], row[colIndex(ammCols, "ix_name")]))...))
		}
		for _, row := range ex.failed {
			write(fFailed, row)
		}
		for _, row := range ex.transfers {
			write(fTransfers, row)
		}
		for _, row := range r.moves {
			write(fMoves, row)
		}
		for _, row := range r.delegs {
			write(fDelegs, row)
		}
		for _, l := range r.other {
			outs[fEvents].line(l)
			ds.Rows[fEvents]++
			var e struct {
				Event string `json:"event"`
			}
			if json.Unmarshal([]byte(l), &e) == nil {
				ds.EventNames[e.Event]++
			}
		}
	}
	wg.Wait()
	for _, row := range aggRows(agg) {
		write(fHourly, row)
	}
	for _, row := range coverageRows(partial, marks) {
		write(fCoverage, row)
	}
	for _, o := range outs {
		if err := o.close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	if firstErr != nil {
		os.RemoveAll(tmp)
		return nil, firstErr
	}
	ds.ScanDecodeErr = st.DecodeFailures
	ds.CPUSeconds = time.Since(start).Seconds()
	b, _ := json.MarshalIndent(ds, "", "  ")
	if err := os.WriteFile(filepath.Join(tmp, "stats.json"), b, 0o644); err != nil {
		return nil, err
	}
	os.RemoveAll(outDir)
	return ds, os.Rename(tmp, outDir)
}

func atoi(s string) int { v, _ := strconv.Atoi(s); return v }

// protocolFlag marks protocol flow: PumpSwap's boost_buy_and_burn and trades signed or
// made by the tokenized-agent buyback authority.
func protocolFlag(signer, user, ixName string) string {
	if ixName == "boost_buy_and_burn" || signer == buybackAuthority || user == buybackAuthority {
		return "1"
	}
	return "0"
}

func runDecode(args []string) int {
	fs := flag.NewFlagSet("decode", flag.ExitOnError)
	spool := fs.String("spool", "", "spool directory (the tee's)")
	from := fs.Uint64("from-slot", 0, "first slot")
	to := fs.Uint64("to-slot", 0, "last slot")
	day := fs.String("day", "", "UTC day (YYYY-MM-DD): blocks outside it are dropped; empty keeps all")
	out := fs.String("out", "", "output directory for the unit's research tables")
	noManifest := fs.Bool("no-manifest", false, "do not require the tee's manifest (test data only)")
	workers := fs.Int("workers", 4, "blocks decoded at once")
	fs.Parse(args)
	if *spool == "" || *out == "" || *to < *from {
		log.Print("usage: decode -spool DIR -from-slot S -to-slot S -out DIR [-day YYYY-MM-DD]")
		return 2
	}
	ds, err := decodeUnit(*spool, *from, *to, *day, *out, !*noManifest, *workers)
	if err != nil {
		log.Print(err)
		return 1
	}
	b, _ := json.Marshal(ds)
	fmt.Println(string(b))
	return 0
}
