// Copy diagnostics (UI-T05, StateView error): only the VM ID, field path, HTTP status, seq, error code and message,
// each a bounded string or number. Nothing else from the request or response is read, so cookies, tokens and other
// headers can never be copied.

export interface DiagnosticInput {
  vm: string;
  field_path?: string | null;
  http_status?: number | null;
  seq?: string | null;
  code?: string | null;
  message?: string | null;
}

const clip = (s: string): string => (s.length > 200 ? `${s.slice(0, 199)}…` : s);

/** The diagnostics text to copy: a JSON object with exactly the allowed fields that are present. */
export function diagnosticsText(d: DiagnosticInput): string {
  const out: Record<string, string | number> = { vm: clip(d.vm) };
  if (typeof d.field_path === 'string') out['field_path'] = clip(d.field_path);
  if (typeof d.http_status === 'number' && Number.isInteger(d.http_status)) out['http_status'] = d.http_status;
  if (typeof d.seq === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(d.seq)) out['seq'] = d.seq;
  if (typeof d.code === 'string') out['code'] = clip(d.code);
  if (typeof d.message === 'string') out['message'] = clip(d.message);
  return JSON.stringify(out, null, 2);
}
