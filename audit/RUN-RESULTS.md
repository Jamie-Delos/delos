# Observed audit runs — 2026-09-13

These are recorded results from executed tool calls, not production benchmarks.

- Complete local contracts: 36 passing, 3 pending, approximately 34 seconds. See `contracts-local-results.txt`. Fifteen passing cases intentionally reproduce unsafe behavior.
- Final 500-operation local curve workload: 10 actors, 2,893 ms inside the measured loop, maximum trade gas 122,314. Includes invariant reads and automining; no throughput inference.
- Separate mainnet-fork test: 1 passing, approximately 25 seconds, block 62,225,577. Transactions executed only on the local fork.
- Read-only live dependency probe: chain ID `0x1237` (4663); factory code 24,535 bytes, NPM 24,384, router 24,497, WETH 2,202. NPM/router factory getters both matched `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA`. Code existence and linked addresses do not prove audited code identity.
- Existing indexer repro: failed RPC scan still committed cursor 5; replayed trade yielded 1 unique trade row but count 2, realQuote 196 instead of 98 and 2 price points.
- Extended indexer harness: 10,000 unique events plus 1,000 replayed events yielded count 11,000 and 11,000 price points. Injected database update failure still advanced cursor to block 6.
- Actual Fastify handlers with stub DB: 1,000 injected requests at concurrency 50, 0 valid-request failures; final observed elapsed 64 ms and p95 7.8465 ms. No TCP, real PostgreSQL, infrastructure, nonempty payload or WebSocket load included. Invalid limit input returned 500; health returned 200 without DB checks.
- Keeper planner: quote-equals-basket case attempted a same-token swap and rejected under a quoter emulating that unavailable pool.
- `npm run build` in indexer passed.
- `npm audit --omit=dev --json`: contracts 0, bot 0, indexer 2 high-severity affected packages. JSON details saved alongside this file.

No production runtime files were modified, and no audit files have been pushed. See `BACKEND-READINESS.md` for findings, limitations and release gates.
