// Publishes a backtest report as the `latest-report.json` asset of the `backtest` release (UI-2 loads it from there).
// A failed publish never loses the published report (BT-WALL c, the DATA-4 B1 pattern): the new report is uploaded
// under another name first, then swapped in by renames, and the old one is deleted only once the new one is in place.
//   1. upload `latest-report.next.json` (a left-over one from a failed publish is deleted first);
//   2. rename `latest-report.json` to `latest-report.previous.json`;
//   3. rename `latest-report.next.json` to `latest-report.json`; on failure the previous report is renamed back;
//   4. delete `latest-report.previous.json`.
// Between steps 2 and 3 (two renames) the name is briefly absent; the old report is never deleted before the new one
// holds the name. Every failed step throws and says which report the release now holds.

export const LATEST = 'latest-report.json';
export const NEXT = 'latest-report.next.json';
export const PREVIOUS = 'latest-report.previous.json';

/** The GitHub REST call: a path under the repository (`/releases/...`) or a full URL. */
export type Api = (path: string, init?: RequestInit) => Promise<Response>;

interface Release {
  readonly id: number;
  readonly upload_url: string;
  readonly assets: readonly { readonly id: number; readonly name: string }[];
}

const must = async (res: Response, what: string): Promise<Response> => {
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res;
};

export const publishReport = async (api: Api, body: string): Promise<void> => {
  let res = await api('/releases/tags/backtest');
  if (res.status === 404) {
    res = await api('/releases', {
      method: 'POST',
      body: JSON.stringify({ tag_name: 'backtest', name: 'Backtest report', body: 'Latest backtest report (research runs only; the holdout stays sealed).', prerelease: true }),
    });
  }
  const release = (await (await must(res, 'release')).json()) as Release;
  const named = (name: string) => release.assets.find((a) => a.name === name);
  const rename = (id: number, name: string) => api(`/releases/assets/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
  const remove = (id: number) => api(`/releases/assets/${id}`, { method: 'DELETE' });
  // Left-overs of a failed publish: the published report still holds the name, so both are safe to delete.
  const old = named(LATEST);
  const leftPrevious = named(PREVIOUS);
  if (leftPrevious !== undefined) {
    if (old === undefined) {
      // A publish failed between its two renames: the previous report goes back under the name first.
      await must(await rename(leftPrevious.id, LATEST), `restoring the left-over ${PREVIOUS}`);
      return publishReport(api, body);
    }
    await must(await remove(leftPrevious.id), `deleting the left-over ${PREVIOUS} (${LATEST} is unchanged)`);
  }
  const leftNext = named(NEXT);
  if (leftNext !== undefined) await must(await remove(leftNext.id), `deleting the left-over ${NEXT} (${LATEST} is unchanged)`);
  const upload = release.upload_url.replace(/\{.*\}$/, '');
  const up = await must(await api(`${upload}?name=${NEXT}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body }), `uploading ${NEXT} (${LATEST} is unchanged)`);
  const next = (await up.json()) as { readonly id: number };
  if (old !== undefined) await must(await rename(old.id, PREVIOUS), `moving the old report aside (${LATEST} is unchanged; ${NEXT} holds the new one)`);
  const swapped = await rename(next.id, LATEST);
  if (!swapped.ok) {
    const back = old === undefined ? null : await rename(old.id, LATEST);
    const holds = old === undefined ? 'no report yet' : back!.ok ? 'the old report' : `no report (${PREVIOUS} holds the old one; the next publish restores it)`;
    await must(swapped, `renaming ${NEXT} to ${LATEST} (${LATEST} holds ${holds})`);
  }
  if (old !== undefined) await must(await remove(old.id), `deleting ${PREVIOUS} (${LATEST} holds the new report)`);
};
