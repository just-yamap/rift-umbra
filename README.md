# RIFT ATM × Umbra Privacy

Confidential SPL transfers integrated into the live RIFT fiat-to-crypto ATM on Solana mainnet, using Umbra's Arcium-MPC-backed stealth UTXO protocol.

**Frontier 2026 — Build with Umbra Side Track ($10K USDC).**

---

## What this is

RIFT is a live fiat-to-crypto ATM running on Solana mainnet. When a customer purchases crypto at the kiosk, the BUY flow can deliver tokens either publicly (Jupiter → customer ATA) or **confidentially** via Umbra: after the Jupiter swap lands tokens in the operator's ATA, the integration creates a stealth UTXO locked to the customer's Umbra commitment, breaking the on-chain link between operator and recipient.

The integration is **additive** to the existing BUY flow, **fail-safe** (public fallback if Umbra fails), and gated by `USE_UMBRA=1` for safe deployment.
## Architecture

```

Customer BUYS at ATM kiosk (e.g. €50 → USDT)
↓
lock_buy_claim (mainnet, Anchor)
→ Claim PDA created on-chain
↓
Jupiter swap USDC → target SPL
→ Tokens land in operator's public ATA
↓
Umbra createUtxoForReceiver
→ Arcium MPC creates a stealth UTXO
→ Poseidon commitment locked to customer
↓
confirm_dispensed (mainnet)
→ 32-byte Poseidon commitment stored on-chain
→ Amount and recipient HIDDEN (audit trail only)
```



If any step in the Umbra branch fails (SDK error, indexer down, receiver not registered), the integration catches the error and falls back to a **public Jupiter transfer** to the customer's ATA — the customer always receives their tokens.

## Repository layout
```
rift-umbra/
├── integration/
│   └── umbra.js                       Production module (262 LOC)
├── scripts/
│   ├── register_umbra_operator.js     One-shot operator account registration
│   ├── test_umbra_init.js             SDK smoke test (DKG + register)
│   └── withdraw_umbra_alice.js        Receiver-side withdraw flow
├── README.md                           This file
├── WIRING.md                           Integration points in atm-connector.js
└── PROOFS.md                           Live production evidence
```

## Module API

The Umbra integration exposes one main function: `deliverConfidentially(...)`, called from the BUY handler after the Jupiter swap completes:

```js
const result = await umbra.deliverConfidentially({
  client,                  // Umbra client (memoised in atm-connector)
  signer,                  // operator authority (Solana signer)
  rpcUrl,                  // mainnet RPC
  mint,                    // SPL mint being delivered
  amount,                  // integer atomics
  receiverAddress,         // customer pubkey (must be Umbra-registered)
  network: 'mainnet',
});

// result.commitment is a 32-byte Poseidon commitment
// that gets written into confirm_dispensed's umbra_commitment slot.
```

## What Umbra actually is

Umbra is an **Arcium-MPC-backed confidential balance + stealth-UTXO** protocol on Solana. The SDK is deeply composable, exposing a client factory plus per-operation factory functions:

```js
const client = await getUmbraClient({ signer, network, rpcUrl });
const createUtxoForReceiver =
  getPublicBalanceToReceiverClaimableUtxoCreatorFunction({ client });
const result = await createUtxoForReceiver({ mint, amount, receiverAddress });
```

`result.commitment` is the on-chain anchor: a 32-byte Poseidon hash that records "a confidential UTXO of value X was created for receiver Y at this slot", with both X and Y hidden from anyone who doesn't hold the receiver's viewing key.

The Rift Anchor program's `confirm_dispensed` instruction stores this commitment in a `[u8; 32]` slot, providing an immutable on-chain audit trail without revealing transaction details.

## Feature gate

```bash
USE_UMBRA=1
UMBRA_RELAYER_URL=https://indexer.umbraprivacy.com
UMBRA_NETWORK=mainnet
```

With `USE_UMBRA=0` (default), the integration is fully inert: no SDK is loaded, no client is built, the BUY runs purely on the public Jupiter path.

## Production status

| Item | State |
|---|---|
| SDK installed | ✅ `@umbra-privacy/sdk@4.0.0` |
| Module deployed | ✅ `backend/integrations/umbra.js` (262 LOC) |
| Boot integration | ✅ Umbra client memoised at startup |
| BUY-flow integration | ✅ atm-connector.js line 1077-1173 (step 5b) |
| Commitment on-chain | ✅ `confirm_dispensed.umbra_commitment[u8;32]` slot |
| Fail-safe fallback | ✅ Public Jupiter transfer if Umbra branch fails |
| Live activation | ✅ `USE_UMBRA=1` in production .env |

## License

MIT License
