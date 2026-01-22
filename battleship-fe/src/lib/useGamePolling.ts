import { useState, useEffect, useCallback } from 'react';
import { getGameByGameId } from './multiplayer';

interface GameState {
  gameId: any;
  playerA: any;
  playerB: any;
  currentTurn: number;
  gameStatus: number;
  gridA: number[];
  boardHashA: number[];
  hitsA: number;
  gridB: number[];
  boardHashB: number[];
  hitsB: number;
}

interface UseGamePollingResult {
  gameState: GameState | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

/**
 * Hook to poll game state periodically
 * @param gameId - The game ID to poll
 * @param enabled - Whether polling is enabled
 * @param interval - Polling interval in ms (default 3000)
 */
export function useGamePolling(
  gameId: string | null,
  enabled: boolean = true,
  interval: number = 3000
): UseGamePollingResult {
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchGameState = useCallback(async () => {
    if (!gameId) return;

    try {
      setIsLoading(true);
      setError(null);

      const result = await getGameByGameId(gameId);

      if (result) {
        setGameState(result.state);
      }
    } catch (err) {
      console.error('Failed to fetch game state:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch game');
    } finally {
      setIsLoading(false);
    }
  }, [gameId]);

  // Initial fetch
  useEffect(() => {
    if (enabled && gameId) {
      fetchGameState();
    }
  }, [enabled, gameId, fetchGameState]);

  // Polling
  useEffect(() => {
    if (!enabled || !gameId) return;

    const pollInterval = setInterval(() => {
      fetchGameState();
    }, interval);

    return () => clearInterval(pollInterval);
  }, [enabled, gameId, interval, fetchGameState]);

  return {
    gameState,
    isLoading,
    error,
    refetch: fetchGameState,
  };
}

// Game status constants
export const ONLINE_GAME_STATUS = {
  WAITING: 0,
  ACTIVE: 1,
  FINISHED: 2,
} as const;
