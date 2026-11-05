-- Espace revenus de tipsmanger : 40 % des ventes faites avec la version femmes.
-- À coller dans Supabase > SQL Editor > Run (une seule fois).
-- Seuls tipsmanger et le propriétaire peuvent l'appeler. Ventes = comptes payants dont le profil vient du questionnaire femmes (data.D.fem = 1).
create or replace function public.creator_revenue()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  e text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if e not in ('tipsmanger@gmail.com', 'arthurdemortiere15@gmail.com') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'days', (
      select coalesce(jsonb_agg(jsonb_build_object('d', d, 'v', v) order by d), '[]'::jsonb)
      from (
        select (created_at at time zone 'Europe/Paris')::date as d, count(distinct props ->> 'vid') as v
        from events
        where name = 'lp_view' and created_at > now() - interval '30 days'
        group by 1
      ) x
    ),
    'sales', (
      select coalesce(jsonb_agg(jsonb_build_object('at', s.paid_at, 'kind', s.plan_kind, 'active', s.unlocked) order by s.paid_at desc), '[]'::jsonb)
      from subscriptions s
      join profiles p on p.user_id = s.user_id
      where s.paid_at is not null
        and coalesce(s.plan_kind, '') <> 'gift'
        and p.data -> 'D' ->> 'fem' = '1'
        and lower(coalesce(p.email, '')) not in ('arthurdemortiere15@gmail.com', 'tipsmanger@gmail.com')
    )
  );
end;
$$;
revoke all on function public.creator_revenue() from public, anon;
grant execute on function public.creator_revenue() to authenticated;
