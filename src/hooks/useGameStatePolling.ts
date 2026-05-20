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
  enabled?: boolean;
}

export function useGameStatePolling({
  launchedGameId,
  numberOfTeams,
  onGameEnded,
  onAllTeamsFinished,
  onNewBip,
  enabled = true,
}: UseGameStatePollingOptions) {
  const lastRawIdRef = useRef<number>(0);
  const gameEndedRef = useRef(false);
  const tickRunningRef = useRef(false);
  const onGameEndedRef = useRef(onGameEnded);
  const onAllTeamsFinishedRef = useRef(onAllTeamsFinished);
  const onNewBipRef = useRef(onNewBip);
  const launchedGameIdRef = useRef(launchedGameId);
  const numberOfTeamsRef = useRef(numberOfTeams);

  useEffect(() => { onGameEndedRef.current = onGameEnded; }, [onGameEnded]);
  useEffect(() => { onAllTeamsFinishedRef.current = onAllTeamsFinished; }, [onAllTeamsFinished]);
  useEffect(() => { onNewBipRef.current = onNewBip; }, [onNewBip]);
  useEffect(() => { launchedGameIdRef.current = launchedGameId; }, [launchedGameId]);
  useEffect(() => { numberOfTeamsRef.current = numberOfTeams; }, [numberOfTeams]);

  useEffect(() => {
    if (!launchedGameId || !enabled) return;

    gameEndedRef.current = false;
    lastRawIdRef.current = 0;
    tickRunningRef.current = false;

    // Initial state fetch primes the cursor so we don't replay every historical
    // punch as a "new bip" on first tick.
    const init = async () => {
      try {
        const state = await getLaunchedGameState(launchedGameId, 0);
        lastRawIdRef.current = state.last_raw_id;
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

        if (state.ended) {
          gameEndedRef.current = true;
          onGameEndedRef.current();
          return;
        }

        const teams = state.teams ?? [];
        if (teams.length >= numberOfTeamsRef.current && teams.every((t) => t.end_time !== null)) {
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
