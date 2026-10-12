ALTER TABLE "Coin" ADD COLUMN "holdersIndexed" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "HolderBalance" (
  "coinAddress" TEXT NOT NULL,
  "holder" TEXT NOT NULL,
  "balance" NUMERIC(78,0) NOT NULL DEFAULT 0,
  CONSTRAINT "HolderBalance_pkey" PRIMARY KEY ("coinAddress", "holder")
);
CREATE INDEX "HolderBalance_coinAddress_balance_idx" ON "HolderBalance"("coinAddress", "balance");

CREATE TABLE "Callout" (
  "id" TEXT NOT NULL,
  "coinAddress" TEXT NOT NULL,
  "author" TEXT NOT NULL,
  "text" VARCHAR(1200) NOT NULL,
  "hidden" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Callout_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Callout_coinAddress_author_key" ON "Callout"("coinAddress", "author");
CREATE INDEX "Callout_coinAddress_updatedAt_idx" ON "Callout"("coinAddress", "updatedAt");

CREATE TABLE "CalloutLike" (
  "calloutId" TEXT NOT NULL,
  "wallet" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CalloutLike_pkey" PRIMARY KEY ("calloutId", "wallet")
);
ALTER TABLE "CalloutLike" ADD CONSTRAINT "CalloutLike_calloutId_fkey" FOREIGN KEY ("calloutId") REFERENCES "Callout"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SocialNonce" (
  "nonce" TEXT NOT NULL,
  "wallet" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SocialNonce_pkey" PRIMARY KEY ("nonce")
);
CREATE INDEX "SocialNonce_createdAt_idx" ON "SocialNonce"("createdAt");
