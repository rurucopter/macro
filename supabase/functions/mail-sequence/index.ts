// Runs every minute (Supabase Cron). Two e-mails per new account:
//   1. welcome  - right after sign-up (account e-mail).
//   2. reminder - 10 minutes after the welcome, only if the person has not paid yet
//                 and ticked the e-mail consent box (marketing e-mail needs consent).
// Secrets: RESEND_API_KEY, CRON_SECRET, UNSUB_SECRET. Optional: MAIL_FROM, REQUIRE_OPTIN ("false" to disable the consent check).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
import { createClient } from "npm:@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const UNSUB_SECRET = Deno.env.get("UNSUB_SECRET") ?? "";
const MAIL_FROM = Deno.env.get("MAIL_FROM") ?? "mangereco <bonjour@mangereco.com>";
const REQUIRE_OPTIN = (Deno.env.get("REQUIRE_OPTIN") ?? "true") !== "false";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SITE = "https://www.mangereco.com";
const SENDER_LINE = "mangereco. - Arthur Demortiere, entrepreneur individuel, 47 rue Vivienne, 75002 Paris";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

async function unsubToken(userId: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(UNSUB_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(userId));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function layout(title: string, body: string, cta: { label: string; url: string }, unsub: string): string {
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1b2420">
<div style="font-size:22px;font-weight:700;margin-bottom:16px">mangereco<span style="color:#0f8a5f">.</span></div>
<h1 style="font-size:20px;line-height:1.3;margin:0 0 12px">${title}</h1>
${body}
<p style="margin:24px 0"><a href="${cta.url}" style="background:#0f8a5f;color:#fff;text-decoration:none;padding:12px 22px;border-radius:99px;font-weight:700;display:inline-block">${cta.label}</a></p>
<hr style="border:none;border-top:1px solid #e3e8e5;margin:24px 0 12px">
<p style="font-size:12px;color:#5b6660;line-height:1.5">${esc(SENDER_LINE)}<br>Tu reçois cet e-mail parce que tu as créé un compte sur mangereco.com. <a href="${unsub}" style="color:#5b6660">Me désinscrire</a></p></div>`;
}

async function send(to: string, subject: string, html: string, text: string, unsub: string) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: MAIL_FROM, to: [to], subject, html, text,
      reply_to: "arthurdemortiere15@gmail.com",
      headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    }),
  });
  if (!r.ok) throw new Error(`resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== CRON_SECRET || !CRON_SECRET) return new Response("forbidden", { status: 403 });
  if (!RESEND_API_KEY || !UNSUB_SECRET) return new Response("missing secrets", { status: 500 });
  const sb = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const out = { welcome: 0, reminder: 0, errors: [] as string[] };
  const info = (p: any) => {
    const D = (p.data && p.data.D) || {};
    const first = String(D.prenom || "").trim().split(/\s+/)[0];
    return { name: first ? first.charAt(0).toUpperCase() + first.slice(1) : "", goal: D.goal || "", budget: D.budget || "", meals: D.meals || "" };
  };
  const goalTxt = (g: string) => (g === "Prise de masse" ? "ta prise de masse" : g === "Sèche" ? "ta sèche" : "ton maintien");

  // 1. welcome: accounts created in the last 24 h, not welcomed yet
  const { data: fresh } = await sb.from("profiles").select("user_id,email,data,created_at,email_unsub")
    .is("welcome_sent_at", null).gt("created_at", iso(now - 24 * 3600 * 1000)).limit(50);
  for (const p of fresh ?? []) {
    if (!p.email || p.email_unsub) continue;
    try {
      const i = info(p);
      const unsub = `${SUPABASE_URL}/functions/v1/unsubscribe?u=${p.user_id}&t=${await unsubToken(p.user_id)}`;
      const plan = i.goal ? `<p style="line-height:1.55">Ton plan pour ${esc(goalTxt(i.goal))} est prêt${i.budget ? `, avec un budget de ${esc(String(i.budget))} € par semaine` : ""}. Retrouve tes repas de la semaine, les macros et ta liste de courses dans ton espace.</p>` : `<p style="line-height:1.55">Ton compte est créé. Réponds à quelques questions et ton plan repas de la semaine est prêt en 2 minutes.</p>`;
      const html = layout(`${i.name ? esc(i.name) + ", bienvenue" : "Bienvenue"} sur mangereco.`, plan, { label: "Voir mon plan", url: `${SITE}/?utm_source=email&utm_campaign=welcome` }, unsub);
      const text = `${i.name ? i.name + ", bienvenue" : "Bienvenue"} sur mangereco.\n\nTon plan t'attend : ${SITE}/?utm_source=email&utm_campaign=welcome\n\n${SENDER_LINE}\nSe désinscrire : ${unsub}`;
      await send(p.email, `${i.name ? i.name + ", ton" : "Ton"} plan mangereco. est prêt`, html, text, unsub);
      await sb.from("profiles").update({ welcome_sent_at: iso(Date.now()) }).eq("user_id", p.user_id);
      out.welcome++;
    } catch (e) { out.errors.push(String(e).slice(0, 160)); }
  }

  // 2. reminder: welcomed 10+ minutes ago (within 2 days), not reminded, not paid
  let q = sb.from("profiles").select("user_id,email,data,email_optin,email_unsub")
    .is("relance_sent_at", null).not("welcome_sent_at", "is", null)
    .lte("welcome_sent_at", iso(now - 10 * 60 * 1000)).gt("welcome_sent_at", iso(now - 48 * 3600 * 1000)).limit(50);
  if (REQUIRE_OPTIN) q = q.eq("email_optin", true);
  const { data: due } = await q;
  const ids = (due ?? []).map((p: any) => p.user_id);
  const paid = new Set<string>();
  if (ids.length) {
    const { data: subs } = await sb.from("subscriptions").select("user_id,unlocked").in("user_id", ids).eq("unlocked", true);
    (subs ?? []).forEach((s: any) => paid.add(s.user_id));
  }
  for (const p of due ?? []) {
    if (!p.email || p.email_unsub) continue;
    try {
      if (paid.has(p.user_id)) { await sb.from("profiles").update({ relance_sent_at: iso(Date.now()) }).eq("user_id", p.user_id); continue; }
      const i = info(p);
      const unsub = `${SUPABASE_URL}/functions/v1/unsubscribe?u=${p.user_id}&t=${await unsubToken(p.user_id)}`;
      const body = `<p style="line-height:1.55">Ton plan pour ${esc(goalTxt(i.goal))} est prêt, mais les recettes détaillées, les macros de chaque repas et la liste de courses sont encore verrouillées.</p><p style="line-height:1.55">Débloque ton accès quand tu veux : le paiement est sécurisé et ton plan est déjà en place.</p>`;
      const html = layout(`${i.name ? esc(i.name) + ", ton" : "Ton"} plan est toujours là`, body, { label: "Débloquer mon plan", url: `${SITE}/?utm_source=email&utm_campaign=relance10` }, unsub);
      const text = `${i.name ? i.name + ", ton" : "Ton"} plan est toujours là.\n\nDébloque tes recettes, tes macros et ta liste de courses : ${SITE}/?utm_source=email&utm_campaign=relance10\n\n${SENDER_LINE}\nSe désinscrire : ${unsub}`;
      await send(p.email, `${i.name ? i.name + ", ton" : "Ton"} plan est toujours là`, html, text, unsub);
      await sb.from("profiles").update({ relance_sent_at: iso(Date.now()) }).eq("user_id", p.user_id);
      out.reminder++;
    } catch (e) { out.errors.push(String(e).slice(0, 160)); }
  }
  return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
});
