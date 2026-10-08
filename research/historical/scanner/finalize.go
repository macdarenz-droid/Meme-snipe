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
//       failed-NNN.csv.zst          failed trade transactions of universe mints, one row each
//       failed_hourly-NNN.csv.zst   the same, counted per hour
//       raw-NNN.jsonl.zst           raw transaction records (wire bytes and meta) of every
//                                   pump/PumpSwap transaction touching a universe mint
//       agg_hourly-NNN.csv.zst      hourly census of every mint that traded (all mints)
//       blocks-NNN.csv.zst          every scanned block with transaction counts
//
// Universe rules (fixed before looking at outcomes; see docs/research/historical-data.md):
//   launch: mint created (CreateEvent) inside the scanned coverage and hash < launchRate;
//           tape from creation to creation + 72 h.
//   grad:   mint graduated (CompletePumpAmmMigrationEvent) inside the coverage and
//           hash < gradRate; tape from graduation to graduation + 15 days.
//   pool:   PumpSwap pool created directly (CreatePoolEvent outside a migration)
//           inside the coverage and hash(base mint) < poolRate; tape from pool creation
//           to pool creation + 15 days.
// A mint's tape is the union of these intervals, never the span between them: rows
// before a graduation exist only when the mint's launch tape covers them, the same as
// for every launch-sampled mint, so the presence of a row never reveals a later
// graduation (no look-ahead).
// Default rates are 5% each (nested: the same hash, so every launch-sampled mint that
// graduates is also grad-sampled). The units hold the scanner's -sample superset (5%
// in CI, so the rates cannot be raised without a rescan; a local -sample 0.25 scan
// allows re-cuts up to 25%).
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
	launchRate = 1.0 // every mint created in coverage (needs retentionPolicy units)
	gradRate   = 1.0 // every graduate in coverage (needs retentionPolicy units)
	poolRate   = 0.05
)

// Tape lengths: 72 h after creation for launches; 15 days after graduation or direct
// pool creation, so the "aged 24 h to 14 days" universe (architecture U1) has every
// trade of its tokens.
var (
	tapeHorizon     int64 = 72 * 3600
	poolTapeHorizon int64 = 15 * 86400
	// Files rotate once this many uncompressed bytes are written (counted before
	// compression, so rotation is deterministic); a part's compressed size is at most
	// about this, under the 2 GiB release asset limit.
	partMaxBytes int64 = 1900 << 20
)

// finalizeOpts are the dataset build options.
type finalizeOpts struct {
	AllowGaps      bool     // testing only: holes in the scanned slot ranges
	LeadInDays     int      // days of gap-free coverage required before the window (14 for the dataset)
	AllowRevisions []string // scanner revisions accepted together; empty: all units must share one
	Regimes        string   // JSON file of regime boundaries (research/historical/regimes.json), copied into the manifest
}

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
	tapes       []tape
}

// tape is one interval [from, to] (block times) of a mint's tape.
type tape struct {
	kind     string
	from, to int64
}

func (mi *mintInfo) inTape(t int64) bool {
	for _, tp := range mi.tapes {
		if t >= tp.from && t <= tp.to {
			return true
		}
	}
	return false
}

// tapeList: "kind:from-to" intervals joined by "|", in launch, grad, pool order.
func (mi *mintInfo) tapeList() string {
	s := make([]string, len(mi.tapes))
	for i, tp := range mi.tapes {
		s[i] = fmt.Sprintf("%s:%d-%d", tp.kind, tp.from, tp.to)
	}
	return strings.Join(s, "|")
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
	p.zw, _ = zstd.NewWriter(f, zstd.WithEncoderLevel(zstd.SpeedBetterCompression), zstd.WithEncoderConcurrency(1))
	p.cnt = &countW{w: p.zw} // uncompressed bytes: independent of encoder timing
	p.bw = bufio.NewWriterSize(p.cnt, 1<<20)
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
	{"failed", "csv", failedCols}, {"failed_hourly", "csv", failedHourlyCols}, {"agg_hourly", "csv", aggCols}, {"blocks", "csv", blockCols},
	{"raw", "jsonl", nil}, {"movements", "csv", movementCols}, {"delegations", "csv", delegationCols},
	{"volume_hours", "csv", volumeHourCols},
}

func dayOf(t int64) string { return time.Unix(t, 0).UTC().Format("2006-01-02") }

func Finalize(out, dsDir string, fromDay, toDay string, opt finalizeOpts) error {
	allowGaps := opt.AllowGaps
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
	// One schema per dataset: columns differ between scanner schemas.
	for _, u := range units {
		if u.stats.Schema != units[0].stats.Schema {
			return fmt.Errorf("units of schema %d and %d mixed (%s); rescan or finalize them separately", units[0].stats.Schema, u.stats.Schema, u.path)
		}
	}
	// One scanner revision per dataset, unless the caller lists the accepted ones.
	revs := map[string]bool{}
	for _, u := range units {
		revs[u.stats.ScannerRevision] = true
	}
	if len(opt.AllowRevisions) > 0 {
		ok := map[string]bool{}
		for _, r := range opt.AllowRevisions {
			ok[r] = true
		}
		for r := range revs {
			if !ok[r] {
				return fmt.Errorf("unit scanner revision %q is not in -allow-revisions", r)
			}
		}
	} else if len(revs) > 1 {
		list := make([]string, 0, len(revs))
		for r := range revs {
			list = append(list, r)
		}
		sort.Strings(list)
		return fmt.Errorf("units come from scanner revisions %v; rescan, or list the accepted ones with -allow-revisions", list)
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
	// Retention: units that keep every curve trade and every canonical-pool trade
	// (retentionPolicy) allow launch and grad rates up to 1.0; the direct-pool universe
	// (non-canonical pools) and older units stay limited to the hash sample.
	retention := units[0].stats.Retention
	for _, u := range units {
		if u.stats.Retention != retention {
			return fmt.Errorf("units of retention %q and %q mixed (%s); rescan", retention, u.stats.Retention, u.path)
		}
	}
	rateCap := minRate
	if retention == retentionPolicy || retention == "K2" || retention == "K3" { // K2 and K3 keep the same rows (OF-3)
		rateCap = 1
	}
	if launchRate > rateCap || gradRate > rateCap || poolRate > minRate {
		return fmt.Errorf("universe rates exceed what the units keep (launch/grad up to %v, direct pool up to %v): rescan needed", rateCap, minRate)
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
	// Lead-in: the universe rules (U1: tokens aged 24 h to 14 days) need this much
	// gap-free history before the first decision day.
	if need := t0.Unix() - int64(opt.LeadInDays)*86400; opt.LeadInDays > 0 && covStart > need {
		return fmt.Errorf("lead-in not covered: coverage starts %s, the %d-day lead-in needs %s",
			time.Unix(covStart, 0).UTC().Format(time.RFC3339), opt.LeadInDays, time.Unix(need, 0).UTC().Format(time.RFC3339))
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
		mi.tapes = mi.tapes[:0]
		if mi.Launch {
			mi.tapes = append(mi.tapes, tape{"launch", mi.CreateTime, mi.CreateTime + tapeHorizon})
		}
		if mi.Grad {
			mi.tapes = append(mi.tapes, tape{"grad", mi.GradTime, mi.GradTime + poolTapeHorizon})
		}
		if mi.DirectPool {
			mi.tapes = append(mi.tapes, tape{"pool", mi.PoolTime, mi.PoolTime + poolTapeHorizon})
		}
		from, to := int64(0), int64(0)
		for _, tp := range mi.tapes {
			if from == 0 || tp.from < from {
				from = tp.from
			}
			if tp.to > to {
				to = tp.to
			}
		}
		mi.TapeFrom, mi.TapeTo = from, to
		mi.Censored = to > covEnd
	}
	inTape := func(mint string, t int64) bool {
		mi := mints[mint]
		return mi != nil && mi.inTape(t)
	}

	// Pass 2: route rows to days.
	if err := os.MkdirAll(filepath.Join(dsDir, "days"), 0o755); err != nil {
		return err
	}
	// Output headers are copied from the units (all units must agree), so data scanned
	// by an older scanner keeps its own columns.
	headers := map[string][]string{}
	noteHeader := func(base string, rec []string) error {
		h, ok := headers[base]
		if !ok {
			headers[base] = append([]string(nil), rec...)
			return nil
		}
		if strings.Join(h, ",") != strings.Join(rec, ",") {
			return fmt.Errorf("%s: units disagree on columns", base)
		}
		return nil
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
				h := s.header
				if uh, ok := headers[s.base]; ok && h != nil {
					h = uh
				}
				df.w[s.base] = &partWriter{dir: dir, base: s.base, ext: s.ext, header: h}
			}
			days[day] = df
		}
		w := df.w[base]
		if uh, ok := headers[base]; ok && w.f == nil && len(w.files) == 0 && w.header != nil {
			w.header = uh // not opened yet: use the units' own columns
		}
		return w, nil
	}
	inWindow := func(t int64) bool { return t >= t0.Unix() && t < t1.Unix() }
	// A unit wholly before the window contributes only its events (creations,
	// graduations, pools) and block rows, so it may be shipped without row files.
	beforeWindow := func(u unitDir) bool { return u.stats.LastBlockTime < t0.Unix() }
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
	// Program-upgrade boundary: first trade event with bytes beyond the IDL, and the
	// first event with an unknown discriminator (both kept raw in the data).
	extraCol := map[string]int{"curve_trades": indexOf(curveCols, "extra_hex"), "amm_trades": indexOf(ammCols, "extra_hex")}
	upgradeFirst := map[string]*boundaryInfo{}
	for _, u := range units {
		for _, spec := range []struct {
			base    string
			mintCol int
			ev      bool
		}{{"curve_trades", 8, true}, {"amm_trades", 9, true}, {"failed", 8, false}, {"blocks", -1, false}, {"movements", 5, false}, {"delegations", 5, false}} {
			// Column positions come from the unit's own header (older schemas differ).
			userCol, tsCol, signerCol := -1, -1, -1
			first := true
			fp := filepath.Join(u.path, spec.base+".csv.zst")
			if spec.base != "blocks" && beforeWindow(u) && !fileExists(fp) {
				continue // events-only unit before the window (assembly in windows)
			}
			if (spec.base == "movements" || spec.base == "delegations") && !fileExists(fp) {
				continue // units written before token movements (or delegations) were kept
			}
			err := readCSVZst(fp, func(rec []string) error {
				if first {
					first = false
					if spec.base == "curve_trades" || spec.base == "amm_trades" {
						userCol, tsCol, signerCol = indexOf(rec, "user"), indexOf(rec, "timestamp"), indexOf(rec, "signer")
					}
					return noteHeader(spec.base, rec)
				}
				slot, _ := strconv.ParseInt(rec[0], 10, 64)
				bt, _ := strconv.ParseInt(rec[1], 10, 64)
				if xc := extraCol[spec.base]; xc > 0 && xc < len(rec) && rec[xc] != "" {
					if b := upgradeFirst[spec.base]; b == nil || slot < b.Slot {
						upgradeFirst[spec.base] = &boundaryInfo{Slot: slot, BlockTime: bt, TxIdx: rec[2], Signature: rec[4]}
					}
				}
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
				} else if spec.base == "movements" || spec.base == "delegations" {
					// Kept for every mint the units kept (no tape filter): ownership and control
					// need the whole history, and presence then depends on nothing in the future.
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
					if spec.base == "movements" || spec.base == "delegations" {
						o, _ := strconv.ParseInt(rec[3], 10, 64)
						in := int64(-1)
						if rec[4] != "" {
							in, _ = strconv.ParseInt(rec[4], 10, 64)
						}
						k.ev = o*100000 + in + 1
					}
				}
				if err := checkOrder(spec.base, k); err != nil {
					return err
				}
				if spec.base == "failed" {
					fw, err := dayW(dayOf(bt), "failed")
					if err != nil {
						return err
					}
					if err := fw.writeCSV(rec); err != nil {
						return err
					}
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
				if signerCol >= 0 && userCol >= 0 && userCol < len(rec) && rec[signerCol] == rec[userCol] {
					rec[signerCol] = ""
				}
				if tsCol >= 0 && tsCol < len(rec) && rec[tsCol] == rec[1] {
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
			if e.Event == "Unknown" {
				if b := upgradeFirst["unknown_event"]; b == nil || int64(e.Slot) < b.Slot {
					upgradeFirst["unknown_event"] = &boundaryInfo{Slot: int64(e.Slot), BlockTime: e.BlockTime, TxIdx: strconv.Itoa(e.TxIdx), Signature: e.Signature}
				}
			}
			if !inWindow(e.BlockTime) {
				return nil
			}
			if sampledOnlyEvents[e.Event] {
				m := e.Fields["mint"]
				if m == "" {
					m = e.Fields["base_mint"]
				}
				if !inTape(m, e.BlockTime) {
					return nil // outside the mint's tape, like its trades (no look-ahead)
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
		if u.stats.Schema >= 2 && !(beforeWindow(u) && !fileExists(filepath.Join(u.path, "raw.jsonl.zst"))) {
			err = readZstLines(filepath.Join(u.path, "raw.jsonl.zst"), func(l []byte) error {
				var r struct {
					Slot      int64    `json:"slot"`
					BlockTime int64    `json:"blockTime"`
					TxIndex   int64    `json:"txIndex"`
					Mints     []string `json:"mints"`
				}
				if err := json.Unmarshal(l, &r); err != nil {
					return err
				}
				if !inWindow(r.BlockTime) {
					return nil
				}
				keep := false
				for _, m := range r.Mints {
					if inTape(m, r.BlockTime) {
						keep = true
						break
					}
				}
				if !keep {
					return nil
				}
				if err := checkOrder("raw", ordKey{r.Slot, r.TxIndex, 0}); err != nil {
					return err
				}
				w, err := dayW(dayOf(r.BlockTime), "raw")
				if err != nil {
					return err
				}
				return w.writeLine(l)
			})
			if err != nil {
				return fmt.Errorf("%s raw: %w", u.path, err)
			}
		}
		if beforeWindow(u) && !fileExists(filepath.Join(u.path, "agg_hourly.csv.zst")) {
			continue
		}
		first := true
		err = readCSVZst(filepath.Join(u.path, "agg_hourly.csv.zst"), func(rec []string) error {
			if first {
				first = false
				return noteHeader("agg_hourly", rec)
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
	// Regime volume per hour (volume.go), for every day of the window, with or without
	// trades: an hour is covered only inside the gap-free, parent-linked coverage.
	hourCovered := func(h int64) bool {
		return len(gaps) == 0 && len(chainBreaks) == 0 && covStart <= h && covEnd >= h+3600-1
	}
	for d := t0; d.Before(t1); d = d.AddDate(0, 0, 1) {
		day := d.Format("2006-01-02")
		w, err := dayW(day, "volume_hours")
		if err != nil {
			return err
		}
		for _, row := range volumeHourRows(d.Unix(), aggAll[day], hourCovered) {
			if err := w.writeCSV(row); err != nil {
				return err
			}
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
		Day           string         `json:"day"`
		BlocksScanned int            `json:"blocks_scanned"`
		Complete      bool           `json:"complete"` // the whole day lies inside the gap-free, parent-linked coverage
		WarmUp        bool           `json:"warm_up"`  // the day lacks its lead-in of gap-free history
		Rows          map[string]int `json:"rows"`
		Files         []fileInfo     `json:"files"`
	}
	// Every day of the window is listed, with or without data, so a missing day shows.
	for d := t0; d.Before(t1); d = d.AddDate(0, 0, 1) {
		if _, err := dayW(d.Format("2006-01-02"), "blocks"); err != nil {
			return err
		}
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
		di.Complete = di.Complete && di.BlocksScanned > 0
		di.WarmUp = dayStart.Unix()-int64(opt.LeadInDays)*86400 < covStart || len(gaps) > 0 || len(chainBreaks) > 0
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
		"quote_mint", "mayhem", "grad_slot", "grad_time", "pool", "direct_pool_slot", "direct_pool_time", "launch", "grad", "direct_pool", "tape_from", "tape_to", "censored", "tapes"}}
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
			b(mi.Launch), b(mi.Grad), b(mi.DirectPool), i64(mi.TapeFrom), i64(mi.TapeTo), b(mi.Censored), mi.tapeList()})
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

	// Movement coverage: for mints not ending in "pump", the units whose pump and
	// PumpSwap transactions were searched for their movements (scope pump_transactions);
	// outside those rows their ownership is unresolved. "pump" mints are complete in
	// every unit and are not listed.
	cw := &partWriter{dir: dsDir, base: "movement_coverage", ext: "csv", header: []string{"mint", "scope", "slot", "reason", "count", "tx_idx", "from_slot", "to_slot"}}
	var covRows [][]string
	// Lead-in units carry no movements (assembly reads only their events, stats and
	// blocks), so ownership of every mint is unresolved before the first window unit:
	// one row with mint "*" says so, with the slots it covers.
	if len(units) > 0 && units[0].stats.FirstBlockTime < t0.Unix() {
		var leadTo uint64
		for _, u := range units {
			if u.stats.LastBlockTime < t0.Unix() {
				leadTo = u.stats.ToSlot
			}
		}
		if leadTo > 0 {
			covRows = append(covRows, []string{"*", "no_movements", "", "lead_in", "", "", strconv.FormatUint(units[0].stats.FromSlot, 10), strconv.FormatUint(leadTo, 10)})
		}
	}
	for _, u := range units {
		p := filepath.Join(u.path, "movement_coverage.csv.zst")
		if !fileExists(p) || u.stats.LastBlockTime < t0.Unix() || u.stats.FirstBlockTime >= t1.Unix() {
			continue
		}
		first := true
		if err := readCSVZst(p, func(rec []string) error {
			if first {
				first = false
				return nil
			}
			row := append([]string(nil), rec...)
			for len(row) < 6 {
				row = append(row, "") // units written before slot, reason, count and tx_idx
			}
			covRows = append(covRows, append(row[:6], strconv.FormatUint(u.stats.FromSlot, 10), strconv.FormatUint(u.stats.ToSlot, 10)))
			return nil
		}); err != nil {
			return fmt.Errorf("%s movement coverage: %w", u.path, err)
		}
	}
	sort.SliceStable(covRows, func(i, j int) bool { return covRows[i][0] < covRows[j][0] })
	for _, r := range covRows {
		if err := cw.writeCSV(r); err != nil {
			return err
		}
	}
	if err := cw.closePart(); err != nil {
		return err
	}
	for _, name := range cw.files {
		fi, err := fileSum(filepath.Join(dsDir, name))
		if err != nil {
			return err
		}
		mintFiles = append(mintFiles, fileInfo{Path: name, Bytes: fi.size, Sha256: fi.sum, Rows: cw.rows})
	}

	// First slot of every unknown discriminator and extra-bytes key over all units.
	firstSeen := map[string]uint64{}
	for _, u := range units {
		for k, s := range u.stats.FirstSeen {
			if v, ok := firstSeen[k]; !ok || s < v {
				firstSeen[k] = s
			}
		}
	}
	unitsInfo := []map[string]any{}
	var decodeFail int64
	for _, u := range units {
		decodeFail += u.stats.DecodeFailures
		unitsInfo = append(unitsInfo, map[string]any{"epoch": u.stats.Epoch, "root_cid": u.stats.RootCid, "from_slot": u.stats.FromSlot,
			"to_slot": u.stats.ToSlot, "blocks": u.stats.Blocks, "decode_failures": u.stats.DecodeFailures,
			"unknown_events": u.stats.UnknownEvents, "newer_layouts": u.stats.NewerLayouts, "extra_bytes": u.stats.ExtraBytes,
			"length_anomalies": u.stats.LengthAnomalies, "older_layouts": u.stats.OlderLayouts, "raw_records": u.stats.RawRecords, "schema": u.stats.Schema, "legacy_meta": u.stats.LegacyMeta, "first_seen_slot": u.stats.FirstSeen, "missing_meta": u.stats.MissingMeta,
			"scanner_revision": u.stats.ScannerRevision})
	}
	man := map[string]any{
		"schema":          units[0].stats.Schema,
		"source":          "Old Faithful public Solana archive, https://files.old-faithful.net (one CAR file per epoch, content-addressed)",
		"programs":        map[string]string{"pump": "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", "pump_amm": "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"},
		"window":          map[string]any{"from": fromDay, "to_exclusive": toDay, "lead_in_days": opt.LeadInDays},
		"coverage":        map[string]any{"first_block_time": covStart, "last_block_time": covEnd, "first_slot": units[0].stats.FromSlot, "last_slot": units[len(units)-1].stats.ToSlot},
		"sampling":        map[string]any{"hash": "first 8 bytes of sha256(mint pubkey bytes), big-endian, divided by 2^64", "launch_rate": launchRate, "grad_rate": gradRate, "direct_pool_rate": poolRate, "launch_tape_seconds": tapeHorizon, "grad_and_pool_tape_seconds": poolTapeHorizon, "unit_sample_rate_min": minRate, "retention": retention},
		"universe_counts": map[string]int{"launch": nLaunch, "grad": nGrad, "direct_pool": nPool, "mints_registered": len(ml)},
		"decode_failures": decodeFail,
		"coverage_gaps":   gaps,
		"program_upgrade_2026_10_02": map[string]any{
			"note":                  "pump and pump_amm were upgraded without a published IDL: trade events gain 8 bytes (extra_hex) and new event discriminators appear (Unknown events). Earliest occurrences seen in the scanned coverage (any sampled mint for trades, any mint for events); they are lower bounds if coverage starts after the upgrade.",
			"first_extra_hex_curve": upgradeFirst["curve_trades"],
			"first_extra_hex_amm":   upgradeFirst["amm_trades"],
			"first_unknown_event":   upgradeFirst["unknown_event"],
		},
		"first_seen_slot": firstSeen,
		"chain_breaks":    chainBreaks,
		"completeness":    "every block's parent is the previous block in the scan (checked on all block rows), so no block is missing between the first and last scanned block",
		"days":            manifestDays,
		"mints_files":     mintFiles,
		"units":           unitsInfo,
	}
	if opt.Regimes != "" {
		b, err := os.ReadFile(opt.Regimes)
		if err != nil {
			return fmt.Errorf("regimes: %w", err)
		}
		var reg any
		if err := json.Unmarshal(b, &reg); err != nil {
			return fmt.Errorf("regimes %s: %w", opt.Regimes, err)
		}
		man["regime_boundaries"] = reg
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

type boundaryInfo struct {
	Slot      int64  `json:"slot"`
	BlockTime int64  `json:"block_time"`
	TxIdx     string `json:"tx_idx"`
	Signature string `json:"signature"`
}

func indexOf(cols []string, name string) int {
	for i, c := range cols {
		if c == name {
			return i
		}
	}
	return -1
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

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }

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

// ---- OF-3 ----

// OF-3 trim (research/z-h-estimate/OLD-FAITHFUL.md §3): a K2 unit trimmed to K3 with the
// pinned PM-01 migration list, with no network access. Every data file is copied byte
// for byte except raw_canonical.jsonl.zst, whose records are kept by k3Keep, the same
// test a K3 scan applies, and written through the scanner's own writer (newCSV), so a
// trimmed unit's data files equal a K3 scan of the same unit byte for byte. stats.json
// records retention K3, the list's sha256 and the kept count.
//
// The per-unit log (unitlog) is one line a unit, "EPOCH/FROM-TO REVISION RETENTION
// LIST_SHA256" ("-" for no list), sorted; -check refuses a directory whose units do not
// match a given log line for line.

// TrimUnit writes the K3 trim of the K2 unit in to out (which must not exist).
func TrimUnit(in, out, listPath string) error {
	if in == "" || out == "" || listPath == "" {
		return fmt.Errorf("trim needs -in, -out and -migration-list")
	}
	list, sum, err := loadMigrationList(listPath)
	if err != nil {
		return err
	}
	st, err := readStats(in)
	if err != nil {
		return err
	}
	if st.Retention != "K2" {
		return fmt.Errorf("%s has retention %q; only a K2 unit is trimmed", in, st.Retention)
	}
	if _, err := os.Stat(out); err == nil {
		return fmt.Errorf("%s exists; a trimmed unit is written once", out)
	}
	tmp := out + ".tmp"
	os.RemoveAll(tmp)
	if err := os.MkdirAll(tmp, 0o755); err != nil {
		return err
	}
	ents, err := os.ReadDir(in)
	if err != nil {
		return err
	}
	kept := int64(0)
	for _, e := range ents {
		name := e.Name()
		if !e.Type().IsRegular() {
			return fmt.Errorf("%s/%s is not a regular file", in, name)
		}
		switch name {
		case "stats.json":
			continue
		case "raw_canonical.jsonl.zst":
			o, err := newCSV(filepath.Join(tmp, name), nil)
			if err != nil {
				return err
			}
			err = readZstLines(filepath.Join(in, name), func(l []byte) error {
				var r struct {
					BlockTime int64    `json:"blockTime"`
					Mints     []string `json:"mints"`
				}
				if err := json.Unmarshal(l, &r); err != nil {
					return err
				}
				if k3Keep(list, r.Mints, r.BlockTime) {
					o.line(string(l))
					kept++
				}
				return nil
			})
			if cerr := o.close(); err == nil {
				err = cerr
			}
			if err != nil {
				return fmt.Errorf("%s/%s: %w", in, name, err)
			}
		default:
			if err := copyFile(filepath.Join(in, name), filepath.Join(tmp, name)); err != nil {
				return err
			}
		}
	}
	st.Retention, st.MigrationListSha256, st.RawCanonicalRecords = "K3", sum, kept
	sb, _ := json.MarshalIndent(st, "", "  ")
	if err := os.WriteFile(filepath.Join(tmp, "stats.json"), sb, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, out)
}

func readStats(dir string) (*UnitStats, error) {
	b, err := os.ReadFile(filepath.Join(dir, "stats.json"))
	if err != nil {
		return nil, err
	}
	st := &UnitStats{}
	if err := json.Unmarshal(b, st); err != nil {
		return nil, fmt.Errorf("%s/stats.json: %w", dir, err)
	}
	return st, nil
}

func copyFile(src, dst string) error {
	f, err := os.Open(src)
	if err != nil {
		return err
	}
	defer f.Close()
	g, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(g, f); err != nil {
		g.Close()
		return err
	}
	return g.Close()
}

// unitLog returns the per-unit log of the finished units under out/units.
func unitLog(out string) ([]string, error) {
	dirs, err := filepath.Glob(filepath.Join(out, "units", "*", "*", "stats.json"))
	if err != nil {
		return nil, err
	}
	var lines []string
	for _, p := range dirs {
		d := filepath.Dir(p)
		if strings.HasSuffix(d, ".tmp") {
			continue
		}
		st, err := readStats(d)
		if err != nil {
			return nil, err
		}
		sha := st.MigrationListSha256
		if sha == "" {
			sha = "-"
		}
		lines = append(lines, fmt.Sprintf("%s/%s %s %s %s", filepath.Base(filepath.Dir(d)), filepath.Base(d), st.ScannerRevision, st.Retention, sha))
	}
	sort.Strings(lines)
	return lines, nil
}

// checkUnitLog refuses when the units under out differ from the log in any line: a
// unit missing or extra, or another revision, retention or migration list sha256. For a K3
// unit (OF-3 ruling 12) the log holds exactly one "k2 SHA256 EPOCH/RANGE/FILE" line per
// K2 file, the same files the K3 unit has, and every K3 file other than
// raw_canonical.jsonl.zst and stats.json has the k2 line's sha256 (the trim copies it).
func checkUnitLog(out, logPath string) error {
	b, err := os.ReadFile(logPath)
	if err != nil {
		return err
	}
	var want []string
	k2 := map[string]map[string]string{} // unit -> file -> sha256
	for _, l := range strings.Split(strings.TrimRight(string(b), "\n"), "\n") {
		if !strings.HasPrefix(l, "k2 ") {
			want = append(want, l)
			continue
		}
		f := strings.Split(l, " ")
		if len(f) != 3 || len(f[1]) != 64 || strings.Count(f[2], "/") != 2 {
			return fmt.Errorf("unit log: malformed k2 line %q", l)
		}
		unit, file := f[2][:strings.LastIndex(f[2], "/")], f[2][strings.LastIndex(f[2], "/")+1:]
		if k2[unit] == nil {
			k2[unit] = map[string]string{}
		}
		if _, dup := k2[unit][file]; dup {
			return fmt.Errorf("unit log: two k2 lines for %s", f[2])
		}
		k2[unit][file] = f[1]
	}
	if err := checkK2Lines(out, k2); err != nil {
		return err
	}
	have, err := unitLog(out)
	if err != nil {
		return err
	}
	for i := 0; i < len(want) || i < len(have); i++ {
		w, h := "", ""
		if i < len(want) {
			w = want[i]
		}
		if i < len(have) {
			h = have[i]
		}
		if w != h {
			return fmt.Errorf("unit log mismatch: the log says %q, the units say %q", w, h)
		}
	}
	return nil
}

// pmHorizonS is how long K3 keeps a listed pool after its migration: migration + 300 min
// (research/pm01/PREREG.md §3, "For the B-10 history pull", PM01-P5 at c0bdb04a: last
// entry at +120 min, time stop 120 min, plus 60 min for the exit ladder). The scanner and
// the trim stay horizon-free: the list carries each mint's FROM and UNTIL.
const pmHorizonS = 300 * 60

// migrationList builds the pinned PM-01 migration list for a day from the finished units
// under each dir (the day's own K2 units): every CompletePumpAmmMigrationEvent's mint, from
// its block time to block time + horizonS, plus the lines of prior (the earlier days'
// list, "" for none) whose window reaches dayStart or later; one line a mint (its first
// migration), sorted by mint. D's list = the days before D + D's own migrations
// (OLD-FAITHFUL.md §2).
func migrationList(dirs []string, horizonS int64, prior string, dayStart int64) ([]string, error) {
	first := map[string]int64{}
	until := map[string]int64{}
	if prior != "" {
		l, _, err := loadMigrationList(prior)
		if err != nil {
			return nil, fmt.Errorf("prior list: %w", err)
		}
		for m, w := range l {
			if w.until >= dayStart {
				first[m], until[m] = w.from, w.until
			}
		}
	}
	for _, dir := range dirs {
		paths, err := filepath.Glob(filepath.Join(dir, "units", "*", "*", "events.jsonl.zst"))
		if err != nil {
			return nil, err
		}
		if len(paths) == 0 {
			return nil, fmt.Errorf("%s holds no units", dir)
		}
		for _, p := range paths {
			if strings.HasSuffix(filepath.Dir(p), ".tmp") {
				continue
			}
			if _, err := os.Stat(filepath.Join(filepath.Dir(p), "stats.json")); err != nil {
				return nil, fmt.Errorf("%s is not a finished unit", filepath.Dir(p))
			}
			err := readZstLines(p, func(l []byte) error {
				var e struct {
					BlockTime int64             `json:"block_time"`
					Program   string            `json:"program"`
					Event     string            `json:"event"`
					Fields    map[string]string `json:"fields"`
				}
				if err := json.Unmarshal(l, &e); err != nil {
					return err
				}
				if e.Program != "pump" || e.Event != "CompletePumpAmmMigrationEvent" || e.Fields["mint"] == "" || e.BlockTime <= 0 {
					return nil
				}
				if t, ok := first[e.Fields["mint"]]; !ok || e.BlockTime < t {
					first[e.Fields["mint"]] = e.BlockTime
					until[e.Fields["mint"]] = e.BlockTime + horizonS
				}
				return nil
			})
			if err != nil {
				return nil, fmt.Errorf("%s: %w", p, err)
			}
		}
	}
	lines := make([]string, 0, len(first))
	for m, t := range first {
		lines = append(lines, fmt.Sprintf("%s %d %d", m, t, until[m]))
	}
	sort.Strings(lines)
	return lines, nil
}

// checkK2Lines: each K3 unit under out has exactly its files' k2 lines, and every copied
// file still has its K2 sha256; a unit that is not K3 has none.
func checkK2Lines(out string, k2 map[string]map[string]string) error {
	stats, err := filepath.Glob(filepath.Join(out, "units", "*", "*", "stats.json"))
	if err != nil {
		return err
	}
	seen := map[string]bool{}
	for _, p := range stats {
		d := filepath.Dir(p)
		if strings.HasSuffix(d, ".tmp") {
			continue
		}
		unit := filepath.Base(filepath.Dir(d)) + "/" + filepath.Base(d)
		seen[unit] = true
		st, err := readStats(d)
		if err != nil {
			return err
		}
		lines := k2[unit]
		if st.Retention != "K3" {
			if len(lines) > 0 {
				return fmt.Errorf("unit log: k2 lines for %s, a %s unit", unit, st.Retention)
			}
			continue
		}
		files, err := filepath.Glob(filepath.Join(d, "*.zst"))
		if err != nil {
			return err
		}
		if len(files) != len(lines) {
			return fmt.Errorf("unit log: %s has %d files and %d k2 lines", unit, len(files), len(lines))
		}
		for _, f := range files {
			name := filepath.Base(f)
			want, ok := lines[name]
			if !ok {
				return fmt.Errorf("unit log: no k2 line for %s/%s", unit, name)
			}
			if name == "raw_canonical.jsonl.zst" {
				continue
			}
			got, err := fileSha256(f)
			if err != nil {
				return err
			}
			if got != want {
				return fmt.Errorf("unit log: %s/%s differs from its K2 copy", unit, name)
			}
		}
	}
	for unit := range k2 {
		if !seen[unit] {
			return fmt.Errorf("unit log: k2 lines for %s, which is not a unit", unit)
		}
	}
	return nil
}

func fileSha256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
