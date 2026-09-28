// Links from the e-mails. Secret: UNSUB_SECRET (same value as in mail-sequence). Verify JWT must be OFF for this function.
//   Unsubscribe : /functions/v1/unsubscribe?u=<user_id>&t=<hmac of user_id>
//                 GET shows a confirmation button (mail scanners open links, they must not unsubscribe anyone),
//                 POST unsubscribes (button, or one-click from the mail app via the List-Unsubscribe-Post header).
//   Click       : /functions/v1/unsubscribe?c=<mail_key>&u=<user_id>&t=<hmac of user_id|mail_key>&to=<path on the site>
//                 records the first click in mail_log.clicked_at, then redirects to https://www.mangereco.com<path>.
import { createClient } from "npm:@supabase/supabase-js@2";

const UNSUB_SECRET = Deno.env.get("UNSUB_SECRET") ?? "";
const SITE = "https://www.mangereco.com";

async function token(msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(UNSUB_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function eq(a: string, b: string) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
const shell = (inner: string) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>mangereco.</title><body style="font-family:Arial,sans-serif;max-width:480px;margin:15vh auto;padding:0 20px;text-align:center;color:#1b2420">${inner}<p><a href="${SITE}/" style="color:#0f8a5f">Retour sur mangereco.com</a></p>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
const page = (msg: string) => shell(`<h1 style="font-size:22px">${msg}</h1>`);

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const u = url.searchParams.get("u") ?? "";
  const t = url.searchParams.get("t") ?? "";
  const c = url.searchParams.get("c");
  const sb = () => createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

  // ---- click on a button of an e-mail
  if (c !== null) {
    let to = url.searchParams.get("to") ?? "/";
    if (!/^\/(?![\/\\])[^\s]*$/.test(to)) to = "/"; // only paths of our own site: no open redirect
    if (UNSUB_SECRET && /^[0-9a-f-]{36}$/.test(u) && /^[A-Za-z0-9-]{1,60}$/.test(c) && eq(t, await token(`${u}|${c}`))) {
      try { await sb().from("mail_log").update({ clicked_at: new Date().toISOString() }).eq("user_id", u).eq("mail_key", c).is("clicked_at", null); } catch (_) { /* never block the redirect */ }
    }
    return new Response(null, { status: 302, headers: { Location: SITE + to, "Cache-Control": "no-store" } });
  }

  // ---- unsubscribe
  if (!UNSUB_SECRET || !/^[0-9a-f-]{36}$/.test(u) || !eq(t, await token(u))) return page("Lien invalide.");
  if (req.method !== "POST") {
    return shell(`<h1 style="font-size:22px">Ne plus recevoir nos e-mails ?</h1><p style="line-height:1.5;color:#3d4a44">Tu ne recevras plus les rappels ni les nouveautés. Si tu es abonné, tu recevras quand même les e-mails liés à ton abonnement (paiement, renouvellement).</p>` +
      `<form method="post" action="?u=${u}&t=${t}"><button type="submit" style="background:#0f8a5f;color:#fff;border:none;padding:14px 24px;border-radius:99px;font-weight:700;font-size:16px;cursor:pointer">Me désinscrire</button></form>`);
  }
  const { error } = await sb().from("profiles").update({ email_optin: false, email_unsub: true }).eq("user_id", u);
  if (error) return page("Une erreur est survenue. Écris-nous à arthurdemortiere15@gmail.com.");
  // one-click from the mail app sends "List-Unsubscribe=One-Click" as the body: a short answer is enough
  const ct = req.headers.get("content-type") ?? "";
  const body = ct.includes("form") ? await req.text().catch(() => "") : "";
  if (body.includes("List-Unsubscribe=One-Click")) return new Response("ok");
  return page("C'est fait, tu es désinscrit.");
});
