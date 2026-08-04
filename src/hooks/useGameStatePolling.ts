import { useEffect, useRef } from 'react';
import { getLaunchedGameState, RawPunchRow } from '../services/launchedGames';

// Polls a single combined `state` endpoint per second that returns ended +
// teams + new raw_data since the last cursor. Fires onGameEnded,
// onAllTeamsFinished, onNewBip as state changes.

interface UseGameStatePollingOptions {
  launchedGameId: number | null;
  numberOfTeams: number;
  onGameEnded: () => void;
  onAllTeamsFinished: () => void;
  onNewBip: (row: RawPunchRow & { launched_game_id: number }) => void;
  // Fires once when the mother flips the game to started (start_time set). Lets
  // a device sitting on the registration/inscription screen follow the device
  // that pressed "Start game" into play without the operator touching it.
  onGameStarted?: () => void;
  enabled?: boolean;
  // When true, suppress the all-teams-finished auto-end. Used by auto-register
  // / reuse-cards modes where teams are created dynamically, so a momentary
  // "all current teams finished" must not end the game. The game then ends
  // only via the server `ended` flag (manual End game).
  disableAllFinishedEnd?: boolean;
}

export function useGameStatePolling({
  launchedGameId,
  numberOfTeams,
  onGameEnded,
  onAllTeamsFinished,
  onNewBip,
  onGameStarted,
  enabled = true,
  disableAllFinishedEnd = false,
}: UseGameStatePollingOptions) {
  const lastRawIdRef = useRef<number>(0);
  const gameEndedRef = useRef(false);
  const gameStartedRef = useRef(false);
  const tickRunningRef = useRef(false);
  const onGameEndedRef = useRef(onGameEnded);
  const onAllTeamsFinishedRef = useRef(onAllTeamsFinished);
  const onNewBipRef = useRef(onNewBip);
  const onGameStartedRef = useRef(onGameStarted);
  const launchedGameIdRef = useRef(launchedGameId);
  const numberOfTeamsRef = useRef(numberOfTeams);
  const disableAllFinishedEndRef = useRef(disableAllFinishedEnd);

  useEffect(() => { onGameEndedRef.current = onGameEnded; }, [onGameEnded]);
  useEffect(() => { onAllTeamsFinishedRef.current = onAllTeamsFinished; }, [onAllTeamsFinished]);
  useEffect(() => { onNewBipRef.current = onNewBip; }, [onNewBip]);
  useEffect(() => { onGameStartedRef.current = onGameStarted; }, [onGameStarted]);
  useEffect(() => { launchedGameIdRef.current = launchedGameId; }, [launchedGameId]);
  useEffect(() => { numberOfTeamsRef.current = numberOfTeams; }, [numberOfTeams]);
  useEffect(() => { disableAllFinishedEndRef.current = disableAllFinishedEnd; }, [disableAllFinishedEnd]);

  useEffect(() => {
    if (!launchedGameId || !enabled) return;

    gameEndedRef.current = false;
    gameStartedRef.current = false;
    lastRawIdRef.current = 0;
    tickRunningRef.current = false;

    // Fire onGameStarted exactly once, the first tick that sees the mother's
    // start flag flip. Idempotent for consumers whose "start" handler just sets
    // an already-current phase (e.g. a device that pressed Start itself).
    const signalStartedIfNeeded = (state: { started?: boolean; start_time?: string | null }) => {
      if (gameStartedRef.current) return;
      if (state.started || state.start_time) {
        gameStartedRef.current = true;
        onGameStartedRef.current?.();
      }
    };

    // Initial state fetch primes the cursor so we don't replay every historical
    // punch as a "new bip" on first tick.
    const init = async () => {
      try {
        const state = await getLaunchedGameState(launchedGameId, 0);
        lastRawIdRef.current = state.last_raw_id;
        signalStartedIfNeeded(state);
        if (state.ended) {
          gameEndedRef.current = true;
          onGameEndedRef.current();
        }
      } catch (err) {
        console.error('[useGameStatePolling] init failed:', err);
      }
    };

    const tick = async () => {
      if (tickRunningRef.current) return;
      const gid = launchedGameIdRef.current;
      if (!gid || gameEndedRef.current) return;

      tickRunningRef.current = true;
      try {
        const state = await getLaunchedGameState(gid, lastRawIdRef.current);

        signalStartedIfNeeded(state);

        if (state.ended) {
          gameEndedRef.current = true;
          onGameEndedRef.current();
          return;
        }

        const teams = state.teams ?? [];
        if (
          !disableAllFinishedEndRef.current &&
          teams.length >= numberOfTeamsRef.current &&
          teams.every((t) => t.end_time !== null)
        ) {
          gameEndedRef.current = true;
          onAllTeamsFinishedRef.current();
          return;
        }

        const newRows = state.new_raw_data ?? [];
        if (newRows.length > 0) {
          lastRawIdRef.current = state.last_raw_id;
          for (const row of newRows) {
            onNewBipRef.current({ ...row, launched_game_id: gid });
          }
        }
      } catch (err) {
        // Swallow per-tick errors so the interval keeps running. The next
        // poll will retry. 401/403 propagate via api.ts → AuthProvider.
        console.error('[useGameStatePolling] tick failed:', err);
      } finally {
        tickRunningRef.current = false;
      }
    };

    let interval: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    init().then(() => {
      if (cancelled) return;
      interval = setInterval(tick, 1000);
    });

    return () => {
      cancelled = true;
      if (interval !== null) clearInterval(interval);
    };
  }, [launchedGameId, enabled]);
}
