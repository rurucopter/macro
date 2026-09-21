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

-- Reglages a faire dans le dashboard :
--  Authentication > Providers > Google : activer et renseigner Client ID / Secret (Google Cloud Console)
--  Authentication > URL Configuration : Site URL et Redirect URLs = https://macro-deploy-ten.vercel.app
--  Puis renseigner supabaseUrl et supabaseKey (anon) dans MACRO_CFG (index.html).
