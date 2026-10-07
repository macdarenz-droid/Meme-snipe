// The policy tools' only wall-clock read (the 14-day age rule needs today's date).
export function wallClockNowMs(): number {
  return Date.now();
}
