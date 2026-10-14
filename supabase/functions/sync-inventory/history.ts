// Pure helpers for inventory history/velocity — no I/O, so they can be tested directly.

export const DAY_MS = 24 * 60 * 60 * 1000;

export type Flow = Map<string, number>; // lower-case sku -> units

export function addTo(map: Flow, sku: string, units: number) {
  const key = sku.trim().toLowerCase();
  if (!key || !units) return;
  map.set(key, (map.get(key) ?? 0) + units);
}

// Units that must have left the building (sold, shipped, scrapped) since the last
// snapshot. Anything that arrived (PO/return receipts, finished kits) is added back to
// where stock started, and anything consumed by kitting is taken off, so replenishment
// can't hide sales and kitting doesn't look like selling. Never negative: an unexplained
// increase (cycle-count fix, etc.) just means no recorded outflow.
export function outflowUnits(prevOnHand: number, inbound: number, kittedIn: number, kittedOut: number, nowOnHand: number): number {
  const expected = prevOnHand + inbound + kittedIn - kittedOut;
  return Math.max(0, Math.round(expected - nowOnHand));
}

export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export type DailyRow = { day: string; sku: string; outflow: number };

// Units/day over the last `windowDays` calendar days (UTC buckets), dividing by the time
// actually covered by history so a brand-new tracker isn't diluted by days it didn't exist.
// null until at least a day of history exists.
export function velocityPerDay(rows: DailyRow[], now: Date, coverageStart: Date, windowDays: number): Map<string, number | null> {
  const windowStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (windowDays - 1) * DAY_MS;
  const startKey = dayKey(new Date(windowStartMs));
  const covered = (now.getTime() - Math.max(windowStartMs, coverageStart.getTime())) / DAY_MS;
  const sums = new Map<string, number>();
  for (const r of rows) {
    if (r.day < startKey) continue;
    const k = r.sku.toLowerCase();
    sums.set(k, (sums.get(k) ?? 0) + r.outflow);
  }
  const out = new Map<string, number | null>();
  for (const [k, v] of sums) out.set(k, covered >= 1 ? Math.round((v / covered) * 100) / 100 : null);
  return out;
}

export function coveredDays(now: Date, coverageStart: Date): number {
  return Math.max(0, Math.round(((now.getTime() - coverageStart.getTime()) / DAY_MS) * 10) / 10);
}
