// Former defect reproductions now assert the safe ingestion behavior.
require('./backend.readiness.cjs').ingestChecks().catch(e=>{console.error(e);process.exitCode=1;});
