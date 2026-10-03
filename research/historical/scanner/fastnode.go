package main

// Reader for the archive's DAG-CBOR nodes (schema: yellowstone-faithful
// ledger.ipldsch). Only what the scanner needs:
//   Transaction [kind=0, data DataFrame, metadata DataFrame, slot, index?]
//   Block       [kind=2, slot, shredding, entries, meta [parent_slot, blocktime, height?], rewards]
//   DataFrame   [kind=6, hash?, index?, total?, data bytes, next [link]?]
// Large payloads are split into frames chained by `next` links; frames are ordered by
// index and checked against `hash` (CRC-64/ISO, or FNV-64a in older archives).

import (
	"errors"
	"fmt"
	"hash/crc64"
	"hash/fnv"
	"sort"
)

const (
	kindTransaction = 0
	kindBlock       = 2
	kindDataFrame   = 6
)

var errCBOR = errors.New("unexpected CBOR")

type cborR struct {
	b []byte
	p int
}

// head reads a CBOR item head: major type, argument, and whether it was null.
func (r *cborR) head() (major byte, arg uint64, null bool, ok bool) {
	if r.p >= len(r.b) {
		return 0, 0, false, false
	}
	c := r.b[r.p]
	r.p++
	major, info := c>>5, c&0x1f
	if c == 0xf6 || c == 0xf7 { // null, undefined
		return 7, 0, true, true
	}
	switch {
	case info < 24:
		arg = uint64(info)
	case info == 24:
		if r.p+1 > len(r.b) {
			return 0, 0, false, false
		}
		arg = uint64(r.b[r.p])
		r.p++
	case info == 25:
		if r.p+2 > len(r.b) {
			return 0, 0, false, false
		}
		arg = uint64(r.b[r.p])<<8 | uint64(r.b[r.p+1])
		r.p += 2
	case info == 26:
		if r.p+4 > len(r.b) {
			return 0, 0, false, false
		}
		for i := 0; i < 4; i++ {
			arg = arg<<8 | uint64(r.b[r.p+i])
		}
		r.p += 4
	case info == 27:
		if r.p+8 > len(r.b) {
			return 0, 0, false, false
		}
		for i := 0; i < 8; i++ {
			arg = arg<<8 | uint64(r.b[r.p+i])
		}
		r.p += 8
	default:
		return 0, 0, false, false // indefinite lengths are not used by the archive
	}
	return major, arg, false, true
}

// skip skips one complete item.
func (r *cborR) skip() bool {
	major, arg, null, ok := r.head()
	if !ok {
		return false
	}
	if null {
		return true
	}
	switch major {
	case 0, 1, 7:
		return true
	case 2, 3:
		if arg > uint64(len(r.b)-r.p) {
			return false
		}
		r.p += int(arg)
		return true
	case 4:
		for i := uint64(0); i < arg; i++ {
			if !r.skip() {
				return false
			}
		}
		return true
	case 5:
		for i := uint64(0); i < 2*arg; i++ {
			if !r.skip() {
				return false
			}
		}
		return true
	case 6:
		return r.skip()
	}
	return false
}

// optUint reads an unsigned integer or null.
func (r *cborR) optUint() (uint64, bool, error) {
	major, v, null, ok := r.head()
	if !ok {
		return 0, false, errCBOR
	}
	if null {
		return 0, false, nil
	}
	if major != 0 {
		return 0, false, errCBOR
	}
	return v, true, nil
}

// optInt reads a signed or unsigned integer, or null (frame hashes are signed ints).
func (r *cborR) optInt() (uint64, bool, error) {
	major, v, null, ok := r.head()
	if !ok {
		return 0, false, errCBOR
	}
	if null {
		return 0, false, nil
	}
	switch major {
	case 0:
		return v, true, nil
	case 1:
		return uint64(-1 - int64(v)), true, nil
	}
	return 0, false, errCBOR
}

type frame struct {
	hash     uint64
	hasHash  bool
	index    uint64
	hasIndex bool
	total    uint64
	hasTotal bool
	data     []byte
	next     []string // CID bytes as map keys
}

func (r *cborR) frame() (*frame, error) {
	major, n, _, ok := r.head()
	if !ok || major != 4 || n < 5 {
		return nil, errCBOR
	}
	if m, kind, _, ok := r.head(); !ok || m != 0 || kind != kindDataFrame {
		return nil, errCBOR
	}
	f := &frame{}
	var err error
	if f.hash, f.hasHash, err = r.optInt(); err != nil {
		return nil, err
	}
	if f.index, f.hasIndex, err = r.optUint(); err != nil {
		return nil, err
	}
	if f.total, f.hasTotal, err = r.optUint(); err != nil {
		return nil, err
	}
	major, l, _, ok := r.head()
	if !ok || major != 2 || l > uint64(len(r.b)-r.p) {
		return nil, errCBOR
	}
	f.data = r.b[r.p : r.p+int(l)]
	r.p += int(l)
	if n >= 6 {
		major, cnt, null, ok := r.head()
		if !ok {
			return nil, errCBOR
		}
		if !null {
			if major != 4 {
				return nil, errCBOR
			}
			for i := uint64(0); i < cnt; i++ {
				// link: tag 42 + byte string 0x00 | CID
				if m, tag, _, ok := r.head(); !ok || m != 6 || tag != 42 {
					return nil, errCBOR
				}
				m, bl, _, ok := r.head()
				if !ok || m != 2 || bl < 1 || bl > uint64(len(r.b)-r.p) {
					return nil, errCBOR
				}
				f.next = append(f.next, string(r.b[r.p+1:r.p+int(bl)]))
				r.p += int(bl)
			}
		}
	}
	for i := uint64(6); i < n; i++ {
		if !r.skip() {
			return nil, errCBOR
		}
	}
	return f, nil
}

// frameGetterFn returns the DataFrame node stored under a CID.
type frameGetterFn func(cid string) (*frame, error)

func parseFrameNode(raw []byte) (*frame, error) {
	return (&cborR{b: raw}).frame()
}

// loadFrames returns the complete payload starting at the first frame.
func loadFrames(first *frame, get frameGetterFn) ([]byte, error) {
	if !first.hasTotal || first.total <= 1 {
		return first.data, nil
	}
	all, err := gatherFrames(first, get, 0)
	if err != nil {
		return nil, err
	}
	if uint64(len(all)) != first.total {
		return nil, fmt.Errorf("expected %d frames, got %d", first.total, len(all))
	}
	sort.SliceStable(all, func(i, j int) bool {
		if !all[i].hasIndex || !all[j].hasIndex {
			return all[i].hasIndex
		}
		return all[i].index < all[j].index
	})
	var out []byte
	for _, f := range all {
		out = append(out, f.data...)
	}
	if first.hasHash {
		if crc64.Checksum(out, crcTable) != first.hash {
			h := fnv.New64a()
			h.Write(out)
			if h.Sum64() != first.hash {
				return nil, fmt.Errorf("frame data hash mismatch")
			}
		}
	}
	return out, nil
}

var crcTable = crc64.MakeTable(crc64.ISO)

func gatherFrames(f *frame, get frameGetterFn, depth int) ([]*frame, error) {
	if depth > 10000 {
		return nil, fmt.Errorf("frame chain too long")
	}
	out := []*frame{f}
	for _, c := range f.next {
		nf, err := get(c)
		if err != nil {
			return nil, err
		}
		more, err := gatherFrames(nf, get, depth+1)
		if err != nil {
			return nil, err
		}
		out = append(out, more...)
	}
	return out, nil
}

// txNode parses a Transaction node into its transaction bytes, compressed metadata
// and position in the block (-1 if absent).
func txNode(raw []byte, get frameGetterFn) (data, meta []byte, index int, err error) {
	r := &cborR{b: raw}
	major, n, _, ok := r.head()
	if !ok || major != 4 || n < 4 {
		return nil, nil, 0, errCBOR
	}
	if m, kind, _, ok := r.head(); !ok || m != 0 || kind != kindTransaction {
		return nil, nil, 0, errCBOR
	}
	df, err := r.frame()
	if err != nil {
		return nil, nil, 0, err
	}
	mf, err := r.frame()
	if err != nil {
		return nil, nil, 0, err
	}
	if !r.skip() { // slot
		return nil, nil, 0, errCBOR
	}
	index = -1
	if n >= 5 {
		v, has, err := r.optUint()
		if err != nil {
			return nil, nil, 0, err
		}
		if has {
			index = int(v)
		}
	}
	if data, err = loadFrames(df, get); err != nil {
		return nil, nil, 0, fmt.Errorf("transaction data: %w", err)
	}
	if meta, err = loadFrames(mf, get); err != nil {
		return nil, nil, 0, fmt.Errorf("transaction meta: %w", err)
	}
	return data, meta, index, nil
}

// blockNode parses a Block node's slot, parent slot and block time.
func blockNode(raw []byte) (slot, parent uint64, blockTime int64, err error) {
	r := &cborR{b: raw}
	major, n, _, ok := r.head()
	if !ok || major != 4 || n < 5 {
		return 0, 0, 0, errCBOR
	}
	if m, kind, _, ok := r.head(); !ok || m != 0 || kind != kindBlock {
		return 0, 0, 0, errCBOR
	}
	s, has, err := r.optUint()
	if err != nil || !has {
		return 0, 0, 0, errCBOR
	}
	if !r.skip() || !r.skip() { // shredding, entries
		return 0, 0, 0, errCBOR
	}
	major, mn, _, ok := r.head()
	if !ok || major != 4 || mn < 2 {
		return 0, 0, 0, errCBOR
	}
	p, has, err := r.optUint()
	if err != nil || !has {
		return 0, 0, 0, errCBOR
	}
	bt, _, err := r.optInt()
	if err != nil {
		return 0, 0, 0, errCBOR
	}
	return s, p, int64(bt), nil
}
