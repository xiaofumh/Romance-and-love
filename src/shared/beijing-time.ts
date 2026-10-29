export function beijingClock(unixMs: number) {
  if (!Number.isFinite(unixMs) || Math.abs(unixMs) > 8e15) throw new Error('INVALID_CLOCK');
  const iso = new Date(unixMs + 8 * 3600000).toISOString();
  return { timeZone: 'Asia/Shanghai' as const, utcOffset: '+08:00' as const, unixMs,
    date: iso.slice(0, 10), dateTime: iso.slice(0, 19).replace('T', ' ') };
}
export type BeijingClock = ReturnType<typeof beijingClock>;
