"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { Logo } from "@/components/logo";
import { ResponseBars } from "@/components/response-bars";
import { ValueBars, groupValues } from "@/components/value-bars";
import { TimerRing } from "@/components/timer-ring";
import { RoomQr } from "@/components/room-qr";
import { Leaderboard } from "@/components/leaderboard";
import { PodiumView } from "@/components/podium-view";
import { useTeacherRoom } from "@/lib/use-teacher-room";
import { useRoomChannel } from "@/lib/use-room-channel";
import { useCountdown } from "@/lib/use-countdown";
import { supabase, rpcError } from "@/lib/rpc";
import { OPTION_LETTERS } from "@/lib/game";
import type { DistributionBucket, TeacherState } from "@/lib/types";
import { Loader2 } from "lucide-react";

const PHASE_LABEL: Record<string, string> = {
  answering: "Answers open",
  distribution: "Discussing",
  revealed: "Answer revealed",
  leaderboard: "Leaderboard",
};

/** No-op subscribe for `useSyncExternalStore` — the window origin is stable. */
const emptySubscribe = () => () => {};

/**
 * Smartboard view (PRD §7).
 *
 * Read-only: it shows the question, the live distribution, the clock and the
 * leaderboard — never the teacher's controls, so the projector can't be
 * mistaken for the control centre.
 */
export function DisplayBoard({ code }: { code: string }) {
  const [roomId, setRoomId] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase
        .from("rooms")
        .select("id")
        .eq("code", code.toUpperCase())
        .in("status", ["lobby", "active"])
        .maybeSingle();
      if (cancelled) return;
      if (error) setResolveError(rpcError(error));
      else if (!data) setResolveError("room_not_found");
      else setRoomId(data.id as string);
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  const { state, error, ready, refresh } = useTeacherRoom(roomId);
  useRoomChannel({
    roomId,
    kind: "display",
    nickname: "display",
    enabled: !!roomId,
    onEvent: () => void refresh(),
  });

  if (resolveError) {
    return (
      <Shell code={code}>
        <div className="grid place-items-center rounded-3xl border bg-card p-12 text-center">
          <div>
            <p className="font-display text-3xl font-extrabold">
              Room {code} isn&apos;t live
            </p>
            <p className="mt-2 text-muted-foreground">
              It may have ended. Start a new room from the dashboard.
            </p>
            <Link
              href="/dashboard"
              className="mt-5 inline-block rounded-xl bg-[var(--primary)] px-5 py-2.5 font-semibold text-white"
            >
              Dashboard
            </Link>
          </div>
        </div>
      </Shell>
    );
  }

  if (!ready || (!state && !error)) {
    return (
      <Shell code={code}>
        <div className="flex items-center justify-center gap-3 py-40 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" /> Connecting to room…
        </div>
      </Shell>
    );
  }

  if (!state) {
    return (
      <Shell code={code}>
        <div className="grid place-items-center rounded-3xl border bg-card p-12 text-center">
          <div>
            <p className="font-display text-3xl font-extrabold">Couldn&apos;t load</p>
            <p className="mt-2 font-mono text-sm text-muted-foreground">{error}</p>
          </div>
        </div>
      </Shell>
    );
  }

  return <Board state={state} code={code} />;
}

function Shell({ code, children }: { code: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-7xl flex-col gap-5 px-5 py-6">
      <header className="flex flex-wrap items-center justify-between gap-3 mb-2">
        <div className="flex items-center gap-3">
          <Logo />
        </div>
        <span className="room-code rounded-xl bg-[var(--primary)] px-3 py-1.5 text-lg font-bold text-white">
          {code}
        </span>
      </header>
      {children}
    </div>
  );
}

function Board({ state, code }: { state: TeacherState; code: string }) {
  const a = state.activity;
  const total = state.participants.length;
  const answered = a?.response_count ?? 0;
  const revealed = a?.state === "revealed" || a?.state === "leaderboard";
  const numeric = a?.type === "numerical";
  const closed = state.room.status === "closed" || state.room.status === "expired";
  const origin = useSyncExternalStore(
    emptySubscribe,
    () => window.location.origin,
    () => "",
  );
  const remaining = useCountdown(a?.state === "answering" ? a.deadline : null, state.server_time_ms);

  const buckets = useMemo<DistributionBucket[]>(() => {
    if (!a) return [];
    const counts = new Map<number, number>();
    for (const r of a.responses) {
      const raw = r.answer?.[0];
      const key = typeof raw === "number" ? raw : Number(raw);
      const k = Number.isFinite(key) ? key : -1;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return [...counts.entries()].map(([key, count]) => ({ key, count }));
  }, [a]);

  const valueBuckets = useMemo(() => (a ? groupValues(a.responses) : []), [a]);

  const correctIndex =
    revealed && a && a.type !== "numerical"
      ? typeof a.correct_answer?.[0] === "number"
        ? (a.correct_answer[0] as number)
        : 0
      : null;

  const showDistribution = a?.state === "distribution" || a?.state === "revealed" || a?.state === "leaderboard";

  return (
    <Shell code={code}>
      {/* ------------------------------------------------ stats strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Players" value={total} />
        <Stat
          label="Answered"
          value={answered}
          tone={total > 0 && answered >= total ? "full" : "default"}
        />
        <Stat label="Question" value={a ? `Q${a.seq}` : "—"} />
        <Stat
          label="Round"
          value={closed ? "Ended" : state.room.status === "lobby" ? "Lobby" : "Live"}
        />
      </div>

      <main className="grid flex-1 items-start gap-5 lg:grid-cols-[1.4fr_1fr]">
        <section className="flex flex-col gap-4">
          {a ? (
            <>
              <div className="rounded-3xl border border-border bg-card p-6 shadow-sm sm:p-8">
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  <span className="rounded-lg bg-[var(--ember)]/12 px-2.5 py-1 text-xs font-bold tracking-wide text-[var(--primary)] uppercase">
                    {a.type.replace("_", " ")}
                  </span>
                  <span className="rounded-lg bg-muted px-2.5 py-1 text-xs font-bold text-muted-foreground">
                    {a.difficulty}
                  </span>
                  {a.state !== "answering" && PHASE_LABEL[a.state] && (
                    <span className="rounded-lg bg-[var(--gold)]/15 px-2.5 py-1 text-xs font-bold text-[var(--primary)]">
                      {PHASE_LABEL[a.state]}
                    </span>
                  )}
                </div>

                <p className="font-display text-3xl leading-tight font-extrabold break-words sm:text-5xl">
                  {a.prompt}
                </p>

                {a.state === "answering" && (
                  <div className="mt-6 flex flex-wrap items-center gap-5">
                    <TimerRing seconds={remaining} total={a.timer_seconds} size="lg" />
                    <div>
                      <p className="font-display text-xl font-extrabold sm:text-2xl">
                        {answered} of {total} answered
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Phones are locked to this question until the timer runs out.
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {showDistribution ? (
                <div className="rounded-3xl border border-border bg-card p-5 sm:p-6">
                  <p className="mb-3 text-xs font-bold tracking-widest text-muted-foreground uppercase">
                    Live response distribution
                  </p>
                  {numeric ? (
                    <ValueBars buckets={valueBuckets} total={answered} />
                  ) : (
                    <ResponseBars
                      buckets={buckets}
                      total={answered}
                      optionCount={a.options?.length || 4}
                      correctIndex={correctIndex}
                    />
                  )}
                  {!revealed && (
                    <p className="mt-3 text-xs text-muted-foreground">
                      Anonymous split — no names, no individual answers, until you reveal.
                    </p>
                  )}
                </div>
              ) : (
                <div className="rounded-3xl border border-dashed border-border bg-card/60 p-8 text-center">
                  <p className="font-display text-lg font-bold">Responses Collecting</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Distribution will be displayed when controlled from teacher screen.
                  </p>
                </div>
              )}

              {revealed && a.type !== "numerical" && (
                <div className="rounded-3xl border border-border bg-card p-5 sm:p-6">
                  <p className="mb-3 text-xs font-bold tracking-widest text-muted-foreground uppercase">
                    Options
                  </p>
                  <ul className="grid gap-2 sm:grid-cols-2">
                    {a.options.map((o, i) => (
                      <li
                        key={i}
                        className={`flex items-center gap-3 rounded-xl border-2 px-3 py-2.5 ${
                          i === correctIndex
                            ? "border-[var(--success)] bg-[var(--success)]/10"
                            : "border-border bg-muted/40"
                        }`}
                      >
                        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-muted-foreground/70 font-display text-xs font-extrabold text-white">
                          {OPTION_LETTERS[i] ?? i + 1}
                        </span>
                        <span className="min-w-0 flex-1 font-medium">{o}</span>
                        {i === correctIndex && (
                          <span className="font-display text-sm font-extrabold text-[var(--success)]">
                            ✓
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {revealed && numeric && (
                <div className="rounded-3xl border border-[var(--success)]/40 bg-[var(--success)]/10 p-5 sm:p-6">
                  <p className="text-xs font-bold tracking-widest text-muted-foreground uppercase">
                    Correct answer
                  </p>
                  <p className="font-display mt-1.5 text-3xl font-extrabold text-[var(--success)] sm:text-4xl">
                    {String(a.correct_answer?.[0] ?? "—")}
                    {Number(a.correct_answer?.[1]) > 0 && (
                      <span className="text-base font-semibold text-muted-foreground">
                        {" "}
                        ± {String(a.correct_answer?.[1])}
                      </span>
                    )}
                  </p>
                </div>
              )}

              {a.explanation && revealed && (
                <div className="rounded-3xl border border-[var(--gold)]/40 bg-[var(--gold)]/10 p-5">
                  <p className="text-xs font-bold tracking-widest text-muted-foreground uppercase">
                    Why
                  </p>
                  <p className="mt-1.5 text-lg">{a.explanation}</p>
                </div>
              )}
            </>
          ) : (
            <div className="rounded-3xl border border-border bg-gradient-to-br from-[var(--ember)]/15 via-[var(--gold)]/10 to-[var(--primary)]/10 p-8 sm:p-14">
              <div
                className={
                  closed
                    ? ""
                    : "flex flex-col items-start gap-7 sm:flex-row sm:items-center"
                }
              >
                {/* The QR lives on the board, not only on the teacher's laptop:
                    this is the surface the class is told to scan (PRD §5). */}
                {!closed && origin && (
                  <RoomQr
                    url={`${origin}/join/${code}`}
                    size={220}
                    className="shrink-0"
                  />
                )}
                <div className="min-w-0">
                  <h1 className="font-display text-4xl leading-tight font-extrabold sm:text-6xl">
                    {closed
                      ? "That’s a wrap"
                      : state.room.status === "lobby"
                        ? state.room.title
                        : "Next question soon"}
                  </h1>
                  <p className="mt-3 max-w-lg text-lg text-muted-foreground sm:text-xl">
                    {closed
                      ? "Thanks for playing — this room is closed and the temporary data is gone."
                      : state.room.status === "lobby"
                        ? "Scan the QR or enter the room code on your phone to join."
                        : "The teacher is setting up the next challenge."}
                  </p>
                </div>
              </div>
            </div>
          )}
        </section>

        <aside className="flex flex-col gap-4">
          <div className="rounded-3xl border border-border bg-card p-5">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-heading text-lg font-bold">Leaderboard</h3>
            </div>
            <div className="max-h-[420px] overflow-y-auto pr-1">
              <Leaderboard rows={state.leaderboard} max={50} />
            </div>
          </div>

              {closed && state.leaderboard.length > 0 && (
                <div className="mb-6">
                  <PodiumView leaderboard={state.leaderboard} />
                </div>
              )}

          <div className="rounded-3xl border border-border bg-card p-5">
            <p className="text-xs font-bold tracking-widest text-muted-foreground uppercase">
              In the room
            </p>
            <p className="font-display mt-1 text-4xl font-extrabold">{total}</p>
            <div className="mt-3 flex max-h-[140px] flex-wrap gap-1.5 overflow-y-auto pr-1">
              {state.participants.map((p) => (
                <span
                  key={p.id}
                  className="rounded-lg bg-muted px-2 py-1 text-xs font-medium"
                >
                  {p.nickname}
                </span>
              ))}
            </div>
          </div>
        </aside>
      </main>
    </Shell>
  );
}

function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string | number;
  tone?: "default" | "full";
}) {
  return (
    <div className="rounded-2xl border border-border bg-card px-4 py-3">
      <p className="text-[11px] font-bold tracking-widest text-muted-foreground uppercase">
        {label}
      </p>
      <p
        className={`font-display text-3xl font-extrabold tabular-nums ${
          tone === "full" ? "text-[var(--success)]" : "text-foreground"
        }`}
      >
        {value}
      </p>
    </div>
  );
}
