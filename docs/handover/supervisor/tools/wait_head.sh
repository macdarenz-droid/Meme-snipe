#!/bin/bash
# usage: wait_head.sh <pr> <branch> <old_sha> ; waits for head to change, then checks, base containment
PR=$1; BR=$2; OLD=$3; DIR=$(cd "$(dirname "$0")" && pwd); cd /home/user/Meme-snipe
until [ "$(git ls-remote origin refs/heads/$BR | cut -f1)" != "$OLD" ]; do sleep 5; done
bash "$DIR/wait_pr.sh" $PR
git fetch -q origin $BR ccr-14987baf-i6lrsl; git rev-parse origin/$BR
git merge-base --is-ancestor origin/ccr-14987baf-i6lrsl origin/$BR && echo "contains base $(git rev-parse --short origin/ccr-14987baf-i6lrsl)" || echo "BASE MOVED"
