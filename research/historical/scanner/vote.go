package main

// isVoteTx reports whether a legacy or v0 transaction only calls the vote program
// (optionally with compute-budget instructions) and loads no accounts from lookup
// tables. Anything it cannot parse is not a vote, so it is processed in full.
func isVoteTx(tx []byte) bool {
	ns, sz := compactU16(tx)
	if sz <= 0 {
		return false
	}
	p := sz + ns*64
	if p >= len(tx) {
		return false
	}
	versioned := tx[p]&0x80 != 0
	if versioned {
		if tx[p]&0x7f != 0 { // only v0 here
			return false
		}
		p++
	}
	p += 3 // header
	nk, sz := compactU16(tx[min(p, len(tx)):])
	if sz <= 0 || nk == 0 {
		return false
	}
	p += sz
	keysAt := p
	p += nk*32 + 32 // keys, recent blockhash
	if p > len(tx) {
		return false
	}
	ni, sz := compactU16(tx[p:])
	if sz <= 0 || ni == 0 {
		return false
	}
	p += sz
	votes := 0
	for i := 0; i < ni; i++ {
		if p >= len(tx) {
			return false
		}
		pi := int(tx[p])
		p++
		if pi >= nk {
			return false
		}
		var k [32]byte
		copy(k[:], tx[keysAt+pi*32:])
		switch k {
		case voteProgram:
			votes++
		case computeBudgetProgram:
		default:
			return false
		}
		for j := 0; j < 2; j++ { // account indexes, then data
			n, sz := compactU16(tx[min(p, len(tx)):])
			if sz <= 0 {
				return false
			}
			p += sz + n
			if p > len(tx) {
				return false
			}
		}
	}
	if versioned {
		nl, sz := compactU16(tx[min(p, len(tx)):])
		if sz <= 0 || nl != 0 {
			return false
		}
	}
	return votes > 0
}

var computeBudgetProgram = mustPK("ComputeBudget111111111111111111111111111111")
