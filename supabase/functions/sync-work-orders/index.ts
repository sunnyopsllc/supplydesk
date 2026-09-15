// Supabase Edge Function: sync-work-orders
//
// Pulls open work orders from Deposco, matches them to Supply Desk SKUs
// (stripping a trailing "-V3"/"v3"/" - V3" off the kit name), and writes
// item.openWorkOrder = {number, qty, dueDate} onto matching items in the
// app_state row — clearing it from any item no longer open. Mirrors the
// logic that used to be run from a local script.
//
// Deposco credentials come from function secrets (never exposed to the
// client). The Supabase service role key is injected automatically by the
// platform as SUPABASE_SERVICE_ROLE_KEY.
//
// Trigger this by calling the function URL with a valid user JWT (the
// deployed site's "Sync Work Orders" button does this), or on a schedule
// via pg_cron.

import { createClient } from "jsr:@supabase/supabase-js@2";

// Without these, the browser's CORS preflight (an OPTIONS request the
// browser sends before the real POST, since it carries an Authorization
// header) gets no response headers it accepts, so it blocks the actual
// response before the page's JS ever sees it — surfaces client-side as a
// generic "Failed to send a request to the Edge Function", even though the
// function itself runs fine (a plain server-to-server call skips CORS
// entirely, which is why this didn't show up in earlier testing).
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const V3_SUFFIX_RE = /[\s-]*v3$/i;

function skuFromKitName(name: string | undefined | null): string {
  return (name ?? "").trim().replace(V3_SUFFIX_RE, "");
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

async function getOpenWorkOrders(accessToken: string): Promise<any[]> {
  const url = "https://api.deposco.com/latest/workOrders?" + new URLSearchParams({
    status: "Open",
    businessUnit: "Better Days",
  });
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!resp.ok) {
    throw new Error(`Deposco workOrders request failed: ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json();
  return data.data ?? [];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Require the caller to be a real logged-in Supply Desk user (not just
    // anyone holding the public anon key) — check the bearer token against
    // Auth before doing anything else. Two accepted callers:
    //  - a real logged-in Supply Desk user (the "Sync work orders" button)
    //  - the project's own service role key (the scheduled cron job) — safe
    //    to trust since only this project itself holds that key.
    const authHeader = req.headers.get("Authorization") ?? "";
    const callerToken = authHeader.replace(/^Bearer\s+/i, "");
    const isScheduledCall = callerToken === serviceRoleKey;

    if (!isScheduledCall) {
      const callerClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: userData, error: userError } = await callerClient.auth.getUser(callerToken);
      if (userError || !userData?.user) {
        return new Response(JSON.stringify({ ok: false, error: "Not authenticated" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // From here on, use the service role key (server-side only, never sent
    // to the client) to actually read/write app_state.
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const accessToken = await getDeposcoAccessToken();
    const workOrders = await getOpenWorkOrders(accessToken);

    const woBySku = new Map<string, { number: string; qty: number; dueDate: string }>();
    for (const wo of workOrders) {
      const kitName = wo?.kitHeader?.businessKey?.name;
      const sku = skuFromKitName(kitName);
      if (!sku) continue;
      woBySku.set(sku.toLowerCase(), {
        number: wo.number,
        qty: wo.quantity,
        dueDate: wo.dueDate,
      });
    }

    const { data: row, error: readError } = await supabase
      .from("app_state")
      .select("data")
      .eq("id", 1)
      .single();
    if (readError) throw readError;

    const state = row.data;
    let setCount = 0;
    let clearedCount = 0;

    for (const item of state.items ?? []) {
      const skuKey = (item.sku ?? "").trim().toLowerCase();
      const matched = woBySku.get(skuKey);
      if (matched) {
        if (JSON.stringify(item.openWorkOrder) !== JSON.stringify(matched)) {
          item.openWorkOrder = matched;
          setCount++;
        }
      } else if ("openWorkOrder" in item) {
        delete item.openWorkOrder;
        clearedCount++;
      }
    }

    const { error: writeError } = await supabase
      .from("app_state")
      .update({ data: state, updated_at: new Date().toISOString() })
      .eq("id", 1);
    if (writeError) throw writeError;

    return new Response(
      JSON.stringify({
        ok: true,
        openWorkOrders: workOrders.length,
        itemsUpdated: setCount,
        itemsCleared: clearedCount,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error(err);
    return new Response(
      JSON.stringify({ ok: false, error: String(err?.message ?? err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
