import express from "express";
import { IAppStore } from "../orchestration/RoomStore";

export function createShareRouter(store: IAppStore): express.Router {
  const router = express.Router();

  router.get("/s/:shortCode", async (req, res) => {
    const shortCode = String(req.params.shortCode || "").trim().slice(0, 32);
    if (!shortCode) {
      res.status(404).send("share link not found");
      return;
    }

    const sharedLink = await store.getSharedLinkByShortCode(shortCode);
    if (!sharedLink) {
      res.status(404).send("share link not found");
      return;
    }

    res.redirect(
      `/r/${encodeURIComponent(sharedLink.roomId)}?msg=${encodeURIComponent(sharedLink.messageId)}`
    );
  });

  return router;
}
