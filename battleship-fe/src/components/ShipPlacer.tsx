import { GameBoard } from './GameBoard';
import { useGameStore } from '../lib/gameStore';

interface ShipPlacerProps {
  onConfirm: () => void;
}

export function ShipPlacer({ onConfirm }: ShipPlacerProps) {
  const {
    shipX,
    shipY,
    orientation,
    setShipPosition,
    setOrientation,
    isShipPlaced
  } = useGameStore();

  const isHorizontal = orientation === 'horizontal';

  // Check if ship fits on board
  const isValidPlacement = isHorizontal
    ? shipX + 4 <= 5
    : shipY + 4 <= 5;

  // Generate preview grid
  const previewGrid = new Array(25).fill(0);

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-xl font-semibold text-white mb-2">
          🚢 Place Your Ship
        </h2>
        <p className="text-gray-400 text-sm">
          Click on the grid or use controls below
        </p>
      </div>

      {/* Board with preview */}
      <div className="flex justify-center">
        <GameBoard
          grid={previewGrid}
          isOwner={true}
          isAttackMode={false}
          shipPreview={{ x: shipX, y: shipY, horizontal: isHorizontal }}
          onCellClick={(x, y) => setShipPosition(x, y)}
        />
      </div>

      {/* Controls */}
      <div className="space-y-4 max-w-xs mx-auto">
        {/* Position sliders */}
        <div>
          <label className="block text-gray-400 text-sm mb-1">Position X: {shipX}</label>
          <input
            type="range"
            min="0"
            max={isHorizontal ? 1 : 4}
            value={shipX}
            onChange={(e) => setShipPosition(Number(e.target.value), shipY)}
            className="w-full accent-purple-500"
          />
        </div>

        <div>
          <label className="block text-gray-400 text-sm mb-1">Position Y: {shipY}</label>
          <input
            type="range"
            min="0"
            max={isHorizontal ? 4 : 1}
            value={shipY}
            onChange={(e) => setShipPosition(shipX, Number(e.target.value))}
            className="w-full accent-purple-500"
          />
        </div>

        {/* Orientation toggle */}
        <div className="flex gap-2">
          <button
            onClick={() => {
              setOrientation('horizontal');
              // Adjust position if needed
              if (shipX > 1) setShipPosition(1, shipY);
            }}
            className={`flex-1 py-2 rounded-lg transition ${isHorizontal
                ? 'bg-purple-600 text-white'
                : 'bg-slate-700 text-gray-400'
              }`}
          >
            ↔️ Horizontal
          </button>
          <button
            onClick={() => {
              setOrientation('vertical');
              // Adjust position if needed
              if (shipY > 1) setShipPosition(shipX, 1);
            }}
            className={`flex-1 py-2 rounded-lg transition ${!isHorizontal
                ? 'bg-purple-600 text-white'
                : 'bg-slate-700 text-gray-400'
              }`}
          >
            ↕️ Vertical
          </button>
        </div>

        {/* Validity indicator */}
        {!isValidPlacement && (
          <div className="text-red-400 text-sm text-center">
            ⚠️ Ship doesn't fit! Adjust position.
          </div>
        )}

        {/* Confirm button */}
        <button
          onClick={onConfirm}
          disabled={!isValidPlacement || isShipPlaced}
          className="w-full bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700 text-white py-3 rounded-xl font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          ✅ Confirm Placement
        </button>
      </div>
    </div>
  );
}
