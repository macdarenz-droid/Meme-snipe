#!/usr/bin/bash
# Sourced by publish-day.sh and archive-guard.sh (OF-5 rulings 1 and 3): one judgement of
# a day release in the private store. Needs GH (the gh command or a function, holding the
# store token) and DATA_REPO.
# release_state TAG DAY: "done", "complete", "absent", or "incomplete: <why>", judged
# only from the release itself (never from local files, whose QA reports change on every
# rerun): not a draft, every asset uploaded, and the asset names equal the expected set,
# with the part count taken from the release's own SHA256SUMS-DAY. "done" (OF-5 ruling
# 1): that set plus the readback-ok-DAY marker, whose content names the tag and the
# sha256 of the stored SHA256SUMS-DAY (marker_text); "complete": the set without it (the
# read-back never passed).
marker_text() { printf 'readback-ok %s %s\n' "$1" "$(sha256sum "$2" | cut -d' ' -f1)"; }
release_state() {
  local tag=$1 day=$2 info tmp want have mk=""
  local err
  err=$(mktemp)
  if ! info=$("$GH" release view "$tag" --repo "$DATA_REPO" --json isDraft,assets \
    --jq '"draft \(.isDraft)", (.assets[] | "asset \(.name) \(.state)")' 2>"$err"); then
    # Only a missing release is "absent"; any other gh error (auth, network, rate
    # limit) is an error, never a reason to publish.
    if grep -qi "release not found" "$err"; then echo absent; else echo "error: $(tr '\n' ' ' < "$err")"; fi
    rm -f "$err"
    return
  fi
  rm -f "$err"
  grep -qx "draft false" <<<"$info" || { echo "incomplete: draft release"; return; }
  if grep '^asset ' <<<"$info" | grep -vq ' uploaded$'; then echo "incomplete: an asset is not fully uploaded"; return; fi
  tmp=$(mktemp -d)
  "$GH" release download "$tag" --repo "$DATA_REPO" --pattern "SHA256SUMS-$day" --dir "$tmp" >/dev/null 2>&1 ||
    { rm -rf "$tmp"; echo "incomplete: no SHA256SUMS-$day"; return; }
  want=$( { awk '{print $2}' "$tmp/SHA256SUMS-$day" | grep -E "^(units-$day\.tar\.part[0-9]+|rescan-$day\.sha256|list-$day\.txt|pm01-subset-$day\.txt|margin-$day\.tar)\$" || true
            printf '%s\n' "events-$day.tar" "qa-$day.md" "qa-$day.json" "manifest-$day.json" "parity-$day.json" "units-$day.log" "SHA256SUMS-$day"; } | sort)
  have=$(grep '^asset ' <<<"$info" | awk '{print $2}' | sort)
  if grep -qx "readback-ok-$day" <<<"$have"; then
    mk=$(marker_text "$tag" "$tmp/SHA256SUMS-$day")
    "$GH" release download "$tag" --repo "$DATA_REPO" --pattern "readback-ok-$day" --dir "$tmp" >/dev/null 2>&1 &&
      [ "$(cat "$tmp/readback-ok-$day" 2>/dev/null)" = "${mk%$'\n'}" ] ||
      { rm -rf "$tmp"; echo "incomplete: its readback-ok-$day marker cannot be read or does not match its SHA256SUMS-$day"; return; }
    have=$(grep -vx "readback-ok-$day" <<<"$have")
  fi
  rm -rf "$tmp"
  grep -q "^units-$day\.tar\.part" <<<"$want" || { echo "incomplete: SHA256SUMS-$day lists no tar part"; return; }
  [ "$have" = "$want" ] || { echo "incomplete: assets differ from the expected set"; return; }
  if [ -n "$mk" ]; then echo done; else echo complete; fi
}
