#!/usr/bin/env python3
"""Stores one finished tape unit in the owner's private Hugging Face dataset
(owner approval 2026-10-08: Mrcdrnz/zeroed-tape; reads, uploads and read-back checks).
The token is the owner's network secret: the proxy adds it, nothing here holds one.

  hfstore.py WORK DAY EPOCH FROM TO

Uploads tape/DAY/FROM-TO/{core,research,records}/... in one commit (fewer than 100
files), then downloads every file back and checks its sha256. Only then is the unit
listed in WORK/stored.tsv (day, unit, path, sha256, bytes); the caller deletes the local
copy after that. A path that already exists with the same sha256 counts as stored; a
different one stops (nothing is overwritten)."""
import hashlib
import os
import shutil
import sys
import tempfile

from huggingface_hub import HfApi, hf_hub_download

REPO = "Mrcdrnz/zeroed-tape"


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def main():
    work, day, ep, frm, to = sys.argv[1:6]
    unit = f"{frm}-{to}"
    src = {
        "core": os.path.join(work, "day", "units", ep, unit),
        "research": os.path.join(work, "research", "units", ep, unit),
    }
    rec = os.path.join(work, "units", frm)
    if not os.path.exists(os.path.join(rec, "ledger.json")):
        rec = work  # Phase 0 keeps its records in WORK
    recs = [f for f in ("ledger.json", "rpcscan-usage.json", "identity.txt", "decode-stats.json",
                        "getblock-manifest.tsv", "digest-compare.json") if os.path.exists(os.path.join(rec, f))]
    for k, d in src.items():
        if not os.path.exists(os.path.join(d, "stats.json")):
            sys.exit(f"unit {unit}: {k} is not finished")
    files = []  # (local path, path in the dataset)
    base = f"tape/{day}/{unit}"
    for k, d in src.items():
        for name in sorted(os.listdir(d)):
            files.append((os.path.join(d, name), f"{base}/{k}/{name}"))
    for name in recs:
        files.append((os.path.join(rec, name), f"{base}/records/{name}"))
    if len(files) >= 100:
        sys.exit(f"unit {unit}: {len(files)} files, the limit is 99 a commit")
    api = HfApi()
    existing = set(api.list_repo_files(REPO, repo_type="dataset"))
    stage = tempfile.mkdtemp(dir=work, prefix="hf.")
    try:
        todo = [(p, r) for p, r in files if r not in existing]
        if todo:
            # One commit for the unit: hard links into a staging folder (no copy).
            for p, r in todo:
                dst = os.path.join(stage, r)
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                os.link(p, dst)
            api.upload_folder(repo_id=REPO, repo_type="dataset", folder_path=stage,
                              commit_message=f"tape {day} unit {unit}")
        rows = []
        for p, r in files:
            back = tempfile.mkdtemp(dir=work, prefix="hfback.")
            try:
                got = hf_hub_download(REPO, r, repo_type="dataset", local_dir=back)
                if sha(got) != sha(p):
                    sys.exit(f"read-back mismatch: {r}")
            finally:
                shutil.rmtree(back, ignore_errors=True)
            rows.append(f"{day}\t{unit}\t{r}\t{sha(p)}\t{os.path.getsize(p)}\n")
    finally:
        shutil.rmtree(stage, ignore_errors=True)
    with open(os.path.join(work, "stored.tsv"), "a") as f:
        f.writelines(rows)
    f.close()
    with open(os.path.join(work, "stored-units.txt"), "a") as f:
        f.write(f"{day}\t{unit}\t{len(rows)}\n")
    print(f"stored and read back: {base} ({len(rows)} files)")


if __name__ == "__main__":
    main()
