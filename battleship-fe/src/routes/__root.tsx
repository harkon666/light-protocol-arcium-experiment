import { Link, Outlet, createRootRoute } from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'
import { WalletButton } from '../components/WalletButton'

export const Route = createRootRoute({
  component: () => (
    <>
      {/* Navigation */}
      <nav className="bg-slate-900 border-b border-purple-500/30 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <Link to="/" className="text-xl font-bold text-white flex items-center gap-2">
            🚢 ZK Battleship
          </Link>
          <div className="flex items-center gap-6">
            <div className="flex gap-4">
              <Link
                to="/"
                className="text-gray-300 hover:text-white transition"
                activeProps={{ className: 'text-purple-400' }}
              >
                Home
              </Link>
              <Link
                to="/zk-demo"
                className="text-gray-300 hover:text-white transition"
                activeProps={{ className: 'text-purple-400' }}
              >
                🔐 ZK Demo
              </Link>
              <Link
                to="/game"
                className="text-gray-300 hover:text-white transition"
                activeProps={{ className: 'text-purple-400' }}
              >
                🎮 Play Game
              </Link>
            </div>
            <WalletButton />
          </div>
        </div>
      </nav>

      <Outlet />
      <TanStackDevtools
        config={{
          position: 'bottom-right',
        }}
        plugins={[
          {
            name: 'Tanstack Router',
            render: <TanStackRouterDevtoolsPanel />,
          },
        ]}
      />
    </>
  ),
})
