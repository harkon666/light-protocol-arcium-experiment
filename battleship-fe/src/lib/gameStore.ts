import { create } from 'zustand';

// Cell states matching the Solana program
export const CELL_EMPTY = 0;
export const CELL_SHIP = 1;
export const CELL_HIT = 2;
export const CELL_MISS = 3;

// Game status
export const GAME_STATUS = {
  WAITING: 0,
  ACTIVE: 1,
  FINISHED: 2,
} as const;

export interface GameState {
  // Game info
  gameId: string | null;
  playerRole: 'A' | 'B' | null;
  gameStatus: number;
  currentTurn: number; // 1 = A's turn, 2 = B's turn
  winner: 'A' | 'B' | null;

  // Player A data
  playerA: string | null;
  gridA: number[];
  boardHashA: string | null;

  // Player B data  
  playerB: string | null;
  gridB: number[];
  boardHashB: string | null;

  // Ship placement (for current player)
  shipX: number;
  shipY: number;
  orientation: 'horizontal' | 'vertical';
  salt: bigint | null;
  isShipPlaced: boolean;

  // Actions
  setGameId: (id: string) => void;
  setPlayerRole: (role: 'A' | 'B') => void;
  setShipPosition: (x: number, y: number) => void;
  setOrientation: (o: 'horizontal' | 'vertical') => void;
  setSalt: (salt: bigint) => void;
  placeShip: () => void;
  createGame: (hash: string, pubkey: string) => void;
  joinGame: (hash: string, pubkey: string) => void;
  attack: (x: number, y: number, isHit: boolean) => void;
  reset: () => void;
}

// Helper to generate grid with ship
function generateGrid(shipX: number, shipY: number, isHorizontal: boolean): number[] {
  const grid = new Array(25).fill(CELL_EMPTY);
  const shipLength = 4;

  for (let i = 0; i < shipLength; i++) {
    const x = isHorizontal ? shipX + i : shipX;
    const y = isHorizontal ? shipY : shipY + i;
    if (x < 5 && y < 5) {
      grid[y * 5 + x] = CELL_SHIP;
    }
  }

  return grid;
}

export const useGameStore = create<GameState>((set, get) => ({
  // Initial state
  gameId: null,
  playerRole: null,
  gameStatus: GAME_STATUS.WAITING,
  currentTurn: 1,
  winner: null,

  playerA: null,
  gridA: new Array(25).fill(CELL_EMPTY),
  boardHashA: null,

  playerB: null,
  gridB: new Array(25).fill(CELL_EMPTY),
  boardHashB: null,

  shipX: 0,
  shipY: 0,
  orientation: 'horizontal',
  salt: null,
  isShipPlaced: false,

  // Actions
  setGameId: (id) => set({ gameId: id }),
  setPlayerRole: (role) => set({ playerRole: role }),
  setShipPosition: (x, y) => set({ shipX: x, shipY: y }),
  setOrientation: (o) => set({ orientation: o }),
  setSalt: (salt) => set({ salt }),

  placeShip: () => {
    set({ isShipPlaced: true });
  },

  createGame: (hash, pubkey) => {
    const { shipX, shipY, orientation } = get();
    const grid = generateGrid(shipX, shipY, orientation === 'horizontal');

    set({
      gameId: Date.now().toString(),
      playerRole: 'A',
      playerA: pubkey,
      gridA: grid,
      boardHashA: hash,
      gameStatus: GAME_STATUS.WAITING,
      currentTurn: 1,
      isShipPlaced: true,
    });
  },

  joinGame: (hash, pubkey) => {
    const { shipX, shipY, orientation } = get();
    const grid = generateGrid(shipX, shipY, orientation === 'horizontal');

    set({
      playerRole: 'B',
      playerB: pubkey,
      gridB: grid,
      boardHashB: hash,
      gameStatus: GAME_STATUS.ACTIVE,
      isShipPlaced: true,
    });
  },

  attack: (x, y, isHit) => {
    const { currentTurn, gridA, gridB } = get();
    const targetGrid = currentTurn === 1 ? [...gridB] : [...gridA];
    const idx = y * 5 + x;

    targetGrid[idx] = isHit ? CELL_HIT : CELL_MISS;

    // Check for win (all 4 ship cells hit)
    const hitCount = targetGrid.filter(c => c === CELL_HIT).length;
    const isWin = hitCount >= 4;

    set({
      ...(currentTurn === 1 ? { gridB: targetGrid } : { gridA: targetGrid }),
      currentTurn: currentTurn === 1 ? 2 : 1,
      ...(isWin ? {
        gameStatus: GAME_STATUS.FINISHED,
        winner: currentTurn === 1 ? 'A' : 'B'
      } : {}),
    });
  },

  reset: () => set({
    gameId: null,
    playerRole: null,
    gameStatus: GAME_STATUS.WAITING,
    currentTurn: 1,
    winner: null,
    playerA: null,
    gridA: new Array(25).fill(CELL_EMPTY),
    boardHashA: null,
    playerB: null,
    gridB: new Array(25).fill(CELL_EMPTY),
    boardHashB: null,
    shipX: 0,
    shipY: 0,
    orientation: 'horizontal',
    salt: null,
    isShipPlaced: false,
  }),
}));
