-- Coaching avec Arthur (vendu avec le plan a vie a 59,99 EUR). La table coaching_requests existe deja.
-- A coller dans Supabase > SQL Editor : "paye" = paiement a vie recu apres la demande de coaching.
create or replace function public.admin_coaching()
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare res jsonb;
begin
  if lower(coalesce(auth.jwt() ->> 'email', '')) <> 'arthurdemortiere15@gmail.com' then raise exception 'forbidden' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(x order by x.paid_at desc nulls last, x.created_at desc), '[]'::jsonb) into res from (
    select c.user_id, c.prenom, c.phone, c.slot, c.created_at, c.called_at, p.email,
           case when (s.plan_kind = 'life' or s.founder) and s.paid_at >= c.created_at then s.paid_at end as paid_at
    from coaching_requests c
    left join profiles p on p.user_id = c.user_id
    left join subscriptions s on s.user_id = c.user_id) x;
  return res;
end $$;
revoke all on function public.admin_coaching() from public, anon;
grant execute on function public.admin_coaching() to authenticated;
