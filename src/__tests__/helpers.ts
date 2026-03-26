import express from "express";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { SQLiteRoomStore } from "../db/SQLiteRoomStore";

export function tempDbPath(): string {
  return path.join(os.tmpdir(), `hexnest-test-${randomUUID()}.sqlite`);
}

export function buildTestApp(
  store: SQLiteRoomStore,
  ...middlewares: express.RequestHandler[]
): express.Application {
  const app = express();
  app.use(express.json());
  for (const mw of middlewares) {
    app.use(mw);
  }
  return app;
}
