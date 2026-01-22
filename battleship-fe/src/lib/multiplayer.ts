
import { BN, Program, AnchorProvider } from "@coral-xyz/anchor";
import { Connection, ComputeBudgetProgram } from "@solana/web3.js";
import {
  createRpc,
  deriveAddressSeedV2,
  deriveAddressV2,
  PackedAccounts,
  SystemAccountMetaConfig,
  bn,
  featureFlags,
  VERSION,
  TreeType,
} from "@lightprotocol/stateless.js";
import { HELIUS_RPC_URL, PROGRAM_IDS } from "./solana";
import battleshipIdl from "../idl/battleship.json";

// Enable V2 Mode
(featureFlags as any).version = VERSION.V2;

// Initialize Light Protocol RPC for Devnet
// For Devnet/Mainnet, Helius RPC handles all ZK Compression endpoints
const rpc = createRpc(HELIUS_RPC_URL);

// Helper to get connection
export const getConnection = () => new Connection(HELIUS_RPC_URL);

// Program interface - using proper AnchorProvider
export const getProgram = (connection: Connection, wallet: any) => {
  // Create a proper Anchor provider
  const provider = new AnchorProvider(
    connection,
    wallet,
    { commitment: 'confirmed' }
  );

  // @ts-ignore - IDL type compatibility
  return new Program(battleshipIdl, provider);
}

/**
 * Fetch a compressed game state by game ID
 */
export async function findGameAccounts(): Promise<any[]> {
  try {
    // Query compressed accounts owned by the battleship program
    const accounts = await rpc.getCompressedAccountsByOwner(PROGRAM_IDS.battleship);
    return accounts.items;
  } catch (e) {
    console.error("Failed to fetch games:", e);
    return [];
  }
}

/**
 * Create a new game transaction on-chain
 */
export async function createOnlineGameTx(
  input: {
    connection: Connection,
    wallet: any,
    gameId: string, // Use string representation of u64
    shipX: number,
    shipY: number,
    orientation: number, // 0 or 1
    boardHash: string // Hex string
  }
) {
  const { connection, wallet, gameId, shipX, shipY, orientation, boardHash } = input;

  if (!wallet.publicKey) throw new Error("Wallet not connected");

  const program = getProgram(connection, wallet);

  // 1. Derive Game Address
  // Convert gameId to 8-byte buffer (simulating u64 LE)
  const gameIdBg = BigInt(gameId);
  const gameIdBytes = new Uint8Array(8);
  const view = new DataView(gameIdBytes.buffer);
  view.setBigUint64(0, gameIdBg, true); // Little endian

  // Seeds: ["battleship", gameId]
  const seed = deriveAddressSeedV2([
    new TextEncoder().encode("battleship"),
    gameIdBytes
  ]);

  // Get tree info from the RPC for devnet
  // Use the SDK's proper methods for devnet
  console.log("Fetching tree info from devnet...");

  // Get address tree for V2
  const addressTreeInfo = await rpc.getAddressTreeInfoV2();
  console.log("Address Tree Info:", addressTreeInfo);

  // Get state trees
  const stateTreeInfos = await rpc.getStateTreeInfos();
  console.log("State Tree Infos:", stateTreeInfos);

  // Find the state tree (StateV1 type = 0)
  const stateTreeInfo = stateTreeInfos.find((t: any) => t.treeType === TreeType.StateV1) || stateTreeInfos[0];

  if (!addressTreeInfo || !stateTreeInfo) {
    throw new Error("Could not fetch tree info from devnet. Make sure you're connected to the right network.");
  }

  const addressTree = addressTreeInfo.tree;
  const addressQueue = addressTreeInfo.queue;
  const outputStateTree = stateTreeInfo.tree;

  console.log("Using Address Tree:", addressTree.toBase58());
  console.log("Using Address Queue:", addressQueue.toBase58());
  console.log("Using Output State Tree:", outputStateTree.toBase58());

  const gameAddress = deriveAddressV2(seed, addressTree, PROGRAM_IDS.battleship);
  console.log("Derived Game Address:", gameAddress.toBase58());

  // 2. Get Validity Proof (for creating the account)
  // For new address creation, we pass the address tree and queue from the tree info
  const proofRpcResult = await rpc.getValidityProofV0(
    [], // No input compressed accounts for creation
    [{
      tree: addressTree,
      queue: addressQueue,
      address: bn(gameAddress.toBytes())
    }]
  );

  console.log("Proof result:", proofRpcResult);

  // 3. Prepare Packed Accounts (matching test file pattern)
  const systemAccountConfig = SystemAccountMetaConfig.new(PROGRAM_IDS.battleship);
  const remainingAccounts = new PackedAccounts();
  remainingAccounts.addSystemAccountsV2(systemAccountConfig);

  const addressMerkleTreePubkeyIndex = remainingAccounts.insertOrGet(addressTree);
  const addressQueuePubkeyIndex = remainingAccounts.insertOrGet(addressQueue);

  const packedAddressTreeInfo = {
    rootIndex: proofRpcResult.rootIndices[0],
    addressMerkleTreePubkeyIndex,
    addressQueuePubkeyIndex,
  };

  const outputStateTreeIndex = remainingAccounts.insertOrGet(outputStateTree);

  // 4. Build Instruction
  const boardHashBuffer = Buffer.from(boardHash, 'hex');
  const boardHashArray = Array.from(boardHashBuffer);

  // Format arguments to match the working test pattern
  const proof = { 0: proofRpcResult.compressedProof };

  const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 });

  console.log("Building transaction with args:", {
    proof,
    packedAddressTreeInfo,
    outputStateTreeIndex,
    gameId,
    shipX,
    shipY,
    isHorizontal: orientation === 0,
    boardHashLength: boardHashArray.length
  });

  try {
    const tx = await program.methods
      .createGame(
        proof as any,
        packedAddressTreeInfo as any,
        outputStateTreeIndex,
        new BN(gameId),
        shipX,
        shipY,
        orientation === 0, // boolean: true = horizontal
        boardHashArray
      )
      .accounts({ signer: wallet.publicKey })
      .preInstructions([computeBudgetIx])
      .remainingAccounts(remainingAccounts.toAccountMetas().remainingAccounts)
      .transaction();

    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.feePayer = wallet.publicKey;

    return tx;
  } catch (err) {
    console.error("Error building CreateGame transaction:", err);
    throw err;
  }
}
