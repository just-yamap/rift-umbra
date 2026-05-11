# Wiring Umbra into the RIFT BUY Flow

This document shows where `integration/umbra.js` plugs into the production backend (`atm-connector.js` in the live RIFT stack).

The integration is **additive** and **fail-safe**: the Umbra delivery branch is wrapped in try/catch, and if anything fails (SDK error, indexer down, receiver not registered) the BUY transparently falls back to a public Jupiter transfer so the customer always receives their tokens.

---

## 1. Client memoisation at boot

At backend startup, the Umbra client is built once and cached. The client is heavy (it carries derived viewing keys and RPC plumbing) so reusing it across BUYs matters.

```js
let _umbraClient = null;
async function getCachedUmbraClient() {
  if (_umbraClient) return _umbraClient;
  const { getUmbraClient } = require('@umbra-privacy/sdk');
  _umbraClient = await getUmbraClient({
    signer: signingWallet,
    network: process.env.UMBRA_NETWORK || 'mainnet',
    rpcUrl: process.env.SOLANA_RPC,
    rpcSubscriptionsUrl: process.env.SOLANA_RPC_WSS,
    indexerApiEndpoint: process.env.UMBRA_RELAYER_URL,
  });
  return _umbraClient;
}
```

The full set of params (`rpcSubscriptionsUrl` + `indexerApiEndpoint`) is required by SDK 4.0.0 — passing only `signer + network + rpcUrl` causes a `Cannot read properties of undefined (reading 'match')` crash inside the SDK.

---

## 2. Confidential delivery in the BUY flow (atm-connector.js step 5b, ~line 1077)

After `lock_buy_claim` creates the Claim PDA and Jupiter swaps USDC into the target SPL, the integration optionally creates an Umbra stealth UTXO for the customer:

```js
// ── 5b. Confidential delivery via Umbra (when operator.privacyMode + USE_UMBRA) ──
let umbraCommitment = new Uint8Array(32);
let umbraDeliverySig = null;

if (CFG.useUmbra && operatorAcc.privacyMode) {
  try {
    const client = await getCachedUmbraClient();
    const createUtxoForReceiver =
      getPublicBalanceToReceiverClaimableUtxoCreatorFunction({ client });

    const result = await createUtxoForReceiver({
      mint: targetMint,
      amount: deliveredAtomics,
      receiverAddress: destPubkey,
    });

    umbraCommitment = result.commitment;
    umbraDeliverySig = result.signature;
    console.log(`[BUY] Umbra confidential delivery sig=${umbraDeliverySig.slice(0,12)}...`);
  } catch (e) {
    console.warn(`[BUY] Umbra confidential delivery failed: ${e.message} — executing PUBLIC FALLBACK delivery`);
    // Public fallback: standard SPL transfer from operator ATA to customer ATA
    umbraDeliverySig = await publicSplTransfer({ targetMint, amount: deliveredAtomics, destPubkey });
    console.log(`[BUY] Public fallback delivery successful: ${deliveredAtomics} of ${targetMint.toBase58().slice(0,8)}... → customer (sig=${umbraDeliverySig.slice(0,12)}...)`);
  }
}
```

The `result.commitment` is a 32-byte Poseidon hash. If the Umbra branch succeeds, this commitment is the on-chain anchor. If it fails, `umbraCommitment` stays as the zeroed default (semantically meaning "no privacy applied to this BUY").

---

## 3. Commit on-chain in confirm_dispensed (~line 1220)

The Rift Anchor program's `confirm_dispensed` instruction accepts a `[u8; 32]` slot to record the Umbra commitment:

```rust
pub fn confirm_dispensed(
    ctx: Context<ConfirmDispensed>,
    settlement_sig: [u8; 64],
    final_usdc_settled: u64,
    delta_usdc: u64,
    umbra_commitment: [u8; 32],  // ← stored, audit-only (not validated on-chain)
) -> Result<()> {
    // ...
    ctx.accounts.claim.umbra_commitment = umbra_commitment;
    // ...
}
```

The commitment is stored verbatim in the Claim PDA — providing an immutable on-chain audit trail of "a confidential UTXO was created for this BUY", without revealing amount or recipient.

This 32-byte slot is the same slot Cloak uses for its commitment (the slot is generic — any 32-byte commitment from a privacy protocol can live there).

---

## 4. Receiver-side claim (companion script: withdraw_umbra_alice.js)

Once a stealth UTXO is created for the customer, the customer (or their wallet) calls Umbra's withdraw flow to convert the UTXO back to a public SPL balance. The companion script `scripts/withdraw_umbra_alice.js` is a reference implementation showing how a receiver can:

1. Decrypt the UTXO using their viewing key (derived from their Solana keypair).
2. Generate a ZK proof of ownership.
3. Submit the withdraw to Umbra's relayer.
4. Receive the SPL tokens on their public ATA.

This is independent of RIFT (the customer never interacts with RIFT after the BUY) — they hold the UTXO commitment and can claim it whenever they want.

---

## 5. Operator registration (companion script: register_umbra_operator.js)

Before the integration can run, the operator authority must be registered with Umbra's EncryptedUserAccount system on-chain. The companion script `scripts/register_umbra_operator.js` is a one-shot tool that:

1. Loads the operator authority keypair (`FuePxPf2...` in production RIFT).
2. Derives the operator's Umbra commitment.
3. CPIs into Umbra's `register_user` instruction.
4. Persists the registration confirmation.

This is run once per deployment.

---

## 6. SDK smoke test (companion script: test_umbra_init.js)

`scripts/test_umbra_init.js` is a minimal smoke test that loads the Umbra SDK, builds a client, and verifies that the DKG + indexer endpoint are reachable. Run this after any SDK upgrade or RPC change to confirm Umbra still boots cleanly before activating it in the live BUY flow.

```bash
cd backend
node --env-file=.env scripts/test_umbra_init.js
```

---

## Activation steps for a fresh deployment

```bash
# 1. Install SDK
npm install @umbra-privacy/sdk@^4.0.0

# 2. Configure .env
echo "USE_UMBRA=1" >> .env
echo "UMBRA_RELAYER_URL=https://indexer.umbraprivacy.com" >> .env
echo "UMBRA_NETWORK=mainnet" >> .env

# 3. Register operator with Umbra
node --env-file=.env scripts/register_umbra_operator.js

# 4. Smoke test
node --env-file=.env scripts/test_umbra_init.js

# 5. Restart connector
pkill -f atm-connector
node --env-file=.env atm-connector.js > /tmp/rift_connector.log 2>&1 &

# 6. Verify
grep -i umbra /tmp/rift_connector.log
curl -s http://localhost:8790/health | python3 -m json.tool | grep -i umbra
```

The next privacy-mode BUY will route through Umbra. Look for in the log:
[BUY] Umbra confidential delivery sig=<signature>...

If Umbra is unavailable, the log shows the fail-safe in action:
[BUY] Umbra confidential delivery failed: <reason> — executing PUBLIC FALLBACK delivery
[BUY] Public fallback delivery successful: ... → customer

The customer receives their tokens either way.
