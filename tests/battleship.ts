import * as anchor from "@coral-xyz/anchor";
import { Program, web3 } from "@coral-xyz/anchor";
import { Battleship } from "../target/types/battleship";
import idl from "../target/idl/battleship.json";
import {
  bn,
  confirmTx,
  createRpc,
  defaultTestStateTreeAccounts,
  deriveAddressV2,
  deriveAddressSeedV2,
  batchAddressTree,
  PackedAccounts,
  Rpc,
  sleep,
  SystemAccountMetaConfig,
  featureFlags,
  VERSION,
} from "@lightprotocol/stateless.js";
import * as assert from "assert";

// Force V2 mode
(featureFlags as any).version = VERSION.V2;

const path = require("path");
const os = require("os");
require("dotenv").config();

const anchorWalletPath = path.join(os.homedir(), ".config/solana/id.json");
process.env.ANCHOR_WALLET = anchorWalletPath;

// Grid constants
const GRID_SIZE = 5;
const SHIP_LENGTH = 4;

// Cell states
const CELL_EMPTY = 0;
const CELL_SHIP = 1;
const CELL_HIT = 2;
const CELL_MISS = 3;

describe("battleship", () => {
  const program = anchor.workspace.Battleship as Program<Battleship>;
  const coder = new anchor.BorshCoder(idl as anchor.Idl);

  // Shared state across tests
  let signer: web3.Keypair;
  let rpc: Rpc;
  let outputStateTree: web3.PublicKey;
  let addressTree: web3.PublicKey;
  let gameAddress: web3.PublicKey;

  const GAME_ID = Date.now(); // Unique game ID

  before(async () => {
    signer = new web3.Keypair();
    rpc = createRpc(
      "http://127.0.0.1:8899",
      "http://127.0.0.1:8784",
      "http://127.0.0.1:3001",
      { commitment: "confirmed" }
    );
    await rpc.requestAirdrop(signer.publicKey, web3.LAMPORTS_PER_SOL * 2);
    await sleep(2000);

    outputStateTree = defaultTestStateTreeAccounts().merkleTree;
    addressTree = new web3.PublicKey(batchAddressTree);

    // Derive game address
    const gameIdBytes = Buffer.alloc(8);
    gameIdBytes.writeBigUInt64LE(BigInt(GAME_ID));
    const seed = deriveAddressSeedV2([Buffer.from("battleship"), gameIdBytes]);
    gameAddress = deriveAddressV2(seed, addressTree, new web3.PublicKey(program.idl.address));

    console.log("Game ID:", GAME_ID);
    console.log("Game Address:", gameAddress.toBase58());
  });

  // ===============================
  // TEST 1: Create Game with Ship
  // ===============================
  it("1. create game with ship placed horizontally at (0,0)", async () => {
    const shipStartX = 0;
    const shipStartY = 0;
    const isHorizontal = true;

    const proofRpcResult = await rpc.getValidityProofV0(
      [],
      [{ tree: addressTree, queue: addressTree, address: bn(gameAddress.toBytes()) }]
    );

    const systemAccountConfig = new SystemAccountMetaConfig(program.programId);
    const remainingAccounts = new PackedAccounts();
    remainingAccounts.addSystemAccountsV2(systemAccountConfig);

    const addressMerkleTreePubkeyIndex = remainingAccounts.insertOrGet(addressTree);
    const packedAddressTreeInfo = {
      rootIndex: proofRpcResult.rootIndices[0],
      addressMerkleTreePubkeyIndex,
      addressQueuePubkeyIndex: addressMerkleTreePubkeyIndex,
    };
    const outputStateTreeIndex = remainingAccounts.insertOrGet(outputStateTree);
    const proof = { 0: proofRpcResult.compressedProof };

    const computeBudgetIx = web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1000000 });
    const tx = await program.methods
      .createGame(
        proof,
        packedAddressTreeInfo,
        outputStateTreeIndex,
        new anchor.BN(GAME_ID),
        shipStartX,
        shipStartY,
        isHorizontal
      )
      .accounts({ signer: signer.publicKey })
      .preInstructions([computeBudgetIx])
      .remainingAccounts(remainingAccounts.toAccountMetas().remainingAccounts)
      .signers([signer])
      .transaction();

    tx.recentBlockhash = (await rpc.getRecentBlockhash()).blockhash;
    tx.sign(signer);
    const sig = await rpc.sendTransaction(tx, [signer]);
    await confirmTx(rpc, sig);
    console.log("Create Game TX:", sig);

    // Wait for indexer
    const slot = await rpc.getSlot();
    await rpc.confirmTransactionIndexed(slot);

    // Verify game state
    const compressedAccount = await rpc.getCompressedAccount(bn(gameAddress.toBytes()));
    const decoded = coder.types.decode("GameState", compressedAccount!.data!.data);

    console.log("Decoded GameState:", decoded);

    assert.strictEqual(decoded.game_id.toNumber(), GAME_ID, "Game ID should match");
    assert.strictEqual(decoded.hits, 0, "Hits should be 0");
    assert.strictEqual(decoded.attacks_made, 0, "Attacks made should be 0");
    assert.strictEqual(decoded.is_game_over, false, "Game should not be over");

    // Verify ship placement at indices 0, 1, 2, 3 (horizontal from 0,0)
    assert.deepStrictEqual(
      Array.from(decoded.ship_cells),
      [0, 1, 2, 3],
      "Ship should be at cells 0, 1, 2, 3"
    );

    console.log("✅ Game created with ship at (0,0)-(3,0) horizontally");
  });

  // ===============================
  // TEST 2: Attack and HIT
  // ===============================
  it("2. attack (0,0) - should be HIT", async () => {
    const attackX = 0;
    const attackY = 0;

    // Fetch current game state
    const compressedAccount = await rpc.getCompressedAccount(bn(gameAddress.toBytes()));
    const currentGame = coder.types.decode("GameState", compressedAccount!.data!.data);
    const currentGameArg = {
      gameId: currentGame.game_id,
      grid: currentGame.grid,
      shipCells: currentGame.ship_cells,
      hits: currentGame.hits,
      attacksMade: currentGame.attacks_made,
      isGameOver: currentGame.is_game_over,
    };

    const proofRpcResult = await rpc.getValidityProofV0(
      [{
        hash: compressedAccount!.hash,
        tree: compressedAccount!.treeInfo.tree,
        queue: compressedAccount!.treeInfo.queue
      }],
      []
    );

    const systemAccountConfig = new SystemAccountMetaConfig(program.programId);
    const remainingAccounts = new PackedAccounts();
    remainingAccounts.addSystemAccountsV2(systemAccountConfig);

    const merkleTreeIndex = remainingAccounts.insertOrGet(compressedAccount!.treeInfo.tree);
    const queueIndex = remainingAccounts.insertOrGet(compressedAccount!.treeInfo.queue);
    const outputStateTreeIndex = remainingAccounts.insertOrGet(outputStateTree);

    const accountMeta = {
      treeInfo: {
        rootIndex: proofRpcResult.rootIndices[0],
        proveByIndex: false,
        merkleTreePubkeyIndex: merkleTreeIndex,
        queuePubkeyIndex: queueIndex,
        leafIndex: compressedAccount!.leafIndex,
      },
      address: Array.from(gameAddress.toBytes()),
      outputStateTreeIndex,
    };

    const proof = { 0: proofRpcResult.compressedProof };
    const computeBudgetIx = web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1000000 });

    const tx = await program.methods
      .attack(proof, currentGameArg, accountMeta, attackX, attackY)
      .accounts({ signer: signer.publicKey })
      .preInstructions([computeBudgetIx])
      .remainingAccounts(remainingAccounts.toAccountMetas().remainingAccounts)
      .signers([signer])
      .transaction();

    tx.recentBlockhash = (await rpc.getRecentBlockhash()).blockhash;
    tx.sign(signer);
    const sig = await rpc.sendTransaction(tx, [signer]);
    await confirmTx(rpc, sig);
    console.log("Attack (0,0) TX:", sig);

    // Wait for indexer
    const slot = await rpc.getSlot();
    await rpc.confirmTransactionIndexed(slot);

    // Verify game state
    const updatedAccount = await rpc.getCompressedAccount(bn(gameAddress.toBytes()));
    const decoded = coder.types.decode("GameState", updatedAccount!.data!.data);

    assert.strictEqual(decoded.hits, 1, "Hits should be 1");
    assert.strictEqual(decoded.attacks_made, 1, "Attacks made should be 1");
    assert.strictEqual(decoded.grid[0], CELL_HIT, "Cell (0,0) should be HIT");
    assert.strictEqual(decoded.is_game_over, false, "Game should not be over yet");

    console.log("✅ Attack (0,0) - HIT! Hits: 1/4");
  });

  // ===============================
  // TEST 3: Attack and MISS
  // ===============================
  it("3. attack (4,4) - should be MISS", async () => {
    const attackX = 4;
    const attackY = 4;

    // Fetch current game state
    const compressedAccount = await rpc.getCompressedAccount(bn(gameAddress.toBytes()));
    const currentGame = coder.types.decode("GameState", compressedAccount!.data!.data);
    const currentGameArg = {
      gameId: currentGame.game_id,
      grid: currentGame.grid,
      shipCells: currentGame.ship_cells,
      hits: currentGame.hits,
      attacksMade: currentGame.attacks_made,
      isGameOver: currentGame.is_game_over,
    };

    const proofRpcResult = await rpc.getValidityProofV0(
      [{
        hash: compressedAccount!.hash,
        tree: compressedAccount!.treeInfo.tree,
        queue: compressedAccount!.treeInfo.queue
      }],
      []
    );

    const systemAccountConfig = new SystemAccountMetaConfig(program.programId);
    const remainingAccounts = new PackedAccounts();
    remainingAccounts.addSystemAccountsV2(systemAccountConfig);

    const merkleTreeIndex = remainingAccounts.insertOrGet(compressedAccount!.treeInfo.tree);
    const queueIndex = remainingAccounts.insertOrGet(compressedAccount!.treeInfo.queue);
    const outputStateTreeIndex = remainingAccounts.insertOrGet(outputStateTree);

    const accountMeta = {
      treeInfo: {
        rootIndex: proofRpcResult.rootIndices[0],
        proveByIndex: false,
        merkleTreePubkeyIndex: merkleTreeIndex,
        queuePubkeyIndex: queueIndex,
        leafIndex: compressedAccount!.leafIndex,
      },
      address: Array.from(gameAddress.toBytes()),
      outputStateTreeIndex,
    };

    const proof = { 0: proofRpcResult.compressedProof };
    const computeBudgetIx = web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1000000 });

    const tx = await program.methods
      .attack(proof, currentGameArg, accountMeta, attackX, attackY)
      .accounts({ signer: signer.publicKey })
      .preInstructions([computeBudgetIx])
      .remainingAccounts(remainingAccounts.toAccountMetas().remainingAccounts)
      .signers([signer])
      .transaction();

    tx.recentBlockhash = (await rpc.getRecentBlockhash()).blockhash;
    tx.sign(signer);
    const sig = await rpc.sendTransaction(tx, [signer]);
    await confirmTx(rpc, sig);
    console.log("Attack (4,4) TX:", sig);

    // Wait for indexer
    const slot = await rpc.getSlot();
    await rpc.confirmTransactionIndexed(slot);

    // Verify game state
    const updatedAccount = await rpc.getCompressedAccount(bn(gameAddress.toBytes()));
    const decoded = coder.types.decode("GameState", updatedAccount!.data!.data);

    assert.strictEqual(decoded.hits, 1, "Hits should still be 1");
    assert.strictEqual(decoded.attacks_made, 2, "Attacks made should be 2");
    const cellIndex = attackY * GRID_SIZE + attackX; // 4*5+4 = 24
    assert.strictEqual(decoded.grid[cellIndex], CELL_MISS, "Cell (4,4) should be MISS");

    console.log("✅ Attack (4,4) - MISS! Attacks: 2");
  });

  // ===============================
  // TEST 4: Sink the ship (GAME OVER)
  // ===============================
  it("4. attack remaining ship cells - should trigger GAME OVER", async () => {
    // Attack cells (1,0), (2,0), (3,0) to sink the ship
    const attackCoords = [[1, 0], [2, 0], [3, 0]];

    for (let i = 0; i < attackCoords.length; i++) {
      const [attackX, attackY] = attackCoords[i];

      // Fetch current game state
      const compressedAccount = await rpc.getCompressedAccount(bn(gameAddress.toBytes()));
      const currentGame = coder.types.decode("GameState", compressedAccount!.data!.data);
      const currentGameArg = {
        gameId: currentGame.game_id,
        grid: currentGame.grid,
        shipCells: currentGame.ship_cells,
        hits: currentGame.hits,
        attacksMade: currentGame.attacks_made,
        isGameOver: currentGame.is_game_over,
      };

      const proofRpcResult = await rpc.getValidityProofV0(
        [{
          hash: compressedAccount!.hash,
          tree: compressedAccount!.treeInfo.tree,
          queue: compressedAccount!.treeInfo.queue
        }],
        []
      );

      const systemAccountConfig = new SystemAccountMetaConfig(program.programId);
      const remainingAccounts = new PackedAccounts();
      remainingAccounts.addSystemAccountsV2(systemAccountConfig);

      const merkleTreeIndex = remainingAccounts.insertOrGet(compressedAccount!.treeInfo.tree);
      const queueIndex = remainingAccounts.insertOrGet(compressedAccount!.treeInfo.queue);
      const outputStateTreeIndex = remainingAccounts.insertOrGet(outputStateTree);

      const accountMeta = {
        treeInfo: {
          rootIndex: proofRpcResult.rootIndices[0],
          proveByIndex: false,
          merkleTreePubkeyIndex: merkleTreeIndex,
          queuePubkeyIndex: queueIndex,
          leafIndex: compressedAccount!.leafIndex,
        },
        address: Array.from(gameAddress.toBytes()),
        outputStateTreeIndex,
      };

      const proof = { 0: proofRpcResult.compressedProof };
      const computeBudgetIx = web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1000000 });

      const tx = await program.methods
        .attack(proof, currentGameArg, accountMeta, attackX, attackY)
        .accounts({ signer: signer.publicKey })
        .preInstructions([computeBudgetIx])
        .remainingAccounts(remainingAccounts.toAccountMetas().remainingAccounts)
        .signers([signer])
        .transaction();

      tx.recentBlockhash = (await rpc.getRecentBlockhash()).blockhash;
      tx.sign(signer);
      const sig = await rpc.sendTransaction(tx, [signer]);
      await confirmTx(rpc, sig);
      console.log(`Attack (${attackX},${attackY}) TX:`, sig);

      // Wait for indexer
      const slot = await rpc.getSlot();
      await rpc.confirmTransactionIndexed(slot);
    }

    // Verify final game state
    const finalAccount = await rpc.getCompressedAccount(bn(gameAddress.toBytes()));
    const decoded = coder.types.decode("GameState", finalAccount!.data!.data);

    assert.strictEqual(decoded.hits, 4, "Hits should be 4");
    assert.strictEqual(decoded.attacks_made, 5, "Attacks made should be 5");
    assert.strictEqual(decoded.is_game_over, true, "Game should be OVER!");

    // All ship cells should be HIT
    for (let i = 0; i < SHIP_LENGTH; i++) {
      assert.strictEqual(decoded.grid[i], CELL_HIT, `Cell ${i} should be HIT`);
    }

    console.log("🎉 GAME OVER! Ship sunk in 5 attacks!");
    console.log("Grid state:", Array.from(decoded.grid));
  });
});
