package main

// Helius JSON-RPC client (DATA-2): getBlocks and getBlock for RPCUnit.
//
//   - The API key comes only from HELIUS_API_KEY. It is never logged: every error is
//     built without the request URL and scrubbed of the key.
//   - A hard credit stop: each HTTP attempt reserves one credit (getBlock and getBlocks
//     cost 1 credit each, Helius docs 2026-10-04) before it is sent; past -max-credits
//     nothing more is sent and the run stops resumably (errCreditCap, exit 75).
//   - Requests are paced to -rps across all fetchers.
//   - 429 and 5xx: wait Retry-After, else 1 s doubling to 64 s with jitter, never less
//     than 1 s; past -max-backoff of waiting in one call the run stops resumably
//     (errBackoffBudget). There is no tight retry loop.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var (
	errCreditCap     = errors.New("credit cap reached")
	errBackoffBudget = errors.New("rate-limit back-off budget used up")
)

type heliusConfig struct {
	url          *string
	rps          *float64
	conc         int
	maxCredits   *int64
	maxTxVersion *int
	maxBackoff   *time.Duration
}

func heliusFlags(fs *flag.FlagSet) *heliusConfig {
	c := &heliusConfig{
		url:          fs.String("helius-url", "https://mainnet.helius-rpc.com/", "Helius RPC endpoint (the key is added from HELIUS_API_KEY)"),
		rps:          fs.Float64("rps", 8, "requests per second, all fetchers together (free plan: 10)"),
		maxCredits:   fs.Int64("max-credits", 0, "hard stop: credits this process may spend (required, above 0)"),
		maxTxVersion: fs.Int("max-tx-version", 1, "maxSupportedTransactionVersion (v1 transactions exist since SIMD-0385)"),
		maxBackoff:   fs.Duration("max-backoff", 15*time.Minute, "longest total rate-limit wait in one request before stopping resumably"),
	}
	fs.IntVar(&c.conc, "conc", 4, "blocks fetched at once")
	return c
}

func (c *heliusConfig) client() (*heliusClient, error) {
	key := os.Getenv("HELIUS_API_KEY")
	if key == "" {
		return nil, errors.New("refused: HELIUS_API_KEY is not set")
	}
	if *c.maxCredits <= 0 {
		return nil, errors.New("refused: -max-credits must be above 0")
	}
	if *c.rps <= 0 || *c.rps > 500 || c.conc < 1 {
		return nil, errors.New("refused: -rps must be in (0, 500] and -conc at least 1")
	}
	sep := "?"
	if strings.Contains(*c.url, "?") {
		sep = "&"
	}
	return &heliusClient{
		endpoint:   *c.url + sep + "api-key=" + key,
		key:        key,
		http:       &http.Client{Timeout: 120 * time.Second},
		interval:   time.Duration(float64(time.Second) / *c.rps),
		maxCredits: *c.maxCredits,
		maxTxVer:   *c.maxTxVersion,
		maxBackoff: *c.maxBackoff,
	}, nil
}

type heliusClient struct {
	endpoint   string // holds the key: never logged, never in an error
	key        string
	http       *http.Client
	interval   time.Duration
	maxCredits int64
	maxTxVer   int
	maxBackoff time.Duration

	paceMu sync.Mutex
	nextAt time.Time

	Credits   atomic.Int64 // HTTP attempts sent (each reserved one credit)
	Requests  atomic.Int64 // calls that returned a usable answer
	Retries   atomic.Int64
	Status429 atomic.Int64
	Bytes     atomic.Int64 // response bytes after decompression
	LatencyNs atomic.Int64 // summed over usable answers
	WaitedNs  atomic.Int64 // rate-limit and error back-off
	maxBody   int64
}

// scrub removes the key from any text that might reach a log.
func (h *heliusClient) scrub(s string) string {
	if h.key == "" {
		return s
	}
	return strings.ReplaceAll(s, h.key, "***")
}

func (h *heliusClient) pace(ctx context.Context) error {
	h.paceMu.Lock()
	now := time.Now()
	if h.nextAt.Before(now) {
		h.nextAt = now
	}
	at := h.nextAt
	h.nextAt = h.nextAt.Add(h.interval)
	h.paceMu.Unlock()
	return sleepCtx(ctx, time.Until(at))
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// call sends one JSON-RPC request and returns its result (or the RPC error, typed by
// rpcResult).
func (h *heliusClient) call(ctx context.Context, method string, params any) ([]byte, error) {
	body, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	if err != nil {
		return nil, err
	}
	var waited time.Duration
	backoff := time.Second
	for attempt := 0; ; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if h.Credits.Add(1) > h.maxCredits {
			h.Credits.Add(-1)
			return nil, fmt.Errorf("%s: %w (%d)", method, errCreditCap, h.maxCredits)
		}
		if err := h.pace(ctx); err != nil {
			return nil, err
		}
		t0 := time.Now()
		resp, retryAfter, status, err := h.post(ctx, body)
		if err == nil && status == http.StatusOK {
			res, rerr := rpcResult(resp)
			var re *rpcError
			if errors.As(rerr, &re) && (re.Code == -32429 || re.Code == 429) {
				status = http.StatusTooManyRequests // rate limit reported in the body
			} else {
				h.Requests.Add(1)
				h.Bytes.Add(int64(len(resp)))
				h.LatencyNs.Add(int64(time.Since(t0)))
				return res, rerr
			}
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		retryable := err != nil || status == http.StatusTooManyRequests || status >= 500
		if !retryable {
			return nil, fmt.Errorf("%s: HTTP %d: %s", method, status, h.scrub(snippet(resp)))
		}
		if status == http.StatusTooManyRequests {
			h.Status429.Add(1)
		}
		wait := backoff
		if retryAfter > 0 {
			wait = retryAfter
		} else {
			wait += time.Duration(rand.Int63n(int64(wait) / 5)) // jitter up to 20%
			if backoff < 64*time.Second {
				backoff *= 2
			}
		}
		if wait < time.Second {
			wait = time.Second
		}
		if waited+wait > h.maxBackoff {
			why := fmt.Sprintf("HTTP %d", status)
			if err != nil {
				why = err.Error()
			}
			return nil, fmt.Errorf("%s: %w after %s (last: %s)", method, errBackoffBudget, waited.Round(time.Second), why)
		}
		h.Retries.Add(1)
		waited += wait
		h.WaitedNs.Add(int64(wait))
		if err := sleepCtx(ctx, wait); err != nil {
			return nil, err
		}
	}
}

// post sends body and returns the response body, any Retry-After and the status. Its
// errors never carry the URL.
func (h *heliusClient) post(ctx context.Context, body []byte) ([]byte, time.Duration, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, 0, 0, errors.New("building the request failed")
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := h.http.Do(req)
	if err != nil {
		var ue interface{ Unwrap() error }
		if errors.As(err, &ue) && ue.Unwrap() != nil {
			err = ue.Unwrap() // drop *url.Error's URL
		}
		return nil, 0, 0, errors.New(h.scrub(err.Error()))
	}
	defer resp.Body.Close()
	limit := h.maxBody
	if limit == 0 {
		limit = 512 << 20
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, 0, resp.StatusCode, errors.New(h.scrub(err.Error()))
	}
	if int64(len(b)) > limit {
		return nil, 0, resp.StatusCode, fmt.Errorf("response larger than %d bytes", limit)
	}
	var ra time.Duration
	if v := resp.Header.Get("Retry-After"); v != "" {
		if s, err := strconv.Atoi(v); err == nil && s > 0 {
			ra = time.Duration(s) * time.Second
		}
	}
	return b, ra, resp.StatusCode, nil
}

func snippet(b []byte) string {
	if len(b) > 200 {
		b = b[:200]
	}
	return string(b)
}

func (h *heliusClient) producedSlots(ctx context.Context, from, to uint64) ([]uint64, error) {
	res, err := h.call(ctx, "getBlocks", []any{from, to, map[string]any{"commitment": "finalized"}})
	if err != nil {
		return nil, err
	}
	var out []uint64
	if err := json.Unmarshal(res, &out); err != nil {
		return nil, fmt.Errorf("getBlocks result: %w", err)
	}
	return out, nil
}

func (h *heliusClient) block(ctx context.Context, slot uint64) ([]byte, error) {
	return h.call(ctx, "getBlock", []any{slot, map[string]any{
		"encoding": "base64", "transactionDetails": "full", "rewards": false,
		"maxSupportedTransactionVersion": h.maxTxVer, "commitment": "finalized"}})
}

// usage is the client's counters, for logs and the pilot report.
type heliusUsage struct {
	Credits       int64   `json:"credits"`
	Requests      int64   `json:"requests"`
	Retries       int64   `json:"retries"`
	Status429     int64   `json:"http_429"`
	ResponseBytes int64   `json:"response_bytes"`
	MeanLatencyMs float64 `json:"mean_latency_ms"`
	WaitedSeconds float64 `json:"waited_seconds"`
	// Final: written at a clean exit. The ledger books a non-final file's whole
	// reservation (a run killed mid-unit may have spent more than it last wrote).
	Final bool `json:"final"`
}

func (h *heliusClient) usage() heliusUsage {
	u := heliusUsage{Credits: h.Credits.Load(), Requests: h.Requests.Load(), Retries: h.Retries.Load(),
		Status429: h.Status429.Load(), ResponseBytes: h.Bytes.Load(), WaitedSeconds: float64(h.WaitedNs.Load()) / 1e9}
	if u.Requests > 0 {
		u.MeanLatencyMs = float64(h.LatencyNs.Load()) / float64(u.Requests) / 1e6
	}
	return u
}

func (h *heliusClient) logUsage() {
	u := h.usage()
	log.Printf("helius: credits=%d requests=%d retries=%d http429=%d bytes=%d meanLatency=%.0fms waited=%.0fs",
		u.Credits, u.Requests, u.Retries, u.Status429, u.ResponseBytes, u.MeanLatencyMs, u.WaitedSeconds)
}
