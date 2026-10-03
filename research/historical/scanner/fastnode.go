package main

// Minimal reader for the archive's Transaction node (DAG-CBOR tuple
// [kind, data DataFrame, metadata DataFrame, slot, index]), avoiding the reflection
// based decoder for the common case where data and metadata each fit in one frame.
// Anything unexpected returns ok=false and the caller uses the faithful decoder.

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
	if c == 0xf6 { // null
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
		if r.p+int(arg) > len(r.b) || int(arg) < 0 {
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

// frame reads a DataFrame and returns its bytes if it is a single complete frame.
func (r *cborR) frame() ([]byte, bool) {
	major, n, _, ok := r.head()
	if !ok || major != 4 || n < 5 {
		return nil, false
	}
	if m, kind, _, ok := r.head(); !ok || m != 0 || kind != 6 {
		return nil, false
	}
	if !r.skip() || !r.skip() { // hash, index
		return nil, false
	}
	major, total, null, ok := r.head()
	if !ok {
		return nil, false
	}
	if !null && (major != 0 || total > 1) {
		return nil, false // multi-frame: use the full decoder
	}
	major, l, _, ok := r.head()
	if !ok || major != 2 || r.p+int(l) > len(r.b) {
		return nil, false
	}
	data := r.b[r.p : r.p+int(l)]
	r.p += int(l)
	for i := uint64(5); i < n; i++ { // next, and anything newer
		if !r.skip() {
			return nil, false
		}
	}
	return data, true
}

func fastTxNode(raw []byte) (data, meta []byte, index int, ok bool) {
	r := &cborR{b: raw}
	major, n, _, ok := r.head()
	if !ok || major != 4 || n < 4 {
		return nil, nil, 0, false
	}
	if m, kind, _, ok := r.head(); !ok || m != 0 || kind != 0 {
		return nil, nil, 0, false
	}
	if data, ok = r.frame(); !ok {
		return nil, nil, 0, false
	}
	if meta, ok = r.frame(); !ok {
		return nil, nil, 0, false
	}
	if !r.skip() { // slot
		return nil, nil, 0, false
	}
	index = -1
	if n >= 5 {
		major, v, null, ok := r.head()
		if !ok {
			return nil, nil, 0, false
		}
		if !null {
			if major != 0 {
				return nil, nil, 0, false
			}
			index = int(v)
		}
	}
	return data, meta, index, true
}
