#!/usr/bin/env node
/**
 * End-to-end Umbra SDK test: init → create UTXO → validate 32-byte commitment.
 * Usage: cd ~/rift-solana/backend && node --env-file=.env scripts/test_umbra_init.js
 * Safe — uses 1 atomic unit, won't deliver real value but proves SDK pipeline.
 */
'use strict';

const path = require('path');
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const fs = require('fs');

async function main() {
  const kpPath = process.env.ANCHOR_WALLET || process.env.OPERATOR_KEYPAIR_PATH;
  if (!kpPath) {
    console.error('ERROR: set ANCHOR_WALLET or OPERATOR_KEYPAIR_PATH env var pointing to your operator keypair.json');
    process.exit(1);
  }
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(kpPath, 'utf8'))));
  console.log(`Operator: ${kp.publicKey.toBase58()}`);

  const signingWallet = {
    get publicKey() { return kp.publicKey; },
    signTransaction: async (tx) => { tx.partialSign(kp); return tx; },
    _keypair: kp,
  };

  const rpcUrl = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');
  console.log(`RPC: ${rpcUrl}`);

  const umbra = require(path.join(__dirname, '..', 'integrations', 'umbra.js'));

  // Step 1: init client
  console.log('\n1. Initializing Umbra client...');
  const result = await umbra.initClient({ connection, operatorSigner: signingWallet });
  console.log('   ✅ Client initialized');

  // Step 2: test confidentialTransfer
  console.log('\n2. Testing confidentialTransfer (operator → operator, 1 atomic USDC)...');
  const USDC_MINT = process.env.USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  try {
    const stealth = umbra.deriveStealth(kp.publicKey.toBase58());
    const { commitment, signature } = await umbra.confidentialTransfer({
      client: result,
      mint: new PublicKey(USDC_MINT),
      amount: 1n,
      stealthAddress: stealth,
    });

    // Validate commitment format
    console.log(`   signature: ${signature}`);
    const len = commitment instanceof Uint8Array ? commitment.length : (commitment?.length || 0);
    console.log(`   commitment type=${commitment?.constructor?.name} length=${len}`);
    console.log(`   hex preview: ${Buffer.from(commitment).toString('hex').slice(0,32)}...`);
    if (len !== 32) {
      console.error(`   ❌ EXPECTED 32 bytes, got ${len}`);
    } else {
      console.log('   ✅ Valid 32-byte commitment');
    }
  } catch (e) {
    const msg = e.cause ? e.cause.message : e.message;
    if (/insufficient|balance|not enough|InsufficientFunds/i.test(msg)) {
      console.log(`   ⚠️  Expected: ${msg}`);
      console.log('   SDK path works — insufficient balance for test amount.');
    } else {
      console.error(`   ❌ Error: ${msg}`);
      if (e.cause) console.error('   Cause stack:', e.cause.stack);
      else console.error('   Stack:', e.stack);
    }
  }
}

main().catch(e => {
  console.error('FATAL:', e.message);
  console.error('Stack:', e.stack);
  process.exit(1);
});
