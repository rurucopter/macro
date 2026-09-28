// Runs every minute (Supabase Cron). Sends the e-mail sequences:
//   A  account, not paying (needs e-mail consent). Clock starts when the paywall was first seen (else at sign-up).
//        A1 +10 min (button straight to the Whop checkout), A2 D+1 (shopping list, blurred preview), A3 D+3 (last reminder),
//        A4 then every Saturday 18:00 Paris, 1 per week, 4 at most (recipes teaser).
//      Everything stops as soon as the person pays. While founder places remain (live count) the mails push the
//      founder pack (links ?payer=fondateur / ?offre=fondateur), once the 20 are sold the 9.99 €/month plan
//      (?payer=mensuel / ?offre=plan). The annual plan is not offered any more (hidden on the site).
//   B  paying
//        B1 right after payment (transactional, sent even if unsubscribed)
//        B2 48 h after payment, only if the shopping list was not opened since the payment
//        B3 every Saturday 18:00 Paris: the plan + list of the week
//        B4 renewal reminder, D-3 for monthly, D-7 for annual (transactional)
//        B5 manual "nouveauté" broadcast (POST ?broadcast, see below)
//   C1 seven days after a cancellation. F1 one founder mail to accounts created before SEQ_START.
// Each (user, mail) pair is claimed in public.mail_log before sending, so a mail is never sent twice.
// A failed send is retried twice (after 5 min, then 30 min); the error is kept in mail_log.last_error.
// Every button goes through the unsubscribe function (?c=...) which records mail_log.clicked_at, then redirects.
// Secrets: RESEND_API_KEY, CRON_SECRET, UNSUB_SECRET. Optional: MAIL_FROM, MANAGE_URL, REQUIRE_OPTIN ("false" disables
// the consent check for the A mails), SEQ_START.
// Manual calls (header x-cron-secret, or the admin's Supabase session from the site's stats page):
//   ?test=1                                       every template to the admin address (add &only=A2 for one)
//   POST ?broadcast  {slug, subject, text, cta, to, audience: "abonnes"|"inscrits", test: true|false}   B5
import { createClient } from "npm:@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const UNSUB_SECRET = Deno.env.get("UNSUB_SECRET") ?? "";
const MAIL_FROM = Deno.env.get("MAIL_FROM") ?? "Arthur de Mangereco <app@mangereco.com>";
const REQUIRE_OPTIN = (Deno.env.get("REQUIRE_OPTIN") ?? "true") !== "false";
const SEQ_START = Deno.env.get("SEQ_START") ?? "2026-09-26T18:00:00Z";
const MANAGE_URL = Deno.env.get("MANAGE_URL") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SITE = "https://www.mangereco.com";
const IMG_LIST = `${SITE}/img/mail-liste-floue.png`;
const ADMIN = "arthurdemortiere15@gmail.com";
const SENDER_LINE = "mangereco. - Arthur Demortiere, entrepreneur individuel, 47 rue Vivienne, 75002 Paris";
const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const MAX_PER_RUN = 40;
const MAX_BROADCAST = 120; // per call (Resend: 2 mails/s, the function must answer within ~150 s)
const MAX_ATTEMPTS = 3;
const FOUNDER_CAP = 20;
const A4_MAX = 4;
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-cron-secret", "Access-Control-Allow-Methods": "POST, OPTIONS" };

const esc = (s: string) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function hmac(msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(UNSUB_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- Paris time. The site switches to the new weekly plan on Saturday 18:00 Paris: same week number here.
function paris(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Paris", weekday: "long", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const g = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  const y = +g("year"), mo = +g("month"), da = +g("day"), h = +g("hour") % 24, mi = +g("minute");
  const days = Date.UTC(y, mo - 1, da, h, mi) / DAY;
  return { wd: g("weekday"), hour: h, date: `${g("year")}-${g("month")}-${g("day")}`, week: Math.floor((days + 4.25) / 7) };
}
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "long", timeZone: "Europe/Paris" });
const euros = (n: number) => n.toFixed(2).replace(".", ",") + " €";

// ---- templates
type V = {
  prenom: string; goal: string; budget: string; meals: number; places: number;
  weekCost: number | null; plans: number; renouv: string; price: string; week: number;
  b5?: { subject: string; text: string; cta: string; to: string };
};
type Mail = { subject: string; html: string; text: string; tx: boolean };
type Go = (path: string) => string; // tracked link to a path of the site

// Recipes shown in the A4 teaser (name, protein g, price per portion, photo). 3 per week, rotating.
const TEASER: [string, number, number, string][] = [
  ["Curry poulet + riz basmati", 34, 1.9, "chicken-curry-rice.jpg"],
  ["Chili con carne maison", 37, 1.7, "chili2meal.jpg"],
  ["Omelette 4 œufs + flocons d'avoine", 35, 1.2, "omelette2.jpg"],
  ["Riz + dinde + courgettes", 39, 2, "turkey-rice-zucchini.jpg"],
  ["Pâtes + thon + sauce tomate maison", 31, 1.2, "pasta.jpg"],
  ["Pancakes protéinés + banane", 25, 1, "pancakes.jpg"],
  ["Lentilles corail + riz + poulet", 43, 1.8, "lentil.jpg"],
  ["Bolo maison (bœuf haché + pâtes)", 38, 2, "bolo.jpg"],
  ["Wrap poulet + crudités", 33, 1.6, "wrap.jpg"],
  ["Œufs brouillés + pommes de terre sautées", 26, 1.1, "eggs-potatoes.jpg"],
  ["Poulet grillé + riz basmati", 43, 2.1, "chicken.jpg"],
  ["Dahl de lentilles corail + riz basmati", 29, 1.4, "lentil-veggie-bowl.jpg"],
];

const goalTxt = (g: string) => (g === "Sèche" ? "perdre du gras en gardant ton muscle" : g === "Maintien" ? "rester en forme" : "prendre du muscle");
const pl = (n: number) => `${n} place${n > 1 ? "s" : ""}`;
const utm = (key: string) => `utm_source=email&utm_campaign=${key}`;

function build(key: string, v: V, go: Go): Mail | null {
  const hi = v.prenom ? `Salut ${esc(v.prenom)},` : "Salut,";
  const P = (h: string) => `<p style="line-height:1.55;margin:0 0 14px">${h}</p>`;
  const UL = (items: string[]) => `<ul style="line-height:1.55;padding-left:20px;margin:0 0 14px">${items.map((i) => `<li style="margin:0 0 4px">${i}</li>`).join("")}</ul>`;
  const small = (h: string) => `<p style="line-height:1.5;margin:0 0 14px;font-size:14px;color:#3d4a44">${h}</p>`;
  const sign = P("Arthur");
  const F = v.places !== 0; // founder pack still open (-1: count unknown)
  const nb = v.places > 0 ? `Il reste ${pl(v.places)} sur ${FOUNDER_CAP}` : `Places limitées à ${FOUNDER_CAP}`;
  const left = P(`<b>${nb}</b>. Quand elles sont parties, l'offre ferme : ce sera 9,99 €/mois.`);
  const PLAN = `/?${utm(key)}`, LISTE = `/?voir=liste&${utm(key)}`, FOND = `/?offre=fondateur&${utm(key)}`, OFFRE = `/?offre=plan&${utm(key)}`;
  const PAY = `/?payer=${F ? "fondateur" : "mensuel"}&${utm(key)}`; // straight to the Whop checkout
  let subject = "", body = "", cta = "", to = PLAN, tx = false;
  switch (key) {
    // ---------- A: not paying
    case "A1": // 3 lines, one button straight to the checkout
      subject = F ? "Ton plan est prêt — 59,99 € une fois, à vie" : "Ton plan est prêt — 9,99 €/mois";
      body = F ? P(`${hi} ton plan est prêt : <b>59,99 € une fois</b>, et il est à toi à vie.`) +
                 P(v.places > 0 ? `Il reste <b>${pl(v.places)}</b> au prix fondateur, ensuite c'est 9,99 €/mois.` : `<b>Places limitées à ${FOUNDER_CAP}</b> au prix fondateur, ensuite c'est 9,99 €/mois.`) + sign
               : P(`${hi} ton plan est prêt : tous tes repas et ta liste de courses avec les prix.`) + P("Débloque-le pour <b>9,99 €/mois</b>.") + sign;
      cta = F ? "Débloquer mon plan à vie" : "Débloquer mon plan";
      to = PAY;
      break;
    case "A2":
      subject = `Ta liste de courses à ${esc(v.budget)} € est prête`;
      body = P(hi) + P(`Ta liste pour la semaine est faite : les quantités, les prix, rangée par rayon. Objectif : ${goalTxt(v.goal)} sans dépasser ${esc(v.budget)} €.`) +
        `<p style="margin:0 0 14px"><img src="${IMG_LIST}" width="480" alt="Aperçu flouté d'une liste de courses mangereco" style="width:100%;max-width:480px;height:auto;border-radius:14px;border:1px solid #e3e8e5;display:block"></p>` +
        (F ? P(`Débloque-la avec le <b>pack fondateur</b> : 59,99 € une fois, et elle se refait toute seule chaque samedi, à vie. ${nb}.`)
           : P("Débloque-la pour 9,99 €/mois.")) + sign;
      cta = "Débloquer ma liste";
      to = F ? FOND : OFFRE;
      break;
    case "A3":
      subject = F ? (v.places > 0 ? `Dernier rappel : ${pl(v.places)} fondateur` : "Dernier rappel : pack fondateur") : "Dernier rappel pour ton plan";
      body = P(hi) + P("C'est mon dernier rappel, promis.") +
        (F ? P(`Le pack fondateur, c'est <b>59,99 € une seule fois</b> pour ton plan repas et ta liste de courses, recalculés chaque semaine, à vie.`) + left
           : P("Ton plan repas + ta liste de courses avec les prix, recalculés chaque semaine : 9,99 €/mois.")) +
        P("Si quelque chose te bloque (le prix, un aliment, le plan), réponds à ce mail et dis-moi quoi.") + sign;
      cta = F ? "Devenir membre fondateur" : "Débloquer mon plan";
      to = F ? FOND : OFFRE;
      break;
    case "A4": {
      const i = ((v.week % 4) + 4) % 4 * 3, picks = TEASER.slice(i, i + 3);
      subject = `3 repas à moins de ${euros(Math.ceil(Math.max(...picks.map((x) => x[2]))))} cette semaine`;
      const card = (m: [string, number, number, string]) =>
        `<tr><td style="padding:0 0 10px;width:96px;vertical-align:top"><img src="${SITE}/img/${m[3]}" width="88" height="88" alt="" style="width:88px;height:88px;object-fit:cover;border-radius:12px;display:block"></td>` +
        `<td style="padding:0 0 10px 12px;vertical-align:middle;line-height:1.4"><b>${esc(m[0])}</b><br><span style="font-size:14px;color:#3d4a44">${m[1]} g de protéines · ${euros(m[2])} la portion</span></td></tr>`;
      body = P(hi) + P("Au menu des plans mangereco cette semaine :") +
        `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 14px;width:100%">${picks.map(card).join("")}</table>` +
        P("Avec ton plan, tu as les quantités exactes pour tes macros et la liste de courses qui va avec.") +
        (F ? small(`Pack fondateur : 59,99 € une fois, à vie. ${nb}.`) : small("9,99 €/mois."));
      cta = "Voir mon plan de la semaine";
      to = F ? FOND : OFFRE;
      break;
    }
    case "F1":
      if (!F) return null;
      subject = v.places > 0 ? `Plus que ${pl(v.places)} en accès à vie` : `Pack fondateur : places limitées à ${FOUNDER_CAP}`;
      body = P(hi) + P(`J'ouvre le <b>pack fondateur</b> de Mangereco aux ${FOUNDER_CAP} premiers clients :`) +
        UL(["<b>59,99 € une seule fois</b>, pas d'abonnement", "Accès à vie à ton plan repas + ta liste de courses avec les prix", "Toutes les futures nouveautés incluses", "Prix bloqué pour toujours"]) +
        left + P("Une question ? Réponds à ce mail.") + sign;
      cta = "Devenir membre fondateur";
      to = FOND;
      break;
    // ---------- B: paying
    case "B1":
      tx = true;
      subject = "Ton plan est prêt, fais tes courses 🛒";
      body = P(`${v.prenom ? `Merci ${esc(v.prenom)} !` : "Merci !"} Ton paiement est bien passé, tout est débloqué.`) +
        P("Ta liste de courses de la semaine est prête, avec les quantités et les prix. Ouvre-la au magasin et coche au fur et à mesure.") +
        small("Chaque samedi à 18 h, ton nouveau plan et ta nouvelle liste arrivent. Une question ? Réponds à ce mail.") + sign;
      cta = "Ouvrir ma liste de courses";
      to = LISTE;
      break;
    case "B2":
      subject = "Ta liste t'attend";
      body = P(`${v.prenom ? esc(v.prenom) + ", t" : "T"}a liste de courses est prête. Un clic et tu l'as sous les yeux au magasin.`);
      cta = "Ouvrir ma liste";
      to = LISTE;
      break;
    case "B3":
      subject = "Ton plan + ta liste de la semaine sont prêts";
      body = P(hi) + P("Nouvelle semaine, nouveau plan : tes repas et ta liste de courses sont prêts" + (v.weekCost ? ` (environ ${euros(v.weekCost)} pour la semaine).` : ".")) +
        P("Bonnes courses 💪");
      cta = "Voir ma liste de la semaine";
      to = LISTE;
      break;
    case "B4":
      tx = true;
      subject = `Ton abonnement se renouvelle le ${esc(v.renouv)}`;
      body = P(hi) + P(`Ton abonnement Mangereco (${esc(v.price)}) se renouvelle le <b>${esc(v.renouv)}</b>.`) +
        P("Ce que tu as eu jusqu'ici :") +
        UL([`<b>${v.plans}</b> plan${v.plans > 1 ? "s" : ""} de la semaine, avec leur liste de courses`,
            v.weekCost ? `Une semaine de courses à <b>environ ${euros(v.weekCost)}</b>` + (v.meals ? `, soit ~${euros(v.weekCost / v.meals)} le repas` : "") : `Un plan calé sur ton budget de <b>${esc(v.budget)} € par semaine</b>`]) +
        P("Rien à faire si tu continues.") +
        small(MANAGE_URL.startsWith("http") ? `Pour gérer ou résilier : <a href="${esc(MANAGE_URL)}" style="color:#3d4a44">ton espace abonnement</a>. Tu peux aussi répondre à ce mail.` : "Pour résilier, réponds simplement à ce mail, je m'en occupe.") + sign;
      cta = "Voir ma liste de la semaine";
      to = LISTE;
      break;
    case "B5": {
      const b = v.b5;
      if (!b) return null;
      subject = b.subject;
      body = P(hi) + b.text.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean).map((x) => P(esc(x).replace(/\n/g, "<br>"))).join("") + sign;
      cta = b.cta;
      to = b.to + (b.to.includes("?") ? "&" : "?") + utm("B5");
      break;
    }
    // ---------- C: cancelled
    case "C1":
      subject = "Qu'est-ce qui n'a pas marché ?";
      body = P(`${v.prenom ? esc(v.prenom) + ", u" : "U"}ne seule question : pourquoi tu as arrêté ?`) + P("Réponds en 1 phrase, je lis tout.") + sign;
      break;
    default:
      return null;
  }
  const url = cta ? go(to) : "";
  const btn = cta ? `<p style="margin:22px 0"><a href="${url}" style="background:#0f8a5f;color:#ffffff;text-decoration:none;padding:14px 24px;border-radius:99px;font-weight:700;display:inline-block;font-size:16px">${esc(cta)}</a></p>` : "";
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:20px 16px;color:#1b2420;font-size:16px">${body}${btn}__FOOT__</div>`;
  const text = body.replace(/<\/(p|li|tr)>/g, "\n").replace(/<br\s*\/?>/g, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\n{3,}/g, "\n\n").trim() + (cta ? `\n\n${cta} : ${url}` : "");
  return { subject, html, text, tx };
}

async function deliver(to: string, userId: string, mail: Mail, tag = ""): Promise<void> {
  let foot: string, textFoot: string, headers: Record<string, string> = {};
  if (mail.tx) {
    foot = `<p style="font-size:12px;color:#5b6660;line-height:1.5;margin:0">${esc(SENDER_LINE)}<br>E-mail lié à ton abonnement mangereco.</p>`;
    textFoot = `\n\n--\n${SENDER_LINE}`;
  } else {
    const unsub = `${SUPABASE_URL}/functions/v1/unsubscribe?u=${userId}&t=${await hmac(userId)}`;
    foot = `<p style="font-size:12px;color:#5b6660;line-height:1.5;margin:0">${esc(SENDER_LINE)}<br>Tu reçois cet e-mail parce que tu as un compte sur mangereco.com. <a href="${unsub}" style="color:#5b6660">Me désinscrire</a></p>`;
    textFoot = `\n\n--\n${SENDER_LINE}\nSe désinscrire : ${unsub}`;
    headers = { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
  }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: MAIL_FROM, to: [to], subject: tag + mail.subject, reply_to: ADMIN, headers,
      html: mail.html.replace("__FOOT__", `<hr style="border:none;border-top:1px solid #e3e8e5;margin:24px 0 12px">${foot}`),
      text: mail.text + textFoot,
    }),
  });
  if (!r.ok) throw new Error(`resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
  await sleep(550); // Resend allows 2 requests per second
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const out = { sent: [] as string[], errors: [] as string[], remaining: 0 };
  const json = (status = 200) => new Response(JSON.stringify(out), { status, headers: { ...CORS, "Content-Type": "application/json" } });
  const deny = (msg: string, status: number) => new Response(msg, { status, headers: CORS });
  if (!RESEND_API_KEY || !UNSUB_SECRET) return deny("missing secrets", 500);
  const sb = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

  // who is calling: the cron (secret) or the admin from the site (Supabase session)
  let admin = false;
  const cron = !!CRON_SECRET && req.headers.get("x-cron-secret") === CRON_SECRET;
  if (!cron) {
    const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (jwt) { const { data } = await sb.auth.getUser(jwt); admin = (data?.user?.email ?? "").toLowerCase() === ADMIN; }
    if (!admin) return deny("forbidden", 403);
  }
  const url = new URL(req.url);
  const now = Date.now();
  const pt = paris();

  const { count: founders, error: fe } = await sb.from("subscriptions").select("user_id", { count: "exact", head: true }).or("plan_kind.eq.life,founder.eq.true");
  // -1 = count unavailable: the founder pack stays offered, without a number ("Places limitées à 20")
  const places = fe || founders === null ? -1 : Math.max(0, FOUNDER_CAP - founders);

  const info = (p: any): V => {
    const D = (p && p.data && p.data.D) || {};
    const first = String(D.prenom || "").trim().split(/\s+/)[0];
    return {
      prenom: first ? first.charAt(0).toUpperCase() + first.slice(1) : "", goal: D.goal || "", budget: String(D.budget || "25"),
      meals: +D.meals || 0, places, weekCost: p && p.week_cost ? +p.week_cost : null, plans: 1, renouv: "", price: "", week: pt.week,
    };
  };
  const tracker = async (uid: string, claim: string): Promise<Go> => {
    const t = await hmac(`${uid}|${claim}`);
    return (path) => `${SUPABASE_URL}/functions/v1/unsubscribe?c=${encodeURIComponent(claim)}&u=${uid}&t=${t}&to=${encodeURIComponent(path)}`;
  };

  // ---- mail log, preloaded per batch of users
  const log = new Map<string, any>();
  async function loadLog(ids: string[]) {
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error } = await sb.from("mail_log").select("user_id,mail_key,status,attempts,updated_at").in("user_id", ids.slice(i, i + 100));
      if (error) throw new Error("mail_log: " + error.message);
      (data ?? []).forEach((r: any) => log.set(`${r.user_id}|${r.mail_key}`, r));
    }
  }
  const sentCount = (uid: string, prefix: string) => { let n = 0; for (const [k, r] of log) if (k.startsWith(`${uid}|${prefix}`) && r.status === "sent") n++; return n; };
  const retryable = (r: any) => r.status === "failed" && (r.attempts ?? 1) < MAX_ATTEMPTS && now - new Date(r.updated_at).getTime() >= ((r.attempts ?? 1) <= 1 ? 5 : 30) * MIN;

  let budgetLeft = MAX_PER_RUN;
  // claim (user, mail) in mail_log, send, then record the result
  async function once(p: any, key: string, v: V, claim = key) {
    if (budgetLeft <= 0 || !p.email) return;
    const id = `${p.user_id}|${claim}`, prev = log.get(id);
    if (prev && !retryable(prev)) return;
    const m = build(key, v, await tracker(p.user_id, claim));
    if (!m || (p.email_unsub && !m.tx)) return;
    const stamp = new Date().toISOString();
    if (!prev) {
      const { error } = await sb.from("mail_log").insert({ user_id: p.user_id, mail_key: claim, status: "pending", attempts: 1, updated_at: stamp });
      if (error) { if ((error as any).code !== "23505") out.errors.push(`log ${claim}: ${error.message}`); return; }
    } else {
      const { data, error } = await sb.from("mail_log").update({ status: "pending", attempts: prev.attempts + 1, updated_at: stamp })
        .eq("user_id", p.user_id).eq("mail_key", claim).eq("status", "failed").eq("attempts", prev.attempts).select("user_id");
      if (error || !data || !data.length) return; // another run took it
    }
    log.set(id, { status: "pending", attempts: (prev?.attempts ?? 0) + 1, updated_at: stamp });
    budgetLeft--;
    try {
      await deliver(p.email, p.user_id, m);
      await sb.from("mail_log").update({ status: "sent", sent_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_error: null }).eq("user_id", p.user_id).eq("mail_key", claim);
      log.get(id).status = "sent";
      out.sent.push(claim);
    } catch (e) {
      const err = String(e).slice(0, 300);
      await sb.from("mail_log").update({ status: "failed", last_error: err, updated_at: new Date().toISOString() }).eq("user_id", p.user_id).eq("mail_key", claim);
      out.errors.push(`${claim}: ${err}`);
    }
  }
  const PCOLS = "user_id,email,data,created_at,email_optin,email_unsub,paywall_seen_at,list_opened_at,week_cost";
  async function profilesFor(ids: string[]) {
    const m = new Map<string, any>();
    for (let i = 0; i < ids.length; i += 100) {
      const { data } = await sb.from("profiles").select(PCOLS).in("user_id", ids.slice(i, i + 100));
      (data ?? []).forEach((p: any) => m.set(p.user_id, p));
    }
    return m;
  }
  const adminProfile = async () => {
    const { data } = await sb.from("profiles").select(PCOLS).ilike("email", ADMIN).limit(1);
    return data && data[0] ? data[0] : { user_id: "00000000-0000-0000-0000-000000000000", email: ADMIN, data: null };
  };
  // test sends are logged as T-<key> (not counted in the stats) so that the click tracking can be checked
  async function sendTest(key: string, v: V) {
    const me = await adminProfile();
    const claim = `T-${key}`;
    const m = build(key, v, await tracker(me.user_id, claim));
    if (!m) { out.errors.push(`${key}: rien à envoyer (mail inconnu, ou offre fondateur fermée pour F1)`); return; }
    try {
      await deliver(ADMIN, me.user_id, m, `[TEST ${key}] `);
      if (me.data !== null) await sb.from("mail_log").upsert({ user_id: me.user_id, mail_key: claim, status: "sent", attempts: 1, sent_at: new Date().toISOString(), updated_at: new Date().toISOString(), clicked_at: null, last_error: null });
      out.sent.push(key);
    } catch (e) { out.errors.push(`${key}: ${String(e).slice(0, 200)}`); }
  }

  // ---- B5 broadcast (manual)
  if (url.searchParams.has("broadcast")) {
    if (req.method !== "POST") return deny("POST only", 405);
    const b = await req.json().catch(() => ({}));
    const slug = String(b.slug ?? "").trim(), subject = String(b.subject ?? "").trim(), text = String(b.text ?? "").trim();
    const cta = String(b.cta ?? "").trim() || "Voir sur mangereco", to = String(b.to ?? "/").trim() || "/";
    if (!/^[a-z0-9-]{3,40}$/.test(slug)) return deny("slug : 3 à 40 caractères, a-z, 0-9 et tirets", 400);
    if (!subject || subject.length > 120 || !text || text.length > 4000 || cta.length > 40) return deny("objet (120 max), texte (4000 max) et bouton (40 max) requis", 400);
    if (!/^\/(?![\/\\])[^\s]*$/.test(to)) return deny("le lien doit être un chemin du site, ex. / ou /?voir=liste", 400);
    const base = info(null);
    base.b5 = { subject, text, cta, to };
    if (b.test !== false) { await sendTest("B5", base); return json(); }
    const claim = `B5-${slug}`;
    let users: any[] = [];
    if (b.audience === "inscrits") {
      const { data } = await sb.from("profiles").select(PCOLS).eq("email_unsub", false).order("created_at", { ascending: true }).limit(2000);
      users = data ?? [];
      const cust = new Set<string>();
      const { data: subs } = await sb.from("subscriptions").select("user_id").or("unlocked.eq.true,paid_at.not.is.null").limit(2000);
      (subs ?? []).forEach((s: any) => cust.add(s.user_id));
      users = users.filter((p) => p.email_optin === true || !REQUIRE_OPTIN || cust.has(p.user_id));
    } else {
      const { data: act } = await sb.from("subscriptions").select("user_id").eq("unlocked", true).limit(2000);
      const pm = await profilesFor((act ?? []).map((s: any) => s.user_id));
      users = [...pm.values()].filter((p) => !p.email_unsub);
    }
    await loadLog(users.map((p) => p.user_id));
    budgetLeft = MAX_BROADCAST;
    for (const p of users) { const v = info(p); v.b5 = base.b5; await once(p, "B5", v, claim); }
    out.remaining = users.filter((p) => { const r = log.get(`${p.user_id}|${claim}`); return p.email && (!r || retryable(r)); }).length;
    return json();
  }

  // ---- test mode: templates to the admin address
  const test = url.searchParams.get("test");
  if (test !== null) {
    if (test !== "1" && test.toLowerCase() !== ADMIN) return deny("use ?test=1", 400);
    const me = await adminProfile();
    const v = info(me);
    v.renouv = fmtDate(new Date(now + 7 * DAY).toISOString()); v.price = "9,99 €/mois"; v.plans = 5;
    const only = url.searchParams.get("only");
    const keys = only ? [only.toUpperCase()] : ["A1", "A2", "A3", "A4", "F1", "B1", "B2", "B3", "B4", "C1"];
    for (const k of keys) await sendTest(k, v);
    return json();
  }
  if (!cron) return deny("the admin can only send tests and broadcasts", 403);

  // ---- A: not paying (accounts created since SEQ_START, in the last 60 days)
  const quiet = pt.hour < 8 || pt.hour >= 21; // no reminder mail at night (Paris)
  const satEvening = pt.wd === "Saturday" && pt.hour >= 18 && pt.hour < 21;
  const { data: recent, error: re } = await sb.from("profiles").select(PCOLS)
    .gt("created_at", SEQ_START).gt("created_at", new Date(now - 60 * DAY).toISOString()).order("created_at", { ascending: true }).limit(1000);
  if (re) out.errors.push("profiles: " + re.message);
  const ids = (recent ?? []).map((p: any) => p.user_id);
  const paid = new Set<string>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data: subs } = await sb.from("subscriptions").select("user_id").in("user_id", ids.slice(i, i + 100)).or("unlocked.eq.true,paid_at.not.is.null");
    (subs ?? []).forEach((s: any) => paid.add(s.user_id));
  }
  await loadLog(ids);
  for (const p of recent ?? []) {
    if (budgetLeft <= 0) break;
    if (paid.has(p.user_id) || p.email_unsub) continue;
    if (!(p.email_optin === true || !REQUIRE_OPTIN)) continue;
    const age = now - new Date(p.paywall_seen_at ?? p.created_at).getTime();
    const v = info(p);
    if (age >= 10 * MIN && age < DAY) await once(p, "A1", v);
    else if (!quiet && age >= DAY && age < 3 * DAY) await once(p, "A2", v);
    else if (!quiet && age >= 3 * DAY && age < 6 * DAY) await once(p, "A3", v);
    else if (satEvening && age >= 6 * DAY && sentCount(p.user_id, "A4-") < A4_MAX) await once(p, "A4", v, `A4-w${pt.week}`);
  }

  // ---- F1: one founder-offer mail to accounts created before SEQ_START (they never entered sequence A)
  if (places !== 0 && budgetLeft > 0 && !quiet) {
    const { data: old } = await sb.from("profiles").select(PCOLS).lte("created_at", SEQ_START).eq("email_unsub", false).order("created_at", { ascending: true }).limit(500);
    const pool = (old ?? []).filter((p: any) => p.email && (p.email_optin === true || !REQUIRE_OPTIN));
    const poolIds = pool.map((p: any) => p.user_id);
    const skip = new Set<string>();
    for (let i = 0; i < poolIds.length; i += 100) {
      const { data: subs } = await sb.from("subscriptions").select("user_id").in("user_id", poolIds.slice(i, i + 100)).or("unlocked.eq.true,paid_at.not.is.null");
      (subs ?? []).forEach((s: any) => skip.add(s.user_id));
    }
    await loadLog(poolIds);
    for (const p of pool) { if (!skip.has(p.user_id)) await once(p, "F1", info(p)); }
  }

  // ---- B: paying customers
  const { data: subsAll, error: se } = await sb.from("subscriptions").select("user_id,unlocked,plan_kind,paid_at,renews_at,canceled_at")
    .or("unlocked.eq.true,canceled_at.not.is.null").limit(2000);
  if (se) out.errors.push("subscriptions: " + se.message);
  const subs = subsAll ?? [];
  const bIds = subs.map((s: any) => s.user_id);
  const pm = await profilesFor(bIds);
  await loadLog(bIds);
  const t = (iso: string | null) => (iso ? new Date(iso).getTime() : 0);
  for (const s of subs) {
    if (budgetLeft <= 0) break;
    const p = pm.get(s.user_id);
    if (!p) continue;
    const v = info(p);
    const since = now - t(s.paid_at);
    if (s.unlocked) {
      // B1 right after payment (paid in the last 24 h)
      if (s.paid_at && since < DAY) await once(p, "B1", v);
      // B2 48 h after payment, only if the list was not opened since
      if (!quiet && s.paid_at && since >= 48 * HOUR && since < 72 * HOUR && t(p.list_opened_at) < t(s.paid_at)) await once(p, "B2", v);
      // B3 every Saturday 18:00 Paris (not to someone who paid in the last 12 h: they just got B1)
      if (satEvening && since >= 12 * HOUR) await once(p, "B3", v, `B3-w${pt.week}`);
      // B4 renewal reminder: D-3 monthly, D-7 annual
      if (!quiet && s.renews_at && ["month", "year", "downsell"].includes(s.plan_kind)) {
        const left = (new Date(`${s.renews_at}T00:00:00+02:00`).getTime() - now) / DAY;
        const lead = s.plan_kind === "month" ? 3 : 7;
        if (left <= lead && left > lead - 2) {
          v.renouv = fmtDate(`${s.renews_at}T12:00:00Z`);
          v.price = s.plan_kind === "month" ? "9,99 €/mois" : s.plan_kind === "downsell" ? "49,99 €/an" : "99 €/an";
          v.plans = sentCount(p.user_id, "B3-") + 1;
          await once(p, "B4", v, `B4-${s.renews_at}`);
        }
      }
    } else if (s.canceled_at) {
      // C1 seven days after the cancellation
      const c = now - t(s.canceled_at);
      if (!quiet && c >= 7 * DAY && c < 10 * DAY) await once(p, "C1", v);
    }
  }
  return json();
});
