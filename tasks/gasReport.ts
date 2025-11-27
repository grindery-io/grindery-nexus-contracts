import { task } from "hardhat/config";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { ZeroLC } from "../typechain-types";
import * as fs from "fs";

task("gas-report", "Report gas consumption for settling charges in batches").setAction(async (_, hre) => {
  const { ethers } = hre;
  const [owner, user, agent] = await ethers.getSigners();

  console.log("\n=== ZeroLC Gas Consumption Report ===\n");
  console.log("Setting up test environment...");

  // Deploy TestERC20
  const TestERC20Factory = await ethers.getContractFactory("TestERC20");
  const gasToken = await TestERC20Factory.deploy(ethers.parseEther("10000000"));
  await gasToken.waitForDeployment();

  // Deploy UniversalSigValidator
  const UniversalSigValidatorFactory = await ethers.getContractFactory("UniversalSigValidator");
  const universalSigValidator = await UniversalSigValidatorFactory.deploy();
  await universalSigValidator.waitForDeployment();

  // Deploy ZeroLC implementation
  const ZeroLCFactory = await ethers.getContractFactory("ZeroLC");
  const zeroLCImpl = await ZeroLCFactory.deploy(await gasToken.getAddress(), await universalSigValidator.getAddress());
  await zeroLCImpl.waitForDeployment();

  /*
  // Deploy proxy
  const ERC1967ProxyFactory = await ethers.getContractFactory(
    "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy"
  );
  const initData = zeroLCImpl.interface.encodeFunctionData("initialize");
  const proxy = await ERC1967ProxyFactory.deploy(await zeroLCImpl.getAddress(), initData);
  await proxy.waitForDeployment();
  */

  const zeroLC = ZeroLCFactory.attach(await zeroLCImpl.getAddress()) as ZeroLC;

  // console.log("Deployed code:", await agent.provider.getCode(await zeroLC.getAddress()));

  // Transfer tokens and deposit
  await gasToken.transfer(user.address, 1000000n);
  await gasToken.connect(user).approve(await zeroLC.getAddress(), 1000000n);
  await zeroLC.connect(user)["deposit(uint256)"](1000000n);

  // Create and register authorization scope
  const currentTime = await time.latest();
  const scope = {
    user: user.address,
    disputeWindow: 3600,
    agent: agent.address,
    notBefore: currentTime,
    notAfter: currentTime + 31536000, // 1 year
    totalAmount: 1000000n,
    amountGranularity: 0,
  };

  const domain = {
    name: "ZeroLC",
    version: "1",
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await zeroLC.getAddress(),
  };

  const types = {
    AuthorizationScope: [
      { name: "user", type: "address" },
      { name: "disputeWindow", type: "uint40" },
      { name: "agent", type: "address" },
      { name: "notBefore", type: "uint40" },
      { name: "notAfter", type: "uint40" },
      { name: "totalAmount", type: "uint128" },
      { name: "amountGranularity", type: "uint8" },
    ],
  };

  const signature = await user.signTypedData(domain, types, scope);
  await zeroLC.registerAuthorizationScope(scope, signature);

  const scopeHash = await zeroLC.getScopeHash(scope);

  // Helper to pack ChargeEntry structs into bytes (12 bytes each: uint32 + uint24 + uint40)
  function packChargeEntries(entries: { scaledAmount: bigint; nonce: number; notAfter: number }[]): string {
    const packed = entries
      .map((e) =>
        ethers
          .solidityPacked(["uint32", "uint24", "uint40"], [e.scaledAmount, e.nonce, e.notAfter])
          .slice(2) // Remove 0x prefix
      )
      .join("");
    return "0x" + packed;
  }

  // Helper to create charge batch
  async function createChargeBatch(numCharges: number, startNonce: number) {
    const currentTime = await time.latest();
    const chargeEntries = [];

    // Create varying charge amounts
    for (let i = 0; i < numCharges; i++) {
      chargeEntries.push({
        scaledAmount: BigInt(100 + (i % 10) * 10), // Varying amounts: 100, 110, 120, ..., 190, 100, ...
        nonce: startNonce + i,
        notAfter: currentTime + 3600,
      });
    }

    // Create batch part hash - pack all entries then hash all except last 12 bytes
    let batchPartHash = "0x0000000000000000000000000000000000000000000000000000000000000000";
    if (chargeEntries.length > 1) {
      const packedEntries = packChargeEntries(chargeEntries);
      // Hash all bytes except the last 12 bytes (24 hex chars)
      batchPartHash = ethers.keccak256("0x" + packedEntries.slice(2, -24));
    }

    const lastEntry = chargeEntries[chargeEntries.length - 1];

    const verifierEncoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "tuple(uint32,uint24,uint40)", "bytes32"],
      [batchPartHash, [lastEntry.scaledAmount, lastEntry.nonce, lastEntry.notAfter], scopeHash]
    );

    const verifierBytes = ethers.getBytes(verifierEncoded);
    const agentSignature = await agent.signMessage(verifierBytes);

    return {
      scope: scope,
      entries: packChargeEntries(chargeEntries),
      timestamp: currentTime,
      agentSignature: agentSignature,
    };
  }

  // Perform initial settlement (not measured) to initialize state
  console.log("Initializing scope with dummy settlement...");
  let dummyBatch = await createChargeBatch(1, 1);
  await zeroLC.settleCharges([dummyBatch]);
  dummyBatch = await createChargeBatch(1, 2);
  await zeroLC.settleCharges([dummyBatch]);
  dummyBatch = await createChargeBatch(1, 3);
  await zeroLC.settleCharges([dummyBatch]);

  let currentNonce = 4; // Start after dummy charge

  // Test scenarios
  const scenarios = [1, 10, 100];
  const results: { charges: number; gasUsed: bigint }[] = [];

  console.log("\nMeasuring gas consumption...\n");

  let singleChargeTxHash: string | undefined;

  for (const numCharges of scenarios) {
    const batch = await createChargeBatch(numCharges, currentNonce);
    const tx = await zeroLC.settleCharges([batch]);
    const receipt = await tx.wait();

    const gasUsed = receipt!.gasUsed;
    results.push({ charges: numCharges, gasUsed });

    // Capture transaction hash for single charge case
    if (numCharges === 100) {
      singleChargeTxHash = receipt!.hash;
    }

    currentNonce += numCharges;
  }

  // Display results
  console.log("┌─────────────────────┬──────────────┬─────────────────┐");
  console.log("│ Charges per Batch   │ Gas Used     │ Gas per Charge  │");
  console.log("├─────────────────────┼──────────────┼─────────────────┤");

  for (const result of results) {
    const gasPerCharge = result.gasUsed / BigInt(result.charges);
    console.log(
      `│ ${result.charges.toString().padEnd(19)} │ ${result.gasUsed.toString().padEnd(12)} │ ${gasPerCharge.toString().padEnd(15)} │`
    );
  }

  console.log("└─────────────────────┴──────────────┴─────────────────┘\n");

  // Calculate incremental costs
  console.log("Incremental Analysis:");
  console.log(`  Base cost (1 charge):       ${results[0].gasUsed}`);
  console.log(
    `  Incremental (1→10):         ${results[1].gasUsed - results[0].gasUsed} (${(results[1].gasUsed - results[0].gasUsed) / 9n} per charge)`
  );
  console.log(
    `  Incremental (10→100):       ${results[2].gasUsed - results[1].gasUsed} (${(results[2].gasUsed - results[1].gasUsed) / 90n} per charge)`
  );
  console.log();

  // Detailed trace analysis for 100 charges case
  if (singleChargeTxHash) {
    console.log("\n=== Detailed Gas Analysis (100 Charges) ===\n");
    console.log("Generating detailed trace...");

    try {
      // Get detailed opcode-level trace (using default tracer)
      const opcodeTrace: any = await ethers.provider.send("debug_traceTransaction", [singleChargeTxHash, {}]);

      console.log(`  Transaction Hash: ${singleChargeTxHash}`);

      // Analyze gas consumption by operation
      const structLogs = opcodeTrace.structLogs || [];

      console.log("\n=== Top 20 Most Expensive Operations ===\n");

      // Group by opcode and calculate total gas
      const opcodeStats: { [key: string]: { count: number; totalGas: number; operations: any[] } } = {};

      for (let i = 0; i < structLogs.length; i++) {
        const log = structLogs[i];
        const opcode = log.op;
        const gasCost = i < structLogs.length - 1 ? log.gas - structLogs[i + 1].gas : 0;

        if (!opcodeStats[opcode]) {
          opcodeStats[opcode] = { count: 0, totalGas: 0, operations: [] };
        }

        opcodeStats[opcode].count++;
        opcodeStats[opcode].totalGas += gasCost;
        opcodeStats[opcode].operations.push({
          pc: log.pc,
          depth: log.depth,
          gas: gasCost,
        });
      }

      // Sort by total gas consumed
      const sortedOpcodes = Object.entries(opcodeStats)
        .map(([opcode, stats]) => ({ opcode, ...stats }))
        .sort((a, b) => b.totalGas - a.totalGas)
        .slice(0, 20);

      console.log("┌──────────────┬───────────┬──────────────┬─────────────────┐");
      console.log("│ Opcode       │ Count     │ Total Gas    │ Avg Gas/Op      │");
      console.log("├──────────────┼───────────┼──────────────┼─────────────────┤");

      for (const stat of sortedOpcodes) {
        const avgGas = stat.count > 0 ? Math.round(stat.totalGas / stat.count) : 0;
        console.log(
          `│ ${stat.opcode.padEnd(12)} │ ${stat.count.toString().padEnd(9)} │ ${stat.totalGas.toString().padEnd(12)} │ ${avgGas.toString().padEnd(15)} │`
        );
      }

      console.log("└──────────────┴───────────┴──────────────┴─────────────────┘\n");

      // Storage operations analysis
      const sstoreOps = opcodeStats["SSTORE"]?.operations || [];
      const sloadOps = opcodeStats["SLOAD"]?.operations || [];

      console.log("Storage Operations:");
      console.log(`  SSTORE operations: ${sstoreOps.length}`);
      console.log(`  SLOAD operations: ${sloadOps.length}`);
      console.log(
        `  Total storage gas: ${(opcodeStats["SSTORE"]?.totalGas || 0) + (opcodeStats["SLOAD"]?.totalGas || 0)}`
      );

      console.log();

      // Write detailed per-instruction gas report to file
      const outputFile = "gas-report-detailed.txt";
      console.log(`Writing detailed per-instruction gas report to ${outputFile}...`);

      let fileContent = "";
      fileContent += "=".repeat(80) + "\n";
      fileContent += "ZeroLC 100 Charges Settlement - Detailed Gas Report\n";
      fileContent += "=".repeat(80) + "\n\n";
      fileContent += `Transaction Hash: ${singleChargeTxHash}\n`;
      fileContent += `Total Gas Used: ${results[2].gasUsed}\n`;
      fileContent += `Total Instructions: ${structLogs.length}\n\n`;

      // Group instructions by PC (each PC appears once)
      const pcMap: {
        [pc: number]: {
          opcode: string;
          depth: number;
          totalGas: number;
          count: number;
          avgStackDepth: number;
          immediate?: string;
        };
      } = {};

      for (let i = 0; i < structLogs.length; i++) {
        const log = structLogs[i];
        const gasCost = i < structLogs.length - 1 ? log.gas - structLogs[i + 1].gas : 0;
        const stackDepth = log.stack ? log.stack.length : 0;

        if (!pcMap[log.pc]) {
          // Extract immediate value for PUSH instructions
          let immediate: string | undefined;
          if (log.op.startsWith("PUSH") && log.stack && log.stack.length > 0) {
            // The pushed value is on top of the stack after execution
            // For PUSH instructions, check the next log's stack to see what was pushed
            if (i + 1 < structLogs.length && structLogs[i + 1].stack) {
              const pushedValue = structLogs[i + 1].stack[structLogs[i + 1].stack.length - 1];
              if (pushedValue) {
                // Convert to hex, trim leading zeros but keep at least 1 digit
                const hexValue = pushedValue.replace(/^0x0*/, "0x") || "0x0";
                immediate = hexValue;
              }
            }
          }

          pcMap[log.pc] = {
            opcode: log.op,
            depth: log.depth,
            totalGas: gasCost,
            count: 1,
            avgStackDepth: stackDepth,
            immediate,
          };
        } else {
          pcMap[log.pc].totalGas += gasCost;
          pcMap[log.pc].count += 1;
          pcMap[log.pc].avgStackDepth += stackDepth;
        }
      }

      // Calculate averages and sort by PC
      const sortedPCs = Object.entries(pcMap)
        .map(([pc, data]) => ({
          pc: parseInt(pc),
          opcode: data.opcode,
          depth: data.depth,
          totalGas: data.totalGas,
          count: data.count,
          avgGas: data.count > 0 ? Math.round(data.totalGas / data.count) : 0,
          avgStackDepth: data.count > 0 ? Math.round(data.avgStackDepth / data.count) : 0,
          immediate: data.immediate,
        }))
        .sort((a, b) => a.pc - b.pc);

      fileContent += "=".repeat(80) + "\n";
      fileContent += "Per-Instruction Trace (Grouped by PC, Sorted by PC)\n";
      fileContent += "=".repeat(80) + "\n\n";
      fileContent += "PC      | Depth | Opcode          | Executions | Total Gas | Avg Gas | Immediate\n";
      fileContent += "-".repeat(80) + "\n";

      for (const entry of sortedPCs) {
        const pc = "0x" + entry.pc.toString(16).toUpperCase().padStart(4, "0");
        const depth = entry.depth.toString().padEnd(5);
        const opcode = entry.opcode.padEnd(15);
        const executions = entry.count.toString().padEnd(10);
        const totalGas = entry.totalGas.toString().padEnd(9);
        const avgGas = entry.avgGas.toString().padEnd(7);
        const immediate = entry.immediate || "";

        fileContent += `${pc} | ${depth} | ${opcode} | ${executions} | ${totalGas} | ${avgGas} | ${immediate}\n`;
      }

      fileContent += "\n" + "=".repeat(80) + "\n";
      fileContent += "Opcode Statistics (Sorted by Total Gas)\n";
      fileContent += "=".repeat(80) + "\n\n";
      fileContent += "Opcode          | Count     | Total Gas  | Avg Gas/Op | % of Total\n";
      fileContent += "-".repeat(80) + "\n";

      const totalGasFromOpcodes = Object.values(opcodeStats).reduce((sum, stat) => sum + stat.totalGas, 0);

      for (const stat of sortedOpcodes) {
        const avgGas = stat.count > 0 ? Math.round(stat.totalGas / stat.count) : 0;
        const percentage = totalGasFromOpcodes > 0 ? ((stat.totalGas / totalGasFromOpcodes) * 100).toFixed(2) : "0.00";

        const opcode = stat.opcode.padEnd(15);
        const count = stat.count.toString().padEnd(9);
        const totalGas = stat.totalGas.toString().padEnd(10);
        const avg = avgGas.toString().padEnd(10);

        fileContent += `${opcode} | ${count} | ${totalGas} | ${avg} | ${percentage}%\n`;
      }

      fileContent += "\n" + "=".repeat(80) + "\n";
      fileContent += "Storage Operations Details\n";
      fileContent += "=".repeat(80) + "\n\n";

      fileContent += "SSTORE Operations:\n";
      fileContent += "-".repeat(80) + "\n";
      fileContent += "PC      | Depth | Gas Cost\n";
      for (const op of sstoreOps) {
        const pcHex = "0x" + op.pc.toString(16).toUpperCase().padStart(4, "0");
        fileContent += `${pcHex} | ${op.depth.toString().padEnd(5)} | ${op.gas}\n`;
      }

      fileContent += "\nSLOAD Operations:\n";
      fileContent += "-".repeat(80) + "\n";
      fileContent += "PC      | Depth | Gas Cost\n";
      for (const op of sloadOps) {
        const pcHex = "0x" + op.pc.toString(16).toUpperCase().padStart(4, "0");
        fileContent += `${pcHex} | ${op.depth.toString().padEnd(5)} | ${op.gas}\n`;
      }

      fileContent += "\n" + "=".repeat(80) + "\n";
      fileContent += "Summary Statistics\n";
      fileContent += "=".repeat(80) + "\n\n";
      fileContent += `Total SSTORE operations: ${sstoreOps.length}\n`;
      fileContent += `Total SLOAD operations: ${sloadOps.length}\n`;
      fileContent += `Total storage gas: ${(opcodeStats["SSTORE"]?.totalGas || 0) + (opcodeStats["SLOAD"]?.totalGas || 0)}\n`;
      fileContent += `Storage gas percentage: ${totalGasFromOpcodes > 0 ? ((((opcodeStats["SSTORE"]?.totalGas || 0) + (opcodeStats["SLOAD"]?.totalGas || 0)) / totalGasFromOpcodes) * 100).toFixed(2) : 0}%\n`;

      fs.writeFileSync(outputFile, fileContent);
      console.log(`✓ Detailed gas report written to ${outputFile}\n`);
    } catch (error: any) {
      console.log(`\nNote: Detailed trace analysis not available (${error.message})`);
      console.log("This is expected in some Hardhat network configurations.");
    }
  }
});
