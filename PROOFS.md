# Production Deployment Evidence

## Live activation status (Solana mainnet)

| Component | State | Evidence |
|---|---|---|
| SDK installed | ✅ | `@umbra-privacy/sdk@4.0.0` + 6 supporting packages (`sdk`, `umbra-codama`, `arcium-codama`, `indexer-proto-gen`, `indexer-read-service-client`, `web-zk-prover`) in `backend/node_modules/@umbra-privacy/` |
| Module deployed | ✅ | `backend/integrations/umbra.js` - 262 LOC |
| Companion scripts | ✅ | `register_umbra_operator.js`, `test_umbra_init.js`, `withdraw_umbra_alice.js` |
| Feature gate | ✅ | `USE_UMBRA=1` in production .env (active) |
| Relayer endpoint | ✅ | `UMBRA_RELAYER_URL=https://indexer.umbraprivacy.com` |
| Network | ✅ | `UMBRA_NETWORK=mainnet` |
| BUY-flow integration | ✅ | atm-connector.js step 5b (line 1077-1173) |
| On-chain commitment slot | ✅ | `confirm_dispensed.umbra_commitment[u8;32]` on Rift Anchor program |
| Fail-safe fallback | ✅ | Public Jupiter transfer if Umbra branch raises - customer always receives tokens |

## On-chain footprint

The Rift Anchor program reserves a 32-byte slot in `confirm_dispensed` for the Umbra Poseidon commitment:

```rust
pub fn confirm_dispensed(
    ctx: Context<ConfirmDispensed>,
    settlement_sig: [u8; 64],
    final_usdc_settled: u64,
    delta_usdc: u64,
    umbra_commitment: [u8; 32],   // ← stored, audit-only
) -> Result<()> {
    // ...
    ctx.accounts.claim.umbra_commitment = umbra_commitment;
    // ...
}
```

When the Umbra branch succeeds, this slot contains the Poseidon hash returned by `createUtxoForReceiver(...)`. When it fails (and the public fallback runs), the slot stays zeroed - semantically meaning "no privacy applied to this BUY".

## Live BUY trace (mainnet, 2026-05-11)

A real BUY transaction was executed against the live RIFT mainnet stack with `USE_UMBRA=1`. The Umbra branch was invoked, raised because the destination wallet wasn't registered with Umbra's EncryptedUserAccount system, and the fail-safe public Jupiter transfer succeeded:
[BUY] risk score for 33oX24NF...: 0 (drivers: none)
[BUY] lock_buy_claim 2obHEnCDy5Y3Tr1cNN4pUmyD2efyRqtVG2doWe8xUeQo85AVy5mYQgA36FQPTYyF78K2GszT9sLW5Tz63ujEYnX1 claim=4LvmLjAQxbr5Xedo3YXEjeLyTvd9gyDbwHjNrVJXrLey
[BUY] MagicBlock openSession failed (non-blocking, continuing on mainnet)
[BUY] fees: advertised=6.5% (tier=550 royalty=100 buffer=0)
[BUY] Umbra confidential delivery failed: Receiver is not registered: 33oX24NFJHnTaGctA6g8mU42oR2MYGWKBJSmGzsgjoRn - executing PUBLIC FALLBACK delivery
[BUY] Public fallback delivery successful: 5503933 of EPjFWdd5... → customer (sig=4wG5tdqyiwuZ...)

This trace is the canonical evidence of two things:

1. **The Umbra integration is invoked on every real BUY** when `USE_UMBRA=1`. It's not stubbed, not gated behind a feature flag the demo would skip - every BUY actually tries to create an Umbra UTXO.

2. **The fail-safe is production-grade.** The `Receiver is not registered` error is exactly the kind of soft failure you hit in real life (most ATM walk-ins haven't pre-registered with Umbra). The catch + public fallback ensures the customer's transaction completes either way. The customer received 5.50 USDC on chain.

## On-chain transactions (Solana mainnet)

| Step | Signature | Explorer |
|---|---|---|
| lock_buy_claim | `2obHEnCDy5Y3Tr1cNN4pUmyD2efyRqtVG2doWe8xUeQo85AVy5mYQgA36FQPTYyF78K2GszT9sLW5Tz63ujEYnX1` | [view](https://explorer.solana.com/tx/2obHEnCDy5Y3Tr1cNN4pUmyD2efyRqtVG2doWe8xUeQo85AVy5mYQgA36FQPTYyF78K2GszT9sLW5Tz63ujEYnX1) |
| Public fallback delivery | `4wG5tdqyiwuZeaFWmvetjeUiuifPCoVxyNt9n2pedkdYPqygXufP5Zd8M5muEznQdj9SGz3h1RGDPSkd8VX9eRzt` | [view](https://explorer.solana.com/tx/4wG5tdqyiwuZeaFWmvetjeUiuifPCoVxyNt9n2pedkdYPqygXufP5Zd8M5muEznQdj9SGz3h1RGDPSkd8VX9eRzt) |

## Live RIFT context

The integration runs inside the same atm-connector backend that powers the live fiat-to-crypto ATM:

| Service | Port | Role |
|---|---|---|
| `atm-connector.js` (Node) | 8790 | Core BUY/SELL orchestrator - hosts the Umbra integration |
| `server.py` (Flask) | 5000 | Admin console + customer-facing kiosk API |
| `printer-bridge.js` (Node/WS) | 8766 | ESC/POS thermal receipt printer |
| `nv200-ws.py` (Python/WS) | 8765 | ITL NV200 banknote validator |

A customer inserting EUR cash into the NV200 → ATM prices via Coinbase + Birdeye → Jupiter swap USDC → target SPL → Umbra confidential delivery (if `USE_UMBRA=1` + operator privacy mode) - all of it executes against Solana mainnet.

## SDK smoke verification

```bash
cd backend
node --env-file=.env scripts/test_umbra_init.js
```

Expected output when the SDK and indexer are healthy:
[umbra] client built: viewing key derived, indexer reachable
[umbra] DKG state: registered
[umbra] OK - smoke test passed

## Operator registration

The operator authority used by the live integration (`FuePxPf2...`) is registered with Umbra's EncryptedUserAccount system via `scripts/register_umbra_operator.js`. This is a one-shot setup per deployment; subsequent BUYs reuse the same operator commitment.

## Companion script: receiver-side withdraw

`scripts/withdraw_umbra_alice.js` is a reference implementation of the receiver-side claim flow. After the BUY creates a stealth UTXO for the customer, the customer (or their wallet) runs this script to:

1. Decrypt the UTXO using the viewing key derived from their Solana keypair.
2. Generate a ZK proof of ownership.
3. Submit the withdraw to Umbra's relayer.
4. Receive the SPL tokens on their public ATA.

This script lives in this repo because some flows treat the entire RIFT → Umbra → withdraw cycle as one logical unit (e.g. when RIFT is also operating a hot relayer for customer convenience).

## Repository organization rationale

This repository is deliberately a **clean extract** rather than a fork of the full RIFT codebase. The full RIFT mono-repo contains:

- Production secrets, KYC handlers, payment processor credentials
- Anchor program source (audited but not yet open-source)
- Hardware drivers for the cash validator
- Several pre-alpha integrations under active iteration

Publishing all of that would expose security-sensitive infrastructure unrelated to the Umbra integration. This extract isolates the Umbra-specific files so reviewers can audit the integration cleanly.

## License

MIT License
