import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { ShipPlacer } from '../components/ShipPlacer'
import { GameBoard } from '../components/GameBoard'
import { useGameStore, GAME_STATUS, CELL_EMPTY, CELL_SHIP } from '../lib/gameStore'
import { generateBoardHash, generateRandomSalt } from '../lib/noir'
import { createOnlineGameTx, joinOnlineGameTx, attackTx, getConnection } from '../lib/multiplayer'
import { useGamePolling, ONLINE_GAME_STATUS } from '../lib/useGamePolling'
import { WalletButton } from '../components/WalletButton'

export const Route = createFileRoute('/game')({
  component: GamePage,
})

function GamePage() {
  const store = useGameStore();
  const wallet = useWallet();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [aiThinking, setAiThinking] = useState(false);
  const [lastAiMove, setLastAiMove] = useState<{ x: number, y: number, hit: boolean } | null>(null);
  const [gameMode, setGameMode] = useState<'ai' | 'online'>('ai');
  const [joinGameId, setJoinGameId] = useState('');

  // Poll game state whenever we are in an online game with an ID
  const isOnlineGame = gameMode === 'online' && store.gameId !== null;

  const { gameState: onlineGameState } = useGamePolling(
    store.gameId,
    isOnlineGame,
    3000 // Poll every 3 seconds
  );

  // Sync online state to local store
  useEffect(() => {
    if (!onlineGameState) return;

    console.log("Polling Update:", {
      status: onlineGameState.gameStatus,
      turn: onlineGameState.currentTurn,
      playerB: onlineGameState.playerB?.toBase58()
    });

    // 1. Update Game Status
    let newStatus = onlineGameState.gameStatus === ONLINE_GAME_STATUS.WAITING ? GAME_STATUS.WAITING :
      onlineGameState.gameStatus === ONLINE_GAME_STATUS.ACTIVE ? GAME_STATUS.ACTIVE : GAME_STATUS.FINISHED;

    // Determine winner based on gameStatus (2=A Won, 3=B Won)
    let newWinner: 'A' | 'B' | null = null;
    if (onlineGameState.gameStatus === 2) newWinner = 'A';
    if (onlineGameState.gameStatus === 3) newWinner = 'B';

    // PREVENT REVERSION: If local is ACTIVE, ignore WAITING from polling (indexer lag)
    if (store.gameStatus === GAME_STATUS.ACTIVE && newStatus === GAME_STATUS.WAITING) {
      console.log("Ignoring stale WAITING status from polling (local is ACTIVE)");
      newStatus = GAME_STATUS.ACTIVE;
    }

    // 2. Update Turn (Contract: 1=PlayerA, 2=PlayerB -> Store: Same)
    // Contract uses 1-based indexing for turns as well
    const newTurn = onlineGameState.currentTurn;

    // 3. Update Grids & Hashes
    let newGridA = store.gridA;
    let newGridB = store.gridB;

    // Helper to convert byte array to hex string
    const toHex = (arr: number[]) => arr ? Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('') : null;

    const newBoardHashA = toHex(onlineGameState.boardHashA);
    const newBoardHashB = toHex(onlineGameState.boardHashB);

    if (store.playerRole === 'A') {
      newGridA = onlineGameState.gridA; // My board
      newGridB = onlineGameState.gridB; // Opponent board
    } else if (store.playerRole === 'B') {
      newGridA = onlineGameState.gridB; // My board (Player B content)
      newGridB = onlineGameState.gridA; // Opponent board (Player A content)
    }

    // Only update if something changed (or if it's the first sync/active transition or HASH is missing)
    if (store.gameStatus !== newStatus || store.currentTurn !== newTurn || !store.boardHashB || store.winner !== newWinner) {
      console.log("Syncing online state (status/turn/hash/winner changed)...");
      useGameStore.setState({
        gameStatus: newStatus,
        currentTurn: newTurn,
        gridA: newGridA,
        gridB: newGridB,
        playerB: onlineGameState.playerB ? onlineGameState.playerB.toBase58() : store.playerB,
        boardHashA: newBoardHashA,
        boardHashB: newBoardHashB,
        winner: newWinner,
      });
    } else {
      // Just sync grids
      // We'll compare JSON stringified to avoid loop, or just set it (zustand shallow compares?)
      // To be safe, just set it, React will handle diff.
      // Actually, preventing loop is good.
      const gridsChanged = JSON.stringify(newGridA) !== JSON.stringify(store.gridA) ||
        JSON.stringify(newGridB) !== JSON.stringify(store.gridB);

      if (gridsChanged) {
        useGameStore.setState({
          gridA: newGridA,
          gridB: newGridB,
          boardHashA: newBoardHashA,
          boardHashB: newBoardHashB,
          winner: newWinner,
        });
      }
    }
  }, [onlineGameState, store.playerRole, store.gameStatus, store.currentTurn, store.winner]);


  // AI opponent logic
  useEffect(() => {
    if (gameMode !== 'ai') return;

    // Only run when it's AI's turn (player B) and game is active
    if (store.gameStatus !== GAME_STATUS.ACTIVE) return;
    if (store.playerRole !== 'A') return; // Only when human is player A
    if (store.currentTurn !== 2) return; // Turn 2 = Player B (AI)

    setAiThinking(true);

    // AI makes a move after a delay
    const timeout = setTimeout(() => {
      // Find available cells to attack on player A's grid
      const availableCells: number[] = [];
      store.gridA.forEach((cell, idx) => {
        if (cell === CELL_EMPTY || cell === CELL_SHIP) {
          // Only attack cells that haven't been hit/missed
          const currentState = store.gridA[idx];
          if (currentState === CELL_EMPTY || currentState === CELL_SHIP) {
            availableCells.push(idx);
          }
        }
      });

      // Filter out already attacked cells (hit or miss = 2 or 3)
      const attackableCells = availableCells.filter(idx =>
        store.gridA[idx] === CELL_EMPTY || store.gridA[idx] === CELL_SHIP
      );

      if (attackableCells.length > 0) {
        // Pick a random cell
        const randomIdx = attackableCells[Math.floor(Math.random() * attackableCells.length)];
        const x = randomIdx % 5;
        const y = Math.floor(randomIdx / 5);

        // Check if it's a hit
        const isHit = store.gridA[randomIdx] === CELL_SHIP;

        // Record AI's move for display
        setLastAiMove({ x, y, hit: isHit });

        // Execute attack (AI attacks player A's grid)
        // We need to call attack but for AI attacking A, the logic is reversed
        // Current attack logic: currentTurn 1 attacks B, currentTurn 2 attacks A
        store.attack(x, y, isHit);
      }

      setAiThinking(false);
    }, 1000 + Math.random() * 1000); // 1-2 second delay

    return () => clearTimeout(timeout);
  }, [store.currentTurn, store.gameStatus, store.playerRole, store.gridA, gameMode]);

  const handleCreateGame = async () => {
    setLoading(true);
    setError('');
    setLastAiMove(null);

    try {
      // Generate random salt
      const salt = generateRandomSalt();
      store.setSalt(salt);

      // Generate ZK hash
      const hash = await generateBoardHash(
        store.shipX,
        store.shipY,
        store.orientation === 'horizontal' ? 0 : 1,
        salt
      );

      // Handle based on mode
      if (gameMode === 'ai') {
        store.createGame(hash, 'You');
      } else {
        // Online Mode
        if (!wallet.publicKey || !wallet.signTransaction) {
          throw new Error("Please connect your wallet first!");
        }

        const gameId = Date.now().toString(); // Use timestamp as simple game ID
        const connection = getConnection();

        console.log("Creating online game transaction...");
        const tx = await createOnlineGameTx({
          connection,
          wallet: wallet as any, // casting for simplicity
          gameId,
          shipX: store.shipX,
          shipY: store.shipY,
          orientation: store.orientation === 'horizontal' ? 0 : 1,
          boardHash: hash
        });

        console.log("Sending transaction...");
        const signature = await wallet.sendTransaction(tx, connection);
        console.log("Tx Signature:", signature);

        await connection.confirmTransaction(signature, 'confirmed');
        console.log("Transaction confirmed!");

        store.createGame(hash, wallet.publicKey.toString());
        store.setGameId(gameId);
      }

    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'Failed to create game');
    } finally {
      setLoading(false);
    }
  };

  const handleStartVsAI = () => {
    // Immediately start game against AI
    // AI places ship randomly
    const aiShipX = Math.floor(Math.random() * 2); // 0 or 1 for horizontal
    const aiShipY = Math.floor(Math.random() * 5);
    const aiGrid = new Array(25).fill(CELL_EMPTY);

    // Place AI ship horizontally
    for (let i = 0; i < 4; i++) {
      aiGrid[(aiShipY * 5) + aiShipX + i] = CELL_SHIP;
    }

    useGameStore.setState({
      playerB: '🤖 AI Bot',
      gridB: aiGrid,
      boardHashB: 'ai_hidden_hash_' + Math.random().toString(36).substring(7),
      gameStatus: GAME_STATUS.ACTIVE,
    });
  };

  const handleAttack = async (x: number, y: number) => {
    // 1. AI Logic
    if (gameMode === 'ai') {
      if (aiThinking) return; // Prevent attack while AI is thinking

      // Determine if hit by checking opponent's grid
      const targetGrid = store.gridB; // Player A always attacks B
      const idx = y * 5 + x;
      const isHit = targetGrid[idx] === CELL_SHIP;

      store.attack(x, y, isHit);
      setLastAiMove(null);
      return;
    }

    // 2. Online Logic
    if (gameMode === 'online') {
      // Basic checks
      if (store.gameStatus !== GAME_STATUS.ACTIVE) return;
      if (!store.gameId) return;

      // Verify turn locally (optional, blockchain checks too)
      const myTurn = (store.playerRole === 'A' && store.currentTurn === 1) ||
        (store.playerRole === 'B' && store.currentTurn === 2);

      if (!myTurn) {
        console.log("Not your turn!");
        return;
      }

      try {
        setLoading(true);
        setError('');
        const connection = getConnection();
        console.log(`Attacking (${x}, ${y}) in game ${store.gameId}...`);

        const tx = await attackTx({
          connection,
          wallet: wallet as any,
          gameId: store.gameId,
          x,
          y
        });

        // Simulate transaction first to get detailed error
        console.log("Simulating attack transaction...");
        try {
          const simulation = await connection.simulateTransaction(tx);
          console.log("Simulation result:", simulation);
          if (simulation.value.err) {
            console.error("Simulation error:", simulation.value.err);
            console.error("Simulation logs:", simulation.value.logs);
            throw new Error(`Attack simulation failed: ${JSON.stringify(simulation.value.err)}\n\nLogs:\n${simulation.value.logs?.join('\n')}`);
          }
        } catch (simErr) {
          console.error("Simulation exception:", simErr);
          throw simErr;
        }

        const signature = await wallet.sendTransaction(tx, connection);
        console.log("Attack Tx:", signature);

        await connection.confirmTransaction(signature, 'confirmed');
        console.log("Attack confirmed!");

        // We rely on polling to update the board state
      } catch (e: any) {
        console.error("Attack failed:", e);
        setError("Attack failed: " + (e.message || e.toString()));
      } finally {
        setLoading(false);
      }
    }
  };

  const handleJoinGame = async () => {
    if (!joinGameId.trim()) {
      setError('Please enter a Game ID to join');
      return;
    }

    setLoading(true);
    setError('');

    try {
      if (!wallet.publicKey || !wallet.signTransaction) {
        throw new Error("Please connect your wallet first!");
      }

      // Generate random salt
      const salt = generateRandomSalt();
      store.setSalt(salt);

      // Generate ZK hash for player B's board
      const hash = await generateBoardHash(
        store.shipX,
        store.shipY,
        store.orientation === 'horizontal' ? 0 : 1,
        salt
      );

      const connection = getConnection();

      console.log("Joining game:", joinGameId);
      const tx = await joinOnlineGameTx({
        connection,
        wallet: wallet as any,
        gameId: joinGameId,
        shipX: store.shipX,
        shipY: store.shipY,
        orientation: store.orientation === 'horizontal' ? 0 : 1,
        boardHash: hash
      });

      // Simulate transaction first to get detailed error
      console.log("Simulating join transaction...");
      try {
        const simulation = await connection.simulateTransaction(tx);
        console.log("Simulation result:", simulation);
        if (simulation.value.err) {
          console.error("Simulation error:", simulation.value.err);
          console.error("Simulation logs:", simulation.value.logs);
          throw new Error(`Transaction simulation failed: ${JSON.stringify(simulation.value.err)}\n\nLogs:\n${simulation.value.logs?.join('\n')}`);
        }
      } catch (simErr) {
        console.error("Simulation exception:", simErr);
        throw simErr;
      }

      console.log("Sending join transaction...");
      const signature = await wallet.sendTransaction(tx, connection);
      console.log("Tx Signature:", signature);

      await connection.confirmTransaction(signature, 'confirmed');
      console.log("Join transaction confirmed!");

      // Set up local state/board for player B using the proper action
      console.log("Initializing Player B state...");
      store.joinGame(hash, wallet.publicKey.toString());
      store.setGameId(joinGameId);

      // Ensure specific fields are set if joinGame didn't cover them (redundancy check)
      useGameStore.setState({
        currentTurn: 1 // Player A goes first
      });

    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'Failed to join game');
    } finally {
      setLoading(false);
    }
  };

  // Custom Loading Screen
  if (loading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="text-center">
          <div className="text-6xl animate-bounce mb-4">🚢</div>
          <h2 className="text-2xl font-bold text-white mb-2">Deploying Fleet...</h2>
          <p className="text-blue-400">Generating Zero-Knowledge Proof & Creating Game</p>
          <div className="mt-4 w-64 h-2 bg-slate-700 rounded-full mx-auto overflow-hidden">
            <div className="h-full bg-blue-500 animate-pulse w-full"></div>
          </div>
        </div>
      </div>
    );
  }

  // Game Mode Selection (before placement)
  if (!store.gameId && !store.isShipPlaced && !loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900 p-8">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-6">
            <h1 className="text-4xl font-bold text-white mb-4">🎮 Battleship Game</h1>
            <p className="text-blue-300">Choose your game mode</p>
          </div>

          <div className="flex justify-center gap-4 mb-8">
            <button
              onClick={() => setGameMode('ai')}
              className={`px-6 py-3 rounded-xl font-bold transition flex items-center gap-2 ${gameMode === 'ai' ? 'bg-purple-600 text-white shadow-lg shadow-purple-500/30' : 'bg-slate-700 text-gray-400 hover:bg-slate-600'}`}
            >
              🤖 Play vs AI
            </button>
            <button
              onClick={() => setGameMode('online')}
              className={`px-6 py-3 rounded-xl font-bold transition flex items-center gap-2 ${gameMode === 'online' ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/30' : 'bg-slate-700 text-gray-400 hover:bg-slate-600'}`}
            >
              👥 Play Online
            </button>
          </div>

          <div className="max-w-md mx-auto">
            {/* Create Game */}
            <div className={`backdrop-blur-sm rounded-2xl p-6 border transition-colors ${gameMode === 'ai' ? 'bg-slate-800/50 border-purple-500/30' : 'bg-slate-800/50 border-blue-500/30'}`}>
              <h2 className="text-xl font-semibold text-white mb-6 flex items-center gap-2">
                <span className="text-2xl">{gameMode === 'ai' ? '🤖' : '🌐'}</span>
                {gameMode === 'ai' ? 'Setup AI Battle' : 'Create Online Game'}
              </h2>

              {gameMode === 'online' && !wallet.connected && (
                <div className="mb-6 p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-xl text-yellow-200 text-sm text-center">
                  ⚠️ Connect Phantom/Solflare wallet to play online
                  <div className="mt-2 flex justify-center">
                    <WalletButton />
                  </div>
                </div>
              )}

              <ShipPlacer onConfirm={handleCreateGame} />

              {/* Join Existing Game - Online mode only */}
              {gameMode === 'online' && wallet.connected && (
                <div className="mt-6 pt-6 border-t border-slate-600">
                  <h3 className="text-lg font-semibold text-white mb-3 flex items-center gap-2">
                    <span>🔗</span> Or Join Existing Game
                  </h3>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={joinGameId}
                      onChange={(e) => setJoinGameId(e.target.value)}
                      placeholder="Enter Game ID..."
                      className="flex-1 px-4 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:border-blue-500"
                    />
                    <button
                      onClick={handleJoinGame}
                      disabled={!joinGameId.trim()}
                      className="px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded-lg font-semibold transition"
                    >
                      Join
                    </button>
                  </div>
                  <p className="text-xs text-gray-500 mt-2">
                    Get the Game ID from Player A to join their game
                  </p>
                </div>
              )}

              {/* Show error */}
              {error && (
                <div className="mt-4 p-3 bg-red-500/20 text-red-200 rounded-lg text-sm text-center">
                  {error}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Game created, waiting for player B - auto start vs AI
  if (store.gameStatus === GAME_STATUS.WAITING && store.playerRole === 'A') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900 p-8">
        <div className="max-w-2xl mx-auto text-center">
          <h1 className="text-3xl font-bold text-white mb-6">🚢 Ship Placed!</h1>

          <div className="bg-slate-800/50 backdrop-blur-sm rounded-2xl p-8 border border-blue-500/30">
            <div className="text-left space-y-2 text-gray-400 mb-6">
              <p>✅ Your ship is placed at ({store.shipX}, {store.shipY}) - {store.orientation}</p>
              <p>🔐 Board Hash: <span className="font-mono text-xs text-purple-400">{store.boardHashA?.substring(0, 16)}...</span></p>
              {gameMode === 'online' && (
                <div className="mt-4 p-4 bg-slate-900 rounded-xl border border-blue-500/20 text-center">
                  <p className="text-sm text-gray-400 mb-2">Waiting for opponent to join...</p>
                  <p className="text-xs text-slate-500">Game ID: {store.gameId}</p>
                  <div className="flex justify-center gap-1 mt-2">
                    <span className="w-2 h-2 bg-blue-500 rounded-full animate-bounce"></span>
                    <span className="w-2 h-2 bg-blue-500 rounded-full animate-bounce delay-100"></span>
                    <span className="w-2 h-2 bg-blue-500 rounded-full animate-bounce delay-200"></span>
                  </div>
                </div>
              )}
            </div>

            {/* Preview own board */}
            <div className="mb-6">
              <h3 className="text-white mb-2">Your Board:</h3>
              <div className="flex justify-center">
                <GameBoard
                  grid={store.gridA}
                  isOwner={true}
                  isAttackMode={false}
                />
              </div>
            </div>

            {/* Start vs AI - Only show if in AI mode */}
            {gameMode === 'ai' && (
              <button
                onClick={handleStartVsAI}
                className="w-full bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700 text-white py-4 rounded-xl font-semibold text-lg transition"
              >
                🤖 Start Battle vs AI
              </button>
            )}
          </div>

          <button
            onClick={() => store.reset()}
            className="mt-4 text-gray-400 hover:text-white"
          >
            ← Cancel Game
          </button>
        </div>
      </div>
    );
  }

  // Active game - show both boards
  if (store.gameStatus === GAME_STATUS.ACTIVE) {
    // Determine if it's my turn based on Role and CurrentTurn
    // Turn 1 = Player A, Turn 2 = Player B
    const isMyTurn = (store.playerRole === 'A' && store.currentTurn === 1) ||
      (store.playerRole === 'B' && store.currentTurn === 2);

    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900 p-8">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-6">
            <h1 className="text-3xl font-bold text-white mb-2">⚔️ Battle In Progress</h1>
            <div className="flex justify-center mb-2">
              <span className={`px-3 py-1 rounded-full text-xs font-bold ${gameMode === 'online' ? 'bg-blue-500/20 text-blue-300' : 'bg-purple-500/20 text-purple-300'}`}>
                {gameMode === 'online' ? '👥 ONLINE MATCH' : '🤖 VS AI'}
              </span>
            </div>
            <p className={`text-xl ${isMyTurn ? 'text-green-400' : 'text-yellow-400'}`}>
              {aiThinking ? "🤖 AI is thinking..." : (isMyTurn ? "🎯 Your Turn - Click enemy board to attack!" : "⏳ Waiting for opponent...")}
            </p>

            {/* Last AI move notification */}
            {lastAiMove && (
              <div className={`mt-2 text-lg ${lastAiMove.hit ? 'text-red-400' : 'text-blue-400'}`}>
                🤖 AI attacked ({lastAiMove.x}, {lastAiMove.y}) - {lastAiMove.hit ? '💥 HIT!' : '🌊 Miss'}
              </div>
            )}
          </div>

          <div className="grid md:grid-cols-2 gap-8">
            {/* My Board */}
            <div className="bg-slate-800/50 backdrop-blur-sm rounded-2xl p-6 border border-blue-500/30">
              <h2 className="text-xl font-semibold text-white mb-4 text-center">
                🚢 Your Board
              </h2>
              <div className="flex justify-center">
                <GameBoard
                  grid={store.gridA}
                  isOwner={true}
                  isAttackMode={false}
                />
              </div>
            </div>

            {/* Enemy Board */}
            <div className="bg-slate-800/50 backdrop-blur-sm rounded-2xl p-6 border border-red-500/30">
              <h2 className="text-xl font-semibold text-white mb-4 text-center">
                🎯 Enemy Board (Hidden)
              </h2>
              <div className="flex justify-center">
                <GameBoard
                  grid={store.gridB}
                  isOwner={false}
                  isAttackMode={isMyTurn && !aiThinking}
                  onCellClick={handleAttack}
                />
              </div>
            </div>
          </div>

          {/* Game Info */}
          <div className="mt-6 text-center text-gray-400">
            <p>Game ID: <span className="font-mono text-blue-400">{store.gameId}</span></p>
            <p className="text-sm mt-1">Enemy Hash: <span className="font-mono text-purple-400">
              {(store.playerRole === 'A' ? store.boardHashB : store.boardHashA)?.substring(0, 20) || "Waiting..."}...
            </span></p>
            <p className="text-xs text-slate-600 mt-2">
              Status: {store.gameStatus === GAME_STATUS.ACTIVE ? "Active" : "Waiting"} |
              Turn: {store.currentTurn === 1 ? "A" : "B"}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Game finished
  if (store.gameStatus === GAME_STATUS.FINISHED) {
    // Check if I won (compare my role with the winner)
    const didWin = store.winner === store.playerRole;

    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900 p-8 flex items-center justify-center">
        <div className="text-center">
          <div className="text-6xl mb-6">{didWin ? '🏆' : '💀'}</div>
          <h1 className={`text-4xl font-bold mb-4 ${didWin ? 'text-green-400' : 'text-red-400'}`}>
            {didWin ? 'Victory!' : 'Defeat!'}
          </h1>
          <p className="text-gray-400 mb-8">
            {didWin ? 'You destroyed the fleet!' : 'Your fleet was destroyed!'}
          </p>
          <button
            onClick={() => {
              store.reset();
              window.location.reload(); // Refresh to ensure clean state
            }}
            className="bg-purple-600 hover:bg-purple-700 text-white px-8 py-3 rounded-xl font-semibold"
          >
            🔄 Play Again
          </button>
        </div>
      </div>
    );
  }

  return null;
}

