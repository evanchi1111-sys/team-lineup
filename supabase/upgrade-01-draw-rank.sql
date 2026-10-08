-- =====================================================================
-- 升級 01：積分排名的抽籤順位（隊伍戰績完全相同時，由主辦填入）
-- 用法：Supabase → SQL Editor → New query → 貼上全部內容 → Run
-- 可以重複執行；2026-10-08 之後用新版 setup.sql 建立的專案不需要執行。
-- =====================================================================

alter table public.tl_teams add column if not exists draw_rank int check (draw_rank between 1 and 99);
