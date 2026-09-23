-- USD fields fail closed: null means "no configured USD price for this quote asset", never 0 or a
-- placeholder ETH price. Existing rows keep their values; rebuild the index after configuring ETH_USD /
-- QUOTE_USD if the previous values were produced by the old hardcoded default.
ALTER TABLE "Coin" ALTER COLUMN "priceUsd" DROP NOT NULL, ALTER COLUMN "priceUsd" DROP DEFAULT,
  ALTER COLUMN "marketCapUsd" DROP NOT NULL, ALTER COLUMN "marketCapUsd" DROP DEFAULT,
  ALTER COLUMN "volumeUsd" DROP NOT NULL, ALTER COLUMN "volumeUsd" DROP DEFAULT;
ALTER TABLE "PricePoint" ALTER COLUMN "priceUsd" DROP NOT NULL, ALTER COLUMN "priceUsd" DROP DEFAULT;
