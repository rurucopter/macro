// Receives Whop webhooks and keeps public.subscriptions in sync:
//   payment.succeeded        -> unlocked = true, plan kind, paid_at, renewal date
//   membership.deactivated   -> unlocked = false, canceled_at (never for the lifetime plan)
// Deploy from the Supabase dashboard (Edge Functions, Verify JWT off). Secrets: WHOP_WEBHOOK_SECRET (+ optional FOUNDER_PLAN_ID).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically by Supabase.
//
// Signature scheme (Whop docs): HMAC-SHA256 over "{webhook-id}.{webhook-timestamp}.{raw body}", key = the raw ws_... secret,
// result base64, header value "v1,<signature>" (possibly several space-separated candidates).

import { createClient } from "npm:@supabase/supabase-js@2";

const WHOP_WEBHOOK_SECRET = Deno.env.get("WHOP_WEBHOOK_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const MAX_CLOCK_SKEW_SECONDS = 300;

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function computeSignature(signedContent: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedContent));
  return btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
}

async function verifyWhopSignature(id: string, timestamp: string, rawBody: string, signatureHeader: string): Promise<boolean> {
  const expected = await computeSignature(`${id}.${timestamp}.${rawBody}`, WHOP_WEBHOOK_SECRET);
  const candidates = signatureHeader.split(" ").map((part) => part.split(",")[1]).filter(Boolean) as string[];
  return candidates.some((sig) => timingSafeEqual(sig, expected));
}

const dayPlus = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!WHOP_WEBHOOK_SECRET) {
    console.error("WHOP_WEBHOOK_SECRET is not set");
    return new Response("Server misconfigured", { status: 500 });
  }

  const id = req.headers.get("webhook-id");
  const timestamp = req.headers.get("webhook-timestamp");
  const signature = req.headers.get("webhook-signature");
  if (!id || !timestamp || !signature) return new Response("Missing signature headers", { status: 400 });

  const ts = parseInt(timestamp, 10);
  if (!ts || Math.abs(Date.now() / 1000 - ts) > MAX_CLOCK_SKEW_SECONDS) return new Response("Stale timestamp", { status: 400 });

  const rawBody = await req.text();
  if (!(await verifyWhopSignature(id, timestamp, rawBody, signature))) return new Response("Invalid signature", { status: 401 });

  let event: any;
  try { event = JSON.parse(rawBody); } catch { return new Response("Invalid JSON", { status: 400 }); }

  const isPayment = event.type === "payment.succeeded";
  const isEnd = event.type === "membership.deactivated";
  if (!isPayment && !isEnd) return new Response("ignored", { status: 200 }); // ack everything else so Whop doesn't retry

  const email: string | undefined = event.data?.user?.email ?? event.data?.email;
  if (!email) {
    console.error(`${event.type} event without a buyer email`, event.data?.id);
    return new Response("Missing buyer email", { status: 200 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: userId, error: lookupError } = await supabase.rpc("get_user_id_by_email", { p_email: email });
  if (lookupError || !userId) {
    console.error("No Supabase user found for email", email, lookupError);
    return new Response("No matching user", { status: 200 });
  }

  if (isEnd) {
    const { data: cur } = await supabase.from("subscriptions").select("plan_kind,founder").eq("user_id", userId).maybeSingle();
    if (cur && (cur.plan_kind === "life" || cur.founder)) return new Response("lifetime, kept", { status: 200 });
    const { error } = await supabase.from("subscriptions").update({ unlocked: false, canceled_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("user_id", userId);
    if (error) { console.error("Failed to deactivate", error); return new Response("DB error", { status: 500 }); }
    return new Response("ok", { status: 200 });
  }

  const paymentId: string | undefined = event.data?.id;
  const planId: string | undefined = event.data?.plan?.id;
  const founderPlanId = Deno.env.get("FOUNDER_PLAN_ID");
  const total = Math.round(Number(event.data?.total ?? event.data?.usd_total ?? NaN) * 100) / 100;
  const isFounder = founderPlanId ? planId === founderPlanId : total === 59.99;
  // kind of plan from the amount charged (prices are tax-inclusive)
  const kind = isFounder ? "life" : total === 49.99 ? "downsell" : total === 99 ? "year" : total >= 9.9 && total <= 10.1 ? "month" : null;

  const row: Record<string, unknown> = {
    user_id: userId,
    unlocked: true,
    plan: planId ?? null,
    plan_kind: kind,
    whop_payment_id: paymentId ?? null,
    paid_at: new Date().toISOString(),
    renews_at: kind === "year" || kind === "downsell" ? dayPlus(365) : kind === "month" ? dayPlus(30) : null,
    canceled_at: null,
    updated_at: new Date().toISOString(),
  };
  if (isFounder) row.founder = true;

  const { error: upsertError } = await supabase.from("subscriptions").upsert(row, { onConflict: "user_id" });
  if (upsertError) {
    console.error("Failed to upsert subscription", upsertError);
    return new Response("DB error", { status: 500 });
  }
  return new Response("ok", { status: 200 });
});
