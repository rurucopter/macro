-- Sequences e-mail v3 (A non-payeurs, B abonnes, suivi des clics). A executer dans Supabase > SQL Editor,
-- puis re-executer supabase_admin.sql. Sans danger si on le relance.

-- Ce que le site enregistre pour declencher les bons mails
alter table public.profiles add column if not exists paywall_seen_at timestamptz;  -- 1re fois que l'ecran de paiement s'affiche
alter table public.profiles add column if not exists list_opened_at timestamptz;   -- derniere fois que l'abonne a vu sa liste de courses
alter table public.profiles add column if not exists week_cost numeric;            -- cout estime de sa derniere liste (mail de renouvellement)

-- Journal des mails : statut, tentatives, erreur, clic
alter table public.mail_log add column if not exists status text not null default 'sent';  -- pending | sent | failed
alter table public.mail_log add column if not exists attempts int not null default 1;
alter table public.mail_log add column if not exists last_error text;
alter table public.mail_log add column if not exists updated_at timestamptz not null default now();
alter table public.mail_log add column if not exists clicked_at timestamptz;
create index if not exists mail_log_clicked_idx on public.mail_log (user_id, clicked_at) where clicked_at is not null;
