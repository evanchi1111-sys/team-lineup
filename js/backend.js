import { SUPABASE_URL, SUPABASE_ANON_KEY, ORGANIZER_EMAIL } from './config.js';
import { validateLineup, minPlayersFor, systemOf } from './rules.js';

export const DEFAULT_SETTINGS = { id: 1, title: '桌球團體賽排點系統', match_system: 5, games_per_point: 5, min_players_3: 6, min_players_5: 7 };

export function isConfigured() {
  return /^https:\/\/.+/.test(SUPABASE_URL) && SUPABASE_ANON_KEY.length > 20;
}

export async function createBackend({ demo }) {
  return demo ? createDemoBackend() : createSupabaseBackend();
}

function friendlyError(error) {
  const msg = String(error?.message || error || '');
  if (/invalid login credentials/i.test(msg)) return new Error('帳號或密碼錯誤');
  if (/row-level security|permission denied|42501/i.test(msg) || error?.code === '42501') return new Error('沒有寫入權限，請重新登入主辦帳號');
  if (/duplicate key|23505/i.test(msg) || error?.code === '23505') return new Error('名稱重複，請換一個');
  if (/password should be at least|weak password/i.test(msg)) return new Error('密碼至少需要 6 個字元');
  if (/same.*password|different from the old/i.test(msg)) return new Error('新密碼不能和舊密碼相同');
  if (/failed to fetch|network/i.test(msg)) return new Error('網路連線失敗，請檢查網路後再試');
  if (/could not find the function|tl_/i.test(msg) && /schema cache|does not exist/i.test(msg)) return new Error('資料庫尚未設定，請先執行 supabase/setup.sql');
  return new Error(msg || '發生未知錯誤');
}

// ---------------------------------------------------------------- Supabase

async function createSupabaseBackend() {
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  const check = ({ data, error }) => {
    if (error) throw friendlyError(error);
    return data;
  };
  // 被安全規則擋下的 update/delete 不會報錯，只會影響 0 列
  const mustAffect = (result) => {
    const rows = check(result);
    if (!rows || rows.length === 0) throw new Error('沒有寫入權限，請重新登入主辦帳號');
    return rows;
  };
  // 我們自己的 RPC 以 { ok, error } 回報結果
  const rpc = async (name, args) => {
    const data = check(await sb.rpc(name, args));
    if (data && data.ok === false) throw new Error(data.error || '操作失敗');
    return data;
  };
  const now = () => new Date().toISOString();

  return {
    async load() {
      const [settings, teams, players, matches, lineups] = await Promise.all([
        sb.from('tl_settings').select('*').eq('id', 1).maybeSingle(),
        sb.from('tl_teams').select('*').order('created_at').order('name'),
        sb.from('tl_players').select('*').order('created_at').order('name'),
        sb.from('tl_matches').select('*').order('round').order('seq'),
        sb.rpc('tl_public_lineups'),
      ]);
      return {
        settings: check(settings) || { ...DEFAULT_SETTINGS },
        teams: check(teams),
        players: check(players),
        matches: check(matches),
        lineups: check(lineups),
      };
    },
    subscribe(onChange, onStatus = () => {}) {
      const channel = sb.channel('team-lineup');
      for (const table of ['tl_settings', 'tl_teams', 'tl_players', 'tl_matches']) {
        channel.on('postgres_changes', { event: '*', schema: 'public', table }, onChange);
      }
      channel.subscribe((status) => onStatus(status));
      return () => sb.removeChannel(channel);
    },

    // ----- 主辦帳號 -----
    async getUser() {
      const { data } = await sb.auth.getSession();
      return data.session?.user ?? null;
    },
    onAuthChange(callback) {
      const { data } = sb.auth.onAuthStateChange((_event, session) => callback(session?.user ?? null));
      return () => data.subscription.unsubscribe();
    },
    async signIn(email, password) {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw friendlyError(error);
    },
    async signOut() {
      await sb.auth.signOut();
    },
    async changePassword(email, currentPassword, newPassword) {
      const verify = await sb.auth.signInWithPassword({ email, password: currentPassword });
      if (verify.error) throw new Error('目前密碼錯誤');
      const { error } = await sb.auth.updateUser({ password: newPassword });
      if (error) throw friendlyError(error);
    },

    // ----- 隊伍（以隊伍密碼驗證） -----
    teamLogin: (team, code) => rpc('tl_team_login', { p_team: team, p_passcode: code }),
    teamData: (team, code) => rpc('tl_team_data', { p_team: team, p_passcode: code }),
    teamAddPlayer: (team, code, name) => rpc('tl_team_add_player', { p_team: team, p_passcode: code, p_name: name }),
    teamRemovePlayer: (team, code, player) => rpc('tl_team_remove_player', { p_team: team, p_passcode: code, p_player: player }),
    teamSaveLineup: (team, code, match, slots, lock) =>
      rpc('tl_team_save_lineup', { p_team: team, p_passcode: code, p_match: match, p_slots: slots, p_lock: lock }),

    // ----- 主辦 -----
    adminCreateTeam: (name, passcode) => rpc('tl_admin_create_team', { p_name: name, p_passcode: passcode || null }),
    adminSetPasscode: (team, passcode) => rpc('tl_admin_set_passcode', { p_team: team, p_passcode: passcode || null }),
    async adminPasscodes() {
      return (await rpc('tl_admin_passcodes', {})).passcodes || {};
    },
    async adminAllMatches() {
      return check(await sb.from('tl_matches').select('*').order('round').order('seq'));
    },
    async adminRenameTeam(id, name) {
      mustAffect(await sb.from('tl_teams').update({ name }).eq('id', id).select());
    },
    async adminDeleteTeam(id) {
      mustAffect(await sb.from('tl_teams').delete().eq('id', id).select());
    },
    async adminAddPlayers(rows) {
      check(await sb.from('tl_players').insert(rows));
    },
    async adminRemovePlayer(id) {
      mustAffect(await sb.from('tl_players').delete().eq('id', id).select());
    },
    async adminUpdateSettings(patch) {
      mustAffect(await sb.from('tl_settings').update({ ...patch, updated_at: now() }).eq('id', 1).select());
    },
    async adminCreateMatches(rows) {
      check(await sb.from('tl_matches').insert(rows));
    },
    async adminUpdateMatch(id, patch) {
      mustAffect(await sb.from('tl_matches').update({ ...patch, updated_at: now() }).eq('id', id).select());
    },
    async adminDeleteMatch(id) {
      mustAffect(await sb.from('tl_matches').delete().eq('id', id).select());
    },
    async adminWipe() {
      await this.adminUpdateSettings({});
      check(await sb.from('tl_matches').delete().not('id', 'is', null));
      check(await sb.from('tl_teams').delete().not('id', 'is', null));
    },
  };
}

// ---------------------------------------------------------------- 示範模式
// 資料只存在這個分頁的記憶體裡；規則與伺服器相同（排點在雙方鎖定前不會公開）。

function createDemoBackend() {
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
  const t0 = Date.now();
  const stamp = (i) => new Date(t0 + i).toISOString();
  const db = { settings: { ...DEFAULT_SETTINGS }, teams: [], secrets: {}, players: [], matches: [], lineups: [] };
  const DEMO_PASSWORD = 'demo1234';

  const sample = [
    ['東區鐵人', '1111', ['陳志明', '林建宏', '黃俊傑', '張家豪', '李承翰', '王冠宇', '吳宗憲', '劉育成']],
    ['西區旋風', '2222', ['蔡明哲', '鄭凱文', '謝宗翰', '許家銘', '郭建志', '洪偉倫', '邱冠廷']],
    ['南港飛龍', '3333', ['周子豪', '曾柏翰', '彭俊宏', '游志偉', '詹凱翔', '葉承恩', '潘彥廷']],
    ['北城猛虎', '4444', ['楊博文', '蕭志遠', '賴俊男', '江冠霖', '范世豪', '石育德']],
  ];
  sample.forEach(([name, code, names], i) => {
    const id = uid();
    db.teams.push({ id, name, created_at: stamp(i) });
    db.secrets[id] = code;
    names.forEach((n, j) => db.players.push({ id: uid(), team_id: id, name: n, created_at: stamp(i * 100 + j) }));
  });

  let user = null;
  const dataListeners = new Set();
  const authListeners = new Set();
  const emit = () => setTimeout(() => dataListeners.forEach((fn) => fn()), 30);
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const fail = (msg) => { throw new Error(msg); };
  const requireOrganizer = () => { if (!user) fail('沒有主辦權限，請重新登入'); };
  const verify = (team, code) => {
    if (!(team in db.secrets)) fail('找不到這個隊伍');
    if (db.secrets[team] !== code) fail('隊伍密碼錯誤');
  };
  const revealed = (m) => m.a_locked && m.b_locked;

  return {
    isDemo: true,
    demoPassword: DEMO_PASSWORD,
    demoTeamCodes: Object.fromEntries(sample.map(([name, code]) => [name, code])),
    async load() {
      const visible = db.matches.filter((m) => m.published || user);
      return {
        settings: clone(db.settings),
        teams: clone(db.teams),
        players: clone(db.players),
        matches: clone(visible),
        lineups: clone(db.lineups.filter((l) => {
          const m = db.matches.find((x) => x.id === l.match_id);
          return m && revealed(m) && (m.published || user);
        })),
      };
    },
    subscribe(onChange, onStatus = () => {}) {
      dataListeners.add(onChange);
      setTimeout(() => onStatus('SUBSCRIBED'), 0);
      return () => dataListeners.delete(onChange);
    },
    async getUser() { return user; },
    onAuthChange(cb) { authListeners.add(cb); return () => authListeners.delete(cb); },
    async signIn(email, password) {
      if (email.toLowerCase() !== ORGANIZER_EMAIL.toLowerCase() || password !== DEMO_PASSWORD) fail('帳號或密碼錯誤');
      user = { email: ORGANIZER_EMAIL };
      authListeners.forEach((fn) => fn(user));
    },
    async signOut() { user = null; authListeners.forEach((fn) => fn(null)); },
    async changePassword() { fail('示範模式無法變更密碼'); },

    async teamLogin(team, code) { verify(team, code); return { ok: true }; },
    async teamData(team, code) {
      verify(team, code);
      const matches = db.matches.filter((m) => m.team_a_id === team || m.team_b_id === team);
      const ids = new Set(matches.map((m) => m.id));
      const lineups = db.lineups.filter((l) => ids.has(l.match_id) && (l.team_id === team || revealed(db.matches.find((m) => m.id === l.match_id))));
      return { ok: true, matches: clone(matches), lineups: clone(lineups) };
    },
    async teamAddPlayer(team, code, name) {
      verify(team, code);
      const n = String(name || '').trim();
      if (!n || n.length > 20) fail('選手姓名需為 1～20 個字');
      if (db.players.some((p) => p.team_id === team && p.name === n)) fail('隊上已經有同名的選手');
      db.players.push({ id: uid(), team_id: team, name: n, created_at: new Date().toISOString() });
      emit();
      return { ok: true };
    },
    async teamRemovePlayer(team, code, player) {
      verify(team, code);
      const inLocked = db.lineups.some((l) => {
        const m = db.matches.find((x) => x.id === l.match_id);
        const mine = m.team_a_id === team ? m.a_locked : m.b_locked;
        return l.team_id === team && mine && Object.values(l.slots).flat().includes(player);
      });
      if (inLocked) fail('這位選手已在鎖定的排點中，無法刪除');
      db.players = db.players.filter((p) => !(p.id === player && p.team_id === team));
      emit();
      return { ok: true };
    },
    async teamSaveLineup(team, code, matchId, slots, lock) {
      verify(team, code);
      const m = db.matches.find((x) => x.id === matchId);
      if (!m || (m.team_a_id !== team && m.team_b_id !== team)) fail('這場比賽不屬於你的隊伍');
      const isA = m.team_a_id === team;
      const mine = isA ? m.a_locked : m.b_locked;
      if (revealed(m)) fail('雙方都已鎖定，排點已公布，無法再修改');
      if (mine) {
        if (lock) fail('排點已經鎖定，如需修改請先解除鎖定');
        if (isA) m.a_locked = false; else m.b_locked = false;
        emit();
        return { ok: true };
      }
      const players = db.players.filter((p) => p.team_id === team);
      const filled = Object.fromEntries(systemOf(m.match_system).points.map((pt) => [pt.key, (slots[pt.key] || []).filter(Boolean)]));
      const errors = validateLineup({ slots: filled, matchSystem: m.match_system, players, minPlayers: minPlayersFor(db.settings, m.match_system), forLock: lock });
      if (errors.length) fail(errors[0]);
      // 與伺服器相同：草稿保留空位，鎖定時存去掉空位的版本
      const clean = lock ? filled : Object.fromEntries(systemOf(m.match_system).points.map((pt) => [pt.key, [...(slots[pt.key] || [])]]));
      const existing = db.lineups.find((l) => l.match_id === matchId && l.team_id === team);
      if (existing) existing.slots = clean;
      else db.lineups.push({ match_id: matchId, team_id: team, slots: clean });
      if (lock) {
        if (isA) m.a_locked = true; else m.b_locked = true;
        if (revealed(m)) m.published = true;
      }
      emit();
      return { ok: true };
    },

    async adminCreateTeam(name, passcode) {
      requireOrganizer();
      const n = String(name || '').trim();
      if (!n || n.length > 10) fail('隊名需為 1～10 個字');
      if (db.teams.some((t) => t.name === n)) fail('已經有同名的隊伍');
      const code = passcode || String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
      if (code.length < 4 || code.length > 20) fail('隊伍密碼需為 4～20 個字元');
      const id = uid();
      db.teams.push({ id, name: n, created_at: new Date().toISOString() });
      db.secrets[id] = code;
      emit();
      return { ok: true, id, passcode: code };
    },
    async adminSetPasscode(team, passcode) {
      requireOrganizer();
      const code = passcode || String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
      if (code.length < 4 || code.length > 20) fail('隊伍密碼需為 4～20 個字元');
      db.secrets[team] = code;
      return { ok: true, passcode: code };
    },
    async adminPasscodes() { requireOrganizer(); return { ...db.secrets }; },
    async adminAllMatches() { requireOrganizer(); return clone(db.matches); },
    async adminRenameTeam(id, name) {
      requireOrganizer();
      if (db.teams.some((t) => t.name === name && t.id !== id)) fail('名稱重複，請換一個');
      db.teams.find((t) => t.id === id).name = name;
      emit();
    },
    async adminDeleteTeam(id) {
      requireOrganizer();
      db.teams = db.teams.filter((t) => t.id !== id);
      db.players = db.players.filter((p) => p.team_id !== id);
      const gone = new Set(db.matches.filter((m) => m.team_a_id === id || m.team_b_id === id).map((m) => m.id));
      db.matches = db.matches.filter((m) => !gone.has(m.id));
      db.lineups = db.lineups.filter((l) => !gone.has(l.match_id) && l.team_id !== id);
      delete db.secrets[id];
      emit();
    },
    async adminAddPlayers(rows) {
      requireOrganizer();
      for (const r of rows) {
        if (db.players.some((p) => p.team_id === r.team_id && p.name === r.name)) fail('名稱重複，請換一個');
        db.players.push({ id: uid(), created_at: new Date().toISOString(), ...r });
      }
      emit();
    },
    async adminRemovePlayer(id) { requireOrganizer(); db.players = db.players.filter((p) => p.id !== id); emit(); },
    async adminUpdateSettings(patch) { requireOrganizer(); Object.assign(db.settings, patch); emit(); },
    async adminCreateMatches(rows) {
      requireOrganizer();
      rows.forEach((r) => db.matches.push({
        id: uid(), scores: {}, status: 'scheduled', winner_id: null, published: true, notes: '', a_locked: false, b_locked: false, ...r,
      }));
      emit();
    },
    async adminUpdateMatch(id, patch) { requireOrganizer(); Object.assign(db.matches.find((m) => m.id === id), patch); emit(); },
    async adminDeleteMatch(id) {
      requireOrganizer();
      db.matches = db.matches.filter((m) => m.id !== id);
      db.lineups = db.lineups.filter((l) => l.match_id !== id);
      emit();
    },
    async adminWipe() {
      requireOrganizer();
      Object.assign(db, { teams: [], secrets: {}, players: [], matches: [], lineups: [] });
      emit();
    },
  };
}
