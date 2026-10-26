-- Lucid Lux games: accounts, saves, runs, badges, groups.
-- Lives in the dedicated Lucid Lux project (tsbazrbdkojzhnglakcv), in its own
-- schema. The schema is NOT exposed through the API and grants nothing to
-- anon or authenticated: the only door is the public.ll_* functions below,
-- each security definer with an empty search_path.

create schema if not exists games;
revoke all on schema games from public;
revoke all on schema games from anon, authenticated;

-- ------------------------------------------------------------ catalog
create table games.catalog (
  game text primary key check (game ~ '^[a-z0-9-]{2,24}$'),
  name text not null,
  live boolean not null default false
);
insert into games.catalog (game, name, live) values
  ('tapboom',  'TapBoom',  true),
  ('resonant', 'Resonant', false),
  ('sches',    'Sches',    false),
  ('huemain',  'HueMain',  false);

-- ------------------------------------------------------------ names
-- A name is one mineral and one creature, both from this list. No free text,
-- so there is nothing to moderate.
create table games.name_words (
  kind text not null check (kind in ('mineral', 'creature')),
  word text not null check (word ~ '^[A-Z][a-z]{2,11}$'),
  primary key (kind, word)
);
insert into games.name_words (kind, word)
select 'mineral', w from unnest(array[
  'Agate','Amber','Amethyst','Apatite','Azurite','Barite','Beryl','Calcite',
  'Celestine','Citrine','Diamond','Dolomite','Emerald','Epidote','Feldspar','Fluorite',
  'Galena','Garnet','Gypsum','Halite','Hematite','Iolite','Jade','Jasper',
  'Kyanite','Malachite','Mica','Moonstone','Olivine','Onyx','Opal','Peridot',
  'Pyrite','Quartz','Rhodonite','Ruby','Sapphire','Sodalite','Spinel','Sunstone',
  'Talc','Topaz','Tourmaline','Turquoise','Zircon','Benitoite','Larimar','Jadeite'
]) w;
insert into games.name_words (kind, word)
select 'creature', w from unnest(array[
  'Badger','Beetle','Bison','Crane','Cricket','Dolphin','Egret','Falcon',
  'Finch','Fox','Gecko','Gull','Hare','Hawk','Heron','Ibis',
  'Jay','Kestrel','Kiwi','Koi','Lark','Llama','Lynx','Marten',
  'Mole','Moth','Newt','Nightjar','Orca','Otter','Owl','Pika',
  'Puffin','Quail','Raven','Robin','Seal','Sparrow','Swift','Tapir',
  'Tern','Urchin','Vole','Walrus','Wombat','Wren','Yak','Zebra'
]) w;

-- ------------------------------------------------------------ players
create sequence games.player_number_seq;
create table games.players (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null,
  number integer not null unique default nextval('games.player_number_seq'),
  age_band text not null check (age_band in ('13-17', '18+')),
  avatar_shape smallint not null default 0 check (avatar_shape between 0 and 7),
  avatar_color smallint not null default 0 check (avatar_color between 0 and 7),
  research_opt_in boolean not null default false,
  research_opt_in_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter sequence games.player_number_seq owned by games.players.number;

-- ------------------------------------------------------------ saves
create table games.saves (
  player_id uuid not null references games.players (id) on delete cascade,
  game text not null references games.catalog (game),
  state jsonb not null,
  rev integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (player_id, game),
  check (pg_column_size(state) < 98304)
);
create index saves_game_idx on games.saves (game);

-- ------------------------------------------------------------ runs
create table games.runs (
  id bigint generated always as identity primary key,
  player_id uuid not null references games.players (id) on delete cascade,
  game text not null references games.catalog (game),
  kind text not null check (kind in ('daily', 'round', 'run')),
  round_id text,
  score integer not null,
  accuracy smallint not null check (accuracy between 0 and 100),
  combo integer not null check (combo >= 0),
  level smallint not null default 0 check (level between 0 and 200),
  correct integer not null check (correct >= 0),
  wrong integer not null check (wrong >= 0),
  duration_ms integer not null check (duration_ms >= 0),
  finished boolean not null default false,
  client_version text check (client_version is null or length(client_version) <= 24),
  created_at timestamptz not null default now()
);
create index runs_board_idx on games.runs (game, kind, round_id, score desc);
create index runs_player_idx on games.runs (player_id, game, created_at desc);

-- ------------------------------------------------------------ badges
create table games.badges (
  slug text primary key,
  game text references games.catalog (game),     -- null = across all games
  name text not null,
  hint text not null,
  sort integer not null default 0
);
create index badges_game_idx on games.badges (game);
create table games.player_badges (
  player_id uuid not null references games.players (id) on delete cascade,
  slug text not null references games.badges (slug),
  earned_at timestamptz not null default now(),
  primary key (player_id, slug)
);
create index player_badges_slug_idx on games.player_badges (slug);

insert into games.badges (slug, game, name, hint, sort) values
  ('tb.first',    'tapboom', 'First Boom',  'Finish a round',                         10),
  ('tb.ten',      'tapboom', 'Ten Rounds',  'Finish 10 rounds',                       20),
  ('tb.hundred',  'tapboom', 'Century',     'Finish 100 rounds',                      30),
  ('tb.days3',    'tapboom', 'Returning',   'Play on 3 different days',               40),
  ('tb.days7',    'tapboom', 'Week of Play','Play on 7 different days',               50),
  ('tb.days30',   'tapboom', 'Month of Play','Play on 30 different days',             60),
  ('tb.clean',    'tapboom', 'Spotless',    '100% accuracy in a round of 10 or more taps', 70),
  ('tb.combo15',  'tapboom', 'Chain 15',    'Reach a 15 combo',                       80),
  ('tb.combo30',  'tapboom', 'Chain 30',    'Reach a 30 combo',                       90),
  ('tb.gate5',    'tapboom', 'Five Gates',  'Reach level 6',                          100),
  ('tb.diamond',  'tapboom', 'Diamond',     'Reach level 13, the Diamond rank',       110),
  ('tb.opal',     'tapboom', 'Opal',        'Reach level 16, the Opal rank',          120),
  ('tb.daily3',   'tapboom', 'Regular',     'Play 3 daily challenges',                130),
  ('tb.daily10',  'tapboom', 'Devoted',     'Play 10 daily challenges',               140),
  ('tb.streak3',  'tapboom', 'On a Roll',   'Daily challenge 3 days in a row',        150),
  ('tb.streak7',  'tapboom', 'Seven Straight','Daily challenge 7 days in a row',      160),
  ('tb.top10',    'tapboom', 'Top Ten',     'Finish a day in the daily top 10',       170),
  ('tb.podium',   'tapboom', 'Podium',      'Finish a day in the daily top 3',        180),
  ('tb.champion', 'tapboom', 'Champion',    'Win a day of the daily challenge',       190),
  ('tb.finisher', 'tapboom', 'Finisher',    'Open every gate in the campaign',        200);

-- ------------------------------------------------------------ daily settlement
create table games.daily_places (
  game text not null references games.catalog (game),
  round_id text not null,
  player_id uuid not null references games.players (id) on delete cascade,
  place integer not null,
  field integer not null,
  primary key (game, round_id, player_id)
);
create index daily_places_player_idx on games.daily_places (player_id);
create table games.daily_settled (
  game text not null references games.catalog (game),
  round_id text not null,
  settled_at timestamptz not null default now(),
  primary key (game, round_id)
);

-- ------------------------------------------------------------ groups (leagues later)
create table games.groups (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('league', 'team', 'club')),
  name text not null check (length(name) between 2 and 40),
  game text references games.catalog (game),
  created_by uuid references games.players (id) on delete set null,
  created_at timestamptz not null default now()
);
create index groups_game_idx on games.groups (game);
create index groups_created_by_idx on games.groups (created_by);
create table games.group_members (
  group_id uuid not null references games.groups (id) on delete cascade,
  player_id uuid not null references games.players (id) on delete cascade,
  role text not null default 'member' check (role in ('member', 'captain')),
  joined_at timestamptz not null default now(),
  primary key (group_id, player_id)
);
create index group_members_player_idx on games.group_members (player_id);

-- Row level security on everything, with no policies: unreachable except
-- through the definer functions.
alter table games.catalog       enable row level security;
alter table games.name_words    enable row level security;
alter table games.players       enable row level security;
alter table games.saves         enable row level security;
alter table games.runs          enable row level security;
alter table games.badges        enable row level security;
alter table games.player_badges enable row level security;
alter table games.daily_places  enable row level security;
alter table games.daily_settled enable row level security;
alter table games.groups        enable row level security;
alter table games.group_members enable row level security;
revoke all on all tables in schema games from public, anon, authenticated;
revoke all on all sequences in schema games from public, anon, authenticated;
