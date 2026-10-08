#!/usr/bin/env python3
"""Fetches stored tape units from the owner's private dataset Mrcdrnz/zeroed-tape into a
local read-only cache, checking every file's sha256 against WORK/stored.tsv.

  fetch.py [--cache DIR] [--work DIR] [--kind research|core|records] [--day D] [--units N]
  fetch.py --list            # stored units with their schema version

Prints one cache path per unit: CACHE/<day>/<from>-<to>/<kind>/. Analysis code reads
tables from there with pandas (compression="zstd"). Schema v1 units (README "Schema
versions") lack S top_program/cu_price, F cu_price and the CF table."""
import argparse, hashlib, os, sys
from huggingface_hub import hf_hub_download

REPO = "Mrcdrnz/zeroed-tape"
V1 = {"446017500-446021999", "446278500-446282999", "446283000-446287499", "446287500-446287813"}


def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def main():
    a = argparse.ArgumentParser()
    a.add_argument("--cache", default="/home/user/tape-cache")
    a.add_argument("--work", default="/home/user/tape-work")
    a.add_argument("--kind", default="research")
    a.add_argument("--day")
    a.add_argument("--units", type=int, default=0, help="at most N units (0: all)")
    a.add_argument("--list", action="store_true")
    o = a.parse_args()
    rows = [l.rstrip("\n").split("\t") for l in open(os.path.join(o.work, "stored.tsv"))]
    units = []
    for day, unit, path, digest, size in rows:
        if (day, unit) not in units and (not o.day or day == o.day):
            units.append((day, unit))
    if o.list:
        for day, unit in units:
            print(day, unit, "v1" if unit in V1 else "v2")
        return
    if o.units:
        units = units[: o.units]
    for day, unit in units:
        for d, u, path, digest, size in rows:
            if (d, u) != (day, unit) or f"/{o.kind}/" not in path:
                continue
            local = os.path.join(o.cache, path[len("tape/"):])
            if not (os.path.exists(local) and sha(local) == digest):
                got = hf_hub_download(REPO, path, repo_type="dataset", local_dir=o.cache + ".dl")
                if sha(got) != digest:
                    sys.exit(f"sha256 mismatch: {path}")
                os.makedirs(os.path.dirname(local), exist_ok=True)
                os.replace(got, local)
        print(os.path.join(o.cache, day, unit, o.kind))


if __name__ == "__main__":
    main()
