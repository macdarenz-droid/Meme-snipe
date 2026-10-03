package main

// Locating blocks inside an epoch's CAR file without the archive's index files, by
// probing the CAR itself: read a window at an offset, resynchronise on a section whose
// data hashes to its CID, then walk sections to the next block node.
//
// CARv1 section: uvarint(len) | CID | data. Every node of the Solana archive is
// DAG-CBOR hashed with sha2-256, so its CID is 0x01 0x71 0x12 0x20 + 32-byte digest
// and sha256(data) must equal the digest. A false match needs a 2^-256 collision.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

const probeWindow = 4 << 20

// errNoBlock: no block node after the offset (only subset and epoch nodes follow).
var errNoBlock = errors.New("no block after offset")

var cidPrefix = []byte{0x01, 0x71, 0x12, 0x20}

type blockRef struct {
	Slot      uint64 `json:"slot"`
	Parent    uint64 `json:"parent"`
	BlockTime int64  `json:"block_time"`
	End       int64  `json:"end"` // offset just after the block node
}

// sectionAt checks whether a valid section starts at b[p:]; it returns the section's
// total length, the data and true. need > 0 means more bytes are required.
func sectionAt(b []byte, p int) (total int, data []byte, ok bool, need int) {
	l, n := uvarint(b[p:])
	if n <= 0 {
		if n == 0 {
			return 0, nil, false, 10
		}
		return 0, nil, false, 0
	}
	if l < 36 || l > 64<<20 {
		return 0, nil, false, 0
	}
	if p+n+int(l) > len(b) {
		if p+n+4 <= len(b) && !bytes.Equal(b[p+n:p+n+4], cidPrefix) {
			return 0, nil, false, 0
		}
		return 0, nil, false, p + n + int(l) - len(b)
	}
	sec := b[p+n : p+n+int(l)]
	if !bytes.Equal(sec[:4], cidPrefix) {
		return 0, nil, false, 0
	}
	data = sec[36:]
	sum := sha256.Sum256(data)
	if !bytes.Equal(sum[:], sec[4:36]) {
		return 0, nil, false, 0
	}
	return n + int(l), data, true, 0
}

// firstBlockFrom returns the first block node that ends after offset `off`, reading
// forward as needed.
func (e *Epoch) firstBlockFrom(ctx context.Context, off int64) (*blockRef, error) {
	if off < e.headerEnd {
		off = e.headerEnd
	}
	if off >= e.CarSize {
		return nil, errNoBlock
	}
	buf, err := fetchRange(ctx, e.CarURL, off, minI64(probeWindow, e.CarSize-off))
	if err != nil {
		return nil, err
	}
	base := off
	more := func(n int) error {
		if base+int64(len(buf)) >= e.CarSize {
			return errNoBlock
		}
		want := maxI64(int64(n), probeWindow)
		b, err := fetchRange(ctx, e.CarURL, base+int64(len(buf)), minI64(want, e.CarSize-base-int64(len(buf))))
		if err != nil {
			return err
		}
		buf = append(buf, b...)
		return nil
	}
	// resynchronise: the first position where three sections in a row validate
	// (or one, if it is followed by the end of the file)
	p := -1
	for q := 0; p < 0; q++ {
		if q >= len(buf)-40 {
			if q > 64<<20 {
				return nil, fmt.Errorf("no section boundary found after offset %d", off)
			}
			if err := more(0); err != nil {
				return nil, err
			}
		}
		t, _, ok, need := sectionAt(buf, q)
		for need > 0 {
			if err := more(need); err != nil {
				return nil, err
			}
			t, _, ok, need = sectionAt(buf, q)
		}
		if !ok {
			continue
		}
		good := true
		r := q + t
		for k := 0; k < 2 && base+int64(r) < e.CarSize; k++ {
			t2, _, ok2, need2 := sectionAt(buf, r)
			for need2 > 0 {
				if err := more(need2); err != nil {
					return nil, err
				}
				t2, _, ok2, need2 = sectionAt(buf, r)
			}
			if !ok2 {
				good = false
				break
			}
			r += t2
		}
		if good {
			p = q
		}
	}
	// walk to the next block node
	for {
		if p >= len(buf)-10 {
			if err := more(0); err != nil {
				return nil, err
			}
		}
		t, data, ok, need := sectionAt(buf, p)
		for need > 0 {
			if err := more(need); err != nil {
				return nil, err
			}
			t, data, ok, need = sectionAt(buf, p)
		}
		if !ok {
			return nil, fmt.Errorf("lost section sync at offset %d", base+int64(p))
		}
		if len(data) > 1 && data[1] == kindBlock {
			slot, parent, bt, err := blockNode(data)
			if err != nil {
				return nil, fmt.Errorf("block at %d: %w", base+int64(p), err)
			}
			return &blockRef{Slot: slot, Parent: parent, BlockTime: bt, End: base + int64(p+t)}, nil
		}
		p += t
	}
}

// boundary returns the offset just after the block node of the last block with
// slot < s (the CAR header end if there is none), together with the first block at or
// after that offset (nil if none).
func (e *Epoch) boundary(ctx context.Context, s uint64) (int64, *blockRef, error) {
	e.mu.Lock()
	if v, ok := e.bounds[s]; ok {
		e.mu.Unlock()
		return v.off, v.next, nil
	}
	e.mu.Unlock()
	lo, hi := e.headerEnd, e.CarSize // invariant: block found from lo has slot < s (or lo is the header end)
	first, err := e.firstBlockFrom(ctx, lo)
	if err != nil {
		return 0, nil, err
	}
	if first.Slot >= s {
		e.storeBound(s, e.headerEnd, first)
		return e.headerEnd, first, nil
	}
	lo = first.End
	for hi-lo > probeWindow {
		mid := lo + (hi-lo)/2
		b, err := e.firstBlockFrom(ctx, mid)
		if errors.Is(err, errNoBlock) {
			hi = mid // only the epoch's trailing nodes after mid
			continue
		}
		if err != nil {
			return 0, nil, err
		}
		if b.Slot < s {
			lo = b.End
		} else {
			hi = mid
		}
	}
	// walk forward from lo, block by block
	off := lo
	for {
		b, err := e.firstBlockFrom(ctx, off)
		if errors.Is(err, errNoBlock) {
			e.storeBound(s, off, nil)
			return off, nil, nil
		}
		if err != nil {
			return 0, nil, err
		}
		if b.Slot >= s {
			e.storeBound(s, off, b)
			return off, b, nil
		}
		off = b.End
	}
}

type boundVal struct {
	off  int64
	next *blockRef
}

func (e *Epoch) storeBound(s uint64, off int64, next *blockRef) {
	e.mu.Lock()
	e.bounds[s] = boundVal{off, next}
	e.mu.Unlock()
	e.saveBounds()
}

// bounds are cached per epoch: CAR files are immutable (content-addressed by RootCid).
type boundsFile struct {
	RootCid string               `json:"root_cid"`
	Bounds  map[string]boundJSON `json:"bounds"`
}

type boundJSON struct {
	Off  int64     `json:"off"`
	Next *blockRef `json:"next"`
}

func (e *Epoch) boundsPath() string {
	return filepath.Join(e.cacheDir, fmt.Sprintf("bounds-%d.json", e.N))
}

func (e *Epoch) loadBounds() {
	e.bounds = map[uint64]boundVal{}
	b, err := os.ReadFile(e.boundsPath())
	if err != nil {
		return
	}
	var f boundsFile
	if json.Unmarshal(b, &f) != nil || f.RootCid != e.RootCid {
		return
	}
	for k, v := range f.Bounds {
		var s uint64
		fmt.Sscan(k, &s)
		e.bounds[s] = boundVal{v.Off, v.Next}
	}
}

var boundsSaveMu sync.Mutex

func (e *Epoch) saveBounds() {
	boundsSaveMu.Lock()
	defer boundsSaveMu.Unlock()
	e.mu.Lock()
	f := boundsFile{RootCid: e.RootCid, Bounds: map[string]boundJSON{}}
	for s, v := range e.bounds {
		f.Bounds[fmt.Sprint(s)] = boundJSON{v.off, v.next}
	}
	e.mu.Unlock()
	b, _ := json.Marshal(f)
	tmp := e.boundsPath() + ".tmp"
	if os.WriteFile(tmp, b, 0o644) == nil {
		os.Rename(tmp, e.boundsPath())
	}
}

// ByteRange returns the CAR byte range holding every node of blocks in [from, to] and
// the first block in the range (nil if no block was produced in it).
func (e *Epoch) ByteRange(ctx context.Context, from, to uint64) (int64, int64, *blockRef, error) {
	start, first, err := e.boundary(ctx, from)
	if err != nil {
		return 0, 0, nil, err
	}
	end, _, err := e.boundary(ctx, to+1)
	if err != nil {
		return 0, 0, nil, err
	}
	if first != nil && first.Slot > to {
		first = nil
	}
	return start, end, first, nil
}

func minI64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}

func maxI64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}
