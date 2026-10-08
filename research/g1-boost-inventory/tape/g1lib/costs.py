"""Fixed costs per filled round trip, exactly as packages/backtest/src/research/edge-costs.ts `expectedFixed` charges
them (values read by fixed_costs.ts into fixed_costs.json), with the rent term set to the token account the mint
needs at the trade's slot (PREREG §4 "the worker checks the token-account size for Token-2022 mints and uses the
matching rent; a mismatch with the repo's 1,513,840 lamports is logged")."""
from . import params as P


def lamports_per_byte(slot: int) -> int:
    epoch = slot // P.SLOTS_PER_EPOCH
    for first_epoch, rate in P.RENT_LAMPORTS_PER_BYTE:
        if epoch >= first_epoch:
            return rate
    raise ValueError(slot)


def token_account_rent(token_program: str, slot: int) -> int:
    """(128 + size) × lamports_per_byte. Token-2022 (create_v2) ATAs are 170 bytes, SPL ATAs 165. An unknown token
    program is charged the larger account (OQ-6)."""
    size = P.TOKEN_ACCOUNT_BYTES["spl"] if token_program == P.SPL_TOKEN_PROGRAM else P.TOKEN_ACCOUNT_BYTES["token2022"]
    return (P.ACCOUNT_STORAGE_OVERHEAD + size) * lamports_per_byte(slot)


def expected_fixed(rent: int) -> float:
    """edge-costs.ts expectedFixed with `rent` in place of FILL_CONFIG.network.tokenAccountRent."""
    t = P.FIXED["terms"]
    f = t["failProbability"]
    exp_failed = sum(f ** k for k in range(1, int(t["maxAttempts"]) + 1))
    rent_back = t["closeSuccess"] * (1 - t["dust"])
    failed_close = (1 - t["closeSuccess"]) * (1 - t["dust"])
    return (t["entryLanded"] + t["exitFixed"] + exp_failed * t["failedExit"]
            + (1 - rent_back) * rent + failed_close * t["failedExit"])


def rent_log(token_program: str, slot: int) -> dict:
    """The rent the trade is charged and whether it differs from the repo's constant (logged, PREREG §4)."""
    r = token_account_rent(token_program, slot)
    return {"rent_lamports": r, "rent_mismatch_vs_repo": r != P.REPO_RENT_LAMPORTS}
