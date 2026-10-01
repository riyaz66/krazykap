-- ============================================================================
-- RAIN OF PHYSICS — Live Classroom
-- Supabase / Postgres schema  (idempotent — safe to paste more than once)
--
-- Paste this entire file into the Supabase SQL Editor and run it once.
--
-- Design notes
--   * Persistent : teacher accounts, topics, question bank.
--   * Ephemeral  : rooms, participants, activities, responses, XP, streaks.
--   * anon (students) get NO table privileges at all. They talk to the
--     database exclusively through SECURITY DEFINER RPCs that authenticate a
--     per-participant session token (stored hashed). This is what makes the
--     "server is authoritative" requirement real: the browser cannot read the
--     correct answer, cannot write a score, and cannot touch another room.
--   * authenticated (teachers) get table access guarded by row level security.
-- ============================================================================

-- No extensions required: `gen_random_uuid()` (PG13+) and `sha256()` (PG11+)
-- are both core. That matters because every SECURITY DEFINER function below
-- runs with `search_path = ''`, where an extension installed into `extensions`
-- (as many Supabase projects do) would not be reachable by an unqualified name.

-- ----------------------------------------------------------------------------
-- 1. Persistent: teacher profile + topic + question bank
-- ----------------------------------------------------------------------------

create table if not exists public.teachers (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default 'Teacher',
  created_at   timestamptz not null default now()
);

create table if not exists public.topics (
  id         uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.teachers (id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now(),
  unique (teacher_id, name)
);

create table if not exists public.questions (
  id             uuid primary key default gen_random_uuid(),
  teacher_id     uuid not null references public.teachers (id) on delete cascade,
  topic_id       uuid references public.topics (id) on delete set null,
  set_name       text,
  prompt         text not null,
  type           text not null default 'mcq'
                 check (type in ('mcq','true_false','prediction','numerical','find_error','exit_ticket')),
  options        jsonb not null default '[]'::jsonb,   -- ["A text","B text",...]
  correct_answer jsonb not null default '[]'::jsonb,   -- [0] for index types, ["4.2"] for numeric
  explanation    text,
  timer_seconds  integer not null default 30
                 check (timer_seconds is null or timer_seconds between 1 and 3600),
  difficulty     text not null default 'Medium'
                 check (difficulty in ('Easy','Medium','Hard','Boss')),
  is_published   boolean not null default true,
  created_at     timestamptz not null default now()
);

alter table public.questions add column if not exists set_name text;

create index if not exists questions_teacher_idx on public.questions (teacher_id, created_at desc);
create index if not exists questions_topic_idx    on public.questions (topic_id);

-- The dashboard's save call never sends `teacher_id`. The column is NOT NULL
-- with no default, so the row is proposed with teacher_id = NULL,
-- `questions_own`'s WITH CHECK (teacher_id = auth.uid()) evaluates to NULL and
-- every save dies with "new row violates row-level security policy".
-- Defaulting it to the caller makes the policy self-satisfying.
-- (Idempotent ALTER, not part of `create table if not exists`, so it also
-- repairs a table created by an earlier run of this file.)
alter table public.questions alter column teacher_id set default auth.uid();

-- Auto-provision the teacher row + default topics when an auth user appears.
create or replace function public.handle_new_teacher()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  insert into public.teachers (id, display_name)
  values (new.id, coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(coalesce(new.email,''), '@', 1), 'Teacher'))
  on conflict (id) do nothing;

  insert into public.topics (teacher_id, name)
  select new.id, t.name from (values
    ('Mechanics'), ('Current Electricity'), ('Magnetism'),
    ('Thermodynamics'), ('Semiconductor'), ('Digital Electronics'),
    ('Optics'), ('Waves & Sound')
  ) as t(name)
  on conflict (teacher_id, name) do nothing;

  return new;
end;
$fn$;

-- The trigger only covers sign-ups from now on. Any account that already
-- exists in auth.users would have no row in public.teachers, and every
-- create_room() would then fail its foreign key — so backfill them.
insert into public.teachers (id, display_name)
select u.id,
       coalesce(nullif(trim(u.raw_user_meta_data ->> 'display_name'), ''),
                split_part(coalesce(u.email, ''), '@', 1), 'Teacher')
  from auth.users u
on conflict (id) do nothing;

-- Same for the default topic shelf.
insert into public.topics (teacher_id, name)
select t.id, v.name
  from public.teachers t
  cross join (values
    ('Mechanics'), ('Current Electricity'), ('Magnetism'),
    ('Thermodynamics'), ('Semiconductor'), ('Digital Electronics'),
    ('Optics'), ('Waves & Sound')
  ) as v(name)
on conflict (teacher_id, name) do nothing;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_teacher();

-- ----------------------------------------------------------------------------
-- 2. Ephemeral: rooms
-- ----------------------------------------------------------------------------

create table if not exists public.rooms (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique check (code ~ '^[A-Z2-9]{6}$'),
  teacher_id     uuid not null references public.teachers (id) on delete cascade,
  title          text not null default 'Live Class',
  status         text not null default 'lobby'
                 check (status in ('lobby','active','closed','expired')),
  settings       jsonb not null default '{}'::jsonb,
  --  {"streaks_enabled":true, "allow_change":false, "teams_enabled":false}
  rounds_total   integer not null default 0,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  closed_at      timestamptz
);

create index if not exists rooms_teacher_idx  on public.rooms (teacher_id, created_at desc);
create index if not exists rooms_status_idx   on public.rooms (status, expires_at);

-- Unambiguous alphabet: no 0/O, no 1/I/L. 31^6 ≈ 887M combinations.
create or replace function public.gen_room_code()
returns text
language plpgsql
as $fn$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  candidate text;
  i int;
begin
  loop
    candidate := '';
    for i in 1..6 loop
      candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.rooms where code = candidate);
  end loop;
  return candidate;
end;
$fn$;

create or replace function public.create_room(p_title text default 'Live Class')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_teacher uuid := auth.uid();
  v_room    public.rooms%rowtype;
begin
  if v_teacher is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  -- close any previous open rooms for this teacher (one live room at a time),
  -- and take their in-flight questions down with them
  with closed as (
    update public.rooms
       set status = 'closed', closed_at = now()
     where teacher_id = v_teacher and status in ('lobby','active')
    returning id
  )
  update public.activities a
     set state = 'closed', paused = false
    from closed c
   where a.room_id = c.id and a.state <> 'closed';

  insert into public.rooms (code, teacher_id, title, expires_at)
  values (public.gen_room_code(), v_teacher, coalesce(nullif(trim(p_title),''), 'Live Class'),
          now() + interval '3 hours')
  returning * into v_room;

  return row_to_json(v_room)::jsonb;
end;
$fn$;

create or replace function public.close_room(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_room public.rooms%rowtype;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  update public.rooms
     set status = 'closed', closed_at = now()
   where id = p_room_id and teacher_id = auth.uid() and status in ('lobby','active','expired')
  returning * into v_room;

  if v_room.id is null then
    raise exception 'room_not_found' using errcode = 'P0002';
  end if;

  update public.activities set state = 'closed'
   where room_id = p_room_id and state not in ('closed');

  return row_to_json(v_room)::jsonb;
end;
$fn$;

-- Lazy + bulk expiry so rooms reliably disappear.
-- PL/pgSQL rather than SQL: a scalar-returning SQL function must end in a
-- query, and this body ends in a data-modifying statement. Returns the number
-- of activities that were closed along with their room.
create or replace function public.expire_stale_rooms()
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_affected integer;
begin
  with closed as (
    update public.rooms
       set status = 'expired', closed_at = coalesce(closed_at, now())
     where status in ('lobby','active') and expires_at < now()
    returning id
  )
  update public.activities a
     set state = 'closed'
    from closed c
   where a.room_id = c.id and a.state <> 'closed';

  get diagnostics v_affected = row_count;
  return coalesce(v_affected, 0);
end;
$fn$;

-- ----------------------------------------------------------------------------
-- 3. Ephemeral: participants (students, anonymous)
-- ----------------------------------------------------------------------------

create table if not exists public.participants (
  id                 uuid primary key default gen_random_uuid(),
  room_id            uuid not null references public.rooms (id) on delete cascade,
  nickname           text not null check (char_length(nickname) between 1 and 24),
  session_token_hash text not null unique,
  team               text,
  xp                 integer not null default 0,
  streak             integer not null default 0,
  best_streak        integer not null default 0,
  correct_count      integer not null default 0,
  answered_count     integer not null default 0,
  joined_at          timestamptz not null default now(),
  last_seen          timestamptz not null default now()
);

create unique index if not exists participants_room_nickname_key
  on public.participants (room_id, lower(nickname));
create index if not exists participants_room_idx on public.participants (room_id, xp desc);

-- ----------------------------------------------------------------------------
-- 4. Ephemeral: activities (one launched question per round)
-- ----------------------------------------------------------------------------

create table if not exists public.activities (
  id             uuid primary key default gen_random_uuid(),
  room_id        uuid not null references public.rooms (id) on delete cascade,
  question_id    uuid references public.questions (id) on delete set null,
  seq            integer not null,
  type           text not null default 'mcq'
                 check (type in ('mcq','true_false','prediction','numerical','find_error','exit_ticket')),
  prompt         text not null,
  options        jsonb not null default '[]'::jsonb,
  correct_answer jsonb not null default '[]'::jsonb,   -- never leaves the server pre-reveal
  explanation    text,
  difficulty     text not null default 'Medium',
  topic          text,
  state          text not null default 'pending'
                 check (state in ('pending','answering','distribution','revealed','leaderboard','closed')),
  timer_seconds  integer not null default 30,
  speed_window   integer not null default 30,          -- window used for the speed bonus
  paused         boolean not null default false,       -- teacher froze the clock
  launched_at    timestamptz,
  deadline       timestamptz,
  revealed_at    timestamptz,
  created_at     timestamptz not null default now(),
  unique (room_id, seq)
);

create index if not exists activities_room_idx on public.activities (room_id, seq);

create table if not exists public.responses (
  id             uuid primary key default gen_random_uuid(),
  activity_id    uuid not null references public.activities (id) on delete cascade,
  participant_id uuid not null references public.participants (id) on delete cascade,
  room_id        uuid not null references public.rooms (id) on delete cascade,
  answer         jsonb not null,
  confidence     integer check (confidence is null or confidence in (50,70,90,100)),
  submitted_at   timestamptz not null default now(),
  reaction_ms    integer,
  is_correct     boolean not null default false,
  base_points    integer not null default 0,
  speed_bonus    integer not null default 0,
  xp             integer not null default 0,
  changed_count  integer not null default 0,
  unique (activity_id, participant_id)
);

create index if not exists responses_room_idx     on public.responses (room_id);
create index if not exists responses_activity_idx on public.responses (activity_id);

create table if not exists public.challenges (
  id             uuid primary key default gen_random_uuid(),
  activity_id    uuid not null references public.activities (id) on delete cascade,
  participant_id uuid not null references public.participants (id) on delete cascade,
  room_id        uuid not null references public.rooms (id) on delete cascade,
  body           text not null check (char_length(body) between 1 and 400),
  status         text not null default 'pending' check (status in ('pending','approved','rejected')),
  xp_bonus       integer not null default 0,
  created_at     timestamptz not null default now()
);

create index if not exists challenges_room_idx on public.challenges (room_id, status);

-- ----------------------------------------------------------------------------
-- 5. Realtime publication (teacher live feed)
-- ----------------------------------------------------------------------------

do $pub$
begin
  -- Guard both steps: a project may not have the publication yet, and some
  -- projects ship it already configured `for all tables` (which rejects ADD).
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'create publication supabase_realtime';
  end if;

  if coalesce((select puballtables from pg_publication where pubname = 'supabase_realtime'), false) then
    return;
  end if;

  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'responses'
  ) then
    execute 'alter publication supabase_realtime add table public.responses';
  end if;
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'participants'
  ) then
    execute 'alter publication supabase_realtime add table public.participants';
  end if;
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'activities'
  ) then
    execute 'alter publication supabase_realtime add table public.activities';
  end if;
end;
$pub$;

-- The teacher subscribes with a `room_id=eq.<uuid>` filter. UPDATE events only
-- publish the columns covered by the replica identity, so the filter needs the
-- whole row to survive the trip through WAL.
alter table public.responses    replica identity full;
alter table public.participants replica identity full;
alter table public.activities   replica identity full;

-- ----------------------------------------------------------------------------
-- 6. Row Level Security
-- ----------------------------------------------------------------------------

alter table public.teachers    enable row level security;
alter table public.topics      enable row level security;
alter table public.questions   enable row level security;
alter table public.rooms       enable row level security;
alter table public.participants enable row level security;
alter table public.activities  enable row level security;
alter table public.responses   enable row level security;
alter table public.challenges  enable row level security;

drop policy if exists teachers_self on public.teachers;
create policy teachers_self on public.teachers
  for select to authenticated using (id = auth.uid());

drop policy if exists teachers_update_self on public.teachers;
create policy teachers_update_self on public.teachers
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists topics_own on public.topics;
create policy topics_own on public.topics
  for all to authenticated using (teacher_id = auth.uid()) with check (teacher_id = auth.uid());

drop policy if exists questions_own on public.questions;
create policy questions_own on public.questions
  for all to authenticated using (teacher_id = auth.uid()) with check (teacher_id = auth.uid());

drop policy if exists rooms_own on public.rooms;
create policy rooms_own on public.rooms
  for all to authenticated using (teacher_id = auth.uid()) with check (teacher_id = auth.uid());

drop policy if exists participants_room_owner on public.participants;
create policy participants_room_owner on public.participants
  for all to authenticated
  using (exists (select 1 from public.rooms r where r.id = room_id and r.teacher_id = auth.uid()))
  with check (exists (select 1 from public.rooms r where r.id = room_id and r.teacher_id = auth.uid()));

drop policy if exists activities_room_owner on public.activities;
create policy activities_room_owner on public.activities
  for all to authenticated
  using (exists (select 1 from public.rooms r where r.id = room_id and r.teacher_id = auth.uid()))
  with check (exists (select 1 from public.rooms r where r.id = room_id and r.teacher_id = auth.uid()));

drop policy if exists responses_room_owner on public.responses;
create policy responses_room_owner on public.responses
  for select to authenticated
  using (exists (select 1 from public.rooms r where r.id = room_id and r.teacher_id = auth.uid()));

drop policy if exists challenges_room_owner on public.challenges;
create policy challenges_room_owner on public.challenges
  for select to authenticated
  using (exists (select 1 from public.rooms r where r.id = room_id and r.teacher_id = auth.uid()));

-- Students (anon) get no table privileges whatsoever.
revoke all on public.teachers     from anon;
revoke all on public.topics       from anon;
revoke all on public.questions    from anon;
revoke all on public.rooms        from anon;
revoke all on public.participants from anon;
revoke all on public.activities   from anon;
revoke all on public.responses    from anon;
revoke all on public.challenges   from anon;

-- Students (anon) get no table privileges whatsoever. They still need USAGE on
-- the schema to name the RPCs they are allowed to call.
grant usage on schema public to anon, authenticated;
grant select on public.teachers, public.topics, public.questions, public.rooms,
               public.participants, public.activities, public.responses, public.challenges
        to authenticated;
grant insert, update, delete on public.topics, public.questions, public.rooms,
                                public.participants, public.activities
        to authenticated;

-- ----------------------------------------------------------------------------
-- 7. Scoring helpers (server authoritative)
-- ----------------------------------------------------------------------------

-- Correct = 100. Speed bonus 0-50 by how early in the timer the answer landed.
create or replace function public.speed_bonus(p_elapsed numeric, p_window integer)
returns integer
language sql
immutable
as $fn$
  select case
    when p_window is null or p_window <= 0 then 10
    when p_elapsed <= p_window * 0.2 then 50
    when p_elapsed <= p_window * 0.4 then 40
    when p_elapsed <= p_window * 0.6 then 30
    when p_elapsed <= p_window * 0.8 then 20
    else 10
  end;
$fn$;

create or replace function public.streak_milestone(p_streak integer)
returns integer
language sql
immutable
as $fn$
  select case p_streak when 3 then 20 when 5 then 50 when 10 then 100 else 0 end;
$fn$;

-- ----------------------------------------------------------------------------
-- 8. Student RPCs (SECURITY DEFINER, session-token authenticated)
-- ----------------------------------------------------------------------------

create or replace function public.hash_token(p_token text)
returns text
language sql
immutable
set search_path = ''
as $fn$ select encode(sha256(convert_to(p_token, 'UTF8')), 'hex') $fn$;

create or replace function public.join_room(p_code text, p_nickname text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_room     public.rooms%rowtype;
  v_pid      uuid;
  -- Two v4 UUIDs spliced together: ~244 bits of entropy, 64 hex chars, and
  -- only core pg_catalog functions (this runs with an empty search_path).
  v_token    text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  v_nickname text := trim(coalesce(p_nickname, ''));
begin
  perform public.expire_stale_rooms();

  if char_length(v_nickname) < 1 or char_length(v_nickname) > 24 then
    raise exception 'nickname_invalid' using errcode = '22023';
  end if;

  select * into v_room from public.rooms
   where code = upper(trim(coalesce(p_code,''))) and status in ('lobby','active');

  if v_room.id is null then
    raise exception 'room_not_found' using errcode = 'P0002';
  end if;

  begin
    insert into public.participants (room_id, nickname, session_token_hash)
    values (v_room.id, v_nickname, public.hash_token(v_token))
    returning id into v_pid;
  exception when unique_violation then
    raise exception 'nickname_taken' using errcode = '23505';
  end;

  update public.rooms set status = 'active' where id = v_room.id and status = 'lobby';

  return jsonb_build_object(
    'token', v_token,
    'participant_id', v_pid,
    'room_id', v_room.id,
    'room_code', v_room.code,
    'room_title', v_room.title,
    'nickname', v_nickname
  );
end;
$fn$;

create or replace function public.get_room_state(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_pid     uuid;
  v_rid     uuid;
  v_room    public.rooms%rowtype;
  v_act     public.activities%rowtype;
  v_resp    public.responses%rowtype;
  v_count   integer;
  v_rank    integer;
  v_now     timestamptz := now();
  v_dist    jsonb;
  v_result  jsonb;
  v_lb      jsonb;
  v_state   text;
begin
  perform public.expire_stale_rooms();

  select id, room_id into v_pid, v_rid
    from public.participants
   where session_token_hash = public.hash_token(coalesce(p_token, ''));

  if v_pid is null then
    raise exception 'invalid_session' using errcode = '28000';
  end if;

  select * into v_room from public.rooms where id = v_rid;
  if v_room.id is null then
    raise exception 'room_not_found' using errcode = 'P0002';
  end if;

  -- Touch `last_seen` at most once every 10s and only when it really changes.
  -- A no-op UPDATE still publishes a WAL record, and every student polls every
  -- few seconds — without the WHERE guard each poll would become a
  -- teacher-side realtime event and therefore a full refetch.
  update public.participants
     set last_seen = v_now
   where id = v_pid and last_seen < v_now - interval '10 seconds';

  select count(*)::int into v_count from public.participants where room_id = v_rid;

  select * into v_act
    from public.activities
   where room_id = v_rid and state <> 'closed'
   order by seq desc
   limit 1;

  -- rank within room by xp
  select rk into v_rank from (
    select id, rank() over (order by xp desc, joined_at asc) as rk
      from public.participants where room_id = v_rid
  ) t where id = v_pid;

  if v_act.id is not null then
    select * into v_resp from public.responses
     where activity_id = v_act.id and participant_id = v_pid;

    v_state := v_act.state;

    if v_state in ('distribution','revealed','leaderboard') then
      select coalesce(jsonb_agg(jsonb_build_object(
               'key', k, 'count', c) order by k), '[]'::jsonb)
        into v_dist
      from (
        select (case when r.answer ->> 0 ~ '^-?[0-9]+$'
                     then (r.answer ->> 0)::int else -1 end) as k,
               count(*)::int as c
          from public.responses r
         where r.activity_id = v_act.id
         group by 1
      ) s;
    end if;

    if v_state in ('revealed','leaderboard') then
      v_result := case when v_resp.id is null then null else jsonb_build_object(
        'answered',        true,
        'answer',          v_resp.answer,
        'is_correct',      v_resp.is_correct,
        'base_points',     v_resp.base_points,
        'speed_bonus',     v_resp.speed_bonus,
        'xp',              v_resp.xp,
        'reaction_ms',     v_resp.reaction_ms,
        'confidence',      v_resp.confidence
      ) end;
    else
      v_result := case when v_resp.id is null then null else jsonb_build_object(
        'answered', true, 'answer', v_resp.answer, 'confidence', v_resp.confidence
      ) end;
    end if;

    if v_state = 'leaderboard' then
      v_lb := public.leaderboard(v_rid, 'xp', 10);
    end if;
  end if;

  return jsonb_build_object(
    'server_time_ms', (extract(epoch from v_now) * 1000)::bigint,
    'room', jsonb_build_object(
      'id', v_room.id, 'code', v_room.code, 'title', v_room.title,
      'status', v_room.status, 'expires_at', v_room.expires_at,
      'participant_count', v_count,
      'settings', v_room.settings
    ),
    'me', (
      select jsonb_build_object(
        'id', p.id, 'nickname', p.nickname, 'team', p.team,
        'xp', p.xp, 'streak', p.streak, 'best_streak', p.best_streak,
        'correct_count', p.correct_count, 'answered_count', p.answered_count,
        'rank', v_rank, 'last_seen', p.last_seen
      )
      from public.participants p where p.id = v_pid
    ),
    'activity', case when v_act.id is null then null else jsonb_build_object(
      'id', v_act.id, 'seq', v_act.seq, 'type', v_act.type,
      'prompt', v_act.prompt, 'options', v_act.options,
      'difficulty', v_act.difficulty, 'topic', v_act.topic,
      'state', v_state, 'timer_seconds', v_act.timer_seconds,
      'paused', v_act.paused,
      'launched_at', v_act.launched_at, 'deadline', v_act.deadline,
      'revealed_at', v_act.revealed_at,
      'correct_answer', case when v_state in ('revealed','leaderboard')
                             then v_act.correct_answer else '[]'::jsonb end,
      'explanation', case when v_state in ('revealed','leaderboard')
                          then v_act.explanation else null end,
      'distribution', coalesce(v_dist, '[]'::jsonb),
      'my_response', coalesce(v_result, 'null'::jsonb),
      'has_response', (v_resp.id is not null)
    ) end,
    'leaderboard', coalesce(v_lb, '[]'::jsonb),
    'participants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'nickname', p.nickname, 'team', p.team, 'xp', p.xp,
        'connected', (p.last_seen > v_now - interval '45 seconds')
      ) order by p.joined_at)
      from public.participants p where p.room_id = v_rid
    ), '[]'::jsonb)
  );
end;
$fn$;

create or replace function public.submit_answer(
  p_token      text,
  p_activity_id uuid,
  p_answer     jsonb,
  p_confidence integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_pid    uuid;
  v_rid    uuid;
  v_act    public.activities%rowtype;
  v_room   public.rooms%rowtype;
  v_resp   public.responses%rowtype;
  v_exists public.responses%rowtype;
  v_now    timestamptz := now();
  v_elapsed numeric;
  v_window integer;
  v_bonus  integer := 0;
  v_points integer := 0;
  v_xp     integer := 0;
  v_correct boolean := false;
  v_was_correct boolean := false;
  v_streak_bonus integer := 0;
begin
  select id, room_id into v_pid, v_rid
    from public.participants
   where session_token_hash = public.hash_token(coalesce(p_token, ''));
  if v_pid is null then raise exception 'invalid_session' using errcode = '28000'; end if;

  select * into v_act from public.activities
   where id = p_activity_id and room_id = v_rid for update;
  if v_act.id is null then raise exception 'activity_not_found' using errcode = 'P0002'; end if;

  select * into v_room from public.rooms where id = v_rid;
  if v_room.status not in ('lobby','active') then
    raise exception 'room_closed' using errcode = 'P0001';
  end if;

  if v_act.state <> 'answering' then
    raise exception 'not_accepting_answers' using errcode = 'P0001';
  end if;

  if v_act.paused then
    raise exception 'not_accepting_answers' using errcode = 'P0001';
  end if;

  if v_act.deadline is not null and v_now > v_act.deadline + interval '900 milliseconds' then
    raise exception 'time_expired' using errcode = 'P0001';
  end if;

  -- Lock the participant row so streak/XP updates cannot race.
  perform 1 from public.participants where id = v_pid for update;

  select * into v_exists from public.responses
   where activity_id = v_act.id and participant_id = v_pid;
  v_was_correct := coalesce(v_exists.is_correct, false);

  if v_exists.id is not null and coalesce(v_room.settings ->> 'allow_change', 'false') <> 'true' then
    raise exception 'already_answered' using errcode = '23505';
  end if;

  v_window := coalesce(nullif(v_act.speed_window, 0), v_act.timer_seconds, 30);
  v_elapsed := extract(epoch from (v_now - coalesce(v_act.launched_at, v_now)));

  -- A numerical question only accepts numeric input. Without this a modified
  -- client could store arbitrary text and pollute the live distribution.
  -- An empty submission is tolerated (it scores 0), but "abc" is not.
  if v_act.type = 'numerical' then
    begin
      perform nullif(trim(coalesce(p_answer ->> 0, p_answer ->> 'value', '')), '')::numeric;
    exception when others then
      raise exception 'numeric_invalid' using errcode = '22023';
    end;
  end if;

  -- evaluate correctness on the server
  if v_act.type = 'numerical' then
    v_correct := public.is_numerical_correct(p_answer, v_act.correct_answer);
  else
    v_correct := (p_answer = v_act.correct_answer);
  end if;

  -- Record response without awarding XP immediately (XP is awarded on reveal)
  if v_exists.id is null then
    insert into public.responses
      (activity_id, participant_id, room_id, answer, confidence, submitted_at,
       reaction_ms, is_correct, base_points, speed_bonus, xp)
    values
      (v_act.id, v_pid, v_rid, coalesce(p_answer,'[]'::jsonb), p_confidence, v_now,
       greatest(0, round(extract(epoch from (v_now - coalesce(v_act.launched_at, v_now))) * 1000)::int),
       v_correct, 0, 0, 0)
    returning * into v_resp;

    update public.participants
       set answered_count = answered_count + 1
     where id = v_pid;
  else
    update public.responses
       set answer = coalesce(p_answer,'[]'::jsonb),
           confidence = p_confidence,
           submitted_at = v_now,
           is_correct = v_correct,
           changed_count = changed_count + 1
     where id = v_exists.id
    returning * into v_resp;
  end if;

  -- Streaks (teacher may disable them per room). Only a *transition* to a
  -- correct answer advances the run, so re-submitting an unchanged answer
  -- (allow_change) cannot farm milestones.
  if coalesce(v_room.settings ->> 'streaks_enabled', 'true') = 'true' then
    if v_correct and not v_was_correct then
      update public.participants
         set streak = streak + 1,
             best_streak = greatest(best_streak, streak + 1)
       where id = v_pid
      returning streak into v_streak_bonus;

      v_streak_bonus := public.streak_milestone(v_streak_bonus);
      if v_streak_bonus > 0 then
        update public.participants set xp = xp + v_streak_bonus where id = v_pid;
        update public.responses set xp = xp + v_streak_bonus where id = v_resp.id;
        v_xp := v_xp + v_streak_bonus;
      end if;
    elsif not v_correct then
      update public.participants set streak = 0 where id = v_pid;
    end if;
  end if;

  return jsonb_build_object(
    'accepted', true,
    'submitted_at', v_resp.submitted_at,
    -- correctness is intentionally withheld until the teacher reveals
    'revealed', false,
    'xp_now', (select xp from public.participants where id = v_pid)
  );
end;
$fn$;

create or replace function public.is_numerical_correct(p_answer jsonb, p_key jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  v_raw  text := trim(coalesce(p_answer ->> 0, p_answer ->> 'value', ''));
  v_val  numeric;
  v_target numeric;
  v_tol  numeric;
begin
  if v_raw = '' then return false; end if;
  begin
    v_val := v_raw::numeric;
  exception when others then
    return false;
  end;

  v_target := 0;
  v_tol    := 0;
  begin
    v_target := coalesce(nullif(p_key ->> 0, '')::numeric,
                         nullif(p_key ->> 'value', '')::numeric, 0);
    v_tol := coalesce(nullif(p_key ->> 1, '')::numeric,
                      nullif(p_key ->> 'tolerance', '')::numeric, 0);
  exception when others then
    -- Malformed key: never a match, but never a crash either.
    return false;
  end;

  return abs(v_val - v_target) <= greatest(v_tol, 0);
end;
$fn$;

create or replace function public.submit_challenge(p_token text, p_activity_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_pid uuid; v_rid uuid; v_row public.challenges%rowtype;
begin
  select id, room_id into v_pid, v_rid from public.participants
   where session_token_hash = public.hash_token(coalesce(p_token,''));
  if v_pid is null then raise exception 'invalid_session' using errcode = '28000'; end if;

  -- The challenge must belong to the room this student is actually in.
  if not exists (select 1 from public.activities
                  where id = p_activity_id and room_id = v_rid) then
    raise exception 'activity_not_found' using errcode = 'P0002';
  end if;

  insert into public.challenges (activity_id, participant_id, room_id, body)
  values (p_activity_id, v_pid, v_rid, left(trim(p_body), 400))
  returning * into v_row;

  return row_to_json(v_row)::jsonb;
end;
$fn$;

create or replace function public.set_confidence(p_token text, p_activity_id uuid, p_confidence integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_pid uuid; v_rid uuid;
begin
  select id, room_id into v_pid, v_rid from public.participants
   where session_token_hash = public.hash_token(coalesce(p_token,''));
  if v_pid is null then raise exception 'invalid_session' using errcode = '28000'; end if;

  if p_confidence not in (50,70,90,100) then
    raise exception 'confidence_invalid' using errcode = '22023';
  end if;

  update public.responses set confidence = p_confidence
   where activity_id = p_activity_id and participant_id = v_pid;

  return jsonb_build_object('ok', true);
end;
$fn$;

-- ----------------------------------------------------------------------------
-- 9. Leaderboards & summary
-- ----------------------------------------------------------------------------

create or replace function public.leaderboard(p_room_id uuid, p_mode text default 'xp', p_limit integer default 10)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_result jsonb;
begin
  if p_mode not in ('xp','accuracy','speed','streak','participation') then
    p_mode := 'xp';
  end if;

  execute $q$
    with base as (
      select p.id, p.nickname, p.team, p.xp, p.streak, p.best_streak,
             p.correct_count, p.answered_count,
             case when p.answered_count > 0
                  then round(100.0 * p.correct_count / p.answered_count) else null end as accuracy,
             (select round(avg(r.reaction_ms)) from public.responses r
               where r.participant_id = p.id) as avg_speed,
             (select count(*) from public.activities a where a.room_id = p.room_id) as rounds,
             p.joined_at
        from public.participants p
       where p.room_id = $1 and p.correct_count > 0
    ),
    scored as (
      select *,
        case $2
          when 'xp'           then xp::numeric
          when 'accuracy'     then coalesce(accuracy, -1)::numeric
          when 'speed'        then coalesce(999999 - avg_speed, -1)::numeric
          when 'streak'       then best_streak::numeric
          when 'participation' then case when rounds > 0
                                         then answered_count::numeric / rounds else 0 end
        end as score
      from base
    )
    select coalesce(jsonb_agg(x order by rn), '[]'::jsonb) from (
      select row_number() over (order by score desc, xp desc, correct_count desc, coalesce(avg_speed, 999999) asc, joined_at asc, id asc) as rn,
             jsonb_build_object(
               'rank', row_number() over (order by score desc, xp desc, correct_count desc, coalesce(avg_speed, 999999) asc, joined_at asc, id asc),
               'id', id, 'nickname', nickname, 'team', team, 'xp', xp,
               'streak', streak, 'best_streak', best_streak,
               'correct_count', correct_count, 'answered_count', answered_count,
               'accuracy', accuracy, 'avg_speed', avg_speed,
               'score', score
             ) as x
      from (
        select p_sub.* from scored p_sub
      ) s
      order by score desc, xp desc, correct_count desc, coalesce(avg_speed, 999999) asc, joined_at asc, id asc
      limit $3
    ) t
  $q$
  into v_result
  using p_room_id, p_mode, least(coalesce(p_limit,10), 100);

  return coalesce(v_result, '[]'::jsonb);
end;
$fn$;

create or replace function public.get_session_summary(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_result jsonb;
begin
  select jsonb_build_object(
    'students',      (select count(*) from public.participants where room_id = p_room_id),
    'questions',     (select count(*) from public.activities where room_id = p_room_id),
    'avg_accuracy',  coalesce((select round(avg(case when r.is_correct then 100.0 else 0 end))
                               from public.responses r where r.room_id = p_room_id), 0),
    'avg_response_ms', coalesce((select round(avg(reaction_ms)) from public.responses
                                  where room_id = p_room_id), 0),
    'total_responses', (select count(*) from public.responses where room_id = p_room_id),
    'hardest', (
      select jsonb_build_object('prompt', a.prompt, 'accuracy', acc, 'wrong_answer', wrong)
        from (
          select activity_id,
                 round(100.0 * avg(case when is_correct then 1 else 0 end)) as acc,
                 (
                   select r2.answer
                     from public.responses r2
                    where r2.activity_id = r.activity_id and not r2.is_correct
                    group by r2.answer order by count(*) desc limit 1
                 ) as wrong
            from public.responses r
           where room_id = p_room_id
           group by activity_id
           having count(*) > 0
           order by acc asc, count(*) desc
           limit 1
        ) agg
        join public.activities a on a.id = agg.activity_id
      limit 1
    ),
    'leaderboard', public.leaderboard(p_room_id, 'xp', 10)
  ) into v_result;

  return coalesce(v_result, '{}'::jsonb);
end;
$fn$;

create or replace function public.get_teacher_state(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_room public.rooms%rowtype;
  v_act  public.activities%rowtype;
begin
  perform public.expire_stale_rooms();

  select * into v_room from public.rooms
   where id = p_room_id and teacher_id = auth.uid();
  if v_room.id is null then raise exception 'room_not_found' using errcode = 'P0002'; end if;

  select * into v_act from public.activities
   where room_id = p_room_id and state <> 'closed'
   order by seq desc limit 1;

  return jsonb_build_object(
    'server_time_ms', (extract(epoch from now()) * 1000)::bigint,
    'room', row_to_json(v_room)::jsonb,
    'participants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'nickname', p.nickname, 'team', p.team, 'xp', p.xp,
        'streak', p.streak, 'best_streak', p.best_streak,
        'correct_count', p.correct_count, 'answered_count', p.answered_count,
        'connected', (p.last_seen > now() - interval '45 seconds'),
        'answered_this', exists (select 1 from public.responses r
                                  where r.participant_id = p.id and r.activity_id = v_act.id)
      ) order by p.xp desc, p.joined_at)
      from public.participants p where p.room_id = p_room_id
    ), '[]'::jsonb),
    'activity', case when v_act.id is null then null else jsonb_build_object(
      'id', v_act.id, 'seq', v_act.seq, 'type', v_act.type, 'prompt', v_act.prompt,
      'options', v_act.options, 'correct_answer', v_act.correct_answer,
      'explanation', v_act.explanation, 'difficulty', v_act.difficulty, 'topic', v_act.topic,
      'state', v_act.state, 'timer_seconds', v_act.timer_seconds,
      'paused', v_act.paused,
      'launched_at', v_act.launched_at, 'deadline', v_act.deadline,
      'responses', coalesce((
        select jsonb_agg(jsonb_build_object(
          'participant_id', r.participant_id, 'nickname', p.nickname,
          'answer', r.answer, 'is_correct', r.is_correct,
          'reaction_ms', r.reaction_ms, 'confidence', r.confidence,
          'xp', r.xp, 'submitted_at', r.submitted_at
        ) order by r.submitted_at)
        from public.responses r
        join public.participants p on p.id = r.participant_id
        where r.activity_id = v_act.id
      ), '[]'::jsonb),
      'response_count', (select count(*) from public.responses where activity_id = v_act.id)
    ) end,
    'challenges', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'body', c.body, 'status', c.status, 'nickname', p.nickname
      ) order by c.created_at)
      from public.challenges c join public.participants p on p.id = c.participant_id
      where c.room_id = p_room_id and c.status = 'pending'
    ), '[]'::jsonb),
    'leaderboard', public.leaderboard(p_room_id, 'xp', 10),
    'summary', public.get_session_summary(p_room_id)
  );
end;
$fn$;

-- ----------------------------------------------------------------------------
-- 10. Teacher activity control (state machine)
-- ----------------------------------------------------------------------------

create or replace function public.launch_activity(
  p_room_id uuid,
  p_prompt text,
  p_type text default 'mcq',
  p_options jsonb default '[]'::jsonb,
  p_correct jsonb default '[]'::jsonb,
  p_timer integer default 30,
  p_explanation text default null,
  p_difficulty text default 'Medium',
  p_topic text default null,
  p_question_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_room  public.rooms%rowtype;
  v_act   public.activities%rowtype;
  v_seq   integer;
begin
  select * into v_room from public.rooms
   where id = p_room_id and teacher_id = auth.uid();
  if v_room.id is null then raise exception 'room_not_found' using errcode = 'P0002'; end if;
  if v_room.status not in ('lobby','active') then raise exception 'room_closed' using errcode = 'P0001'; end if;
  if coalesce(char_length(trim(p_prompt)), 0) < 2 then raise exception 'prompt_required' using errcode = '22023'; end if;
  if p_type not in ('mcq','true_false','prediction','numerical','find_error','exit_ticket') then
    raise exception 'type_invalid' using errcode = '22023';
  end if;

  -- only one open activity at a time
  update public.activities set state = 'closed'
   where room_id = p_room_id and state <> 'closed';

  select coalesce(max(seq), 0) + 1 into v_seq from public.activities where room_id = p_room_id;

  if p_type = 'true_false' and jsonb_array_length(coalesce(p_options,'[]'::jsonb)) = 0 then
    p_options := '["True","False"]'::jsonb;
  end if;
  if p_type in ('mcq','prediction','find_error','exit_ticket')
     and jsonb_array_length(coalesce(p_options,'[]'::jsonb)) < 2 then
    raise exception 'options_required' using errcode = '22023';
  end if;
  if jsonb_array_length(coalesce(p_correct,'[]'::jsonb)) = 0 then
    raise exception 'correct_answer_required' using errcode = '22023';
  end if;

  -- A numerical round whose key cannot be parsed could never be marked
  -- correct — reject it here rather than failing every submission later.
  if p_type = 'numerical' then
    begin
      perform nullif(coalesce(p_correct ->> 0, ''), '')::numeric;
    exception when others then
      raise exception 'numeric_invalid' using errcode = '22023';
    end;
    if coalesce(p_correct ->> 0, '') = '' then
      raise exception 'numeric_invalid' using errcode = '22023';
    end if;
  end if;

  insert into public.activities
    (room_id, question_id, seq, type, prompt, options, correct_answer, explanation,
     difficulty, topic, state, timer_seconds, speed_window, paused, launched_at, deadline, revealed_at)
  values
    (p_room_id, p_question_id, v_seq, p_type, trim(p_prompt), p_options, p_correct,
     nullif(trim(coalesce(p_explanation,'')), ''), p_difficulty, nullif(trim(coalesce(p_topic,'')), ''),
     'answering', greatest(1, coalesce(p_timer, 30)), greatest(1, coalesce(p_timer, 30)),
     false, now(), now() + make_interval(secs => greatest(1, coalesce(p_timer, 30))), null)
  returning * into v_act;

  update public.rooms set status = 'active', rounds_total = rounds_total + 1 where id = p_room_id;

  return row_to_json(v_act)::jsonb;
end;
$fn$;

create or replace function public.set_activity_state(p_room_id uuid, p_state text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_act public.activities%rowtype;
  v_count integer;
begin
  if not exists (select 1 from public.rooms where id = p_room_id and teacher_id = auth.uid()) then
    raise exception 'room_not_found' using errcode = 'P0002';
  end if;
  if p_state not in ('answering','distribution','revealed','leaderboard','closed') then
    raise exception 'state_invalid' using errcode = '22023';
  end if;

  select * into v_act from public.activities
   where room_id = p_room_id and state <> 'closed'
   order by seq desc limit 1;

  if v_act.id is null then raise exception 'activity_not_found' using errcode = 'P0002'; end if;
  if v_act.state = 'closed' then raise exception 'activity_closed' using errcode = 'P0001'; end if;

  -- 'revealed' freezes the clock, stamps reveal time, and scores correct answers with XP
  if p_state = 'revealed' then
    update public.activities
       set state = 'revealed', revealed_at = now(), deadline = null, paused = false
     where id = v_act.id returning * into v_act;

    -- Evaluate XP and correct_count for this activity if not already scored
    if v_act.revealed_at is not null then
      declare
        r_rec record;
        v_speed_rank integer := 1;
        v_award_xp integer := 0;
      begin
        for r_rec in
          select r.id, r.participant_id, r.reaction_ms
            from public.responses r
           where r.activity_id = v_act.id and r.is_correct = true and r.xp = 0
           order by r.reaction_ms asc, r.submitted_at asc
        loop
          if v_speed_rank = 1 then
            v_award_xp := 20;
          elsif v_speed_rank = 2 then
            v_award_xp := 10;
          elsif v_speed_rank = 3 then
            v_award_xp := 5;
          else
            v_award_xp := 1;
          end if;

          update public.responses
             set xp = v_award_xp, base_points = v_award_xp
           where id = r_rec.id;

          update public.participants
             set xp = xp + v_award_xp,
                 correct_count = correct_count + 1
           where id = r_rec.participant_id;

          v_speed_rank := v_speed_rank + 1;
        end loop;
      end;
    end if;
  elsif p_state = 'answering' then
    -- Re-opening the clock is "here is the full window again", so restart the
    -- speed window too — otherwise elapsed time would be measured from the
    -- original launch and nobody could earn a speed bonus on a re-open.
    update public.activities
       set state = 'answering',
           paused = false,
           launched_at = now(),
           deadline = now() + make_interval(secs => timer_seconds)
     where id = v_act.id returning * into v_act;
  elsif p_state = 'distribution' then
    update public.activities set state = 'distribution', deadline = null, paused = false
     where id = v_act.id returning * into v_act;
  else
    update public.activities set state = p_state, paused = false where id = v_act.id returning * into v_act;
  end if;

  select count(*)::int into v_count from public.responses where activity_id = v_act.id;

  return jsonb_build_object('activity', row_to_json(v_act)::jsonb, 'response_count', v_count);
end;
$fn$;

create or replace function public.close_activity(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_act public.activities%rowtype;
begin
  if not exists (select 1 from public.rooms where id = p_room_id and teacher_id = auth.uid()) then
    raise exception 'room_not_found' using errcode = 'P0002';
  end if;

  update public.activities set state = 'closed', paused = false
   where room_id = p_room_id and state <> 'closed'
   returning * into v_act;

  return coalesce(row_to_json(v_act)::jsonb, 'null'::jsonb);
end;
$fn$;

-- Pauses the live clock, or resumes it. While paused the deadline is cleared
-- so nobody's phone counts down, and `timer_seconds` holds the time that was
-- left so resuming gives it all back.
create or replace function public.pause_timer(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_act public.activities%rowtype;
  v_left integer;
begin
  if not exists (select 1 from public.rooms where id = p_room_id and teacher_id = auth.uid()) then
    raise exception 'room_not_found' using errcode = 'P0002';
  end if;

  select * into v_act from public.activities
   where room_id = p_room_id and state = 'answering' order by seq desc limit 1;
  if v_act.id is null then raise exception 'activity_not_found' using errcode = 'P0002'; end if;

  if v_act.paused then
    -- Resume: hand back exactly the time that was left, and restart the speed
    -- window from now so nobody is punished for the pause.
    update public.activities
       set paused = false,
           deadline = now() + make_interval(secs => greatest(1, v_act.timer_seconds)),
           launched_at = now()
     where id = v_act.id returning * into v_act;
  else
    v_left := greatest(0, floor(extract(epoch from (v_act.deadline - now())))::int);

    update public.activities
       set paused = true,
           timer_seconds = v_left,
           speed_window = v_left,
           deadline = null,
           launched_at = now()
     where id = v_act.id returning * into v_act;
  end if;

  return row_to_json(v_act)::jsonb;
end;
$fn$;

create or replace function public.set_participant_team(p_room_id uuid, p_participant_id uuid, p_team text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_row public.participants%rowtype;
begin
  if not exists (select 1 from public.rooms where id = p_room_id and teacher_id = auth.uid()) then
    raise exception 'room_not_found' using errcode = 'P0002';
  end if;

  update public.participants
     set team = nullif(trim(coalesce(p_team,'')), '')
   where id = p_participant_id and room_id = p_room_id
   returning * into v_row;

  if v_row.id is null then raise exception 'participant_not_found' using errcode = 'P0002'; end if;
  return row_to_json(v_row)::jsonb;
end;
$fn$;

create or replace function public.auto_assign_teams(p_room_id uuid, p_team_count integer default 2)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_total integer; i integer;
begin
  if not exists (select 1 from public.rooms where id = p_room_id and teacher_id = auth.uid()) then
    raise exception 'room_not_found' using errcode = 'P0002';
  end if;
  p_team_count := least(greatest(coalesce(p_team_count,2),2), 6);

  select count(*)::int into v_total from public.participants where room_id = p_room_id;
  if v_total = 0 then return jsonb_build_object('teams', 0); end if;

  with ordered as (
    select id, row_number() over (order by joined_at) - 1 as rn
      from public.participants where room_id = p_room_id
  )
  update public.participants p
     set team = 'Team ' || chr((65 + (o.rn % p_team_count::bigint))::int)
    from ordered o
   where p.id = o.id;

  return jsonb_build_object('teams', p_team_count, 'assigned', v_total);
end;
$fn$;

create or replace function public.decide_challenge(p_room_id uuid, p_challenge_id uuid, p_approve boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_row public.challenges%rowtype; v_bonus integer := 50;
begin
  if not exists (select 1 from public.rooms where id = p_room_id and teacher_id = auth.uid()) then
    raise exception 'room_not_found' using errcode = 'P0002';
  end if;

  update public.challenges
     set status = case when p_approve then 'approved' else 'rejected' end,
         xp_bonus = case when p_approve then v_bonus else 0 end
   where id = p_challenge_id and room_id = p_room_id and status = 'pending'
   returning * into v_row;

  if v_row.id is null then raise exception 'challenge_not_found' using errcode = 'P0002'; end if;

  if p_approve then
    update public.participants set xp = xp + v_bonus where id = v_row.participant_id;
  end if;

  return row_to_json(v_row)::jsonb;
end;
$fn$;

create or replace function public.set_room_settings(p_room_id uuid, p_settings jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_row public.rooms%rowtype;
begin
  update public.rooms
     set settings = coalesce(p_settings, '{}'::jsonb)::jsonb
   where id = p_room_id and teacher_id = auth.uid()
   returning * into v_row;
  if v_row.id is null then raise exception 'room_not_found' using errcode = 'P0002'; end if;
  return row_to_json(v_row)::jsonb;
end;
$fn$;

-- ----------------------------------------------------------------------------
-- 11. Grants — students may only execute the RPCs, never touch tables
-- ----------------------------------------------------------------------------

do $g$
declare f text;
begin
  for f in
    select quote_ident(p.proname) || '(' || pg_get_function_identity_arguments(p.oid) || ')'
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in (
         'create_room','close_room','expire_stale_rooms','gen_room_code',
         'join_room','get_room_state','submit_answer','submit_challenge','set_confidence',
         'leaderboard','get_session_summary','get_teacher_state','launch_activity',
         'set_activity_state','close_activity','pause_timer','set_participant_team',
         'auto_assign_teams','decide_challenge','set_room_settings',
         'speed_bonus','streak_milestone','hash_token','is_numerical_correct'
       )
  loop
    execute 'revoke execute on function ' || f || ' from public, anon';
  end loop;
end;
$g$;

grant execute on function public.join_room(text, text) to anon, authenticated;
grant execute on function public.get_room_state(text) to anon, authenticated;
grant execute on function public.submit_answer(text, uuid, jsonb, integer) to anon, authenticated;
grant execute on function public.submit_challenge(text, uuid, text) to anon, authenticated;
grant execute on function public.set_confidence(text, uuid, integer) to anon, authenticated;
-- hash_token / speed_bonus / streak_milestone / is_numerical_correct stay
-- revoked from anon: nothing client-side calls them, they are only ever used
-- from inside the SECURITY DEFINER functions above.
grant execute on function public.expire_stale_rooms() to authenticated;
grant execute on function public.create_room(text) to authenticated;
grant execute on function public.close_room(uuid) to authenticated;
grant execute on function public.leaderboard(uuid, text, integer) to authenticated;
grant execute on function public.get_session_summary(uuid) to authenticated;
grant execute on function public.get_teacher_state(uuid) to authenticated;
grant execute on function public.launch_activity(uuid, text, text, jsonb, jsonb, integer, text, text, text, uuid) to authenticated;
grant execute on function public.set_activity_state(uuid, text) to authenticated;
grant execute on function public.close_activity(uuid) to authenticated;
grant execute on function public.pause_timer(uuid) to authenticated;
grant execute on function public.set_participant_team(uuid, uuid, text) to authenticated;
grant execute on function public.auto_assign_teams(uuid, integer) to authenticated;
grant execute on function public.decide_challenge(uuid, uuid, boolean) to authenticated;
grant execute on function public.set_room_settings(uuid, jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- 12. Realtime broadcast helper
--    Lets any SECURITY DEFINER RPC ping every browser in a room. The payload
--    carries no answers — clients refetch authoritative state on receipt.
-- ----------------------------------------------------------------------------

create or replace function public.ping_room(p_room_id uuid, p_event text default 'refresh')
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  perform pg_notify('rain_of_physics', jsonb_build_object(
    'room', p_room_id, 'event', p_event
  )::text);
  return true;
exception when others then
  return false;
end;
$fn$;

revoke execute on function public.ping_room(uuid, text) from public, anon;
grant execute on function public.ping_room(uuid, text) to authenticated;

-- Done.
select 'Rain of Physics schema installed' as result;
