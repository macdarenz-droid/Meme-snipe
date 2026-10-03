@AGENTS.md

# Owner additions for this repo

Copied from `macdarenz-droid/M-arc` CLAUDE.md (which imports AGENTS.md). Every addition or change the owner makes for this repo goes here, dated. Where this file and AGENTS.md differ, this file wins.

## Working
- Decide, don't ask (owner, 2026-10-03). Decide as owner or supervisor from what is true: the code, the docs, research, or clear reasoning. Never guess; if something cannot be verified, say so and pick the safest option.
- Ping the owner only for output no agent can produce, even with a workaround (a payment, a login, a secret, a real-device check, a legal or account action). Everything else is decided and recorded in the repo.
- If the owner is busy or silent, keep working. Do not stop or slow down while waiting; work on everything that does not need the answer. Speed never lowers accuracy.
- Parallel work runs outside the supervisor's chat (owner, 2026-10-03): one visible session per task, which the supervisor starts and monitors. No hidden parallel agents inside the supervisor's chat.
- Every report to the owner (owner, 2026-10-03) gives the approximate run time of each task (elapsed and remaining) and the totals, with the uncertainty stated plainly.
- Model range (owner, 2026-10-03): high-complexity tasks on `claude-opus-5-5` with ultracode; lower-complexity tasks on `claude-sonnet-5-5` at medium effort. Never Fable or any lower tier.

## Product
- Zeroed trades only when the data proves the setup (owner, 2026-10-03): consistent, risk aware, data aware, built on research into what matters in the market. Missing, stale or unproven evidence means no trade.
- No AI wording in the UI (owner, 2026-10-03). Every word in the app reads as written by a person. Never mention AI, models, assistants or "smart"/"intelligent" features, and never use stock AI phrasing such as "at a glance", "seamless", "effortless", "unlock", "elevate", "empower", "leverage", "delve", "dive in", "robust", "cutting-edge", "harness", "supercharge", "streamline", "insights", "journey", "game-changer", "powered by", "Let's", "Here's", or decorative sparkles. Use short, specific labels a trader would write ("Today", "Open trade", "Daily loss"). A guard test in the web app fails the build on any flagged word; add to its list, never remove from it.
- Two themes only (owner, 2026-10-03): Paper and Silent Black (see `docs/ARCHITECTURE.md`).
- Name and logo (owner, 2026-10-03): Zeroed, "Slot" mark (see `docs/BRAND.md`).
- Funding (owner, 2026-10-03): Deposit and Withdraw offer two exchanges to choose from, Independent Reserve and Kraken; the bot only sends to the owner's saved wallet.
