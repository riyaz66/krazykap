"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { Logo } from "@/components/logo";
import { RoomQr } from "@/components/room-qr";
import { ResponseBars } from "@/components/response-bars";
import { ValueBars, groupValues } from "@/components/value-bars";
import { TimerRing } from "@/components/timer-ring";
import { Leaderboard } from "@/components/leaderboard";
import { PodiumView } from "@/components/podium-view";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useTeacherRoom } from "@/lib/use-teacher-room";
import { useRoomChannel } from "@/lib/use-room-channel";
import { useCountdown } from "@/lib/use-countdown";
import {
  closeActivity,
  closeRoom,
  launchActivity,
  pauseTimer,
  rpcError,
  setActivityState,
  setRoomSettings,
  decideChallenge,
} from "@/lib/rpc";
import {
  DIFFICULTIES,
  OPTION_LETTERS,
  QUICK_TEMPLATES,
} from "@/lib/game";
import type {
  Difficulty,
  DistributionBucket,
  RoomSettings,
  SessionSummary,
  TeacherState,
} from "@/lib/types";
import { toast } from "sonner";
import {
  BarChart3,
  Copy,
  Maximize2,
  Pause,
  Play,
  Plus,
  Eye,
  EyeOff,
  Trophy,
  Flag,
  Users,
  Loader2,
  CheckCircle2,
  XCircle,
  Rocket,
  Square,
  Radio,
} from "lucide-react";

/** For values that never change during the session (there is nothing to subscribe to). */
function emptySubscribe() {
  return () => {};
}

export function RoomControl({ code }: { code: string }) {
  const [roomId, setRoomId] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  // Lifted so "End class" can land on the wrap-up instead of the dashboard.
  const [summaryOpen, setSummaryOpen] = useState(false);

  // Resolve the human-friendly code into a room id (RLS scopes this to us).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { createClient } = await import("@/lib/client");
      const sb = createClient();
      const { data, error } = await sb
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
  const { emit } = useRoomChannel({
    roomId,
    kind: "teacher",
    nickname: "teacher",
    enabled: !!roomId,
  });

  const notify = useCallback(() => {
    emit("refresh");
    void refresh();
  }, [emit, refresh]);

  if (resolveError) return <ResolveFailed code={code} message={resolveError} />;

  return (
    <div className="min-h-dvh bg-background">
      <ControlHeader
        code={code}
        roomId={roomId}
        participantCount={state?.participants.length ?? 0}
        status={state?.room.status ?? "lobby"}
        expiresAt={state?.room.expires_at ?? null}
        summary={state?.summary ?? null}
        summaryOpen={summaryOpen}
        onSummaryOpenChange={setSummaryOpen}
        onEndRoom={async () => {
          if (!roomId) return;
          const { error: e } = await closeRoom(roomId);
          if (e) return toast.error(e);
          emit("closed");
          void refresh();
          toast.success("Class ended");
          setSummaryOpen(true);
        }}
        onCopy={() => {
          void navigator.clipboard.writeText(window.location.origin + "/join/" + code);
          toast.success("Join link copied");
        }}
      />

      <main className="mx-auto max-w-7xl px-4 py-5 sm:px-6">
        {!ready && !error ? (
          <div className="flex items-center gap-2 py-20 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Connecting to room…
          </div>
        ) : error ? (
          <ErrorPanel message={error} onRetry={() => void refresh()} />
        ) : state ? (
          <RoomBody
            state={state}
            code={code}
            roomId={roomId!}
            onChange={notify}
            emit={emit}
          />
        ) : null}
      </main>
    </div>
  );
}

/* -------------------------------------------------------------- header --- */

function ControlHeader({
  code,
  roomId,
  participantCount,
  status,
  expiresAt,
  summary,
  summaryOpen,
  onSummaryOpenChange,
  onEndRoom,
  onCopy,
}: {
  code: string;
  roomId: string | null;
  participantCount: number;
  status: string;
  expiresAt: string | null;
  summary: SessionSummary | null;
  summaryOpen: boolean;
  onSummaryOpenChange: (v: boolean) => void;
  onEndRoom: () => unknown;
  onCopy: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [ending, setEnding] = useState(false);

  const [podiumModalOpen, setPodiumModalOpen] = useState(false);

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-card/85 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
        <Link href="/dashboard" aria-label="Back to dashboard">
          <Logo compact />
        </Link>

        <div className="flex items-center gap-2">
          <span className="room-code rounded-lg bg-[var(--primary)] px-2.5 py-1 text-sm font-bold text-white">
            {code}
          </span>
          <button
            type="button"
            onClick={onCopy}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Copy join link"
          >
            <Copy className="size-4" />
          </button>
        </div>

        <span className="flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-semibold">
          <Users className="size-3.5" /> {participantCount}
        </span>

        <Badge variant={status === "active" ? "default" : "secondary"} className="text-[10px]">
          <Radio className="size-3" /> {status}
        </Badge>

        {expiresAt && (
          <span className="hidden text-xs text-muted-foreground md:inline">
            expires {new Date(expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setPodiumModalOpen(true)}>
            🏆 Podium
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onSummaryOpenChange(true)}>
            <BarChart3 className="size-4" /> Summary
          </Button>
          {roomId && (
            <Button variant="outline" size="sm" asChild>
              <Link href={`/room/${code}/display`} target="_blank">
                <Maximize2 className="size-4" /> Display mode
              </Link>
            </Button>
          )}
          <Button variant="destructive" size="sm" onClick={() => setConfirming(true)}>
            <Square className="size-4" /> End class
          </Button>
        </div>
      </div>

      <SummaryDialog
        open={summaryOpen}
        onOpenChange={onSummaryOpenChange}
        summary={summary}
        running={status === "active" || status === "lobby"}
      />

      <Dialog open={podiumModalOpen} onOpenChange={setPodiumModalOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="font-display text-xl font-extrabold">
              🏆 Olympic Podium Stand
            </DialogTitle>
          </DialogHeader>
          <PodiumView leaderboard={summary?.leaderboard || []} />
        </DialogContent>
      </Dialog>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-display text-lg font-extrabold">
              End this class?
            </DialogTitle>
            <DialogDescription>
              Every student is disconnected, the code stops working, and all
              temporary room data is deleted or expired. Your question bank is kept.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              Keep going
            </Button>
            <Button
              variant="destructive"
              disabled={ending}
              onClick={async () => {
                setEnding(true);
                await onEndRoom();
                setEnding(false);
                setConfirming(false);
              }}
            >
              {ending && <Loader2 className="size-4 animate-spin" />} End class
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </header>
  );
}

/* ---------------------------------------------------------------- body --- */

function RoomBody({
  state,
  code,
  roomId,
  onChange,
  emit,
}: {
  state: TeacherState;
  code: string;
  roomId: string;
  onChange: () => void;
  emit: (e: "refresh" | "launched" | "revealed" | "closed" | "answered" | "lobby") => void;
}) {
  const activity = state.activity;
  const [composerOpen, setComposerOpen] = useState(false);

  const answered = activity?.response_count ?? 0;
  const total = state.participants.length;
  const waiting = total - answered;

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
      {/* ----------------------------------------------------- main column */}
      <div className="flex flex-col gap-5">
        {activity ? (
          <ActiveQuestionCard
            state={state}
            roomId={roomId}
            onChange={onChange}
            emit={emit}
          />
        ) : (
          <LobbyCard
            code={code}
            title={state.room.title}
            participants={state.participants}
            onLaunch={() => setComposerOpen(true)}
          />
        )}

        {activity && (
          <div className="flex flex-wrap gap-2">
            <Button size="lg" onClick={() => setComposerOpen(true)}>
              <Plus className="size-4" /> New question
            </Button>
          </div>
        )}

        <SettingsCard
          roomId={roomId}
          settings={state.room.settings}
          onChange={onChange}
        />
      </div>

      {/* --------------------------------------------------- side column */}
      <aside className="flex flex-col gap-5">
        <Card>
          <CardHeader>
            <CardTitle className="font-display text-base font-bold">
              Joined · {state.participants.length}
            </CardTitle>
            {activity && (
              <CardDescription>
                {answered} answered · {Math.max(0, waiting)} still deciding
              </CardDescription>
            )}
          </CardHeader>
          <CardContent>
            <ul className="max-h-[300px] space-y-1.5 overflow-y-auto pr-1">
              {state.participants.length === 0 && (
                <li className="py-6 text-center text-sm text-muted-foreground">
                  Waiting for the class to scan…
                </li>
              )}
              {state.participants.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center gap-2 rounded-lg bg-muted/60 px-2.5 py-1.5 text-sm"
                >
                  <span
                    className={`size-2 shrink-0 rounded-full ${
                      p.connected ? "bg-success" : "bg-muted-foreground/40"
                    }`}
                    aria-label={p.connected ? "connected" : "disconnected"}
                  />
                  <span className="min-w-0 flex-1 truncate font-medium">{p.nickname}</span>
                  {p.team && (
                    <span className="shrink-0 text-[10px] uppercase text-muted-foreground">
                      {p.team}
                    </span>
                  )}
                  <span className="shrink-0 text-xs font-bold tabular-nums text-[var(--primary)]">
                    {p.xp}
                  </span>
                  {activity && p.answered_this && (
                    <CheckCircle2 className="size-3.5 shrink-0 text-success" />
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="font-display text-base font-bold">Leaderboard</CardTitle>
          </CardHeader>
          <CardContent>
            <Leaderboard rows={state.leaderboard} dense max={8} />
          </CardContent>
        </Card>

        {state.challenges.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="font-display text-base font-bold">
                Challenges · {state.challenges.length}
              </CardTitle>
              <CardDescription>Approve to award bonus XP.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2">
              {state.challenges.map((c) => (
                <div key={c.id} className="rounded-lg border border-border p-2.5">
                  <p className="text-xs font-semibold text-muted-foreground">{c.nickname}</p>
                  <p className="mt-0.5 text-sm break-words">{c.body}</p>
                  <div className="mt-2 flex gap-2">
                    <Button
                      size="xs"
                      onClick={async () => {
                        const { error } = await decideChallenge(roomId, c.id, true);
                        if (error) return toast.error(error);
                        toast.success("+50 XP awarded");
                        onChange();
                      }}
                    >
                      <CheckCircle2 className="size-3" /> Approve
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={async () => {
                        const { error } = await decideChallenge(roomId, c.id, false);
                        if (error) return toast.error(error);
                        onChange();
                      }}
                    >
                      <XCircle className="size-3" /> Reject
                    </Button>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </aside>

      <QuestionComposer
        open={composerOpen}
        onOpenChange={setComposerOpen}
        roomId={roomId}
        onLaunched={() => {
          setComposerOpen(false);
          emit("launched");
          onChange();
        }}
      />
    </div>
  );
}

/* --------------------------------------------------------------- lobby --- */

function LobbyCard({
  code,
  title,
  participants,
  onLaunch,
}: {
  code: string;
  title: string;
  participants: { nickname: string }[];
  onLaunch: () => void;
}) {
  // `window.location` is unavailable while rendering on the server; this
  // subscribes to it so the client value appears without a render cascade.
  const origin = useSyncExternalStore(
    emptySubscribe,
    () => window.location.origin,
    () => "",
  );

  return (
    <Card className="border-[var(--ember)]/30">
      <CardHeader>
        <CardTitle className="font-display text-xl font-extrabold">{title}</CardTitle>
        <CardDescription>
          Students scan the QR or go to <span className="font-mono">/join/{code}</span>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-start">
          {origin && <RoomQr url={`${origin}/join/${code}`} size={240} />}
          <div className="flex-1 text-center sm:text-left">
            <p className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Room code
            </p>
            <p className="room-code mt-1 text-5xl font-extrabold text-[var(--primary)] sm:text-6xl">
              {code}
            </p>
            <p className="mt-4 text-sm text-muted-foreground">
              {participants.length === 0
                ? "Nobody has joined yet."
                : `${participants.length} student${participants.length === 1 ? "" : "s"} in the lobby.`}
            </p>
            <div className="mt-5">
              <Button size="lg" onClick={onLaunch}>
                <Rocket className="size-4" /> Launch first question
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------- active question --- */

function ActiveQuestionCard({
  state,
  roomId,
  onChange,
  emit,
}: {
  state: TeacherState;
  roomId: string;
  onChange: () => void;
  emit: (e: "refresh" | "revealed" | "answered") => void;
}) {
  const a = state.activity!;
  const remaining = useCountdown(a.state === "answering" ? a.deadline : null, state.server_time_ms);
  const [busy, setBusy] = useState(false);

  // Aggregate the response rows into distribution buckets — same shape the
  // student-side `distribution` gives us, so one bar component serves both.
  const buckets = useMemo<DistributionBucket[]>(() => {
    const counts = new Map<number, number>();
    for (const r of a.responses) {
      const raw = r.answer?.[0];
      const key = typeof raw === "number" ? raw : Number(raw);
      const k = Number.isFinite(key) ? key : -1;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return [...counts.entries()].map(([key, count]) => ({ key, count }));
  }, [a.responses]);

  // A numerical answer has no option slots — `correct_answer` holds
  // [value, tolerance] there, so indexing it would always flag bucket A.
  const numeric = a.type === "numerical";

  const valueBuckets = useMemo(() => groupValues(a.responses), [a.responses]);

  const correctIndex =
    !numeric && (a.state === "revealed" || a.state === "leaderboard")
      ? typeof a.correct_answer?.[0] === "number"
        ? (a.correct_answer[0] as number)
        : 0
      : null;

  async function go(next: string) {
    setBusy(true);
    const { error } = await setActivityState(roomId, next);
    setBusy(false);
    if (error) return toast.error(error);
    if (next === "revealed") emit("revealed");
    else emit("refresh");
    onChange();
  }

  const optionCount = a.options?.length || 4;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">Q{a.seq}</Badge>
              <Badge variant="secondary">{a.type.replace("_", " ")}</Badge>
              <Badge variant="outline">{a.difficulty}</Badge>
              {a.topic && <Badge variant="outline">{a.topic}</Badge>}
              <StateBadge state={a.state} />
            </div>
            <CardTitle className="mt-2 font-display text-xl font-extrabold break-words">
              {a.prompt}
            </CardTitle>
          </div>
          {a.state === "answering" && (
            <TimerRing seconds={remaining} total={a.timer_seconds} size="md" paused={a.paused} />
          )}
        </div>
      </CardHeader>

      <CardContent className="grid gap-5">
        {/* choices preview */}
        {a.state !== "revealed" && a.state !== "leaderboard" && a.type !== "numerical" && (
          <div className="grid gap-2 sm:grid-cols-2">
            {a.options.map((o, i) => (
              <div
                key={i}
                className="flex items-center gap-2 rounded-xl border border-border bg-muted/50 px-3 py-2.5"
              >
                <span className="grid size-6 shrink-0 place-items-center rounded-md bg-muted-foreground/70 text-xs font-bold text-white">
                  {OPTION_LETTERS[i] ?? i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{o}</span>
              </div>
            ))}
          </div>
        )}

        {/* live distribution */}
        {(a.state === "distribution" ||
          a.state === "revealed" ||
          a.state === "leaderboard" ||
          a.response_count > 0) && (
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Live responses · {a.response_count}/{state.participants.length}
            </p>
            {numeric ? (
              <ValueBars buckets={valueBuckets} total={a.response_count} />
            ) : (
              <ResponseBars
                buckets={buckets}
                total={a.response_count}
                optionCount={optionCount}
                correctIndex={correctIndex}
              />
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              Per-answer breakdown appears in the response list below once you reveal.
            </p>
          </div>
        )}

        {/* per-student responses after reveal */}
        {(a.state === "revealed" || a.state === "leaderboard") && a.responses.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Responses
            </p>
            <ul className="max-h-56 space-y-1 overflow-y-auto pr-1">
              {a.responses.map((r) => (
                <li
                  key={r.participant_id}
                  className="flex items-center gap-2 rounded-lg bg-muted/60 px-2.5 py-1.5 text-xs"
                >
                  {r.is_correct ? (
                    <CheckCircle2 className="size-3.5 shrink-0 text-success" />
                  ) : (
                    <XCircle className="size-3.5 shrink-0 text-destructive" />
                  )}
                  <span className="min-w-0 flex-1 truncate font-medium">{r.nickname}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {formatAnswer(r.answer, a.type)}
                  </span>
                  <span className="shrink-0 font-bold tabular-nums text-[var(--primary)]">
                    +{r.xp}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {a.explanation && (a.state === "revealed" || a.state === "leaderboard") && (
          <div className="rounded-xl border border-[var(--gold)]/40 bg-[var(--gold)]/10 p-3">
            <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
              Explanation
            </p>
            <p className="mt-1 text-sm">{a.explanation}</p>
          </div>
        )}

        <Separator />

        {/* ------------------------------------------------- control bar */}
        <div className="flex flex-wrap gap-2">
          {a.state === "answering" && (
            <>
              <Button onClick={() => void go("distribution")} disabled={busy} size="lg">
                <Eye className="size-4" /> Show responses
              </Button>
              <Button
                variant="outline"
                size="lg"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  const { error } = await pauseTimer(roomId);
                  setBusy(false);
                  if (error) return toast.error(error);
                  onChange();
                }}
              >
                <Pause className="size-4" />{" "}
                {a.paused ? "Resume timer" : "Pause timer"}
              </Button>
            </>
          )}

          {(a.state === "distribution" || a.state === "answering") && (
            <Button
              variant="secondary"
              size="lg"
              disabled={busy}
              onClick={() => void go("revealed")}
            >
              <EyeOff className="size-4" /> Reveal answer
            </Button>
          )}

          {(a.state === "revealed" || a.state === "distribution") && (
            <Button size="lg" disabled={busy} onClick={() => void go("leaderboard")}>
              <Trophy className="size-4" /> Show leaderboard
            </Button>
          )}

          <Button
            variant="outline"
            size="lg"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const { error } = await closeActivity(roomId);
              setBusy(false);
              if (error) return toast.error(error);
              onChange();
            }}
          >
            <Flag className="size-4" /> Skip question
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function StateBadge({ state }: { state: string }) {
  const map: Record<string, string> = {
    answering: "bg-[var(--ember)]/15 text-[var(--primary)] border-[var(--ember)]/40",
    distribution: "bg-[var(--gold)]/15 text-[var(--warning)] border-[var(--gold)]/40",
    revealed: "bg-success/15 text-success border-success/40",
    leaderboard: "bg-[var(--option-d)]/15 text-[var(--option-d)] border-[var(--option-d)]/40",
  };
  return (
    <Badge variant="outline" className={map[state] ?? ""}>
      {state}
    </Badge>
  );
}

function formatAnswer(answer: (string | number)[] | undefined, type: string): string {
  if (!answer || answer.length === 0) return "—";
  if (type === "numerical") return String(answer[0]);
  if (type === "true_false") return answer[0] === 0 ? "True" : "False";
  const idx = Number(answer[0]);
  return OPTION_LETTERS[idx] ?? String(answer[0]);
}

/* ------------------------------------------------------------- settings --- */

function SettingsCard({
  roomId,
  settings,
  onChange,
}: {
  roomId: string;
  settings: RoomSettings;
  onChange: () => void;
}) {
  const streaks = settings?.streaks_enabled !== false;
  const allowChange = settings?.allow_change === true;

  async function toggle(key: keyof RoomSettings, value: boolean) {
    const next = { ...settings, [key]: value };
    const { error } = await setRoomSettings(roomId, next);
    if (error) return toast.error(error);
    onChange();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-display text-base font-bold">Room rules</CardTitle>
        <CardDescription>Applied server-side to every score.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <label className="flex items-center justify-between gap-4">
          <span className="text-sm">
            Streak bonuses
            <span className="block text-xs text-muted-foreground">
              3 → +20, 5 → +50, 10 → +100 XP
            </span>
          </span>
          <Switch checked={streaks} onCheckedChange={(v) => void toggle("streaks_enabled", v)} />
        </label>
        <Separator />
        <label className="flex items-center justify-between gap-4">
          <span className="text-sm">
            Allow answer changes
            <span className="block text-xs text-muted-foreground">
              Off = locks after first submission
            </span>
          </span>
          <Switch checked={allowChange} onCheckedChange={(v) => void toggle("allow_change", v)} />
        </label>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------ composer --- */

interface BankQuestion {
  id: string;
  prompt: string;
  type: string;
  options: string[];
  correct_answer: (string | number)[];
  explanation: string | null;
  timer_seconds: number;
  difficulty: Difficulty;
  set_name: string | null;
}

function QuestionComposer({
  open,
  onOpenChange,
  roomId,
  onLaunched,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  roomId: string;
  onLaunched: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [type, setType] = useState("mcq");
  const [options, setOptions] = useState<string[]>(["", "", "", ""]);
  const [correctIdx, setCorrectIdx] = useState(0);
  const [numeric, setNumeric] = useState("");
  const [tolerance, setTolerance] = useState("0");
  const [explanation, setExplanation] = useState("");
  const [timer, setTimer] = useState(30);
  const [difficulty, setDifficulty] = useState<Difficulty>("Medium");
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState(false);

  const [bankQuestions, setBankQuestions] = useState<BankQuestion[]>([]);
  const [selectedSetFilter, setSelectedSetFilter] = useState<string>("all");
  const [currentSetIndex, setCurrentSetIndex] = useState<number>(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const { createClient } = await import("@/lib/client");
      const sb = createClient();
      const { data } = await sb
        .from("questions")
        .select("id,prompt,type,options,correct_answer,explanation,timer_seconds,difficulty,set_name")
        .order("created_at", { ascending: false })
        .limit(50);
      if (cancelled) return;
      if (data) setBankQuestions(data as BankQuestion[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const availableSets = useMemo(() => {
    const sets = new Set<string>();
    bankQuestions.forEach((bq) => {
      if (bq.set_name) sets.add(bq.set_name);
    });
    return Array.from(sets);
  }, [bankQuestions]);

  const filteredBankQuestions = useMemo(() => {
    if (selectedSetFilter === "all") return bankQuestions;
    return bankQuestions.filter((bq) => bq.set_name === selectedSetFilter);
  }, [bankQuestions, selectedSetFilter]);

  function pickFromBank(q: BankQuestion) {
    setPrompt(q.prompt);
    setType(q.type);
    if (q.type === "numerical") {
      setNumeric(String(q.correct_answer?.[0] ?? ""));
      setTolerance(String(q.correct_answer?.[1] ?? "0"));
    } else {
      setOptions(q.options && q.options.length > 0 ? q.options : ["", "", "", ""]);
      setCorrectIdx(
        typeof q.correct_answer?.[0] === "number" ? (q.correct_answer[0] as number) : 0
      );
    }
    if (q.explanation) setExplanation(q.explanation);
    if (q.timer_seconds) setTimer(q.timer_seconds);
    if (q.difficulty) setDifficulty(q.difficulty);
    toast.success("Loaded question from bank");
  }

  function handleLaunchNextInSet() {
    if (filteredBankQuestions.length === 0) return;
    const nextQ = filteredBankQuestions[currentSetIndex % filteredBankQuestions.length];
    pickFromBank(nextQ);
    setCurrentSetIndex((prev) => (prev + 1) % filteredBankQuestions.length);
  }

  // true_false and exit_ticket present a fixed, non-editable option shelf.
  // The launch payload has to use it — the free-form `options` state is empty
  // for those two types, and shipping `[]` would fail the server's own
  // "at least two options" rule.
  const fixedOptions =
    type === "true_false"
      ? ["True", "False"]
      : type === "exit_ticket"
        ? ["Understood", "Need Practice", "Still Confused"]
        : null;
  const shownOptions = fixedOptions ?? options;

  function pickTemplate(t: (typeof QUICK_TEMPLATES)[number]) {
    setType(t.type);
    if (t.defaults?.options) setOptions([...t.defaults.options, "", ""]);
    if (t.defaults?.timer) setTimer(t.defaults.timer);
    if (t.defaults?.difficulty) setDifficulty(t.defaults.difficulty);
    if (t.type === "numerical") {
      setNumeric("");
      setTolerance("0");
    }
    setCorrectIdx(0);
  }

  async function launch() {
    if (prompt.trim().length < 2) return toast.error("Write the question first");
    const clean = shownOptions.map((o) => o.trim()).filter(Boolean);

    let correct: (string | number)[] = [correctIdx];
    if (type === "numerical") {
      const value = numeric.trim();
      if (!value || !Number.isFinite(Number(value))) {
        return toast.error("Enter a valid number");
      }
      correct = [value, tolerance || "0"];
    } else {
      if (clean.length < 2) return toast.error("Add at least two options");
      if (correctIdx >= clean.length) return toast.error("Pick which option is correct");
      correct = [correctIdx];
    }

    setBusy(true);
    const { error } = await launchActivity({
      roomId,
      prompt: prompt.trim(),
      type,
      options: type === "numerical" ? [] : clean,
      correct,
      timer,
      explanation: explanation.trim() || undefined,
      difficulty,
      topic: topic.trim() || undefined,
    });
    setBusy(false);

    if (error) return toast.error(error);
    toast.success("Question launched");
    setPrompt("");
    setExplanation("");
    onLaunched();
  }

  const showOptions = type !== "numerical";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="font-display text-lg font-extrabold">
            Launch a question
          </DialogTitle>
          <DialogDescription>
            Goes live on every connected phone the moment you press Launch.
          </DialogDescription>
        </DialogHeader>

        {bankQuestions.length > 0 && (
          <div className="grid gap-2 border-b border-border pb-4">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-bold text-[var(--primary)] uppercase tracking-wide">
                Pick from Question Bank
              </Label>
              {availableSets.length > 0 && (
                <div className="flex items-center gap-2">
                  <Select
                    value={selectedSetFilter}
                    onValueChange={(val) => {
                      setSelectedSetFilter(val ?? "all");
                      setCurrentSetIndex(0);
                    }}
                  >
                    <SelectTrigger className="h-7 w-[160px] text-xs">
                      <SelectValue placeholder="Filter by Set" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Sets / Questions</SelectItem>
                      {availableSets.map((s) => (
                        <SelectItem key={s} value={s}>
                          Set: {s}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {selectedSetFilter !== "all" && (
                    <Button size="xs" variant="secondary" onClick={handleLaunchNextInSet}>
                      Load Next in Set ⏭
                    </Button>
                  )}
                </div>
              )}
            </div>
            <Select onValueChange={(qId) => {
              const selected = bankQuestions.find(bq => bq.id === qId);
              if (selected) pickFromBank(selected);
            }}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select a saved question..." />
              </SelectTrigger>
              <SelectContent>
                {filteredBankQuestions.map((q) => (
                  <SelectItem key={q.id} value={q.id}>
                    <span className="truncate max-w-[320px] inline-block">
                      {q.set_name ? `[${q.set_name}] ` : ""}{q.prompt}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="grid gap-2">
          <Label>Quick Challenge</Label>
          <div className="flex flex-wrap gap-2">
            {QUICK_TEMPLATES.map((t) => (
              <button
                key={t.type}
                type="button"
                onClick={() => pickTemplate(t)}
                className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                  type === t.type
                    ? "border-[var(--ember)] bg-[var(--ember)]/12 text-[var(--primary)]"
                    : "border-border bg-card text-muted-foreground hover:text-foreground"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="c-prompt">Question</Label>
          <Textarea
            id="c-prompt"
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={
              type === "exit_ticket"
                ? "How well do you understand today's topic?"
                : type === "find_error"
                  ? "Which step of this solution contains the error?"
                  : "Write the question…"
            }
          />
        </div>

        {showOptions ? (
          <div className="grid gap-2">
            <Label>Options — click the button to mark the correct one</Label>
            <div className="grid gap-2">
              {shownOptions.map((opt, i) => {
                const isCorrect = correctIdx === i;
                return (
                  <div key={i} className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setCorrectIdx(i)}
                      aria-label={`Mark option ${i + 1} correct`}
                      className={`grid size-8 shrink-0 place-items-center rounded-lg border font-display text-xs font-extrabold transition-colors ${
                        isCorrect
                          ? "border-success bg-success text-white"
                          : "border-border bg-card text-muted-foreground hover:border-[var(--ember)]"
                      }`}
                    >
                      {OPTION_LETTERS[i]}
                    </button>
                    <Input
                      value={opt}
                      disabled={fixedOptions !== null}
                      onChange={(e) => {
                        const next = [...options];
                        next[i] = e.target.value;
                        setOptions(next);
                      }}
                      placeholder={`Option ${i + 1}`}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="c-num">Correct value</Label>
              <Input
                id="c-num"
                value={numeric}
                onChange={(e) => setNumeric(e.target.value)}
                placeholder="9.8"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="c-tol">Tolerance ±</Label>
              <Input
                id="c-tol"
                value={tolerance}
                onChange={(e) => setTolerance(e.target.value)}
                placeholder="0.1"
              />
            </div>
          </div>
        )}

        <div className="grid grid-cols-3 gap-3">
          <div className="grid gap-2 col-span-2">
            <Label>Timer Duration</Label>
            <div className="flex gap-2 items-center">
              <div className="flex-1">
                <span className="text-[10px] text-muted-foreground block">Hours</span>
                <Input
                  type="number"
                  min={0}
                  max={24}
                  value={Math.floor(timer / 3600)}
                  onChange={(e) => {
                    const hrs = Math.max(0, Number(e.target.value));
                    const mins = Math.floor((timer % 3600) / 60);
                    const secs = timer % 60;
                    setTimer(hrs * 3600 + mins * 60 + secs);
                  }}
                />
              </div>
              <div className="flex-1">
                <span className="text-[10px] text-muted-foreground block">Mins</span>
                <Input
                  type="number"
                  min={0}
                  max={59}
                  value={Math.floor((timer % 3600) / 60)}
                  onChange={(e) => {
                    const hrs = Math.floor(timer / 3600);
                    const mins = Math.max(0, Number(e.target.value));
                    const secs = timer % 60;
                    setTimer(hrs * 3600 + mins * 60 + secs);
                  }}
                />
              </div>
              <div className="flex-1">
                <span className="text-[10px] text-muted-foreground block">Secs</span>
                <Input
                  type="number"
                  min={0}
                  max={59}
                  value={timer % 60}
                  onChange={(e) => {
                    const hrs = Math.floor(timer / 3600);
                    const mins = Math.floor((timer % 3600) / 60);
                    const secs = Math.max(0, Number(e.target.value));
                    setTimer(hrs * 3600 + mins * 60 + secs);
                  }}
                />
              </div>
            </div>
          </div>
          <div className="grid gap-2">
            <Label>Difficulty</Label>
            <Select value={difficulty} onValueChange={(v) => setDifficulty(v as Difficulty)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DIFFICULTIES.map((d) => (
                  <SelectItem key={d} value={d}>
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="c-topic">Topic</Label>
            <Input
              id="c-topic"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="Optional"
            />
          </div>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="c-exp">Explanation (optional)</Label>
          <Input
            id="c-exp"
            value={explanation}
            onChange={(e) => setExplanation(e.target.value)}
            placeholder="Shown after you reveal the answer"
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="lg" onClick={() => void launch()} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            Launch now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------ summary ----- */

function SummaryDialog({
  open,
  onOpenChange,
  summary,
  running,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  summary: SessionSummary | null;
  running: boolean;
}) {
  const hardest = summary?.hardest;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-display text-xl font-extrabold">
            {running ? "Session so far" : "Session summary"}
          </DialogTitle>
          <DialogDescription>
            {running
              ? "Live numbers from this room. They finalise when the class ends."
              : "Everything that happened in this room, before the data expires."}
          </DialogDescription>
        </DialogHeader>

        {!summary ? (
          <div className="grid place-items-center rounded-2xl border border-dashed border-border py-14 text-center">
            <p className="font-display font-bold">No activity yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Launch a question and the numbers fill in.
            </p>
          </div>
        ) : (
          <div className="grid gap-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <SummaryStat label="Students" value={summary.students} />
              <SummaryStat label="Questions" value={summary.questions} />
              <SummaryStat
                label="Avg accuracy"
                value={`${summary.avg_accuracy}%`}
                tone="primary"
              />
              <SummaryStat
                label="Avg response"
                value={
                  summary.avg_response_ms > 0
                    ? `${(summary.avg_response_ms / 1000).toFixed(1)}s`
                    : "—"
                }
              />
            </div>

            {hardest && (
              <div className="rounded-2xl border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-4">
                <p className="text-xs font-bold tracking-widest text-muted-foreground uppercase">
                  Hardest question · {hardest.accuracy}% got it
                </p>
                <p className="font-display mt-1 text-lg font-bold break-words">
                  {hardest.prompt}
                </p>
                {Array.isArray(hardest.wrong_answer) && hardest.wrong_answer.length > 0 && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    Most-chosen wrong answer:{" "}
                    <span className="font-semibold text-foreground">
                      {formatAnswer(
                        hardest.wrong_answer as (string | number)[],
                        "mcq",
                      )}
                    </span>
                  </p>
                )}
              </div>
            )}

            <div>
              <p className="mb-2 text-xs font-bold tracking-widest text-muted-foreground uppercase">
                Top 3 Podium
              </p>
              <PodiumView leaderboard={summary.leaderboard} />
            </div>

            <div>
              <p className="mb-2 text-xs font-bold tracking-widest text-muted-foreground uppercase">
                Final leaderboard
              </p>
              <Leaderboard rows={summary.leaderboard} max={10} />
            </div>

            <p className="text-center text-xs text-muted-foreground">
              {summary.total_responses} answers scored on the server. Temporary room
              data expires — export anything you want to keep.
            </p>
          </div>
        )}
        <Button asChild className="w-full">
          <Link href="/dashboard">Back to dashboard</Link>
        </Button>
      </DialogContent>
    </Dialog>
  );
}

function SummaryStat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string | number;
  tone?: "default" | "primary";
}) {
  return (
    <div
      className={`rounded-xl px-3 py-3 text-center ${
        tone === "primary" ? "bg-[var(--ember)]/12" : "bg-muted"
      }`}
    >
      <p className="font-display text-2xl leading-none font-extrabold tabular-nums">
        {value}
      </p>
      <p className="mt-1.5 text-[10px] font-bold tracking-wider text-muted-foreground uppercase">
        {label}
      </p>
    </div>
  );
}

/* --------------------------------------------------------------- errors --- */

function ErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="grid place-items-center rounded-2xl border border-destructive/40 bg-destructive/5 px-6 py-16 text-center">
      <p className="font-display text-lg font-bold">Couldn&apos;t load the room</p>
      <p className="mt-1 font-mono text-sm text-muted-foreground">{message}</p>
      <Button className="mt-5" variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

function ResolveFailed({ code, message }: { code: string; message: string }) {
  return (
    <div className="grid min-h-dvh place-items-center bg-background px-5">
      <div className="w-full max-w-md text-center">
        <Logo />
        <div className="mt-6 rounded-2xl border border-border bg-card p-8">
          <p className="font-display text-xl font-extrabold">
            Room {code} isn&apos;t available
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            {message === "room_not_found"
              ? "It may have ended or expired. Ask your teacher to start a new one."
              : "Something went wrong resolving this room."}
          </p>
          <Button className="mt-6" asChild>
            <Link href="/dashboard">Back to dashboard</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
