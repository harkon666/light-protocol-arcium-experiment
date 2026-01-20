import * as anchor from "@coral-xyz/anchor";
import { Program, web3 } from "@coral-xyz/anchor";
import { Update } from "../target/types/update";
import idl from "../target/idl/update.json";
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

describe("zkcompress", () => {
  const program = anchor.workspace.Update as Program<Update>;
  const coder = new anchor.BorshCoder(idl as anchor.Idl);

  // Shared state across tests
  let signer: web3.Keypair;
  let rpc: Rpc;
  let outputStateTree: web3.PublicKey;
  let addressTree: web3.PublicKey;
  let address: web3.PublicKey;

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

    // Derive address
    const messageSeed = new TextEncoder().encode("message");
    const seed = deriveAddressSeedV2([messageSeed, signer.publicKey.toBytes()]);
    address = deriveAddressV2(seed, addressTree, new web3.PublicKey(program.idl.address));
  });

  // ===============================
  // TEST 1: Create Compressed Account
  // ===============================
  it("1. create compressed account", async () => {
    const message = "Hello, compressed world!";

    const proofRpcResult = await rpc.getValidityProofV0(
      [],
      [{ tree: addressTree, queue: addressTree, address: bn(address.toBytes()) }]
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
      .createAccount(proof, packedAddressTreeInfo, outputStateTreeIndex, message)
      .accounts({ signer: signer.publicKey })
      .preInstructions([computeBudgetIx])
      .remainingAccounts(remainingAccounts.toAccountMetas().remainingAccounts)
      .signers([signer])
      .transaction();

    tx.recentBlockhash = (await rpc.getRecentBlockhash()).blockhash;
    tx.sign(signer);
    const sig = await rpc.sendTransaction(tx, [signer]);
    await confirmTx(rpc, sig);
    console.log("Create TX:", sig);

    // Wait for indexer
    const slot = await rpc.getSlot();
    await rpc.confirmTransactionIndexed(slot);

    const compressedAccount = await rpc.getCompressedAccount(bn(address.toBytes()));
    const decoded = coder.types.decode("MyCompressedAccount", compressedAccount!.data!.data);

    assert.ok(decoded.owner.equals(signer.publicKey), "Owner should match");
    assert.strictEqual(decoded.message, message, "Message should match");
    console.log("✅ Created account with message:", decoded.message);
  });

  // ===============================
  // TEST 2: Update Compressed Account
  // ===============================
  it("2. update compressed account", async () => {
    const newMessage = "Updated message!";

    // Fetch current account
    const compressedAccount = await rpc.getCompressedAccount(bn(address.toBytes()));
    const currentAccount = coder.types.decode("MyCompressedAccount", compressedAccount!.data!.data);

    // Get validity proof using treeInfo
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
      address: Array.from(address.toBytes()),
      outputStateTreeIndex,
    };

    const proof = { 0: proofRpcResult.compressedProof };
    const computeBudgetIx = web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1000000 });

    const tx = await program.methods
      .updateAccount(proof, currentAccount, accountMeta, newMessage)
      .accounts({ signer: signer.publicKey })
      .preInstructions([computeBudgetIx])
      .remainingAccounts(remainingAccounts.toAccountMetas().remainingAccounts)
      .signers([signer])
      .transaction();

    tx.recentBlockhash = (await rpc.getRecentBlockhash()).blockhash;
    tx.sign(signer);
    const sig = await rpc.sendTransaction(tx, [signer]);
    await confirmTx(rpc, sig);
    console.log("Update TX:", sig);

    // Wait for indexer
    const slot = await rpc.getSlot();
    await rpc.confirmTransactionIndexed(slot);

    const updatedAccount = await rpc.getCompressedAccount(bn(address.toBytes()));
    const decoded = coder.types.decode("MyCompressedAccount", updatedAccount!.data!.data);

    assert.strictEqual(decoded.message, newMessage, "Message should be updated");
    console.log("✅ Updated account message to:", decoded.message);
  });

  // ===============================
  // TEST 3: Close Compressed Account
  // ===============================
  it("3. close compressed account", async () => {
    // Fetch current account
    const compressedAccount = await rpc.getCompressedAccount(bn(address.toBytes()));
    const decoded = coder.types.decode("MyCompressedAccount", compressedAccount!.data!.data);
    const currentMessage = decoded.message;

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
      address: Array.from(address.toBytes()),
      outputStateTreeIndex,
    };

    const proof = { 0: proofRpcResult.compressedProof };
    const computeBudgetIx = web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1000000 });

    const tx = await program.methods
      .closeAccount(proof, accountMeta, currentMessage)
      .accounts({ signer: signer.publicKey })
      .preInstructions([computeBudgetIx])
      .remainingAccounts(remainingAccounts.toAccountMetas().remainingAccounts)
      .signers([signer])
      .transaction();

    tx.recentBlockhash = (await rpc.getRecentBlockhash()).blockhash;
    tx.sign(signer);
    const sig = await rpc.sendTransaction(tx, [signer]);
    await confirmTx(rpc, sig);
    console.log("Close TX:", sig);

    // Wait for indexer
    const slot = await rpc.getSlot();
    await rpc.confirmTransactionIndexed(slot);

    console.log("✅ Closed compressed account");
  });

  // ===============================
  // TEST 4: Reinitialize Compressed Account
  // ===============================
  it("4. reinitialize compressed account", async () => {
    // Fetch the closed account
    const compressedAccount = await rpc.getCompressedAccount(bn(address.toBytes()));

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
      address: Array.from(address.toBytes()),
      outputStateTreeIndex,
    };

    const proof = { 0: proofRpcResult.compressedProof };
    const computeBudgetIx = web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1000000 });

    const tx = await program.methods
      .reinitAccount(proof, accountMeta)
      .accounts({ signer: signer.publicKey })
      .preInstructions([computeBudgetIx])
      .remainingAccounts(remainingAccounts.toAccountMetas().remainingAccounts)
      .signers([signer])
      .transaction();

    tx.recentBlockhash = (await rpc.getRecentBlockhash()).blockhash;
    tx.sign(signer);
    const sig = await rpc.sendTransaction(tx, [signer]);
    await confirmTx(rpc, sig);
    console.log("Reinit TX:", sig);

    // Wait for indexer
    const slot = await rpc.getSlot();
    await rpc.confirmTransactionIndexed(slot);

    console.log("✅ Reinitialized compressed account");
  });

  // ===============================
  // TEST 5: Burn Compressed Account (Permanent Delete)
  // ===============================
  it("5. burn compressed account", async () => {
    // Create a new signer for burn test
    const burnSigner = new web3.Keypair();
    await rpc.requestAirdrop(burnSigner.publicKey, web3.LAMPORTS_PER_SOL);
    await sleep(2000);

    // Derive new address for burn test
    const messageSeed = new TextEncoder().encode("message");
    const seed = deriveAddressSeedV2([messageSeed, burnSigner.publicKey.toBytes()]);
    const burnAddress = deriveAddressV2(seed, addressTree, new web3.PublicKey(program.idl.address));
    const burnMessage = "Account to be burned";

    // First create the account
    const createProof = await rpc.getValidityProofV0(
      [],
      [{ tree: addressTree, queue: addressTree, address: bn(burnAddress.toBytes()) }]
    );

    const createSystemConfig = new SystemAccountMetaConfig(program.programId);
    const createRemaining = new PackedAccounts();
    createRemaining.addSystemAccountsV2(createSystemConfig);

    const createAddrIdx = createRemaining.insertOrGet(addressTree);
    const createTreeIdx = createRemaining.insertOrGet(outputStateTree);

    const createTx = await program.methods
      .createAccount(
        { 0: createProof.compressedProof },
        { rootIndex: createProof.rootIndices[0], addressMerkleTreePubkeyIndex: createAddrIdx, addressQueuePubkeyIndex: createAddrIdx },
        createTreeIdx,
        burnMessage
      )
      .accounts({ signer: burnSigner.publicKey })
      .preInstructions([web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1000000 })])
      .remainingAccounts(createRemaining.toAccountMetas().remainingAccounts)
      .signers([burnSigner])
      .transaction();

    createTx.recentBlockhash = (await rpc.getRecentBlockhash()).blockhash;
    createTx.sign(burnSigner);
    const createSig = await rpc.sendTransaction(createTx, [burnSigner]);
    await confirmTx(rpc, createSig);
    console.log("Burn test - Create TX:", createSig);

    // Wait for indexer
    await sleep(2000);
    let slot = await rpc.getSlot();
    await rpc.confirmTransactionIndexed(slot);

    // Now burn it
    const compressedAccount = await rpc.getCompressedAccount(bn(burnAddress.toBytes()));

    const burnProof = await rpc.getValidityProofV0(
      [{
        hash: compressedAccount!.hash,
        tree: compressedAccount!.treeInfo.tree,
        queue: compressedAccount!.treeInfo.queue
      }],
      []
    );

    const burnSystemConfig = new SystemAccountMetaConfig(program.programId);
    const burnRemaining = new PackedAccounts();
    burnRemaining.addSystemAccountsV2(burnSystemConfig);

    const merkleTreeIndex = burnRemaining.insertOrGet(compressedAccount!.treeInfo.tree);
    const queueIndex = burnRemaining.insertOrGet(compressedAccount!.treeInfo.queue);

    // CompressedAccountMetaReadOnly (no outputStateTreeIndex)
    const burnAccountMeta = {
      treeInfo: {
        rootIndex: burnProof.rootIndices[0],
        proveByIndex: false,
        merkleTreePubkeyIndex: merkleTreeIndex,
        queuePubkeyIndex: queueIndex,
        leafIndex: compressedAccount!.leafIndex,
      },
      address: Array.from(burnAddress.toBytes()),
    };

    const burnTx = await program.methods
      .burnAccount({ 0: burnProof.compressedProof }, burnAccountMeta, burnMessage)
      .accounts({ signer: burnSigner.publicKey })
      .preInstructions([web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1000000 })])
      .remainingAccounts(burnRemaining.toAccountMetas().remainingAccounts)
      .signers([burnSigner])
      .transaction();

    burnTx.recentBlockhash = (await rpc.getRecentBlockhash()).blockhash;
    burnTx.sign(burnSigner);
    const sig = await rpc.sendTransaction(burnTx, [burnSigner]);
    await confirmTx(rpc, sig);
    console.log("Burn TX:", sig);

    console.log("✅ Burned compressed account permanently");
  });
});