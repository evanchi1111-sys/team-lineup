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
