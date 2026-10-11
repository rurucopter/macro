-- mangereco : liens créateurs / parrainage + stats en temps réel
-- À coller UNE fois dans Supabase -> SQL Editor -> Run.

-- 1) le code de parrainage avec lequel chaque compte est arrivé
alter table public.profiles add column if not exists ref text;
create index if not exists profiles_ref_idx on public.profiles (ref);

-- 2) les créateurs : code public (dans le lien) + clé privée (pour leur page de stats)
create table if not exists public.creators (
  code text primary key check (code ~ '^[a-z0-9_-]{3,24}$'),
  name text not null,
  secret text not null unique default md5(random()::text || clock_timestamp()::text),
  created_at timestamptz not null default now()
);
alter table public.creators enable row level security; -- aucune lecture directe : seulement via les fonctions ci-dessous

-- 3) stats d'un créateur (appelée par sa page, avec sa clé privée). Aucune donnée personnelle renvoyée.
create or replace function public.creator_stats(p_secret text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'code', c.code, 'name', c.name,
    'visits', (select count(distinct props->>'vid') from events where name = 'ref_visit' and lower(props->>'ref') = c.code),
    'signups', (select count(*) from profiles p where p.ref = c.code),
    'paid', (select count(*) from profiles p join subscriptions s using (user_id)
             where p.ref = c.code and s.paid_at is not null and coalesce(s.plan_kind, '') <> 'gift'),
    'paid_life', (select count(*) from profiles p join subscriptions s using (user_id)
             where p.ref = c.code and s.paid_at is not null and (s.plan_kind = 'life' or s.founder)),
    'paid_month', (select count(*) from profiles p join subscriptions s using (user_id)
             where p.ref = c.code and s.paid_at is not null and s.plan_kind = 'month'),
    'active', (select count(*) from profiles p join subscriptions s using (user_id)
             where p.ref = c.code and s.unlocked and coalesce(s.plan_kind, '') <> 'gift'),
    'recent', (select coalesce(jsonb_agg(x order by x->>'at' desc), '[]'::jsonb) from (
             select jsonb_build_object('at', s.paid_at, 'kind', coalesce(s.plan_kind, '?')) as x
             from profiles p join subscriptions s using (user_id)
             where p.ref = c.code and s.paid_at is not null and coalesce(s.plan_kind, '') <> 'gift'
             order by s.paid_at desc limit 20) r)
  ) from creators c where c.secret = p_secret
$$;
revoke all on function public.creator_stats(text) from public;
grant execute on function public.creator_stats(text) to anon, authenticated;

-- 4) vue d'ensemble de tous les créateurs, réservée à l'admin
create or replace function public.admin_creators()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if lower(coalesce(auth.jwt() ->> 'email', '')) <> 'arthurdemortiere15@gmail.com' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return (select coalesce(jsonb_agg(public.creator_stats(c.secret) || jsonb_build_object('secret', c.secret) order by c.created_at), '[]'::jsonb) from creators c);
end $$;
revoke all on function public.admin_creators() from public;
grant execute on function public.admin_creators() to authenticated;

-- 5) ajouter un créateur (exemple : remplace le code et le nom, relance pour chaque créateur)
-- insert into public.creators (code, name) values ('antoine', 'Antoine');
