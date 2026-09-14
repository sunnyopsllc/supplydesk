// Supabase Edge Function: create-work-order
//
// Creates a real work order in Deposco (production) for a given SKU/qty/due
// date. Called only after a logged-in user has reviewed and confirmed the
// details in Supply Desk's Create Work Order dialog — this function never
// fires on its own.
//
// Deposco requires a client-assigned `number` (confirmed by testing against
// UA — Deposco does NOT auto-generate one). This generates one prefixed
// "SD-" so anyone looking at Deposco's own screens can tell at a glance
// which work orders came from Supply Desk.

import { createClient } from "jsr:@supabase/supabase-js@2";

function generateWorkOrderNumber(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `SD-${stamp}`;
}

async function getDeposcoAccessToken(): Promise<string> {
  const clientId = Deno.env.get("DEPOSCO_CLIENT_ID")!;
  const clientSecret = Deno.env.get("DEPOSCO_CLIENT_SECRET")!;
  const refreshToken = Deno.env.get("DEPOSCO_REFRESH_TOKEN")!;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const resp = await fetch("https://auth.deposco.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!resp.ok) {
    throw new Error(`Deposco token request failed: ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json();
  return data.access_token as string;
}

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ ok: false, error: "Method not allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Require a real logged-in Supply Desk user — this creates a real work
    // order in production Deposco, so no service-role/cron bypass here.
    const authHeader = req.headers.get("Authorization") ?? "";
    const callerToken = authHeader.replace(/^Bearer\s+/i, "");
    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userError } = await callerClient.auth.getUser(callerToken);
    if (userError || !userData?.user) {
      return new Response(JSON.stringify({ ok: false, error: "Not authenticated" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { sku, qty, dueDate } = await req.json();
    if (!sku || typeof sku !== "string") {
      return new Response(JSON.stringify({ ok: false, error: "Missing sku" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const quantity = Number(qty);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return new Response(JSON.stringify({ ok: false, error: "Qty must be a positive number" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (!dueDate || typeof dueDate !== "string") {
      return new Response(JSON.stringify({ ok: false, error: "Missing dueDate" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const number = generateWorkOrderNumber();
    const kitName = `${sku} - V3`;

    const accessToken = await getDeposcoAccessToken();
    const payload = {
      number,
      status: "Open",
      quantity,
      dueDate,
      businessUnit: { businessKey: { code: "Better Days" } },
      kitHeader: { businessKey: { name: kitName } },
    };

    const createResp = await fetch("https://api.deposco.com/latest/workOrders", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!createResp.ok) {
      const errText = await createResp.text();
      return new Response(
        JSON.stringify({ ok: false, error: `Deposco rejected the request: ${errText}` }),
        { status: 502, headers: { "Content-Type": "application/json" } },
      );
    }

    // Reflect it immediately in Supply Desk — same shape the sync function
    // writes, so it shows the "Open WO #…" pill right away rather than
    // waiting up to 6 hours for the next scheduled sync.
    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const { data: row, error: readError } = await supabase
      .from("app_state")
      .select("data")
      .eq("id", 1)
      .single();
    if (!readError && row?.data) {
      const state = row.data;
      const item = (state.items ?? []).find(
        (i: any) => (i.sku ?? "").trim().toLowerCase() === sku.trim().toLowerCase(),
      );
      if (item) {
        item.openWorkOrder = { number, qty: quantity, dueDate };
        await supabase
          .from("app_state")
          .update({ data: state, updated_at: new Date().toISOString() })
          .eq("id", 1);
      }
    }

    return new Response(
      JSON.stringify({ ok: true, number, qty: quantity, dueDate }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error(err);
    return new Response(
      JSON.stringify({ ok: false, error: String(err?.message ?? err) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
