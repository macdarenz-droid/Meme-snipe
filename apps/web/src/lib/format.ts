const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "$1.24", or with sign "+$1.24" / "−$1.24" (true minus sign). */
export function formatUsd(value: number, signed = false): string {
  const abs = usd.format(Math.abs(value));
  if (!signed) return value < 0 ? `−${abs}` : abs;
  if (value > 0) return `+${abs}`;
  if (value < 0) return `−${abs}`;
  return abs;
}

export function formatPercent(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatPrice(value: number): string {
  if (value === 0) return '$0';
  if (value >= 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toPrecision(3)}`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

const time = new Intl.DateTimeFormat('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false });
const dateTime = new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

export function formatTime(iso: string): string {
  return time.format(new Date(iso));
}

export function formatDateTime(iso: string): string {
  return dateTime.format(new Date(iso));
}
