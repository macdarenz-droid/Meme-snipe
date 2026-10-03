package main

import (
	"crypto/sha256"
	"encoding/binary"
	"hash/crc64"
	"math"
	"testing"

	"github.com/gagliardetto/solana-go"
	"github.com/mr-tron/base58"
)

func le64(v uint64) []byte { b := make([]byte, 8); binary.LittleEndian.PutUint64(b, v); return b }

// tradeEventPrefix builds the first fields of a pump TradeEvent body.
func tradeEventPrefix(mint [32]byte, sol, tok uint64, buy bool) []byte {
	var b []byte
	b = append(b, mint[:]...)
	b = append(b, le64(sol)...)
	b = append(b, le64(tok)...)
	if buy {
		b = append(b, 1)
	} else {
		b = append(b, 0)
	}
	return b
}

func TestDecodeOlderLayoutIsPrefix(t *testing.T) {
	disc := []byte{189, 219, 127, 211, 78, 230, 97, 238}
	mint := mustPK("BTjq2nwmjLYf9zyNy2MoGqF2Dp4pkHWdEEvSy3Gzpump")
	body := tradeEventPrefix(mint, 18719778, 669126494074, true)
	ev, ok := decodeEvent("pump", disc, body)
	if ev == nil || !ok {
		t.Fatalf("decode failed")
	}
	if ev.def.name != "TradeEvent" || ev.n != 4 {
		t.Fatalf("got %s with %d fields", ev.def.name, ev.n)
	}
	if ev.get("mint") != "BTjq2nwmjLYf9zyNy2MoGqF2Dp4pkHWdEEvSy3Gzpump" || ev.get("sol_amount") != "18719778" || ev.get("token_amount") != "669126494074" || ev.get("is_buy") != "1" {
		t.Fatalf("bad values %v", ev.values[:4])
	}
	if ev.get("user") != "" {
		t.Fatalf("absent field should be empty")
	}
}

func TestDecodeCutFieldIsMalformed(t *testing.T) {
	disc := []byte{189, 219, 127, 211, 78, 230, 97, 238}
	mint := mustPK("BTjq2nwmjLYf9zyNy2MoGqF2Dp4pkHWdEEvSy3Gzpump")
	body := tradeEventPrefix(mint, 1, 2, false)
	body = append(body, 1, 2, 3) // 3 bytes of a 32-byte pubkey
	if _, ok := decodeEvent("pump", disc, body); ok {
		t.Fatalf("a field cut in the middle must not decode")
	}
}

func TestDecodeUnknownDiscriminator(t *testing.T) {
	if ev, _ := decodeEvent("pump", []byte{1, 2, 3, 4, 5, 6, 7, 8}, nil); ev != nil {
		t.Fatalf("unknown discriminator decoded")
	}
}

func TestDecodeSignedI128(t *testing.T) {
	b := make([]byte, 16)
	for i := range b {
		b[i] = 0xff
	}
	if s := int128String(b, true); s != "-1" {
		t.Fatalf("got %s", s)
	}
	if s := int128String(b, false); s != "340282366920938463463374607431768211455" {
		t.Fatalf("got %s", s)
	}
}

func TestEveryIDLEventLoaded(t *testing.T) {
	want := map[string]bool{"pump:TradeEvent": false, "pump:CreateEvent": false, "pump:CompletePumpAmmMigrationEvent": false,
		"amm:BuyEvent": false, "amm:SellEvent": false, "amm:CreatePoolEvent": false, "amm:DepositEvent": false,
		"amm:WithdrawEvent": false, "amm:BoostBuyAndBurnEvent": false}
	for _, d := range eventDefs {
		want[d.program+":"+d.name] = true
	}
	for k, v := range want {
		if !v {
			t.Errorf("missing %s", k)
		}
	}
	if len(eventDefs) < 50 {
		t.Errorf("only %d events loaded", len(eventDefs))
	}
}

func TestMintHashFraction(t *testing.T) {
	m := "BTjq2nwmjLYf9zyNy2MoGqF2Dp4pkHWdEEvSy3Gzpump"
	raw, _ := base58.Decode(m)
	h := sha256.Sum256(raw)
	want := float64(binary.BigEndian.Uint64(h[:8])) / math.Pow(2, 64)
	got, ok := mintHashFraction(m)
	if !ok || got != want || got < 0 || got >= 1 {
		t.Fatalf("got %v want %v", got, want)
	}
	if inSample(m) != (want < sampleRate) {
		t.Fatalf("inSample disagrees with the hash")
	}
	if _, ok := mintHashFraction("not-a-key"); ok {
		t.Fatalf("invalid mint accepted")
	}
}

func TestMayLoadAccounts(t *testing.T) {
	payer := solana.NewWallet().PublicKey()
	prog := solana.MustPublicKeyFromBase58("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA")
	ix := solana.NewInstruction(prog, solana.AccountMetaSlice{solana.Meta(payer).WRITE().SIGNER()}, []byte{1, 2, 3})
	legacy, err := solana.NewTransaction([]solana.Instruction{ix}, solana.Hash{}, solana.TransactionPayer(payer))
	if err != nil {
		t.Fatal(err)
	}
	lb, _ := legacy.MarshalBinary()
	if mayLoadAccounts(lb) {
		t.Fatalf("legacy transaction cannot load accounts")
	}
	other := solana.NewWallet().PublicKey()
	table := solana.NewWallet().PublicKey()
	ix2 := solana.NewInstruction(prog, solana.AccountMetaSlice{solana.Meta(payer).WRITE().SIGNER(), solana.Meta(other)}, []byte{9})
	v0, err := solana.NewTransaction([]solana.Instruction{ix2}, solana.Hash{}, solana.TransactionPayer(payer),
		solana.TransactionAddressTables(map[solana.PublicKey]solana.PublicKeySlice{table: {other}}))
	if err != nil {
		t.Fatal(err)
	}
	vb, _ := v0.MarshalBinary()
	if !messageIsVersioned(vb) || !mayLoadAccounts(vb) {
		t.Fatalf("v0 transaction with a lookup table must be checked")
	}
	v0n, err := solana.NewTransaction([]solana.Instruction{ix}, solana.Hash{}, solana.TransactionPayer(payer),
		solana.TransactionAddressTables(map[solana.PublicKey]solana.PublicKeySlice{}))
	if err != nil {
		t.Fatal(err)
	}
	vnb, _ := v0n.MarshalBinary()
	if messageIsVersioned(vnb) && mayLoadAccounts(vnb) {
		t.Fatalf("v0 transaction without lookups cannot load accounts")
	}
}

func TestTxNode(t *testing.T) {
	// [0, [6, null, null, null, h'0102', null], [6, null, null, null, h'03', null], 7, 2]
	raw := []byte{0x85, 0x00,
		0x86, 0x06, 0xf6, 0xf6, 0xf6, 0x42, 0x01, 0x02, 0xf6,
		0x86, 0x06, 0xf6, 0xf6, 0xf6, 0x41, 0x03, 0xf6,
		0x07, 0x02}
	noFrames := func(string) (*frame, error) { return nil, errCBOR }
	d, m, idx, err := txNode(raw, noFrames)
	if err != nil || string(d) != "\x01\x02" || string(m) != "\x03" || idx != 2 {
		t.Fatalf("got %v %v %v %v", d, m, idx, err)
	}
}

func TestMultiFrameIsReassembledAndHashChecked(t *testing.T) {
	// first frame: index 0, total 2, data "ab", next [link to second]; second: index 1, data "cd"
	payload := []byte("abcd")
	h := crc64.Checksum(payload, crcTable)
	hb := make([]byte, 8)
	binary.BigEndian.PutUint64(hb, h)
	link := []byte{0x00, 0x01, 0x71, 0x12, 0x20}
	link = append(link, make([]byte, 32)...)
	first := []byte{0x86, 0x06, 0x1b}
	first = append(first, hb...)
	first = append(first, 0x00, 0x02, 0x42, 'a', 'b', 0x81, 0xd8, 0x2a, 0x58, byte(len(link)))
	first = append(first, link...)
	second := []byte{0x86, 0x06, 0xf6, 0x01, 0xf6, 0x42, 'c', 'd', 0xf6}
	f, err := parseFrameNode(first)
	if err != nil {
		t.Fatal(err)
	}
	get := func(c string) (*frame, error) {
		if c != string(link[1:]) {
			t.Fatalf("asked for unexpected cid")
		}
		return parseFrameNode(second)
	}
	out, err := loadFrames(f, get)
	if err != nil || string(out) != "abcd" {
		t.Fatalf("got %q %v", out, err)
	}
	f.hash ^= 1
	if _, err := loadFrames(f, get); err == nil {
		t.Fatalf("hash mismatch not detected")
	}
}

func TestBlockNode(t *testing.T) {
	// [2, 100, [], [], [99, 1790000000, null], null]
	raw := []byte{0x86, 0x02, 0x18, 0x64, 0x80, 0x80, 0x83, 0x18, 0x63, 0x1a, 0x6a, 0xb1, 0x3b, 0x80, 0xf6, 0xf6}
	s, p, bt, err := blockNode(raw)
	if err != nil || s != 100 || p != 99 || bt != 1790000000 {
		t.Fatalf("got %d %d %d %v", s, p, bt, err)
	}
}

func TestEmitRowAggregatesAllKeepsSample(t *testing.T) {
	r := &blockResult{blockTime: 7200 + 5, agg: map[aggKey]*aggVal{}}
	in, out := "", ""
	for i := 0; i < 2000 && (in == "" || out == ""); i++ {
		m := solana.NewWallet().PublicKey().String()
		if inSample(m) {
			in = m
		} else {
			out = m
		}
	}
	row := func(mint string) []string {
		r := make([]string, len(curveCols))
		r[0], r[1], r[2], r[3] = "100", "7205", "1", "0"
		r[8], r[9], r[10], r[11] = mint, "1", "1000", "5000"
		r[14], r[15] = "30000001000", "1072999995000"
		return r
	}
	r.emitRow("curve", row(in))
	r.emitRow("curve", row(out))
	if len(r.curve) != 1 || r.curve[0][8] != in {
		t.Fatalf("kept %d rows", len(r.curve))
	}
	if len(r.agg) != 2 {
		t.Fatalf("census must count every mint, got %d", len(r.agg))
	}
	a := r.agg[aggKey{7200, "curve", out, ""}]
	if a == nil || a.nBuy != 1 || a.quoteBuy != 1000 || a.baseBuy != 5000 {
		t.Fatalf("bad aggregate %+v", a)
	}
}

func TestCensusQuoteCurveUsesQuoteReserves(t *testing.T) {
	r := &blockResult{blockTime: 3600, agg: map[aggKey]*aggVal{}}
	mint := solana.NewWallet().PublicKey().String()
	quoteMint := solana.NewWallet().PublicKey().String()
	row := make([]string, len(curveCols))
	r0 := func(vq, tokRes string) []string {
		x := append([]string(nil), row...)
		x[0], x[1], x[2], x[3], x[8], x[9], x[10], x[11] = "100", "3600", "1", "0", mint, "1", "0", "5000"
		x[14], x[15] = "0", tokRes
		x[curveQuoteMintCol], x[curveQuoteAmountCol], x[curveVirtualQuoteCol] = quoteMint, "700", vq
		return x
	}
	r.emitRow("curve", r0("2000", "1000"))
	r.emitRow("curve", r0("3000", "1000"))
	a := r.agg[aggKey{3600, "curve", mint, ""}]
	if a == nil || a.lowPx != 2 || a.highPx != 3 || a.quoteBuy != 1400 || a.closeQuote != "3000" {
		t.Fatalf("quote curve census wrong: %+v", a)
	}
	dst := map[aggKey]*aggVal{aggKey{3600, "curve", mint, ""}: {lowPx: 0, highPx: 0}}
	mergeAgg(dst, r.agg)
	if dst[aggKey{3600, "curve", mint, ""}].lowPx != 2 {
		t.Fatalf("mergeAgg kept a zero low price")
	}
}
