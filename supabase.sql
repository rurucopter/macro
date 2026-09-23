-- macro. : tables et securite (Row Level Security) pour Supabase.
-- A executer une fois dans Supabase > SQL Editor.

-- Profil du funnel (1 ligne par utilisateur connecte)
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  data jsonb,
  updated_at timestamptz default now()
);
alter table public.profiles enable row level security;
create policy "profiles_select_own" on public.profiles for select using (auth.uid() = user_id);
create policy "profiles_insert_own" on public.profiles for insert with check (auth.uid() = user_id);
create policy "profiles_update_own" on public.profiles for update using (auth.uid() = user_id);
create policy "profiles_delete_own" on public.profiles for delete using (auth.uid() = user_id);

-- Evenements du funnel (insertion anonyme uniquement, lecture reservee au service role)
create table if not exists public.events (
  id bigint generated always as identity primary key,
  name text not null,
  props jsonb,
  user_email text,
  created_at timestamptz default now()
);
alter table public.events enable row level security;
create policy "events_insert_anon" on public.events for insert to anon, authenticated with check (true);

-- Statut d'abonnement (paiement Whop). Table separee de "profiles" a dessein :
-- aucune policy insert/update/delete pour anon/authenticated ci-dessous, donc un
-- utilisateur ne peut PAS se debloquer lui-meme via l'API REST. Seule la Edge
-- Function whop-webhook (avec la service_role key, qui contourne RLS) peut ecrire ici.
create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  unlocked boolean not null default false,
  plan text,
  whop_payment_id text,
  updated_at timestamptz default now()
);
alter table public.subscriptions enable row level security;
create policy "subscriptions_select_own" on public.subscriptions for select using (auth.uid() = user_id);

-- Fonction utilisee par la Edge Function whop-webhook pour retrouver le user_id
-- Supabase Auth a partir de l'email envoye par Whop (auth.users n'est pas requetable
-- directement via l'API REST). security definer = s'execute avec les droits du
-- proprietaire (peut lire auth.users), mais ne fait que retourner un id, rien de sensible.
create or replace function public.get_user_id_by_email(p_email text)
returns uuid
language sql
security definer
set search_path = public
as $$
  select id from auth.users where email = p_email limit 1;
$$;

-- Reglages a faire dans le dashboard :
--  Authentication > Providers > Google : activer et renseigner Client ID / Secret (Google Cloud Console)
--  Authentication > URL Configuration : Site URL et Redirect URLs = https://mangereco.com
--  Puis renseigner supabaseUrl et supabaseKey (anon) dans MACRO_CFG (index.html).
--
-- Paiement Whop (deblocage reel apres paiement, voir supabase/functions/whop-webhook) :
--  1. Deployer la fonction : supabase functions deploy whop-webhook
--  2. Secrets de la fonction (Supabase Dashboard > Edge Functions > whop-webhook > Secrets,
--     ou `supabase secrets set`) : WHOP_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
--     (les deux derniers sont deja fournis automatiquement par Supabase a la fonction)
--  3. Dans Whop (dashboard > Developer > Webhooks) : creer un webhook pointant vers
--     https://<project-ref>.supabase.co/functions/v1/whop-webhook, evenement "payment.succeeded",
--     copier le secret ws_... genere dans WHOP_WEBHOOK_SECRET (etape 2)
--  4. Tester avec la fonction "Send test event" de Whop avant d'aller en prod.
