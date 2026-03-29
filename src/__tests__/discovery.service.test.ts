import { describe, expect, it, vi } from "vitest";
import { DiscoveryService } from "../discovery/DiscoveryService";

describe("DiscoveryService", () => {
  it("scans MCP registry and A2A card seeds into candidates", async () => {
    const store = {
      async listDirectoryAgents() {
        return [
          {
            id: "dir-1",
            name: "A2A Seed",
            description: "seed",
            protocol: "a2a",
            endpointUrl: "https://seed.example.com",
            owner: "owner",
            category: "utility",
            status: "approved" as const,
            createdAt: "2026-03-29T00:00:00.000Z"
          }
        ];
      }
    };

    const fetchMock: typeof fetch = async (input: unknown): Promise<Response> => {
      const url = String(input);
      if (url.startsWith("https://registry.modelcontextprotocol.io/v0.1/servers")) {
        return new Response(
          JSON.stringify({
            servers: [
              {
                server: {
                  name: "io.test/sample-mcp",
                  title: "Sample MCP",
                  description: "Sample MCP server",
                  websiteUrl: "https://sample.example.com",
                  remotes: [{ type: "streamable-http", url: "https://sample.example.com/mcp" }]
                }
              }
            ],
            metadata: {}
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      if (url === "https://seed.example.com/.well-known/agent-card.json") {
        return new Response(
          JSON.stringify({
            name: "Seed Agent",
            description: "Seed A2A agent",
            url: "https://seed.example.com",
            a2aEndpoint: "https://seed.example.com/api/a2a",
            authentication: { schemes: ["none"] },
            skills: [{ id: "debate", name: "Debate", tags: ["argue", "reason"] }]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      return new Response("not found", { status: 404 });
    };

    const service = new DiscoveryService(store, fetchMock, {
      mcpPageLimit: 1,
      a2aSeeds: []
    });

    const result = await service.runScan();
    expect(result.scanned).toBe(2);
    expect(result.upserted).toBe(2);
    expect(result.errors).toEqual([]);

    const candidates = service.getCandidates();
    expect(candidates).toHaveLength(2);
    expect(candidates.some((item) => item.protocols.includes("mcp"))).toBe(true);
    expect(candidates.some((item) => item.protocols.includes("a2a"))).toBe(true);
  });

  it("runs queued handshakes and marks candidate as connected on response", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-29T00:00:00.000Z"));

    const store = {
      async listDirectoryAgents() {
        return [
          {
            id: "dir-1",
            name: "Seed Agent",
            description: "seed",
            protocol: "a2a",
            endpointUrl: "https://seed.example.com",
            owner: "owner",
            category: "utility",
            status: "approved" as const,
            createdAt: "2026-03-29T00:00:00.000Z"
          }
        ];
      }
    };

    const fetchMock: typeof fetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = String(init?.method || "GET").toUpperCase();

      if (method === "GET" && url === "https://seed.example.com/.well-known/agent-card.json") {
        return new Response(
          JSON.stringify({
            name: "Seed Agent",
            description: "Seed A2A agent",
            url: "https://seed.example.com",
            a2aEndpoint: "https://seed.example.com/api/a2a",
            authentication: { schemes: ["none"] },
            skills: [{ id: "debate", name: "Debate", tags: ["argue", "reason"] }]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      if (method === "OPTIONS" && url === "https://seed.example.com/api/a2a") {
        return new Response(null, { status: 204 });
      }

      return new Response("not found", { status: 404 });
    };

    const service = new DiscoveryService(store, fetchMock, {
      mcpPageLimit: 0
    });

    await service.runScan();
    let candidates = service.getCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].status).toBe("qualified");
    expect(Boolean(candidates[0].nextHandshakeAt)).toBe(true);

    vi.setSystemTime(new Date("2026-03-30T01:00:00.000Z"));
    const handshake = await service.runHandshakeQueue();

    expect(handshake.attempted).toBe(1);
    expect(handshake.connected).toBe(1);
    expect(handshake.failed).toBe(0);

    candidates = service.getCandidates();
    expect(candidates[0].status).toBe("connected");
    expect(candidates[0].lastHandshakeStatus).toBe("ok");
    expect(candidates[0].nextHandshakeAt).toBeUndefined();

    vi.useRealTimers();
  });
});
