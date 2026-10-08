package main

// The loopback tee (research/SHARED_TAPE_PLAN.md, "How one read serves both"). The
// unchanged rpcscan points -helius-url at it and holds only a placeholder key; the tee
// holds the real key (HELIUS_API_KEY), forwards each request and returns the upstream
// status, headers and body unchanged (429 and Retry-After included). It enforces P4:
//   - a request pace for this process (-rps, never above 25 a second);
//   - an upstream Retry-After pauses every forward until it passes;
//   - 3 consecutive 429 or 403 answers stop it, resumably;
//   - a credit cap (-max-credits, forwarded attempts) and a free-disk floor stop it,
//     resumably.
// Once stopped it forwards nothing more: each request gets a local 429 with
// Retry-After 3600, which ends rpcscan's call at once (its back-off budget is 15
// minutes) with exit 75. Local answers are counted apart and cost no credit.
// It never logs or writes the upstream URL, the key or a query string. Every usable
// getBlock answer is spooled decompressed (zstd) as SPOOL/<slot>.json.zst, the format
// rpcscan's -dir reads, and listed in SPOOL/MANIFEST.tsv with its sha256 and size.

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	teeMaxRPS       = 25      // P4: half the Developer plan's 50 a second, for all users of the key
	teeStopAfter    = 3       // consecutive 429 or 403 answers
	teeMinFreeBytes = 8 << 30 // the plan's disk floor (8 GiB)
	teeLocalRetry   = 3600    // seconds; above rpcscan's 15-minute back-off budget
)

type methodCount struct {
	Attempts     int64            `json:"attempts"`      // forwarded upstream (each may cost a credit)
	Usable       int64            `json:"usable"`        // rpcscan's "requests": HTTP 200 and not an RPC rate-limit error
	HTTP         map[string]int64 `json:"http"`          // status -> count ("err" for no answer)
	RPC429       int64            `json:"rpc_429"`       // HTTP 200 with an RPC rate-limit error
	BytesWire    int64            `json:"bytes_wire"`    // as received (compressed when gzip)
	BytesDecoded int64            `json:"bytes_decoded"` // usable answers, decompressed (rpcscan's response_bytes)
	Skipped      int64            `json:"skipped"`       // getBlock: usable answers that are skipped-slot errors
	Spooled      int64            `json:"spooled"`       // getBlock: blocks written to the spool
}

type teeLedger struct {
	Started      string                  `json:"started"`
	Updated      string                  `json:"updated"`
	MaxCredits   int64                   `json:"max_credits"`
	RPS          float64                 `json:"rps"`
	RPS2         float64                 `json:"rps2,omitempty"`
	SwitchAfter  int64                   `json:"switch_after,omitempty"`
	Methods      map[string]*methodCount `json:"methods"`
	Attempts     int64                   `json:"attempts"`
	Usable       int64                   `json:"usable"`
	BytesWire    int64                   `json:"bytes_wire"`
	BytesDecoded int64                   `json:"bytes_decoded"`
	HTTP429      int64                   `json:"http_429"`
	HTTP403      int64                   `json:"http_403"`
	LocalRefused int64                   `json:"local_refused"` // answered by the tee itself once stopped
	PausedSec    float64                 `json:"paused_seconds"`
	Stopped      string                  `json:"stopped,omitempty"`
	RateLog      []rateMark              `json:"rate_log"` // forwards and 429s per rate phase
}

type rateMark struct {
	RPS      float64 `json:"rps"`
	From     string  `json:"from"`
	Attempts int64   `json:"attempts"`
	Usable   int64   `json:"usable"`
	HTTP429  int64   `json:"http_429"`
	Seconds  float64 `json:"seconds"`
}

type tee struct {
	upstream string // holds the key: never logged, never written
	key      string
	client   *http.Client
	spool    string
	ledgerP  string
	stopP    string
	freeFn   func(string) (uint64, error)

	mu         sync.Mutex
	l          teeLedger
	consec     int
	nextAt     time.Time
	pauseUntil time.Time
	interval   time.Duration
	phaseStart time.Time
	manifest   *os.File
	spoolWG    sync.WaitGroup
	spoolErr   error
}

func newTee(upstream, key string, rps, rps2 float64, switchAfter, maxCredits int64, spool, ledger, stop string) (*tee, error) {
	if key == "" {
		return nil, errors.New("refused: HELIUS_API_KEY is not set")
	}
	if rps <= 0 || rps > teeMaxRPS || rps2 < 0 || rps2 > teeMaxRPS {
		return nil, fmt.Errorf("refused: -rps and -rps2 must be in (0, %d]", teeMaxRPS)
	}
	if maxCredits <= 0 {
		return nil, errors.New("refused: -max-credits must be above 0")
	}
	if spool == "" || ledger == "" || stop == "" {
		return nil, errors.New("refused: -spool, -ledger and -stop-file are required")
	}
	if err := os.MkdirAll(spool, 0o755); err != nil {
		return nil, err
	}
	mf, err := os.OpenFile(filepath.Join(spool, "MANIFEST.tsv"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, err
	}
	sep := "?"
	if strings.Contains(upstream, "?") {
		sep = "&"
	}
	now := time.Now()
	t := &tee{upstream: upstream + sep + "api-key=" + key, key: key,
		client: &http.Client{Timeout: 130 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		spool:  spool, ledgerP: ledger, stopP: stop, freeFn: freeBytes, manifest: mf,
		interval: time.Duration(float64(time.Second) / rps), phaseStart: now}
	t.l = teeLedger{Started: now.UTC().Format(time.RFC3339), MaxCredits: maxCredits, RPS: rps, RPS2: rps2, SwitchAfter: switchAfter,
		Methods: map[string]*methodCount{}, RateLog: []rateMark{{RPS: rps, From: now.UTC().Format(time.RFC3339)}}}
	return t, nil
}

func freeBytes(dir string) (uint64, error) {
	var s syscall.Statfs_t
	if err := syscall.Statfs(dir, &s); err != nil {
		return 0, err
	}
	return s.Bavail * uint64(s.Bsize), nil
}

// scrub removes the key and the upstream URL from text that might reach a log.
func (t *tee) scrub(s string) string {
	s = strings.ReplaceAll(s, t.upstream, "<upstream>")
	if t.key != "" {
		s = strings.ReplaceAll(s, t.key, "***")
	}
	return s
}

// stopLocked records why the tee stopped (the first reason wins) and writes the stop file.
func (t *tee) stopLocked(why string) {
	if t.l.Stopped != "" {
		return
	}
	t.l.Stopped = why
	log.Printf("tee: stopped: %s", why)
	_ = os.WriteFile(t.stopP, []byte(why+"\n"), 0o644)
}

// admit decides whether a request may go upstream and waits for its turn. It returns
// false when the tee is stopped (or stops now).
func (t *tee) admit(ctx context.Context) bool {
	t.mu.Lock()
	if t.l.Stopped == "" {
		if t.l.Attempts >= t.l.MaxCredits {
			t.stopLocked(fmt.Sprintf("credit cap %d reached", t.l.MaxCredits))
		} else if free, err := t.freeFn(t.spool); err != nil || free < teeMinFreeBytes {
			t.stopLocked(fmt.Sprintf("free disk below %d bytes (%d, %v)", uint64(teeMinFreeBytes), free, err))
		}
	}
	if t.l.Stopped != "" {
		t.l.LocalRefused++
		t.mu.Unlock()
		return false
	}
	// Pace: one slot per interval, after any Retry-After pause.
	now := time.Now()
	at := t.nextAt
	if at.Before(now) {
		at = now
	}
	if at.Before(t.pauseUntil) {
		t.l.PausedSec += t.pauseUntil.Sub(at).Seconds()
		at = t.pauseUntil
	}
	t.nextAt = at.Add(t.interval)
	t.l.Attempts++ // reserved before it is sent: a cut-off attempt still counts
	t.l.RateLog[len(t.l.RateLog)-1].Attempts++
	if t.l.RPS2 > 0 && t.l.SwitchAfter > 0 && t.l.Attempts == t.l.SwitchAfter {
		t.closePhaseLocked(now)
		t.interval = time.Duration(float64(time.Second) / t.l.RPS2)
		t.l.RateLog = append(t.l.RateLog, rateMark{RPS: t.l.RPS2, From: now.UTC().Format(time.RFC3339)})
	}
	t.mu.Unlock()
	if d := time.Until(at); d > 0 {
		select {
		case <-time.After(d):
		case <-ctx.Done():
		}
	}
	return true
}

func (t *tee) closePhaseLocked(now time.Time) {
	t.l.RateLog[len(t.l.RateLog)-1].Seconds = now.Sub(t.phaseStart).Seconds()
	t.phaseStart = now
}

type rpcReq struct {
	Method string            `json:"method"`
	Params []json.RawMessage `json:"params"`
	ID     json.RawMessage   `json:"id"`
}

func (t *tee) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		http.Error(w, "request body", http.StatusBadRequest)
		return
	}
	var req rpcReq
	if json.Unmarshal(body, &req) != nil || req.Method == "" {
		http.Error(w, "not a single JSON-RPC request", http.StatusBadRequest)
		return
	}
	method := req.Method
	if !t.admit(r.Context()) {
		t.mu.Lock()
		why := t.l.Stopped
		t.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Retry-After", strconv.Itoa(teeLocalRetry))
		w.WriteHeader(http.StatusTooManyRequests)
		id := req.ID
		if len(id) == 0 {
			id = json.RawMessage("null")
		}
		fmt.Fprintf(w, `{"jsonrpc":"2.0","error":{"code":-32429,"message":%q},"id":%s}`, "local tee stopped: "+why, id)
		return
	}
	up, err := http.NewRequestWithContext(r.Context(), http.MethodPost, t.upstream, bytes.NewReader(body))
	if err != nil {
		t.count(method, "err", nil, nil, 0)
		http.Error(w, "building the upstream request failed", http.StatusBadGateway)
		return
	}
	up.Header.Set("Content-Type", "application/json")
	if ae := r.Header.Get("Accept-Encoding"); ae != "" {
		up.Header.Set("Accept-Encoding", ae) // set explicitly: the body comes back as sent
	}
	resp, err := t.client.Do(up)
	if err != nil {
		var ue interface{ Unwrap() error }
		if errors.As(err, &ue) && ue.Unwrap() != nil {
			err = ue.Unwrap() // drop *url.Error's URL
		}
		log.Printf("tee: %s: upstream error: %s", method, t.scrub(err.Error()))
		t.count(method, "err", nil, nil, 0)
		http.Error(w, "upstream request failed", http.StatusBadGateway)
		return
	}
	wire, err := io.ReadAll(io.LimitReader(resp.Body, 600<<20))
	resp.Body.Close()
	if err != nil {
		log.Printf("tee: %s: reading the upstream body: %s", method, t.scrub(err.Error()))
		t.count(method, "err", nil, nil, 0)
		http.Error(w, "upstream body cut off", http.StatusBadGateway)
		return
	}
	// The answer goes back unchanged: status, headers (no hop-by-hop ones) and body.
	for k, vs := range resp.Header {
		switch http.CanonicalHeaderKey(k) {
		case "Connection", "Keep-Alive", "Transfer-Encoding", "Te", "Trailer", "Upgrade", "Proxy-Connection", "Content-Length":
			continue
		}
		for _, v := range vs {
			w.Header().Add(k, t.scrub(v))
		}
	}
	w.Header().Set("Content-Length", strconv.Itoa(len(wire)))
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(wire)

	var decoded []byte
	switch strings.ToLower(resp.Header.Get("Content-Encoding")) {
	case "", "identity":
		decoded = wire
	case "gzip":
		if zr, err := gzip.NewReader(bytes.NewReader(wire)); err == nil {
			decoded, err = io.ReadAll(zr)
			if err != nil {
				decoded = nil
			}
		}
	}
	ra := 0
	if v := resp.Header.Get("Retry-After"); v != "" {
		ra, _ = strconv.Atoi(v)
	}
	t.count(method, strconv.Itoa(resp.StatusCode), wire, decoded, ra)
	if method == "getBlock" && resp.StatusCode == http.StatusOK && decoded != nil && len(req.Params) > 0 {
		var slot uint64
		if json.Unmarshal(req.Params[0], &slot) == nil {
			t.spoolBlock(slot, decoded)
		}
	}
}

// rpcErrCode returns the JSON-RPC error code of a body, if it has one.
func rpcErrCode(b []byte) (int, bool) {
	var x struct {
		Error *struct {
			Code int `json:"code"`
		} `json:"error"`
	}
	if json.Unmarshal(b, &x) != nil || x.Error == nil {
		return 0, false
	}
	return x.Error.Code, true
}

// count books one forwarded attempt. rpcscan's rule: a usable answer is HTTP 200 whose
// body is not an RPC rate-limit error (-32429 or 429); its decompressed size is
// response_bytes. A 429 (HTTP or in the body) or a 403 extends the failure streak;
// any other answer ends it.
func (t *tee) count(method, status string, wire, decoded []byte, retryAfter int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	m := t.l.Methods[method]
	if m == nil {
		m = &methodCount{HTTP: map[string]int64{}}
		t.l.Methods[method] = m
	}
	m.Attempts++
	m.HTTP[status]++
	m.BytesWire += int64(len(wire))
	t.l.BytesWire += int64(len(wire))
	limited := status == "429" || status == "403"
	if status == "200" {
		code, isErr := rpcErrCode(decoded)
		if decoded == nil {
			// Not decodable here; rpcscan cannot read it either.
		} else if isErr && (code == -32429 || code == 429) {
			m.RPC429++
			limited = true
		} else {
			m.Usable++
			m.BytesDecoded += int64(len(decoded))
			t.l.Usable++
			t.l.BytesDecoded += int64(len(decoded))
			t.l.RateLog[len(t.l.RateLog)-1].Usable++
			if method == "getBlock" && isErr && (code == -32007 || code == -32009) {
				m.Skipped++
			}
		}
	}
	switch status {
	case "429":
		t.l.HTTP429++
		t.l.RateLog[len(t.l.RateLog)-1].HTTP429++
	case "403":
		t.l.HTTP403++
	}
	if limited {
		t.consec++
		wait := time.Duration(retryAfter) * time.Second
		if wait < time.Second {
			wait = time.Second
		}
		if until := time.Now().Add(wait); until.After(t.pauseUntil) {
			t.pauseUntil = until
		}
		if t.consec >= teeStopAfter {
			t.stopLocked(fmt.Sprintf("%d consecutive 429 or 403 answers", t.consec))
		}
	} else {
		t.consec = 0
	}
}

// spoolBlock writes a usable getBlock answer that holds a block (not an error) to the
// spool, compressed, and lists it in the manifest.
func (t *tee) spoolBlock(slot uint64, decoded []byte) {
	if _, isErr := rpcErrCode(decoded); isErr {
		return
	}
	sum := sha256.Sum256(decoded)
	enc := zstdEnc.EncodeAll(decoded, nil)
	p := filepath.Join(t.spool, fmt.Sprintf("%d.json.zst", slot))
	tmp := p + ".tmp"
	err := os.WriteFile(tmp, enc, 0o644)
	if err == nil {
		err = os.Rename(tmp, p)
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if err != nil {
		if t.spoolErr == nil {
			t.spoolErr = err
		}
		t.stopLocked("spool write failed: " + err.Error())
		return
	}
	t.l.Methods["getBlock"].Spooled++
	fmt.Fprintf(t.manifest, "%d\t%s\t%d\n", slot, hex.EncodeToString(sum[:]), len(decoded))
}

func (t *tee) writeLedger() error {
	t.mu.Lock()
	t.l.Updated = time.Now().UTC().Format(time.RFC3339)
	last := &t.l.RateLog[len(t.l.RateLog)-1]
	last.Seconds = time.Since(t.phaseStart).Seconds()
	b, err := json.MarshalIndent(&t.l, "", "  ")
	t.mu.Unlock()
	if err != nil {
		return err
	}
	tmp := t.ledgerP + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, t.ledgerP)
}

func runTee(args []string) int {
	fs := flag.NewFlagSet("tee", flag.ExitOnError)
	listen := fs.String("listen", "127.0.0.1:0", "loopback address to serve on")
	upstream := fs.String("upstream", "https://mainnet.helius-rpc.com/", "Helius RPC endpoint (the key is added from HELIUS_API_KEY)")
	rps := fs.Float64("rps", 10, "forwarded requests a second (at most 25)")
	rps2 := fs.Float64("rps2", 0, "second rate, from attempt -switch-after on (0: none)")
	switchAfter := fs.Int64("switch-after", 0, "attempt at which -rps2 starts")
	maxCredits := fs.Int64("max-credits", 0, "hard stop: attempts forwarded (required)")
	spool := fs.String("spool", "", "spool directory for getBlock answers")
	ledger := fs.String("ledger", "", "ledger file (JSON), rewritten every 5 s and at exit")
	stop := fs.String("stop-file", "", "written with the reason when the tee stops")
	addrFile := fs.String("addr-file", "", "the address served, written once listening")
	fs.Parse(args)
	host, _, err := net.SplitHostPort(*listen)
	if err != nil || (host != "127.0.0.1" && host != "::1" && host != "localhost") {
		log.Print("refused: -listen must be a loopback address")
		return 2
	}
	t, err := newTee(*upstream, os.Getenv("HELIUS_API_KEY"), *rps, *rps2, *switchAfter, *maxCredits, *spool, *ledger, *stop)
	if err != nil {
		log.Print(err)
		return 2
	}
	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		log.Print(err)
		return 1
	}
	srv := &http.Server{Handler: t, ReadHeaderTimeout: 30 * time.Second}
	if *addrFile != "" {
		if err := os.WriteFile(*addrFile, []byte(ln.Addr().String()+"\n"), 0o644); err != nil {
			log.Print(err)
			return 1
		}
	}
	log.Printf("tee: serving on %s, %.0f/s, cap %d", ln.Addr(), *rps, *maxCredits)
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	go func() {
		tk := time.NewTicker(5 * time.Second)
		defer tk.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tk.C:
				if err := t.writeLedger(); err != nil {
					log.Printf("tee: ledger: %v", err)
				}
			}
		}
	}()
	go func() { _ = srv.Serve(ln) }()
	<-ctx.Done()
	sctx, c2 := context.WithTimeout(context.Background(), 150*time.Second)
	defer c2()
	_ = srv.Shutdown(sctx)
	t.manifest.Close()
	if err := t.writeLedger(); err != nil {
		log.Printf("tee: ledger: %v", err)
		return 1
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	ms := make([]string, 0, len(t.l.Methods))
	for k := range t.l.Methods {
		ms = append(ms, k)
	}
	sort.Strings(ms)
	for _, k := range ms {
		m := t.l.Methods[k]
		log.Printf("tee: %s attempts=%d usable=%d bytes=%d", k, m.Attempts, m.Usable, m.BytesDecoded)
	}
	log.Printf("tee: done: attempts=%d usable=%d http429=%d http403=%d localRefused=%d stopped=%q", t.l.Attempts, t.l.Usable, t.l.HTTP429, t.l.HTTP403, t.l.LocalRefused, t.l.Stopped)
	return 0
}
