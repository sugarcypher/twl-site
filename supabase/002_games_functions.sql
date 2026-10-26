-- Lucid Lux games: the only door into the games schema.
-- Every function: security definer, empty search_path, fully qualified names.

-- ------------------------------------------------------------ helpers (not callable by clients)

create or replace function games.today_id()
returns text language sql stable set search_path = '' as $$
  select 'd' || to_char((now() at time zone 'utc')::date, 'YYYY-MM-DD');
$$;

create or replace function games.valid_name(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_name is not null
     and p_name = split_part(p_name, ' ', 1) || ' ' || split_part(p_name, ' ', 2)
     and exists (select 1 from games.name_words w where w.kind = 'mineral'  and w.word = split_part(p_name, ' ', 1))
     and exists (select 1 from games.name_words w where w.kind = 'creature' and w.word = split_part(p_name, ' ', 2));
$$;

-- Award every TapBoom badge the player's record now supports. Idempotent.
create or replace function games.award(p_player uuid, p_game text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_rounds int; v_days int; v_combo int; v_clean boolean; v_level int; v_finished boolean;
  v_dailies int; v_streak int; v_top10 boolean; v_podium boolean; v_champ boolean;
  v_cands text[] := '{}';
begin
  if p_game <> 'tapboom' then return; end if;

  select count(*) filter (where r.kind in ('round', 'daily')),
         count(distinct (r.created_at at time zone 'utc')::date),
         coalesce(max(r.combo), 0),
         coalesce(bool_or(r.kind in ('round', 'daily') and r.accuracy = 100 and r.correct >= 10), false),
         coalesce(max(r.level), 0),
         coalesce(bool_or(r.kind = 'run' and r.finished), false),
         count(distinct r.round_id) filter (where r.kind = 'daily')
    into v_rounds, v_days, v_combo, v_clean, v_level, v_finished, v_dailies
    from games.runs r
   where r.player_id = p_player and r.game = p_game;

  -- Longest run of consecutive daily-challenge days.
  select coalesce(max(n), 0) into v_streak from (
    select count(*) as n from (
      select d, d - (row_number() over (order by d))::int as grp
        from (select distinct to_date(substr(r.round_id, 2), 'YYYY-MM-DD') as d
                from games.runs r
               where r.player_id = p_player and r.game = p_game and r.kind = 'daily') days
    ) g group by grp
  ) s;

  -- Placement badges need a real field of people, not a field of one.
  select coalesce(bool_or(p.place <= 10 and p.field >= 15), false),
         coalesce(bool_or(p.place <= 3  and p.field >= 5),  false),
         coalesce(bool_or(p.place = 1   and p.field >= 5),  false)
    into v_top10, v_podium, v_champ
    from games.daily_places p
   where p.player_id = p_player and p.game = p_game;

  if v_rounds >= 1   then v_cands := array_append(v_cands, 'tb.first'); end if;
  if v_rounds >= 10  then v_cands := array_append(v_cands, 'tb.ten'); end if;
  if v_rounds >= 100 then v_cands := array_append(v_cands, 'tb.hundred'); end if;
  if v_days >= 3     then v_cands := array_append(v_cands, 'tb.days3'); end if;
  if v_days >= 7     then v_cands := array_append(v_cands, 'tb.days7'); end if;
  if v_days >= 30    then v_cands := array_append(v_cands, 'tb.days30'); end if;
  if v_clean         then v_cands := array_append(v_cands, 'tb.clean'); end if;
  if v_combo >= 15   then v_cands := array_append(v_cands, 'tb.combo15'); end if;
  if v_combo >= 30   then v_cands := array_append(v_cands, 'tb.combo30'); end if;
  if v_level >= 6    then v_cands := array_append(v_cands, 'tb.gate5'); end if;
  if v_level >= 13   then v_cands := array_append(v_cands, 'tb.diamond'); end if;
  if v_level >= 16   then v_cands := array_append(v_cands, 'tb.opal'); end if;
  if v_dailies >= 3  then v_cands := array_append(v_cands, 'tb.daily3'); end if;
  if v_dailies >= 10 then v_cands := array_append(v_cands, 'tb.daily10'); end if;
  if v_streak >= 3   then v_cands := array_append(v_cands, 'tb.streak3'); end if;
  if v_streak >= 7   then v_cands := array_append(v_cands, 'tb.streak7'); end if;
  if v_top10         then v_cands := array_append(v_cands, 'tb.top10'); end if;
  if v_podium        then v_cands := array_append(v_cands, 'tb.podium'); end if;
  if v_champ         then v_cands := array_append(v_cands, 'tb.champion'); end if;
  if v_finished      then v_cands := array_append(v_cands, 'tb.finisher'); end if;

  insert into games.player_badges (player_id, slug)
  select p_player, s from unnest(v_cands) s
  on conflict do nothing;
end $$;

-- Freeze the final standings of every past daily that has not been settled.
create or replace function games.settle_dailies(p_game text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  r record;
begin
  for r in
    select distinct x.round_id
      from games.runs x
     where x.game = p_game and x.kind = 'daily' and x.round_id < games.today_id()
       and not exists (select 1 from games.daily_settled s where s.game = p_game and s.round_id = x.round_id)
     limit 30
  loop
    insert into games.daily_settled (game, round_id) values (p_game, r.round_id) on conflict do nothing;
    if not found then continue; end if;     -- another call is settling it
    insert into games.daily_places (game, round_id, player_id, place, field)
    select p_game, r.round_id, b.player_id,
           row_number() over (order by b.score desc, b.created_at asc),
           count(*) over ()
      from (select distinct on (x.player_id) x.player_id, x.score, x.created_at
              from games.runs x
             where x.game = p_game and x.kind = 'daily' and x.round_id = r.round_id
             order by x.player_id, x.score desc, x.created_at asc) b
    on conflict do nothing;
    perform games.award(dp.player_id, p_game)
       from games.daily_places dp
      where dp.game = p_game and dp.round_id = r.round_id;
  end loop;
end $$;

create or replace function games.me_json(p_uid uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when p.id is null then jsonb_build_object('player', null)
  else jsonb_build_object(
    'player', jsonb_build_object(
      'name', p.name, 'number', p.number, 'age_band', p.age_band,
      'avatar_shape', p.avatar_shape, 'avatar_color', p.avatar_color,
      'research_opt_in', p.research_opt_in, 'created_at', p.created_at),
    'badges', coalesce((select jsonb_agg(b.slug order by b.earned_at)
                          from games.player_badges b where b.player_id = p.id), '[]'::jsonb))
  end
  from (select 1) one
  left join games.players p on p.id = p_uid;
$$;

revoke all on all functions in schema games from public, anon, authenticated;

-- ------------------------------------------------------------ public door

-- Six suggested names. Callable before an account exists.
create or replace function public.ll_name_options(p_count integer default 6)
returns setof text language sql volatile security definer set search_path = '' as $$
  select m.word || ' ' || (select c.word from games.name_words c
                             where c.kind = 'creature' and m.word is not null
                             order by random() limit 1)
    from (select word from games.name_words where kind = 'mineral'
           order by random() limit least(greatest(coalesce(p_count, 6), 1), 12)) m;
$$;

create or replace function public.ll_me()
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then return jsonb_build_object('player', null, 'signed_in', false); end if;
  perform games.settle_dailies('tapboom');
  if exists (select 1 from games.players where id = auth.uid()) then
    perform games.award(auth.uid(), 'tapboom');
  end if;
  return games.me_json(auth.uid()) || jsonb_build_object('signed_in', true);
end $$;

create or replace function public.ll_create_player(p_name text, p_age_band text,
  p_avatar_shape integer default 0, p_avatar_color integer default 0)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'reason', 'signed_out'); end if;
  if not games.valid_name(p_name) then return jsonb_build_object('ok', false, 'reason', 'bad_name'); end if;
  if p_age_band not in ('13-17', '18+') then return jsonb_build_object('ok', false, 'reason', 'bad_age'); end if;
  insert into games.players (id, name, age_band, avatar_shape, avatar_color)
  values (auth.uid(), p_name, p_age_band,
          least(greatest(coalesce(p_avatar_shape, 0), 0), 7),
          least(greatest(coalesce(p_avatar_color, 0), 0), 7))
  on conflict (id) do nothing;
  return jsonb_build_object('ok', true) || games.me_json(auth.uid());
end $$;

create or replace function public.ll_update_player(p_name text default null,
  p_avatar_shape integer default null, p_avatar_color integer default null,
  p_research_opt_in boolean default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'reason', 'signed_out'); end if;
  if p_name is not null and not games.valid_name(p_name) then
    return jsonb_build_object('ok', false, 'reason', 'bad_name');
  end if;
  update games.players set
    name = coalesce(p_name, name),
    avatar_shape = coalesce(least(greatest(p_avatar_shape, 0), 7), avatar_shape),
    avatar_color = coalesce(least(greatest(p_avatar_color, 0), 7), avatar_color),
    research_opt_in = coalesce(p_research_opt_in, research_opt_in),
    research_opt_in_at = case when p_research_opt_in is null then research_opt_in_at
                              when p_research_opt_in then now() else null end,
    updated_at = now()
  where id = auth.uid();
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_profile'); end if;
  return jsonb_build_object('ok', true) || games.me_json(auth.uid());
end $$;

create or replace function public.ll_save_get(p_game text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select jsonb_build_object('state', s.state, 'rev', s.rev, 'updated_at', s.updated_at)
       from games.saves s where s.player_id = auth.uid() and s.game = p_game),
    jsonb_build_object('state', null, 'rev', 0));
$$;

-- Optimistic save: succeeds only if the caller saw the latest revision.
-- On a conflict the current copy comes back so the client can choose.
create or replace function public.ll_save_put(p_game text, p_state jsonb, p_base_rev integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_rev int;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'reason', 'signed_out'); end if;
  if not exists (select 1 from games.players where id = auth.uid()) then
    return jsonb_build_object('ok', false, 'reason', 'no_profile');
  end if;
  if not exists (select 1 from games.catalog where game = p_game) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_game');
  end if;
  if p_state is null or jsonb_typeof(p_state) <> 'object' or pg_column_size(p_state) >= 98304 then
    return jsonb_build_object('ok', false, 'reason', 'bad_state');
  end if;
  select rev into v_rev from games.saves where player_id = auth.uid() and game = p_game for update;
  if v_rev is null then
    insert into games.saves (player_id, game, state, rev) values (auth.uid(), p_game, p_state, 1);
    return jsonb_build_object('ok', true, 'rev', 1);
  end if;
  if coalesce(p_base_rev, -1) <> v_rev then
    return jsonb_build_object('ok', false, 'reason', 'conflict') || public.ll_save_get(p_game);
  end if;
  update games.saves set state = p_state, rev = v_rev + 1, updated_at = now()
   where player_id = auth.uid() and game = p_game;
  return jsonb_build_object('ok', true, 'rev', v_rev + 1);
end $$;

-- Record a finished daily, campaign round or whole run. Plausibility ceilings
-- stop casual forgery; they are not proof. Replay checking comes with leagues.
create or replace function public.ll_submit_run(p_game text, p_kind text, p_round_id text,
  p_score integer, p_accuracy integer, p_combo integer, p_level integer,
  p_correct integer, p_wrong integer, p_duration_ms integer,
  p_finished boolean default false, p_version text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_secs numeric := greatest(coalesce(p_duration_ms, 0), 0) / 1000.0;
  v_gap interval;
  v_last timestamptz;
  v_today date := (now() at time zone 'utc')::date;
  v_exp int;
  v_round text := p_round_id;
  v_id bigint;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'reason', 'signed_out'); end if;
  if not exists (select 1 from games.players where id = v_uid) then
    return jsonb_build_object('ok', false, 'reason', 'no_profile');
  end if;
  if not exists (select 1 from games.catalog where game = p_game and live) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_game');
  end if;

  if p_kind = 'daily' then
    if v_round is null or v_round not in ('d' || to_char(v_today, 'YYYY-MM-DD'), 'd' || to_char(v_today - 1, 'YYYY-MM-DD')) then
      return jsonb_build_object('ok', false, 'reason', 'stale_daily');
    end if;
    if v_secs < 10 then return jsonb_build_object('ok', false, 'reason', 'too_short'); end if;
    v_gap := interval '45 seconds';
  elsif p_kind = 'round' then
    if v_secs < 5 then return jsonb_build_object('ok', false, 'reason', 'too_short'); end if;
    v_gap := interval '10 seconds'; v_round := null;
  elsif p_kind = 'run' then
    v_gap := interval '5 seconds'; v_round := null;
  else
    return jsonb_build_object('ok', false, 'reason', 'bad_kind');
  end if;

  if v_secs > 21600 then return jsonb_build_object('ok', false, 'reason', 'too_long'); end if;
  if p_correct is null or p_wrong is null or p_score is null or p_combo is null or p_accuracy is null
     or p_correct < 0 or p_wrong < 0 or p_combo < 0
     or p_correct > (v_secs * 30 + 400)
     or p_wrong   > (v_secs * 20 + 200)
     or p_combo   > p_correct
     or p_score   > p_correct * 360
     or p_score   < -((p_correct + p_wrong) * 400 + 1000)
     or coalesce(p_level, 0) not between 0 and 200 then
    return jsonb_build_object('ok', false, 'reason', 'implausible');
  end if;
  v_exp := case when p_correct + p_wrong = 0 then 0
                else round(100.0 * p_correct / (p_correct + p_wrong)) end;
  if abs(p_accuracy - v_exp) > 1 then return jsonb_build_object('ok', false, 'reason', 'implausible'); end if;

  select max(created_at) into v_last from games.runs
   where player_id = v_uid and game = p_game and kind = p_kind;
  if v_last is not null and now() - v_last < v_gap then
    return jsonb_build_object('ok', false, 'reason', 'too_soon');
  end if;

  insert into games.runs (player_id, game, kind, round_id, score, accuracy, combo, level,
                          correct, wrong, duration_ms, finished, client_version)
  values (v_uid, p_game, p_kind, v_round, p_score, p_accuracy, p_combo, coalesce(p_level, 0),
          p_correct, p_wrong, p_duration_ms, coalesce(p_finished, false), left(p_version, 24))
  returning id into v_id;

  perform games.settle_dailies(p_game);
  perform games.award(v_uid, p_game);

  return jsonb_build_object('ok', true, 'id', v_id,
    'new_badges', coalesce((select jsonb_agg(jsonb_build_object('slug', b.slug, 'name', b.name, 'hint', b.hint) order by b.sort)
                              from games.player_badges pb join games.badges b on b.slug = pb.slug
                             where pb.player_id = v_uid and pb.earned_at = now()), '[]'::jsonb));
end $$;

-- Best score per person for one daily. Top N, plus the caller if outside it.
create or replace function public.ll_daily_board(p_game text, p_round_id text, p_limit integer default 25)
returns table (name text, number integer, avatar_shape smallint, avatar_color smallint,
               score integer, accuracy smallint, combo integer, place bigint, field bigint,
               is_me boolean, at timestamptz)
language sql stable security definer set search_path = '' as $$
  with best as (
    select distinct on (r.player_id) r.player_id, r.score, r.accuracy, r.combo, r.created_at
      from games.runs r
     where r.game = p_game and r.kind = 'daily' and r.round_id = p_round_id
     order by r.player_id, r.score desc, r.created_at asc
  ), ranked as (
    select b.*, row_number() over (order by b.score desc, b.created_at asc) as place,
           count(*) over () as field
      from best b
  )
  select p.name, p.number, p.avatar_shape, p.avatar_color, k.score, k.accuracy, k.combo,
         k.place, k.field, (k.player_id = auth.uid()), k.created_at
    from ranked k join games.players p on p.id = k.player_id
   where k.place <= least(greatest(coalesce(p_limit, 25), 1), 100) or k.player_id = auth.uid()
   order by k.place;
$$;

-- Best single round (daily or campaign) per person, all time.
create or replace function public.ll_hall_of_fame(p_game text, p_limit integer default 25)
returns table (name text, number integer, avatar_shape smallint, avatar_color smallint,
               score integer, accuracy smallint, combo integer, place bigint, is_me boolean, at timestamptz)
language sql stable security definer set search_path = '' as $$
  with best as (
    select distinct on (r.player_id) r.player_id, r.score, r.accuracy, r.combo, r.created_at
      from games.runs r
     where r.game = p_game and r.kind in ('daily', 'round')
     order by r.player_id, r.score desc, r.created_at asc
  ), ranked as (
    select b.*, row_number() over (order by b.score desc, b.created_at asc) as place from best b
  )
  select p.name, p.number, p.avatar_shape, p.avatar_color, k.score, k.accuracy, k.combo,
         k.place, (k.player_id = auth.uid()), k.created_at
    from ranked k join games.players p on p.id = k.player_id
   where k.place <= least(greatest(coalesce(p_limit, 25), 1), 100) or k.player_id = auth.uid()
   order by k.place;
$$;

-- The badge catalog for a game, with the caller's earned date where earned.
create or replace function public.ll_badges(p_game text)
returns table (slug text, name text, hint text, sort integer, earned_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select b.slug, b.name, b.hint, b.sort, pb.earned_at
    from games.badges b
    left join games.player_badges pb on pb.slug = b.slug and pb.player_id = auth.uid()
   where b.game = p_game or b.game is null
   order by b.sort;
$$;

-- Delete everything the games hold about the caller, sign-in record included.
create or replace function public.ll_delete_me()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'reason', 'signed_out'); end if;
  delete from games.players where id = v_uid;
  delete from auth.users where id = v_uid;
  return jsonb_build_object('ok', true);
end $$;

-- ------------------------------------------------------------ grants
revoke all on function public.ll_name_options(integer) from public;
revoke all on function public.ll_me() from public;
revoke all on function public.ll_create_player(text, text, integer, integer) from public;
revoke all on function public.ll_update_player(text, integer, integer, boolean) from public;
revoke all on function public.ll_save_get(text) from public;
revoke all on function public.ll_save_put(text, jsonb, integer) from public;
revoke all on function public.ll_submit_run(text, text, text, integer, integer, integer, integer, integer, integer, integer, boolean, text) from public;
revoke all on function public.ll_daily_board(text, text, integer) from public;
revoke all on function public.ll_hall_of_fame(text, integer) from public;
revoke all on function public.ll_badges(text) from public;
revoke all on function public.ll_delete_me() from public;

revoke all on function public.ll_me() from anon;
revoke all on function public.ll_create_player(text, text, integer, integer) from anon;
revoke all on function public.ll_update_player(text, integer, integer, boolean) from anon;
revoke all on function public.ll_save_get(text) from anon;
revoke all on function public.ll_save_put(text, jsonb, integer) from anon;
revoke all on function public.ll_submit_run(text, text, text, integer, integer, integer, integer, integer, integer, integer, boolean, text) from anon;
revoke all on function public.ll_delete_me() from anon;

grant execute on function public.ll_name_options(integer) to anon, authenticated;
grant execute on function public.ll_daily_board(text, text, integer) to anon, authenticated;
grant execute on function public.ll_hall_of_fame(text, integer) to anon, authenticated;
grant execute on function public.ll_badges(text) to anon, authenticated;
grant execute on function public.ll_me() to authenticated;
grant execute on function public.ll_create_player(text, text, integer, integer) to authenticated;
grant execute on function public.ll_update_player(text, integer, integer, boolean) to authenticated;
grant execute on function public.ll_save_get(text) to authenticated;
grant execute on function public.ll_save_put(text, jsonb, integer) to authenticated;
grant execute on function public.ll_submit_run(text, text, text, integer, integer, integer, integer, integer, integer, integer, boolean, text) to authenticated;
grant execute on function public.ll_delete_me() to authenticated;
