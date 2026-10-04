package main
import ("os";"testing";"github.com/klauspost/compress/zstd")
func TestUnz(t *testing.T){ for _,n:=range []string{"old","new"}{ b,_:=os.ReadFile("/tmp/claude-0/"+n+".zst"); d,_:=zstd.NewReader(nil); o,err:=d.DecodeAll(b,nil); if err!=nil{t.Fatal(err)}; os.WriteFile("/tmp/claude-0/"+n+".json",o,0644)}}
