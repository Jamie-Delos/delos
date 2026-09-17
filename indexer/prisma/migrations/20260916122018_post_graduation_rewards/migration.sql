-- AlterTable
ALTER TABLE "Trade" ADD COLUMN     "venue" TEXT NOT NULL DEFAULT 'curve';

-- CreateTable
CREATE TABLE "RewardEvent" (
    "id" TEXT NOT NULL,
    "coinAddress" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "holder" TEXT,
    "asset" TEXT,
    "amount" TEXT NOT NULL DEFAULT '0',
    "amountB" TEXT NOT NULL DEFAULT '0',
    "block" BIGINT NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RewardEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RewardEvent_coinAddress_ts_idx" ON "RewardEvent"("coinAddress", "ts");

-- CreateIndex
CREATE INDEX "RewardEvent_holder_idx" ON "RewardEvent"("holder");

-- CreateIndex
CREATE UNIQUE INDEX "RewardEvent_txHash_logIndex_key" ON "RewardEvent"("txHash", "logIndex");
