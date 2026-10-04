package main

// Access to the Old Faithful public Solana archive (https://files.old-faithful.net):
// one CAR file per epoch plus compact indexes, read with HTTP range requests.

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
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

// At most 10 request starts per second (ARCHIVE-SAFE, research/historical/ci/archive-limits.conf
// ARCHIVE_MAX_RPS; archive-check.sh reads this literal and dispatches nothing above it).
var reqLimiter = newLimiter(10)

// Politeness towards the archive (a free public host); see polite.go for the rules
// and the persisted back-off state.
//   - request starts are spaced by reqLimiter;
//   - bytes are paced by byteLimiter (-max-mbps, tokens of 1e6 bytes);
//   - a 429, a 403 or any 503 stops the run by default (-on-429 stop); with
//     -on-429 pause every request of the process waits max(1 h, Retry-After), for at
//     most maxBlockedWait in total.
//
// UserAgent identifies the scanner to the archive operators.
const userAgent = "zeroed-historical-scanner/2 (research backtest; +https://github.com/macdarenz-droid/Meme-snipe)"

var (
	stopOn429  = true
	stopped    atomic.Bool
	errStopped = errors.New("stopped: archive answered 429")
)

func retryAfterOf(resp *http.Response) time.Duration {
	v := resp.Header.Get("Retry-After")
	if v == "" {
		return 0
	}
	if secs, err := strconv.Atoi(v); err == nil && secs > 0 {
		return time.Duration(secs) * time.Second
	}
	if t, err := http.ParseTime(v); err == nil {
		return time.Until(t)
	}
	return 0
}

// isBlocked: a 429, a 403 (a block, as on 4 Oct) or any 503 (with or without
// Retry-After) means "stop" (ARCHIVE-SAFE: each stops the run like a 429, never retried).
func isBlocked(resp *http.Response) bool {
	switch resp.StatusCode {
	case http.StatusTooManyRequests, http.StatusForbidden, http.StatusServiceUnavailable:
		return true
	}
	return false
}

var (
	byteLimiter    = newLimiter(80) // MB/s; one token = 1e6 bytes
	maxBlockedWait = 6 * time.Hour
	blockMu        sync.Mutex
	blockedUntil   time.Time
	blockedSince   time.Time
)

func waitUnblocked(ctx context.Context) error {
	for {
		blockMu.Lock()
		d := time.Until(blockedUntil)
		blockMu.Unlock()
		if d <= 0 {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(d):
		}
	}
}

// noteBlocked records a 429 (persisted, see polite.go) and returns false when the run
// must end: always in stop mode, and in pause mode once the total blocked time
// exceeds maxBlockedWait.
func noteBlocked(retryAfter time.Duration) bool {
	blockMu.Lock()
	defer blockMu.Unlock()
	now := time.Now()
	pause := backoffFor(retryAfter)
	record429(now, retryAfter)
	if stopOn429 {
		stopped.Store(true)
		return false
	}
	if blockedSince.IsZero() || now.Sub(blockedUntil) > 10*time.Minute {
		blockedSince = now
	}
	if until := now.Add(pause); until.After(blockedUntil) {
		blockedUntil = until
		log.Printf("archive answered 429: pausing all requests for %s", pause)
	}
	return now.Sub(blockedSince) < maxBlockedWait
}

const mbToken = 1_000_000

// byteTokens is the number of 1e6-byte tokens n bytes use.
func byteTokens(n int64) int64 { return (n + mbToken - 1) / mbToken }

func paceBytes(n int64) {
	for t := byteTokens(n); t > 0; t-- {
		byteLimiter.wait()
	}
}

// fetchRange returns bytes [off, off+n) of url, retrying on network errors and 5xx,
// and waiting out 429s.
func fetchRange(ctx context.Context, url string, off, n int64) ([]byte, error) {
	backoff := 500 * time.Millisecond
	var lastErr error
	for attempt := 0; attempt < 12; {
		if stopped.Load() {
			return nil, errStopped
		}
		if err := waitUnblocked(ctx); err != nil {
			return nil, err
		}
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
		paceBytes(n)
		statHTTPRequests.Add(1)
		req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", off, off+n-1))
		req.Header.Set("User-Agent", userAgent)
		resp, err := httpClient.Do(req)
		if err != nil {
			lastErr = err
			attempt++
			continue
		}
		ok := resp.StatusCode == http.StatusPartialContent || (resp.StatusCode == http.StatusOK && off == 0)
		if !ok {
			io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
			resp.Body.Close()
			lastErr = fmt.Errorf("status %d for %s range %d+%d", resp.StatusCode, url, off, n)
			if isBlocked(resp) {
				statHTTP429.Add(1)
				if !noteBlocked(retryAfterOf(resp)) {
					if stopOn429 {
						return nil, errStopped
					}
					return nil, fmt.Errorf("archive kept answering 429 for %s: %w", maxBlockedWait, lastErr)
				}
				continue // a 429 does not use up an attempt
			}
			if resp.StatusCode == 404 || resp.StatusCode == 416 {
				return nil, lastErr
			}
			attempt++
			continue
		}
		buf := make([]byte, n)
		_, err = io.ReadFull(resp.Body, buf)
		resp.Body.Close()
		if err != nil {
			lastErr = err
			attempt++
			continue
		}
		statBytes.Add(n)
		return buf, nil
	}
	return nil, fmt.Errorf("giving up: %w", lastErr)
}

// errNotInArchive marks a 404: the epoch (or file) is not published (yet).
var errNotInArchive = errors.New("not in archive")

// smallRequest performs a HEAD or GET, waiting out 429s like fetchRange.
func smallRequest(method, url string) ([]byte, int64, error) {
	var lastErr error
	for attempt := 0; attempt < 6; {
		if stopped.Load() {
			return nil, 0, errStopped
		}
		if err := waitUnblocked(context.Background()); err != nil {
			return nil, 0, err
		}
		reqLimiter.wait()
		req, _ := http.NewRequest(method, url, nil)
		req.Header.Set("User-Agent", userAgent)
		resp, err := httpClient.Do(req)
		if err == nil {
			b, rerr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
			resp.Body.Close()
			switch {
			case resp.StatusCode == 200 && rerr == nil:
				return b, resp.ContentLength, nil
			case resp.StatusCode == 404:
				return nil, 0, fmt.Errorf("%s %s: %w", method, url, errNotInArchive)
			case isBlocked(resp):
				statHTTP429.Add(1)
				if !noteBlocked(retryAfterOf(resp)) {
					if stopOn429 {
						return nil, 0, errStopped
					}
					return nil, 0, fmt.Errorf("archive kept answering 429 for %s", maxBlockedWait)
				}
				continue
			}
			err = fmt.Errorf("%s %s: status %d %v", method, url, resp.StatusCode, rerr)
		}
		lastErr = err
		attempt++
		time.Sleep(time.Duration(attempt) * 2 * time.Second)
	}
	return nil, 0, lastErr
}

func headSize(url string) (int64, error) {
	_, n, err := smallRequest("HEAD", url)
	if err == nil && n <= 0 {
		return 0, fmt.Errorf("HEAD %s: no content length", url)
	}
	return n, err
}

func fetchSmall(url string) ([]byte, error) {
	b, _, err := smallRequest("GET", url)
	return b, err
}

// Epoch is one epoch's CAR file in the archive.
type Epoch struct {
	N         uint64
	RootCid   string
	CarURL    string
	CarSize   int64
	headerEnd int64
	cacheDir  string
	mu        sync.Mutex
	bounds    map[uint64]boundVal
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
		return nil, fmt.Errorf("epoch %d: %w", n, err)
	}
	rootB, _ := os.ReadFile(cidPath)
	e := &Epoch{N: n, RootCid: strings.TrimSpace(string(rootB)), CarURL: fmt.Sprintf("%s/%d/epoch-%d.car", archiveBase, n, n), cacheDir: cacheDir}
	if e.CarSize, err = headSize(e.CarURL); err != nil {
		return nil, err
	}
	if e.headerEnd, err = carHeaderSize(e.CarURL); err != nil {
		return nil, err
	}
	e.loadBounds()
	return e, nil
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
