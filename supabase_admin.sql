-- Tableau de bord admin (reserve a arthurdemortiere15@gmail.com).
-- A executer une fois dans Supabase > SQL Editor (projet mangereco).
-- Le controle d'acces est ici, cote base : la fonction leve une erreur pour tout autre
-- e-mail, meme si quelqu'un appelle l'API directement.

alter table public.profiles add column if not exists created_at timestamptz default now();
create index if not exists events_created_idx on public.events (created_at);
create index if not exists events_name_idx on public.events (name);

create or replace function public.admin_stats(p_days int default 30)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  since timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 365)));
  res jsonb;
begin
  if lower(coalesce(auth.jwt() ->> 'email', '')) <> 'arthurdemortiere15@gmail.com' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'since', since,
    'totals', jsonb_build_object(
      'visitors', (select count(distinct props->>'vid') from events where created_at >= since),
      'sessions', (select count(distinct props->>'sid') from events where created_at >= since),
      'users', (select count(*) from profiles),
      'new_users', (select count(*) from profiles where created_at >= since),
      'unlocked', (select count(*) from subscriptions where unlocked),
      'founders', (select count(*) from subscriptions where founder)
    ),
    'events', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select name, count(*) as n, count(distinct props->>'vid') as visitors
      from events where created_at >= since group by name order by n desc) x),
    'pages', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select props->>'page' as page, count(*) as views, count(distinct props->>'vid') as visitors
      from events where name = 'page_view' and created_at >= since group by 1 order by visitors desc) x),
    'steps', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select case when props->>'idx' ~ '^[0-9]{1,2}$' then (props->>'idx')::int end as idx,
             props->>'id' as id, count(*) as views, count(distinct props->>'vid') as visitors
      from events where name = 'step_view' and created_at >= since group by 1, 2 order by 1) x),
    'daily', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select created_at::date as day,
             count(distinct props->>'vid') as visitors,
             count(distinct props->>'vid') filter (where name = 'funnel_start') as starts,
             count(distinct props->>'vid') filter (where name = 'signup_completed') as signups,
             count(distinct props->>'vid') filter (where name = 'checkout_click') as checkouts
      from events where created_at >= since group by 1 order by 1) x),
    'sources', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select coalesce(nullif(props->>'ref', ''), 'direct') as source, count(distinct props->>'vid') as visitors
      from events where name = 'page_view' and props->>'page' = 'landing' and created_at >= since
      group by 1 order by visitors desc limit 15) x),
    'devices', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select coalesce(props->>'dev', '?') as device, count(distinct props->>'vid') as visitors
      from events where name = 'page_view' and props->>'page' = 'landing' and created_at >= since
      group by 1 order by visitors desc) x),
    'goals', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select coalesce(data->'D'->>'goal', '?') as k, count(*) as n from profiles group by 1 order by n desc) x),
    'gyms', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select coalesce(data->'D'->>'gym', '?') as k, count(*) as n from profiles group by 1 order by n desc limit 10) x),
    'stores', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select coalesce(data->'D'->>'store', '?') as k, count(*) as n from profiles group by 1 order by n desc limit 10) x),
    'budget_avg', (select round(avg(case when data->'D'->>'budget' ~ '^[0-9]{1,4}$' then (data->'D'->>'budget')::numeric end), 1) from profiles),
    'recent', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select email, created_at, data->>'status' as status,
             coalesce((select bool_or(s.unlocked) from subscriptions s where s.user_id = profiles.user_id), false) as paid,
             coalesce(email_optin, false) as optin, data->'D'->>'prenom' as prenom,
             data->'D'->>'goal' as goal, data->'D'->>'budget' as budget,
             data->'D'->>'gym' as gym, data->'D'->>'store' as store
      from profiles order by created_at desc nulls last limit 100) x)
  ) into res;

  return res;
end;
$$;

revoke execute on function public.admin_stats(int) from public, anon;
grant execute on function public.admin_stats(int) to authenticated;
