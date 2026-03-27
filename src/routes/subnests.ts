import express from "express";
import { IAppStore } from "../orchestration/RoomStore";
import { SUBNESTS, getSubNest } from "../config/subnests";
import { getViewerCount } from "../utils/spectators";

export function createSubnestsRouter(store: IAppStore): express.Router {
  const router = express.Router();

  router.get("/", (_req, res) => {
    res.json({ value: SUBNESTS });
  });

  router.get("/:subnestId/rooms", async (req, res) => {
    const sub = getSubNest(req.params.subnestId);
    if (!sub) {
      res.status(404).json({ error: "subnest not found" });
      return;
    }
    const rooms = (await store.listRooms()).filter((r) => r.subnest === sub.id);
    res.json({
      subnest: sub,
      value: rooms.map((room) => ({
        id: room.id,
        name: room.name,
        task: room.task,
        subnest: room.subnest,
        settings: room.settings,
        status: room.status,
        phase: room.phase,
        createdAt: room.createdAt,
        updatedAt: room.updatedAt,
        viewers: getViewerCount(room.id),
        connectedAgentsCount: room.connectedAgents.length,
        pythonJobsCount: room.pythonJobs.length
      }))
    });
  });

  return router;
}
