package main

// Unit digests (DATA-2 pilot): a compact fingerprint of a unit's rows, so a unit read
// over RPC can be checked row for row against an archive unit without publishing
// either unit's rows. Per table: the row count, one digest per block (its rows in
// written order) and one per column (the column's values over the unit, in written
// order); plus the unit's counters. Rows are written in a deterministic order that
// depends only on the chain (block, transaction, instruction), so equal units give
// equal digests and a difference names its table, columns and blocks.

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/klauspost/compress/zstd"
)

type tableDigest struct {
	Rows    int               `json:"rows"`
	Columns map[string]string `json:"columns"`
	Blocks  map[string]string `json:"blocks,omitempty"` // slot -> digest; unit-level tables have none
	// Records: raw records only, keyed "slot:txIndex", so a log the RPC cut at its
	// size limit can be matched against the archive's whole log record by record.
	Records map[string]*rawRecordDigest `json:"records,omitempty"`
}

// rawRecordDigest fingerprints one raw record. A candidate record differing from the
// baseline only in its log is explained when its other fields are equal (NoLogs) and
// its log is exactly the baseline's log as a validator with Agave's default log limit
// records it (Cut).
type rawRecordDigest struct {
	Full   string `json:"f"`           // the whole line
	NoLogs string `json:"n"`           // the record without meta.logMessages
	Logs   string `json:"l"`           // the log lines ("null" when not recorded)
	Cut    string `json:"c,omitempty"` // the log after agaveLogCut, when that changes it
}

const (
	logTruncated  = "Log truncated"
	logLimitBytes = 10000 // Agave's default log_messages_bytes_limit
)

// agaveLogCut applies Agave's LogCollector limit to a complete log: a message that
// would bring the bytes written to the limit or past it is dropped, the first drop
// writes "Log truncated", and later messages that still fit are kept. Measured: the
// public RPC's log of every one of the 118 raw records in 25 blocks of the comparison
// unit equals this cut of the archive's log (4 of them shorter than the archive's).
func agaveLogCut(logs []string, limit int) []string {
	out := make([]string, 0, len(logs))
	written, warned := 0, false
	for _, m := range logs {
		if written+len(m) >= limit {
			if !warned {
				warned = true
				out = append(out, logTruncated)
			}
			continue
		}
		written += len(m)
		out = append(out, m)
	}
	return out
}

// hashLines hashes lines with each one length-prefixed, so no split of the same bytes
// into lines (a newline inside a log message) hashes alike.
func hashLines(lines []string) string {
	h := sha256.New()
	var n [binary.MaxVarintLen64]byte
	for _, l := range lines {
		h.Write(n[:binary.PutUvarint(n[:], uint64(len(l)))])
		io.WriteString(h, l)
	}
	return shortHash(h.Sum(nil))
}

// rawDigest builds a raw record's fingerprint from its parsed line.
func rawDigest(line string, obj map[string]json.RawMessage, meta map[string]json.RawMessage) *rawRecordDigest {
	d := &rawRecordDigest{Full: shortHash(sha256Sum(line)), Logs: "null"}
	if lm, ok := meta["logMessages"]; ok && string(lm) != "null" {
		var logs []string
		json.Unmarshal(lm, &logs)
		d.Logs = hashLines(logs)
		if cut := agaveLogCut(logs, logLimitBytes); len(cut) != len(logs) || hashLines(cut) != d.Logs {
			d.Cut = hashLines(cut)
		}
	}
	noLogs := map[string]json.RawMessage{}
	for k, v := range obj {
		noLogs[k] = v
	}
	m2 := map[string]json.RawMessage{}
	for k, v := range meta {
		if k != "logMessages" {
			m2[k] = v
		}
	}
	mb, _ := json.Marshal(m2)
	noLogs["meta"] = mb
	nb, _ := json.Marshal(noLogs) // keys sorted by encoding/json
	d.NoLogs = shortHash(sha256Sum(string(nb)))
	return d
}

func sha256Sum(s string) []byte { h := sha256.Sum256([]byte(s)); return h[:] }

// recordExplained reports whether candidate record c differs from baseline record b
// only by an RPC's log limit: every other field equal, and the candidate's log exactly
// the baseline's log after agaveLogCut (which must have changed it).
func recordExplained(b, c *rawRecordDigest) bool {
	return b != nil && c != nil && b.NoLogs == c.NoLogs && b.Cut != "" && c.Logs == b.Cut
}

type unitDigest struct {
	Epoch    uint64                  `json:"epoch"`
	FromSlot uint64                  `json:"from_slot"`
	ToSlot   uint64                  `json:"to_slot"`
	Source   string                  `json:"source"`
	Stats    map[string]any          `json:"stats"`
	Tables   map[string]*tableDigest `json:"tables"`
}

// digestStats are the counters compared between sources. Timing, HTTP and source
// fields (seconds, http_*, byte ranges, root_cid, revision) legitimately differ.
var digestStats = []string{"blocks", "first_block_slot", "last_block_slot", "first_block_time", "last_block_time",
	"first_parent_slot", "txs", "vote_txs", "pump_txs", "pump_txs_failed", "curve_trades", "amm_trades", "other_events",
	"event_counts", "unknown_events", "decode_failures", "newer_layouts", "older_layouts", "extra_bytes", "first_seen_slot",
	"length_anomalies", "raw_records", "movements", "delegations", "mint_only_records", "other_venue_txs", "legacy_meta",
	"missing_meta", "chain_breaks", "retention", "sample_rate", "schema"}

var digestTables = []struct {
	file, name string
	perBlock   bool
}{
	{"blocks.csv.zst", "blocks", true},
	{"curve_trades.csv.zst", "curve_trades", true},
	{"amm_trades.csv.zst", "amm_trades", true},
	{"failed.csv.zst", "failed", true},
	{"movements.csv.zst", "movements", true},
	{"delegations.csv.zst", "delegations", true},
	{"raw.jsonl.zst", "raw", true},
	{"events.jsonl.zst", "events", true},
	{"agg_hourly.csv.zst", "agg_hourly", false},
	{"movement_coverage.csv.zst", "movement_coverage", false},
}

func shortHash(h []byte) string { return hex.EncodeToString(h[:8]) }

// digestUnit fingerprints the unit in dir. A table file the unit does not have (older
// units had no delegations) is left out, and compareDigests reports it as not compared.
func digestUnit(dir string) (*unitDigest, error) {
	sb, err := os.ReadFile(filepath.Join(dir, "stats.json"))
	if err != nil {
		return nil, err
	}
	var stats map[string]any
	if err := json.Unmarshal(sb, &stats); err != nil {
		return nil, fmt.Errorf("stats.json: %w", err)
	}
	d := &unitDigest{Stats: map[string]any{}, Tables: map[string]*tableDigest{}}
	num := func(k string) uint64 { f, _ := stats[k].(float64); return uint64(f) }
	d.Epoch, d.FromSlot, d.ToSlot = num("epoch"), num("from_slot"), num("to_slot")
	d.Source, _ = stats["root_cid"].(string)
	if d.Source != rpcSourceTag {
		d.Source = "archive"
	}
	for _, k := range digestStats {
		if v, ok := stats[k]; ok {
			d.Stats[k] = v
		}
	}
	for _, t := range digestTables {
		td, err := digestTable(filepath.Join(dir, t.file), t.perBlock, t.name == "raw")
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("%s: %w", t.file, err)
		}
		d.Tables[t.name] = td
	}
	return d, nil
}

func digestTable(path string, perBlock, raw bool) (*tableDigest, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	zr, err := zstd.NewReader(f)
	if err != nil {
		return nil, err
	}
	defer zr.Close()
	td := &tableDigest{Columns: map[string]string{}}
	colH := map[string]io.Writer{}
	colHash := map[string]interface{ Sum([]byte) []byte }{}
	addCol := func(name, v string) {
		w, ok := colH[name]
		if !ok {
			h := sha256.New()
			colH[name], colHash[name] = h, h
			w = h
		}
		io.WriteString(w, v)
		w.Write([]byte{'\n'})
	}
	blockH := map[string]interface {
		io.Writer
		Sum([]byte) []byte
	}{}
	addRow := func(slot, line string) {
		td.Rows++
		if !perBlock {
			return
		}
		h, ok := blockH[slot]
		if !ok {
			h = sha256.New()
			blockH[slot] = h
		}
		io.WriteString(h, line)
		h.Write([]byte{'\n'})
	}
	if raw {
		td.Records = map[string]*rawRecordDigest{}
	}
	if strings.HasSuffix(path, ".csv.zst") {
		cr := csv.NewReader(bufio.NewReaderSize(zr, 1<<20))
		cr.FieldsPerRecord = -1
		header, err := cr.Read()
		if err == io.EOF {
			return td, nil
		}
		if err != nil {
			return nil, err
		}
		for {
			rec, err := cr.Read()
			if err == io.EOF {
				break
			}
			if err != nil {
				return nil, err
			}
			if len(rec) != len(header) {
				return nil, fmt.Errorf("row of %d fields under %d columns", len(rec), len(header))
			}
			var line bytes.Buffer
			w := csv.NewWriter(&line)
			w.Write(rec)
			w.Flush()
			for i, c := range header {
				addCol(c, rec[i])
			}
			addRow(rec[0], strings.TrimSuffix(line.String(), "\n"))
		}
	} else {
		sc := bufio.NewScanner(zr)
		sc.Buffer(make([]byte, 1<<20), 256<<20)
		for sc.Scan() {
			line := sc.Text()
			var obj map[string]json.RawMessage
			if err := json.Unmarshal([]byte(line), &obj); err != nil {
				return nil, fmt.Errorf("json line: %w", err)
			}
			var slot uint64
			json.Unmarshal(obj["slot"], &slot)
			s := strconv.FormatUint(slot, 10)
			// Columns: the top-level keys, with meta's keys one level down (raw records),
			// so a difference in, say, logMessages is named as meta.logMessages.
			keys := make([]string, 0, len(obj))
			for k := range obj {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				if k == "meta" {
					var meta map[string]json.RawMessage
					if json.Unmarshal(obj[k], &meta) == nil {
						for mk, mv := range meta {
							addCol("meta."+mk, s+" "+string(mv)) // keyed by slot: meta keys vary per record
						}
						if raw {
							var idx int
							json.Unmarshal(obj["txIndex"], &idx)
							td.Records[s+":"+strconv.Itoa(idx)] = rawDigest(line, obj, meta)
						}
						continue
					}
				}
				addCol(k, string(obj[k]))
			}
			addRow(s, line)
		}
		if err := sc.Err(); err != nil {
			return nil, err
		}
	}
	for c, h := range colHash {
		td.Columns[c] = shortHash(h.Sum(nil))
	}
	if perBlock {
		td.Blocks = map[string]string{}
		for s, h := range blockH {
			td.Blocks[s] = shortHash(h.Sum(nil))
		}
	}
	return td, nil
}

// digest comparison ---------------------------------------------------------------

type tableComparison struct {
	Table          string   `json:"table"`
	Status         string   `json:"status"` // equal | differs | explained | not_compared
	Why            string   `json:"why,omitempty"`
	RowsBaseline   int      `json:"rows_baseline"`
	RowsCandidate  int      `json:"rows_candidate"`
	ColumnsDiffer  []string `json:"columns_differ,omitempty"`
	ColumnsMissing []string `json:"columns_missing,omitempty"` // in one side only
	BlocksDiffer   int      `json:"blocks_differ"`
	BlocksSample   []string `json:"blocks_sample,omitempty"` // first 20 differing slots
}

type digestComparison struct {
	Equal       bool               `json:"equal"` // every compared table and counter equal or explained
	Unexplained int                `json:"unexplained"`
	Tables      []*tableComparison `json:"tables"`
	StatsDiffer map[string][2]any  `json:"stats_differ,omitempty"`
}

func compareDigests(base, cand *unitDigest) *digestComparison {
	out := &digestComparison{Equal: true, StatsDiffer: map[string][2]any{}}
	for _, k := range digestStats {
		bv, bok := base.Stats[k]
		cv, cok := cand.Stats[k]
		if !bok || !cok {
			continue // a counter one side's scanner did not write is not compared
		}
		bj, _ := json.Marshal(bv)
		cj, _ := json.Marshal(cv)
		if !bytes.Equal(bj, cj) && !(isEmptyJSON(bj) && isEmptyJSON(cj)) {
			out.StatsDiffer[k] = [2]any{bv, cv}
			out.Unexplained++
		}
	}
	names := map[string]bool{}
	for n := range base.Tables {
		names[n] = true
	}
	for n := range cand.Tables {
		names[n] = true
	}
	sorted := make([]string, 0, len(names))
	for n := range names {
		sorted = append(sorted, n)
	}
	sort.Strings(sorted)
	for _, n := range sorted {
		b, c := base.Tables[n], cand.Tables[n]
		tc := &tableComparison{Table: n}
		out.Tables = append(out.Tables, tc)
		if b == nil || c == nil {
			tc.Status = "not_compared"
			tc.Why = "table missing from the baseline (written by a later scanner)"
			if c == nil {
				tc.Why = "table missing from the candidate"
				out.Unexplained++
			}
			if b != nil {
				tc.RowsBaseline = b.Rows
			}
			if c != nil {
				tc.RowsCandidate = c.Rows
			}
			continue
		}
		tc.RowsBaseline, tc.RowsCandidate = b.Rows, c.Rows
		for col, h := range b.Columns {
			ch, ok := c.Columns[col]
			if !ok {
				tc.ColumnsMissing = append(tc.ColumnsMissing, col)
			} else if ch != h {
				tc.ColumnsDiffer = append(tc.ColumnsDiffer, col)
			}
		}
		for col := range c.Columns {
			if _, ok := b.Columns[col]; !ok {
				tc.ColumnsMissing = append(tc.ColumnsMissing, col)
			}
		}
		sort.Strings(tc.ColumnsDiffer)
		sort.Strings(tc.ColumnsMissing)
		var diff []string
		for s, h := range b.Blocks {
			if c.Blocks[s] != h {
				diff = append(diff, s)
			}
		}
		for s := range c.Blocks {
			if _, ok := b.Blocks[s]; !ok {
				diff = append(diff, s)
			}
		}
		sort.Strings(diff)
		tc.BlocksDiffer = len(diff)
		if len(diff) > 20 {
			tc.BlocksSample = diff[:20]
		} else {
			tc.BlocksSample = diff
		}
		switch {
		case tc.RowsBaseline == tc.RowsCandidate && len(tc.ColumnsDiffer) == 0 && len(tc.ColumnsMissing) == 0 && len(diff) == 0:
			tc.Status = "equal"
		case n == "raw" && tc.RowsBaseline == tc.RowsCandidate && len(tc.ColumnsMissing) == 0 &&
			len(tc.ColumnsDiffer) == 1 && tc.ColumnsDiffer[0] == "meta.logMessages" && rawDiffExplained(b, c, diff):
			tc.Status = "explained"
			tc.Why = "only meta.logMessages differs, and every differing record's log is exactly the archive's log as Agave's default 10,000-byte log limit records it (\"Log truncated\"), with every other field equal"
		default:
			tc.Status = "differs"
			out.Unexplained++
		}
	}
	out.Equal = out.Unexplained == 0
	if len(out.StatsDiffer) == 0 {
		out.StatsDiffer = nil
	}
	return out
}

// rawDiffExplained checks every record of every differing block: each must be equal
// or explained by recordExplained, and both sides must hold the same records.
func rawDiffExplained(b, c *tableDigest, blocks []string) bool {
	if b.Records == nil || c.Records == nil || len(blocks) == 0 {
		return false
	}
	in := map[string]bool{}
	for _, s := range blocks {
		in[s] = true
	}
	seen := 0
	for k, br := range b.Records {
		if !in[k[:strings.IndexByte(k, ':')]] {
			continue
		}
		cr := c.Records[k]
		if cr == nil {
			return false
		}
		seen++
		if br.Full != cr.Full && !recordExplained(br, cr) {
			return false
		}
	}
	for k := range c.Records {
		if in[k[:strings.IndexByte(k, ':')]] {
			seen--
		}
	}
	return seen == 0
}

func isEmptyJSON(b []byte) bool {
	s := string(b)
	return s == "null" || s == "{}" || s == "[]"
}

// writeDigest and readDigest store a digest as zstd-compressed JSON.
func writeDigest(path string, d *unitDigest) error {
	b, err := json.Marshal(d)
	if err != nil {
		return err
	}
	enc, _ := zstd.NewWriter(nil, zstd.WithEncoderLevel(zstd.SpeedBestCompression))
	return os.WriteFile(path, enc.EncodeAll(b, nil), 0o644)
}

func readDigest(path string) (*unitDigest, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if strings.HasSuffix(path, ".zst") {
		if b, err = zstdDec.DecodeAll(b, nil); err != nil {
			return nil, err
		}
	}
	var d unitDigest
	if err := json.Unmarshal(b, &d); err != nil {
		return nil, err
	}
	return &d, nil
}
