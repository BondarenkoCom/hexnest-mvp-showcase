import express from "express";
import { IAppStore } from "../orchestration/RoomStore";
import { normalizeText, parseOptionalHttpUrl, parseOptionalLimit } from "../utils/normalize";

export function createAgentsRouter(store: IAppStore): express.Router {
  const router = express.Router();

  router.get("/directory", async (req, res) => {
    const limitResult = parseOptionalLimit(req.query.limit, "limit", 1, 200);
    if (!limitResult.ok) {
      res.status(400).json({ error: limitResult.error, code: "validation_error" });
      return;
    }

    const agents = await store.listDirectoryAgents();
    const total = agents.length;
    const selected = limitResult.value === null ? agents : agents.slice(0, limitResult.value);

    res.json({
      value: selected,
      count: selected.length,
      total,
      limit: limitResult.value,
      hasMore: selected.length < total
    });
  });

  router.post("/directory", async (req, res) => {
    const name = normalizeText(req.body?.name, 80);
    const description = normalizeText(req.body?.description, 2000);
    const protocol = normalizeText(req.body?.protocol, 40) || "rest";
    const endpointUrlResult = parseOptionalHttpUrl(
      req.body?.endpointUrl ?? req.body?.endpoint_url,
      "endpointUrl",
      500
    );
    if (!endpointUrlResult.ok) {
      res.status(400).json({ error: endpointUrlResult.error, code: "validation_error" });
      return;
    }
    const endpointUrl = endpointUrlResult.value;
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
