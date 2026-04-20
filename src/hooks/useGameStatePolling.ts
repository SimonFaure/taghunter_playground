import { useEffect, useRef, useCallback } from 'react';
import { supabase } from '../lib/db';

interface RawDataRow {
  id: number;
  launched_game_id: number;
  device_id: string;
  raw_data: any;
  created_at: string;
}

interface UseGameStatePollingOptions {
  launchedGameId: number | null;
  numberOfTeams: number;
  onGameEnded: () => void;
  onAllTeamsFinished: () => void;
  onNewBip: (row: RawDataRow) => void;
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
  const lastRawDataIdRef = useRef<number | null>(null);
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
    lastRawDataIdRef.current = null;
    tickRunningRef.current = false;

    const init = async () => {
      const { data } = await supabase
        .from('launched_game_raw_data')
        .select('id')
        .eq('launched_game_id', launchedGameId)
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();
      lastRawDataIdRef.current = data?.id ?? 0;
    };

    const tick = async () => {
      if (tickRunningRef.current) return;
      const gid = launchedGameIdRef.current;
      if (!gid || gameEndedRef.current || lastRawDataIdRef.current === null) return;

      tickRunningRef.current = true;
      try {
        const { data: gameRow } = await supabase
          .from('launched_games')
          .select('ended')
          .eq('id', gid)
          .maybeSingle();

        if (gameRow?.ended) {
          gameEndedRef.current = true;
          onGameEndedRef.current();
          return;
        }

        const { data: teams } = await supabase
          .from('teams')
          .select('id, end_time')
          .eq('launched_game_id', gid);

        if (teams && teams.length >= numberOfTeamsRef.current && teams.every(t => t.end_time !== null)) {
          gameEndedRef.current = true;
          onAllTeamsFinishedRef.current();
          return;
        }

        const { data: newRows } = await supabase
          .from('launched_game_raw_data')
          .select('*')
          .eq('launched_game_id', gid)
          .gt('id', lastRawDataIdRef.current)
          .order('id', { ascending: true });

        if (newRows && newRows.length > 0) {
          lastRawDataIdRef.current = newRows[newRows.length - 1].id;
          for (const row of newRows) {
            onNewBipRef.current(row as RawDataRow);
          }
        }
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
