// 賽制、排點檢查與比分計算。資料庫（supabase/setup.sql）有同樣的排點檢查，以伺服器為準。

export const SYSTEMS = {
  3: {
    label: '3 點制',
    winPoints: 2,
    points: [
      { key: 'p1', label: '第一點', type: '單打', size: 1 },
      { key: 'p2', label: '第二點', type: '雙打', size: 2 },
      { key: 'p3', label: '第三點', type: '雙打', size: 2 },
    ],
  },
  5: {
    label: '5 點制',
    winPoints: 3,
    points: [
      { key: 'p1', label: '第一點', type: '單打', size: 1 },
      { key: 'p2', label: '第二點', type: '雙打', size: 2 },
      { key: 'p3', label: '第三點', type: '單打', size: 1 },
      { key: 'p4', label: '第四點', type: '雙打', size: 2 },
      { key: 'p5', label: '第五點', type: '單打', size: 1 },
    ],
  },
};

export const systemOf = (n) => SYSTEMS[n] || SYSTEMS[5];
export const gamesToWin = (gamesPerPoint) => (Number(gamesPerPoint) === 3 ? 2 : 3);
export const minPlayersFor = (settings, matchSystem) =>
  Number(matchSystem) === 3 ? settings.min_players_3 : settings.min_players_5;

// 檢查排點。forLock = true 時做鎖定送出的完整檢查。回傳錯誤訊息陣列（空陣列 = 通過）
export function validateLineup({ slots, matchSystem, players, minPlayers, forLock }) {
  const errors = [];
  const sys = systemOf(matchSystem);
  const ids = new Set(players.map((p) => p.id));
  const used = [];
  for (const pt of sys.points) {
    const chosen = (slots?.[pt.key] || []).filter(Boolean);
    if (chosen.length > pt.size) errors.push(`${pt.label}（${pt.type}）人數過多`);
    if (forLock && chosen.length < pt.size) errors.push(`${pt.label}（${pt.type}）尚未排滿，需要 ${pt.size} 人`);
    if (chosen.some((id) => !ids.has(id))) errors.push(`${pt.label} 有已刪除或不屬於本隊的選手，請重新選擇`);
    used.push(...chosen);
  }
  const dup = used.filter((id, i) => used.indexOf(id) !== i);
  if (dup.length) errors.push('同一位選手不能重複出賽');
  if (forLock && players.length < minPlayers) errors.push(`隊伍登錄選手需至少 ${minPlayers} 人（目前 ${players.length} 人）`);
  return errors;
}

// 單局：桌球 11 分制，先得 11 分且領先 2 分；10:10 後需領先 2 分
export const gameWinner = (g) => (Array.isArray(g) && g[0] !== g[1] ? (g[0] > g[1] ? 1 : 2) : 0);
export const isStandardGame = (a, b) => {
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return hi === 11 ? lo <= 9 : hi > 11 && hi - lo === 2;
};

// 一點的結果：各自贏幾局、勝方（1 = A 隊、2 = B 隊、0 = 未分出）
export function pointResult(games, gamesPerPoint) {
  const need = gamesToWin(gamesPerPoint);
  let a = 0;
  let b = 0;
  for (const g of games || []) {
    const w = gameWinner(g);
    if (w === 1) a++;
    else if (w === 2) b++;
  }
  return { a, b, winner: a >= need ? 1 : b >= need ? 2 : 0 };
}

// 整場結果：依點數順序累計，先拿到過半點數者勝
export function matchResult(match) {
  const sys = systemOf(match.match_system);
  let a = 0;
  let b = 0;
  let played = false;
  const points = sys.points.map((pt) => {
    const games = match.scores?.[pt.key] || [];
    if (games.length) played = true;
    const r = pointResult(games, match.games_per_point);
    if (r.winner === 1) a++;
    else if (r.winner === 2) b++;
    return { ...pt, games, ...r };
  });
  const winner = a >= sys.winPoints ? 1 : b >= sys.winPoints ? 2 : 0;
  return { a, b, winner, points, status: winner ? 'completed' : played ? 'live' : 'scheduled' };
}

// ---------------------------------------------------------------- 積分排名
// 積分：勝一場 2 分、敗一場 1 分。只計算已完賽的對戰。
// 同積分：兩隊看對戰勝負；三隊以上只計算彼此之間的對戰，依序比
// 場數勝率 → 點數勝率 → 局數勝率 → 分數勝率 → 抽籤。

const ratio = (won, lost) => (lost === 0 ? (won > 0 ? Infinity : 1) : won / lost);
const emptyTotals = () => ({ matchesWon: 0, matchesLost: 0, rubbersWon: 0, rubbersLost: 0, gamesWon: 0, gamesLost: 0, pointsWon: 0, pointsLost: 0 });

// 從某一隊（side 1 = A、2 = B）的角度累計一場對戰
function tally(t, match, side) {
  const r = matchResult(match);
  if (r.winner === side) t.matchesWon++;
  else if (r.winner) t.matchesLost++;
  for (const pt of r.points) {
    if (pt.winner === side) t.rubbersWon++;
    else if (pt.winner) t.rubbersLost++;
    for (const g of pt.games) {
      const w = gameWinner(g);
      if (w === side) t.gamesWon++;
      else if (w) t.gamesLost++;
      t.pointsWon += Number(g[side - 1]) || 0;
      t.pointsLost += Number(g[2 - side]) || 0;
    }
  }
}

const STEPS = [
  { key: 'matchRatio', label: '互咬・場數勝率' },
  { key: 'rubberRatio', label: '互咬・點數勝率' },
  { key: 'gameRatio', label: '互咬・局數勝率' },
  { key: 'pointRatio', label: '互咬・分數勝率' },
];
const ratiosOf = (t) => ({
  matchRatio: ratio(t.matchesWon, t.matchesLost),
  rubberRatio: ratio(t.rubbersWon, t.rubbersLost),
  gameRatio: ratio(t.gamesWon, t.gamesLost),
  pointRatio: ratio(t.pointsWon, t.pointsLost),
});
const drawRank = (s) => s.team.draw_rank ?? 999;

export function computeStandings(teams, matches) {
  const done = matches.filter((m) => m.status === 'completed' && matchResult(m).winner);
  const stats = new Map(teams.map((team) => [team.id, { team, played: 0, score: 0, ...emptyTotals(), basis: '', drawTied: false, rank: 0 }]));
  for (const m of done) {
    const a = stats.get(m.team_a_id);
    const b = stats.get(m.team_b_id);
    if (!a || !b) continue;
    a.played++;
    b.played++;
    tally(a, m, 1);
    tally(b, m, 2);
  }
  const all = [...stats.values()];
  for (const s of all) {
    s.wins = s.matchesWon;
    s.losses = s.matchesLost;
    s.score = s.wins * 2 + s.losses;
    Object.assign(s, { overall: ratiosOf(s) });
  }
  if (!done.length) {
    all.forEach((s, i) => { s.rank = i + 1; s.basis = '尚未有比賽結果'; });
    return all;
  }

  const groups = new Map();
  for (const s of all) {
    if (!groups.has(s.score)) groups.set(s.score, []);
    groups.get(s.score).push(s);
  }
  const ordered = [];
  for (const score of [...groups.keys()].sort((x, y) => y - x)) {
    const group = groups.get(score);
    if (group.length === 1) {
      group[0].basis = '積分';
      ordered.push(group[0]);
    } else if (group.length === 2) {
      ordered.push(...resolvePair(group, done));
    } else {
      ordered.push(...resolveGroup(group, done));
    }
  }
  ordered.forEach((s, i) => { s.rank = i + 1; });
  return ordered;
}

function resolvePair([a, b], done) {
  const h2h = done.find((m) => (m.team_a_id === a.team.id && m.team_b_id === b.team.id) || (m.team_a_id === b.team.id && m.team_b_id === a.team.id));
  if (h2h) {
    const r = matchResult(h2h);
    const aWon = (r.winner === 1 && h2h.team_a_id === a.team.id) || (r.winner === 2 && h2h.team_b_id === a.team.id);
    a.basis = b.basis = '兩隊對戰勝負';
    return aWon ? [a, b] : [b, a];
  }
  // 兩隊還沒交手（比賽進行中）：比全部比賽的勝率
  for (const key of ['rubberRatio', 'gameRatio', 'pointRatio']) {
    if (a.overall[key] !== b.overall[key]) {
      a.basis = b.basis = `全賽・${{ rubberRatio: '點數', gameRatio: '局數', pointRatio: '分數' }[key]}勝率`;
      return a.overall[key] > b.overall[key] ? [a, b] : [b, a];
    }
  }
  a.drawTied = b.drawTied = true;
  a.basis = b.basis = '戰績相同・抽籤';
  return drawRank(a) <= drawRank(b) ? [a, b] : [b, a];
}

function resolveGroup(group, done) {
  const ids = new Set(group.map((s) => s.team.id));
  const mutual = done.filter((m) => ids.has(m.team_a_id) && ids.has(m.team_b_id));
  for (const s of group) {
    const t = emptyTotals();
    for (const m of mutual) {
      if (m.team_a_id === s.team.id) tally(t, m, 1);
      else if (m.team_b_id === s.team.id) tally(t, m, 2);
    }
    s.mutual = { ...t, ...ratiosOf(t) };
  }
  const sorted = [...group].sort((a, b) => {
    for (const { key } of STEPS) {
      if (a.mutual[key] !== b.mutual[key]) return a.mutual[key] > b.mutual[key] ? -1 : 1;
    }
    return drawRank(a) - drawRank(b);
  });
  for (const s of sorted) {
    let peers = group;
    s.basis = '';
    for (const { key, label } of STEPS) {
      peers = peers.filter((o) => o.mutual[key] === s.mutual[key]);
      if (peers.length === 1) {
        s.basis = label;
        break;
      }
    }
    if (!s.basis) {
      s.drawTied = true;
      s.basis = '戰績相同・抽籤';
    }
  }
  return sorted;
}

// 單循環賽程（環狀輪轉法），奇數隊自動輪空
export function roundRobin(teamIds) {
  const slots = [...teamIds];
  if (slots.length % 2) slots.push(null);
  const n = slots.length;
  const pairs = [];
  for (let round = 1; round < n; round++) {
    let seq = 0;
    for (let i = 0; i < n / 2; i++) {
      const a = slots[i];
      const b = slots[n - 1 - i];
      if (a && b) pairs.push({ round, seq: seq++, team_a_id: a, team_b_id: b });
    }
    slots.splice(1, 0, slots.pop());
  }
  return pairs;
}
