// One-click unsubscribe. Link format: /functions/v1/unsubscribe?u=<user_id>&t=<hmac hex of user_id>
// Secret: UNSUB_SECRET (same value as in mail-sequence). Verify JWT must be OFF for this function.
import { createClient } from "npm:@supabase/supabase-js@2";

const UNSUB_SECRET = Deno.env.get("UNSUB_SECRET") ?? "";

async function token(userId: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(UNSUB_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(userId));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function eq(a: string, b: string) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
const page = (msg: string) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>mangereco.</title><body style="font-family:Arial,sans-serif;max-width:480px;margin:15vh auto;padding:0 20px;text-align:center;color:#1b2420"><h1 style="font-size:22px">${msg}</h1><p><a href="https://www.mangereco.com/" style="color:#0f8a5f">Retour sur mangereco.com</a></p>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const u = url.searchParams.get("u") ?? "";
  const t = url.searchParams.get("t") ?? "";
  if (!UNSUB_SECRET || !/^[0-9a-f-]{36}$/.test(u) || !eq(t, await token(u))) return page("Lien invalide.");
  const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
  const { error } = await sb.from("profiles").update({ email_optin: false, email_unsub: true }).eq("user_id", u);
  if (error) return page("Une erreur est survenue. Écris-nous à arthurdemortiere15@gmail.com.");
  return req.method === "POST" ? new Response("ok") : page("Tu es désinscrit. Tu ne recevras plus d'e-mails de notre part.");
});
