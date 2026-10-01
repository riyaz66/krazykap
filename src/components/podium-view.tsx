"use client";

import { useRef } from "react";
import type { LeaderboardRow } from "@/lib/types";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";

export function PodiumView({ leaderboard }: { leaderboard: LeaderboardRow[] }) {
  const containerRef = useRef<HTMLDivElement>(null);

  const correctLeaderboard = leaderboard.filter((r) => r.correct_count > 0);

  const first = correctLeaderboard[0];
  const second = correctLeaderboard[1];
  const third = correctLeaderboard[2];

  const handleDownload = () => {
    if (!containerRef.current) return;
    const node = containerRef.current;

    const width = node.offsetWidth || 600;
    const height = node.offsetHeight || 400;

    const canvas = document.createElement("canvas");
    canvas.width = width * 2;
    canvas.height = height * 2;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.scale(2, 2);

    // Background fill
    ctx.fillStyle = "#0f172a"; // dark background
    ctx.fillRect(0, 0, width, height);

    // Title
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 24px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Top Champions", width / 2, 40);

    const stepWidth = Math.min(130, width / 3.5);
    const baseX = width / 2;
    const groundY = height - 40;

    // Helper to draw podium step and text
    const drawPodium = (
      p: LeaderboardRow | undefined,
      rank: number,
      x: number,
      stepHeight: number,
      color: string,
      label: string,
      medal: string
    ) => {
      // Step box
      ctx.fillStyle = color;
      ctx.fillRect(x - stepWidth / 2, groundY - stepHeight, stepWidth, stepHeight);

      // Step border
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.strokeRect(x - stepWidth / 2, groundY - stepHeight, stepWidth, stepHeight);

      // Rank Label
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 28px sans-serif";
      ctx.fillText(label, x, groundY - stepHeight / 2 + 10);

      // Person details above step
      if (p) {
        ctx.fillStyle = "#ffffff";
        ctx.font = "24px sans-serif";
        ctx.fillText(medal, x, groundY - stepHeight - 55);

        ctx.font = "bold 18px sans-serif";
        ctx.fillText(p.nickname, x, groundY - stepHeight - 30);

        ctx.font = "14px sans-serif";
        ctx.fillStyle = "#e2e8f0";
        ctx.fillText(`${p.xp} XP`, x, groundY - stepHeight - 10);
      } else {
        ctx.fillStyle = "#94a3b8";
        ctx.font = "italic 14px sans-serif";
        ctx.fillText("Empty", x, groundY - stepHeight - 15);
      }
    };

    // 2nd Place (Left)
    drawPodium(second, 2, baseX - stepWidth - 15, 120, "#64748b", "2", "🥈");
    // 1st Place (Center)
    drawPodium(first, 1, baseX, 170, "#eab308", "1", "🥇");
    // 3rd Place (Right)
    drawPodium(third, 3, baseX + stepWidth + 15, 80, "#b45309", "3", "🥉");

    // Download image
    const link = document.createElement("a");
    link.download = "top_3_champions.png";
    link.href = canvas.toDataURL("image/png");
    link.click();
  };

  return (
    <div className="flex flex-col items-center gap-4 w-full">
      <div
        ref={containerRef}
        className="relative flex w-full max-w-2xl items-end justify-center gap-3 sm:gap-6 rounded-3xl border border-border bg-card p-6 sm:p-10 pt-16 shadow-lg min-h-[380px]"
      >
        {/* 2nd Place - Silver (Left Stair) */}
        <div className="flex flex-col items-center flex-1 max-w-[150px]">
          {second ? (
            <div className="mb-3 text-center">
              <span className="text-3xl sm:text-4xl">🥈</span>
              <p className="font-display font-extrabold text-sm sm:text-lg truncate max-w-[120px]">
                {second.nickname}
              </p>
              <p className="text-xs font-semibold text-muted-foreground">{second.xp} XP</p>
            </div>
          ) : (
            <p className="mb-3 text-xs text-muted-foreground italic">Empty</p>
          )}
          <div className="flex h-32 sm:h-40 w-full flex-col items-center justify-center rounded-t-2xl border-2 border-slate-400 bg-slate-500/20 shadow-inner">
            <span className="font-display text-2xl sm:text-4xl font-black text-slate-300">2</span>
          </div>
        </div>

        {/* 1st Place - Gold (Center Stair) */}
        <div className="flex flex-col items-center flex-1 max-w-[160px] -mt-6">
          {first ? (
            <div className="mb-3 text-center">
              <span className="text-4xl sm:text-5xl animate-bounce">🥇</span>
              <p className="font-display font-black text-base sm:text-xl text-[var(--gold)] truncate max-w-[130px]">
                {first.nickname}
              </p>
              <p className="text-xs sm:text-sm font-bold text-[var(--gold)]/90">{first.xp} XP</p>
            </div>
          ) : (
            <p className="mb-3 text-xs text-muted-foreground italic">Empty</p>
          )}
          <div className="flex h-44 sm:h-56 w-full flex-col items-center justify-center rounded-t-2xl border-2 border-[var(--gold)] bg-[var(--gold)]/25 shadow-2xl">
            <span className="font-display text-4xl sm:text-6xl font-black text-[var(--gold)]">1</span>
          </div>
        </div>

        {/* 3rd Place - Bronze (Right Stair) */}
        <div className="flex flex-col items-center flex-1 max-w-[150px]">
          {third ? (
            <div className="mb-3 text-center">
              <span className="text-3xl sm:text-4xl">🥉</span>
              <p className="font-display font-extrabold text-sm sm:text-lg truncate max-w-[120px]">
                {third.nickname}
              </p>
              <p className="text-xs font-semibold text-muted-foreground">{third.xp} XP</p>
            </div>
          ) : (
            <p className="mb-3 text-xs text-muted-foreground italic">Empty</p>
          )}
          <div className="flex h-24 sm:h-28 w-full flex-col items-center justify-center rounded-t-2xl border-2 border-amber-700 bg-amber-800/20 shadow-inner">
            <span className="font-display text-2xl sm:text-4xl font-black text-amber-600">3</span>
          </div>
        </div>
      </div>

      <Button onClick={handleDownload} variant="outline" size="sm" className="gap-2">
        <Download className="size-4" /> Download Podium PNG
      </Button>
    </div>
  );
}
