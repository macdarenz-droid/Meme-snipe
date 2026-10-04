import json,base64,subprocess,struct
def rpc(method,params,url="https://api.mainnet-beta.solana.com"):
    out=subprocess.run(["curl","-sS","-m","60","-X","POST","-H","content-type: application/json",url,"-d",json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params})],capture_output=True,text=True).stdout
    return json.loads(out)
