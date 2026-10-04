import sys,re
# usage: resolve.py file mode1 mode2 ...  (one mode per hunk: ours|theirs|both|theirs_ours)
f=sys.argv[1]; modes=sys.argv[2:]
s=open(f).read()
out=[];i=0;k=0
pat=re.compile(r"<<<<<<< [^\n]*\n(.*?)=======\n(.*?)>>>>>>> [^\n]*\n",re.S)
def rep(m):
    global k
    mode=modes[k] if k<len(modes) else modes[-1]; k+=1
    o,t=m.group(1),m.group(2)
    return {'ours':o,'theirs':t,'both':o+t,'theirs_ours':t+o}[mode]
s=pat.sub(rep,s)
open(f,'w').write(s)
print(f,k,'hunks')
