-- Blak pattern insights (live, high-confidence). Mines the user's mood check-ins
-- (mood_logs: great/okay/low/anxious/angry + created_at) for a day-of-week mood
-- pattern. Returns one insight + the evidence ('why'), or 'learning' until there's
-- enough data. Nightly deeper-mining is a planned follow-up.
create or replace function public.blak_insights()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  total int;
  overall numeric;
  best record;
  daynames text[] := array['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
begin
  if uid is null then return jsonb_build_object('kind', 'none'); end if;

  select count(*) into total from public.mood_logs
  where user_id = uid and created_at > now() - interval '70 days';
  if total < 6 then return jsonb_build_object('kind', 'learning'); end if;

  select avg(case mood when 'great' then 2 when 'okay' then 1 when 'low' then -1 when 'anxious' then -1 when 'angry' then -2 else 0 end)
  into overall from public.mood_logs
  where user_id = uid and created_at > now() - interval '70 days';

  select * into best from (
    select extract(dow from created_at at time zone 'Asia/Kolkata')::int as dow,
           count(*) as cnt,
           count(*) filter (where mood in ('great','okay')) as good,
           avg(case mood when 'great' then 2 when 'okay' then 1 when 'low' then -1 when 'anxious' then -1 when 'angry' then -2 else 0 end) as sc
    from public.mood_logs
    where user_id = uid and created_at > now() - interval '70 days'
    group by 1
    having count(*) >= 2
    order by 4 desc
    limit 1
  ) t;

  if found and best.sc - overall >= 0.6 and best.sc > 0 then
    return jsonb_build_object(
      'kind', 'mood_day',
      'title', 'You seem happiest on ' || daynames[best.dow + 1] || 's',
      'why', 'You''ve felt good on ' || best.good || ' of your ' || best.cnt || ' recent ' || daynames[best.dow + 1] || 's.'
    );
  end if;

  return jsonb_build_object('kind', 'learning');
end;
$$;
grant execute on function public.blak_insights() to authenticated;
revoke execute on function public.blak_insights() from public;
