-- GeckoTerminal integration (src/geckoterminal.ts): per-trade ordering and post-trade curve reserves,
-- plus the creation and graduation transactions of each coin, so /events can be served from the database.
ALTER TABLE "Trade" ADD COLUMN "txIndex" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Trade" ADD COLUMN "reserve0After" TEXT;
ALTER TABLE "Trade" ADD COLUMN "reserve1After" TEXT;
CREATE INDEX "Trade_block_idx" ON "Trade"("block");

ALTER TABLE "Coin" ADD COLUMN "createdTxHash" TEXT;
ALTER TABLE "Coin" ADD COLUMN "graduatedBlock" BIGINT;
ALTER TABLE "Coin" ADD COLUMN "graduatedTxHash" TEXT;
ALTER TABLE "Coin" ADD COLUMN "graduatedTxIndex" INTEGER;
ALTER TABLE "Coin" ADD COLUMN "graduatedLogIndex" INTEGER;
ALTER TABLE "Coin" ADD COLUMN "graduatedAt" TIMESTAMP(3);
CREATE INDEX "Coin_graduatedBlock_idx" ON "Coin"("graduatedBlock");
