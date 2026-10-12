CREATE TABLE "WalletProfile" (
  "wallet" TEXT NOT NULL,
  "hidden" BOOLEAN NOT NULL DEFAULT false,
  "displayName" VARCHAR(48) NOT NULL DEFAULT '',
  "bio" VARCHAR(500) NOT NULL DEFAULT '',
  "avatar" VARCHAR(500) NOT NULL DEFAULT '',
  "banner" VARCHAR(500) NOT NULL DEFAULT '',
  "x" VARCHAR(200) NOT NULL DEFAULT '',
  "telegram" VARCHAR(200) NOT NULL DEFAULT '',
  "website" VARCHAR(200) NOT NULL DEFAULT '',
  "signedAt" BIGINT NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WalletProfile_pkey" PRIMARY KEY ("wallet")
);
