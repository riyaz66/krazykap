"use client";

import { cn } from "@/lib/utils";
import type { LeaderboardRow } from "@/lib/types";

const MEDALS = ["🥇", "🥈", "🥉"];

/**
 * Leaderboard with mode switching (PRD §12) — multiple categories so the
 * same high performer doesn't sweep every board.
 */
export function Leaderboard({
  rows,
  mode = "xp",
  highlightId,
  dense = false,
  max = 10,
}: {
  rows: LeaderboardRow[];
  mode?: string;
  highlightId?: string;
  dense?: boolean;
  max?: number;
}) {
  const shown = rows.slice(0, max);

  if (shown.length === 0) {
    return (
      <div className="grid place-items-center rounded-2xl border border-dashed border-border bg-card/60 px-6 py-10 text-center">
        <p className="font-display text-base font-bold">No rankings yet</p>
        <p className="mt-1 text-sm text-muted-foreground">
          The board fills once answers are scored.
        </p>
      </div>
    );
  }

  return (
    <ol className="flex w-full flex-col gap-2">
      {shown.map((row) => {
        const isMe = row.id === highlightId;
        const value =
          mode === "accuracy"
            ? `${row.accuracy ?? 0}%`
            : mode === "speed"
              ? row.avg_speed
                ? `${(row.avg_speed / 1000).toFixed(1)}s`
                : "—"
              : mode === "streak"
                ? `${row.best_streak}🔥`
                : mode === "participation"
                  ? `${row.answered_count}`
                  : `${row.xp} XP`;

        return (
          <li
            key={row.id}
            className={cn(
              "flex items-center gap-3 rounded-xl border transition-all",
              dense ? "px-3 py-2" : "px-4 py-3",
              row.rank <= 3 && "border-[var(--gold)]/45 bg-[var(--gold)]/10",
              isMe
                ? "border-[var(--ember)] bg-[var(--ember)]/10 shadow-[0_0_0_1px_rgba(245,113,31,0.35)]"
                : "border-border bg-card",
            )}
          >
            <span
              className={cn(
                "grid shrink-0 place-items-center rounded-lg font-display font-extrabold tabular-nums",
                dense ? "size-7 text-xs" : "size-9 text-sm",
                row.rank <= 3 ? "bg-transparent text-lg font-emoji" : "bg-muted text-muted-foreground",
              )}
              style={{ fontFamily: '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Android Emoji", sans-serif' }}
            >
              {row.rank <= 3 ? MEDALS[row.rank - 1] : row.rank}
            </span>

            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  "truncate font-display font-bold",
                  dense ? "text-sm" : "text-base",
                )}
              >
                {row.nickname}
                {row.team && (
                  <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {row.team}
                  </span>
                )}
              </p>
              {!dense && (
                <p className="text-xs text-muted-foreground">
                  {row.correct_count}/{row.answered_count} correct
                  {row.best_streak > 1 && ` · best streak ${row.best_streak}`}
                </p>
              )}
            </div>

            <span
              className={cn(
                "shrink-0 font-display font-extrabold tabular-nums",
                dense ? "text-sm" : "text-base",
                row.rank === 1 ? "text-[var(--gold)]" : "text-foreground",
              )}
            >
              {value}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
