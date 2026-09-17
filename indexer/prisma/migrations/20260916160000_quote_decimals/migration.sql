-- AlterTable: quote assets are not all 18-decimal (a meme pair may be quoted in a company coin with
-- creator-supplied decimals); prices/volumes are scaled by the quote's own decimals.
ALTER TABLE "Coin" ADD COLUMN     "quoteDecimals" INTEGER NOT NULL DEFAULT 18;
