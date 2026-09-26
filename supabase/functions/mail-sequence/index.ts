// Runs every minute (Supabase Cron). Sends the e-mail sequences:
//   A  signed-up, not paying : A1 now, A2 D+1 (only if the plan was not reopened), A3 D+3, A4 D+5, A5 D+7 (downsell link required)
//   B  paying                : B1 right after payment, B2 every Sunday 9:00 Paris, B3 30 days before the annual renewal
//   C  cancelled             : C1 seven days after the cancellation
// Each (user, mail) pair is claimed in public.mail_log before sending, so a mail is never sent twice.
// Secrets: RESEND_API_KEY, CRON_SECRET, UNSUB_SECRET. Optional: MAIL_FROM, DOWNSELL_URL, MANAGE_URL, IMG_A3, REQUIRE_OPTIN ("false" disables the consent check for A2-A5), SEQ_START.
// Test: POST ...?test=arthurdemortiere15@gmail.com (with the x-cron-secret header) sends every template to that address.
import { createClient } from "npm:@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const UNSUB_SECRET = Deno.env.get("UNSUB_SECRET") ?? "";
const MAIL_FROM = Deno.env.get("MAIL_FROM") ?? "Arthur de Mangereco <app@mangereco.com>";
const REQUIRE_OPTIN = (Deno.env.get("REQUIRE_OPTIN") ?? "true") !== "false";
const SEQ_START = Deno.env.get("SEQ_START") ?? "2026-09-26T18:00:00Z";
const DOWNSELL_URL = Deno.env.get("DOWNSELL_URL") ?? "";
const MANAGE_URL = Deno.env.get("MANAGE_URL") ?? "mailto:arthurdemortiere15@gmail.com?subject=G%C3%A9rer%20mon%20abonnement";
const IMG_A3 = Deno.env.get("IMG_A3") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SITE = "https://www.mangereco.com";
const ADMIN = "arthurdemortiere15@gmail.com";
const SENDER_LINE = "mangereco. - Arthur Demortiere, entrepreneur individuel, 47 rue Vivienne, 75002 Paris";
const DAY = 86400000;
const MAX_PER_RUN = 40;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function unsubToken(userId: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(UNSUB_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(userId));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type V = { prenom: string; goal: string; budget: string; renouv: string; price: string };
type Mail = { subject: string; html: string; text: string };

const link = (key: string) => `${SITE}/?utm_source=email&utm_campaign=${key}`;
const goalTxt = (g: string) => (g === "Sèche" ? "perdre du gras en gardant ton muscle" : g === "Maintien" ? "rester en forme" : "prendre du muscle");

function build(key: string, v: V): Mail | null {
  const hi = v.prenom ? `Salut ${esc(v.prenom)},` : "Salut,";
  const P = (h: string) => `<p style="line-height:1.55;margin:0 0 12px">${h}</p>`;
  const sign = P("Arthur");
  let subject = "", body = "", cta = "", url = link(key), txt = "";
  switch (key) {
    case "A1":
      subject = "Ton plan de la semaine est prêt 💪";
      body = P(hi) + P("Ton plan repas + ta liste de courses avec les prix sont prêts.") + P(`Objectif : ${goalTxt(v.goal)} sans dépasser ~${esc(v.budget)} € de courses par semaine.`) + P("Une question ? Réponds à ce mail, c'est moi qui lis.") + sign;
      cta = "Voir mon plan";
      break;
    case "A2":
      subject = "Tu fais tes courses quand ?";
      body = P(`${v.prenom ? esc(v.prenom) + ", t" : "T"}a liste est déjà faite, avec les quantités et les prix. Tu n'as plus qu'à la sortir au magasin.`);
      cta = "Ouvrir ma liste";
      break;
    case "A3":
      subject = "Ce que 25 € achètent vraiment";
      body = P("Riz, œufs, poulet, flocons d'avoine, lait… Voilà à quoi ressemble une semaine à ~130 g de protéines par jour pour ~25 € de courses (profil 70-75 kg, prise de masse).") +
        (IMG_A3 ? `<p style="margin:0 0 12px"><img src="${IMG_A3}" alt="Exemple de liste de courses" style="max-width:100%;border-radius:12px"></p>` : "") +
        P("Le plan s'adapte à ton poids, à ton objectif et à ton budget.");
      cta = "Voir l'offre";
      break;
    case "A4":
      subject = "9,99 €, c'est moins qu'un menu fast-food";
      body = P("Sans plan, tu achètes au hasard, tu jettes et tu manques de protéines.") + P("Mangereco, c'est 9,99 €/mois, ou 99 €/an (2 mois offerts).");
      cta = "Voir l'offre";
      break;
    case "A5":
      if (!DOWNSELL_URL) return null;
      subject = "Dernier mail de ma part";
      body = P("Je ne vais pas te relancer indéfiniment.") + P("Si le prix te bloque : 49,99 € pour l'année, soit moins d'1 € par semaine.");
      cta = "Profiter de l'offre";
      url = DOWNSELL_URL;
      break;
    case "B1":
      subject = "Bienvenue, voilà comment en tirer le max";
      body = P("3 choses :") +
        `<ol style="line-height:1.55;padding-left:20px;margin:0 0 12px"><li>Fais tes courses avec la liste (écran mobile).</li><li>Chaque dimanche, ton nouveau plan arrive.</li><li>Pèse-toi 1 fois par semaine et mets à jour ton poids dans « Mes réponses » : ton plan se recalcule.</li></ol>`;
      cta = "Ouvrir mon plan";
      break;
    case "B2":
      subject = "Ton plan de la semaine est prêt 🛒";
      body = P("Nouveau plan, nouvelle liste.") + P("Bonnes courses 💪");
      cta = "Voir ma semaine";
      break;
    case "B3":
      subject = "Ton abonnement annuel se renouvelle bientôt";
      body = P(`${v.prenom ? esc(v.prenom) + ", t" : "T"}on abonnement Mangereco (${esc(v.price)}/an) se renouvelle le ${esc(v.renouv)}.`) + P("Rien à faire si tu continues. Pour gérer ou annuler, c'est ici :");
      cta = "Gérer mon abonnement";
      url = MANAGE_URL;
      break;
    case "C1":
      subject = "Qu'est-ce qui n'a pas marché ?";
      body = P(`${v.prenom ? esc(v.prenom) + ", u" : "U"}ne seule question : pourquoi tu as arrêté ?`) + P("Réponds en 1 phrase, je lis tout.") + sign;
      break;
    default:
      return null;
  }
  const btn = cta ? `<p style="margin:20px 0"><a href="${url}" style="background:#0f8a5f;color:#fff;text-decoration:none;padding:12px 22px;border-radius:99px;font-weight:700;display:inline-block">${cta}</a></p>` : "";
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:20px;color:#1b2420;font-size:16px">${body}${btn}__FOOT__</div>`;
  const text = body.replace(/<\/(p|li)>/g, "\n").replace(/<br\s*\/?>/g, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#39;/g, "'").trim() + (cta ? `\n\n${cta} : ${url}` : "");
  return { subject, html, text };
}

async function deliver(to: string, userId: string, mail: Mail, tag: string): Promise<void> {
  const unsub = `${SUPABASE_URL}/functions/v1/unsubscribe?u=${userId}&t=${await unsubToken(userId)}`;
  const foot = `<hr style="border:none;border-top:1px solid #e3e8e5;margin:24px 0 12px"><p style="font-size:12px;color:#5b6660;line-height:1.5;margin:0">${esc(SENDER_LINE)}<br>Tu reçois cet e-mail parce que tu as un compte sur mangereco.com. <a href="${unsub}" style="color:#5b6660">Me désinscrire</a></p>`;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: MAIL_FROM, to: [to], subject: tag + mail.subject,
      html: mail.html.replace("__FOOT__", foot), text: `${mail.text}\n\n--\n${SENDER_LINE}\nSe désinscrire : ${unsub}`,
      reply_to: ADMIN,
      headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    }),
  });
  if (!r.ok) throw new Error(`resend ${r.status}: ${(await r.text()).slice(0, 160)}`);
  await sleep(550); // Resend allows 2 requests per second
}

function paris(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Paris", weekday: "long", hour: "2-digit", hour12: false, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const g = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  return { wd: g("weekday"), hour: parseInt(g("hour")) % 24, date: `${g("year")}-${g("month")}-${g("day")}` };
}
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Paris" });

Deno.serve(async (req) => {
  if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) return new Response("forbidden", { status: 403 });
  if (!RESEND_API_KEY || !UNSUB_SECRET) return new Response("missing secrets", { status: 500 });
  const url = new URL(req.url);
  const out = { sent: [] as string[], errors: [] as string[] };
  const json = () => new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });

  // ---- test mode: every template to the admin address
  const test = url.searchParams.get("test");
  if (test) {
    if (test.toLowerCase() !== ADMIN) return new Response("test only to " + ADMIN, { status: 400 });
    const v: V = { prenom: "Arthur", goal: "Prise de masse", budget: "25", renouv: fmtDate(new Date(Date.now() + 30 * DAY).toISOString()), price: "99 €" };
    const fakeId = "00000000-0000-0000-0000-000000000000";
    for (const k of ["A1", "A2", "A3", "A4", "A5", "B1", "B2", "B3", "C1"]) {
      const m = build(k, v);
      if (!m) { out.errors.push(`${k}: not sent (DOWNSELL_URL is empty)`); continue; }
      try { await deliver(ADMIN, fakeId, m, `[TEST ${k}] `); out.sent.push(k); } catch (e) { out.errors.push(`${k}: ${String(e).slice(0, 140)}`); }
    }
    return json();
  }

  const sb = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
  const now = Date.now();
  let budgetLeft = MAX_PER_RUN;

  const info = (p: any): V => {
    const D = (p && p.data && p.data.D) || {};
    const first = String(D.prenom || "").trim().split(/\s+/)[0];
    return { prenom: first ? first.charAt(0).toUpperCase() + first.slice(1) : "", goal: D.goal || "", budget: String(D.budget || "25"), renouv: "", price: "99 €" };
  };
  // claim (user, key) then send; the claim prevents duplicates even if two runs overlap
  async function once(p: any, key: string, v: V, claimKey = key) {
    if (budgetLeft <= 0 || !p.email || p.email_unsub) return;
    const m = build(key, v);
    if (!m) return;
    const { error: ce } = await sb.from("mail_log").insert({ user_id: p.user_id, mail_key: claimKey });
    if (ce) { if ((ce as any).code !== "23505") out.errors.push(`log: ${ce.message}`); return; }
    budgetLeft--;
    try { await deliver(p.email, p.user_id, m, ""); out.sent.push(`${claimKey}`); }
    catch (e) { await sb.from("mail_log").delete().eq("user_id", p.user_id).eq("mail_key", claimKey); out.errors.push(`${claimKey}: ${String(e).slice(0, 140)}`); }
  }
  async function profilesFor(ids: string[]) {
    const m = new Map<string, any>();
    if (!ids.length) return m;
    const { data } = await sb.from("profiles").select("user_id,email,data,email_unsub,email_optin,plan_opened_at,created_at").in("user_id", ids);
    (data ?? []).forEach((p: any) => m.set(p.user_id, p));
    return m;
  }

  // ---- A: signed up, not paying (accounts created since SEQ_START, in the last 10 days)
  const { data: recent } = await sb.from("profiles").select("user_id,email,data,created_at,plan_opened_at,email_optin,email_unsub")
    .gt("created_at", SEQ_START).gt("created_at", new Date(now - 10 * DAY).toISOString()).order("created_at", { ascending: true }).limit(200);
  const ids = (recent ?? []).map((p: any) => p.user_id);
  const paid = new Set<string>();
  if (ids.length) {
    const { data: subs } = await sb.from("subscriptions").select("user_id").in("user_id", ids).eq("unlocked", true);
    (subs ?? []).forEach((s: any) => paid.add(s.user_id));
  }
  for (const p of recent ?? []) {
    if (paid.has(p.user_id)) continue;
    const age = now - new Date(p.created_at).getTime();
    const v = info(p);
    const consent = p.email_optin === true || !REQUIRE_OPTIN;
    await once(p, "A1", v);
    if (!consent) continue;
    if (age >= 1 * DAY && age < 3 * DAY && !p.plan_opened_at) await once(p, "A2", v);
    if (age >= 3 * DAY && age < 5 * DAY) await once(p, "A3", v);
    if (age >= 5 * DAY && age < 7 * DAY) await once(p, "A4", v);
    if (age >= 7 * DAY && age < 9 * DAY) await once(p, "A5", v);
  }

  // ---- B1: right after payment (paid in the last 24 h)
  const { data: fresh } = await sb.from("subscriptions").select("user_id").eq("unlocked", true).gt("paid_at", new Date(now - DAY).toISOString()).limit(50);
  if (fresh && fresh.length) {
    const pm = await profilesFor(fresh.map((s: any) => s.user_id));
    for (const s of fresh) { const p = pm.get(s.user_id); if (p) await once(p, "B1", info(p)); }
  }

  // ---- B2: every Sunday at 9:00 Paris time, all active subscribers (once per week)
  const pt = paris();
  if (pt.wd === "Sunday" && pt.hour === 9) {
    const { data: act } = await sb.from("subscriptions").select("user_id").eq("unlocked", true).limit(500);
    const pm = await profilesFor((act ?? []).map((s: any) => s.user_id));
    for (const s of act ?? []) { const p = pm.get(s.user_id); if (p) await once(p, "B2", info(p), `B2-${pt.date}`); }
  }

  // ---- B3: 30 days before the annual renewal
  const d = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const { data: ren } = await sb.from("subscriptions").select("user_id,renews_at,plan_kind").eq("unlocked", true).in("plan_kind", ["year", "downsell"]).gte("renews_at", d(now + 25 * DAY)).lte("renews_at", d(now + 30 * DAY)).limit(50);
  if (ren && ren.length) {
    const pm = await profilesFor(ren.map((s: any) => s.user_id));
    for (const s of ren) { const p = pm.get(s.user_id); if (!p) continue; const v = info(p); v.renouv = fmtDate(s.renews_at + "T12:00:00Z"); v.price = s.plan_kind === "downsell" ? "49,99 €" : "99 €"; await once(p, "B3", v, `B3-${s.renews_at}`); }
  }

  // ---- C1: seven days after the cancellation
  const { data: canc } = await sb.from("subscriptions").select("user_id").eq("unlocked", false).not("canceled_at", "is", null)
    .lte("canceled_at", new Date(now - 7 * DAY).toISOString()).gt("canceled_at", new Date(now - 10 * DAY).toISOString()).limit(50);
  if (canc && canc.length) {
    const pm = await profilesFor(canc.map((s: any) => s.user_id));
    for (const s of canc) { const p = pm.get(s.user_id); if (p) await once(p, "C1", info(p)); }
  }
  return json();
});
