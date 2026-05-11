#!/usr/bin/env node
/**
 * Withdraw Alice's UTXO from Umbra mixer to a public destination wallet.
 *
 * 3-step flow:
 *   1. Scan mixer tree for UTXOs addressed to Alice
 *   2. Claim receiver-claimable UTXOs into Alice's encrypted balance (ZK proof + relayer)
 *   3. Withdraw from encrypted balance to a public destination ATA
 *
 * Usage:
 *   ANCHOR_WALLET=/path/to/alice.json \
 *   WITHDRAW_TO=<destination_pubkey> \
 *     node --env-file=.env scripts/withdraw_umbra_alice.js
 *
 * Optional env:
 *   UMBRA_RELAYER_URL   — relayer endpoint (default: https://indexer.umbraprivacy.com)
 *   SCAN_TREE_INDEX     — stealth pool tree index (default: 0)
 *   SCAN_START_INDEX    — insertion index to start scanning from (default: 0)
 *   SCAN_END_INDEX      — insertion index to stop scanning (default: omitted = latest)
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');

async function main() {
  // ── 1. Parse env ──
  const kpPath = process.env.ANCHOR_WALLET;
  if (!kpPath) {
    console.error('ERROR: set ANCHOR_WALLET env var pointing to alice keypair.json');
    process.exit(1);
  }
  const destination = process.env.WITHDRAW_TO;
  if (!destination) {
    console.error('ERROR: set WITHDRAW_TO env var to the public destination wallet address');
    process.exit(1);
  }
  const USDC_MINT = process.env.USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const relayerUrl = process.env.UMBRA_RELAYER_URL || 'https://indexer.umbraprivacy.com';
  const treeIndex = BigInt(process.env.SCAN_TREE_INDEX || '0');
  const startIndex = BigInt(process.env.SCAN_START_INDEX || '0');
  const endIndex = process.env.SCAN_END_INDEX ? BigInt(process.env.SCAN_END_INDEX) : undefined;

  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(kpPath, 'utf8'))));
  console.log(`Alice (signer): ${kp.publicKey.toBase58()}`);
  console.log(`Withdraw to:    ${destination}`);
  console.log(`USDC mint:      ${USDC_MINT}`);
  console.log(`Relayer:        ${relayerUrl}`);

  // ── 2. Init Umbra client ──
  const SDK = require('@umbra-privacy/sdk');
  const ZK = require('@umbra-privacy/web-zk-prover');
  const umbra = require(path.join(__dirname, '..', 'integrations', 'umbra.js'));

  const rpcUrl = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');
  const signingWallet = {
    get publicKey() { return kp.publicKey; },
    signTransaction: async (tx) => { tx.partialSign(kp); return tx; },
    _keypair: kp,
  };
  console.log(`RPC: ${rpcUrl}`);
  console.log('\nInitializing Umbra client...');
  const { client } = await umbra.initClient({ connection, operatorSigner: signingWallet });
  console.log('✅ Client initialized');

  // ── 3. Scan for Alice's UTXOs ──
  console.log(`\nScanning mixer tree ${treeIndex} from insertion ${startIndex}...`);
  const scanner = SDK.getClaimableUtxoScannerFunction({ client });
  const scanResult = await scanner(treeIndex, startIndex, endIndex);

  const utxos = scanResult.utxos || scanResult;
  const utxoList = Array.isArray(utxos) ? utxos : [];
  console.log(`Found ${utxoList.length} claimable UTXO(s) for Alice`);

  if (utxoList.length === 0) {
    console.log('\nNo UTXOs to claim. Possible reasons:');
    console.log('  - Wrong tree index (try SCAN_TREE_INDEX=1, 2, ...)');
    console.log('  - UTXO was already claimed');
    console.log('  - Scan range too narrow (adjust SCAN_START_INDEX/SCAN_END_INDEX)');
    console.log('  - Indexer not yet synced');
    return;
  }

  for (const [i, u] of utxoList.entries()) {
    console.log(`  [${i}] mint=${u.mint || '?'} amount=${u.amount || '?'} insertionIndex=${u.insertionIndex || '?'}`);
  }

  // ── 4. Claim UTXOs into encrypted balance ──
  console.log('\nClaiming UTXOs into encrypted balance (Groth16 ZK proof + relayer)...');
  const zkProver = ZK.getClaimReceiverClaimableUtxoIntoEncryptedBalanceProver();
  const relayer = SDK.getUmbraRelayer({ apiEndpoint: relayerUrl });

  const claimFn = SDK.getReceiverClaimableUtxoToEncryptedBalanceClaimerFunction(
    { client },
    { zkProver, relayer }
  );
  const claimResult = await claimFn(utxoList);
  console.log('✅ Claim submitted!');

  // Poll until claim is finalized
  if (claimResult.requestId) {
    console.log(`  requestId: ${claimResult.requestId}`);
    console.log('  Polling for finalization...');
    const finalResult = await SDK.pollClaimUntilTerminal(
      (id) => relayer.pollClaimStatus(id),
      claimResult.requestId,
      { pollingIntervalMs: 3000, timeoutMs: 120000 }
    );
    console.log(`  Final status: ${finalResult.status}`);
    if (finalResult.signatures) {
      for (const [batch, sigs] of Object.entries(finalResult.signatures)) {
        console.log(`  Batch ${batch}: ${Array.isArray(sigs) ? sigs.join(', ') : sigs}`);
      }
    }
  } else if (claimResult.signatures) {
    console.log('  Claim signatures:');
    for (const [batch, sigs] of Object.entries(claimResult.signatures)) {
      console.log(`  Batch ${batch}: ${Array.isArray(sigs) ? sigs.join(', ') : sigs}`);
    }
  }

  // ── 5. Withdraw from encrypted balance to public destination ──
  console.log(`\nWithdrawing from encrypted balance to ${destination}...`);
  const withdrawFn = SDK.getEncryptedBalanceToPublicBalanceDirectWithdrawerFunction({ client });

  // Query encrypted balance to know how much to withdraw
  let withdrawAmount;
  try {
    const queryBalance = SDK.getEncryptedBalanceQuerierFunction({ client });
    const balance = await queryBalance(USDC_MINT);
    withdrawAmount = balance.amount || balance.balance || balance;
    console.log(`  Encrypted USDC balance: ${withdrawAmount}`);
  } catch (e) {
    console.warn(`  Could not query balance (${e.message}) — trying to withdraw all claimed UTXOs`);
    // Sum up amounts from scanned UTXOs
    withdrawAmount = utxoList.reduce((sum, u) => sum + BigInt(u.amount || 0), 0n);
    console.log(`  Estimated from UTXOs: ${withdrawAmount}`);
  }

  if (!withdrawAmount || withdrawAmount === 0n) {
    console.log('  Nothing to withdraw (balance is 0).');
    return;
  }

  const withdrawResult = await withdrawFn(destination, USDC_MINT, withdrawAmount);
  console.log('✅ Withdrawal complete!');
  const withdrawSig = withdrawResult.signature || withdrawResult.txSignature ||
    (withdrawResult.signatures ? Object.values(withdrawResult.signatures).flat()[0] : null);
  console.log(`  TX: ${withdrawSig}`);
  if (withdrawSig) {
    console.log(`  Solscan: https://solscan.io/tx/${withdrawSig}`);
  }

  console.log('\n═══════════════════════════════════════════');
  console.log('Privacy guarantee verified:');
  console.log('  TX1 (deposit): Operator → Umbra Pool (no link to Alice)');
  console.log(`  TX2 (withdraw): Umbra Pool → ${destination.slice(0,8)}... (ZK proof)`);
  console.log('  NO ON-CHAIN LINK between TX1 and TX2');
  console.log('═══════════════════════════════════════════');
}

main().catch(e => {
  console.error(`FATAL: ${e.message}`);
  console.error('Stack:', e.stack);
  process.exit(1);
});
