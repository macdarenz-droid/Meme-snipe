package main

// finalize turns scanned units into the published dataset:
//
//   dataset/
//     manifest.json                 coverage per day, row counts, sha256 of every file
//     mints.csv.zst                 universe membership and lifecycle of every mint seen created
//     days/YYYY-MM-DD/
//       curve_trades-NNN.csv.zst    bonding-curve trades of universe mints
//       amm_trades-NNN.csv.zst      PumpSwap trades of universe mints
//       events-NNN.jsonl.zst        universe events (creates, graduations, pools, liquidity, boosts, parameters)
//       failed_hourly-NNN.csv.zst   failed trade transactions of universe mints, counted per hour
//       agg_hourly-NNN.csv.zst      hourly census of every mint that traded (all mints)
//       blocks-NNN.csv.zst          every scanned block with transaction counts
//
// Universe rules (fixed before looking at outcomes; see docs/research/historical-data.md):
//   launch: mint created (CreateEvent) inside the scanned coverage and hash < launchRate;
//           tape from creation to creation + 72 h.
//   grad:   mint graduated (CompletePumpAmmMigrationEvent) inside the coverage and
//           hash < gradRate; tape from creation (or coverage start) to graduation + 72 h.
//   pool:   PumpSwap pool created directly (CreatePoolEvent outside a migration)
//           inside the coverage and hash(base mint) < poolRate; tape from pool creation + 72 h.
// Default rates are 5% each (nested: the same hash, so every launch-sampled mint that
// graduates is also grad-sampled). The scanner keeps a 25% superset, so the dataset
// can be re-cut at up to 25% without rescanning.
// hash = first 8 bytes of sha256(mint) as a fraction of 2^64 (see sample.go).

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/klauspost/compress/zstd"
)

// Universe rates (overridable on the command line, recorded in the manifest).
var (
	launchRate = 0.05
	gradRate   = 0.05
	poolRate   = 0.05
)

const (
	tapeHorizon  = 72 * 3600
	partMaxBytes = 45 << 20 // keep every file under GitHub's 50 MB warning size
)

type unitDir struct {
	path  string
	stats *UnitStats
}

func loadUnits(out string) ([]unitDir, error) {
	dirs, _ := filepath.Glob(filepath.Join(out, "units", "*", "*"))
	var us []unitDir
	for _, d := range dirs {
		if strings.HasSuffix(d, ".tmp") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(d, "stats.json"))
		if err != nil {
			continue // unfinished
		}
		var st UnitStats
		if err := json.Unmarshal(b, &st); err != nil {
			return nil, fmt.Errorf("%s: %w", d, err)
		}
		us = append(us, unitDir{d, &st})
	}
	sort.Slice(us, func(i, j int) bool { return us[i].stats.FromSlot < us[j].stats.FromSlot })
	return us, nil
}

type mintInfo struct {
	Mint        string  `json:"mint"`
	Hash        float64 `json:"hash"`
	CreateSlot  uint64  `json:"create_slot"`
	CreateTime  int64   `json:"create_time"`
	Creator     string  `json:"creator"`
	Name        string  `json:"name"`
	Symbol      string  `json:"symbol"`
	QuoteMint   string  `json:"quote_mint"`
	Mayhem      string  `json:"mayhem"`
	GradSlot    uint64  `json:"grad_slot"`
	GradTime    int64   `json:"grad_time"`
	Pool        string  `json:"pool"`
	PoolSlot    uint64  `json:"pool_slot"` // direct pool creation (not a migration)
	PoolTime    int64   `json:"pool_time"`
	Launch      bool    `json:"launch"`
	Grad        bool    `json:"grad"`
	DirectPool  bool    `json:"direct_pool"`
	TapeFrom    int64   `json:"tape_from"`
	TapeTo      int64   `json:"tape_to"`
	Censored    bool    `json:"censored"`
	observedAny bool
}

type evLine struct {
	Slot      uint64            `json:"slot"`
	BlockTime int64             `json:"block_time"`
	TxIdx     int               `json:"tx_idx"`
	Signature string            `json:"signature"`
	Event     string            `json:"event"`
	Fields    map[string]string `json:"fields"`
}

func readZstLines(path string, fn func(line []byte) error) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	zr, err := zstd.NewReader(f)
	if err != nil {
		return err
	}
	defer zr.Close()
	sc := bufio.NewScanner(zr)
	sc.Buffer(make([]byte, 1<<20), 64<<20)
	for sc.Scan() {
		if err := fn(sc.Bytes()); err != nil {
			return err
		}
	}
	return sc.Err()
}

// partWriter writes numbered parts of one logical file, rotating at partMaxBytes.
type partWriter struct {
	dir, base, ext string
	header         []string
	part           int
	f              *os.File
	cnt            *countW
	zw             *zstd.Encoder
	bw             *bufio.Writer
	cw             *csv.Writer
	rows           int64
	files          []string
}

type countW struct {
	w io.Writer
	n int64
}

func (c *countW) Write(p []byte) (int, error) { n, err := c.w.Write(p); c.n += int64(n); return n, err }

func (p *partWriter) open() error {
	name := fmt.Sprintf("%s-%03d.%s.zst", p.base, p.part, p.ext)
	f, err := os.Create(filepath.Join(p.dir, name))
	if err != nil {
		return err
	}
	p.f = f
	p.cnt = &countW{w: f}
	p.zw, _ = zstd.NewWriter(p.cnt, zstd.WithEncoderLevel(zstd.SpeedBetterCompression))
	p.bw = bufio.NewWriterSize(p.zw, 1<<20)
	p.cw = csv.NewWriter(p.bw)
	p.files = append(p.files, name)
	if p.header != nil {
		p.cw.Write(p.header)
	}
	return nil
}

func (p *partWriter) closePart() error {
	if p.f == nil {
		return nil
	}
	p.cw.Flush()
	if err := p.bw.Flush(); err != nil {
		return err
	}
	if err := p.zw.Close(); err != nil {
		return err
	}
	if err := p.f.Close(); err != nil {
		return err
	}
	p.f = nil
	return nil
}

func (p *partWriter) maybeRotate() error {
	if p.f != nil && p.rows%2000 == 0 {
		p.cw.Flush()
		p.bw.Flush()
		// compressed size so far is at least cnt.n; the encoder buffers up to a block
		if p.cnt.n > partMaxBytes {
			if err := p.closePart(); err != nil {
				return err
			}
			p.part++
		}
	}
	if p.f == nil {
		return p.open()
	}
	return nil
}

func (p *partWriter) writeCSV(rec []string) error {
	if err := p.maybeRotate(); err != nil {
		return err
	}
	p.rows++
	return p.cw.Write(rec)
}

func (p *partWriter) writeLine(line []byte) error {
	if err := p.maybeRotate(); err != nil {
		return err
	}
	p.rows++
	p.cw.Flush()
	p.bw.Write(line)
	return p.bw.WriteByte('\n')
}

type dayFiles struct {
	dir string
	w   map[string]*partWriter
}

var dayFileSpecs = []struct {
	base, ext string
	header    []string
}{
	{"curve_trades", "csv", curveCols}, {"amm_trades", "csv", ammCols}, {"events", "jsonl", nil},
	{"failed_hourly", "csv", failedHourlyCols}, {"agg_hourly", "csv", aggCols}, {"blocks", "csv", blockCols},
}

func dayOf(t int64) string { return time.Unix(t, 0).UTC().Format("2006-01-02") }

func Finalize(out, dsDir string, fromDay, toDay string, allowGaps bool) error {
	t0, err := time.Parse("2006-01-02", fromDay)
	if err != nil {
		return err
	}
	t1, err := time.Parse("2006-01-02", toDay)
	if err != nil {
		return err
	}
	units, err := loadUnits(out)
	if err != nil {
		return err
	}
	if len(units) == 0 {
		return fmt.Errorf("no finished units")
	}
	// Every unit must hold at least the sample the universe rates need. Units written
	// before the rate was recorded used the 0.25 default.
	minRate := 1.0
	for _, u := range units {
		r := u.stats.SampleRate
		if r == 0 {
			r = 0.25
		}
		if r < minRate {
			minRate = r
		}
	}
	if launchRate > minRate || gradRate > minRate || poolRate > minRate {
		return fmt.Errorf("universe rates exceed the smallest unit sample rate %v: rescan needed", minRate)
	}
	// Coverage: contiguous scanned slot ranges; the universe needs creation inside them.
	covStart, covEnd := units[0].stats.FirstBlockTime, units[len(units)-1].stats.LastBlockTime
	gaps := []string{}
	for i := 1; i < len(units); i++ {
		if units[i].stats.FromSlot != units[i-1].stats.ToSlot+1 {
			gaps = append(gaps, fmt.Sprintf("%d-%d", units[i-1].stats.ToSlot+1, units[i].stats.FromSlot-1))
		}
	}
	if len(gaps) > 0 && !allowGaps {
		return fmt.Errorf("scanned units are not contiguous; missing slot ranges %v (finish the scan first)", gaps)
	}
	log.Printf("finalize: %d units, coverage %s .. %s", len(units), time.Unix(covStart, 0).UTC(), time.Unix(covEnd, 0).UTC())

	// Pass 1: registry of creations, graduations and pools.
	mints := map[string]*mintInfo{}
	get := func(m string) *mintInfo {
		mi := mints[m]
		if mi == nil {
			h, _ := mintHashFraction(m)
			mi = &mintInfo{Mint: m, Hash: h}
			mints[m] = mi
		}
		return mi
	}
	migrationTx := map[string]bool{} // slot:tx of migration transactions
	type poolEv struct {
		key  string
		slot uint64
		t    int64
		base string
		pool string
	}
	var pools []poolEv
	for _, u := range units {
		err := readZstLines(filepath.Join(u.path, "events.jsonl.zst"), func(l []byte) error {
			var e evLine
			if err := json.Unmarshal(l, &e); err != nil {
				return err
			}
			key := fmt.Sprintf("%d:%d", e.Slot, e.TxIdx)
			switch e.Event {
			case "CreateEvent":
				mi := get(e.Fields["mint"])
				if mi.CreateSlot == 0 {
					mi.CreateSlot, mi.CreateTime = e.Slot, e.BlockTime
					mi.Creator, mi.Name, mi.Symbol = e.Fields["creator"], e.Fields["name"], e.Fields["symbol"]
					mi.QuoteMint, mi.Mayhem = e.Fields["quote_mint"], e.Fields["is_mayhem_mode"]
				}
			case "CompletePumpAmmMigrationEvent":
				mi := get(e.Fields["mint"])
				if mi.GradSlot == 0 {
					mi.GradSlot, mi.GradTime, mi.Pool = e.Slot, e.BlockTime, e.Fields["pool"]
				}
				migrationTx[key] = true
			case "CreatePoolEvent":
				pools = append(pools, poolEv{key, e.Slot, e.BlockTime, e.Fields["base_mint"], e.Fields["pool"]})
			}
			return nil
		})
		if err != nil {
			return fmt.Errorf("%s events: %w", u.path, err)
		}
	}
	for _, p := range pools {
		if migrationTx[p.key] {
			continue
		}
		mi := get(p.base)
		if mi.PoolSlot == 0 {
			mi.PoolSlot, mi.PoolTime = p.slot, p.t
			if mi.Pool == "" {
				mi.Pool = p.pool
			}
		}
	}
	for _, mi := range mints {
		mi.Launch = mi.CreateSlot != 0 && mi.Hash < launchRate
		mi.Grad = mi.GradSlot != 0 && mi.Hash < gradRate
		mi.DirectPool = mi.PoolSlot != 0 && mi.Hash < poolRate
		from, to := int64(0), int64(0)
		upd := func(a, b int64) {
			if from == 0 || a < from {
				from = a
			}
			if b > to {
				to = b
			}
		}
		if mi.Launch {
			upd(mi.CreateTime, mi.CreateTime+tapeHorizon)
		}
		if mi.Grad {
			start := mi.CreateTime
			if start == 0 {
				start = covStart
			}
			upd(start, mi.GradTime+tapeHorizon)
		}
		if mi.DirectPool {
			upd(mi.PoolTime, mi.PoolTime+tapeHorizon)
		}
		mi.TapeFrom, mi.TapeTo = from, to
		mi.Censored = to > covEnd
	}
	inTape := func(mint string, t int64) bool {
		mi := mints[mint]
		return mi != nil && mi.TapeFrom != 0 && t >= mi.TapeFrom && t <= mi.TapeTo
	}
	isUniverse := func(mint string) bool { mi := mints[mint]; return mi != nil && mi.TapeFrom != 0 }

	// Pass 2: route rows to days.
	if err := os.MkdirAll(filepath.Join(dsDir, "days"), 0o755); err != nil {
		return err
	}
	days := map[string]*dayFiles{}
	dayW := func(day, base string) (*partWriter, error) {
		df := days[day]
		if df == nil {
			dir := filepath.Join(dsDir, "days", day)
			os.RemoveAll(dir)
			if err := os.MkdirAll(dir, 0o755); err != nil {
				return nil, err
			}
			df = &dayFiles{dir: dir, w: map[string]*partWriter{}}
			for _, s := range dayFileSpecs {
				df.w[s.base] = &partWriter{dir: dir, base: s.base, ext: s.ext, header: s.header}
			}
			days[day] = df
		}
		return df.w[base], nil
	}
	inWindow := func(t int64) bool { return t >= t0.Unix() && t < t1.Unix() }
	type ordKey struct{ slot, tx, ev int64 }
	less := func(a, b ordKey) bool {
		if a.slot != b.slot {
			return a.slot < b.slot
		}
		if a.tx != b.tx {
			return a.tx < b.tx
		}
		return a.ev < b.ev
	}
	lastKey := map[string]ordKey{}
	checkOrder := func(file string, k ordKey) error {
		if p, ok := lastKey[file]; ok && !less(p, k) {
			return fmt.Errorf("%s: rows not strictly increasing at slot %d tx %d ev %d (duplicate or disorder)", file, k.slot, k.tx, k.ev)
		}
		lastKey[file] = k
		return nil
	}
	scanned := map[string]int{}
	aggAll := map[string]map[aggKey]*aggVal{} // day -> merged hourly census
	failedAll := map[failedKey]*failedVal{}
	// Completeness: every scanned block names the previous scanned block as its parent
	// (checked on the block rows of all units, in slot order), so no block of the chain
	// is missing between the first and last scanned block.
	chainBreaks := []string{}
	var lastBlock uint64
	for _, u := range units {
		for _, spec := range []struct {
			base    string
			mintCol int
			ev      bool
		}{{"curve_trades", 8, true}, {"amm_trades", 9, true}, {"failed", 8, false}, {"blocks", -1, false}} {
			userCol, tsCol := -1, -1
			switch spec.base {
			case "curve_trades":
				userCol, tsCol = 12, 13
			case "amm_trades":
				userCol, tsCol = 15, 16
			}
			first := true
			err := readCSVZst(filepath.Join(u.path, spec.base+".csv.zst"), func(rec []string) error {
				if first {
					first = false
					return nil
				}
				slot, _ := strconv.ParseInt(rec[0], 10, 64)
				bt, _ := strconv.ParseInt(rec[1], 10, 64)
				if spec.base == "blocks" {
					parent, _ := strconv.ParseUint(rec[2], 10, 64)
					if lastBlock != 0 && parent != lastBlock && len(chainBreaks) < 100 {
						chainBreaks = append(chainBreaks, fmt.Sprintf("block %d parent %d, previous scanned block %d", slot, parent, lastBlock))
					}
					lastBlock = uint64(slot)
				}
				if !inWindow(bt) {
					return nil
				}
				if spec.base == "blocks" {
					scanned[dayOf(bt)]++
				} else if !inTape(rec[spec.mintCol], bt) {
					return nil
				}
				var k ordKey
				k.slot = slot
				if spec.base != "blocks" {
					k.tx, _ = strconv.ParseInt(rec[2], 10, 64)
					if spec.ev {
						k.ev, _ = strconv.ParseInt(rec[3], 10, 64)
					}
				}
				if err := checkOrder(spec.base, k); err != nil {
					return err
				}
				if spec.base == "failed" {
					fk := failedKey{bt - bt%3600, rec[8]}
					fv := failedAll[fk]
					if fv == nil {
						fv = &failedVal{signers: map[string]bool{}, errs: map[string]int{}}
						failedAll[fk] = fv
					}
					fv.n++
					fv.signers[rec[4]] = true
					fv.errs[rec[9]]++
					return nil
				}
				// Redundant values are written empty: signer equal to user, event
				// timestamp equal to block_time.
				if userCol >= 0 && rec[5] == rec[userCol] {
					rec[5] = ""
				}
				if tsCol >= 0 && rec[tsCol] == rec[1] {
					rec[tsCol] = ""
				}
				w, err := dayW(dayOf(bt), spec.base)
				if err != nil {
					return err
				}
				return w.writeCSV(rec)
			})
			if err != nil {
				return fmt.Errorf("%s %s: %w", u.path, spec.base, err)
			}
		}
		err = readZstLines(filepath.Join(u.path, "events.jsonl.zst"), func(l []byte) error {
			var e evLine
			if err := json.Unmarshal(l, &e); err != nil {
				return err
			}
			if !inWindow(e.BlockTime) {
				return nil
			}
			if sampledOnlyEvents[e.Event] {
				m := e.Fields["mint"]
				if m == "" {
					m = e.Fields["base_mint"]
				}
				if !isUniverse(m) {
					return nil
				}
			}
			w, err := dayW(dayOf(e.BlockTime), "events")
			if err != nil {
				return err
			}
			return w.writeLine(l)
		})
		if err != nil {
			return fmt.Errorf("%s events: %w", u.path, err)
		}
		first := true
		err = readCSVZst(filepath.Join(u.path, "agg_hourly.csv.zst"), func(rec []string) error {
			if first {
				first = false
				return nil
			}
			hour, _ := strconv.ParseInt(rec[0], 10, 64)
			if !inWindow(hour) {
				return nil
			}
			day := dayOf(hour)
			m := aggAll[day]
			if m == nil {
				m = map[aggKey]*aggVal{}
				aggAll[day] = m
			}
			mergeAgg(m, map[aggKey]*aggVal{{hour, rec[1], rec[2], rec[3]}: aggFromRow(rec)})
			return nil
		})
		if err != nil {
			return fmt.Errorf("%s agg: %w", u.path, err)
		}
	}
	fks := make([]failedKey, 0, len(failedAll))
	for k := range failedAll {
		fks = append(fks, k)
	}
	sort.Slice(fks, func(i, j int) bool {
		if fks[i].hour != fks[j].hour {
			return fks[i].hour < fks[j].hour
		}
		return fks[i].mint < fks[j].mint
	})
	for _, k := range fks {
		v := failedAll[k]
		w, err := dayW(dayOf(k.hour), "failed_hourly")
		if err != nil {
			return err
		}
		top, topN := "", 0
		for e, n := range v.errs {
			if n > topN || (n == topN && e < top) {
				top, topN = e, n
			}
		}
		if err := w.writeCSV([]string{strconv.FormatInt(k.hour, 10), k.mint, strconv.Itoa(v.n), strconv.Itoa(len(v.signers)), top, strconv.Itoa(topN)}); err != nil {
			return err
		}
	}
	for day, m := range aggAll {
		w, err := dayW(day, "agg_hourly")
		if err != nil {
			return err
		}
		for _, row := range aggRows(m) {
			if err := w.writeCSV(row); err != nil {
				return err
			}
		}
	}

	if len(chainBreaks) > 0 && !allowGaps {
		return fmt.Errorf("parent links broken: %v", chainBreaks)
	}

	// Close and checksum.
	type fileInfo struct {
		Path   string `json:"path"`
		Bytes  int64  `json:"bytes"`
		Sha256 string `json:"sha256"`
		Rows   int64  `json:"rows,omitempty"`
	}
	type dayInfo struct {
		Day            string         `json:"day"`
		BlocksExpected int            `json:"blocks_expected"` // equals blocks_scanned when complete; 0 when the day is only partly covered
		BlocksScanned  int            `json:"blocks_scanned"`
		Complete       bool           `json:"complete"`
		WarmUp         bool           `json:"warm_up"`
		Rows           map[string]int `json:"rows"`
		Files          []fileInfo     `json:"files"`
	}
	var dayList []string
	for d := range days {
		dayList = append(dayList, d)
	}
	sort.Strings(dayList)
	manifestDays := []dayInfo{}
	for _, d := range dayList {
		df := days[d]
		dayStart, _ := time.Parse("2006-01-02", d)
		di := dayInfo{Day: d, BlocksScanned: scanned[d], Rows: map[string]int{}}
		// complete: the whole day lies inside the parent-linked coverage
		di.Complete = len(gaps) == 0 && len(chainBreaks) == 0 && covStart <= dayStart.Unix() && covEnd >= dayStart.Unix()+86400-1
		if di.Complete {
			di.BlocksExpected = di.BlocksScanned
		}
		di.WarmUp = dayStart.Unix() < covStart+tapeHorizon
		for _, s := range dayFileSpecs {
			w := df.w[s.base]
			if w.f == nil && len(w.files) == 0 {
				w.open() // empty file with header, so every day has the same layout
			}
			if err := w.closePart(); err != nil {
				return err
			}
			rows := w.rows
			di.Rows[s.base] = int(rows)
			for _, name := range w.files {
				p := filepath.Join(df.dir, name)
				fi, err := fileSum(p)
				if err != nil {
					return err
				}
				rel, _ := filepath.Rel(dsDir, p)
				di.Files = append(di.Files, fileInfo{Path: rel, Bytes: fi.size, Sha256: fi.sum})
			}
		}
		manifestDays = append(manifestDays, di)
	}

	// mints table
	mp := filepath.Join(dsDir, "mints.csv.zst")
	mw := &partWriter{dir: dsDir, base: "mints", ext: "csv", header: []string{"mint", "hash", "create_slot", "create_time", "creator", "name", "symbol",
		"quote_mint", "mayhem", "grad_slot", "grad_time", "pool", "direct_pool_slot", "direct_pool_time", "launch", "grad", "direct_pool", "tape_from", "tape_to", "censored"}}
	var ml []*mintInfo
	for _, mi := range mints {
		if mi.CreateSlot != 0 || mi.GradSlot != 0 || mi.PoolSlot != 0 {
			ml = append(ml, mi)
		}
	}
	sort.Slice(ml, func(i, j int) bool { return ml[i].Mint < ml[j].Mint })
	b := func(x bool) string {
		if x {
			return "1"
		}
		return "0"
	}
	u64 := func(x uint64) string { return strconv.FormatUint(x, 10) }
	i64 := func(x int64) string { return strconv.FormatInt(x, 10) }
	nLaunch, nGrad, nPool := 0, 0, 0
	for _, mi := range ml {
		if mi.Launch {
			nLaunch++
		}
		if mi.Grad {
			nGrad++
		}
		if mi.DirectPool {
			nPool++
		}
		mw.writeCSV([]string{mi.Mint, strconv.FormatFloat(mi.Hash, 'f', 8, 64), u64(mi.CreateSlot), i64(mi.CreateTime), mi.Creator, mi.Name, mi.Symbol,
			mi.QuoteMint, mi.Mayhem, u64(mi.GradSlot), i64(mi.GradTime), mi.Pool, u64(mi.PoolSlot), i64(mi.PoolTime),
			b(mi.Launch), b(mi.Grad), b(mi.DirectPool), i64(mi.TapeFrom), i64(mi.TapeTo), b(mi.Censored)})
	}
	if err := mw.closePart(); err != nil {
		return err
	}
	var mintFiles []fileInfo
	for _, name := range mw.files {
		fi, err := fileSum(filepath.Join(dsDir, name))
		if err != nil {
			return err
		}
		mintFiles = append(mintFiles, fileInfo{Path: name, Bytes: fi.size, Sha256: fi.sum, Rows: mw.rows})
	}
	_ = mp

	unitsInfo := []map[string]any{}
	var decodeFail int64
	for _, u := range units {
		decodeFail += u.stats.DecodeFailures
		unitsInfo = append(unitsInfo, map[string]any{"epoch": u.stats.Epoch, "root_cid": u.stats.RootCid, "from_slot": u.stats.FromSlot,
			"to_slot": u.stats.ToSlot, "blocks": u.stats.Blocks, "blocks_expected": u.stats.BlocksExpected, "decode_failures": u.stats.DecodeFailures,
			"unknown_events": u.stats.UnknownEvents, "newer_layouts": u.stats.NewerLayouts, "missing_blocks": len(u.stats.MissingBlocks),
			"scanner_revision": u.stats.ScannerRevision})
	}
	man := map[string]any{
		"schema":          schemaVersion,
		"generated_at":    time.Now().UTC().Format(time.RFC3339),
		"source":          "Old Faithful public Solana archive, https://files.old-faithful.net (one CAR file per epoch, content-addressed)",
		"programs":        map[string]string{"pump": "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", "pump_amm": "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"},
		"window":          map[string]string{"from": fromDay, "to_exclusive": toDay},
		"coverage":        map[string]any{"first_block_time": covStart, "last_block_time": covEnd, "first_slot": units[0].stats.FromSlot, "last_slot": units[len(units)-1].stats.ToSlot},
		"sampling":        map[string]any{"hash": "first 8 bytes of sha256(mint pubkey bytes), big-endian, divided by 2^64", "launch_rate": launchRate, "grad_rate": gradRate, "direct_pool_rate": poolRate, "tape_horizon_seconds": tapeHorizon, "unit_sample_rate_min": minRate},
		"universe_counts": map[string]int{"launch": nLaunch, "grad": nGrad, "direct_pool": nPool, "mints_registered": len(ml)},
		"decode_failures": decodeFail,
		"coverage_gaps":   gaps,
		"days":            manifestDays,
		"mints_files":     mintFiles,
		"units":           unitsInfo,
	}
	mb, _ := json.MarshalIndent(man, "", "  ")
	return os.WriteFile(filepath.Join(dsDir, "manifest.json"), mb, 0o644)
}

var failedHourlyCols = []string{"hour", "mint", "n_failed", "n_signers", "top_error", "top_error_count"}

type failedKey struct {
	hour int64
	mint string
}

type failedVal struct {
	n       int
	signers map[string]bool
	errs    map[string]int
}

func aggFromRow(rec []string) *aggVal {
	i := func(s string) int64 { v, _ := strconv.ParseInt(s, 10, 64); return v }
	f := func(s string) float64 { v, _ := strconv.ParseFloat(s, 64); return v }
	return &aggVal{quoteMint: rec[4], nBuy: i(rec[5]), nSell: i(rec[6]), quoteBuy: atou(rec[7]), quoteSell: atou(rec[8]), baseBuy: atou(rec[9]), baseSell: atou(rec[10]),
		firstSlot: atou(rec[11]), lastSlot: atou(rec[12]), openBase: rec[13], openQuote: rec[14], closeBase: rec[15], closeQuote: rec[16], closeVQuote: rec[17],
		highPx: f(rec[18]), lowPx: f(rec[19])}
}

func readCSVZst(path string, fn func(rec []string) error) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	zr, err := zstd.NewReader(f)
	if err != nil {
		return err
	}
	defer zr.Close()
	cr := csv.NewReader(bufio.NewReaderSize(zr, 1<<20))
	cr.FieldsPerRecord = -1
	cr.ReuseRecord = true
	for {
		rec, err := cr.Read()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		if err := fn(rec); err != nil {
			return err
		}
	}
}

type sumInfo struct {
	size int64
	sum  string
}

func fileSum(p string) (sumInfo, error) {
	f, err := os.Open(p)
	if err != nil {
		return sumInfo{}, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return sumInfo{}, err
	}
	return sumInfo{n, hex.EncodeToString(h.Sum(nil))}, nil
}

var _ = bytes.Equal
