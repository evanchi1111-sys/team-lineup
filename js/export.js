// 匯出 Excel 與 LINE 文字戰報。ctx 由 app.js 提供：
// { title, matches, teams, teamName(id), playerNames(ids), lineupOf(matchId, teamId), matchResult(m), statusLabel(m) }

const fileStamp = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const gamesText = (games) => games.map((g) => `${g[0]}:${g[1]}`).join('、');

export function exportExcel(ctx) {
  const XLSX = window.XLSX;
  if (!XLSX) throw new Error('匯出模組還在載入，請稍候幾秒再試');
  const summary = [];
  const detail = [];
  for (const m of ctx.matches) {
    const r = ctx.matchResult(m);
    const a = ctx.teamName(m.team_a_id);
    const b = ctx.teamName(m.team_b_id);
    summary.push({
      輪次: `第 ${m.round} 輪`, 隊伍A: a, 隊伍B: b,
      點數比分: m.status === 'scheduled' ? '' : `${r.a} : ${r.b}`,
      勝方: r.winner ? (r.winner === 1 ? a : b) : '', 狀態: ctx.statusLabel(m), 備註: m.notes || '',
    });
    const la = ctx.lineupOf(m.id, m.team_a_id);
    const lb = ctx.lineupOf(m.id, m.team_b_id);
    for (const pt of r.points) {
      if (!pt.games.length && !la && !lb) continue;
      detail.push({
        輪次: `第 ${m.round} 輪`, 對戰: `${a} vs ${b}`, 點次: `${pt.label}（${pt.type}）`,
        A隊出賽: la ? ctx.playerNames(la[pt.key]) : '',
        B隊出賽: lb ? ctx.playerNames(lb[pt.key]) : '',
        局數: pt.games.length ? `${pt.a} : ${pt.b}` : '', 各局比分: gamesText(pt.games),
        勝方: pt.winner ? (pt.winner === 1 ? a : b) : '',
      });
    }
  }
  const roster = ctx.teams.map((t) => ({ 隊伍: t.name, 選手: ctx.playerNames(ctx.playersOf(t.id).map((p) => p.id)) }));

  const wb = XLSX.utils.book_new();
  const add = (rows, name, widths) => {
    const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ 說明: '（無資料）' }]);
    ws['!cols'] = widths.map((wch) => ({ wch }));
    XLSX.utils.book_append_sheet(wb, ws, name);
  };
  add(ctx.standings.map((s) => ({
    名次: s.rank, 隊伍: s.team.name, 積分: s.score, 出賽: s.played, 勝: s.wins, 敗: s.losses,
    點數: `${s.rubbersWon} : ${s.rubbersLost}`, 局數: `${s.gamesWon} : ${s.gamesLost}`, 得失分: `${s.pointsWon} : ${s.pointsLost}`,
    判定依據: s.drawTied && s.team.draw_rank == null ? `${s.basis}（未抽籤）` : s.basis,
  })), '積分排名', [6, 12, 6, 6, 5, 5, 8, 8, 10, 20]);
  add(summary, '對戰結果', [8, 12, 12, 9, 12, 8, 20]);
  add(detail, '各點明細', [8, 26, 16, 16, 16, 7, 30, 12]);
  add(roster, '隊伍名單', [12, 60]);
  XLSX.writeFile(wb, `${ctx.title}_${fileStamp(new Date())}.xlsx`);
}

export function lineReport(ctx) {
  const lines = [`🏓 ${ctx.title} 戰報`, ''];
  if (ctx.standings.some((s) => s.played)) {
    lines.push('【積分排名】');
    for (const s of ctx.standings) lines.push(`${s.rank}. ${s.team.name}　${s.score} 分（${s.wins} 勝 ${s.losses} 敗，點數 ${s.rubbersWon}:${s.rubbersLost}）`);
    lines.push('');
  }
  const rounds = [...new Set(ctx.matches.map((m) => m.round))].sort((x, y) => x - y);
  for (const round of rounds) {
    lines.push(`【第 ${round} 輪】`);
    for (const m of ctx.matches.filter((x) => x.round === round)) {
      const r = ctx.matchResult(m);
      const a = ctx.teamName(m.team_a_id);
      const b = ctx.teamName(m.team_b_id);
      if (m.status === 'scheduled') {
        lines.push(`${a} vs ${b}（未開始）`);
        continue;
      }
      lines.push(`${a} ${r.a} : ${r.b} ${b}${r.winner ? `　🏆 ${r.winner === 1 ? a : b}` : '（進行中）'}`);
      const la = ctx.lineupOf(m.id, m.team_a_id);
      const lb = ctx.lineupOf(m.id, m.team_b_id);
      for (const pt of r.points) {
        if (!pt.games.length) continue;
        const who = la && lb ? `${ctx.playerNames(la[pt.key])} vs ${ctx.playerNames(lb[pt.key])} ` : '';
        lines.push(`　${pt.label}${pt.type} ${who}${pt.a}:${pt.b}（${gamesText(pt.games)}）`);
      }
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}
