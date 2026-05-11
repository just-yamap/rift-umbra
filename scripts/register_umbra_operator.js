#!/usr/bin/env node
/**
 * Register the RIFT operator wallet in the Umbra protocol.
 * Idempotent — safe to run multiple times.
 *
 * Usage: cd ~/rift-solana/backend && node --env-file=.env scripts/register_umbra_operator.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { Connection, Keypair } = require('@solana/web3.js');

async function main() {
  const SDK = require('@umbra-privacy/sdk');

  // Load operator keypair
  const kpPath = process.env.ANCHOR_WALLET || process.env.OPERATOR_KEYPAIR_PATH;
  if (!kpPath) {
    console.error('ERROR: set ANCHOR_WALLET or OPERATOR_KEYPAIR_PATH env var pointing to your operator keypair.json');
    process.exit(1);
  }
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(kpPath, 'utf8'))));
  console.log(`Operator: ${kp.publicKey.toBase58()}`);

  // Build signer using our wrapper (handles async + full 64-byte key)
  const umbra = require(path.join(__dirname, '..', 'integrations', 'umbra.js'));
  const rpcUrl = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');
  const signingWallet = {
    get publicKey() { return kp.publicKey; },
    signTransaction: async (tx) => { tx.partialSign(kp); return tx; },
    _keypair: kp,
  };

  console.log(`RPC: ${rpcUrl}`);
  console.log('Initializing Umbra client...');
  const { client } = await umbra.initClient({ connection, operatorSigner: signingWallet });

  // Step 1: Check if already registered
  console.log('\nChecking registration status...');
  try {
    const queryUserAccount = SDK.getQueryUserAccountFunction({ client }, {});
    const account = await queryUserAccount();
    if (account) {
      console.log('✅ Already registered!');
      console.log('  confidentialEnabled:', !!account.x25519PublicKey);
      console.log('  anonymousEnabled:', !!account.userCommitment);
      if (account.x25519PublicKey && account.userCommitment) {
        console.log('  Both modes active — nothing to do.');
        return;
      }
    }
  } catch (e) {
    // Not registered yet, or query format different — proceed to register
    console.log(`  Not registered yet (${e.message.slice(0, 80)})`);
  }

  // Step 2: Register — confidential first (no ZK prover needed)
  console.log('\nRegistering (confidential=true, anonymous=false)...');
  const register = SDK.getUserRegistrationFunction({ client });
  const sigs = await register({ confidential: true, anonymous: false });
  console.log(`✅ Registration complete! TX signatures:`);
  if (Array.isArray(sigs)) {
    sigs.forEach((s, i) => console.log(`  [${i}] ${s}`));
  } else {
    console.log(`  ${JSON.stringify(sigs)}`);
  }

  // Step 3: Now register anonymous mode (needs ZK prover)
  console.log('\nRegistering anonymous mode (needs ZK prover)...');
  try {
    const { getUserRegistrationProver } = require('@umbra-privacy/web-zk-prover');
    const zkProver = getUserRegistrationProver();
    const registerAnon = SDK.getUserRegistrationFunction({ client }, { zkProver });
    const anonSigs = await registerAnon({ confidential: false, anonymous: true });
    console.log('✅ Anonymous mode registered!');
    if (Array.isArray(anonSigs)) {
      anonSigs.forEach((s, i) => console.log(`  [${i}] ${s}`));
    } else {
      console.log(`  ${JSON.stringify(anonSigs)}`);
    }
  } catch (e) {
    console.warn(`⚠️  Anonymous mode registration failed (non-blocking): ${e.message}`);
    console.warn('   The operator can still use confidential mode. Anonymous mode is optional for the demo.');
  }

  console.log('\nDone.');
}

main().catch(e => {
  console.error(`FATAL: ${e.message}`);
  console.error('Stack:', e.stack);
  process.exit(1);
});
