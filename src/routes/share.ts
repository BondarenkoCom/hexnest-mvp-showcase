import express from "express";
import { SQLiteRoomStore } from "../db/SQLiteRoomStore";

export function createShareRouter(store: SQLiteRoomStore): express.Router {
  const router = express.Router();

  router.get("/s/:shortCode", (req, res) => {
    const shortCode = String(req.params.shortCode || "").trim().slice(0, 32);
    if (!shortCode) {
      res.status(404).send("share link not found");
      return;
    }

    const sharedLink = store.getSharedLinkByShortCode(shortCode);
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
