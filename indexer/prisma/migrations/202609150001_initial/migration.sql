-- CreateTable
CREATE TABLE "Coin" (
    "address" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "symbol" TEXT NOT NULL DEFAULT '',
    "decimals" INTEGER NOT NULL DEFAULT 18,
    "totalSupply" TEXT NOT NULL DEFAULT '0',
    "creator" TEXT NOT NULL DEFAULT '',
    "quote" TEXT NOT NULL DEFAULT '',
    "quoteSymbol" TEXT NOT NULL DEFAULT 'ETH',
    "vault" TEXT,
    "holdersBps" INTEGER NOT NULL DEFAULT 0,
    "isV2" BOOLEAN NOT NULL DEFAULT false,
    "virtualQuote" TEXT NOT NULL DEFAULT '0',
    "tokenReserve" TEXT NOT NULL DEFAULT '0',
    "realQuote" TEXT NOT NULL DEFAULT '0',
    "graduationQuote" TEXT NOT NULL DEFAULT '0',
    "graduated" BOOLEAN NOT NULL DEFAULT false,
    "pool" TEXT,
    "progressBps" INTEGER NOT NULL DEFAULT 0,
    "priceQuote" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "priceUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "marketCapUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "volumeQuote" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "volumeUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tradeCount" INTEGER NOT NULL DEFAULT 0,
    "createdBlock" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Coin_pkey" PRIMARY KEY ("address")
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" TEXT NOT NULL,
    "coinAddress" TEXT NOT NULL,
    "trader" TEXT NOT NULL,
    "isBuy" BOOLEAN NOT NULL,
    "amountIn" TEXT NOT NULL,
    "amountOut" TEXT NOT NULL,
    "fee" TEXT NOT NULL,
    "priceQuote" DOUBLE PRECISION NOT NULL,
    "block" BIGINT NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricePoint" (
    "id" TEXT NOT NULL,
    "coinAddress" TEXT NOT NULL,
    "priceQuote" DOUBLE PRECISION NOT NULL,
    "priceUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "block" BIGINT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PricePoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cursor" (
    "id" TEXT NOT NULL,
    "lastBlock" BIGINT NOT NULL DEFAULT 0,
    "lastHash" TEXT,
    "chainId" INTEGER,
    "curve" TEXT,

    CONSTRAINT "Cursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndexedEvent" (
    "chainId" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "block" BIGINT NOT NULL,
    "blockHash" TEXT NOT NULL,

    CONSTRAINT "IndexedEvent_pkey" PRIMARY KEY ("chainId","txHash","logIndex")
);

-- CreateIndex
CREATE INDEX "Coin_graduated_idx" ON "Coin"("graduated");

-- CreateIndex
CREATE INDEX "Coin_createdAt_idx" ON "Coin"("createdAt");

-- CreateIndex
CREATE INDEX "Coin_marketCapUsd_idx" ON "Coin"("marketCapUsd");

-- CreateIndex
CREATE INDEX "Coin_updatedAt_idx" ON "Coin"("updatedAt");

-- CreateIndex
CREATE INDEX "Trade_coinAddress_ts_idx" ON "Trade"("coinAddress", "ts");

-- CreateIndex
CREATE INDEX "Trade_ts_idx" ON "Trade"("ts");

-- CreateIndex
CREATE UNIQUE INDEX "Trade_txHash_logIndex_key" ON "Trade"("txHash", "logIndex");

-- CreateIndex
CREATE INDEX "PricePoint_coinAddress_ts_idx" ON "PricePoint"("coinAddress", "ts");

-- CreateIndex
CREATE INDEX "IndexedEvent_block_idx" ON "IndexedEvent"("block");

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_coinAddress_fkey" FOREIGN KEY ("coinAddress") REFERENCES "Coin"("address") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricePoint" ADD CONSTRAINT "PricePoint_coinAddress_fkey" FOREIGN KEY ("coinAddress") REFERENCES "Coin"("address") ON DELETE RESTRICT ON UPDATE CASCADE;
