import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';

export function WalletButton() {
  const { connected, publicKey } = useWallet();

  return (
    <div className="flex items-center gap-3">
      {connected && publicKey && (
        <span className="text-xs text-gray-400 font-mono">
          {publicKey.toString().slice(0, 4)}...{publicKey.toString().slice(-4)}
        </span>
      )}
      <WalletMultiButton
        style={{
          backgroundColor: connected ? '#10b981' : '#8b5cf6',
          borderRadius: '0.5rem',
          padding: '0.5rem 1rem',
          fontSize: '0.875rem',
        }}
      />
    </div>
  );
}
