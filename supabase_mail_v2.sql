-- Sequences e-mail v2 (A inscrit non payant, B payant, C annulation). A executer dans Supabase > SQL Editor.
alter table public.profiles add column if not exists email_optin boolean default false;
alter table public.profiles add column if not exists email_unsub boolean default false;
alter table public.profiles add column if not exists plan_opened_at timestamptz;

alter table public.subscriptions add column if not exists plan_kind text;
alter table public.subscriptions add column if not exists paid_at timestamptz;
alter table public.subscriptions add column if not exists renews_at date;
alter table public.subscriptions add column if not exists canceled_at timestamptz;

-- Journal des e-mails envoyes : garantit qu'un meme mail n'est jamais envoye deux fois au meme utilisateur.
create table if not exists public.mail_log (
  user_id uuid not null,
  mail_key text not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, mail_key)
);
alter table public.mail_log enable row level security;  -- aucune policy : seule la cle service (fonctions) y accede
