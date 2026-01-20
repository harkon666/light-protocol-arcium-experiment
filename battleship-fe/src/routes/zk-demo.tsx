import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { generateBoardHash, generateRandomSalt } from '../lib/noir'

export const Route = createFileRoute('/zk-demo')({
  component: ZkDemoPage,
})

function ZkDemoPage() {
  // Input state
  const [shipX, setShipX] = useState(0)
  const [shipY, setShipY] = useState(0)
  const [orientation, setOrientation] = useState<'horizontal' | 'vertical'>('horizontal')
  const [salt, setSalt] = useState<string>('')

  // Output state
  const [hash, setHash] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>('')

  const handleGenerateSalt = () => {
    const newSalt = generateRandomSalt()
    setSalt(newSalt.toString())
  }

  const handleGenerateHash = async () => {
    if (!salt) {
      setError('Please generate a salt first!')
      return
    }

    setLoading(true)
    setError('')

    try {
      const hashResult = await generateBoardHash(
        shipX,
        shipY,
        orientation === 'horizontal' ? 0 : 1,
        BigInt(salt)
      )
      setHash(hashResult)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 p-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold text-white mb-4">
            🔐 ZK Proof Demo
          </h1>
          <p className="text-purple-300 text-lg">
            See how Zero-Knowledge proofs hide your ship positions
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-8">
          {/* Input Panel */}
          <div className="bg-slate-800/50 backdrop-blur-sm rounded-2xl p-6 border border-purple-500/30">
            <h2 className="text-xl font-semibold text-white mb-6 flex items-center gap-2">
              <span className="text-2xl">🚢</span> Private Input (Your Secret)
            </h2>

            {/* Ship Position */}
            <div className="space-y-4">
              <div>
                <label className="block text-purple-300 text-sm mb-2">Ship Position X</label>
                <input
                  type="range"
                  min="0"
                  max="4"
                  value={shipX}
                  onChange={(e) => setShipX(Number(e.target.value))}
                  className="w-full accent-purple-500"
                />
                <div className="text-white text-center">{shipX}</div>
              </div>

              <div>
                <label className="block text-purple-300 text-sm mb-2">Ship Position Y</label>
                <input
                  type="range"
                  min="0"
                  max="4"
                  value={shipY}
                  onChange={(e) => setShipY(Number(e.target.value))}
                  className="w-full accent-purple-500"
                />
                <div className="text-white text-center">{shipY}</div>
              </div>

              <div>
                <label className="block text-purple-300 text-sm mb-2">Orientation</label>
                <div className="flex gap-4">
                  <button
                    onClick={() => setOrientation('horizontal')}
                    className={`flex-1 py-2 rounded-lg transition ${orientation === 'horizontal'
                        ? 'bg-purple-600 text-white'
                        : 'bg-slate-700 text-gray-400'
                      }`}
                  >
                    ↔️ Horizontal
                  </button>
                  <button
                    onClick={() => setOrientation('vertical')}
                    className={`flex-1 py-2 rounded-lg transition ${orientation === 'vertical'
                        ? 'bg-purple-600 text-white'
                        : 'bg-slate-700 text-gray-400'
                      }`}
                  >
                    ↕️ Vertical
                  </button>
                </div>
              </div>

              {/* Salt */}
              <div>
                <label className="block text-purple-300 text-sm mb-2">Random Salt (Extra Security)</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={salt}
                    readOnly
                    placeholder="Click Generate Salt"
                    className="flex-1 bg-slate-700 text-white px-4 py-2 rounded-lg text-sm font-mono truncate"
                  />
                  <button
                    onClick={handleGenerateSalt}
                    className="bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded-lg transition"
                  >
                    🎲
                  </button>
                </div>
              </div>

              {/* Generate Button */}
              <button
                onClick={handleGenerateHash}
                disabled={loading}
                className="w-full bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 text-white py-3 rounded-xl font-semibold transition disabled:opacity-50"
              >
                {loading ? '⏳ Generating...' : '🔒 Generate ZK Hash'}
              </button>

              {error && (
                <div className="text-red-400 text-sm text-center">{error}</div>
              )}
            </div>
          </div>

          {/* Output Panel */}
          <div className="bg-slate-800/50 backdrop-blur-sm rounded-2xl p-6 border border-green-500/30">
            <h2 className="text-xl font-semibold text-white mb-6 flex items-center gap-2">
              <span className="text-2xl">📊</span> Public Output (On-Chain)
            </h2>

            {hash ? (
              <div className="space-y-6">
                <div>
                  <label className="block text-green-300 text-sm mb-2">Pedersen Hash (32 bytes)</label>
                  <div className="bg-slate-900 p-4 rounded-lg font-mono text-green-400 text-sm break-all">
                    0x{hash}
                  </div>
                </div>

                <div className="bg-green-900/30 border border-green-500/30 rounded-lg p-4">
                  <h3 className="text-green-400 font-semibold mb-2">✅ What opponent sees:</h3>
                  <ul className="text-green-300 text-sm space-y-1">
                    <li>• A random-looking 64 hex characters</li>
                    <li>• No way to know X, Y, or orientation</li>
                    <li>• Salt adds extra entropy</li>
                  </ul>
                </div>

                <div className="bg-red-900/30 border border-red-500/30 rounded-lg p-4">
                  <h3 className="text-red-400 font-semibold mb-2">❌ What opponent CANNOT see:</h3>
                  <ul className="text-red-300 text-sm space-y-1">
                    <li>• Ship X: <span className="font-mono">{shipX}</span></li>
                    <li>• Ship Y: <span className="font-mono">{shipY}</span></li>
                    <li>• Orientation: <span className="font-mono">{orientation}</span></li>
                    <li>• Salt: <span className="font-mono text-xs">{salt.slice(0, 20)}...</span></li>
                  </ul>
                </div>
              </div>
            ) : (
              <div className="text-center text-gray-500 py-12">
                <div className="text-6xl mb-4">🔮</div>
                <p>Generate a hash to see the magic!</p>
              </div>
            )}
          </div>
        </div>

        {/* Educational Section */}
        <div className="mt-12 bg-slate-800/30 backdrop-blur-sm rounded-2xl p-8 border border-slate-600/30">
          <h2 className="text-2xl font-bold text-white mb-6 text-center">🧠 How It Works</h2>
          <div className="grid md:grid-cols-3 gap-6">
            <div className="text-center">
              <div className="text-4xl mb-3">1️⃣</div>
              <h3 className="text-purple-300 font-semibold mb-2">You Choose Position</h3>
              <p className="text-gray-400 text-sm">Pick where to place your ship (x, y, orientation) + add random salt</p>
            </div>
            <div className="text-center">
              <div className="text-4xl mb-3">2️⃣</div>
              <h3 className="text-purple-300 font-semibold mb-2">Noir Validates & Hashes</h3>
              <p className="text-gray-400 text-sm">ZK circuit checks valid placement, then creates Pedersen Hash</p>
            </div>
            <div className="text-center">
              <div className="text-4xl mb-3">3️⃣</div>
              <h3 className="text-purple-300 font-semibold mb-2">Only Hash Goes On-Chain</h3>
              <p className="text-gray-400 text-sm">Solana stores the hash (commitment). Your position stays secret!</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
