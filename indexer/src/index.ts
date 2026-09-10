import { cfg } from "./config.js";
import { runIngest } from "./ingest.js";
import { runApi } from "./api.js";
import { prisma } from "./db.js";

// One process runs both the API and the ingester. At higher volume, split them (same code, two
// deployments): run `runApi()` on web dynos and `runIngest()` on a single worker so the cursor has
// one writer.
async function main() {
  if (!cfg.databaseUrl) {
    console.error("DATABASE_URL is not set — copy .env.example to .env and point it at Postgres.");
    process.exit(1);
  }
  await prisma.$connect();
  await runApi();       // start serving immediately (reads whatever's already indexed)
  await runIngest();    // then backfill + live-poll forever
}

main().catch((e) => { console.error("[indexer] fatal:", e); process.exit(1); });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => { try { await prisma.$disconnect(); } catch { /* noop */ } process.exit(0); });
}
