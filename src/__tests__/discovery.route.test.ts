import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createDiscoveryRouter } from "../routes/discovery";

function buildApp(service: any): express.Application {
  const app = express();
  app.use(express.json());
  app.use("/api", createDiscoveryRouter(service));
  return app;
}

describe("discovery routes", () => {
  it("returns candidates list", async () => {
    const service = {
      getStatus: () => ({ running: false, lastRun: null, totalCandidates: 1 }),
      getCandidates: () => [
        {
          id: "c-1",
          title: "Candidate",
          description: "",
          homepageUrl: "",
          endpointUrl: "",
          protocols: ["a2a"],
          capabilities: [],
          auth: "none",
          joinability: "connectable",
          trustScore: 55,
          status: "new",
          sourceKinds: ["a2a_card"],
          firstSeenAt: "2026-03-29T00:00:00.000Z",
          lastSeenAt: "2026-03-29T00:00:00.000Z"
        }
      ],
      runScan: async () => ({ startedAt: "", finishedAt: "", scanned: 0, upserted: 0, errors: [] }),
      updateCandidateStatus: () => null
    };

    const res = await request(buildApp(service)).get("/api/discovery/candidates");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.value[0].id).toBe("c-1");
  });

  it("requires admin secret for scan", async () => {
    const service = {
      getStatus: () => ({ running: false, lastRun: null, totalCandidates: 0 }),
      getCandidates: () => [],
      runScan: async () => ({ startedAt: "", finishedAt: "", scanned: 0, upserted: 0, errors: [] }),
      updateCandidateStatus: () => null
    };

    const app = buildApp(service);
    const noAuth = await request(app).post("/api/discovery/scan");
    expect(noAuth.status).toBe(401);

    const withAuth = await request(app)
      .post("/api/discovery/scan")
      .set("x-admin-secret", "hexnest-admin-local");
    expect(withAuth.status).toBe(200);
    expect(withAuth.body.ok).toBe(true);
  });

  it("updates candidate status with admin auth", async () => {
    const service = {
      getStatus: () => ({ running: false, lastRun: null, totalCandidates: 0 }),
      getCandidates: () => [],
      runScan: async () => ({ startedAt: "", finishedAt: "", scanned: 0, upserted: 0, errors: [] }),
      updateCandidateStatus: (_id: string, status: string) => ({ id: "c-1", status })
    };

    const app = buildApp(service);

    const badStatus = await request(app)
      .patch("/api/discovery/candidates/c-1/status")
      .set("x-admin-secret", "hexnest-admin-local")
      .send({ status: "broken" });
    expect(badStatus.status).toBe(400);

    const ok = await request(app)
      .patch("/api/discovery/candidates/c-1/status")
      .set("x-admin-secret", "hexnest-admin-local")
      .send({ status: "approved" });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("approved");
  });
});
