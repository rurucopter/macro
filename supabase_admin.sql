-- Tableau de bord admin (reserve a arthurdemortiere15@gmail.com).
-- A executer dans Supabase > SQL Editor (projet mangereco), a chaque mise a jour de ce fichier.
-- Le controle d'acces est ici, cote base : la fonction leve une erreur pour tout autre
-- e-mail, meme si quelqu'un appelle l'API directement.
-- Prerequis : supabase.sql, supabase_mail_v2.sql et supabase_emails.sql deja executes.

alter table public.profiles add column if not exists created_at timestamptz default now();
create index if not exists events_created_idx on public.events (created_at);
create index if not exists events_name_idx on public.events (name);
create index if not exists mail_log_sent_idx on public.mail_log (sent_at);

create or replace function public.admin_stats(p_days int default 30)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  tz constant text := 'Europe/Paris';
  since timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 365)));
  today date := (now() at time zone 'Europe/Paris')::date;
  res jsonb;
begin
  if lower(coalesce(auth.jwt() ->> 'email', '')) <> 'arthurdemortiere15@gmail.com' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'since', since,
    'today', today,
    'totals', jsonb_build_object(
      'visitors', (select count(distinct props->>'vid') from events where created_at >= since),
      'sessions', (select count(distinct props->>'sid') from events where created_at >= since),
      'returning', (select count(*) from (select props->>'vid' from events where created_at >= since
                     group by 1 having count(distinct props->>'sid') > 1) r),
      'users', (select count(*) from profiles),
      'new_users', (select count(*) from profiles where created_at >= since),
      'new_users_today', (select count(*) from profiles where (created_at at time zone tz)::date = today),
      'optin', (select count(*) from profiles where email_optin),
      'unsub', (select count(*) from profiles where email_unsub),
      'plan_opened', (select count(*) from profiles where plan_opened_at is not null),
      'unlocked', (select count(*) from subscriptions where unlocked),
      'founders', (select count(*) from subscriptions where founder or plan_kind = 'life'),
      'canceled', (select count(*) from subscriptions where canceled_at is not null),
      'paid_period', (select count(*) from subscriptions where paid_at >= since),
      'mails_period', (select count(*) from mail_log where sent_at >= since),
      'mails_today', (select count(*) from mail_log where (sent_at at time zone tz)::date = today),
      'mails_all', (select count(*) from mail_log),
      'mail_recipients', (select count(distinct user_id) from mail_log where sent_at >= since)
    ),

    -- Argent : une ligne par formule. paid_at = dernier paiement connu (ecrase au renouvellement).
    'subs', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select coalesce(plan_kind, case when founder then 'life' else '?' end) as kind,
             count(*) filter (where unlocked) as active,
             count(*) as total,
             count(*) filter (where canceled_at is not null) as canceled,
             count(*) filter (where paid_at >= since) as new_period
      from subscriptions where paid_at is not null or unlocked group by 1 order by active desc) x),
    'paid_daily', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select (paid_at at time zone tz)::date as day, coalesce(plan_kind, '?') as kind, count(*) as n
      from subscriptions where paid_at >= since group by 1, 2 order by 1) x),
    'pay_delay_days', (select round(percentile_cont(0.5) within group (order by extract(epoch from s.paid_at - p.created_at) / 86400)::numeric, 1)
      from subscriptions s join profiles p using (user_id)
      where s.paid_at is not null and p.created_at is not null and s.paid_at >= p.created_at),

    -- E-mails (journal mail_log ; B2 est cle par semaine : B2-AAAA-MM-JJ)
    'mails_daily', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select (sent_at at time zone tz)::date as day, split_part(mail_key, '-', 1) as k, count(*) as n
      from mail_log where sent_at >= since group by 1, 2 order by 1, 2) x),
    'mails_keys', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select split_part(m.mail_key, '-', 1) as k,
             count(*) as total,
             count(*) filter (where m.sent_at >= since) as period,
             max(m.sent_at) as last,
             count(*) filter (where s.paid_at > m.sent_at and s.paid_at <= m.sent_at + interval '7 days') as paid_7d
      from mail_log m left join subscriptions s on s.user_id = m.user_id
      group by 1 order by 1) x),
    'mails_recent', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select m.sent_at, m.mail_key as k, p.email
      from mail_log m left join profiles p on p.user_id = m.user_id
      order by m.sent_at desc limit 60) x),

    -- Trafic et parcours
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
      select (created_at at time zone tz)::date as day,
             count(distinct props->>'vid') as visitors,
             count(distinct props->>'vid') filter (where name = 'funnel_start') as starts,
             count(distinct props->>'vid') filter (where name = 'onboarding_done') as done,
             count(distinct props->>'vid') filter (where name = 'signup_completed') as signups,
             count(distinct props->>'vid') filter (where name = 'paywall_view') as paywalls,
             count(distinct props->>'vid') filter (where name = 'checkout_click') as checkouts
      from events where created_at >= since group by 1 order by 1) x),
    'signups_daily', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select (created_at at time zone tz)::date as day, count(*) as n, count(*) filter (where email_optin) as optin
      from profiles where created_at >= since group by 1 order by 1) x),
    -- Acquisition : premiere visite de la landing de chaque visiteur, puis ce qu'il a fait ensuite.
    'acq', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      with ft as (
        select distinct on (props->>'vid') props->>'vid' as vid,
               coalesce(nullif(props->>'ref', ''), 'direct') as source,
               coalesce(props->>'dev', '?') as dev,
               coalesce(nullif(props->>'camp', ''), '') as camp
        from events where name = 'page_view' and props->>'page' = 'landing' and created_at >= since
        order by props->>'vid', created_at),
      acts as (
        select props->>'vid' as vid,
               bool_or(name = 'funnel_start') as st, bool_or(name = 'onboarding_done') as dn,
               bool_or(name in ('signup_completed', 'signup')) as su,
               bool_or(name = 'paywall_view') as pw, bool_or(name = 'checkout_click') as co
        from events where created_at >= since group by 1)
      select ft.source, ft.dev, ft.camp, count(*) as visitors,
             count(*) filter (where a.st) as starts, count(*) filter (where a.dn) as done,
             count(*) filter (where a.su) as signups, count(*) filter (where a.pw) as paywalls,
             count(*) filter (where a.co) as checkouts
      from ft left join acts a using (vid) group by 1, 2, 3 order by visitors desc limit 300) x),
    'sources', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select coalesce(nullif(props->>'ref', ''), 'direct') as source, count(distinct props->>'vid') as visitors
      from events where name = 'page_view' and props->>'page' = 'landing' and created_at >= since
      group by 1 order by visitors desc limit 15) x),
    'devices', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select coalesce(props->>'dev', '?') as device, count(distinct props->>'vid') as visitors
      from events where name = 'page_view' and props->>'page' = 'landing' and created_at >= since
      group by 1 order by visitors desc) x),
    'hours', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select extract(hour from created_at at time zone tz)::int as h, count(distinct props->>'vid') as visitors
      from events where name = 'page_view' and props->>'page' = 'landing' and created_at >= since group by 1 order by 1) x),
    'weekdays', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select extract(isodow from created_at at time zone tz)::int as d, count(distinct props->>'vid') as visitors
      from events where name = 'page_view' and props->>'page' = 'landing' and created_at >= since group by 1 order by 1) x),
    'timing', (select jsonb_build_object(
        'signup_min', round((percentile_cont(0.5) within group (order by extract(epoch from su - f) / 60) filter (where su > f))::numeric, 1),
        'funnel_min', round((percentile_cont(0.5) within group (order by extract(epoch from dn - fs) / 60) filter (where dn > fs))::numeric, 1))
      from (select min(created_at) as f,
                   min(created_at) filter (where name = 'funnel_start') as fs,
                   min(created_at) filter (where name = 'onboarding_done') as dn,
                   min(created_at) filter (where name in ('signup_completed', 'signup')) as su
            from events where created_at >= since group by props->>'vid') t),
    'plan_select', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select coalesce(props->>'plan', '?') as k, count(distinct props->>'vid') as n
      from events where name = 'plan_select' and created_at >= since group by 1 order by n desc) x),
    'checkout_plans', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select coalesce(props->>'plan', '?') as k, count(distinct props->>'vid') as n
      from events where name = 'checkout_click' and created_at >= since group by 1 order by n desc) x),

    -- Profils
    'goals', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select coalesce(data->'D'->>'goal', '?') as k, count(*) as n from profiles group by 1 order by n desc) x),
    'gyms', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select coalesce(data->'D'->>'gym', '?') as k, count(*) as n from profiles group by 1 order by n desc limit 10) x),
    'stores', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select coalesce(data->'D'->>'store', '?') as k, count(*) as n from profiles group by 1 order by n desc limit 10) x),
    'diets', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select coalesce(data->'D'->>'diet', '?') as k, count(*) as n from profiles group by 1 order by n desc limit 10) x),
    'genders', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select coalesce(data->'D'->>'gender', data->>'g', '?') as k, count(*) as n from profiles group by 1 order by n desc) x),
    'ages', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select case when a is null then '?' when a < 18 then 'Moins de 18' when a <= 21 then '18-21' when a <= 25 then '22-25'
                  when a <= 30 then '26-30' else '31 et +' end as k, count(*) as n
      from (select case when data->'D'->>'age' ~ '^[0-9]{1,3}$' then (data->'D'->>'age')::int end as a from profiles) p
      group by 1 order by min(coalesce(a, 999))) x),
    'budgets', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select case when b is null then '?' when b < 25 then 'Moins de 25 €' when b < 35 then '25-34 €' when b < 45 then '35-44 €'
                  when b < 60 then '45-59 €' else '60 € et +' end as k, count(*) as n
      from (select case when data->'D'->>'budget' ~ '^[0-9]{1,4}$' then (data->'D'->>'budget')::int end as b from profiles) p
      group by 1 order by min(coalesce(b, 99999))) x),
    'budget_avg', (select round(avg(case when data->'D'->>'budget' ~ '^[0-9]{1,4}$' then (data->'D'->>'budget')::numeric end), 1) from profiles),
    'recent', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select p.email, p.created_at, p.data->>'status' as status,
             coalesce(s.unlocked, false) as paid, s.plan_kind,
             coalesce(p.email_optin, false) as optin, coalesce(p.email_unsub, false) as unsub,
             p.plan_opened_at is not null as opened,
             (select count(*) from mail_log m where m.user_id = p.user_id) as mails,
             (select m.mail_key from mail_log m where m.user_id = p.user_id order by m.sent_at desc limit 1) as last_mail,
             p.data->'D'->>'prenom' as prenom, p.data->'D'->>'goal' as goal, p.data->'D'->>'budget' as budget,
             p.data->'D'->>'gym' as gym, p.data->'D'->>'store' as store
      from profiles p left join subscriptions s on s.user_id = p.user_id
      order by p.created_at desc nulls last limit 150) x)
  ) into res;

  return res;
end;
$$;

revoke execute on function public.admin_stats(int) from public, anon;
grant execute on function public.admin_stats(int) to authenticated;
