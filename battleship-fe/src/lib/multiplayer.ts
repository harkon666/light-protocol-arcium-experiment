
import { BN, Program, AnchorProvider } from "@coral-xyz/anchor";
import { Connection, ComputeBudgetProgram, PublicKey } from "@solana/web3.js";
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

/**
 * Derive game address from game ID
 */
export async function deriveGameAddress(gameId: string) {
  const gameIdBg = BigInt(gameId);
  const gameIdBytes = new Uint8Array(8);
  const view = new DataView(gameIdBytes.buffer);
  view.setBigUint64(0, gameIdBg, true);

  const seed = deriveAddressSeedV2([
    new TextEncoder().encode("battleship"),
    gameIdBytes
  ]);

  const addressTreeInfo = await rpc.getAddressTreeInfoV2();
  const addressTree = addressTreeInfo.tree;

  return deriveAddressV2(seed, addressTree, PROGRAM_IDS.battleship);
}

/**
 * Fetch game state by game ID
 */
export async function getGameByGameId(gameId: string): Promise<{ account: any; state: any } | null> {
  try {
    const gameAddress = await deriveGameAddress(gameId);
    console.log("Looking up game at address:", gameAddress.toBase58());

    const account = await rpc.getCompressedAccount(bn(gameAddress.toBytes()));

    if (!account || !account.data) {
      console.log("Game not found");
      return null;
    }

    // Decode the game state from the compressed account data
    const state = decodeGameState(account.data.data);

    return { account, state };
  } catch (e) {
    console.error("Failed to fetch game:", e);
    return null;
  }
}

/**
 * Decode GameState from raw buffer
 * Matches the Rust struct layout
 * GameState struct size: 190 bytes (without discriminator) or 198 bytes (with)
 */
function decodeGameState(data: Buffer | Uint8Array): any {
  const buffer = Buffer.from(data);
  let offset = 0;

  console.log("Buffer size:", buffer.length);
  console.log("Buffer hex (first 50 bytes):", buffer.slice(0, 50).toString('hex'));

  // Check if buffer has discriminator (198 bytes vs 190 bytes)
  // GameState: 8 + 32 + 32 + 1 + 1 + 25 + 32 + 1 + 25 + 32 + 1 = 190 bytes without discriminator
  const GAME_STATE_SIZE = 190;
  const hasDiscriminator = buffer.length >= GAME_STATE_SIZE + 8;

  if (hasDiscriminator) {
    console.log("Detected discriminator, skipping 8 bytes");
    offset += 8;
  }

  // game_id: u64 (8 bytes)
  const gameId = buffer.readBigUInt64LE(offset);
  offset += 8;

  // player_a: Pubkey (32 bytes)
  const playerA = new PublicKey(buffer.slice(offset, offset + 32));
  offset += 32;

  // player_b: Pubkey (32 bytes)
  const playerB = new PublicKey(buffer.slice(offset, offset + 32));
  offset += 32;

  // current_turn: u8 (1 byte)
  const currentTurn = buffer.readUInt8(offset);
  offset += 1;

  // game_status: u8 (1 byte)
  const gameStatus = buffer.readUInt8(offset);
  offset += 1;

  // grid_a: [u8; 25] (25 bytes)
  const gridA = Array.from(buffer.slice(offset, offset + 25));
  offset += 25;

  // board_hash_a: [u8; 32] (32 bytes)
  const boardHashA = Array.from(buffer.slice(offset, offset + 32));
  offset += 32;

  // hits_a: u8 (1 byte)
  const hitsA = buffer.readUInt8(offset);
  offset += 1;

  // grid_b: [u8; 25] (25 bytes)
  const gridB = Array.from(buffer.slice(offset, offset + 25));
  offset += 25;

  // board_hash_b: [u8; 32] (32 bytes)
  const boardHashB = Array.from(buffer.slice(offset, offset + 32));
  offset += 32;

  // hits_b: u8 (1 byte)
  const hitsB = buffer.readUInt8(offset);

  // Return with BN for u64 and Arrays for fixed-size arrays (Anchor serialization format)
  return {
    gameId: new BN(gameId.toString()), // BN for u64
    playerA,  // PublicKey
    playerB,  // PublicKey
    currentTurn,
    gameStatus,
    gridA,
    boardHashA,
    hitsA,
    gridB,
    boardHashB,
    hitsB,
  };
}

/**
 * Join an existing game as Player B
 */
export async function joinOnlineGameTx(
  input: {
    connection: Connection,
    wallet: any,
    gameId: string,
    shipX: number,
    shipY: number,
    orientation: number, // 0 = horizontal, 1 = vertical
    boardHash: string // Hex string
  }
) {
  const { connection, wallet, gameId, shipX, shipY, orientation, boardHash } = input;

  if (!wallet.publicKey) throw new Error("Wallet not connected");

  const program = getProgram(connection, wallet);

  console.log("Joining game:", gameId);

  // 1. Derive game address and fetch current game state
  const gameAddress = await deriveGameAddress(gameId);
  console.log("Game Address:", gameAddress.toBase58());

  const account = await rpc.getCompressedAccount(bn(gameAddress.toBytes()));
  if (!account || !account.data) {
    throw new Error("Game not found. Make sure the Game ID is correct.");
  }

  const state = decodeGameState(account.data.data);
  console.log("Current game state:", state);

  // Check if game is in waiting state
  if (state.gameStatus !== 0) {
    throw new Error("Game is not in waiting state. Cannot join.");
  }

  // 2. Get validity proof for updating the account
  const proofRpcResult = await rpc.getValidityProofV0(
    [{
      hash: account.hash,
      tree: account.treeInfo.tree,
      queue: account.treeInfo.queue
    }],
    [] // No new addresses
  );

  console.log("Proof result:", proofRpcResult);

  // 3. Prepare Packed Accounts
  const systemAccountConfig = SystemAccountMetaConfig.new(PROGRAM_IDS.battleship);
  const remainingAccounts = new PackedAccounts();
  remainingAccounts.addSystemAccountsV2(systemAccountConfig);

  const merkleTreeIndex = remainingAccounts.insertOrGet(account.treeInfo.tree);
  const queueIndex = remainingAccounts.insertOrGet(account.treeInfo.queue);

  // Get output state tree
  const stateTreeInfos = await rpc.getStateTreeInfos();
  const stateTreeInfo = stateTreeInfos.find((t: any) => t.treeType === TreeType.StateV1) || stateTreeInfos[0];
  const outputStateTree = stateTreeInfo.tree;
  const outputStateTreeIndex = remainingAccounts.insertOrGet(outputStateTree);

  // Build account meta matching the IDL's CompressedAccountMeta
  const accountMeta = {
    treeInfo: {
      rootIndex: proofRpcResult.rootIndices[0],
      proveByIndex: false,
      merkleTreePubkeyIndex: merkleTreeIndex,
      queuePubkeyIndex: queueIndex,
      leafIndex: account.leafIndex,
    },
    address: Array.from(gameAddress.toBytes()),
    outputStateTreeIndex,
  };

  // 4. Build board hash array
  const boardHashBuffer = Buffer.from(boardHash, 'hex');
  const boardHashArray = Array.from(boardHashBuffer);

  // 5. Format proof
  const proof = { 0: proofRpcResult.compressedProof };

  const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 });

  console.log("Building joinGame transaction...");

  try {
    const tx = await program.methods
      .joinGame(
        proof as any,
        state as any,
        accountMeta as any,
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
    console.error("Error building JoinGame transaction:", err);
    throw err;
  }
}

/**
 * Send an attack transaction (Online Mode)
 */
export async function attackTx(
  input: {
    connection: Connection,
    wallet: any,
    gameId: string,
    x: number,
    y: number
  }
) {
  const { connection, wallet, gameId, x, y } = input;

  if (!wallet.publicKey) throw new Error("Wallet not connected");

  const program = getProgram(connection, wallet);

  // 1. Derive game address and fetch current game state
  const gameAddress = await deriveGameAddress(gameId);
  const account = await rpc.getCompressedAccount(bn(gameAddress.toBytes()));

  if (!account || !account.data) {
    throw new Error("Game not found. Make sure the Game ID is correct.");
  }

  const state = decodeGameState(account.data.data);

  // 2. Get validity proof for updating the account
  const proofRpcResult = await rpc.getValidityProofV0(
    [{
      hash: account.hash,
      tree: account.treeInfo.tree,
      queue: account.treeInfo.queue
    }],
    [] // No new addresses
  );

  // 3. Prepare Packed Accounts
  const systemAccountConfig = SystemAccountMetaConfig.new(PROGRAM_IDS.battleship);
  const remainingAccounts = new PackedAccounts();
  remainingAccounts.addSystemAccountsV2(systemAccountConfig);

  const merkleTreeIndex = remainingAccounts.insertOrGet(account.treeInfo.tree);
  const queueIndex = remainingAccounts.insertOrGet(account.treeInfo.queue);

  // Get output state tree
  const stateTreeInfos = await rpc.getStateTreeInfos();
  const stateTreeInfo = stateTreeInfos.find((t: any) => t.treeType === TreeType.StateV1) || stateTreeInfos[0];
  const outputStateTree = stateTreeInfo.tree;
  const outputStateTreeIndex = remainingAccounts.insertOrGet(outputStateTree);

  // Build account meta matching the IDL's CompressedAccountMeta
  const accountMeta = {
    treeInfo: {
      rootIndex: proofRpcResult.rootIndices[0],
      proveByIndex: false,
      merkleTreePubkeyIndex: merkleTreeIndex,
      queuePubkeyIndex: queueIndex,
      leafIndex: account.leafIndex,
    },
    address: Array.from(gameAddress.toBytes()),
    outputStateTreeIndex,
  };

  // 4. Format proof
  const proof = { 0: proofRpcResult.compressedProof };

  const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 });

  console.log("Building attack transaction...", { x, y });

  try {
    const tx = await program.methods
      .attack(
        proof as any,
        state as any,
        accountMeta as any,
        x,
        y
      )
      .accounts({ signer: wallet.publicKey })
      .preInstructions([computeBudgetIx])
      .remainingAccounts(remainingAccounts.toAccountMetas().remainingAccounts)
      .transaction();

    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.feePayer = wallet.publicKey;

    return tx;
  } catch (err) {
    console.error("Error building Attack transaction:", err);
    throw err;
  }
}
