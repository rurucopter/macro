// Receives Whop's "payment.succeeded" webhook and marks the paying user as
// unlocked in public.subscriptions. Deploy with: supabase functions deploy whop-webhook
// Required secrets: WHOP_WEBHOOK_SECRET (from Whop's webhook settings).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically by Supabase.
//
// Signature scheme (per Whop's docs, https://docs.whop.com/developer/guides/webhooks):
// HMAC-SHA256 over "{webhook-id}.{webhook-timestamp}.{raw body}", key = the raw
// ws_... secret string (no prefix stripping, no base64 decoding), result base64-encoded,
// header value shaped "v1,<signature>" (possibly several space-separated candidates).
//
// This has not been exercised against a real Whop-signed request yet - test it with
// Whop's "Send test event" button before relying on it in production.

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
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedContent));
  return btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
}

async function verifyWhopSignature(id: string, timestamp: string, rawBody: string, signatureHeader: string): Promise<boolean> {
  const expected = await computeSignature(`${id}.${timestamp}.${rawBody}`, WHOP_WEBHOOK_SECRET);
  const candidates = signatureHeader
    .split(" ")
    .map((part) => part.split(",")[1])
    .filter(Boolean) as string[];
  return candidates.some((sig) => timingSafeEqual(sig, expected));
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  if (!WHOP_WEBHOOK_SECRET) {
    console.error("WHOP_WEBHOOK_SECRET is not set");
    return new Response("Server misconfigured", { status: 500 });
  }

  const id = req.headers.get("webhook-id");
  const timestamp = req.headers.get("webhook-timestamp");
  const signature = req.headers.get("webhook-signature");
  if (!id || !timestamp || !signature) {
    return new Response("Missing signature headers", { status: 400 });
  }

  const ts = parseInt(timestamp, 10);
  if (!ts || Math.abs(Date.now() / 1000 - ts) > MAX_CLOCK_SKEW_SECONDS) {
    return new Response("Stale timestamp", { status: 400 });
  }

  const rawBody = await req.text();

  const valid = await verifyWhopSignature(id, timestamp, rawBody, signature);
  if (!valid) {
    return new Response("Invalid signature", { status: 401 });
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (event.type !== "payment.succeeded") {
    // Acknowledge every other event type so Whop doesn't retry them.
    return new Response("ignored", { status: 200 });
  }

  const email: string | undefined = event.data?.user?.email ?? event.data?.email;
  const paymentId: string | undefined = event.data?.id;
  const planId: string | undefined = event.data?.plan?.id;

  if (!email) {
    console.error("payment.succeeded event without a buyer email", event.data?.id);
    return new Response("Missing buyer email", { status: 200 }); // ack so Whop doesn't retry forever
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: userId, error: lookupError } = await supabase.rpc("get_user_id_by_email", { p_email: email });
  if (lookupError || !userId) {
    console.error("No Supabase user found for email", email, lookupError);
    // The buyer paid but has no account (e.g. checked out with a different e-mail
    // than they signed up with). Ack the webhook - retries won't fix a mismatched
    // email - but leave a trace so this can be reconciled manually.
    return new Response("No matching user", { status: 200 });
  }

  const { error: upsertError } = await supabase
    .from("subscriptions")
    .upsert(
      { user_id: userId, unlocked: true, plan: planId ?? null, whop_payment_id: paymentId ?? null, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );

  if (upsertError) {
    console.error("Failed to upsert subscription", upsertError);
    return new Response("DB error", { status: 500 });
  }

  return new Response("ok", { status: 200 });
});
