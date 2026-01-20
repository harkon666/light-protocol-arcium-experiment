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

describe("battleship_1v1", () => {
  const program = anchor.workspace.Battleship as Program<Battleship>;
  const coder = new anchor.BorshCoder(idl as anchor.Idl);

  // Shared state
  let signerA: web3.Keypair;
  let signerB: web3.Keypair;
  let rpc: Rpc;
  let outputStateTree: web3.PublicKey;
  let addressTree: web3.PublicKey;
  let gameAddress: web3.PublicKey;

  const GAME_ID = Date.now();

  before(async () => {
    signerA = new web3.Keypair();
    signerB = new web3.Keypair();

    rpc = createRpc(
      "http://127.0.0.1:8899",
      "http://127.0.0.1:8784",
      "http://127.0.0.1:3001",
      { commitment: "confirmed" }
    );

    // Airdrop to both players
    await rpc.requestAirdrop(signerA.publicKey, web3.LAMPORTS_PER_SOL * 2);
    await rpc.requestAirdrop(signerB.publicKey, web3.LAMPORTS_PER_SOL * 2);
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

  // Helper to decode GameState
  const decodeGameState = (data: Buffer) => {
    const decoded = coder.types.decode("GameState", data);
    return {
      gameId: decoded.game_id,
      playerA: decoded.player_a,
      playerB: decoded.player_b,
      currentTurn: decoded.current_turn,
      gameStatus: decoded.game_status,
      // Player A
      gridA: decoded.grid_a,
      shipsA: decoded.ships_a,
      hitsA: decoded.hits_a,
      // Player B
      gridB: decoded.grid_b,
      shipsB: decoded.ships_b,
      hitsB: decoded.hits_b,
    };
  };

  it("1. Player A Creates Game", async () => {
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

    const computeBudgetIx = web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 });

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
      .accounts({ signer: signerA.publicKey })
      .preInstructions([computeBudgetIx])
      .remainingAccounts(remainingAccounts.toAccountMetas().remainingAccounts)
      .signers([signerA])
      .transaction();

    tx.recentBlockhash = (await rpc.getRecentBlockhash()).blockhash;
    tx.sign(signerA);
    const sig = await rpc.sendTransaction(tx, [signerA]);
    await confirmTx(rpc, sig);
    console.log("Create Game TX:", sig);

    await rpc.confirmTransactionIndexed(await rpc.getSlot());

    // Verify State
    const account = await rpc.getCompressedAccount(bn(gameAddress.toBytes()));
    const state = decodeGameState(account!.data!.data);

    assert.strictEqual(state.gameId.toNumber(), GAME_ID);
    assert.ok(state.playerA.equals(signerA.publicKey));
    assert.strictEqual(state.currentTurn, 1);
    assert.strictEqual(state.gameStatus, 0); // Waiting
    console.log("✅ Game Created. Waiting for B.");
  });

  it("2. Player B Joins Game", async () => {
    // Player B places ship vertically at (4,0)
    const shipStartX = 4;
    const shipStartY = 0;
    const isHorizontal = false; // Vertical at right edge

    const account = await rpc.getCompressedAccount(bn(gameAddress.toBytes()));
    const state = decodeGameState(account!.data!.data);

    const proofRpcResult = await rpc.getValidityProofV0(
      [{ hash: account!.hash, tree: account!.treeInfo.tree, queue: account!.treeInfo.queue }],
      []
    );

    const systemAccountConfig = new SystemAccountMetaConfig(program.programId);
    const remainingAccounts = new PackedAccounts();
    remainingAccounts.addSystemAccountsV2(systemAccountConfig);

    const merkleTreeIndex = remainingAccounts.insertOrGet(account!.treeInfo.tree);
    const queueIndex = remainingAccounts.insertOrGet(account!.treeInfo.queue);
    const outputStateTreeIndex = remainingAccounts.insertOrGet(outputStateTree);

    const accountMeta = {
      treeInfo: {
        rootIndex: proofRpcResult.rootIndices[0],
        proveByIndex: false,
        merkleTreePubkeyIndex: merkleTreeIndex,
        queuePubkeyIndex: queueIndex,
        leafIndex: account!.leafIndex,
      },
      address: Array.from(gameAddress.toBytes()),
      outputStateTreeIndex,
    };

    const tx = await program.methods
      .joinGame(
        { 0: proofRpcResult.compressedProof },
        state,
        accountMeta,
        shipStartX,
        shipStartY,
        isHorizontal
      )
      .accounts({ signer: signerB.publicKey })
      .remainingAccounts(remainingAccounts.toAccountMetas().remainingAccounts)
      .signers([signerB])
      .transaction();

    tx.recentBlockhash = (await rpc.getRecentBlockhash()).blockhash;
    tx.sign(signerB);
    const sig = await rpc.sendTransaction(tx, [signerB]);
    await confirmTx(rpc, sig);
    console.log("Join Game TX:", sig);

    await rpc.confirmTransactionIndexed(await rpc.getSlot());

    // Verify State
    const updatedAccount = await rpc.getCompressedAccount(bn(gameAddress.toBytes()));
    const newState = decodeGameState(updatedAccount!.data!.data);

    assert.ok(newState.playerB.equals(signerB.publicKey));
    assert.strictEqual(newState.gameStatus, 1); // Active
    console.log("✅ Player B Joined. Game Active.");
  });

  it("3. Player A Attacks B (Hit)", async () => {
    // A attacks (4,0) -> Should hit B's ship
    const attackX = 4;
    const attackY = 0;

    const account = await rpc.getCompressedAccount(bn(gameAddress.toBytes()));
    const state = decodeGameState(account!.data!.data);

    const proofRpcResult = await rpc.getValidityProofV0(
      [{ hash: account!.hash, tree: account!.treeInfo.tree, queue: account!.treeInfo.queue }],
      []
    );

    const systemAccountConfig = new SystemAccountMetaConfig(program.programId);
    const remainingAccounts = new PackedAccounts();
    remainingAccounts.addSystemAccountsV2(systemAccountConfig);
    const merkleTreeIndex = remainingAccounts.insertOrGet(account!.treeInfo.tree);
    const queueIndex = remainingAccounts.insertOrGet(account!.treeInfo.queue);
    const outputStateTreeIndex = remainingAccounts.insertOrGet(outputStateTree);

    const accountMeta = {
      treeInfo: {
        rootIndex: proofRpcResult.rootIndices[0],
        proveByIndex: false,
        merkleTreePubkeyIndex: merkleTreeIndex,
        queuePubkeyIndex: queueIndex,
        leafIndex: account!.leafIndex,
      },
      address: Array.from(gameAddress.toBytes()),
      outputStateTreeIndex,
    };

    const tx = await program.methods
      .attack(
        { 0: proofRpcResult.compressedProof },
        state,
        accountMeta,
        attackX,
        attackY
      )
      .accounts({ signer: signerA.publicKey })
      .remainingAccounts(remainingAccounts.toAccountMetas().remainingAccounts)
      .signers([signerA])
      .transaction();

    tx.recentBlockhash = (await rpc.getRecentBlockhash()).blockhash;
    tx.sign(signerA);
    const sig = await rpc.sendTransaction(tx, [signerA]);
    await confirmTx(rpc, sig);
    console.log("Attack (A->B) TX:", sig);

    await rpc.confirmTransactionIndexed(await rpc.getSlot());

    const updatedAccount = await rpc.getCompressedAccount(bn(gameAddress.toBytes()));
    const newState = decodeGameState(updatedAccount!.data!.data);

    assert.strictEqual(newState.hitsB, 1);
    assert.strictEqual(newState.gridB[4], CELL_HIT); // (4,0) is index 4
    assert.strictEqual(newState.currentTurn, 2); // Switched to B
    console.log("✅ A Hit B. Turn Switched to B.");
  });

  it("4. Player B Attacks A (Miss)", async () => {
    // B attacks (4,4) -> Should miss A (A is at 0,0 - 3,0)
    const attackX = 4;
    const attackY = 4;

    const account = await rpc.getCompressedAccount(bn(gameAddress.toBytes()));
    const state = decodeGameState(account!.data!.data);

    const proofRpcResult = await rpc.getValidityProofV0(
      [{ hash: account!.hash, tree: account!.treeInfo.tree, queue: account!.treeInfo.queue }],
      []
    );

    const systemAccountConfig = new SystemAccountMetaConfig(program.programId);
    const remainingAccounts = new PackedAccounts();
    remainingAccounts.addSystemAccountsV2(systemAccountConfig);
    const merkleTreeIndex = remainingAccounts.insertOrGet(account!.treeInfo.tree);
    const queueIndex = remainingAccounts.insertOrGet(account!.treeInfo.queue);
    const outputStateTreeIndex = remainingAccounts.insertOrGet(outputStateTree);

    const accountMeta = {
      treeInfo: {
        rootIndex: proofRpcResult.rootIndices[0],
        proveByIndex: false,
        merkleTreePubkeyIndex: merkleTreeIndex,
        queuePubkeyIndex: queueIndex,
        leafIndex: account!.leafIndex,
      },
      address: Array.from(gameAddress.toBytes()),
      outputStateTreeIndex,
    };

    const tx = await program.methods
      .attack(
        { 0: proofRpcResult.compressedProof },
        state,
        accountMeta,
        attackX,
        attackY
      )
      .accounts({ signer: signerB.publicKey })
      .remainingAccounts(remainingAccounts.toAccountMetas().remainingAccounts)
      .signers([signerB])
      .transaction();

    tx.recentBlockhash = (await rpc.getRecentBlockhash()).blockhash;
    tx.sign(signerB);
    const sig = await rpc.sendTransaction(tx, [signerB]);
    await confirmTx(rpc, sig);
    console.log("Attack (B->A) TX:", sig);

    await rpc.confirmTransactionIndexed(await rpc.getSlot());

    const updatedAccount = await rpc.getCompressedAccount(bn(gameAddress.toBytes()));
    const newState = decodeGameState(updatedAccount!.data!.data);

    assert.strictEqual(newState.gridA[24], CELL_MISS); // (4,4) is index 24
    assert.strictEqual(newState.currentTurn, 1); // Switched to A
    console.log("✅ B Missed A. Turn Switched to A.");
  });

  it("5. Player A Sinks B (Game Over)", async () => {
    // Ships at (4,0), (4,1), (4,2), (4,3)
    // A already hit (4,0)
    // Remaining targets: (4,1), (4,2), (4,3)
    const targets = [[4, 1], [4, 2], [4, 3]];

    for (let i = 0; i < targets.length; i++) {
      const [targetX, targetY] = targets[i];

      // 1. Player A Attacks (Hit)
      let account = await rpc.getCompressedAccount(bn(gameAddress.toBytes()));
      let state = decodeGameState(account!.data!.data);

      let proofRpcResult = await rpc.getValidityProofV0(
        [{ hash: account!.hash, tree: account!.treeInfo.tree, queue: account!.treeInfo.queue }],
        []
      );
      let systemAccountConfig = new SystemAccountMetaConfig(program.programId);
      let remainingAccounts = new PackedAccounts();
      remainingAccounts.addSystemAccountsV2(systemAccountConfig);
      let merkleTreeIndex = remainingAccounts.insertOrGet(account!.treeInfo.tree);
      let queueIndex = remainingAccounts.insertOrGet(account!.treeInfo.queue);
      let outputStateTreeIndex = remainingAccounts.insertOrGet(outputStateTree);
      let accountMeta = {
        treeInfo: {
          rootIndex: proofRpcResult.rootIndices[0],
          proveByIndex: false,
          merkleTreePubkeyIndex: merkleTreeIndex,
          queuePubkeyIndex: queueIndex,
          leafIndex: account!.leafIndex,
        },
        address: Array.from(gameAddress.toBytes()),
        outputStateTreeIndex,
      };

      let tx = await program.methods
        .attack(
          { 0: proofRpcResult.compressedProof },
          state,
          accountMeta,
          targetX,
          targetY
        )
        .accounts({ signer: signerA.publicKey })
        .remainingAccounts(remainingAccounts.toAccountMetas().remainingAccounts)
        .signers([signerA])
        .transaction();

      tx.recentBlockhash = (await rpc.getRecentBlockhash()).blockhash;
      tx.sign(signerA);
      let sig = await rpc.sendTransaction(tx, [signerA]);
      await confirmTx(rpc, sig);
      await rpc.confirmTransactionIndexed(await rpc.getSlot());

      // If this was the last hit, check Game Over
      if (i === targets.length - 1) {
        const finalAccount = await rpc.getCompressedAccount(bn(gameAddress.toBytes()));
        const finalState = decodeGameState(finalAccount!.data!.data);
        assert.strictEqual(finalState.gameStatus, 2); // 2 = A Won
        console.log("🎉 Player A Wins! Game Status = 2");
        return; // Done
      }

      // 2. Player B Attacks (Miss) - to give turn back to A
      const missX = i + 1;
      const missY = 4;

      account = await rpc.getCompressedAccount(bn(gameAddress.toBytes()));
      state = decodeGameState(account!.data!.data);

      proofRpcResult = await rpc.getValidityProofV0(
        [{ hash: account!.hash, tree: account!.treeInfo.tree, queue: account!.treeInfo.queue }],
        []
      );
      systemAccountConfig = new SystemAccountMetaConfig(program.programId);
      remainingAccounts = new PackedAccounts();
      remainingAccounts.addSystemAccountsV2(systemAccountConfig);
      merkleTreeIndex = remainingAccounts.insertOrGet(account!.treeInfo.tree);
      queueIndex = remainingAccounts.insertOrGet(account!.treeInfo.queue);
      outputStateTreeIndex = remainingAccounts.insertOrGet(outputStateTree);
      accountMeta = {
        treeInfo: {
          rootIndex: proofRpcResult.rootIndices[0],
          proveByIndex: false,
          merkleTreePubkeyIndex: merkleTreeIndex,
          queuePubkeyIndex: queueIndex,
          leafIndex: account!.leafIndex,
        },
        address: Array.from(gameAddress.toBytes()),
        outputStateTreeIndex,
      };

      tx = await program.methods
        .attack(
          { 0: proofRpcResult.compressedProof },
          state,
          accountMeta,
          missX,
          missY
        )
        .accounts({ signer: signerB.publicKey })
        .remainingAccounts(remainingAccounts.toAccountMetas().remainingAccounts)
        .signers([signerB])
        .transaction();

      tx.recentBlockhash = (await rpc.getRecentBlockhash()).blockhash;
      tx.sign(signerB);
      sig = await rpc.sendTransaction(tx, [signerB]);
      await confirmTx(rpc, sig);
      await rpc.confirmTransactionIndexed(await rpc.getSlot());
    }
  });
});
