import re,sys
for p in sys.argv[1:]:
    s=open(p).read()
    s=re.sub(r"<<<<<<< [^\n]*\n(.*?)=======\n(.*?)>>>>>>> [^\n]*\n",lambda m:m.group(1)+m.group(2),s,flags=re.S)
    open(p,'w').write(s)
