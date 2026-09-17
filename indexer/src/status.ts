export const ingestion: { lastSuccessAt: number; lastBlock: string | null; error: string | null } = {
  lastSuccessAt: 0,
  lastBlock: null,
  error: "Waiting for finalized ingestion",
};
