// Pending team starts on the Mystery / Tracks game pages: the self-register
// name prompt and the first-bip videos, each keyed by team. A single slot used
// to hold one pending start: a second team's bip overwrote the first team's,
// which then never started, or got the other team's name and score.
//
// - Name prompts: the NEWEST bip is on screen - that team is at the reader.
//   Earlier prompts wait underneath and come back once it is answered; a team
//   bipping again brings its own prompt back on top (`raiseSelfReg`).
// - Videos: first come, first served - a team bipping during another team's
//   videos gets its own once those end.
//
// `claim` / `release` guard a team whose start is already in progress, so a
// repeat bip from it never opens a second prompt / video.

import { useCallback, useRef, useState } from 'react';
import type { VideoSource } from '../services/firstBipVideos';

export interface PendingSelfReg {
  teamId: number;
  cardId: number;
  finalize: (name: string, language: string) => Promise<void>;
  abort: () => Promise<void>;
}

export interface PendingVideoStart {
  teamId: number;
  videos: VideoSource[];
  finalize: () => Promise<void>;
}

export function usePendingStarts() {
  const claimedRef = useRef<Set<number>>(new Set());
  const selfRegQueueRef = useRef<PendingSelfReg[]>([]);
  const videoQueueRef = useRef<PendingVideoStart[]>([]);
  // The head of each queue - the one on screen.
  const [selfReg, setSelfReg] = useState<PendingSelfReg | null>(null);
  const [videoStart, setVideoStart] = useState<PendingVideoStart | null>(null);

  /** Claims the start sequence for a team. False when it is already in progress (repeat bip). */
  const claim = useCallback((teamId: number): boolean => {
    if (claimedRef.current.has(teamId)) return false;
    claimedRef.current.add(teamId);
    return true;
  }, []);

  /** Ends the claim once the start is persisted or cancelled. */
  const release = useCallback((teamId: number) => {
    claimedRef.current.delete(teamId);
  }, []);

  const enqueueSelfReg = useCallback((entry: PendingSelfReg) => {
    selfRegQueueRef.current = [entry, ...selfRegQueueRef.current.filter((e) => e.teamId !== entry.teamId)];
    setSelfReg(entry);
  }, []);

  /** A team with a pending prompt bipped again: show its prompt. False if it has none. */
  const raiseSelfReg = useCallback((teamId: number): boolean => {
    const entry = selfRegQueueRef.current.find((e) => e.teamId === teamId);
    if (!entry) return false;
    selfRegQueueRef.current = [entry, ...selfRegQueueRef.current.filter((e) => e !== entry)];
    setSelfReg(entry);
    return true;
  }, []);

  /** Removes a team's prompt (submitted or aborted); the next queued one shows. */
  const dropSelfReg = useCallback((teamId: number) => {
    selfRegQueueRef.current = selfRegQueueRef.current.filter((e) => e.teamId !== teamId);
    setSelfReg(selfRegQueueRef.current[0] ?? null);
  }, []);

  const enqueueVideoStart = useCallback((entry: PendingVideoStart) => {
    videoQueueRef.current = [...videoQueueRef.current.filter((e) => e.teamId !== entry.teamId), entry];
    setVideoStart(videoQueueRef.current[0]);
  }, []);

  /** The head's videos ended: start that team, show the next team's videos. */
  const completeVideoStart = useCallback(async () => {
    const [head, ...rest] = videoQueueRef.current;
    videoQueueRef.current = rest;
    setVideoStart(rest[0] ?? null);
    if (head) await head.finalize();
  }, []);

  return {
    selfReg,
    videoStart,
    claim,
    release,
    enqueueSelfReg,
    raiseSelfReg,
    dropSelfReg,
    enqueueVideoStart,
    completeVideoStart,
  };
}
