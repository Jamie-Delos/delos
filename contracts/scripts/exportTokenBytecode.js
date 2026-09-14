// Regenerates frontend/src/lib/launchTokenBytecode.ts from the compiled LaunchToken artifact, so the
// frontend's in-browser c0de grind predicts the SAME CREATE2 address the deployed factory produces.
// Run after any change to LaunchToken or the compiler settings, from the SAME build you deploy:
//   npx hardhat compile && node scripts/exportTokenBytecode.js
const fs = require("fs");
const path = require("path");
const artifact = require("../artifacts/contracts/LaunchToken.sol/LaunchToken.json");

const out = `// AUTO-GENERATED — do not edit by hand.
// LaunchToken CREATION bytecode, copied from contracts/artifacts/contracts/LaunchToken.sol/LaunchToken.json.
// The in-browser c0de grind hashes this + the encoded constructor args to predict the CREATE2 address.
// MUST match the LaunchToken the deployed factory creates — regenerate from the SAME build you deploy,
// or a grinded launch will revert with "not a census address". Regenerate: node scripts/exportTokenBytecode.js
export const LAUNCH_TOKEN_BYTECODE = "${artifact.bytecode}" as const;
`;
const dest = path.join(__dirname, "..", "..", "frontend", "src", "lib", "launchTokenBytecode.ts");
if (process.argv.includes("--check")) {
  const embedded = fs.readFileSync(dest, "utf8").match(/0x[0-9a-fA-F]{100,}/)?.[0];
  if (embedded !== artifact.bytecode) throw new Error("Client creation bytecode differs from compiled LaunchToken; regenerate before release");
  for (const name of ["LaunchFactory", "LaunchFactoryV2", "CensusCurve", "DividendVault", "LaunchLocker"]) {
    const compiled = require(`../artifacts/contracts/${name}.sol/${name}.json`);
    if ((compiled.deployedBytecode.length - 2) / 2 > 24576) throw new Error(`${name} exceeds EIP-170 size limit`);
  }
  console.log("Creation bytecode and contract size checks passed");
} else {
  fs.writeFileSync(dest, out);
  console.log("Generated LaunchToken creation bytecode");
}
