# Delos holder callouts

This branch adds a social layer to the V4 coin page. The read and write endpoints live on the Delos indexer; no wallet key or private signing service is needed server-side.

## Rules

- A wallet may publish one thesis per token when its live on-chain balance is at least **0.5% of real `totalSupply()`**. The indexer checks `balanceOf` and `totalSupply` at the same block when the post is submitted. Selling later does not erase a published thesis.
- A verified company wallet may publish without that balance. Verification is an explicit `COMPANY_CALLOUT_WALLETS` token-to-wallet allowlist configured by the operator after checking company control. The token creator is not automatically verified. Removing an entry removes the badge on the next read.
- The same wallet may update its thesis **once per rolling 24 hours**, enforced in a database transaction. All wallets may like or unlike other people's callouts once per callout; self-likes are refused.
- Every write uses a wallet signature containing the chain, token, wallet, action, content/target, issuance time and random nonce. Signatures expire after five minutes; nonces are single-use. The server verifies the signer, never accepts an address claim alone, and rate-limits writes. Text is plain text and React escapes it.
- An operator can suppress abuse by setting `Callout.hidden=true` in Postgres; hidden posts are excluded from reads and cannot be liked. Establish a moderation/reporting workflow before public launch.

## Holder list

The indexer now processes each launch token's `Transfer` events from the mint onward, in the same canonical, checkpointed transaction as launch and trade events. The top-20 list comes from those balances, excludes configured protocol custody addresses, and reports the latest finalized indexed block. It is a **wallet ranking**, not an identity or beneficial-ownership claim. A person can split holdings across wallets. The pool manager and curve are not ranked as people.

Only coins registered while this transfer index is active have `holdersIndexed=true`. Existing coin rows remain false after the migration, so the UI explicitly shows holder rankings as unavailable for them. To cover those coins, perform a reviewed holder backfill from each token's mint block or rebuild the indexer from a fresh database at the deployment start block. Do not simply flip the flag; it would display incomplete balances.

## Deployment and review

1. Apply the Prisma migration and regenerate the Prisma client in an isolated, reviewed deployment environment. Set `VITE_INDEXER_URL` to the live HTTPS indexer for the website and restrict `CORS_ORIGIN` to the actual site origin.
2. Set `COMPANY_CALLOUT_WALLETS` only after independently verifying the token address and a company-controlled signing wallet. A multisig/contract wallet can sign if its signature validates through the chain RPC. Keep this allowlist under the team's change review.
3. Treat the indexer's Postgres social tables as durable user data. Export/preserve `Callout`, `CalloutLike`, and `SocialNonce` when rebuilding chain data. Do not wipe them as part of a holder backfill.
4. Run the frontend/indexer builds and a mainnet-fork or isolated team rehearsal before exposing the write API. Check an exact 0.5% holder, one wei below threshold, a non-holder, official company wallet, invalid/replayed signatures, concurrent edits, the 24-hour boundary, like/unlike, self-like rejection, transfers, mint, graduation and pool transfers.

This change has **not** been deployed or exercised with wallets on this PC. Existing on-chain contracts and fee logic are untouched.
