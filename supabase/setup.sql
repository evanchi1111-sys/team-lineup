-- =====================================================================
-- 桌球團體賽排點系統：Supabase 資料庫設定
-- 資料表一律以 tl_ 開頭，可以和其他系統（例如雙打計分）共用同一個 Supabase 專案。
-- 用法：Supabase → SQL Editor → New query → 貼上全部內容 → Run
-- 可以重複執行，不會清掉已有的資料。
-- =====================================================================

-- ---------- 1. 資料表 ----------

create table if not exists public.tl_settings (
  id              int primary key default 1 check (id = 1),
  title           text not null default '桌球團體賽排點系統' check (char_length(title) between 1 and 40),
  match_system    int  not null default 5 check (match_system in (3, 5)),   -- 3 點制（單雙雙）或 5 點制（單雙單雙單）
  games_per_point int  not null default 5 check (games_per_point in (3, 5)), -- 每一點打三局兩勝或五局三勝
  min_players_3   int  not null default 6 check (min_players_3 between 5 and 30),
  min_players_5   int  not null default 7 check (min_players_5 between 7 and 30),
  updated_at      timestamptz not null default now()
);
insert into public.tl_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.tl_teams (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique check (char_length(btrim(name)) between 1 and 10),
  created_at timestamptz not null default now()
);

-- 隊伍密碼與錯誤次數（不開放給網頁讀取，只能透過下方的函式驗證）
create table if not exists public.tl_team_secrets (
  team_id      uuid primary key references public.tl_teams(id) on delete cascade,
  passcode     text not null check (char_length(passcode) between 4 and 20),
  failed       int  not null default 0,
  locked_until timestamptz
);

create table if not exists public.tl_players (
  id         uuid primary key default gen_random_uuid(),
  team_id    uuid not null references public.tl_teams(id) on delete cascade,
  name       text not null check (char_length(btrim(name)) between 1 and 20),
  created_at timestamptz not null default now(),
  unique (team_id, name)
);

create table if not exists public.tl_matches (
  id              uuid primary key default gen_random_uuid(),
  round           int  not null default 1 check (round >= 1),
  seq             int  not null default 0,
  team_a_id       uuid not null references public.tl_teams(id) on delete cascade,
  team_b_id       uuid not null references public.tl_teams(id) on delete cascade,
  match_system    int  not null check (match_system in (3, 5)),
  games_per_point int  not null check (games_per_point in (3, 5)),
  scores          jsonb not null default '{}'::jsonb check (jsonb_typeof(scores) = 'object'), -- {"p1":[[11,8],[9,11]], ...}
  status          text not null default 'scheduled' check (status in ('scheduled', 'live', 'completed')),
  winner_id       uuid references public.tl_teams(id) on delete set null,
  published       boolean not null default true,
  notes           text not null default '' check (char_length(notes) <= 100),
  a_locked        boolean not null default false,
  b_locked        boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (team_a_id <> team_b_id)
);
create index if not exists tl_matches_round_idx on public.tl_matches (round, seq);

-- 各場比賽各隊的排點（不開放給網頁讀取；雙方都鎖定後才透過 tl_public_lineups 公布）
create table if not exists public.tl_lineups (
  match_id   uuid not null references public.tl_matches(id) on delete cascade,
  team_id    uuid not null references public.tl_teams(id) on delete cascade,
  slots      jsonb not null default '{}'::jsonb check (jsonb_typeof(slots) = 'object'), -- {"p1":["選手id"],"p2":["id","id"],...}
  updated_at timestamptz not null default now(),
  primary key (match_id, team_id)
);

-- 主辦帳號名單（只能在 SQL 修改，網頁讀不到）
create table if not exists public.tl_organizers (
  email text primary key
);

-- ---------- 2. 共用函式 ----------

create or replace function public.tl_is_organizer()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.tl_organizers
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- 驗證隊伍密碼。通過回傳 null，否則回傳錯誤訊息。連續錯 5 次鎖 5 分鐘。
-- 注意：呼叫的函式不可用 raise 結束，否則錯誤次數的紀錄會被一起復原。
create or replace function public.tl__verify(p_team uuid, p_passcode text)
returns text language plpgsql security definer set search_path = public as $$
declare
  s public.tl_team_secrets%rowtype;
begin
  select * into s from public.tl_team_secrets where team_id = p_team for update;
  if not found then
    return '找不到這個隊伍';
  end if;
  if s.locked_until is not null and s.locked_until > now() then
    return format('密碼錯誤次數過多，請 %s 分鐘後再試', ceil(extract(epoch from (s.locked_until - now())) / 60)::int);
  end if;
  if s.passcode = coalesce(p_passcode, '') then
    if s.failed > 0 or s.locked_until is not null then
      update public.tl_team_secrets set failed = 0, locked_until = null where team_id = p_team;
    end if;
    return null;
  end if;
  if s.failed + 1 >= 5 then
    update public.tl_team_secrets set failed = 0, locked_until = now() + interval '5 minutes' where team_id = p_team;
    return '密碼錯誤次數過多，請 5 分鐘後再試';
  end if;
  update public.tl_team_secrets set failed = s.failed + 1 where team_id = p_team;
  return '隊伍密碼錯誤';
end $$;
revoke execute on function public.tl__verify(uuid, text) from public, anon, authenticated;

create or replace function public.tl__fail(p_message text)
returns jsonb language sql immutable as $$
  select jsonb_build_object('ok', false, 'error', p_message);
$$;

-- ---------- 3. 隊伍使用的函式（以隊伍密碼驗證） ----------

create or replace function public.tl_team_login(p_team uuid, p_passcode text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_err text := public.tl__verify(p_team, p_passcode);
begin
  if v_err is not null then return public.tl__fail(v_err); end if;
  return jsonb_build_object('ok', true);
end $$;

-- 隊伍自己的資料：所有自己的對戰（含未公布）、自己的排點、已公布的對手排點
create or replace function public.tl_team_data(p_team uuid, p_passcode text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_err text := public.tl__verify(p_team, p_passcode);
begin
  if v_err is not null then return public.tl__fail(v_err); end if;
  return jsonb_build_object(
    'ok', true,
    'matches', coalesce((
      select jsonb_agg(to_jsonb(m) order by m.round, m.seq)
      from public.tl_matches m
      where m.team_a_id = p_team or m.team_b_id = p_team), '[]'::jsonb),
    'lineups', coalesce((
      select jsonb_agg(jsonb_build_object('match_id', l.match_id, 'team_id', l.team_id, 'slots', l.slots))
      from public.tl_lineups l
      join public.tl_matches m on m.id = l.match_id
      where (m.team_a_id = p_team or m.team_b_id = p_team)
        and (l.team_id = p_team or (m.a_locked and m.b_locked))), '[]'::jsonb)
  );
end $$;

create or replace function public.tl_team_add_player(p_team uuid, p_passcode text, p_name text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_err  text := public.tl__verify(p_team, p_passcode);
  v_name text := btrim(coalesce(p_name, ''));
begin
  if v_err is not null then return public.tl__fail(v_err); end if;
  if char_length(v_name) not between 1 and 20 then return public.tl__fail('選手姓名需為 1～20 個字'); end if;
  if exists (select 1 from public.tl_players where team_id = p_team and name = v_name) then
    return public.tl__fail('隊上已經有同名的選手');
  end if;
  insert into public.tl_players (team_id, name) values (p_team, v_name);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.tl_team_remove_player(p_team uuid, p_passcode text, p_player uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_err text := public.tl__verify(p_team, p_passcode);
begin
  if v_err is not null then return public.tl__fail(v_err); end if;
  if exists (
    select 1
    from public.tl_lineups l
    join public.tl_matches m on m.id = l.match_id
    cross join lateral jsonb_each(l.slots) e
    cross join lateral jsonb_array_elements_text(e.value) x
    where l.team_id = p_team
      and ((m.team_a_id = p_team and m.a_locked) or (m.team_b_id = p_team and m.b_locked))
      and x = p_player::text
  ) then
    return public.tl__fail('這位選手已在鎖定的排點中，無法刪除');
  end if;
  delete from public.tl_players where id = p_player and team_id = p_team;
  return jsonb_build_object('ok', true);
end $$;

-- 儲存排點。p_lock = true 鎖定送出（完整檢查）；false 儲存草稿，或在已鎖定時解除鎖定
create or replace function public.tl_team_save_lineup(p_team uuid, p_passcode text, p_match uuid, p_slots jsonb, p_lock boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_err     text := public.tl__verify(p_team, p_passcode);
  m         public.tl_matches%rowtype;
  v_is_a    boolean;
  v_mine    boolean;
  v_points  text[];
  v_sizes   int[];
  v_labels  text[];
  v_min     int;
  v_arr     jsonb;
  v_filled  text[];
  v_all     text[] := '{}';
  v_clean   jsonb := '{}'::jsonb;
  v_bad     int;
begin
  if v_err is not null then return public.tl__fail(v_err); end if;

  select * into m from public.tl_matches where id = p_match for update;
  if not found or (m.team_a_id <> p_team and m.team_b_id <> p_team) then
    return public.tl__fail('這場比賽不屬於你的隊伍');
  end if;
  v_is_a := m.team_a_id = p_team;
  v_mine := case when v_is_a then m.a_locked else m.b_locked end;

  if m.a_locked and m.b_locked then
    return public.tl__fail('雙方都已鎖定，排點已公布，無法再修改');
  end if;

  if v_mine then
    if p_lock then return public.tl__fail('排點已經鎖定，如需修改請先解除鎖定'); end if;
    -- 對手還沒鎖定，可以解除鎖定
    if v_is_a then update public.tl_matches set a_locked = false, updated_at = now() where id = p_match;
    else update public.tl_matches set b_locked = false, updated_at = now() where id = p_match; end if;
    return jsonb_build_object('ok', true);
  end if;

  if m.match_system = 3 then
    v_points := array['p1','p2','p3']; v_sizes := array[1,2,2];
    v_labels := array['第一點（單打）','第二點（雙打）','第三點（雙打）'];
  else
    v_points := array['p1','p2','p3','p4','p5']; v_sizes := array[1,2,1,2,1];
    v_labels := array['第一點（單打）','第二點（雙打）','第三點（單打）','第四點（雙打）','第五點（單打）'];
  end if;

  if p_slots is null or jsonb_typeof(p_slots) <> 'object' then return public.tl__fail('排點格式錯誤'); end if;

  -- 草稿可以有空位（""），讓畫面上的選單位置不跳動；鎖定時必須排滿
  for i in 1 .. array_length(v_points, 1) loop
    v_arr := coalesce(p_slots -> v_points[i], '[]'::jsonb);
    if jsonb_typeof(v_arr) <> 'array' or jsonb_array_length(v_arr) > v_sizes[i] then
      return public.tl__fail(v_labels[i] || ' 格式錯誤');
    end if;
    v_filled := array(select x from jsonb_array_elements_text(v_arr) x where x <> '');
    if p_lock and coalesce(cardinality(v_filled), 0) <> v_sizes[i] then
      return public.tl__fail(v_labels[i] || ' 尚未排滿');
    end if;
    v_all := v_all || v_filled;
    v_clean := v_clean || jsonb_build_object(v_points[i], case when p_lock then to_jsonb(v_filled) else v_arr end);
  end loop;

  if (select count(*) from unnest(v_all)) <> (select count(distinct x) from unnest(v_all) x) then
    return public.tl__fail('同一位選手不能重複出賽');
  end if;
  select count(*) into v_bad from unnest(v_all) x
  where not exists (select 1 from public.tl_players p where p.id::text = x and p.team_id = p_team);
  if v_bad > 0 then return public.tl__fail('排點中有不屬於本隊的選手，請重新選擇'); end if;

  if p_lock then
    select case when m.match_system = 3 then min_players_3 else min_players_5 end into v_min
    from public.tl_settings where id = 1;
    if (select count(*) from public.tl_players where team_id = p_team) < v_min then
      return public.tl__fail(format('隊伍登錄選手需至少 %s 人', v_min));
    end if;
  end if;

  insert into public.tl_lineups (match_id, team_id, slots, updated_at)
  values (p_match, p_team, v_clean, now())
  on conflict (match_id, team_id) do update set slots = excluded.slots, updated_at = now();

  if p_lock then
    if v_is_a then update public.tl_matches set a_locked = true, updated_at = now() where id = p_match;
    else update public.tl_matches set b_locked = true, updated_at = now() where id = p_match; end if;
    -- 雙方都鎖定後自動公布這場對戰
    update public.tl_matches set published = true where id = p_match and a_locked and b_locked;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- 所有人可讀：雙方都已鎖定的排點
create or replace function public.tl_public_lineups()
returns table (match_id uuid, team_id uuid, slots jsonb)
language sql stable security definer set search_path = public as $$
  select l.match_id, l.team_id, l.slots
  from public.tl_lineups l
  join public.tl_matches m on m.id = l.match_id
  where m.a_locked and m.b_locked and (m.published or public.tl_is_organizer());
$$;

-- ---------- 4. 主辦使用的函式 ----------

create or replace function public.tl_admin_create_team(p_name text, p_passcode text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_code text := nullif(btrim(coalesce(p_passcode, '')), '');
  v_id   uuid;
begin
  if not public.tl_is_organizer() then return public.tl__fail('沒有主辦權限，請重新登入'); end if;
  if char_length(v_name) not between 1 and 10 then return public.tl__fail('隊名需為 1～10 個字'); end if;
  if exists (select 1 from public.tl_teams where name = v_name) then return public.tl__fail('已經有同名的隊伍'); end if;
  if v_code is null then v_code := lpad(floor(random() * 1000000)::int::text, 6, '0'); end if;
  if char_length(v_code) not between 4 and 20 then return public.tl__fail('隊伍密碼需為 4～20 個字元'); end if;
  insert into public.tl_teams (name) values (v_name) returning id into v_id;
  insert into public.tl_team_secrets (team_id, passcode) values (v_id, v_code);
  return jsonb_build_object('ok', true, 'id', v_id, 'passcode', v_code);
end $$;

create or replace function public.tl_admin_set_passcode(p_team uuid, p_passcode text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_code text := nullif(btrim(coalesce(p_passcode, '')), '');
begin
  if not public.tl_is_organizer() then return public.tl__fail('沒有主辦權限，請重新登入'); end if;
  if v_code is null then v_code := lpad(floor(random() * 1000000)::int::text, 6, '0'); end if;
  if char_length(v_code) not between 4 and 20 then return public.tl__fail('隊伍密碼需為 4～20 個字元'); end if;
  insert into public.tl_team_secrets (team_id, passcode) values (p_team, v_code)
  on conflict (team_id) do update set passcode = excluded.passcode, failed = 0, locked_until = null;
  return jsonb_build_object('ok', true, 'passcode', v_code);
end $$;

create or replace function public.tl_admin_passcodes()
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.tl_is_organizer() then return public.tl__fail('沒有主辦權限，請重新登入'); end if;
  return jsonb_build_object('ok', true, 'passcodes',
    coalesce((select jsonb_object_agg(team_id, passcode) from public.tl_team_secrets), '{}'::jsonb));
end $$;

-- ---------- 5. 安全規則（由伺服器執行，網頁無法略過） ----------

alter table public.tl_settings     enable row level security;
alter table public.tl_teams        enable row level security;
alter table public.tl_team_secrets enable row level security;  -- 不設規則 = 網頁完全無法存取
alter table public.tl_players      enable row level security;
alter table public.tl_matches      enable row level security;
alter table public.tl_lineups      enable row level security;
alter table public.tl_organizers   enable row level security;  -- 不設規則 = 網頁完全無法存取

do $$
declare
  t text;
begin
  -- 所有人可讀、只有主辦可寫
  foreach t in array array['tl_settings', 'tl_teams', 'tl_players'] loop
    execute format('drop policy if exists "public read" on public.%I', t);
    execute format('create policy "public read" on public.%I for select using (true)', t);
  end loop;
  -- 主辦可完整讀寫
  foreach t in array array['tl_settings', 'tl_teams', 'tl_players', 'tl_matches', 'tl_lineups'] loop
    execute format('drop policy if exists "organizer all" on public.%I', t);
    execute format(
      'create policy "organizer all" on public.%I for all to authenticated
         using (public.tl_is_organizer()) with check (public.tl_is_organizer())', t);
  end loop;
end $$;

-- 對戰：所有人只能看到已公布的場次（隊伍透過 tl_team_data 看自己的全部場次）
drop policy if exists "public read published" on public.tl_matches;
create policy "public read published" on public.tl_matches for select using (published);
-- tl_lineups 刻意不開放公開讀取：鎖定前任何人（包含對手）都讀不到

-- ---------- 6. 即時同步 ----------

do $$
declare
  t text;
begin
  foreach t in array array['tl_settings', 'tl_teams', 'tl_players', 'tl_matches'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------- 7. 主辦帳號 ----------
-- 這個 email 必須與 js/config.js 的 ORGANIZER_EMAIL、以及 Authentication → Users 的帳號相同。
-- 想讓其他帳號也能管理，多加幾行 insert 即可。
insert into public.tl_organizers (email) values ('organizer@dsc-table-tennis.app')
on conflict (email) do nothing;
