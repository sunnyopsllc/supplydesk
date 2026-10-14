import { addTo, Flow } from "./history.ts";

export async function deposcoGet(url: string, accessToken: string): Promise<any> {
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
  if (!resp.ok) throw new Error(`Deposco request failed: ${resp.status} ${url}`);
  return await resp.json();
}

// Deposco ignores date filters and returns newest first, so page until a whole page is
// older than the cutoff.
export async function pageUntilOlder(firstUrl: string, accessToken: string, dateOf: (r: any) => string | undefined, cutoff: Date, maxPages = 15): Promise<any[]> {
  const out: any[] = [];
  let url: string | null = firstUrl;
  for (let i = 0; url && i < maxPages; i++) {
    const data = await deposcoGet(url, accessToken);
    const rows = data.data ?? [];
    out.push(...rows);
    const newest = rows.reduce((m: number, r: any) => Math.max(m, Date.parse(dateOf(r) ?? "") || 0), 0);
    if (data.complete || newest < cutoff.getTime()) break;
    url = (data.links ?? []).find((l: any) => l.rel === "next")?.href ?? null;
  }
  return out;
}

export async function getInboundSince(accessToken: string, since: Date, now: Date) {
  const inbound: Flow = new Map(), kittedIn: Flow = new Map(), kittedOut: Flow = new Map();

  const receipts = await pageUntilOlder(
    "https://api.deposco.com/latest/receipts?" + new URLSearchParams({ pageSize: "100", businessUnit: "Better Days" }),
    accessToken, (r) => r.createdDate, since);
  let receiptCount = 0;
  for (const r of receipts) {
    const t = Date.parse(r.createdDate ?? "");
    if (!(t > since.getTime() && t <= now.getTime())) continue;
    const packQty = Number(r?.receivedPack?.businessKey?.quantity) || 1;
    addTo(inbound, String(r?.receivedItem?.businessKey?.number ?? ""), (Number(r.receivedPackQuantity) || 0) * packQty);
    receiptCount++;
  }

  const wos = await pageUntilOlder(
    "https://api.deposco.com/latest/workOrders?" + new URLSearchParams({ pageSize: "100", businessUnit: "Better Days", status: "Complete" }),
    accessToken, (r) => r.updatedDate, since);
  const kitCache = new Map<string, any[]>();
  let woCount = 0;
  for (const wo of wos) {
    const t = Date.parse(wo.endDate ?? wo.updatedDate ?? "");
    if (!(t > since.getTime() && t <= now.getTime())) continue;
    const built = (wo.workorderDetails ?? []).reduce((n: number, d: any) => n + (Number(d.builtQuantity) || 0), 0) || Number(wo.quantity) || 0;
    const href = wo?.kitHeader?.href;
    if (!href || !built) continue;
    if (!kitCache.has(href)) kitCache.set(href, (await deposcoGet(href, accessToken))?.kitDetails?.data ?? []);
    for (const d of kitCache.get(href)!) {
      const sku = String(d?.self?.businessKey?.["item.number"] ?? "");
      const q = Number(d.quantity) || 0;
      if (d.type === "Output") addTo(kittedIn, sku, built * q);
      else if (d.type === "Input") addTo(kittedOut, sku, built * q);
    }
    woCount++;
  }
  return { inbound, kittedIn, kittedOut, receiptCount, woCount };
}

