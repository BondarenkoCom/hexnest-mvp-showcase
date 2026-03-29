import { IAppStore } from "../orchestration/RoomStore";
import { newId, nowIso } from "../utils/ids";
import {
  DiscoveryCandidate,
  DiscoveryCandidateStatus,
  DiscoveryJoinability,
  DiscoveryLogEntry,
  DiscoveryProtocol,
  DiscoveryRunResult
} from "./types";

interface DiscoveryServiceOptions {
  mcpRegistryUrl: string;
  mcpPageLimit: number;
  fetchTimeoutMs: number;
  a2aSeeds: string[];
  maxLogs: number;
  contactThreshold: number;
}

interface McpServerListResponse {
  servers?: Array<{
    server?: {
      name?: string;
      title?: string;
      description?: string;
      websiteUrl?: string;
      repository?: { url?: string };
      remotes?: Array<{ type?: string; url?: string; headers?: unknown[] }>;
    };
  }>;
  metadata?: {
    nextCursor?: string;
  };
}

interface A2AAgentCard {
  name?: string;
  description?: string;
  url?: string;
  a2aEndpoint?: string;
  endpoints?: { a2a?: string };
  skills?: Array<{ name?: string; id?: string; tags?: string[] }>;
  authentication?: { schemes?: string[] };
  securitySchemes?: Record<string, unknown>;
}

const DEFAULT_OPTIONS: DiscoveryServiceOptions = {
  mcpRegistryUrl: "https://registry.modelcontextprotocol.io/v0.1/servers",
  mcpPageLimit: Math.max(1, Number(process.env.HEXNEST_DISCOVERY_MCP_PAGES || 2)),
  fetchTimeoutMs: Math.max(1000, Number(process.env.HEXNEST_DISCOVERY_TIMEOUT_MS || 8000)),
  a2aSeeds: parseSeeds(process.env.HEXNEST_DISCOVERY_A2A_SEEDS || ""),
  maxLogs: Math.max(100, Number(process.env.HEXNEST_DISCOVERY_MAX_LOGS || 600)),
  contactThreshold: Math.max(1, Math.min(100, Number(process.env.HEXNEST_DISCOVERY_CONTACT_THRESHOLD || 70)))
};

type DiscoveryStore = Pick<IAppStore, "listDirectoryAgents">;

export class DiscoveryService {
  private readonly options: DiscoveryServiceOptions;
  private readonly candidates = new Map<string, DiscoveryCandidate>();
  private readonly logs: DiscoveryLogEntry[] = [];
  private running = false;
  private lastRun: DiscoveryRunResult | null = null;

  constructor(
    private readonly store: DiscoveryStore,
    private readonly fetchImpl: typeof fetch = fetch,
    options: Partial<DiscoveryServiceOptions> = {}
  ) {
    this.options = {
      mcpRegistryUrl: String(options.mcpRegistryUrl || DEFAULT_OPTIONS.mcpRegistryUrl),
      mcpPageLimit: Math.max(1, Number(options.mcpPageLimit || DEFAULT_OPTIONS.mcpPageLimit)),
      fetchTimeoutMs: Math.max(1000, Number(options.fetchTimeoutMs || DEFAULT_OPTIONS.fetchTimeoutMs)),
      a2aSeeds: Array.isArray(options.a2aSeeds)
        ? options.a2aSeeds
        : DEFAULT_OPTIONS.a2aSeeds,
      maxLogs: Math.max(100, Number(options.maxLogs || DEFAULT_OPTIONS.maxLogs)),
      contactThreshold: Math.max(
        1,
        Math.min(100, Number(options.contactThreshold || DEFAULT_OPTIONS.contactThreshold))
      )
    };
  }

  public getCandidates(filters: {
    status?: DiscoveryCandidateStatus;
    protocol?: DiscoveryProtocol;
    minScore?: number;
  } = {}): DiscoveryCandidate[] {
    const minScore = Number.isFinite(filters.minScore) ? Number(filters.minScore) : -Infinity;
    return Array.from(this.candidates.values())
      .filter((candidate) => !filters.status || candidate.status === filters.status)
      .filter((candidate) => !filters.protocol || candidate.protocols.includes(filters.protocol))
      .filter((candidate) => candidate.trustScore >= minScore)
      .sort((a, b) => {
        if (b.trustScore !== a.trustScore) return b.trustScore - a.trustScore;
        return a.title.localeCompare(b.title);
      })
      .map((candidate) => ({ ...candidate }));
  }

  public getStatus(): { running: boolean; lastRun: DiscoveryRunResult | null; totalCandidates: number } {
    return {
      running: this.running,
      lastRun: this.lastRun ? { ...this.lastRun } : null,
      totalCandidates: this.candidates.size
    };
  }

  public getLogs(limit = 200): DiscoveryLogEntry[] {
    const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 200));
    return this.logs
      .slice(-safeLimit)
      .map((item) => ({ ...item }));
  }

  public updateCandidateStatus(id: string, status: DiscoveryCandidateStatus): DiscoveryCandidate | null {
    const found = this.candidates.get(id);
    if (!found) return null;
    found.status = status;
    found.lastSeenAt = nowIso();
    this.log("candidate.status_changed", "info", `${found.title} status -> ${status}`, found.id, "manual");
    return { ...found };
  }

  public async runScan(): Promise<DiscoveryRunResult> {
    if (this.running) {
      throw new Error("discovery scan already running");
    }
    this.running = true;
    const startedAt = nowIso();
    this.log("scan.started", "info", "Discovery scan started");
    const errors: string[] = [];
    let scanned = 0;
    let upserted = 0;

    try {
      const mcp = await this.scanMcpRegistry().catch((err) => {
        errors.push(`mcp_registry: ${toErrorMessage(err)}`);
        this.log("scan.error", "error", `MCP scan failed: ${toErrorMessage(err)}`, undefined, "mcp_registry");
        return { scanned: 0, upserted: 0 };
      });
      scanned += mcp.scanned;
      upserted += mcp.upserted;

      const a2a = await this.scanA2ASeeds().catch((err) => {
        errors.push(`a2a_seeds: ${toErrorMessage(err)}`);
        this.log("scan.error", "error", `A2A scan failed: ${toErrorMessage(err)}`, undefined, "a2a_seeds");
        return { scanned: 0, upserted: 0 };
      });
      scanned += a2a.scanned;
      upserted += a2a.upserted;
    } finally {
      this.running = false;
    }

    const result: DiscoveryRunResult = {
      startedAt,
      finishedAt: nowIso(),
      scanned,
      upserted,
      errors
    };
    this.lastRun = result;
    this.log(
      "scan.finished",
      errors.length > 0 ? "warn" : "info",
      `Discovery scan finished: scanned=${scanned}, upserted=${upserted}, errors=${errors.length}`
    );
    return { ...result, errors: [...result.errors] };
  }

  private async scanMcpRegistry(): Promise<{ scanned: number; upserted: number }> {
    let cursor: string | undefined;
    let scanned = 0;
    let upserted = 0;

    for (let page = 0; page < this.options.mcpPageLimit; page += 1) {
      const url = new URL(this.options.mcpRegistryUrl);
      url.searchParams.set("limit", "100");
      if (cursor) {
        url.searchParams.set("cursor", cursor);
      }
      const response = await this.fetchJson<McpServerListResponse>(url.toString());
      const servers = Array.isArray(response.servers) ? response.servers : [];
      for (const item of servers) {
        const server = item.server;
        if (!server?.name) continue;
        scanned += 1;

        const remotes = Array.isArray(server.remotes) ? server.remotes : [];
        const firstRemote = remotes.find((remote) => typeof remote?.url === "string" && remote.url.length > 0);
        const endpointUrl = String(firstRemote?.url || "").trim();
        const homepageUrl = String(server.websiteUrl || server.repository?.url || "").trim();
        const auth = firstRemote?.headers && firstRemote.headers.length > 0 ? "headers_required" : "unknown";
        const capabilities = remotes
          .map((remote) => String(remote?.type || "").trim())
          .filter(Boolean)
          .map((type) => `transport:${type}`);

        const candidate = this.upsertCandidate({
          id: `mcp:${server.name.toLowerCase()}`,
          title: String(server.title || server.name),
          description: String(server.description || ""),
          homepageUrl,
          endpointUrl,
          protocols: ["mcp"],
          capabilities,
          auth,
          joinability: endpointUrl ? "manual" : "unknown",
          sourceKind: "mcp_registry"
        });
        if (candidate) {
          upserted += 1;
          this.log(
            "candidate.found",
            "info",
            `MCP candidate found: ${candidate.title}`,
            candidate.id,
            "mcp_registry"
          );
        }
      }

      cursor = response.metadata?.nextCursor;
      if (!cursor) break;
    }
    return { scanned, upserted };
  }

  private async scanA2ASeeds(): Promise<{ scanned: number; upserted: number }> {
    const seeds = await this.buildA2ASeedUrls();
    let scanned = 0;
    let upserted = 0;
    for (const cardUrl of seeds) {
      scanned += 1;
      this.log("probe.sent", "info", `Probing A2A card: ${cardUrl}`, undefined, "a2a_card");
      try {
        const card = await this.fetchJson<A2AAgentCard>(cardUrl);
        this.log("probe.responded", "info", `A2A card responded: ${cardUrl}`, undefined, "a2a_card");
        const endpoint = String(card.a2aEndpoint || card.endpoints?.a2a || "").trim();
        const homepageUrl = String(card.url || toOrigin(cardUrl) || "").trim();
        const auth = Array.isArray(card.authentication?.schemes)
          ? card.authentication?.schemes.join(",")
          : card.securitySchemes
            ? "security_schemes"
            : "unknown";
        const capabilities = extractSkillTags(card.skills);

        const candidate = this.upsertCandidate({
          id: `a2a:${normalizeIdComponent(homepageUrl || cardUrl)}`,
          title: String(card.name || homepageUrl || cardUrl),
          description: String(card.description || ""),
          homepageUrl,
          endpointUrl: endpoint,
          protocols: ["a2a"],
          capabilities,
          auth,
          joinability: endpoint ? "connectable" : "unknown",
          sourceKind: "a2a_card"
        });
        if (candidate) {
          upserted += 1;
          this.log(
            "candidate.found",
            "info",
            `A2A candidate found: ${candidate.title}`,
            candidate.id,
            "a2a_card"
          );
        }
      } catch (error) {
        this.log("probe.failed", "warn", `A2A probe failed: ${cardUrl} (${toErrorMessage(error)})`, undefined, "a2a_card");
      }
    }
    return { scanned, upserted };
  }

  private async buildA2ASeedUrls(): Promise<string[]> {
    const seedSet = new Set<string>();
    for (const raw of this.options.a2aSeeds) {
      toA2ACardUrl(raw).forEach((url) => seedSet.add(url));
    }

    const directory = await this.store.listDirectoryAgents();
    for (const item of directory) {
      toA2ACardUrl(item.endpointUrl).forEach((url) => seedSet.add(url));
    }
    return Array.from(seedSet).slice(0, 200);
  }

  private upsertCandidate(input: {
    id: string;
    title: string;
    description: string;
    homepageUrl: string;
    endpointUrl: string;
    protocols: DiscoveryProtocol[];
    capabilities: string[];
    auth: string;
    joinability: DiscoveryJoinability;
    sourceKind: string;
  }): DiscoveryCandidate {
    const now = nowIso();
    const existing = this.candidates.get(input.id);
    const mergedProtocols = dedupeStrings([...(existing?.protocols || []), ...input.protocols]) as DiscoveryProtocol[];
    const mergedCaps = dedupeStrings([...(existing?.capabilities || []), ...input.capabilities]);
    const mergedSourceKinds = dedupeStrings([...(existing?.sourceKinds || []), input.sourceKind]);

    const candidate: DiscoveryCandidate = {
      id: input.id,
      title: input.title || existing?.title || "Unknown candidate",
      description: input.description || existing?.description || "",
      homepageUrl: input.homepageUrl || existing?.homepageUrl || "",
      endpointUrl: input.endpointUrl || existing?.endpointUrl || "",
      protocols: mergedProtocols,
      capabilities: mergedCaps,
      auth: input.auth || existing?.auth || "unknown",
      joinability: pickJoinability(existing?.joinability, input.joinability),
      trustScore: 0,
      status: existing?.status || "new",
      sourceKinds: mergedSourceKinds,
      firstSeenAt: existing?.firstSeenAt || now,
      lastSeenAt: now
    };
    candidate.trustScore = scoreCandidate(candidate);
    if (candidate.trustScore >= this.options.contactThreshold && candidate.status === "new") {
      candidate.status = "qualified";
      this.log(
        "candidate.contact_queued",
        "info",
        `Candidate queued for outreach: ${candidate.title} (score ${candidate.trustScore})`,
        candidate.id,
        input.sourceKind
      );
    }
    this.candidates.set(candidate.id, candidate);
    return candidate;
  }

  private log(
    type: string,
    level: DiscoveryLogEntry["level"],
    summary: string,
    candidateId?: string,
    source?: string
  ): void {
    this.logs.push({
      id: newId(),
      timestamp: nowIso(),
      type,
      level,
      summary,
      candidateId,
      source
    });
    const overflow = this.logs.length - this.options.maxLogs;
    if (overflow > 0) {
      this.logs.splice(0, overflow);
    }
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.fetchTimeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          "accept": "application/json"
        },
        signal: controller.signal
      });
      if (!res.ok) {
        throw new Error(`http_${res.status}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseSeeds(raw: string): string[] {
  return String(raw || "")
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function scoreCandidate(candidate: DiscoveryCandidate): number {
  let score = 0;
  if (candidate.protocols.includes("mcp")) score += 35;
  if (candidate.protocols.includes("a2a")) score += 30;
  if (candidate.endpointUrl.startsWith("https://")) score += 15;
  if (candidate.homepageUrl.startsWith("https://")) score += 8;
  if (candidate.capabilities.length >= 3) score += 8;
  if (candidate.auth.includes("none")) score += 6;
  if (candidate.joinability === "connectable") score += 10;
  if (candidate.description.length >= 30) score += 6;
  return Math.max(0, Math.min(100, score));
}

function dedupeStrings(items: string[]): string[] {
  return Array.from(
    new Set(
      items
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    )
  );
}

function extractSkillTags(skills: A2AAgentCard["skills"]): string[] {
  if (!Array.isArray(skills)) return [];
  const tags: string[] = [];
  for (const skill of skills) {
    if (!skill) continue;
    if (typeof skill.id === "string" && skill.id.trim()) tags.push(`skill:${skill.id.trim()}`);
    if (typeof skill.name === "string" && skill.name.trim()) tags.push(`skill:${skill.name.trim()}`);
    if (Array.isArray(skill.tags)) tags.push(...skill.tags);
  }
  return dedupeStrings(tags).slice(0, 40);
}

function toA2ACardUrl(raw: string): string[] {
  const value = String(raw || "").trim();
  if (!value) return [];
  try {
    const parsed = new URL(value);
    if (parsed.pathname.endsWith("/agent-card.json")) return [parsed.toString()];
    if (parsed.pathname === "/" || parsed.pathname === "") {
      return [`${parsed.origin}/.well-known/agent-card.json`];
    }
    return [
      `${parsed.origin}/.well-known/agent-card.json`,
      parsed.toString()
    ];
  } catch {
    if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(value)) {
      return [`https://${value}/.well-known/agent-card.json`];
    }
    return [];
  }
}

function toOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function normalizeIdComponent(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9:_/-]+/g, "-").slice(0, 120);
}

function pickJoinability(
  existing: DiscoveryJoinability | undefined,
  incoming: DiscoveryJoinability
): DiscoveryJoinability {
  if (incoming === "connectable") return incoming;
  if (existing === "connectable") return existing;
  if (incoming === "manual") return incoming;
  return existing || incoming;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
