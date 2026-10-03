package main

// Decoding of pump.fun (bonding curve) and PumpSwap (pump_amm) Anchor events, driven
// by the programs' published IDLs (idl/pump.json and idl/pump_amm.json, copied from
// github.com/pump-fun/pump-public-docs at commit cb188ce, 2026-09-29).
//
// Fields are appended to events over time, so an event emitted by an older program
// version is a prefix of the current layout: decoding stops cleanly at the end of the
// data and the missing trailing fields stay empty. Bytes left after the last known
// field mean a newer layout than our IDL; they are counted, never silently dropped.

import (
	"bytes"
	_ "embed"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"strings"

	"github.com/mr-tron/base58"
)

var (
	pumpProgram = mustPK("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")
	ammProgram  = mustPK("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA")
	voteProgram = mustPK("Vote111111111111111111111111111111111111111")
	// sha256("anchor:event")[:8], the tag of Anchor's emit_cpi self-invocation.
	eventIxTag = []byte{0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d}
)

//go:embed idl/pump.json
var pumpIDL []byte

//go:embed idl/pump_amm.json
var ammIDL []byte

func mustPK(s string) [32]byte {
	b, err := base58.Decode(s)
	if err != nil || len(b) != 32 {
		panic("bad pubkey " + s)
	}
	var k [32]byte
	copy(k[:], b)
	return k
}

type idlField struct {
	Name string          `json:"name"`
	Type json.RawMessage `json:"type"`
}

type idlTypeDef struct {
	Name string `json:"name"`
	Type struct {
		Kind      string          `json:"kind"`
		RawFields json.RawMessage `json:"fields"`
		Fields    []idlField      `json:"-"`
		Variants  []struct {
			Name string `json:"name"`
		} `json:"variants"`
	} `json:"type"`
}

type idlDoc struct {
	Events []struct {
		Name          string `json:"name"`
		Discriminator []byte `json:"discriminator"`
	} `json:"events"`
	Types []idlTypeDef `json:"types"`
}

// typ is a parsed IDL type.
type typ struct {
	prim    string // pubkey, u8, u16, u32, u64, i64, u128, i128, bool, string
	vec     *typ
	arr     *typ
	arrN    int
	opt     *typ
	defined *idlTypeDef
	types   map[string]*idlTypeDef
}

type eventDef struct {
	program string // "pump" or "amm"
	name    string
	fields  []idlField
	types   []*typ
	index   map[string]int
}

var eventDefs = map[string]*eventDef{} // program + discriminator

func init() {
	for _, x := range []struct {
		prog string
		raw  []byte
	}{{"pump", pumpIDL}, {"amm", ammIDL}} {
		var d idlDoc
		if err := json.Unmarshal(x.raw, &d); err != nil {
			panic(err)
		}
		types := map[string]*idlTypeDef{}
		for i := range d.Types {
			// Named-field structs only; tuple structs (fields given as bare types) are
			// not used by any event.
			json.Unmarshal(d.Types[i].Type.RawFields, &d.Types[i].Type.Fields)
			types[d.Types[i].Name] = &d.Types[i]
		}
		for _, e := range d.Events {
			td := types[e.Name]
			if td == nil {
				panic("no type for event " + e.Name)
			}
			ed := &eventDef{program: x.prog, name: e.Name, fields: td.Type.Fields, index: map[string]int{}}
			for i, fl := range td.Type.Fields {
				t, err := parseType(fl.Type, types)
				if err != nil {
					panic(fmt.Sprintf("%s.%s: %v", e.Name, fl.Name, err))
				}
				ed.types = append(ed.types, t)
				ed.index[fl.Name] = i
			}
			eventDefs[x.prog+string(e.Discriminator)] = ed
		}
	}
}

func parseType(raw json.RawMessage, types map[string]*idlTypeDef) (*typ, error) {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		switch s {
		case "pubkey", "u8", "u16", "u32", "u64", "i64", "u128", "i128", "bool", "string", "i32", "i16", "i8":
			return &typ{prim: s}, nil
		}
		return nil, fmt.Errorf("unsupported type %q", s)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, err
	}
	if v, ok := m["vec"]; ok {
		inner, err := parseType(v, types)
		return &typ{vec: inner}, err
	}
	if v, ok := m["option"]; ok {
		inner, err := parseType(v, types)
		return &typ{opt: inner}, err
	}
	if v, ok := m["array"]; ok {
		var pair []json.RawMessage
		if err := json.Unmarshal(v, &pair); err != nil || len(pair) != 2 {
			return nil, fmt.Errorf("bad array")
		}
		inner, err := parseType(pair[0], types)
		if err != nil {
			return nil, err
		}
		var n int
		if err := json.Unmarshal(pair[1], &n); err != nil {
			return nil, err
		}
		return &typ{arr: inner, arrN: n}, nil
	}
	if v, ok := m["defined"]; ok {
		var dn struct {
			Name string `json:"name"`
		}
		if err := json.Unmarshal(v, &dn); err != nil {
			return nil, err
		}
		td := types[dn.Name]
		if td == nil {
			return nil, fmt.Errorf("unknown defined type %s", dn.Name)
		}
		return &typ{defined: td, types: types}, nil
	}
	return nil, fmt.Errorf("unsupported type %s", string(raw))
}

var errShort = errors.New("short")

// decodeValue decodes one value of type t at body[*p:], rendering it as a string:
// integers in decimal, pubkeys in base58, composite values as compact JSON.
func decodeValue(t *typ, body []byte, p *int) (string, error) {
	need := func(n int) error {
		if *p+n > len(body) {
			return errShort
		}
		return nil
	}
	switch {
	case t.prim != "":
		switch t.prim {
		case "pubkey":
			if err := need(32); err != nil {
				return "", err
			}
			v := base58.Encode(body[*p : *p+32])
			*p += 32
			return v, nil
		case "u8", "i8":
			if err := need(1); err != nil {
				return "", err
			}
			v := uint64(body[*p])
			*p++
			if t.prim == "i8" {
				return strconv.FormatInt(int64(int8(v)), 10), nil
			}
			return strconv.FormatUint(v, 10), nil
		case "u16", "i16":
			if err := need(2); err != nil {
				return "", err
			}
			v := binary.LittleEndian.Uint16(body[*p:])
			*p += 2
			if t.prim == "i16" {
				return strconv.FormatInt(int64(int16(v)), 10), nil
			}
			return strconv.FormatUint(uint64(v), 10), nil
		case "u32", "i32":
			if err := need(4); err != nil {
				return "", err
			}
			v := binary.LittleEndian.Uint32(body[*p:])
			*p += 4
			if t.prim == "i32" {
				return strconv.FormatInt(int64(int32(v)), 10), nil
			}
			return strconv.FormatUint(uint64(v), 10), nil
		case "u64":
			if err := need(8); err != nil {
				return "", err
			}
			v := binary.LittleEndian.Uint64(body[*p:])
			*p += 8
			return strconv.FormatUint(v, 10), nil
		case "i64":
			if err := need(8); err != nil {
				return "", err
			}
			v := int64(binary.LittleEndian.Uint64(body[*p:]))
			*p += 8
			return strconv.FormatInt(v, 10), nil
		case "u128", "i128":
			if err := need(16); err != nil {
				return "", err
			}
			v := int128String(body[*p:*p+16], t.prim == "i128")
			*p += 16
			return v, nil
		case "bool":
			if err := need(1); err != nil {
				return "", err
			}
			v := "0"
			if body[*p] != 0 {
				v = "1"
			}
			*p++
			return v, nil
		case "string":
			if err := need(4); err != nil {
				return "", err
			}
			n := int(binary.LittleEndian.Uint32(body[*p:]))
			*p += 4
			if err := need(n); err != nil {
				return "", err
			}
			v := string(body[*p : *p+n])
			*p += n
			return v, nil
		}
	case t.vec != nil || t.arr != nil:
		n, inner := t.arrN, t.arr
		if t.vec != nil {
			if err := need(4); err != nil {
				return "", err
			}
			n = int(binary.LittleEndian.Uint32(body[*p:]))
			*p += 4
			inner = t.vec
			if n > len(body) {
				return "", errShort
			}
		}
		parts := make([]string, 0, n)
		for i := 0; i < n; i++ {
			v, err := decodeValue(inner, body, p)
			if err != nil {
				return "", err
			}
			parts = append(parts, jsonScalar(inner, v))
		}
		return "[" + strings.Join(parts, ",") + "]", nil
	case t.opt != nil:
		if err := need(1); err != nil {
			return "", err
		}
		tag := body[*p]
		*p++
		if tag == 0 {
			return "", nil
		}
		return decodeValue(t.opt, body, p)
	case t.defined != nil:
		td := t.defined
		if td.Type.Kind == "enum" {
			if err := need(1); err != nil {
				return "", err
			}
			i := int(body[*p])
			*p++
			if i < len(td.Type.Variants) {
				return td.Type.Variants[i].Name, nil
			}
			return strconv.Itoa(i), nil
		}
		parts := make([]string, 0, len(td.Type.Fields))
		for _, fl := range td.Type.Fields {
			ft, err := parseType(fl.Type, t.types)
			if err != nil {
				return "", err
			}
			v, err := decodeValue(ft, body, p)
			if err != nil {
				return "", err
			}
			parts = append(parts, strconv.Quote(fl.Name)+":"+jsonScalar(ft, v))
		}
		return "{" + strings.Join(parts, ",") + "}", nil
	}
	return "", fmt.Errorf("unsupported type")
}

func jsonScalar(t *typ, v string) string {
	if t.vec != nil || t.arr != nil || (t.defined != nil && t.defined.Type.Kind != "enum") {
		return v
	}
	return strconv.Quote(v)
}

// decodedEvent holds field values as strings ("" = absent in this event version).
type decodedEvent struct {
	def    *eventDef
	values []string
	extra  int // bytes after the last known field (newer layout than our IDL)
	n      int // fields carried by this event version
	tail   []byte
}

func (d *decodedEvent) get(name string) string {
	if i, ok := d.def.index[name]; ok {
		return d.values[i]
	}
	return ""
}

// decodeEvent decodes body (after the 8-byte discriminator). It returns nil if the
// discriminator is unknown, and ok=false if a field is cut in the middle.
func decodeEvent(program string, disc, body []byte) (*decodedEvent, bool) {
	d, found := eventDefs[program+string(disc)]
	if !found {
		return nil, false
	}
	ev := &decodedEvent{def: d, values: make([]string, len(d.fields))}
	p := 0
	for i, t := range d.types {
		if p == len(body) {
			return ev, true // older, shorter layout
		}
		v, err := decodeValue(t, body, &p)
		if err != nil {
			return ev, false
		}
		ev.values[i] = v
		ev.n = i + 1
	}
	ev.extra = len(body) - p
	if ev.extra > 0 {
		ev.tail = body[p:]
	}
	return ev, true
}

func int128String(b []byte, signed bool) string {
	be := make([]byte, 16)
	for i := 0; i < 16; i++ {
		be[i] = b[15-i]
	}
	v := new(big.Int).SetBytes(be)
	if signed && be[0]&0x80 != 0 {
		v.Sub(v, new(big.Int).Lsh(big.NewInt(1), 128))
	}
	return v.String()
}

func hexs(b []byte) string { return hex.EncodeToString(b) }

var _ = bytes.Equal
