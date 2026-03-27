import path from "path";
import { SQLiteRoomStore } from "../db/SQLiteRoomStore";

type SeedAgent = {
  name: string;
  description: string;
  protocol: string;
  endpointUrl: string;
  owner: string;
};

const seedAgents: SeedAgent[] = [
  {
    name: "Neva",
    description:
      "Builder agent specializing in architecture, system design, and technical planning. Can break down complex problems into actionable components.",
    protocol: "a2a",
    endpointUrl: "https://neva-agent.vercel.app/.well-known/agent-card.json",
    owner: "Neva Team"
  },
  {
    name: "PolicyCheck",
    description:
      "Legal and risk analysis agent. Evaluates proposals for regulatory compliance, identifies legal risks, and suggests policy frameworks.",
    protocol: "rest",
    endpointUrl: "https://policycheck.api.agentregistry.org/v1",
    owner: "A2A Registry"
  },
  {
    name: "Validate Agent",
    description:
      "Security-focused agent that reviews code, APIs, and architectures for vulnerabilities. Performs threat modeling and suggests mitigations.",
    protocol: "rest",
    endpointUrl: "https://validate.agent.silicon.friendly/api",
    owner: "Silicon Friendly"
  }
];

function resolveDbPath(): string {
  return process.env.HEXNEST_DB_PATH || path.resolve(process.cwd(), "data", "hexnest.sqlite");
}

export async function seedDirectoryAgents(): Promise<void> {
  const dbPath = resolveDbPath();
  const store = new SQLiteRoomStore(dbPath);
  const existingNames = new Set(
    (await store.listDirectoryAgents()).map((agent) => agent.name.trim().toLowerCase())
  );

  let insertedCount = 0;
  let skippedCount = 0;

  for (const agent of seedAgents) {
    const normalizedName = agent.name.trim().toLowerCase();
    if (existingNames.has(normalizedName)) {
      skippedCount += 1;
      console.log(`Skipping existing directory agent: ${agent.name}`);
      continue;
    }

    const created = await store.addDirectoryAgent(agent);
    await store.updateDirectoryAgentStatus(created.id, "approved");
    existingNames.add(normalizedName);
    insertedCount += 1;

    console.log(`Seeded approved directory agent: ${agent.name}`);
  }

  console.log(
    `Agent directory seeding finished. inserted=${insertedCount} skipped=${skippedCount} db=${dbPath}`
  );
}

seedDirectoryAgents().catch((error) => {
  console.error("Failed to seed agent directory.", error);
  process.exitCode = 1;
});
