package main

// Access to the Old Faithful public Solana archive (https://files.old-faithful.net):
// one CAR file per epoch plus compact indexes, read with HTTP range requests.

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ipfs/go-cid"
	"github.com/rpcpool/yellowstone-faithful/blocktimeindex"
	"github.com/rpcpool/yellowstone-faithful/indexes"
)

const archiveBase = "https://files.old-faithful.net"

var httpClient = &http.Client{
	Timeout: 120 * time.Second,
	Transport: &http.Transport{
		Proxy:               http.ProxyFromEnvironment,
		MaxIdleConns:        256,
		MaxIdleConnsPerHost: 256,
		IdleConnTimeout:     90 * time.Second,
		// HTTP/1.1 with one TCP connection per parallel chunk: over HTTP/2 every
		// request shares one connection, which caps throughput at ~25 MB/s.
		ForceAttemptHTTP2: false,
		TLSNextProto:      map[string]func(string, *tls.Conn) http.RoundTripper{},
	},
}

// Counters reported in every unit's stats.
var (
	statHTTPRequests atomic.Int64
	statHTTPRetries  atomic.Int64
	statHTTP429      atomic.Int64
	statBytes        atomic.Int64
)

// limiter spaces request starts so the archive sees at most `rps` requests per second
// from this process (measured: 100 req/s sustained is accepted; bursts of ~200/s get 429).
type limiter struct {
	mu   sync.Mutex
	next time.Time
	gap  time.Duration
}

func newLimiter(rps float64) *limiter {
	return &limiter{gap: time.Duration(float64(time.Second) / rps)}
}

func (l *limiter) wait() {
	l.mu.Lock()
	now := time.Now()
	if l.next.Before(now) {
		l.next = now
	}
	t := l.next
	l.next = l.next.Add(l.gap)
	l.mu.Unlock()
	if d := time.Until(t); d > 0 {
		time.Sleep(d)
	}
}

var reqLimiter = newLimiter(40)

// fetchRange returns bytes [off, off+n) of url, retrying on network errors, 429 and 5xx.
func fetchRange(ctx context.Context, url string, off, n int64) ([]byte, error) {
	backoff := 500 * time.Millisecond
	var lastErr error
	for attempt := 0; attempt < 12; attempt++ {
		if attempt > 0 {
			statHTTPRetries.Add(1)
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(backoff):
			}
			if backoff < 30*time.Second {
				backoff *= 2
			}
		}
		reqLimiter.wait()
		statHTTPRequests.Add(1)
		req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", off, off+n-1))
		resp, err := httpClient.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		ok := resp.StatusCode == http.StatusPartialContent || (resp.StatusCode == http.StatusOK && off == 0)
		if !ok {
			io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
			resp.Body.Close()
			if resp.StatusCode == 429 {
				statHTTP429.Add(1)
			}
			lastErr = fmt.Errorf("status %d for %s range %d+%d", resp.StatusCode, url, off, n)
			if resp.StatusCode == 404 || resp.StatusCode == 416 {
				return nil, lastErr
			}
			continue
		}
		buf := make([]byte, n)
		_, err = io.ReadFull(resp.Body, buf)
		resp.Body.Close()
		if err != nil {
			lastErr = err
			continue
		}
		statBytes.Add(n)
		return buf, nil
	}
	return nil, fmt.Errorf("giving up: %w", lastErr)
}

// remoteFile is an io.ReaderAt over an archive file.
type remoteFile struct {
	url  string
	size int64
}

func (r *remoteFile) ReadAt(p []byte, off int64) (int, error) {
	if off >= r.size {
		return 0, io.EOF
	}
	n := int64(len(p))
	short := false
	if off+n > r.size {
		n = r.size - off
		short = true
	}
	b, err := fetchRange(context.Background(), r.url, off, n)
	if err != nil {
		return 0, err
	}
	copy(p, b)
	if short {
		return int(n), io.EOF
	}
	return int(n), nil
}
func (r *remoteFile) Close() error { return nil }
func (r *remoteFile) Size() int64  { return r.size }

func headSize(url string) (int64, error) {
	for attempt := 0; attempt < 6; attempt++ {
		reqLimiter.wait()
		resp, err := httpClient.Head(url)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == 200 && resp.ContentLength > 0 {
				return resp.ContentLength, nil
			}
			err = fmt.Errorf("HEAD %s: status %d", url, resp.StatusCode)
			if resp.StatusCode == 404 {
				return 0, err
			}
		}
		time.Sleep(time.Duration(attempt+1) * 2 * time.Second)
		if attempt == 5 {
			return 0, err
		}
	}
	return 0, fmt.Errorf("unreachable")
}

func fetchSmall(url string) ([]byte, error) {
	for attempt := 0; attempt < 6; attempt++ {
		reqLimiter.wait()
		resp, err := httpClient.Get(url)
		if err == nil {
			b, rerr := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode == 200 && rerr == nil {
				return b, nil
			}
			err = fmt.Errorf("GET %s: status %d %v", url, resp.StatusCode, rerr)
			if resp.StatusCode == 404 {
				return nil, err
			}
		}
		time.Sleep(time.Duration(attempt+1) * 2 * time.Second)
		if attempt == 5 {
			return nil, err
		}
	}
	return nil, fmt.Errorf("unreachable")
}

// Epoch bundles what is needed to locate blocks of one epoch in its CAR file.
type Epoch struct {
	N          uint64
	RootCid    string
	CarURL     string
	CarSize    int64
	slotToCid  *indexes.SlotToCid_Reader
	cidToOff   *indexes.CidToOffsetAndSize_Reader
	blockTimes *blocktimeindex.Index
}

func epochFirstSlot(e uint64) uint64 { return e * 432000 }
func epochLastSlot(e uint64) uint64  { return e*432000 + 431999 }

// cachedFile downloads a small archive file once into cacheDir.
func cachedFile(cacheDir, url string) (string, error) {
	p := filepath.Join(cacheDir, filepath.Base(url))
	if st, err := os.Stat(p); err == nil && st.Size() > 0 {
		return p, nil
	}
	b, err := fetchSmall(url)
	if err != nil {
		return "", err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return "", err
	}
	return p, os.Rename(tmp, p)
}

func OpenEpoch(n uint64, cacheDir string) (*Epoch, error) {
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		return nil, err
	}
	cidPath, err := cachedFile(cacheDir, fmt.Sprintf("%s/%d/epoch-%d.cid", archiveBase, n, n))
	if err != nil {
		return nil, fmt.Errorf("epoch %d not in archive yet: %w", n, err)
	}
	rootB, _ := os.ReadFile(cidPath)
	root := strings.TrimSpace(string(rootB))
	base := fmt.Sprintf("%s/%d/epoch-%d-%s-mainnet", archiveBase, n, n, root)
	e := &Epoch{N: n, RootCid: root, CarURL: fmt.Sprintf("%s/%d/epoch-%d.car", archiveBase, n, n)}
	if e.CarSize, err = headSize(e.CarURL); err != nil {
		return nil, err
	}
	s2c, err := cachedFile(cacheDir, base+"-slot-to-cid.index")
	if err != nil {
		return nil, err
	}
	if e.slotToCid, err = indexes.Open_SlotToCid(s2c); err != nil {
		return nil, fmt.Errorf("slot-to-cid: %w", err)
	}
	btPath, err := cachedFile(cacheDir, base+"-slot-to-blocktime.index")
	if err != nil {
		return nil, err
	}
	btBytes, _ := os.ReadFile(btPath)
	if e.blockTimes, err = blocktimeindex.FromBytes(btBytes); err != nil {
		return nil, fmt.Errorf("slot-to-blocktime: %w", err)
	}
	c2oURL := base + "-cid-to-offset-and-size.index"
	c2oSize, err := headSize(c2oURL)
	if err != nil {
		return nil, err
	}
	if e.cidToOff, err = indexes.OpenWithReader_CidToOffsetAndSize(&remoteFile{url: c2oURL, size: c2oSize}); err != nil {
		return nil, fmt.Errorf("cid-to-offset: %w", err)
	}
	return e, nil
}

// BlockTime returns the block time of slot, or false if the slot has no block.
func (e *Epoch) BlockTime(slot uint64) (int64, bool) {
	t, err := e.blockTimes.Get(slot)
	if err != nil || t == 0 {
		return 0, false
	}
	return t, true
}

// blockNode returns the CAR offset and size of the block node of slot (false if skipped).
func (e *Epoch) blockNode(slot uint64) (uint64, uint64, bool, error) {
	c, err := e.slotToCid.Get(slot)
	if err != nil {
		return 0, 0, false, nil // skipped slot
	}
	if c == cid.Undef {
		return 0, 0, false, nil
	}
	os, err := e.cidToOff.Get(c)
	if err != nil {
		return 0, 0, false, fmt.Errorf("cid-to-offset for slot %d: %w", slot, err)
	}
	return os.Offset, os.Size, true, nil
}

// ByteRange returns the CAR byte range holding every node of blocks in [from, to].
// Nodes of a block precede its block node, so the range starts right after the block
// node of the last produced slot before `from` and ends after the block node of the
// last produced slot <= `to`.
func (e *Epoch) ByteRange(from, to uint64) (int64, int64, error) {
	var start int64 = -1
	for s := int64(from) - 1; s >= int64(epochFirstSlot(e.N)); s-- {
		off, size, ok, err := e.blockNode(uint64(s))
		if err != nil {
			return 0, 0, err
		}
		if ok {
			start = int64(off + size)
			break
		}
	}
	if start < 0 {
		// first block of the epoch: the CAR header precedes it. Start after the header.
		h, err := carHeaderSize(e.CarURL)
		if err != nil {
			return 0, 0, err
		}
		start = h
	}
	for s := int64(to); s >= int64(from); s-- {
		off, size, ok, err := e.blockNode(uint64(s))
		if err != nil {
			return 0, 0, err
		}
		if ok {
			return start, int64(off + size), nil
		}
	}
	return start, start, nil // no produced block in range
}

func carHeaderSize(url string) (int64, error) {
	b, err := fetchRange(context.Background(), url, 0, 64)
	if err != nil {
		return 0, err
	}
	l, n := uvarint(b)
	if n <= 0 {
		return 0, fmt.Errorf("bad CAR header varint")
	}
	return int64(n) + int64(l), nil
}

func uvarint(b []byte) (uint64, int) {
	var x uint64
	var s uint
	for i, c := range b {
		if i == 10 {
			return 0, -1
		}
		if c < 0x80 {
			return x | uint64(c)<<s, i + 1
		}
		x |= uint64(c&0x7f) << s
		s += 7
	}
	return 0, 0
}

// rangeReader streams [start, end) of a remote file with `conc` parallel chunk
// downloads, delivered in order.
type rangeReader struct {
	ctx    context.Context
	cancel context.CancelFunc
	chunks chan chan chunkResult
	cur    []byte
	err    error
}

type chunkResult struct {
	b   []byte
	err error
}

func newRangeReader(parent context.Context, url string, start, end int64, chunk int64, conc int) *rangeReader {
	ctx, cancel := context.WithCancel(parent)
	rr := &rangeReader{ctx: ctx, cancel: cancel, chunks: make(chan chan chunkResult, conc)}
	go func() {
		defer close(rr.chunks)
		for off := start; off < end; off += chunk {
			n := chunk
			if off+n > end {
				n = end - off
			}
			ch := make(chan chunkResult, 1)
			select {
			case rr.chunks <- ch:
			case <-ctx.Done():
				return
			}
			go func(off, n int64) {
				b, err := fetchRange(ctx, url, off, n)
				ch <- chunkResult{b, err}
			}(off, n)
		}
	}()
	return rr
}

func (r *rangeReader) Read(p []byte) (int, error) {
	for len(r.cur) == 0 {
		if r.err != nil {
			return 0, r.err
		}
		ch, ok := <-r.chunks
		if !ok {
			if err := r.ctx.Err(); err != nil {
				r.err = err // cancelled: never report a clean end of data
				return 0, err
			}
			r.err = io.EOF
			return 0, io.EOF
		}
		res := <-ch
		if res.err != nil {
			r.err = res.err
			return 0, res.err
		}
		r.cur = res.b
	}
	n := copy(p, r.cur)
	r.cur = r.cur[n:]
	return n, nil
}

func (r *rangeReader) Close() { r.cancel() }
