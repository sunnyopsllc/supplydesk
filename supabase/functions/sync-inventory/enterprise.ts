// Deposco "Enterprise Inventory" availability API (launch.deposco.com, Basic Auth). Unlike
// /latest/inventory, it returns TotalCoATPQty — the figure Deposco shows as Total Sellable Qty.
// Credentials are the Deposco user "Supply Chain" (function secrets, never in the repo).

const BASE = "https://launch.deposco.com/integration/LAUNCH/enterpriseinventory/";
const BATCH = 40;
const CONCURRENCY = 4;

export type CoAtpResult = {
  byItem: Map<string, number>; // exact Deposco item number (lower-case) -> TotalCoATPQty
  requested: number;
  failedBatches: number;
  error?: string;
};

export async function getTotalCoAtp(itemNumbers: string[], facilities: string, businessUnit = "Better Days"): Promise<CoAtpResult> {
  const user = Deno.env.get("DEPOSCO_ENTERPRISE_USER");
  const pass = Deno.env.get("DEPOSCO_ENTERPRISE_PASSWORD");
  const out: CoAtpResult = { byItem: new Map(), requested: itemNumbers.length, failedBatches: 0 };
  if (!user || !pass) { out.error = "Enterprise inventory credentials are not set"; out.failedBatches = -1; return out; }
  const auth = "Basic " + btoa(`${user}:${pass}`);

  const batches: string[][] = [];
  for (let i = 0; i < itemNumbers.length; i += BATCH) batches.push(itemNumbers.slice(i, i + BATCH));

  let next = 0;
  async function worker() {
    while (next < batches.length) {
      const batch = batches[next++];
      const url = BASE + encodeURIComponent(businessUnit) + "/availability?" +
        `measures=TotalCoATPQty&itemNumbers=${batch.map(encodeURIComponent).join(",")}&facilityNumbers=${facilities}`;
      try {
        const resp = await fetch(url, { headers: { Authorization: auth, Accept: "application/json" } });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        for (const e of data.enterpriseInventory ?? []) {
          const q = Number(e.totalCoAtpQty);
          if (Number.isFinite(q)) out.byItem.set(String(e.itemNumber).toLowerCase(), q);
        }
      } catch (err) {
        out.failedBatches++;
        out.error = String((err as Error)?.message ?? err);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return out;
}
