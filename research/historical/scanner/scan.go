package main

// Scanning of one slot range ("unit") of the archive: stream the CAR bytes, group nodes
// per block, keep transactions that touch the pump or PumpSwap programs, decode their
// events and write normalised rows.

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	bin "github.com/gagliardetto/binary"
	"github.com/gagliardetto/solana-go"
	"github.com/klauspost/compress/zstd"
)

// Schema version of the output rows. Bump on any change of columns or meaning.
const schemaVersion = 3

var curveCols = []string{
	"slot", "block_time", "tx_idx", "ev_idx", "signature", "signer", "tx_fee", "cu",
	"mint", "is_buy", "sol_amount", "token_amount", "user", "timestamp",
	"virtual_sol_reserves", "virtual_token_reserves", "real_sol_reserves", "real_token_reserves",
	"fee_recipient", "fee_basis_points", "fee", "creator", "creator_fee_basis_points", "creator_fee",
	"track_volume", "ix_name", "mayhem_mode", "cashback_fee_basis_points", "cashback",
	"buyback_fee_basis_points", "buyback_fee", "shareholders", "quote_mint", "quote_amount",
	"virtual_quote_reserves", "real_quote_reserves", "holder_rewards_bps", "holder_rewards",
	"outer_ix", "inner_ix", "jito_tip", "extra_hex", "layout_fields", "last_in_tx", "chain_curve_lamports", "chain_curve_base", "chain_curve_quote",
	"user_token_account", "user_token_owner",
}

var ammCols = []string{
	"slot", "block_time", "tx_idx", "ev_idx", "signature", "signer", "tx_fee", "cu",
	"pool", "base_mint", "quote_mint", "side", "base_amount", "quote_amount", "limit_quote", "user", "timestamp",
	"pool_base_token_reserves", "pool_quote_token_reserves",
	"lp_fee_basis_points", "lp_fee", "protocol_fee_basis_points", "protocol_fee",
	"quote_amount_lp_adjusted", "user_quote_amount", "protocol_fee_recipient", "coin_creator",
	"coin_creator_fee_basis_points", "coin_creator_fee", "track_volume", "min_base_amount_out", "ix_name",
	"cashback_fee_basis_points", "cashback", "buyback_fee_basis_points", "buyback_fee",
	"virtual_quote_reserves", "can_boost", "base_supply", "holder_rewards_bps", "holder_rewards",
	"outer_ix", "inner_ix", "jito_tip", "extra_hex", "layout_fields", "last_in_tx", "chain_pool_base", "chain_pool_quote",
	"user_token_account", "user_token_owner",
}

var blockCols = []string{"slot", "block_time", "parent_slot", "n_tx", "n_vote", "n_pump_tx", "n_pump_ok", "n_pump_failed", "n_events"}

var failedCols = []string{"slot", "block_time", "tx_idx", "signature", "signer", "tx_fee", "cu", "programs", "mint_hint", "error"}

type UnitStats struct {
	Schema         int            `json:"schema"`
	Epoch          uint64         `json:"epoch"`
	RootCid        string         `json:"root_cid"`
	FromSlot       uint64         `json:"from_slot"`
	ToSlot         uint64         `json:"to_slot"`
	ByteStart      int64          `json:"byte_start"`
	ByteEnd        int64          `json:"byte_end"`
	Blocks         int            `json:"blocks"`
	FirstBlockSlot uint64         `json:"first_block_slot"`
	LastBlockSlot  uint64         `json:"last_block_slot"`
	FirstBlockTime int64          `json:"first_block_time"`
	LastBlockTime  int64          `json:"last_block_time"`
	Txs            int64          `json:"txs"`
	VoteTxs        int64          `json:"vote_txs"`
	PumpTxs        int64          `json:"pump_txs"`
	PumpTxsFailed  int64          `json:"pump_txs_failed"`
	CurveTrades    int64          `json:"curve_trades"`
	AmmTrades      int64          `json:"amm_trades"`
	OtherEvents    int64          `json:"other_events"`
	EventCounts    map[string]int `json:"event_counts"`
	UnknownEvents  map[string]int `json:"unknown_events"`
	DecodeFailures int64          `json:"decode_failures"`
	DecodeErrors   []string       `json:"decode_errors"`
	NewerLayouts   map[string]int `json:"newer_layouts"`
	OlderLayouts   map[string]int `json:"older_layouts"`
	ExtraBytes     map[string]int `json:"extra_bytes"` // event:extra -> count (0 = exact IDL layout)
	// FirstSeen: the first slot of each unknown discriminator ("unknown:prog:hex") and
	// each non-zero extra-bytes key ("extra:prog:Event:n") in the unit, so the
	// 2026-10-02 regime boundary and any later change are located exactly.
	FirstSeen       map[string]uint64 `json:"first_seen_slot"`
	LengthAnomalies int64             `json:"length_anomalies"` // events longer than the IDL by other than 8 bytes
	RawRecords      int64             `json:"raw_records"`
	Movements       int64             `json:"movements"`         // token movement rows (movements.go)
	Delegations     int64             `json:"delegations"`       // delegation rows (delegations.go)
	MintOnlyRecords int64             `json:"mint_only_records"` // raw records of plain token transactions touching a sampled mint
	OtherVenueTxs   int64             `json:"other_venue_txs"`   // transactions touching a sampled mint through other programs (counted, not stored)
	LegacyMeta      int64             `json:"legacy_meta"`
	MissingMeta     int64             `json:"missing_meta"`
	LogEventsSeen   int64             `json:"log_events_seen"`
	MetaOnlyChecks  int64             `json:"meta_only_checks"`
	FullMetaParses  int64             `json:"full_meta_parses"`
	MetaOnlyHits    int64             `json:"meta_only_hits"`
	FirstParentSlot uint64            `json:"first_parent_slot"`
	ChainBreaks     []string          `json:"chain_breaks"`
	Seconds         float64           `json:"seconds"`
	HTTPRequests    int64             `json:"http_requests"`
	HTTPRetries     int64             `json:"http_retries"`
	HTTP429         int64             `json:"http_429"`
	FinishedAt      string            `json:"finished_at"`
	ScannerRevision string            `json:"scanner_revision"`
	SampleRate      float64           `json:"sample_rate"`
	// Retention: which rows the unit keeps (retentionPolicy); empty for older units,
	// which kept trades of sampled mints only.
	Retention string `json:"retention"`
	// OF-3 (canonical.go): the pinned PM-01 migration list's sha256 (K3 units), and the
	// records of the files K2 and K3 units add.
	MigrationListSha256 string `json:"migration_list_sha256,omitempty"`
	RawCanonicalRecords int64  `json:"raw_canonical_records,omitempty"`
	ConfigRecords       int64  `json:"config_records,omitempty"`
	mu                  sync.Mutex
}

func (s *UnitStats) decodeErr(msg string) {
	s.mu.Lock()
	s.DecodeFailures++
	if len(s.DecodeErrors) < 50 {
		s.DecodeErrors = append(s.DecodeErrors, msg)
	}
	s.mu.Unlock()
}

// firstSeen records the first slot of key (caller holds s.mu).
func (s *UnitStats) firstSeen(key string, slot uint64) {
	if v, ok := s.FirstSeen[key]; !ok || slot < v {
		s.FirstSeen[key] = slot
	}
}

// missingMeta counts a transaction stored without its meta: what it touched cannot be
// known, so it is a decode failure, never a silent skip.
func (s *UnitStats) missingMeta(slot uint64, txIdx int) {
	s.mu.Lock()
	s.MissingMeta++
	s.mu.Unlock()
	s.decodeErr(fmt.Sprintf("slot %d idx %d: transaction has no meta", slot, txIdx))
}

// csvOut writes RFC 4180 rows to a zstd-compressed file.
type csvOut struct {
	f  *os.File
	zw *zstd.Encoder
	bw *bufio.Writer
}

func newCSV(path string, cols []string) (*csvOut, error) {
	f, err := os.Create(path)
	if err != nil {
		return nil, err
	}
	zw, err := zstd.NewWriter(f, zstd.WithEncoderLevel(zstd.SpeedBetterCompression))
	if err != nil {
		return nil, err
	}
	c := &csvOut{f: f, zw: zw, bw: bufio.NewWriterSize(zw, 1<<20)}
	if cols != nil {
		c.bw.WriteString(strings.Join(cols, ",") + "\n")
	}
	return c, nil
}

func (c *csvOut) row(vals []string) {
	for i, v := range vals {
		if i > 0 {
			c.bw.WriteByte(',')
		}
		if strings.ContainsAny(v, ",\"\r\n") {
			c.bw.WriteByte('"')
			c.bw.WriteString(strings.ReplaceAll(v, `"`, `""`))
			c.bw.WriteByte('"')
		} else {
			c.bw.WriteString(v)
		}
	}
	c.bw.WriteByte('\n')
}

func (c *csvOut) line(s string) { c.bw.WriteString(s); c.bw.WriteByte('\n') }

func (c *csvOut) close() error {
	if err := c.bw.Flush(); err != nil {
		return err
	}
	if err := c.zw.Close(); err != nil {
		return err
	}
	if err := c.f.Sync(); err != nil {
		return err
	}
	return c.f.Close()
}

// blockData is everything of one block, collected while streaming.
type blockData struct {
	slot      uint64
	parent    uint64
	blockTime int64
	txNodes   [][]byte
	frames    map[string][]byte
}

type blockResult struct {
	slot      uint64
	blockTime int64
	blockRow  []string
	curve     [][]string
	amm       [][]string
	other     []string
	failed    [][]string
	txs, vote int64
	pumpTxs   int64
	pumpFail  int64
	agg       map[aggKey]*aggVal
	raw       []string
	rawCanon  []string // K2/K3: canonical-pool transactions not in raw (canonical.go, OF-3)
	config    []string // K2/K3: transactions that write a fee or venue config account (P12)
	mintOnly  int64
	moves     [][]string
	delegs    [][]string
	partial   []string // non-"pump" mints with pump or PumpSwap events (movement coverage: pump transactions only)
	marks     []coverageMark
}

// openUnitFiles opens a unit's data files in dir (K2 and K3 add raw_canonical and
// config; canonical.go, OF-3).
func openUnitFiles(dir string) (map[string]*csvOut, error) {
	outs := map[string]*csvOut{}
	files := map[string][]string{"curve_trades.csv.zst": curveCols, "amm_trades.csv.zst": ammCols,
		"blocks.csv.zst": blockCols, "failed.csv.zst": failedCols, "events.jsonl.zst": nil, "agg_hourly.csv.zst": aggCols, "raw.jsonl.zst": nil,
		"movements.csv.zst": movementCols, "movement_coverage.csv.zst": movementCoverageCols, "delegations.csv.zst": delegationCols}
	if retentionMode != "" {
		files["raw_canonical.jsonl.zst"], files["config.jsonl.zst"] = nil, nil
	}
	for name, cols := range files {
		o, err := newCSV(filepath.Join(dir, name), cols)
		if err != nil {
			return nil, err
		}
		outs[name] = o
	}
	return outs, nil
}

// ScanUnit scans blocks in [from, to] of epoch e into dir/<from>-<to>/.
func ScanUnit(ctx context.Context, e *Epoch, from, to uint64, outDir string, dlConc int, workers int) (*UnitStats, error) {
	t0 := time.Now()
	st := &UnitStats{Schema: schemaVersion, Epoch: e.N, RootCid: e.RootCid, FromSlot: from, ToSlot: to,
		EventCounts: map[string]int{}, UnknownEvents: map[string]int{}, NewerLayouts: map[string]int{}, OlderLayouts: map[string]int{}, ExtraBytes: map[string]int{}, FirstSeen: map[string]uint64{}, ScannerRevision: scannerRevision, SampleRate: sampleRate, Retention: unitRetention(), MigrationListSha256: k3ListSha}
	req0, ret0, r4290 := statHTTPRequests.Load(), statHTTPRetries.Load(), statHTTP429.Load()

	start, end, firstBlock, err := e.ByteRange(ctx, from, to)
	if err != nil {
		return nil, err
	}
	st.ByteStart, st.ByteEnd = start, end

	tmp := outDir + ".tmp"
	os.RemoveAll(tmp)
	if err := os.MkdirAll(tmp, 0o755); err != nil {
		return nil, err
	}
	outs, err := openUnitFiles(tmp)
	if err != nil {
		return nil, err
	}

	// Stream and split into blocks.
	rr := newRangeReader(ctx, e.CarURL, start, end, 16<<20, dlConc)
	defer rr.Close()
	cnt := &countR{r: rr}
	br := bufio.NewReaderSize(cnt, 4<<20)

	jobs := make(chan *blockData, workers*2)
	type indexed struct {
		seq int
		res *blockResult
	}
	results := make(chan indexed, workers*2)
	var wg sync.WaitGroup
	seqCh := make(chan int, 1)
	_ = seqCh
	type job struct {
		seq int
		b   *blockData
	}
	jobQ := make(chan job, workers*2)
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range jobQ {
				results <- indexed{j.seq, processBlock(j.b, st)}
			}
		}()
	}
	_ = jobs

	// Writer: re-orders results by sequence.
	writeErr := make(chan error, 1)
	go func() {
		pending := map[int]*blockResult{}
		agg := map[aggKey]*aggVal{}
		partial := map[string]bool{}
		var marks []coverageMark
		next := 0
		for r := range results {
			pending[r.seq] = r.res
			for {
				res, ok := pending[next]
				if !ok {
					break
				}
				delete(pending, next)
				next++
				writeResult(outs, res, st, agg)
				for _, m := range res.partial {
					partial[m] = true
				}
				marks = append(marks, res.marks...)
			}
		}
		for _, row := range aggRows(agg) {
			outs["agg_hourly.csv.zst"].row(row)
		}
		for _, row := range coverageRows(partial, marks) {
			outs["movement_coverage.csv.zst"].row(row)
		}
		writeErr <- nil
	}()

	seq := 0
	var readErr error
	cur := &blockData{frames: map[string][]byte{}}
	for {
		c, data, err := readSection(br)
		if err != nil {
			if !errors.Is(err, io.EOF) {
				readErr = err
			}
			break
		}
		if len(data) < 2 {
			readErr = fmt.Errorf("short node")
			break
		}
		switch data[1] {
		case kindTransaction:
			cur.txNodes = append(cur.txNodes, data)
		case kindDataFrame:
			cur.frames[c] = data
		case kindBlock:
			slot, parent, bt, err := blockNode(data)
			if err != nil {
				readErr = fmt.Errorf("decode block: %w", err)
				break
			}
			cur.slot, cur.parent, cur.blockTime = slot, parent, bt
			jobQ <- job{seq, cur}
			seq++
			cur = &blockData{frames: map[string][]byte{}}
		}
		if readErr != nil {
			break
		}
		select {
		case <-ctx.Done():
			readErr = ctx.Err()
		default:
		}
		if readErr != nil {
			break
		}
	}
	if readErr == nil && cnt.n != end-start {
		readErr = fmt.Errorf("read %d bytes, expected %d", cnt.n, end-start)
	}
	if readErr == nil && len(cur.txNodes) > 0 {
		readErr = fmt.Errorf("%d transaction nodes after the last block node", len(cur.txNodes))
	}
	close(jobQ)
	wg.Wait()
	close(results)
	<-writeErr
	if readErr != nil {
		for _, o := range outs {
			o.close()
		}
		return nil, readErr
	}
	for _, o := range outs {
		if err := o.close(); err != nil {
			return nil, err
		}
	}
	// Completeness: the range starts at the first block at or after `from`, and every
	// block names the previous one as its parent, so no block of the chain is missing.
	// Across units, finalize checks each unit's first parent against the previous
	// unit's last block.
	switch {
	case firstBlock == nil && st.Blocks > 0:
		return nil, fmt.Errorf("found %d blocks where the archive has none", st.Blocks)
	case firstBlock != nil && st.FirstBlockSlot != firstBlock.Slot:
		return nil, fmt.Errorf("first block %d, expected %d", st.FirstBlockSlot, firstBlock.Slot)
	case len(st.ChainBreaks) > 0:
		return nil, fmt.Errorf("%d parent-link breaks (first %s)", len(st.ChainBreaks), st.ChainBreaks[0])
	}
	st.Seconds = time.Since(t0).Seconds()
	st.HTTPRequests = statHTTPRequests.Load() - req0
	st.HTTPRetries = statHTTPRetries.Load() - ret0
	st.HTTP429 = statHTTP429.Load() - r4290
	st.FinishedAt = time.Now().UTC().Format(time.RFC3339)
	sb, _ := json.MarshalIndent(st, "", "  ")
	if err := os.WriteFile(filepath.Join(tmp, "stats.json"), sb, 0o644); err != nil {
		return nil, err
	}
	os.RemoveAll(outDir)
	if err := os.Rename(tmp, outDir); err != nil {
		return nil, err
	}
	return st, nil
}

func writeResult(outs map[string]*csvOut, r *blockResult, st *UnitStats, agg map[aggKey]*aggVal) {
	mergeAgg(agg, r.agg)
	st.mu.Lock()
	parent, _ := strconv.ParseUint(r.blockRow[2], 10, 64)
	if st.Blocks == 0 {
		st.FirstBlockSlot = r.slot
		st.FirstBlockTime, _ = strconv.ParseInt(r.blockRow[1], 10, 64)
		st.FirstParentSlot = parent
	} else if parent != st.LastBlockSlot && len(st.ChainBreaks) < 20 {
		st.ChainBreaks = append(st.ChainBreaks, fmt.Sprintf("block %d parent %d, previous block %d", r.slot, parent, st.LastBlockSlot))
	}
	st.Blocks++
	st.LastBlockSlot = r.slot
	st.LastBlockTime, _ = strconv.ParseInt(r.blockRow[1], 10, 64)
	st.Txs += r.txs
	st.VoteTxs += r.vote
	st.PumpTxs += r.pumpTxs
	st.PumpTxsFailed += r.pumpFail
	st.CurveTrades += int64(len(r.curve))
	st.AmmTrades += int64(len(r.amm))
	st.OtherEvents += int64(len(r.other))
	st.RawRecords += int64(len(r.raw))
	st.RawCanonicalRecords += int64(len(r.rawCanon))
	st.ConfigRecords += int64(len(r.config))
	st.MintOnlyRecords += r.mintOnly
	st.Movements += int64(len(r.moves))
	st.Delegations += int64(len(r.delegs))
	st.mu.Unlock()
	outs["blocks.csv.zst"].row(r.blockRow)
	for _, row := range r.curve {
		outs["curve_trades.csv.zst"].row(row)
	}
	for _, row := range r.amm {
		outs["amm_trades.csv.zst"].row(row)
	}
	for _, l := range r.other {
		outs["events.jsonl.zst"].line(l)
	}
	for _, row := range r.failed {
		outs["failed.csv.zst"].row(row)
	}
	for _, l := range r.raw {
		outs["raw.jsonl.zst"].line(l)
	}
	for _, l := range r.rawCanon {
		outs["raw_canonical.jsonl.zst"].line(l)
	}
	for _, l := range r.config {
		outs["config.jsonl.zst"].line(l)
	}
	for _, row := range r.moves {
		outs["movements.csv.zst"].row(row)
	}
	for _, row := range r.delegs {
		outs["delegations.csv.zst"].row(row)
	}
}

type countR struct {
	r *rangeReader
	n int64
}

func (c *countR) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}

// readSection reads one CARv1 section (uvarint length, CID, data) and verifies that
// the data hashes to its CID: every archive node is DAG-CBOR with a sha2-256 CIDv1.
func readSection(br *bufio.Reader) (string, []byte, error) {
	l, err := readUvarint(br)
	if err != nil {
		return "", nil, err
	}
	if l < 36 || l > 1<<30 {
		return "", nil, fmt.Errorf("bad section length %d", l)
	}
	buf := make([]byte, l)
	if _, err := io.ReadFull(br, buf); err != nil {
		if errors.Is(err, io.EOF) {
			err = io.ErrUnexpectedEOF
		}
		return "", nil, err
	}
	if !bytes.Equal(buf[:4], cidPrefix) {
		return "", nil, fmt.Errorf("unexpected CID prefix %x", buf[:4])
	}
	sum := sha256.Sum256(buf[36:])
	if !bytes.Equal(sum[:], buf[4:36]) {
		return "", nil, fmt.Errorf("node data does not match its CID")
	}
	return string(buf[:36]), buf[36:], nil
}

func readUvarint(br *bufio.Reader) (uint64, error) {
	var x uint64
	var s uint
	for i := 0; ; i++ {
		b, err := br.ReadByte()
		if err != nil {
			if i > 0 && errors.Is(err, io.EOF) {
				return 0, io.ErrUnexpectedEOF
			}
			return 0, err
		}
		if i == 10 {
			return 0, fmt.Errorf("varint overflow")
		}
		if b < 0x80 {
			return x | uint64(b)<<s, nil
		}
		x |= uint64(b&0x7f) << s
		s += 7
	}
}

func frameGetter(b *blockData) frameGetterFn {
	return func(c string) (*frame, error) {
		raw, ok := b.frames[c]
		if !ok {
			return nil, fmt.Errorf("frame %x not in block", c)
		}
		return parseFrameNode(raw)
	}
}

func processBlock(b *blockData, st *UnitStats) *blockResult {
	r := &blockResult{slot: b.slot, blockTime: b.blockTime, agg: map[aggKey]*aggVal{}}
	bt := strconv.FormatInt(b.blockTime, 10)
	slot := strconv.FormatUint(b.slot, 10)
	get := frameGetter(b)
	var nEvents int
	for _, raw := range b.txNodes {
		r.txs++
		txBytes, metaBuf, txIdx, err := txNode(raw, get)
		if err != nil {
			st.decodeErr(fmt.Sprintf("slot %d: tx node: %v", b.slot, err))
			continue
		}
		// A vote transaction: every top-level instruction calls the vote program (or
		// the compute budget program) and nothing is loaded from lookup tables. The
		// byte search is only a fast pre-filter; the instructions decide.
		if bytes.Contains(txBytes, voteProgram[:]) && isVoteTx(txBytes) {
			r.vote++
			continue
		}
		staticHit := bytes.Contains(txBytes, pumpProgram[:]) || bytes.Contains(txBytes, ammProgram[:])
		// P12 (K2/K3): a pump_fees admin transaction runs no pump or PumpSwap
		// instruction; its config write is recorded here, and only here.
		if !staticHit && mayWriteConfig(txBytes) {
			configOnlyTx(r, st, b, txIdx, txBytes, metaBuf)
		}
		// Programs reached through an address lookup table are only visible in the meta.
		if !staticHit && !mayLoadAccounts(txBytes) {
			if mintScan {
				mintOnlyTx(r, st, b, txIdx, txBytes, metaBuf)
			}
			continue
		}
		var metaRaw []byte
		if len(metaBuf) > 0 {
			var err error
			metaRaw, err = zstdDec.DecodeAll(metaBuf, nil)
			if err != nil {
				st.decodeErr(fmt.Sprintf("slot %d: meta zstd: %v", b.slot, err))
				continue
			}
		}
		if !staticHit && len(metaRaw) == 0 {
			st.missingMeta(b.slot, txIdx) // programs reached through a lookup table are unknowable
			continue
		}
		if !staticHit {
			st.mu.Lock()
			st.MetaOnlyChecks++
			st.mu.Unlock()
			if !(bytes.Contains(metaRaw, pumpProgram[:]) || bytes.Contains(metaRaw, ammProgram[:])) {
				if mintScan {
					mintOnlyTxRaw(r, st, b, txIdx, txBytes, metaRaw)
				}
				continue
			}
			st.mu.Lock()
			st.MetaOnlyHits++
			st.mu.Unlock()
		}
		processTx(r, st, b, slot, bt, txIdx, txBytes, metaRaw, &nEvents)
	}
	r.blockRow = []string{slot, bt, strconv.FormatUint(b.parent, 10), strconv.FormatInt(r.txs, 10), strconv.FormatInt(r.vote, 10),
		strconv.FormatInt(r.pumpTxs, 10), strconv.FormatInt(r.pumpTxs-r.pumpFail, 10), strconv.FormatInt(r.pumpFail, 10), strconv.Itoa(nEvents)}
	return r
}

// zstdDec is safe for concurrent DecodeAll calls.
var zstdDec, _ = zstd.NewReader(nil, zstd.WithDecoderConcurrency(0))

// mayLoadAccounts reports whether a transaction can load accounts from lookup tables:
// a v0 message with at least one table lookup, or any newer message version (checked
// in the meta). Legacy messages cannot.
func mayLoadAccounts(tx []byte) bool {
	n, sz := compactU16(tx)
	if sz <= 0 {
		return false
	}
	p := sz + n*64
	if p >= len(tx) || tx[p]&0x80 == 0 {
		return false // legacy
	}
	if tx[p] != 0x80 {
		return true // v1 or later: let the meta decide
	}
	p += 1 + 3 // version byte, header
	rd := func() (int, bool) {
		if p >= len(tx) {
			return 0, false
		}
		v, k := compactU16(tx[p:])
		if k <= 0 {
			return 0, false
		}
		p += k
		return v, true
	}
	nk, ok := rd()
	if !ok {
		return true
	}
	p += nk*32 + 32 // keys, blockhash
	ni, ok := rd()
	if !ok {
		return true
	}
	for i := 0; i < ni; i++ {
		p++ // program id index
		na, ok := rd()
		if !ok {
			return true
		}
		p += na
		nd, ok := rd()
		if !ok {
			return true
		}
		p += nd
	}
	nl, ok := rd()
	if !ok {
		return true // malformed: be conservative
	}
	return nl > 0
}

// messageIsVersioned reports whether the message after the signatures has the version
// prefix bit (v0 or v1); only those can load accounts from lookup tables.
func messageIsVersioned(tx []byte) bool {
	n, sz := compactU16(tx)
	if sz <= 0 {
		return false
	}
	off := sz + int(n)*64
	return off < len(tx) && tx[off]&0x80 != 0
}

func compactU16(b []byte) (int, int) {
	v := 0
	for i := 0; i < 3 && i < len(b); i++ {
		v |= int(b[i]&0x7f) << (7 * i)
		if b[i]&0x80 == 0 {
			return v, i + 1
		}
	}
	return 0, -1
}

type ixRef struct {
	program [32]byte
	accts   []int
	data    []byte
	height  int
}

func processTx(r *blockResult, st *UnitStats, b *blockData, slot, bt string, txIdx int, txBytes, metaRaw []byte, nEvents *int) {
	var tx solana.Transaction
	if err := tx.UnmarshalWithDecoder(bin.NewBinDecoder(txBytes)); err != nil {
		st.decodeErr(fmt.Sprintf("slot %d idx %d: tx: %v", b.slot, txIdx, err))
		return
	}
	if len(metaRaw) == 0 {
		st.missingMeta(b.slot, txIdx)
		return
	}
	nKeys := len(tx.Message.AccountKeys)
	meta, err := leanMeta(metaRaw)
	if err == nil && len(meta.PostBalances) != nKeys+len(meta.LoadedWritableAddresses)+len(meta.LoadedReadonlyAddresses) {
		err = errProto // not a protobuf meta (or inconsistent): use the full parser
	}
	if err != nil {
		// Older archive epochs store metas in a legacy (bincode) format; every epoch
		// scanned so far is protobuf. Count and skip rather than guess.
		st.mu.Lock()
		st.LegacyMeta++
		st.mu.Unlock()
		st.decodeErr(fmt.Sprintf("slot %d idx %d: meta is not the expected protobuf", b.slot, txIdx))
		return
	}
	keys := make([][32]byte, 0, len(tx.Message.AccountKeys)+len(meta.LoadedWritableAddresses)+len(meta.LoadedReadonlyAddresses))
	for _, k := range tx.Message.AccountKeys {
		keys = append(keys, k)
	}
	for _, k := range meta.LoadedWritableAddresses {
		var kk [32]byte
		copy(kk[:], k)
		keys = append(keys, kk)
	}
	for _, k := range meta.LoadedReadonlyAddresses {
		var kk [32]byte
		copy(kk[:], k)
		keys = append(keys, kk)
	}
	key := func(i int) [32]byte {
		if i >= 0 && i < len(keys) {
			return keys[i]
		}
		return [32]byte{}
	}
	// P12 (K2/K3): a config write, unless processBlock already recorded it.
	if bytes.Contains(txBytes, pumpProgram[:]) || bytes.Contains(txBytes, ammProgram[:]) || !mayWriteConfig(txBytes) {
		r.addConfig(st, b, txIdx, &tx, txBytes, metaRaw, meta.LoadedWritableAddresses)
	}
	sig := tx.Signatures[0].String()
	signer := solana.PublicKey(key(0)).String()
	fee := strconv.FormatUint(meta.Fee, 10)
	cu := ""
	if meta.ComputeUnitsConsumed != nil {
		cu = strconv.FormatUint(*meta.ComputeUnitsConsumed, 10)
	}
	tidx := strconv.Itoa(txIdx)

	// Instruction sequence in execution order, grouped by top-level instruction.
	groups := make([][]ixRef, len(tx.Message.Instructions))
	for i, ix := range tx.Message.Instructions {
		acc := make([]int, len(ix.Accounts))
		for j, a := range ix.Accounts {
			acc[j] = int(a)
		}
		groups[i] = []ixRef{{program: key(int(ix.ProgramIDIndex)), accts: acc, data: ix.Data, height: 1}}
	}
	for _, inner := range meta.InnerInstructions {
		gi := int(inner.Index)
		if gi < 0 || gi >= len(groups) {
			continue
		}
		for _, ii := range inner.Instructions {
			acc := make([]int, len(ii.Accounts))
			for j, a := range ii.Accounts {
				acc[j] = int(a)
			}
			h := 0
			if ii.StackHeight != nil {
				h = int(*ii.StackHeight)
			}
			groups[gi] = append(groups[gi], ixRef{program: key(int(ii.ProgramIdIndex)), accts: acc, data: ii.Data, height: h})
		}
	}
	touches := false
	programs := map[string]bool{}
	for _, g := range groups {
		for _, ix := range g {
			if ix.program == pumpProgram {
				touches = true
				programs["pump"] = true
			} else if ix.program == ammProgram {
				touches = true
				programs["amm"] = true
			}
		}
	}
	if !touches {
		// Reached here only because a lookup table loads a pump program: no pump
		// instruction ran, so it is plain token activity or another venue, handled like
		// every other non-pump transaction (movements of "pump" mints, sampled raw).
		mintOnlyTxRaw(r, st, b, txIdx, txBytes, metaRaw)
		return
	}
	r.pumpTxs++
	failed := meta.Err != nil && len(meta.Err.Err) > 0
	if failed {
		r.pumpFail++
		progs := make([]string, 0, 2)
		for p := range programs {
			progs = append(progs, p)
		}
		sort.Strings(progs)
		mintHint := ""
		for _, g := range groups {
			for _, ix := range g {
				if (ix.program == pumpProgram || ix.program == ammProgram) && len(ix.accts) > 3 {
					if ix.program == pumpProgram && len(ix.data) >= 8 && isCurveTradeIx(ix.data[:8]) {
						mintHint = solana.PublicKey(key(ix.accts[2])).String()
					} else if ix.program == pumpProgram && len(ix.data) >= 8 && isCurveTradeV2Ix(ix.data[:8]) {
						mintHint = solana.PublicKey(key(ix.accts[1])).String()
					} else if ix.program == ammProgram && len(ix.data) >= 8 && isAmmTradeIx(ix.data[:8]) {
						mintHint = solana.PublicKey(key(ix.accts[3])).String()
					}
				}
			}
		}
		if mintHint != "" && inSample(mintHint) {
			r.failed = append(r.failed, []string{slot, bt, tidx, sig, signer, fee, cu, strings.Join(progs, "|"), mintHint, hexs(meta.Err.Err)})
		}
		nRaw := len(r.raw)
		r.addRaw(st, b, txIdx, sig, txBytes, metaRaw, meta, nil, mintHint)
		r.addCanonical(st, b, txIdx, sig, txBytes, metaRaw, groups, key, len(r.raw) > nRaw)
		return
	}

	// Transactions with log-emitted event data ("Program data:" from any program).
	if bytes.Contains(metaRaw, []byte("Program data: ")) {
		st.mu.Lock()
		st.LogEventsSeen++
		st.mu.Unlock()
	}

	post := meta.PostTokenBalances
	tokBal := func(owner string, mint string) string {
		for _, tb := range post {
			if tb.Owner == owner && (mint == "" || tb.Mint == mint) && tb.UiTokenAmount != nil {
				return tb.UiTokenAmount.Amount
			}
		}
		return ""
	}
	tokBalByIndex := func(idx int) string {
		for _, tb := range post {
			if int(tb.AccountIndex) == idx && tb.UiTokenAmount != nil {
				return tb.UiTokenAmount.Amount
			}
		}
		return ""
	}
	lamportsOf := func(k [32]byte) string {
		for i := range keys {
			if keys[i] == k && i < len(meta.PostBalances) {
				return strconv.FormatUint(meta.PostBalances[i], 10)
			}
		}
		return ""
	}

	// The token account a swap credits or debits and its owner: the post-transaction
	// token balances, else the pre-transaction ones (an account the swap closes), else
	// the owner given when the account was initialised in this transaction.
	var full *TransactionStatusMeta
	var fullErr error
	fullMetaOnce := func() *TransactionStatusMeta {
		if full == nil {
			if full, fullErr = fullMeta(metaRaw); fullErr != nil {
				st.decodeErr(fmt.Sprintf("slot %d idx %d: full meta: %v", b.slot, txIdx, fullErr))
				full = &TransactionStatusMeta{}
			}
		}
		return full
	}
	var temps map[int]string
	swapUser := func(emitter *ixRef) (account, owner string) {
		pos := swapUserAccountPos(emitter)
		if pos < 0 || pos >= len(emitter.accts) {
			return "", ""
		}
		i := emitter.accts[pos]
		account = solana.PublicKey(key(i)).String()
		for _, tb := range post {
			if int(tb.AccountIndex) == i {
				return account, tb.Owner
			}
		}
		for _, tb := range fullMetaOnce().PreTokenBalances {
			if int(tb.AccountIndex) == i {
				return account, tb.Owner
			}
		}
		if temps == nil {
			temps = tempOwners(groups, func(j int) string {
				if j >= 0 && j < len(keys) {
					return solana.PublicKey(keys[j]).String()
				}
				return ""
			})
		}
		return account, temps[i]
	}
	var swapMarks []coverageMark
	slotN := b.slot
	attribute := func(mint string, emitter *ixRef) []string {
		account, owner := swapUser(emitter)
		// boost_buy_and_burn burns what it buys: no holder is credited, nothing unresolved
		boost := emitter != nil && len(emitter.data) >= 8 && bytes.Equal(emitter.data[:8], boostBuyIx)
		if owner == "" && !boost && mint != "" {
			swapMarks = append(swapMarks, coverageMark{mint: mint, scope: "unresolved", reason: "swap_owner_unknown", slot: slotN, txIdx: txIdx})
		}
		return []string{account, owner}
	}

	type pendingRow struct {
		kind string
		key  string
		row  []string
	}
	var rows []pendingRow
	evIdx := 0
	tip := strconv.FormatUint(jitoTip(keys, meta.PreBalances, meta.PostBalances), 10)
	var eventMints []string
	var createdMints []string // creates, migrations and canonical pool creations keep their raw record
	for gi, g := range groups {
		for k, ix := range g {
			// position for the (slot, tx, outer, inner) ordering key; events are
			// self-CPI inner instructions, k = 0 is the top-level instruction itself
			outer := strconv.Itoa(gi)
			inner := ""
			if k > 0 {
				inner = strconv.Itoa(k - 1)
			}
			var prog string
			if ix.program == pumpProgram {
				prog = "pump"
			} else if ix.program == ammProgram {
				prog = "amm"
			} else {
				continue
			}
			if len(ix.data) < 16 || !bytes.Equal(ix.data[:8], eventIxTag) {
				continue
			}
			disc, body := ix.data[8:16], ix.data[16:]
			ev, ok := decodeEvent(prog, disc, body)
			if ev == nil {
				st.mu.Lock()
				st.UnknownEvents[prog+":"+hexs(disc)]++
				st.firstSeen("unknown:"+prog+":"+hexs(disc), b.slot)
				st.mu.Unlock()
				// kept raw for every mint: decodable once the layout is published
				jb, _ := json.Marshal(map[string]any{"slot": b.slot, "block_time": b.blockTime, "tx_idx": txIdx, "ev_idx": evIdx,
					"signature": sig, "signer": signer, "program": prog, "event": "Unknown", "discriminator": hexs(disc), "data_hex": hexs(body),
					"outer_ix": gi, "inner_ix": k - 1})
				r.other = append(r.other, string(jb))
				evIdx++
				continue
			}
			if !ok {
				st.decodeErr(fmt.Sprintf("slot %d idx %d: %s truncated (%d bytes)", b.slot, txIdx, ev.def.name, len(body)))
				evIdx++
				continue
			}
			nFields := ev.n
			st.mu.Lock()
			st.EventCounts[prog+":"+ev.def.name]++
			if ev.extra > 0 {
				st.NewerLayouts[prog+":"+ev.def.name]++
			}
			st.ExtraBytes[prog+":"+ev.def.name+":"+strconv.Itoa(ev.extra)]++
			if ev.extra != 0 {
				st.firstSeen("extra:"+prog+":"+ev.def.name+":"+strconv.Itoa(ev.extra), b.slot)
			}
			if ev.extra != 0 && ev.extra != 8 {
				st.LengthAnomalies++
			}
			if ev.n < len(ev.def.fields) {
				st.OlderLayouts[prog+":"+ev.def.name+":"+strconv.Itoa(ev.n)]++
			}
			st.mu.Unlock()
			*nEvents++
			ctxCols := []string{slot, bt, tidx, strconv.Itoa(evIdx), sig, signer, fee, cu}
			switch {
			case prog == "pump" && ev.def.name == "TradeEvent":
				row := append([]string{}, ctxCols...)
				for _, c := range curveCols[8:38] {
					v := ev.get(c)
					row = append(row, v)
				}
				row = append(row, outer, inner, tip, hexs(ev.tail), strconv.Itoa(nFields), "0", "", "", "")
				row = append(row, attribute(ev.get("mint"), findEmitter(g, k, pumpProgram))...)
				rows = append(rows, pendingRow{"curve", ev.get("mint"), row})
				eventMints = append(eventMints, ev.get("mint"))
			case prog == "amm" && (ev.def.name == "BuyEvent" || ev.def.name == "SellEvent"):
				emitter := findEmitter(g, k, ammProgram)
				baseMint, quoteMint, vb, vq := "", "", "", ""
				if emitter != nil && len(emitter.accts) > 8 {
					baseMint = solana.PublicKey(key(emitter.accts[3])).String()
					quoteMint = solana.PublicKey(key(emitter.accts[4])).String()
					// buy / sell / buy_exact_quote_in: pool vaults are accounts 7 and 8;
					// boost_buy_and_burn: accounts 5 and 6 (pump_amm IDL).
					if len(emitter.data) >= 8 && bytes.Equal(emitter.data[:8], boostBuyIx) {
						vb, vq = strconv.Itoa(emitter.accts[5]), strconv.Itoa(emitter.accts[6])
					} else {
						vb, vq = strconv.Itoa(emitter.accts[7]), strconv.Itoa(emitter.accts[8])
					}
				}
				side, baseAmt, quoteAmt, limit, adj, userQ := "buy", ev.get("base_amount_out"), ev.get("quote_amount_in"), ev.get("max_quote_amount_in"), ev.get("quote_amount_in_with_lp_fee"), ev.get("user_quote_amount_in")
				if ev.def.name == "SellEvent" {
					side, baseAmt, quoteAmt, limit, adj, userQ = "sell", ev.get("base_amount_in"), ev.get("quote_amount_out"), ev.get("min_quote_amount_out"), ev.get("quote_amount_out_without_lp_fee"), ev.get("user_quote_amount_out")
				}
				row := append([]string{}, ctxCols...)
				row = append(row, ev.get("pool"), baseMint, quoteMint, side, baseAmt, quoteAmt, limit, ev.get("user"), ev.get("timestamp"),
					ev.get("pool_base_token_reserves"), ev.get("pool_quote_token_reserves"),
					ev.get("lp_fee_basis_points"), ev.get("lp_fee"), ev.get("protocol_fee_basis_points"), ev.get("protocol_fee"),
					adj, userQ, ev.get("protocol_fee_recipient"), ev.get("coin_creator"),
					ev.get("coin_creator_fee_basis_points"), ev.get("coin_creator_fee"), ev.get("track_volume"), ev.get("min_base_amount_out"), ev.get("ix_name"),
					ev.get("cashback_fee_basis_points"), ev.get("cashback"), ev.get("buyback_fee_basis_points"), ev.get("buyback_fee"),
					ev.get("virtual_quote_reserves"), ev.get("can_boost"), ev.get("base_supply"), ev.get("holder_rewards_bps"), ev.get("holder_rewards"),
					outer, inner, tip, hexs(ev.tail), strconv.Itoa(nFields), "0", vb, vq)
				row = append(row, attribute(baseMint, emitter)...)
				rows = append(rows, pendingRow{"amm", ev.get("pool"), row})
				eventMints = append(eventMints, baseMint)
			default:
				m := map[string]any{"slot": b.slot, "block_time": b.blockTime, "tx_idx": txIdx, "ev_idx": evIdx, "signature": sig,
					"signer": signer, "program": prog, "event": ev.def.name, "layout_fields": nFields, "outer_ix": gi, "inner_ix": k - 1, "jito_tip": tip}
				fields := map[string]string{}
				for i, fd := range ev.def.fields {
					if i < ev.n {
						fields[fd.Name] = ev.values[i]
					}
				}
				m["fields"] = fields
				eventMints = append(eventMints, fields["mint"], fields["base_mint"])
				// Raw records kept whatever the mint's hash: every create (mint authority and
				// extensions), every migration and every canonical pool creation (LP mint,
				// burn and pool setup of every graduate).
				switch {
				case prog == "pump" && (ev.def.name == "CreateEvent" || ev.def.name == "CompletePumpAmmMigrationEvent") && fields["mint"] != "":
					createdMints = append(createdMints, fields["mint"])
				case prog == "amm" && ev.def.name == "CreatePoolEvent" && isCanonicalPool(fields["pool"], fields["base_mint"], fields["quote_mint"]):
					createdMints = append(createdMints, fields["base_mint"])
				}
				if len(ev.tail) > 0 {
					m["extra_hex"] = hexs(ev.tail)
				}
				if ev.def.name == "CompletePumpAmmMigrationEvent" || ev.def.name == "CreatePoolEvent" || ev.def.name == "CreateEvent" {
					// post-transaction state of the new pool / curve, for cross-checks
					if pool := fields["pool"]; pool != "" {
						m["chain_pool_balances"] = ownerBalances(post, pool)
					}
					if bc := fields["bonding_curve"]; bc != "" {
						m["chain_curve_balances"] = ownerBalances(post, bc)
						if pk, err := solana.PublicKeyFromBase58(bc); err == nil {
							m["chain_curve_lamports"] = lamportsOf(pk)
						}
					}
				}
				if keepEvent(ev.def.name, fields) {
					jb, _ := json.Marshal(m)
					r.other = append(r.other, string(jb))
				}
			}
			evIdx++
		}
	}
	// Mark the last trade per curve / pool in the tx and attach post-tx chain state.
	lastSeen := map[string]int{}
	for i, pr := range rows {
		lastSeen[pr.kind+pr.key] = i
	}
	for i, pr := range rows {
		if lastSeen[pr.kind+pr.key] != i {
			if pr.kind == "amm" {
				pr.row[len(pr.row)-4], pr.row[len(pr.row)-3] = "", ""
			}
			r.emitRow(pr.kind, pr.row)
			continue
		}
		if pr.kind == "curve" {
			row := pr.row
			n := len(row) - 2 // the two attribution columns follow the chain columns
			row[n-4] = "1"
			mint := row[8]
			quoteMint := row[8+24] // quote_mint column
			bc := bondingCurvePDA(mint)
			if bc != "" {
				bcPK := solana.MustPublicKeyFromBase58(bc)
				row[n-3] = lamportsOf(bcPK)
				row[n-2] = tokBal(bc, mint)
				if quoteMint != "" && quoteMint != wsolMint {
					row[n-1] = tokBal(bc, quoteMint)
				}
			}
			r.emitRow("curve", row)
		} else {
			row := pr.row
			n := len(row) - 2 // the two attribution columns follow the chain columns
			row[n-3] = "1"
			if vb, err := strconv.Atoi(row[n-2]); err == nil {
				row[n-2] = tokBalByIndex(vb)
			}
			if vq, err := strconv.Atoi(row[n-1]); err == nil {
				row[n-1] = tokBalByIndex(vq)
			}
			r.emitRow("amm", row)
		}
	}
	// Token movements outside the swaps: "pump" mints, and other mints with a pump or
	// PumpSwap event in this transaction (their coverage is listed as partial).
	active := map[string]bool{}
	for _, m := range eventMints {
		if m != "" && m != wsolMint {
			active[m] = true
			if !pumpSuffix(m) {
				r.partial = append(r.partial, m)
			}
		}
	}
	r.marks = append(r.marks, swapMarks...)
	if hasMovementOutsideSwaps(groups) {
		if full := fullMetaOnce(); fullErr == nil {
			want := func(m string) bool { return pumpSuffix(m) || active[m] }
			rows, marks := movementRows(slot, bt, txIdx, keys, groups, full, want)
			r.moves, r.marks = append(r.moves, rows...), append(r.marks, marks...)
			r.delegs = append(r.delegs, delegationRows(slot, bt, txIdx, keys, groups, full, want)...)
		}
	}
	nRaw := len(r.raw)
	r.addRaw(st, b, txIdx, sig, txBytes, metaRaw, meta, createdMints, eventMints...)
	r.addCanonical(st, b, txIdx, sig, txBytes, metaRaw, groups, key, len(r.raw) > nRaw)
}

// addRaw writes the raw record of a transaction that touches a sampled mint, or that
// creates a mint (always, so every CreateEvent row has its raw record; the created
// mints are listed in the record's mints).
func (r *blockResult) addRaw(st *UnitStats, b *blockData, txIdx int, sig string, txBytes, metaRaw []byte, meta *TransactionStatusMeta, created []string, extra ...string) {
	// Cheap check first: the token balances' mints (pre and post) and the event mints.
	hit := len(created) > 0
	for _, m := range extra {
		hit = hit || (m != "" && m != wsolMint && inSample(m))
	}
	if !hit {
		ms, err := metaMints(metaRaw)
		if err != nil {
			st.decodeErr(fmt.Sprintf("slot %d idx %d: meta mints: %v", b.slot, txIdx, err))
			return
		}
		for _, m := range ms {
			hit = hit || (m != wsolMint && inSample(m))
		}
		if !hit {
			return
		}
	}
	// The full meta: the lean one has no pre-token balances, and a mint seen only
	// there (an account closed by a full sell) must still get its record.
	full, err := fullMeta(metaRaw)
	if err != nil {
		st.decodeErr(fmt.Sprintf("slot %d idx %d: full meta: %v", b.slot, txIdx, err))
		return
	}
	mints := sampledMints(full, extra...)
	for _, m := range created {
		if !containsString(mints, m) {
			mints = append(mints, m)
		}
	}
	sort.Strings(mints)
	if len(mints) == 0 {
		return
	}
	r.raw = append(r.raw, buildRawRecord(b.slot, b.blockTime, txIdx, sig, txBytes, full, mints))
}

const wsolMint = "So11111111111111111111111111111111111111112"

func containsString(xs []string, x string) bool {
	for _, y := range xs {
		if y == x {
			return true
		}
	}
	return false
}

func ownerBalances(post []*TokenBalance, owner string) map[string]string {
	out := map[string]string{}
	for _, tb := range post {
		if tb.Owner == owner && tb.UiTokenAmount != nil {
			out[tb.Mint] = tb.UiTokenAmount.Amount
		}
	}
	return out
}

// findEmitter returns the instruction that emitted the event at position k of group g:
// the nearest earlier instruction of `program` one stack level above the event.
func findEmitter(g []ixRef, k int, program [32]byte) *ixRef {
	h := g[k].height
	for i := k - 1; i >= 0; i-- {
		if g[i].program == program && (h == 0 || g[i].height == h-1) && !(len(g[i].data) >= 8 && bytes.Equal(g[i].data[:8], eventIxTag)) {
			return &g[i]
		}
	}
	return nil
}

var boostBuyIx = []byte{105, 68, 6, 175, 0, 7, 35, 162}

var (
	curveTradeIx = [][]byte{{102, 6, 61, 18, 1, 218, 235, 234}, {56, 252, 116, 8, 158, 223, 205, 95}, {51, 230, 133, 164, 1, 127, 131, 173}}
	ammTradeIx   = [][]byte{{102, 6, 61, 18, 1, 218, 235, 234}, {198, 46, 21, 82, 180, 217, 232, 112}, {51, 230, 133, 164, 1, 127, 131, 173}}
)

func isCurveTradeIx(d []byte) bool {
	for _, x := range curveTradeIx {
		if bytes.Equal(d, x) {
			return true
		}
	}
	return false
}

// buy_v2, sell_v2, buy_exact_quote_in_v2: base mint is account 1.
var curveTradeV2Ix = [][]byte{{184, 23, 238, 97, 103, 197, 211, 61}, {93, 246, 130, 60, 231, 233, 64, 178}, {194, 171, 28, 70, 104, 77, 91, 47}}

func isCurveTradeV2Ix(d []byte) bool {
	for _, x := range curveTradeV2Ix {
		if bytes.Equal(d, x) {
			return true
		}
	}
	return false
}

func isAmmTradeIx(d []byte) bool {
	for _, x := range ammTradeIx {
		if bytes.Equal(d, x) {
			return true
		}
	}
	return false
}

var pdaCache sync.Map

func bondingCurvePDA(mint string) string {
	if v, ok := pdaCache.Load(mint); ok {
		return v.(string)
	}
	m, err := solana.PublicKeyFromBase58(mint)
	if err != nil {
		return ""
	}
	pda, _, err := solana.FindProgramAddress([][]byte{[]byte("bonding-curve"), m[:]}, solana.PublicKey(pumpProgram))
	if err != nil {
		return ""
	}
	s := pda.String()
	pdaCache.Store(mint, s)
	return s
}

// mintScan (schema 2): also keep raw records of transactions that do not touch the
// pump programs but move, burn or re-authorise a sampled mint (any sampled mint in
// their token balances). Approved by the supervisor for universe mints.
var mintScan = true

func mintOnlyTx(r *blockResult, st *UnitStats, b *blockData, txIdx int, txBytes, metaBuf []byte) {
	if len(metaBuf) == 0 {
		st.missingMeta(b.slot, txIdx)
		return
	}
	metaRaw, err := zstdDec.DecodeAll(metaBuf, nil)
	if err != nil {
		st.decodeErr(fmt.Sprintf("slot %d: meta zstd: %v", b.slot, err))
		return
	}
	mintOnlyTxRaw(r, st, b, txIdx, txBytes, metaRaw)
}

func mintOnlyTxRaw(r *blockResult, st *UnitStats, b *blockData, txIdx int, txBytes, metaRaw []byte) {
	mints, err := metaMints(metaRaw)
	if err != nil {
		// Not the expected protobuf meta: its token balances cannot be read, so plain
		// activity of a sampled mint could hide here. Counted, never dropped silently.
		st.mu.Lock()
		st.LegacyMeta++
		st.mu.Unlock()
		st.decodeErr(fmt.Sprintf("slot %d idx %d: meta is not the expected protobuf (token balances unreadable)", b.slot, txIdx))
		return
	}
	hit, suffixHit := false, false
	for _, m := range mints {
		if m != wsolMint && inSample(m) {
			hit = true
		}
		if pumpSuffix(m) {
			suffixHit = true
		}
	}
	if !hit && !suffixHit {
		return
	}
	full, err := fullMeta(metaRaw)
	if err != nil {
		st.decodeErr(fmt.Sprintf("slot %d idx %d: full meta: %v", b.slot, txIdx, err))
		return
	}
	var tx solana.Transaction
	if err := tx.UnmarshalWithDecoder(bin.NewBinDecoder(txBytes)); err != nil || len(tx.Signatures) == 0 {
		st.decodeErr(fmt.Sprintf("slot %d idx %d: tx: %v", b.slot, txIdx, err))
		return
	}
	if suffixHit && (full.Err == nil || len(full.Err.Err) == 0) {
		// Movements of "pump" mints in transactions outside pump and PumpSwap.
		mk := make([][32]byte, 0, len(tx.Message.AccountKeys)+len(full.LoadedWritableAddresses)+len(full.LoadedReadonlyAddresses))
		for _, k := range tx.Message.AccountKeys {
			mk = append(mk, k)
		}
		for _, k := range append(append([][]byte{}, full.LoadedWritableAddresses...), full.LoadedReadonlyAddresses...) {
			var kk [32]byte
			copy(kk[:], k)
			mk = append(mk, kk)
		}
		groups := ixGroups(tx, full, mk)
		slotS, btS := strconv.FormatUint(b.slot, 10), strconv.FormatInt(b.blockTime, 10)
		rows, marks := movementRows(slotS, btS, txIdx, mk, groups, full, pumpSuffix)
		r.moves, r.marks = append(r.moves, rows...), append(r.marks, marks...)
		r.delegs = append(r.delegs, delegationRows(slotS, btS, txIdx, mk, groups, full, pumpSuffix)...)
	}
	if !hit {
		return
	}
	ms := sampledMints(full)
	if len(ms) == 0 {
		return
	}
	// Only plain token-program activity (transfers, burns, mint-to, authority and
	// extension changes, account creation): every invoked program must be one of the
	// basic ones. Swaps on other venues are counted, not stored (Zeroed trades only
	// pump and PumpSwap; they would add ~2.5x to the raw records).
	keys := make([][32]byte, 0, len(tx.Message.AccountKeys)+len(full.LoadedWritableAddresses)+len(full.LoadedReadonlyAddresses))
	for _, k := range tx.Message.AccountKeys {
		keys = append(keys, k)
	}
	for _, k := range append(append([][]byte{}, full.LoadedWritableAddresses...), full.LoadedReadonlyAddresses...) {
		var kk [32]byte
		copy(kk[:], k)
		keys = append(keys, kk)
	}
	basicOnly := func(i int) bool { return i >= 0 && i < len(keys) && basicPrograms[keys[i]] }
	for _, ix := range tx.Message.Instructions {
		if !basicOnly(int(ix.ProgramIDIndex)) {
			st.mu.Lock()
			st.OtherVenueTxs++
			st.mu.Unlock()
			return
		}
	}
	for _, ii := range full.InnerInstructions {
		for _, ix := range ii.Instructions {
			if !basicOnly(int(ix.ProgramIdIndex)) {
				st.mu.Lock()
				st.OtherVenueTxs++
				st.mu.Unlock()
				return
			}
		}
	}
	r.raw = append(r.raw, buildRawRecord(b.slot, b.blockTime, txIdx, tx.Signatures[0].String(), txBytes, full, ms))
	r.mintOnly++
}

// ixGroups returns a transaction's instructions grouped by top-level instruction, in
// execution order, with program keys resolved and stack heights from the meta.
func ixGroups(tx solana.Transaction, m *TransactionStatusMeta, keys [][32]byte) [][]ixRef {
	key := func(i int) [32]byte {
		if i >= 0 && i < len(keys) {
			return keys[i]
		}
		return [32]byte{}
	}
	groups := make([][]ixRef, len(tx.Message.Instructions))
	for i, ix := range tx.Message.Instructions {
		acc := make([]int, len(ix.Accounts))
		for j, a := range ix.Accounts {
			acc[j] = int(a)
		}
		groups[i] = []ixRef{{program: key(int(ix.ProgramIDIndex)), accts: acc, data: ix.Data, height: 1}}
	}
	for _, inner := range m.InnerInstructions {
		gi := int(inner.Index)
		if gi < 0 || gi >= len(groups) {
			continue
		}
		for _, ii := range inner.Instructions {
			acc := make([]int, len(ii.Accounts))
			for j, a := range ii.Accounts {
				acc[j] = int(a)
			}
			h := 0
			if ii.StackHeight != nil {
				h = int(*ii.StackHeight)
			}
			groups[gi] = append(groups[gi], ixRef{program: key(int(ii.ProgramIdIndex)), accts: acc, data: ii.Data, height: h})
		}
	}
	return groups
}

// Programs of plain token activity.
var basicPrograms = func() map[[32]byte]bool {
	m := map[[32]byte]bool{}
	for _, a := range []string{
		"11111111111111111111111111111111", "ComputeBudget111111111111111111111111111111",
		"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
		"ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
		"Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
	} {
		m[mustPK(a)] = true
	}
	return m
}()
