// Deposco briefly (or sometimes for a while) reports a work order with NO status — for example while
// Launch is editing or saving it — and the "status=Open" filter then drops an order that is still
// active. Orders with a blank status that were updated recently and have no end date are treated as
// open; blank-status orders untouched for days are old closed/cancelled ones and stay out.
export const BLANK_STATUS_RECENT_MS = 3 * 24 * 60 * 60 * 1000;

export function isRecentBlankStatus(wo: { status?: string | null; endDate?: string | null; updatedDate?: string | null }, nowMs: number): boolean {
  if (wo.status) return false;
  if (wo.endDate) return false;
  const updated = Date.parse(wo.updatedDate ?? "");
  return Number.isFinite(updated) && nowMs - updated < BLANK_STATUS_RECENT_MS;
}
