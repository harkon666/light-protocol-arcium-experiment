import { CELL_EMPTY, CELL_SHIP, CELL_HIT, CELL_MISS } from '../lib/gameStore';

interface GameBoardProps {
  grid: number[];
  isOwner: boolean; // true = show ships, false = hide ships (enemy view)
  isAttackMode: boolean;
  onCellClick?: (x: number, y: number) => void;
  shipPreview?: { x: number; y: number; horizontal: boolean } | null;
}

export function GameBoard({
  grid,
  isOwner,
  isAttackMode,
  onCellClick,
  shipPreview
}: GameBoardProps) {

  const getCellStyle = (value: number, index: number) => {

    // Ship preview
    if (shipPreview) {
      const previewCells: number[] = [];
      for (let i = 0; i < 4; i++) {
        const px = shipPreview.horizontal ? shipPreview.x + i : shipPreview.x;
        const py = shipPreview.horizontal ? shipPreview.y : shipPreview.y + i;
        previewCells.push(py * 5 + px);
      }
      if (previewCells.includes(index)) {
        return 'bg-purple-500/50 border-purple-400';
      }
    }

    switch (value) {
      case CELL_SHIP:
        return isOwner
          ? 'bg-blue-600 border-blue-400'
          : 'bg-slate-700 border-slate-600'; // Hide enemy ships
      case CELL_HIT:
        return 'bg-red-600 border-red-400';
      case CELL_MISS:
        return 'bg-gray-500 border-gray-400';
      default:
        return 'bg-slate-700 border-slate-600 hover:bg-slate-600';
    }
  };

  const getCellContent = (value: number) => {
    switch (value) {
      case CELL_HIT:
        return '💥';
      case CELL_MISS:
        return '🌊';
      case CELL_SHIP:
        return isOwner ? '🚢' : '';
      default:
        return '';
    }
  };

  return (
    <div className="inline-block">
      {/* Column headers */}
      <div className="flex mb-1">
        <div className="w-10" /> {/* Spacer for row labels */}
        {[0, 1, 2, 3, 4].map(i => (
          <div key={i} className="w-12 text-center text-gray-400 text-sm">
            {i}
          </div>
        ))}
      </div>

      {/* Grid rows */}
      {[0, 1, 2, 3, 4].map(y => (
        <div key={y} className="flex">
          {/* Row label */}
          <div className="w-10 flex items-center justify-center text-gray-400 text-sm">
            {y}
          </div>

          {/* Cells */}
          {[0, 1, 2, 3, 4].map(x => {
            const idx = y * 5 + x;
            const value = grid[idx];
            const canClick = isAttackMode && (value === CELL_EMPTY || value === CELL_SHIP);

            return (
              <button
                key={x}
                onClick={() => canClick && onCellClick?.(x, y)}
                disabled={!canClick && isAttackMode}
                className={`
                  w-12 h-12 border-2 rounded-lg m-0.5 
                  flex items-center justify-center text-xl
                  transition-all duration-150
                  ${getCellStyle(value, idx)}
                  ${canClick ? 'cursor-crosshair hover:scale-105' : ''}
                  ${!canClick && isAttackMode ? 'cursor-not-allowed opacity-50' : ''}
                `}
              >
                {getCellContent(value)}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
