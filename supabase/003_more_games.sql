-- Lucid Lux games, part 3: Batduko and Resonant join the accounts, plus
-- badges that span games. TapBoom keeps its own ll_submit_run; the other
-- games report finished puzzles and rounds through ll_submit_result.

alter table games.runs drop constraint if exists runs_kind_check;
alter table games.runs add constraint runs_kind_check check (kind in ('daily', 'round', 'run', 'solve'));

insert into games.catalog (game, name, live) values ('batduko', 'Batduko', true)
on conflict (game) do update set live = true;
update games.catalog set live = true where game = 'resonant';

insert into games.badges (slug, game, name, hint, sort) values
  ('bd.first',    'batduko',  'First Roost',      'Solve a Batduko cave',                         310),
  ('bd.ten',      'batduko',  'Colony of Ten',    'Solve 10 caves',                               320),
  ('bd.midnight', 'batduko',  'Midnight Flight',  'Solve a Midnight cave',                        330),
  ('bd.swift',    'batduko',  'Swift Wings',      'Solve a cave in under 3 minutes',              340),
  ('bd.champion', 'batduko',  'Bat Champion',     'Score 2,000 or more in one cave',              350),
  ('bd.days3',    'batduko',  'Night After Night','Solve caves on 3 different days',              360),
  ('rs.first',    'resonant', 'First Hold',       'Hold the core in round I',                     410),
  ('rs.four',     'resonant', 'Flat Mastery',     'Hold the core in round IV',                    420),
  ('rs.fold',     'resonant', 'Folded',           'Hold the core on a folded solid',              430),
  ('rs.nine',     'resonant', 'Why Five',         'Hold the core in round IX',                    440),
  ('rs.full',     'resonant', 'Untouched',        'Hold the core at full integrity',              450),
  ('ll.two',      null,       'Wanderer',         'Play two Lucid Lux games',                     900),
  ('ll.three',    null,       'Explorer',         'Play three Lucid Lux games',                   910)
on conflict (slug) do nothing;

-- The TapBoom rules keep their body; a dispatcher now sits in front of them.
alter function games.award(uuid, text) rename to award_tapboom;

create or replace function games.award_other(p_player uuid, p_game text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_cands text[] := '{}';
  v_n int; v_days int; v_top int; v_fast boolean; v_best int; v_full boolean;
begin
  if p_game = 'batduko' then
    select count(*), count(distinct (r.created_at at time zone 'utc')::date), coalesce(max(r.level), 0),
           coalesce(bool_or(r.duration_ms < 180000), false), coalesce(max(r.score), 0)
      into v_n, v_days, v_top, v_fast, v_best
      from games.runs r where r.player_id = p_player and r.game = 'batduko' and r.kind = 'solve';
    if v_n >= 1     then v_cands := array_append(v_cands, 'bd.first'); end if;
    if v_n >= 10    then v_cands := array_append(v_cands, 'bd.ten'); end if;
    if v_top >= 3   then v_cands := array_append(v_cands, 'bd.midnight'); end if;
    if v_fast       then v_cands := array_append(v_cands, 'bd.swift'); end if;
    if v_best >= 2000 then v_cands := array_append(v_cands, 'bd.champion'); end if;
    if v_days >= 3  then v_cands := array_append(v_cands, 'bd.days3'); end if;
  elsif p_game = 'resonant' then
    select coalesce(max(r.level) filter (where r.finished), 0),
           coalesce(bool_or(r.finished and r.score >= 100), false)
      into v_top, v_full
      from games.runs r where r.player_id = p_player and r.game = 'resonant' and r.kind = 'round';
    if v_top >= 1 then v_cands := array_append(v_cands, 'rs.first'); end if;
    if v_top >= 4 then v_cands := array_append(v_cands, 'rs.four'); end if;
    if v_top >= 5 then v_cands := array_append(v_cands, 'rs.fold'); end if;
    if v_top >= 9 then v_cands := array_append(v_cands, 'rs.nine'); end if;
    if v_full     then v_cands := array_append(v_cands, 'rs.full'); end if;
  end if;

  -- Across games: how many different Lucid Lux games this player has played.
  select count(distinct r.game) into v_n from games.runs r where r.player_id = p_player;
  if v_n >= 2 then v_cands := array_append(v_cands, 'll.two'); end if;
  if v_n >= 3 then v_cands := array_append(v_cands, 'll.three'); end if;

  insert into games.player_badges (player_id, slug)
  select p_player, s from unnest(v_cands) s
  on conflict do nothing;
end $$;

create or replace function games.award(p_player uuid, p_game text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_game = 'tapboom' then perform games.award_tapboom(p_player, p_game); end if;
  perform games.award_other(p_player, p_game);
end $$;

revoke all on all functions in schema games from public, anon, authenticated;

-- Signing in brings every game's badges up to date, not only TapBoom's.
create or replace function public.ll_me()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare g text;
begin
  if auth.uid() is null then return jsonb_build_object('player', null, 'signed_in', false); end if;
  perform games.settle_dailies('tapboom');
  if exists (select 1 from games.players where id = auth.uid()) then
    for g in select c.game from games.catalog c where c.live loop
      perform games.award(auth.uid(), g);
    end loop;
  end if;
  return games.me_json(auth.uid()) || jsonb_build_object('signed_in', true);
end $$;

-- A finished Batduko cave or Resonant round. Ceilings stop casual forgery;
-- they are not proof.
create or replace function public.ll_submit_result(p_game text, p_kind text, p_level integer,
  p_score integer, p_duration_ms integer, p_won boolean default true, p_version text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_gap interval;
  v_last timestamptz;
  v_id bigint;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'reason', 'signed_out'); end if;
  if not exists (select 1 from games.players where id = v_uid) then
    return jsonb_build_object('ok', false, 'reason', 'no_profile');
  end if;
  if p_game = 'batduko' then
    if p_kind <> 'solve' or not coalesce(p_won, false) or coalesce(p_level, 0) not between 1 and 3
       or coalesce(p_score, -1) not between 0 and 20000 or coalesce(p_duration_ms, 0) < 15000
       or p_duration_ms > 21600000 then
      return jsonb_build_object('ok', false, 'reason', 'implausible');
    end if;
    v_gap := interval '10 seconds';
  elsif p_game = 'resonant' then
    if p_kind <> 'round' or coalesce(p_level, 0) not between 1 and 9
       or coalesce(p_score, -1) not between 0 and 100 or coalesce(p_duration_ms, 0) < 3000
       or p_duration_ms > 21600000 then
      return jsonb_build_object('ok', false, 'reason', 'implausible');
    end if;
    v_gap := interval '3 seconds';
  else
    return jsonb_build_object('ok', false, 'reason', 'unknown_game');
  end if;
  if not exists (select 1 from games.catalog where game = p_game and live) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_game');
  end if;

  select max(created_at) into v_last from games.runs where player_id = v_uid and game = p_game;
  if v_last is not null and now() - v_last < v_gap then
    return jsonb_build_object('ok', false, 'reason', 'too_soon');
  end if;

  insert into games.runs (player_id, game, kind, round_id, score, accuracy, combo, level,
                          correct, wrong, duration_ms, finished, client_version)
  values (v_uid, p_game, p_kind, null, p_score, 0, 0, p_level, 0, 0, p_duration_ms,
          coalesce(p_won, false), left(p_version, 24))
  returning id into v_id;

  perform games.award(v_uid, p_game);

  return jsonb_build_object('ok', true, 'id', v_id,
    'new_badges', coalesce((select jsonb_agg(jsonb_build_object('slug', b.slug, 'name', b.name, 'hint', b.hint) order by b.sort)
                              from games.player_badges pb join games.badges b on b.slug = pb.slug
                             where pb.player_id = v_uid and pb.earned_at = now()), '[]'::jsonb));
end $$;

revoke all on function public.ll_submit_result(text, text, integer, integer, integer, boolean, text) from public, anon;
grant execute on function public.ll_submit_result(text, text, integer, integer, integer, boolean, text) to authenticated;
revoke all on function public.ll_me() from public, anon;
grant execute on function public.ll_me() to authenticated;
