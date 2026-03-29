import express from "express";
import { DiscoveryService } from "../discovery/DiscoveryService";
import { DiscoveryCandidateStatus, DiscoveryProtocol } from "../discovery/types";
import { requireAdmin } from "../utils/auth";

const ALLOWED_STATUSES: DiscoveryCandidateStatus[] = [
  "new",
  "qualified",
  "approved",
  "rejected",
  "connected"
];

const ALLOWED_PROTOCOLS: DiscoveryProtocol[] = ["a2a", "mcp", "openapi", "webhook", "rest"];

export function createDiscoveryRouter(service: DiscoveryService): express.Router {
  const router = express.Router();

  router.get("/discovery/status", (_req, res) => {
    res.json(service.getStatus());
  });

  router.get("/discovery/candidates", (req, res) => {
    const statusRaw = String(req.query.status || "").trim();
    const protocolRaw = String(req.query.protocol || "").trim();
    const minScoreRaw = Number(req.query.minScore);

    const status = ALLOWED_STATUSES.includes(statusRaw as DiscoveryCandidateStatus)
      ? (statusRaw as DiscoveryCandidateStatus)
      : undefined;
    const protocol = ALLOWED_PROTOCOLS.includes(protocolRaw as DiscoveryProtocol)
      ? (protocolRaw as DiscoveryProtocol)
      : undefined;
    const minScore = Number.isFinite(minScoreRaw) ? minScoreRaw : undefined;

    const items = service.getCandidates({ status, protocol, minScore });
    res.json({
      count: items.length,
      value: items
    });
  });

  router.get("/discovery/logs", (req, res) => {
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? limitRaw : 200;
    const value = service.getLogs(limit);
    res.json({ count: value.length, value });
  });

  router.post("/discovery/scan", requireAdmin, async (_req, res, next) => {
    try {
      const result = await service.runScan();
      res.json({ ok: true, result });
    } catch (error) {
      next(error);
    }
  });

  router.post("/discovery/handshake", requireAdmin, async (_req, res, next) => {
    try {
      const result = await service.runHandshakeQueue();
      res.json({ ok: true, result });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/discovery/candidates/:id/status", requireAdmin, (req, res) => {
    const status = String(req.body?.status || "").trim() as DiscoveryCandidateStatus;
    if (!ALLOWED_STATUSES.includes(status)) {
      res.status(400).json({ error: "invalid status" });
      return;
    }
    const updated = service.updateCandidateStatus(req.params.id, status);
    if (!updated) {
      res.status(404).json({ error: "candidate not found" });
      return;
    }
    res.json(updated);
  });

  return router;
}
