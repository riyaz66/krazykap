"use client";

/**
 * Students are anonymous: their only credential is a per-room session token
 * issued by the `join_room` RPC. It lives in localStorage so a brief network
 * drop or phone lock does not throw the student out of the room (PRD §24).
 */

const PREFIX = "rop.session.";

export interface StoredSession {
  token: string;
  roomId: string;
  roomCode: string;
  nickname: string;
  joinedAt: number;
}

function key(roomCode: string) {
  return PREFIX + roomCode.toUpperCase();
}

export function saveSession(s: StoredSession): void {
  if (typeof window === "undefined") return;
  try {
    // Save to sessionStorage first so each browser tab gets its own unique student session
    window.sessionStorage.setItem(key(s.roomCode), JSON.stringify(s));
    window.localStorage.setItem(key(s.roomCode), JSON.stringify(s));
  } catch {
    /* storage disabled — reconnection simply won't persist */
  }
}

export function loadSession(roomCode: string): StoredSession | null {
  if (typeof window === "undefined") return null;
  try {
    const sessionRaw = window.sessionStorage.getItem(key(roomCode));
    if (sessionRaw) {
      const parsed = JSON.parse(sessionRaw) as StoredSession;
      if (parsed?.token) return parsed;
    }
    const localRaw = window.localStorage.getItem(key(roomCode));
    if (!localRaw) return null;
    const parsed = JSON.parse(localRaw) as StoredSession;
    if (!parsed?.token) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearSession(roomCode: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(key(roomCode));
    window.localStorage.removeItem(key(roomCode));
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ teacher */

const ROOM_KEY = "rop.teacher.room";

/** Remembers the last room so a dashboard refresh returns you to the control centre. */
export function saveLastRoom(roomId: string, code: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ROOM_KEY, JSON.stringify({ roomId, code }));
  } catch {
    /* ignore */
  }
}

export function loadLastRoom(): { roomId: string; code: string } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ROOM_KEY);
    return raw ? (JSON.parse(raw) as { roomId: string; code: string }) : null;
  } catch {
    return null;
  }
}
