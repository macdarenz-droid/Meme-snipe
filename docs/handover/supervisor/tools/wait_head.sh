#!/bin/bash
# usage: wait_head.sh <pr> <branch> <old_sha> ; waits for head to change, then checks, base containment
PR=$1; BR=$2; OLD=$3; cd /home/user/Meme-snipe
until [ "$(git ls-remote origin refs/heads/$BR | cut -f1)" != "$OLD" ]; do sleep 5; done
bash /tmp/claude-0/-home-user-Meme-snipe/bfe97b8d-9361-5e1a-a5d2-7a95e7d0e23b/scratchpad/wait_pr.sh $PR
git fetch -q origin $BR ccr-14987baf-i6lrsl; git rev-parse origin/$BR
git merge-base --is-ancestor origin/ccr-14987baf-i6lrsl origin/$BR && echo "contains base $(git rev-parse --short origin/ccr-14987baf-i6lrsl)" || echo "BASE MOVED"
