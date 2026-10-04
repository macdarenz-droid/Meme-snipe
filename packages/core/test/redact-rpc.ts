// The RPC address as fixture files record it: scheme and host only. A keyed endpoint carries its key in the query
// (`?api-key=`), the path (`/<token>/`, `/v2/<key>`) or the user part (`user:pass@`), so all three are masked and
// never written. Every fixture fetch script records its RPC through this; test/redact-rpc.test.ts holds them to it.
export const redactRpc = (url: string): string => {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return '…';
  }
  const path = u.pathname === '/' || u.pathname === '' ? '' : '/…';
  const query = [...u.searchParams.keys()].map((k) => `${k}=…`).join('&');
  return `${u.protocol}//${u.host}${query ? `${path || '/'}?${query}` : path}`;
};
