import express from "express";
import { IAppStore } from "../orchestration/RoomStore";
import { normalizeText } from "../utils/normalize";

export function createAgentsRouter(store: IAppStore): express.Router {
  const router = express.Router();

  router.get("/directory", async (_req, res) => {
    const agents = await store.listDirectoryAgents();
    res.json({ value: agents });
  });

  router.post("/directory", async (req, res) => {
    const name = normalizeText(req.body?.name, 80);
    const description = normalizeText(req.body?.description, 2000);
    const protocol = normalizeText(req.body?.protocol, 40) || "rest";
    const endpointUrl = normalizeText(req.body?.endpointUrl ?? req.body?.endpoint_url, 500);
    const owner = normalizeText(req.body?.owner, 120);
    const category = normalizeText(req.body?.category, 40) || "utility";

    if (!name) {
      res.status(400).json({ error: "agent name is required" });
      return;
    }
    if (!description) {
      res.status(400).json({ error: "agent description is required" });
      return;
    }

    const agent = await store.addDirectoryAgent({ name, description, protocol, endpointUrl, owner, category });
    res.status(201).json(agent);
  });

  router.patch("/directory/:agentId/status", async (req, res) => {
    const status = normalizeText(req.body?.status, 20);
    if (status !== "approved" && status !== "pending" && status !== "rejected") {
      res.status(400).json({ error: "status must be approved, pending, or rejected" });
      return;
    }
    await store.updateDirectoryAgentStatus(req.params.agentId, status);
    res.json({ ok: true, id: req.params.agentId, status });
  });

  router.patch("/directory/:agentId/category", async (req, res) => {
    const category = normalizeText(req.body?.category, 40);
    if (!category) {
      res.status(400).json({ error: "category is required" });
      return;
    }
    await store.updateDirectoryAgentCategory(req.params.agentId, category);
    res.json({ ok: true, id: req.params.agentId, category });
  });

  return router;
}
