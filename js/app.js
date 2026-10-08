import { ORGANIZER_EMAIL } from './config.js';
import { createBackend, isConfigured, DEFAULT_SETTINGS } from './backend.js';
import { SYSTEMS, systemOf, gamesToWin, minPlayersFor, validateLineup, gameWinner, isStandardGame, pointResult, matchResult, roundRobin, computeStandings } from './rules.js';
import { exportExcel, lineReport } from './export.js';

const VIEWS = { board: '對戰看板', team: '各隊排點', admin: '主辦管理' };
const ADMIN_TABS = { matches: '對戰與比分', teams: '隊伍與選手', settings: '設定與匯出' };
const BOARD_TABS = { standings: '積分排名', matches: '對戰賽程' };

const demo = new URLSearchParams(location.search).has('demo');
const store = {
  get(key, fallback, area = localStorage) {
    try { return area.getItem(`tl_${key}`) ?? fallback; } catch { return fallback; }
  },
  set(key, value, area = localStorage) {
    try { value == null ? area.removeItem(`tl_${key}`) : area.setItem(`tl_${key}`, value); } catch { /* 忽略 */ }
  },
};

const savedTeam = (() => {
  try { return JSON.parse(store.get('team', 'null', sessionStorage)); } catch { return null; }
})();

const state = {
  loaded: false,
  error: null,
  busy: false,
  live: false,
  settings: { ...DEFAULT_SETTINGS },
  teams: [],
  players: [],
  matches: [],
  lineups: [],
  user: null,
  view: VIEWS[store.get('view')] ? store.get('view') : 'board',
  adminTab: ADMIN_TABS[store.get('adminTab')] ? store.get('adminTab') : 'matches',
  boardTab: BOARD_TABS[store.get('boardTab')] ? store.get('boardTab') : 'standings',
  myTeam: store.get('myTeam', ''),
  team: savedTeam, // { id, code }：各隊排點登入（只存在這個分頁）
  teamData: null,
  teamNotice: null,
  drafts: {}, // 尚未儲存的排點：{ matchId: slots }
  passcodes: {},
};

const app = document.getElementById('app');
const modalRoot = document.getElementById('modal-root');
const toastEl = document.getElementById('toast');
let backend;

// ---------------------------------------------------------------- 小工具

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const teamById = (id) => state.teams.find((t) => t.id === id);
const teamName = (id) => teamById(id)?.name ?? '（已刪除）';
const playersOf = (teamId) => state.players.filter((p) => p.team_id === teamId);
const playerName = (id) => state.players.find((p) => p.id === id)?.name ?? '（已刪除）';
const playerNames = (ids) => (ids || []).filter(Boolean).map(playerName).join('、');
const isOrganizer = () => !!state.user && (state.user.email || '').toLowerCase() === ORGANIZER_EMAIL.toLowerCase();
const statusLabel = (m) => ({ completed: '已完賽', live: '進行中', scheduled: '未開始' })[m.status] || '未開始';
const revealed = (m) => m.a_locked && m.b_locked;
const sortMatches = (list) => [...list].sort((x, y) => x.round - y.round || x.seq - y.seq);
// 草稿保留空位（讓下拉選單位置不跳動）；送出與檢查時去掉空位，並固定欄位順序
const cleanSlots = (slots, matchSystem) =>
  Object.fromEntries(systemOf(matchSystem).points.map((pt) => [pt.key, (slots?.[pt.key] || []).filter(Boolean)]));
// 已公布的排點（看板）＋ 隊伍自己能看到的排點（含自己的草稿）
const lineupOf = (matchId, teamId) => {
  const pool = [...state.lineups, ...(state.teamData?.lineups || [])];
  return pool.find((l) => l.match_id === matchId && l.team_id === teamId)?.slots || null;
};

let toastTimer;
function toast(message, kind = 'info') {
  toastEl.textContent = message;
  toastEl.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = ''; }, 3400);
}

async function run(task, successMessage) {
  if (state.busy) return false;
  state.busy = true;
  render();
  try {
    await task();
    if (successMessage) toast(successMessage, 'ok');
    return true;
  } catch (err) {
    console.error(err);
    toast(err.message || '操作失敗，請再試一次', 'error');
    return false;
  } finally {
    state.busy = false;
    await reload();
  }
}

// ---------------------------------------------------------------- 資料載入與即時同步

let reloadTimer;
const scheduleReload = () => {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(reload, 250);
};

async function reload() {
  try {
    const data = await backend.load();
    Object.assign(state, data, { loaded: true, error: null });
  } catch (err) {
    console.error(err);
    state.error = err.message || '資料讀取失敗';
  }
  if (state.team) {
    try {
      const data = await backend.teamData(state.team.id, state.team.code);
      state.teamData = data;
    } catch (err) {
      // 密碼被主辦重設、隊伍被刪除或嘗試次數過多：登出並提示
      if (!/網路/.test(err.message)) {
        teamLogout(/密碼錯誤$/.test(err.message) ? '隊伍密碼已被主辦單位變更，請取得新密碼後重新登入' : err.message);
      }
    }
  }
  if (isOrganizer() && state.adminTab === 'teams') {
    try { state.passcodes = await backend.adminPasscodes(); } catch { /* 顯示時再提示 */ }
  }
  requestRender();
}

let pendingRender = false;
const isEditing = () => {
  const el = document.activeElement;
  return !!el && app.contains(el) && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
};
function requestRender() {
  if (isEditing()) pendingRender = true;
  else render();
}
app.addEventListener('focusout', () => {
  setTimeout(() => {
    if (pendingRender && !isEditing()) {
      pendingRender = false;
      render();
    }
  }, 0);
});

// ---------------------------------------------------------------- 共用畫面元件

function renderHeader() {
  return `
    <header class="topbar">
      <div class="container topbar-inner">
        <div class="brand">
          <span class="brand-icon" aria-hidden="true">🏓</span>
          <div>
            <h1>${esc(state.settings.title)}</h1>
            ${
              state.live
                ? `<p class="live"><span class="dot" aria-hidden="true"></span>即時更新中</p>`
                : `<p class="live off"><span class="dot" aria-hidden="true"></span>重新連線中，每 15 秒自動更新</p>`
            }
          </div>
        </div>
      </div>
      <nav class="container viewtabs" aria-label="功能">
        ${Object.entries(VIEWS)
          .map(([key, label]) => `<button class="viewtab ${state.view === key ? 'on' : ''}" data-action="view" data-view="${key}" aria-pressed="${state.view === key}">${label}</button>`)
          .join('')}
      </nav>
    </header>`;
}

const chip = (text, kind = '') => `<span class="chip ${kind}">${esc(text)}</span>`;
const lockChip = (locked) => (locked ? chip('🔒 已鎖定', 'ok') : chip('排點中', 'muted'));
const emptyState = (text) => `<div class="empty"><span aria-hidden="true">🏓</span><p>${esc(text)}</p></div>`;

// 一場對戰的各點明細：出賽選手（雙方鎖定後）＋各局比分
function pointTable(m) {
  const r = matchResult(m);
  const show = revealed(m);
  const la = show ? lineupOf(m.id, m.team_a_id) : null;
  const lb = show ? lineupOf(m.id, m.team_b_id) : null;
  let decidedAt = -1;
  let a = 0;
  let b = 0;
  r.points.forEach((pt, i) => {
    if (pt.winner === 1) a++;
    if (pt.winner === 2) b++;
    if (decidedAt < 0 && (a >= systemOf(m.match_system).winPoints || b >= systemOf(m.match_system).winPoints)) decidedAt = i;
  });
  return `
    <div class="points">
      ${r.points
        .map((pt, i) => {
          const skipped = decidedAt >= 0 && i > decidedAt && !pt.games.length;
          const who = (slots) => (slots ? esc(playerNames(slots[pt.key])) || '—' : '🔒');
          return `
            <div class="pt-row ${pt.winner === 1 ? 'win-a' : pt.winner === 2 ? 'win-b' : ''} ${skipped ? 'skipped' : ''}">
              <div class="pt-head"><b>${pt.label}</b><span>${pt.type}</span>${pt.games.length ? `<span class="pt-score">${pt.a} : ${pt.b}</span>` : skipped ? '<span class="pt-score muted">免賽</span>' : ''}</div>
              <div class="pt-players"><span class="pa">${who(la)}</span><span class="vs">vs</span><span class="pb">${who(lb)}</span></div>
              ${pt.games.length ? `<div class="pt-games">${pt.games.map((g) => `<span class="g ${gameWinner(g) === 1 ? 'wa' : 'wb'}">${g[0]}:${g[1]}</span>`).join('')}</div>` : ''}
            </div>`;
        })
        .join('')}
      ${show ? '' : `<p class="note center">🔒 雙方都鎖定排點後，才會公布各點出賽選手</p>`}
    </div>`;
}

function matchHeader(m, mine) {
  const r = matchResult(m);
  const side = (id, locked, isWinner) => `
    <div class="team-side ${isWinner ? 'won' : ''} ${id === mine ? 'me' : ''}">
      <span class="tname">${esc(teamName(id))}</span>
      ${revealed(m) ? '' : lockChip(locked)}
    </div>`;
  return `
    <div class="match-top">
      <span class="status-badge ${m.status}">${statusLabel(m)}</span>
      <span class="fmt">${systemOf(m.match_system).label}・每點${m.games_per_point === 3 ? '三局兩勝' : '五局三勝'}</span>
    </div>
    <div class="vs-row">
      ${side(m.team_a_id, m.a_locked, r.winner === 1)}
      <div class="big-score">${m.status === 'scheduled' ? 'vs' : `${r.a}<span>:</span>${r.b}`}</div>
      ${side(m.team_b_id, m.b_locked, r.winner === 2)}
    </div>
    ${m.notes ? `<p class="match-notes">📝 ${esc(m.notes)}</p>` : ''}`;
}

// ---------------------------------------------------------------- 看板

// 排名只計算已公布的對戰，主辦與選手看到的排名一致
const standings = () => computeStandings(state.teams, state.matches.filter((m) => m.published));

function renderStandings(mine) {
  const rows = standings();
  if (!rows.length) return emptyState('還沒有隊伍。');
  const org = isOrganizer();
  const needDraw = rows.some((s) => s.drawTied && s.team.draw_rank == null);
  const medal = (s) => (s.played && s.rank <= 3 ? ['🥇', '🥈', '🥉'][s.rank - 1] : s.rank);
  return `
    ${needDraw && org ? `<div class="banner warn">有隊伍戰績完全相同，請抽籤後在「抽籤」欄填入順位。</div>` : ''}
    <div class="table-wrap">
      <table class="rank-table">
        <thead><tr>
          <th>名次</th><th class="left">隊伍</th><th>積分</th><th>勝</th><th>敗</th>
          <th class="hide-sm">點數</th><th class="hide-sm">局數</th><th class="hide-sm">得失分</th><th class="left hide-sm">判定依據</th>
        </tr></thead>
        <tbody>
          ${rows.map((s) => {
            const basis = s.drawTied && s.team.draw_rank == null ? `${s.basis}（未抽籤）` : s.basis;
            const draw = s.drawTied && org
              ? `<label class="draw">抽籤 <select data-change="draw-rank" data-id="${s.team.id}" aria-label="${esc(s.team.name)} 抽籤順位">
                   <option value="">—</option>
                   ${rows.map((_, i) => `<option value="${i + 1}" ${s.team.draw_rank === i + 1 ? 'selected' : ''}>${i + 1}</option>`).join('')}
                 </select></label>`
              : '';
            return `
              <tr class="${s.team.id === mine ? 'mine' : ''}">
                <td class="rank">${medal(s)}</td>
                <td class="left"><div class="team">${esc(s.team.name)}</div><div class="basis show-sm">${esc(basis)}・點數 ${s.rubbersWon}:${s.rubbersLost}</div>${draw}</td>
                <td><b>${s.score}</b></td><td>${s.wins}</td><td>${s.losses}</td>
                <td class="hide-sm nowrap">${s.rubbersWon}:${s.rubbersLost}</td>
                <td class="hide-sm nowrap">${s.gamesWon}:${s.gamesLost}</td>
                <td class="hide-sm nowrap">${s.pointsWon}:${s.pointsLost}</td>
                <td class="left hide-sm basis">${esc(basis)}</td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    <p class="note">積分：勝一場 2 分、敗一場 1 分。同積分時，兩隊看對戰勝負；三隊以上只計算彼此之間的對戰，依序比 場數勝率 → 點數勝率 → 局數勝率 → 分數勝率 → 抽籤。只計算已完賽的對戰。</p>`;
}

function renderBoard() {
  const matches = sortMatches(state.matches);
  if (!matches.length) return emptyState('主辦單位尚未公布對戰，開賽後這裡會自動更新。');
  const mine = state.teams.some((t) => t.id === state.myTeam) ? state.myTeam : '';
  const done = matches.filter((m) => m.status === 'completed').length;
  const pct = Math.round((done / matches.length) * 100);
  const rounds = [...new Set(matches.map((m) => m.round))];
  const tabs = `
    <nav class="subtabs two" aria-label="看板內容">
      ${Object.entries(BOARD_TABS).map(([key, label]) => `<button class="subtab ${state.boardTab === key ? 'on' : ''}" data-action="board-tab" data-tab="${key}" aria-pressed="${state.boardTab === key}">${label}</button>`).join('')}
    </nav>`;
  return `
    <section class="card status">
      <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="賽事進度"><div class="progress-bar" style="width:${pct}%"></div></div>
      <p class="status-text">賽事進度 <b>${done}</b> / ${matches.length} 場（${pct}%）</p>
      <div class="picker">
        <label for="my-team">我的隊伍</label>
        <select id="my-team" data-change="my-team">
          <option value="">（不指定）</option>
          ${state.teams.map((t) => `<option value="${t.id}" ${t.id === mine ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
        </select>
      </div>
    </section>
    ${tabs}
    ${
      state.boardTab === 'standings'
        ? renderStandings(mine)
        : rounds
            .map((round) => `
              <h3 class="round-title">第 ${round} 輪</h3>
              <div class="match-grid">
                ${matches
                  .filter((m) => m.round === round)
                  .map((m) => `<article class="match card ${m.status} ${mine && (m.team_a_id === mine || m.team_b_id === mine) ? 'mine' : ''}">${matchHeader(m, mine)}${pointTable(m)}</article>`)
                  .join('')}
              </div>`)
            .join('')
    }`;
}

// ---------------------------------------------------------------- 各隊排點

function renderTeamLogin() {
  const busy = state.busy ? 'disabled' : '';
  return `
    <section class="card narrow">
      <h2>各隊排點登入</h2>
      <p class="note">選擇隊伍並輸入主辦單位提供的隊伍密碼。</p>
      ${state.teamNotice ? `<div class="banner error">${esc(state.teamNotice)}</div>` : ''}
      ${
        state.teams.length
          ? `<form class="form" data-form="team-login">
               <label>隊伍<select name="team" required>
                 <option value="">（請選擇）</option>
                 ${state.teams.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}
               </select></label>
               <label>隊伍密碼<input name="code" type="password" inputmode="numeric" autocomplete="off" required maxlength="20"></label>
               <button class="btn primary" ${busy}>登入</button>
             </form>`
          : emptyState('主辦單位尚未建立隊伍。')
      }
      ${demo ? `<p class="note">示範模式隊伍密碼：${Object.entries(backend.demoTeamCodes).map(([n, c]) => `${esc(n)} <b>${c}</b>`).join('、')}</p>` : ''}
    </section>`;
}

function teamLogout(notice = null) {
  state.team = null;
  state.teamData = null;
  state.drafts = {};
  state.teamNotice = notice;
  store.set('team', null, sessionStorage);
}

function renderTeam() {
  if (!state.team) return renderTeamLogin();
  const team = teamById(state.team.id);
  if (!team || !state.teamData) return `<div class="center-card"><div class="spinner"></div><p>載入隊伍資料中…</p></div>`;
  const players = playersOf(team.id);
  const busy = state.busy ? 'disabled' : '';
  const matches = sortMatches(state.teamData.matches || []);
  const minNeeded = Math.max(...[...new Set(matches.map((m) => m.match_system))].map((s) => minPlayersFor(state.settings, s)), minPlayersFor(state.settings, state.settings.match_system));

  return `
    <section class="card team-head">
      <div><span class="note">目前登入</span><h2>${esc(team.name)}</h2></div>
      <button class="btn small" data-action="team-logout">登出隊伍</button>
    </section>

    <section class="card">
      <div class="section-head">
        <h3>隊員名單 <span class="count ${players.length < minNeeded ? 'bad' : 'good'}">${players.length} 人</span></h3>
        <span class="note">排點需至少 ${minNeeded} 人</span>
      </div>
      <ul class="roster">
        ${players.map((p) => `<li><span>${esc(p.name)}</span><button class="icon-btn" data-action="team-remove-player" data-id="${p.id}" aria-label="刪除 ${esc(p.name)}" ${busy}>✕</button></li>`).join('') || '<li class="note">尚無隊員</li>'}
      </ul>
      <form class="inline-form" data-form="team-add-player">
        <input name="name" maxlength="20" placeholder="新增隊員姓名" required autocomplete="off" aria-label="新增隊員姓名">
        <button class="btn" ${busy}>新增</button>
      </form>
    </section>

    <h3 class="round-title">本隊對戰與排點</h3>
    ${
      matches.length
        ? matches.map((m) => teamMatchCard(m, team, players)).join('')
        : `<div class="banner info">📋 主辦單位還沒有安排本隊的對戰。<br>排點是「每一場對戰」各自排，主辦在「對戰與比分」產生賽程後，這裡就會出現每場比賽的排點表（畫面會自動更新）。</div>`
    }`;
}

function teamMatchCard(m, team, players) {
  const isA = m.team_a_id === team.id;
  const mineLocked = isA ? m.a_locked : m.b_locked;
  const oppLocked = isA ? m.b_locked : m.a_locked;
  const opponent = teamName(isA ? m.team_b_id : m.team_a_id);
  const sys = systemOf(m.match_system);
  const saved = lineupOf(m.id, team.id) || {};
  const draft = state.drafts[m.id] || saved; // 含空位
  const dirty = !!state.drafts[m.id] && JSON.stringify(cleanSlots(draft, m.match_system)) !== JSON.stringify(cleanSlots(saved, m.match_system));
  const minPlayers = minPlayersFor(state.settings, m.match_system);
  const lockErrors = validateLineup({ slots: cleanSlots(draft, m.match_system), matchSystem: m.match_system, players, minPlayers, forLock: true });
  const busy = state.busy ? 'disabled' : '';

  const head = `
    <div class="match-top">
      <span class="round-tag">第 ${m.round} 輪</span>
      <span class="fmt">${sys.label}・對手：<b>${esc(opponent)}</b></span>
    </div>
    <div class="lock-row">
      <span>本隊 ${lockChip(mineLocked)}</span><span>對手 ${lockChip(oppLocked)}</span>
    </div>`;

  if (revealed(m)) {
    return `<article class="card match ${m.status}">${matchHeader(m, team.id)}${pointTable(m)}</article>`;
  }
  if (mineLocked) {
    return `
      <article class="card match">
        ${head}
        <div class="lineup-view">
          ${sys.points.map((pt) => `<div class="lv-row"><span class="lv-label">${pt.label} ${pt.type}</span><span>${esc(playerNames(saved[pt.key])) || '—'}</span></div>`).join('')}
        </div>
        <div class="banner info">已鎖定送出。對手鎖定後雙方排點會同時公布，之後就不能再修改。</div>
        <div class="actions"><button class="btn" data-action="team-unlock" data-id="${m.id}" ${busy}>解除鎖定（修改排點）</button></div>
      </article>`;
  }

  // 排點編輯：每個位置一個下拉選單；已排在其他位置的選手會標示並停用
  const chosenElsewhere = (key, idx) => {
    const set = new Set();
    for (const pt of sys.points) (draft[pt.key] || []).forEach((id, j) => { if (id && !(pt.key === key && j === idx)) set.add(id); });
    return set;
  };
  const selects = sys.points
    .map((pt) => {
      const boxes = Array.from({ length: pt.size }, (_, idx) => {
        const current = (draft[pt.key] || [])[idx] || '';
        const taken = chosenElsewhere(pt.key, idx);
        return `<select data-change="slot" data-match="${m.id}" data-point="${pt.key}" data-idx="${idx}" aria-label="${pt.label}${pt.type}第 ${idx + 1} 位">
          <option value="">（選擇選手）</option>
          ${players.map((p) => `<option value="${p.id}" ${p.id === current ? 'selected' : ''} ${taken.has(p.id) ? 'disabled' : ''}>${esc(p.name)}${taken.has(p.id) ? '（已排）' : ''}</option>`).join('')}
        </select>`;
      }).join('');
      return `<div class="slot-row"><span class="slot-label">${pt.label}<small>${pt.type}</small></span><div class="slot-boxes">${boxes}</div></div>`;
    })
    .join('');

  return `
    <article class="card match editing">
      ${head}
      <div class="slots">${selects}</div>
      ${
        lockErrors.length
          ? `<ul class="checklist">${lockErrors.map((e) => `<li>⚠️ ${esc(e)}</li>`).join('')}</ul>`
          : `<p class="ok-line">✅ 排點完整，可以鎖定送出</p>`
      }
      <div class="actions">
        <button class="btn" data-action="team-save-draft" data-id="${m.id}" ${busy || !dirty ? 'disabled' : ''}>${dirty ? '儲存草稿' : '草稿已儲存'}</button>
        <button class="btn primary" data-action="team-lock" data-id="${m.id}" ${busy || lockErrors.length ? 'disabled' : ''}>鎖定送出</button>
      </div>
    </article>`;
}

// ---------------------------------------------------------------- 主辦管理

function renderAdminLogin() {
  return `
    <section class="card narrow">
      <h2>主辦單位登入</h2>
      <form class="form" data-form="admin-login">
        <label>帳號<input name="email" type="email" required autocomplete="username" value="${esc(ORGANIZER_EMAIL)}"></label>
        <label>密碼<input name="password" type="password" required autocomplete="current-password"></label>
        <button class="btn primary" ${state.busy ? 'disabled' : ''}>登入</button>
      </form>
      ${demo ? `<p class="note">示範模式主辦密碼：<b>${esc(backend.demoPassword)}</b></p>` : ''}
    </section>`;
}

function renderAdmin() {
  if (!isOrganizer()) return renderAdminLogin();
  return `
    <section class="card team-head">
      <div><span class="note">主辦模式</span><h2>${esc(state.user.email)}</h2></div>
      <button class="btn small" data-action="logout">登出</button>
    </section>
    <nav class="subtabs three" aria-label="管理項目">
      ${Object.entries(ADMIN_TABS).map(([key, label]) => `<button class="subtab ${state.adminTab === key ? 'on' : ''}" data-action="admin-tab" data-tab="${key}" aria-pressed="${state.adminTab === key}">${label}</button>`).join('')}
    </nav>
    ${state.adminTab === 'matches' ? renderAdminMatches() : ''}
    ${state.adminTab === 'teams' ? renderAdminTeams() : ''}
    ${state.adminTab === 'settings' ? renderAdminSettings() : ''}`;
}

function renderAdminMatches() {
  const matches = sortMatches(state.matches);
  const busy = state.busy ? 'disabled' : '';
  const teamOptions = state.teams.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  return `
    <section class="card">
      <div class="section-head"><h3>建立對戰</h3><span class="note">${systemOf(state.settings.match_system).label}・每點${state.settings.games_per_point === 3 ? '三局兩勝' : '五局三勝'}</span></div>
      <div class="actions">
        <button class="btn primary" data-action="generate" ${busy || state.teams.length < 2 ? 'disabled' : ''}>${matches.length ? '補齊單循環缺少的對戰' : '產生單循環賽程'}</button>
      </div>
      <form class="form grid-form" data-form="add-match">
        <label>A 隊<select name="a" required><option value="">（選擇）</option>${teamOptions}</select></label>
        <label>B 隊<select name="b" required><option value="">（選擇）</option>${teamOptions}</select></label>
        <label>輪次<input name="round" type="number" min="1" value="${Math.max(1, ...matches.map((m) => m.round))}" required></label>
        <label>備註<input name="notes" maxlength="100" placeholder="例如：決賽"></label>
        <button class="btn" ${busy}>手動新增對戰</button>
      </form>
    </section>
    ${
      matches.length
        ? [...new Set(matches.map((m) => m.round))].map((round) => `
            <h3 class="round-title">第 ${round} 輪</h3>
            <div class="match-grid">${matches.filter((m) => m.round === round).map(adminMatchCard).join('')}</div>`).join('')
        : emptyState('還沒有對戰，請先在「隊伍與選手」建立隊伍，再產生賽程。')
    }`;
}

function adminMatchCard(m) {
  const busy = state.busy ? 'disabled' : '';
  return `
    <article class="card match ${m.status} ${m.published ? '' : 'hidden-match'}">
      ${matchHeader(m, '')}
      ${pointTable(m)}
      <div class="actions wrap">
        <button class="btn primary small" data-action="score" data-id="${m.id}">登錄比分</button>
        <button class="btn small" data-action="toggle-publish" data-id="${m.id}" ${busy}>${m.published ? '👁️ 已公布（點此隱藏）' : '🙈 隱藏中（點此公布）'}</button>
        ${m.a_locked ? `<button class="btn small" data-action="admin-unlock" data-id="${m.id}" data-side="a" ${busy}>解除 ${esc(teamName(m.team_a_id))} 鎖定</button>` : ''}
        ${m.b_locked ? `<button class="btn small" data-action="admin-unlock" data-id="${m.id}" data-side="b" ${busy}>解除 ${esc(teamName(m.team_b_id))} 鎖定</button>` : ''}
        <button class="btn small danger" data-action="delete-match" data-id="${m.id}" ${busy}>刪除</button>
      </div>
    </article>`;
}

function renderAdminTeams() {
  const busy = state.busy ? 'disabled' : '';
  return `
    ${
      state.teams.length >= 2 && !state.matches.length
        ? `<div class="banner warn">下一步：產生賽程後，各隊才能開始排點。
             <div class="actions"><button class="btn primary" data-action="generate" ${busy}>產生單循環賽程</button></div></div>`
        : ''
    }
    <div class="forms">
      <form class="card form" data-form="create-team">
        <h3>新增隊伍</h3>
        <label>隊名（10 字內）<input name="name" maxlength="10" required autocomplete="off"></label>
        <label>隊伍密碼（留白自動產生 6 位數）<input name="code" maxlength="20" autocomplete="off"></label>
        <button class="btn primary" ${busy}>新增隊伍</button>
      </form>
      <form class="card form" data-form="bulk-teams">
        <h3>批次匯入</h3>
        <label>每行一隊：隊名＋冒號＋隊員（用逗號或頓號分開）
          <textarea name="text" rows="5" placeholder="東區鐵人：陳志明、林建宏、黃俊傑&#10;西區旋風: 蔡明哲,鄭凱文"></textarea>
        </label>
        <button class="btn primary" ${busy}>匯入</button>
        <p class="note">已存在的隊名會把隊員加進該隊。新隊伍的密碼會自動產生。</p>
      </form>
    </div>
    <div class="section-head">
      <h3>隊伍（${state.teams.length}）</h3>
      ${state.teams.length ? `<button class="btn small" data-action="copy-codes">複製隊伍密碼表</button>` : ''}
    </div>
    ${
      state.teams.length
        ? state.teams.map((t) => {
            const players = playersOf(t.id);
            return `
              <article class="card team-card">
                <div class="section-head">
                  <h3>${esc(t.name)} <span class="count">${players.length} 人</span></h3>
                  <span class="code">密碼 <b>${esc(state.passcodes[t.id] ?? '…')}</b></span>
                </div>
                <ul class="roster">
                  ${players.map((p) => `<li><span>${esc(p.name)}</span><button class="icon-btn" data-action="admin-remove-player" data-id="${p.id}" aria-label="刪除 ${esc(p.name)}" ${busy}>✕</button></li>`).join('') || '<li class="note">尚無隊員</li>'}
                </ul>
                <form class="inline-form" data-form="admin-add-player" data-team="${t.id}">
                  <input name="name" maxlength="20" placeholder="新增隊員" required autocomplete="off" aria-label="新增隊員到 ${esc(t.name)}">
                  <button class="btn" ${busy}>新增</button>
                </form>
                <div class="actions">
                  <button class="btn small" data-action="rename-team" data-id="${t.id}" ${busy}>改隊名</button>
                  <button class="btn small" data-action="reset-code" data-id="${t.id}" ${busy}>重設密碼</button>
                  <button class="btn small danger" data-action="delete-team" data-id="${t.id}" ${busy}>刪除隊伍</button>
                </div>
              </article>`;
          }).join('')
        : emptyState('還沒有隊伍。')
    }`;
}

function renderAdminSettings() {
  const s = state.settings;
  const locked = state.matches.length > 0;
  const busy = state.busy ? 'disabled' : '';
  return `
    <form class="card form" data-form="settings">
      <h3>大會設定</h3>
      <label>網站標題<input name="title" maxlength="40" required value="${esc(s.title)}"></label>
      <label>賽制
        <select name="match_system" ${locked ? 'disabled' : ''}>
          ${Object.entries(SYSTEMS).map(([k, v]) => `<option value="${k}" ${Number(k) === s.match_system ? 'selected' : ''}>${v.label}（${v.points.map((p) => p.type).join('、')}）</option>`).join('')}
        </select>
      </label>
      <label>每一點
        <select name="games_per_point" ${locked ? 'disabled' : ''}>
          <option value="5" ${s.games_per_point === 5 ? 'selected' : ''}>五局三勝</option>
          <option value="3" ${s.games_per_point === 3 ? 'selected' : ''}>三局兩勝</option>
        </select>
      </label>
      ${locked ? `<p class="note">已有對戰時無法變更賽制；如需變更，請先刪除所有對戰。</p>` : ''}
      <div class="row">
        <label>3 點制最少隊員<input name="min_players_3" type="number" min="5" max="30" required value="${s.min_players_3}"></label>
        <label>5 點制最少隊員<input name="min_players_5" type="number" min="7" max="30" required value="${s.min_players_5}"></label>
      </div>
      <button class="btn primary" ${busy}>儲存設定</button>
    </form>
    <section class="card">
      <h3>匯出成績</h3>
      <div class="actions">
        <button class="btn" data-action="export-excel">匯出 Excel</button>
        <button class="btn" data-action="copy-report">複製 LINE 戰報</button>
        <button class="btn" data-action="copy-link">複製網站網址</button>
      </div>
    </section>
    <section class="card">
      <h3>帳號與資料</h3>
      <div class="actions">
        <button class="btn" data-action="change-password">變更主辦密碼</button>
        <button class="btn danger" data-action="wipe" ${busy}>清除全部資料</button>
      </div>
    </section>`;
}

// ---------------------------------------------------------------- 主畫面

function render() {
  if (!state.loaded) {
    app.innerHTML = state.error
      ? `<div class="center-card"><h2>無法讀取資料</h2><p>${esc(state.error)}</p><button class="btn primary" data-action="retry">重新載入</button></div>`
      : `<div class="center-card"><div class="spinner" aria-hidden="true"></div><p>載入中…</p></div>`;
    return;
  }
  app.innerHTML = `
    ${renderHeader()}
    <main class="container">
      ${state.error ? `<div class="banner error">⚠️ 與資料庫連線異常：${esc(state.error)}（畫面可能不是最新）</div>` : ''}
      ${demo ? `<div class="banner demo">🧪 示範模式：資料只存在這個分頁，重新整理就會還原。</div>` : ''}
      ${state.view === 'board' ? renderBoard() : ''}
      ${state.view === 'team' ? renderTeam() : ''}
      ${state.view === 'admin' ? renderAdmin() : ''}
    </main>`;
}

// ---------------------------------------------------------------- 對話框

function openModal(html, onReady) {
  const previousFocus = document.activeElement;
  modalRoot.innerHTML = `<div class="backdrop"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
  const backdrop = modalRoot.querySelector('.backdrop');
  const close = () => {
    modalRoot.innerHTML = '';
    document.removeEventListener('keydown', onKey);
    if (previousFocus?.focus) previousFocus.focus();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop || e.target.closest('[data-close]')) close(); });
  onReady(modalRoot.querySelector('.modal'), close);
  if (!modalRoot.contains(document.activeElement)) modalRoot.querySelector('input, button:not([data-close])')?.focus();
}

function openScoreModal(match) {
  const sys = systemOf(match.match_system);
  const gpp = match.games_per_point;
  const need = gamesToWin(gpp);
  const show = revealed(match);
  const la = show ? lineupOf(match.id, match.team_a_id) : null;
  const lb = show ? lineupOf(match.id, match.team_b_id) : null;
  const nameA = teamName(match.team_a_id);
  const nameB = teamName(match.team_b_id);
  const cell = (key, i, side) => {
    const g = (match.scores?.[key] || [])[i];
    return `<input class="pt-input" type="number" inputmode="numeric" min="0" max="99" data-point="${key}" data-game="${i}" data-side="${side}" value="${g ? g[side] : ''}" aria-label="${key} 第 ${i + 1} 局 ${side ? esc(nameB) : esc(nameA)} 得分">`;
  };

  openModal(
    `<h2>第 ${match.round} 輪　${esc(nameA)} vs ${esc(nameB)}</h2>
     <div class="score-head"><span>${esc(nameA)}</span><b class="score-total"></b><span>${esc(nameB)}</span></div>
     <p class="score-hint">依序輸入每一點各局得分，一點先贏 ${need} 局即獲勝；整場先拿 ${sys.winPoints} 點獲勝。${show ? '' : '（雙方尚未都鎖定排點，出賽選手暫不顯示）'}</p>
     <div class="score-points">
       ${sys.points.map((pt) => `
         <section class="sp" data-point-box="${pt.key}">
           <div class="sp-head"><b>${pt.label} ${pt.type}</b><span class="sp-sum"></span></div>
           ${show ? `<div class="sp-who">${esc(playerNames(la?.[pt.key])) || '—'} <span class="vs">vs</span> ${esc(playerNames(lb?.[pt.key])) || '—'}</div>` : ''}
           ${Array.from({ length: gpp }, (_, i) => `
             <div class="game-row" data-row="${pt.key}-${i}">
               <span class="game-label">第 ${i + 1} 局</span>${cell(pt.key, i, 0)}<span class="colon">:</span>${cell(pt.key, i, 1)}
               <span class="row-note"></span>
             </div>`).join('')}
         </section>`).join('')}
     </div>
     <label>備註<input name="notes" maxlength="100" value="${esc(match.notes || '')}"></label>
     <p class="score-result"></p>
     <div class="modal-actions">
       <button type="button" class="btn" data-clear>清除比分</button>
       <button type="button" class="btn" data-close>取消</button>
       <button type="button" class="btn primary" data-save>儲存</button>
     </div>`,
    (modal, close) => {
      const input = (key, i, side) => modal.querySelector(`.pt-input[data-point="${key}"][data-game="${i}"][data-side="${side}"]`);
      // 由前往後讀：每一點讀到未完成的局或已分勝負為止；整場分出勝負後，後面的點不再讀
      const evaluate = () => {
        const scores = {};
        let problem = null;
        let a = 0;
        let b = 0;
        const boxes = [];
        for (const pt of sys.points) {
          const decidedMatch = a >= sys.winPoints || b >= sys.winPoints;
          const games = [];
          let pa = 0;
          let pb = 0;
          if (!decidedMatch) {
            for (let i = 0; i < gpp && pa < need && pb < need; i++) {
              const x = input(pt.key, i, 0).value;
              const y = input(pt.key, i, 1).value;
              if (x === '' && y === '') break;
              const va = Number(x);
              const vb = Number(y);
              if (x === '' || y === '' || !Number.isInteger(va) || !Number.isInteger(vb) || va < 0 || vb < 0 || va === vb) {
                problem ||= { key: pt.key, i, message: x !== '' && y !== '' && va === vb ? '同分無法判定勝方' : '請填完兩隊得分' };
                break;
              }
              games.push([va, vb]);
              if (va > vb) pa++; else pb++;
            }
          }
          if (games.length) scores[pt.key] = games;
          const r = pointResult(games, gpp);
          if (r.winner === 1) a++;
          if (r.winner === 2) b++;
          boxes.push({ pt, games, r, decidedMatch });
          // 這一點還沒打完，就不往後讀（後面的點還沒開始）
          if (!r.winner) {
            sys.points.slice(sys.points.indexOf(pt) + 1).forEach((rest) => boxes.push({ pt: rest, games: [], r: { a: 0, b: 0, winner: 0 }, pending: true }));
            break;
          }
        }
        return { scores, problem, a, b, boxes, winner: a >= sys.winPoints ? 1 : b >= sys.winPoints ? 2 : 0 };
      };
      const draw = () => {
        const ev = evaluate();
        for (const box of ev.boxes) {
          const el = modal.querySelector(`[data-point-box="${box.pt.key}"]`);
          const hideBox = box.decidedMatch || box.pending;
          el.hidden = hideBox && !box.games.length;
          el.querySelector('.sp-sum').textContent = box.games.length ? `${box.r.a} : ${box.r.b}${box.r.winner ? `　${box.r.winner === 1 ? nameA : nameB} 勝` : ''}` : '';
          const visibleRows = box.r.winner ? box.games.length : Math.min(gpp, box.games.length + 1);
          for (let i = 0; i < gpp; i++) {
            const row = el.querySelector(`[data-row="${box.pt.key}-${i}"]`);
            row.hidden = i >= visibleRows;
            const g = box.games[i];
            row.classList.toggle('w1', !!g && g[0] > g[1]);
            row.classList.toggle('w2', !!g && g[1] > g[0]);
            const note = row.querySelector('.row-note');
            if (ev.problem && ev.problem.key === box.pt.key && ev.problem.i === i) { note.textContent = ev.problem.message; note.className = 'row-note bad'; }
            else if (g && !isStandardGame(g[0], g[1])) { note.textContent = '非 11 分制比分，請再確認'; note.className = 'row-note warn'; }
            else { note.textContent = ''; note.className = 'row-note'; }
          }
        }
        modal.querySelector('.score-total').textContent = `${ev.a} : ${ev.b}`;
        modal.querySelector('.score-result').innerHTML = ev.winner
          ? `🏆 勝方：<b>${esc(ev.winner === 1 ? nameA : nameB)}</b>`
          : Object.keys(ev.scores).length ? '比賽進行中，可先儲存目前比分。' : '';
      };
      modal.querySelector('.score-points').addEventListener('input', draw);
      modal.querySelector('.score-points').addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || !e.target.matches('.pt-input')) return;
        e.preventDefault();
        const inputs = [...modal.querySelectorAll('.sp:not([hidden]) .game-row:not([hidden]) .pt-input')];
        (inputs[inputs.indexOf(e.target) + 1] || modal.querySelector('[data-save]')).focus();
      });
      modal.querySelector('[data-clear]').addEventListener('click', () => {
        modal.querySelectorAll('.pt-input').forEach((el) => { el.value = ''; });
        draw();
      });
      modal.querySelector('[data-save]').addEventListener('click', async () => {
        const ev = evaluate();
        if (ev.problem) {
          modal.querySelector('.score-result').innerHTML = `<span class="error">${esc(systemOf(match.match_system).points.find((p) => p.key === ev.problem.key).label)} 第 ${ev.problem.i + 1} 局：${ev.problem.message}</span>`;
          return;
        }
        const r = matchResult({ ...match, scores: ev.scores });
        const patch = {
          scores: ev.scores,
          status: r.status,
          winner_id: r.winner === 1 ? match.team_a_id : r.winner === 2 ? match.team_b_id : null,
          notes: modal.querySelector('[name=notes]').value.trim(),
        };
        close();
        await run(() => backend.adminUpdateMatch(match.id, patch), '比分已儲存');
      });
      draw();
      const first = [...modal.querySelectorAll('.sp:not([hidden]) .game-row:not([hidden]) .pt-input')].find((el) => el.value === '');
      first?.focus();
    }
  );
}

function openPasswordModal() {
  openModal(
    `<h2>變更主辦密碼</h2>
     <form>
       <label>目前密碼<input name="current" type="password" required autocomplete="current-password"></label>
       <label>新密碼（至少 6 個字元）<input name="next" type="password" required minlength="6" autocomplete="new-password"></label>
       <label>再輸入一次新密碼<input name="confirm" type="password" required minlength="6" autocomplete="new-password"></label>
       <p class="error" hidden></p>
       <div class="modal-actions"><button type="button" class="btn" data-close>取消</button><button class="btn primary">更新密碼</button></div>
     </form>`,
    (modal, close) => {
      const form = modal.querySelector('form');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const errorEl = form.querySelector('.error');
        const fail = (msg) => { errorEl.textContent = msg; errorEl.hidden = false; };
        if (form.next.value !== form.confirm.value) return fail('兩次輸入的新密碼不一樣');
        try {
          await backend.changePassword(state.user.email, form.current.value, form.next.value);
          close();
          toast('密碼已更新（雙打計分系統也是同一個帳號）', 'ok');
        } catch (err) {
          fail(err.message);
        }
      });
    }
  );
}

// ---------------------------------------------------------------- 操作

const copyText = async (text, okMessage) => {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMessage, 'ok');
  } catch {
    prompt('請複製以下內容：', text);
  }
};

const exportCtx = () => ({
  title: state.settings.title,
  matches: sortMatches(state.matches),
  teams: state.teams,
  standings: standings(),
  teamName,
  playersOf,
  playerNames,
  lineupOf,
  matchResult,
  statusLabel,
});

function parseBulkTeams(text) {
  const rows = [];
  const skipped = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([^:：]+)[:：](.*)$/);
    const name = (m ? m[1] : line).trim();
    const players = m ? m[2].split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean) : [];
    if (!name || name.length > 10 || players.some((p) => p.length > 20)) skipped.push(line);
    else rows.push({ name, players: [...new Set(players)] });
  }
  return { rows, skipped };
}

const actions = {
  retry: () => { state.error = null; render(); reload(); },
  view: ({ view }) => { state.view = view; store.set('view', view); render(); window.scrollTo(0, 0); },
  'board-tab': ({ tab }) => { state.boardTab = tab; store.set('boardTab', tab); render(); },
  'admin-tab': ({ tab }) => { state.adminTab = tab; store.set('adminTab', tab); render(); if (tab === 'teams') reload(); },
  logout: async () => { await backend.signOut(); toast('已登出'); },
  'team-logout': () => { teamLogout(); render(); },

  'team-remove-player': ({ id }) => {
    if (!confirm(`確定刪除隊員「${playerName(id)}」？`)) return;
    run(() => backend.teamRemovePlayer(state.team.id, state.team.code, id), '已刪除隊員');
  },
  'team-save-draft': ({ id }) => {
    const slots = state.drafts[id]; // 保留空位，重新載入後選單位置不變
    run(async () => {
      await backend.teamSaveLineup(state.team.id, state.team.code, id, slots, false);
      delete state.drafts[id];
    }, '草稿已儲存（對手看不到）');
  },
  'team-lock': ({ id }) => {
    const m = state.teamData.matches.find((x) => x.id === id);
    const slots = cleanSlots(state.drafts[id] || lineupOf(id, state.team.id), m.match_system);
    const sys = systemOf(m.match_system);
    const summary = sys.points.map((pt) => `${pt.label}${pt.type}：${playerNames(slots[pt.key])}`).join('\n');
    if (!confirm(`確定鎖定送出？\n\n${summary}\n\n雙方都鎖定後會同時公布，之後無法再修改。`)) return;
    run(async () => {
      await backend.teamSaveLineup(state.team.id, state.team.code, id, slots, true);
      delete state.drafts[id];
    }, '已鎖定送出');
  },
  'team-unlock': ({ id }) => {
    if (!confirm('解除鎖定後可以修改排點，修改完記得再鎖定送出。確定解除？')) return;
    run(() => backend.teamSaveLineup(state.team.id, state.team.code, id, {}, false), '已解除鎖定');
  },

  generate: () => {
    const existing = state.matches;
    const has = (a, b) => existing.some((m) => (m.team_a_id === a && m.team_b_id === b) || (m.team_a_id === b && m.team_b_id === a));
    const base = { match_system: state.settings.match_system, games_per_point: state.settings.games_per_point, published: true };
    let rows;
    if (!existing.length) {
      rows = roundRobin(state.teams.map((t) => t.id)).map((p) => ({ ...base, ...p }));
    } else {
      const startRound = Math.max(...existing.map((m) => m.round)) + 1;
      const missing = [];
      state.teams.forEach((x, i) => state.teams.slice(i + 1).forEach((y) => { if (!has(x.id, y.id)) missing.push([x.id, y.id]); }));
      rows = missing.map(([a, b], i) => ({ ...base, round: startRound, seq: i, team_a_id: a, team_b_id: b }));
    }
    if (!rows.length) return toast('所有隊伍之間都已經有對戰了');
    if (!confirm(`將新增 ${rows.length} 場對戰，確定嗎？`)) return;
    run(() => backend.adminCreateMatches(rows), `已新增 ${rows.length} 場對戰`);
  },
  score: ({ id }) => {
    const m = state.matches.find((x) => x.id === id);
    if (m) openScoreModal(m);
  },
  'toggle-publish': ({ id }) => {
    const m = state.matches.find((x) => x.id === id);
    run(() => backend.adminUpdateMatch(id, { published: !m.published }), m.published ? '已隱藏' : '已公布');
  },
  'admin-unlock': ({ id, side }) => {
    const m = state.matches.find((x) => x.id === id);
    const name = teamName(side === 'a' ? m.team_a_id : m.team_b_id);
    const warn = revealed(m) ? '\n\n⚠️ 雙方排點已經公布，解除後該隊可以重新排點。' : '';
    if (!confirm(`確定解除「${name}」的排點鎖定？${warn}`)) return;
    run(() => backend.adminUpdateMatch(id, side === 'a' ? { a_locked: false } : { b_locked: false }), '已解除鎖定');
  },
  'delete-match': ({ id }) => {
    const m = state.matches.find((x) => x.id === id);
    if (!confirm(`確定刪除「${teamName(m.team_a_id)} vs ${teamName(m.team_b_id)}」？兩隊的排點與比分會一併刪除。`)) return;
    run(() => backend.adminDeleteMatch(id), '已刪除對戰');
  },
  'admin-remove-player': ({ id }) => {
    if (!confirm(`確定刪除隊員「${playerName(id)}」？若已排入鎖定的排點，該位置會顯示為「已刪除」。`)) return;
    run(() => backend.adminRemovePlayer(id), '已刪除隊員');
  },
  'rename-team': ({ id }) => {
    const name = prompt('新的隊名（10 字內）', teamName(id));
    if (!name || !name.trim() || name.trim() === teamName(id)) return;
    if (name.trim().length > 10) return toast('隊名不能超過 10 個字', 'error');
    run(() => backend.adminRenameTeam(id, name.trim()), '隊名已更新');
  },
  'reset-code': ({ id }) => {
    const code = prompt(`為「${teamName(id)}」設定新密碼（4～20 個字元）。\n留白會自動產生 6 位數密碼。\n舊密碼會立即失效。`, '');
    if (code === null) return;
    run(async () => {
      const res = await backend.adminSetPasscode(id, code.trim());
      toast(`新密碼：${res.passcode}`, 'ok');
    });
  },
  'delete-team': ({ id }) => {
    if (!confirm(`確定刪除「${teamName(id)}」？隊員、相關對戰、排點與比分會一併刪除。`)) return;
    if (!confirm('再次確認：刪除後無法復原。')) return;
    run(() => backend.adminDeleteTeam(id), '已刪除隊伍');
  },
  'copy-codes': () => {
    const text = [`${state.settings.title} 隊伍密碼`, ...state.teams.map((t) => `${t.name}：${state.passcodes[t.id] ?? '（未設定）'}`)].join('\n');
    copyText(text, '已複製隊伍密碼表（請分別私下傳給各隊）');
  },
  'export-excel': () => {
    try { exportExcel(exportCtx()); } catch (err) { toast(err.message, 'error'); }
  },
  'copy-report': () => copyText(lineReport(exportCtx()), '已複製戰報，可以貼到 LINE'),
  'copy-link': () => copyText(location.origin + location.pathname + (demo ? '?demo' : ''), '網址已複製'),
  'change-password': () => (backend.isDemo ? toast('示範模式無法變更密碼') : openPasswordModal()),
  wipe: () => {
    if (!confirm('⚠️ 這會刪除「所有隊伍、隊員、對戰、排點與比分」。確定嗎？')) return;
    if (!confirm('最後確認：全部資料將無法復原。')) return;
    run(() => backend.adminWipe(), '全部資料已清除');
  },
};

app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  actions[el.dataset.action]?.(el.dataset, el);
});

app.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (!el) return;
  if (el.dataset.change === 'my-team') {
    state.myTeam = el.value;
    store.set('myTeam', el.value);
    render();
  } else if (el.dataset.change === 'draw-rank') {
    const rank = el.value ? Number(el.value) : null;
    el.blur();
    run(() => backend.adminSetDrawRank(el.dataset.id, rank), '抽籤順位已更新');
  } else if (el.dataset.change === 'slot') {
    const { match, point, idx } = el.dataset;
    const m = state.teamData.matches.find((x) => x.id === match);
    const base = state.drafts[match] || lineupOf(match, state.team.id) || {};
    const next = Object.fromEntries(systemOf(m.match_system).points.map((pt) => {
      const arr = [...(base[pt.key] || [])];
      while (arr.length < pt.size) arr.push('');
      return [pt.key, arr];
    }));
    next[point][Number(idx)] = el.value;
    state.drafts[match] = next;
    render();
  }
});

app.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  const kind = form.dataset.form;

  if (kind === 'team-login') {
    const id = form.team.value;
    const code = form.code.value.trim();
    if (!id || !code) return;
    await run(async () => {
      await backend.teamLogin(id, code);
      state.team = { id, code };
      state.teamNotice = null;
      store.set('team', JSON.stringify(state.team), sessionStorage);
    }, `已登入：${teamName(id)}`);
  } else if (kind === 'team-add-player') {
    const name = form.name.value.trim();
    if (await run(() => backend.teamAddPlayer(state.team.id, state.team.code, name), `已新增 ${name}`)) form.reset();
  } else if (kind === 'admin-login') {
    await run(() => backend.signIn(form.email.value.trim(), form.password.value), '已登入主辦模式');
  } else if (kind === 'create-team') {
    await run(async () => {
      const res = await backend.adminCreateTeam(form.name.value.trim(), form.code.value.trim());
      toast(`已新增隊伍，密碼：${res.passcode}`, 'ok');
    });
  } else if (kind === 'bulk-teams') {
    const { rows, skipped } = parseBulkTeams(form.text.value);
    if (!rows.length) return toast(skipped.length ? `看不懂這些行：${skipped.slice(0, 3).join('｜')}` : '請先貼上名單', 'error');
    let created = 0;
    let added = 0;
    const ok = await run(async () => {
      for (const row of rows) {
        let team = state.teams.find((t) => t.name === row.name);
        if (!team) {
          const res = await backend.adminCreateTeam(row.name, '');
          team = { id: res.id, name: row.name };
          created++;
        }
        const existing = new Set(playersOf(team.id).map((p) => p.name));
        const fresh = row.players.filter((p) => !existing.has(p)).map((name) => ({ team_id: team.id, name }));
        if (fresh.length) {
          await backend.adminAddPlayers(fresh);
          added += fresh.length;
        }
      }
    });
    if (ok) toast(`新增 ${created} 隊、${added} 位隊員${skipped.length ? `，略過 ${skipped.length} 行` : ''}`, 'ok');
  } else if (kind === 'admin-add-player') {
    const name = form.name.value.trim();
    await run(() => backend.adminAddPlayers([{ team_id: form.dataset.team, name }]), `已新增 ${name}`);
  } else if (kind === 'add-match') {
    const a = form.a.value;
    const b = form.b.value;
    if (a === b) return toast('請選擇兩支不同的隊伍', 'error');
    const round = Number(form.round.value) || 1;
    const seq = state.matches.filter((m) => m.round === round).length;
    await run(() => backend.adminCreateMatches([{
      team_a_id: a, team_b_id: b, round, seq, notes: form.notes.value.trim(),
      match_system: state.settings.match_system, games_per_point: state.settings.games_per_point, published: true,
    }]), '已新增對戰');
  } else if (kind === 'settings') {
    const patch = {
      title: form.title.value.trim(),
      min_players_3: Number(form.min_players_3.value),
      min_players_5: Number(form.min_players_5.value),
    };
    if (!form.match_system.disabled) {
      patch.match_system = Number(form.match_system.value);
      patch.games_per_point = Number(form.games_per_point.value);
    }
    await run(() => backend.adminUpdateSettings(patch), '設定已儲存');
  }
});

// ---------------------------------------------------------------- 啟動

async function init() {
  if (!demo && !isConfigured()) {
    app.innerHTML = `<div class="center-card"><h2>🏓 尚未連接資料庫</h2><p>請在 <code>js/config.js</code> 填入 Supabase 設定。</p><p><a class="btn primary" href="?demo">先試用示範模式</a></p></div>`;
    return;
  }
  render();
  try {
    backend = await createBackend({ demo });
  } catch (err) {
    console.error(err);
    state.error = '無法載入資料庫模組，請檢查網路連線後重新整理。';
    render();
    return;
  }
  state.user = await backend.getUser();
  backend.onAuthChange((user) => {
    const was = isOrganizer();
    state.user = user;
    if (was !== isOrganizer()) reload();
    else render();
  });
  await reload();
  backend.subscribe(scheduleReload, (status) => {
    const live = status === 'SUBSCRIBED';
    if (live) scheduleReload();
    if (live !== state.live) {
      state.live = live;
      requestRender();
    }
  });
  const poll = () => {
    if (!document.hidden) scheduleReload();
    setTimeout(poll, state.live ? 60000 : 15000);
  };
  setTimeout(poll, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleReload(); });
}

init();
