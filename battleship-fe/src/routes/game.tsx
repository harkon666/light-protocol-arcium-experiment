import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { ShipPlacer } from '../components/ShipPlacer'
import { GameBoard } from '../components/GameBoard'
import { useGameStore, GAME_STATUS, CELL_EMPTY, CELL_SHIP } from '../lib/gameStore'
import { generateBoardHash, generateRandomSalt } from '../lib/noir'
import { createOnlineGameTx, getConnection } from '../lib/multiplayer'
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

  const handleAttack = (x: number, y: number) => {
    if (aiThinking && gameMode === 'ai') return; // Prevent attack while AI is thinking

    // Determine if hit by checking opponent's grid
    const targetGrid = store.gridB; // Player A always attacks B
    const idx = y * 5 + x;
    const isHit = targetGrid[idx] === CELL_SHIP;

    store.attack(x, y, isHit);
    setLastAiMove(null);
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
    const isMyTurn = store.currentTurn === 1; // Player A is always human

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
            <p className="text-sm mt-1">Enemy Hash: <span className="font-mono text-purple-400">{store.boardHashB?.substring(0, 20)}...</span></p>
          </div>
        </div>
      </div>
    );
  }

  // Game finished
  if (store.gameStatus === GAME_STATUS.FINISHED) {
    const didWin = store.winner === 'A'; // Human is always player A

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
            onClick={() => store.reset()}
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

