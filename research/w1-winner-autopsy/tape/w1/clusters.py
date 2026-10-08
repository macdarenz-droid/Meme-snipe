"""PREREG §3: funding clusters. Owners are joined (union-find, as connected components) when a W SOL transfer or a
T transfer of a pump mint made on or before the cluster day ran directly between them. An address linked to more
than 50 owners (a hub) is never used for joining, nor is an excluded address (pool, curve, program-derived,
protocol). OPEN_QUESTIONS Q5: joining only through direct owner-to-owner links is the literal reading; the variant
that also joins through non-owner intermediaries is reported by `hub_effect` for the reviewer, never used."""
import numpy as np
import pandas as pd
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

HUB_OWNERS = 50


def build(days, asof_day, hub=HUB_OWNERS, via_non_owners=False):
    """Clusters as of `asof_day` from the ledger day dicts with day <= asof_day.

    Returns (trader: pd.Series owner id -> trader id, info dict). Owners are every tracked swap owner seen on
    those days; an owner without a usable link is its own trader. Trader ids are the smallest owner id in the
    cluster, so they are stable and contain no address."""
    use = [d for d in days if d["day"] <= asof_day]
    owners = np.unique(np.concatenate([d["owners"] for d in use])) if use else np.zeros(0, np.int64)
    parts = [d["wedges"] for d in use] + [d["tedges"] for d in use]
    e = np.unique(np.concatenate(parts), axis=0) if parts and sum(len(p) for p in parts) else np.zeros((0, 2), np.int64)
    excluded = np.unique(np.concatenate([d["hub_excluded_nodes"] for d in use])) if use else np.zeros(0, np.int64)
    w_present = all(d["w_present"] for d in use)
    # undirected, deduplicated links
    if len(e):
        e = np.unique(np.sort(e, axis=1), axis=0)
    is_owner = lambda x: np.isin(x, owners)
    # hub: an address with more than `hub` distinct owner neighbours
    if len(e):
        a, b = e[:, 0], e[:, 1]
        nb = pd.DataFrame({"x": np.concatenate([a, b]), "y": np.concatenate([b, a])})
        nb = nb[is_owner(nb["y"].to_numpy())]
        deg = nb.groupby("x")["y"].nunique()
        hubs = deg[deg > hub].index.to_numpy(np.int64)
    else:
        hubs = np.zeros(0, np.int64)
    blocked = np.union1d(hubs, excluded)
    if len(e):
        keep = ~np.isin(e[:, 0], blocked) & ~np.isin(e[:, 1], blocked)
        if not via_non_owners:
            keep &= is_owner(e[:, 0]) & is_owner(e[:, 1])
        ej = e[keep]
    else:
        ej = e
    nodes = np.unique(np.concatenate([owners, ej.ravel()]))
    if len(ej):
        r = np.searchsorted(nodes, ej[:, 0])
        c = np.searchsorted(nodes, ej[:, 1])
        g = coo_matrix((np.ones(len(ej), np.int8), (r, c)), shape=(len(nodes), len(nodes)))
        _, lab = connected_components(g, directed=False)
    else:
        lab = np.arange(len(nodes))
    ol = lab[np.searchsorted(nodes, owners)] if len(owners) else np.zeros(0, np.int64)
    df = pd.DataFrame({"owner": owners, "lab": ol})
    tid = df.groupby("lab")["owner"].transform("min")
    trader = pd.Series(tid.to_numpy(np.int64), index=owners)
    sizes = df.groupby("lab").size()
    # effect of the hub threshold (§9.3): clusters had hubs been allowed to join
    info = {
        "asof": asof_day, "owners": int(len(owners)), "traders": int(trader.nunique()),
        "links": int(len(e)), "links_used": int(len(ej)), "hubs": int(len(hubs)),
        "w_present": bool(w_present),
        "limitation": None if w_present else "W absent: clusters use T only",
        "size_distribution": {str(k): int(v) for k, v in sizes.value_counts().sort_index().items()},
        "largest": int(sizes.max()) if len(sizes) else 0,
    }
    return trader, info


def hub_effect(days, asof_day, thresholds=(20, 50, 100, 10**9)):
    """§9.3: traders and the largest cluster at other hub thresholds (10**9 = no hub rule)."""
    out = {}
    for h in thresholds:
        t, i = build(days, asof_day, hub=h)
        out[str(h)] = {"traders": i["traders"], "largest": i["largest"], "hubs": i["hubs"]}
    t, i = build(days, asof_day, via_non_owners=True)
    out["50, joining through non-owners (not used)"] = {"traders": i["traders"], "largest": i["largest"],
                                                         "hubs": i["hubs"]}
    return out


def assign(owner_ids, trader):
    """Owner ids -> trader ids; an owner the clusters never saw is its own trader."""
    o = pd.Series(np.asarray(owner_ids, np.int64))
    return o.map(trader).fillna(o).astype(np.int64).to_numpy()
