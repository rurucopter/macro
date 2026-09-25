-- E-mails automatiques (bienvenue + relance 10 min). A executer dans Supabase > SQL Editor (projet mangereco).
alter table public.profiles add column if not exists email_optin boolean default false;
alter table public.profiles add column if not exists email_unsub boolean default false;
alter table public.profiles add column if not exists welcome_sent_at timestamptz;
alter table public.profiles add column if not exists relance_sent_at timestamptz;

-- Les comptes deja existants ne recevront rien : on les marque comme deja traites.
update public.profiles set welcome_sent_at = now(), relance_sent_at = now() where welcome_sent_at is null;

-- Un utilisateur peut cocher/decocher sa propre case de consentement (via l'upsert de son profil : deja permis par la policy existante).
