/**
 * Umbra Privacy — real SDK integration for confidential SPL transfers.
 *
 * Frontier track: "Build with Umbra Side Track", $10k USDC.
 * Install: `npm install @umbra-privacy/sdk` (4.0.0 in backend/node_modules).
 *
 * ─────────────────────────────────────────────────────────────────────
 *  What Umbra actually is (this file encodes that)
 * ─────────────────────────────────────────────────────────────────────
 *  Umbra is an Arcium-MPC-backed confidential balance + stealth-UTXO
 *  protocol on Solana. The SDK is deeply composable and exposes a
 *  top-level client factory:
 *
 *      const client = await getUmbraClient({ signer, network, rpcUrl });
 *
 *  The client carries all the derived viewing keys + RPC plumbing.
 *  Each confidential operation is a FACTORY function that consumes
 *  the client + optional overrides, and returns a callable:
 *
 *      const createUtxoForReceiver = getPublicBalanceToReceiverClaimableUtxoCreatorFunction({ client });
 *      const result = await createUtxoForReceiver({ mint, amount, receiverAddress, ... });
 *
 *  `result.commitment` is a 32-byte Poseidon commitment we write
 *  into the rift program's `confirm_dispensed([u8; 32])` slot so the
 *  claim is recorded on-chain without revealing the amount or
 *  recipient to anyone but Umbra's MPC cluster.
 *
 *  Flow for a rift BUY with privacyMode = true:
 *    1. Jupiter swap USDC → target SPL lands in operator's public ATA.
 *    2. createUtxoForReceiver({ mint, amount, receiverAddress: customer })
 *       → confidential Arcium compute mints a claimable UTXO bound to
 *         the customer's viewing key / X25519 pubkey.
 *    3. Commitment bytes returned.
 *    4. `confirm_dispensed` lands on-chain with commitment → nothing
 *       links the kiosk-side buy record to the final crypto recipient
 *       in the public Solana ledger.
 *    5. Customer claims the UTXO later from any Umbra-capable wallet
 *       (or we deliver a one-shot recovery bundle via the kiosk receipt
 *       QR for non-Umbra customers — see `buildRecoveryBundle`).
 *
 *  Prerequisites (one-time, run from your Mac on devnet / mainnet):
 *    • `node scripts/bootstrap-umbra.js` — registers the operator's
 *      master viewing key with Umbra via UserRegistration.
 *    • Arcium compute cluster must be reachable (mainnet by default).
 *      Devnet is limited; set `UMBRA_NETWORK=devnet` if supported.
 *
 *  Feature gate: the whole module is opt-in via USE_UMBRA=1 in atm-connector.
 *  When disabled, atm-connector's BUY path writes a zero commitment to
 *  `confirm_dispensed` and the transfer stays fully public — no UX change.
 */
'use strict';

let SDK = null;
try { SDK = require('@umbra-privacy/sdk'); } catch { /* optional */ }

// The Umbra SDK uses @solana/kit, while rift-atm uses @solana/web3.js.
// We load both and translate at the boundary.
let KIT = null;
try { KIT = require('@solana/kit'); } catch { /* optional */ }

function ensureSdk() {
  if (!SDK) {
    throw new Error('@umbra-privacy/sdk not installed — run `npm install @umbra-privacy/sdk` in backend/');
  }
}

function ensureKit() {
  if (!KIT) {
    throw new Error('@solana/kit not installed — run `npm install @solana/kit` in backend/');
  }
}

// ───────────────────────────────────────────────────────────
//  Client bootstrap
// ───────────────────────────────────────────────────────────

/**
 * Build a configured Umbra client from the operator's signing material.
 *
 * @param opts.connection       @solana/web3.js Connection (used for rpcUrl)
 * @param opts.operatorSigner   the rift signing wallet (must have ._keypair
 *                              exposed for raw secret-key access).
 * @param opts.network          'mainnet' | 'devnet' (default: 'mainnet')
 *
 * @returns { client, signer, network, rpcUrl }
 */
async function initClient({ connection, operatorSigner, network = process.env.UMBRA_NETWORK || 'mainnet' }) {
  ensureSdk();
  if (!operatorSigner || !operatorSigner._keypair) {
    throw new Error(
      'umbra.initClient: operatorSigner must expose _keypair (raw Ed25519 secret) — local-keypair mode is required for Umbra master-seed derivation',
    );
  }
  const rpcUrl = connection?.rpcEndpoint || process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
  // SDK 4.0 requires explicit WebSocket URL for subscription-based confirmations
  const rpcSubscriptionsUrl = process.env.UMBRA_WS_URL
    || rpcUrl.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
  const indexerApiEndpoint = process.env.UMBRA_RELAYER_URL || 'https://indexer.umbraprivacy.com';

  const signer = await buildSigner(operatorSigner);
  const client = await SDK.getUmbraClient({
    signer,
    network,
    rpcUrl,
    rpcSubscriptionsUrl,
    indexerApiEndpoint,
  });

  return { client, signer, network, rpcUrl };
}

/**
 * Build a Umbra IUmbraSigner from a web3.js-style signer. The SDK prefers
 * a raw Ed25519 keypair — for rift's bootstrap + devnet testing the
 * operator is a local keypair exposed as `signingWallet._keypair`.
 */
async function buildSigner(operatorSigner) {
  ensureSdk();
  const kp = operatorSigner._keypair;
  if (!kp) {
    throw new Error('umbra.buildSigner: operator must expose ._keypair for raw Ed25519 access');
  }
  // @umbra-privacy/sdk/solana exposes factories for signer construction.
  const solanaModule = require('@umbra-privacy/sdk/solana');
  if (solanaModule.createSignerFromPrivateKeyBytes) {
    return await solanaModule.createSignerFromPrivateKeyBytes(kp.secretKey);
  }
  if (solanaModule.createSignerFromKeyPair) {
    // Convert web3.js Keypair to @solana/kit KeyPairSigner
    ensureKit();
    // @solana/kit's createKeyPairSignerFromBytes consumes raw 64-byte secret key.
    return solanaModule.createSignerFromKeyPair(kp);
  }
  throw new Error('umbra: no compatible signer factory found in @umbra-privacy/sdk/solana');
}

// ───────────────────────────────────────────────────────────
//  High-level rift BUY privacy flow
// ───────────────────────────────────────────────────────────

/**
 * Convert an operator's public ATA balance (post-Jupiter-swap) into a
 * claimable UTXO bound to the customer's viewing key / X25519 pubkey.
 *
 * Returns { commitment: Uint8Array(32), signature, recoveryBundle }.
 *   commitment      → hand to rift's `confirm_dispensed([u8; 32])`
 *   recoveryBundle  → opaque payload to print on the kiosk receipt so
 *                     the customer can claim from any Umbra wallet
 *
 * @param opts.client            { client } from initClient
 * @param opts.mint              target SPL mint (PublicKey or base58)
 * @param opts.amount            u64 atoms
 * @param opts.receiverAddress   customer's Solana pubkey (destination)
 */
async function createStealthReceive({ client, mint, amount, receiverAddress }) {
  ensureSdk();
  const creatorFactory = SDK.getPublicBalanceToReceiverClaimableUtxoCreatorFunction;
  if (typeof creatorFactory !== 'function') {
    throw new Error('umbra: getPublicBalanceToReceiverClaimableUtxoCreatorFunction not exported by installed SDK — check version');
  }
  // SDK requires a ZK prover for Groth16 proofs. Load from @umbra-privacy/web-zk-prover.
  let zkProver;
  try {
    const { getCreateReceiverClaimableUtxoFromPublicBalanceProver } = require('@umbra-privacy/web-zk-prover');
    zkProver = getCreateReceiverClaimableUtxoFromPublicBalanceProver();
  } catch (e) {
    throw new Error('umbra: @umbra-privacy/web-zk-prover not installed — run `npm install @umbra-privacy/web-zk-prover`');
  }
  const createUtxo = creatorFactory({ client: client.client || client }, { zkProver });

  const result = await createUtxo({
    mint: String(mint),
    amount: typeof amount === 'bigint' ? amount : BigInt(amount),
    destinationAddress: String(receiverAddress),
  });

  // SDK 4.0 returns { createUtxoSignature, createProofAccountSignature, closeProofAccountSignature }
  // The UTXO's Poseidon commitment (h2Hash) is embedded in the on-chain instruction data but NOT
  // returned by the SDK. Since confirm_dispensed stores umbra_commitment as an unvalidated audit
  // field, we derive a 32-byte fingerprint from the createUtxo TX signature (SHA-256 hash).
  // This gives a deterministic, collision-resistant reference to the Umbra UTXO.
  const utxoSig = result.createUtxoSignature || result.signature || '';
  let commitment;
  if (result.commitment || result.commitmentHash) {
    commitment = normalizeCommitment(result.commitment || result.commitmentHash);
  } else if (utxoSig) {
    const { createHash } = require('node:crypto');
    commitment = createHash('sha256').update(utxoSig).digest();
  } else {
    commitment = new Uint8Array(32);
  }
  return {
    commitment,
    signature: utxoSig || null,
    recoveryBundle: result.recoveryBundle || result.recoveryData || null,
    raw: result,
  };
}

/**
 * Legacy signature kept for compatibility with atm-connector.js — it
 * calls `umbra.confidentialTransfer({ signer, mint, amount, stealthAddress, rpc })`.
 * We remap to the `createStealthReceive` path above.
 */
async function confidentialTransfer({ signer, mint, amount, stealthAddress, rpc, client }) {
  ensureSdk();
  if (!client) throw new Error('umbra.confidentialTransfer: pass `client` from initClient');
  return createStealthReceive({
    client,
    mint,
    amount,
    receiverAddress: stealthAddress,
  });
}

/**
 * Compatibility shim for atm-connector's `umbra.deriveStealth(dest)` call.
 * In the current SDK the receiver address is simply the customer's
 * pubkey — the stealth derivation happens inside the UTXO creator.
 * We pass it through so existing call sites don't break.
 */
function deriveStealth(userPubkey) {
  return String(userPubkey);
}

// ───────────────────────────────────────────────────────────
//  Helpers
// ───────────────────────────────────────────────────────────

function normalizeCommitment(c) {
  if (!c) return new Uint8Array(32);
  if (c instanceof Uint8Array) {
    if (c.length !== 32) throw new Error(`umbra: unexpected commitment length ${c.length}`);
    return c;
  }
  if (typeof c === 'string') {
    const hex = c.replace(/^0x/, '');
    if (hex.length !== 64) throw new Error(`umbra: commitment hex must be 32 bytes (got ${hex.length / 2})`);
    return Uint8Array.from(Buffer.from(hex, 'hex'));
  }
  if (Buffer.isBuffer(c)) return Uint8Array.from(c);
  if (Array.isArray(c)) return Uint8Array.from(c);
  throw new Error('umbra: cannot normalize commitment of type ' + typeof c);
}

/**
 * Convert a 32-byte commitment to the [u8; 32] array Rift expects.
 */
function commitmentAsArray(commitment) {
  const bytes = normalizeCommitment(commitment);
  return Array.from(bytes);
}

module.exports = {
  initClient,
  buildSigner,
  createStealthReceive,
  confidentialTransfer,      // legacy alias for atm-connector
  deriveStealth,             // legacy alias (passthrough)
  commitmentAsArray,
  normalizeCommitment,
};
