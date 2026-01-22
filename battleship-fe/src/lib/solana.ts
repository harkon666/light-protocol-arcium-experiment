import { Connection, PublicKey } from '@solana/web3.js';

// Helius RPC for devnet (replace with your API key)
export const HELIUS_RPC_URL = 'https://devnet.helius-rpc.com/?api-key=ce23e4f2-a2d1-479e-ba11-47270f50bd07';

// Deployed program IDs
export const PROGRAM_IDS = {
  battleship: new PublicKey('3gogNiRRhYTAT5UJUh4QCQ7XksCgrRr8dhGGMqjM3HLp'),
};

// Light Protocol devnet endpoints
// Note: Helius now supports ZK Compression on the main RPC endpoint
export const LIGHT_PROTOCOL = {
  photonIndexer: HELIUS_RPC_URL,
  prover: HELIUS_RPC_URL,
};

// Create connection
let connection: Connection | null = null;

export function getConnection(): Connection {
  if (!connection) {
    connection = new Connection(HELIUS_RPC_URL, 'confirmed');
  }
  return connection;
}

// Cluster for wallet adapter
export const CLUSTER = 'devnet';
export const ENDPOINT = HELIUS_RPC_URL;
