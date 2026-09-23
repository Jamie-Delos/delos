-- V4 product (CensusCurveV4 + canonical Uniswap V4 pool with the Census hook). Existing rows are V3.
ALTER TABLE "Coin" ADD COLUMN "product" TEXT NOT NULL DEFAULT 'v3',
  ADD COLUMN "reflectionBps" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "poolId" TEXT;

-- Per-trade fee split (FeeAllocated on the V4 curve, FeeAccrued from the hook); "0" on V3 trades.
ALTER TABLE "Trade" ADD COLUMN "feeProtocol" TEXT NOT NULL DEFAULT '0',
  ADD COLUMN "feeCreator" TEXT NOT NULL DEFAULT '0',
  ADD COLUMN "feeHolders" TEXT NOT NULL DEFAULT '0',
  ADD COLUMN "feePenalty" TEXT NOT NULL DEFAULT '0';
