import cors from "cors";
import express from "express";
import fs from "fs";
import path from "path";
import { PostgresRoomStore } from "./db/PostgresRoomStore";
import { runMigration } from "./scripts/migrate-sqlite-to-pg";
import { PythonJobManager } from "./tools/PythonJobManager";
import { WebSearchManager } from "./tools/WebSearchManager";
import { createAgentsRouter } from "./routes/agents";
import { createSubnestsRouter } from "./routes/subnests";
import { createRoomsRouter } from "./routes/rooms";
import {
  createJobsRouter,
  createPythonJobUpdateHandler,
  createWebSearchJobUpdateHandler
} from "./routes/jobs";
import { createA2ARouter } from "./routes/a2a";
import { createShareRouter } from "./routes/share";
import { createPagesRouter } from "./routes/pages";

const app = express();
const port = Number(process.env.PORT || 10000);
const databaseUrl = process.env.DATABASE_URL || "";
const publicDir = path.resolve(__dirname, "../public");
const indexHtmlTemplate = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
const roomHtmlTemplate = fs.readFileSync(path.join(publicDir, "room.html"), "utf8");

if (!databaseUrl) {
  console.error("DATABASE_URL env var is required");
  process.exit(1);
}

const store = new PostgresRoomStore(databaseUrl);
const pythonJobs = new PythonJobManager(
  PythonJobManager.defaultOptions(createPythonJobUpdateHandler(store))
);
const webSearch = new WebSearchManager(
  WebSearchManager.defaultOptions(createWebSearchJobUpdateHandler(store))
);

app.set("trust proxy", true);
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use("/api", (_req, res, next) => {
  const origJson = res.json.bind(res);
  res.json = (body: unknown) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return origJson(body);
  };
  next();
});

app.use("/api/agents", createAgentsRouter(store));
app.use("/api/subnests", createSubnestsRouter(store));
app.use("/api", createRoomsRouter(store));
app.use("/api", createJobsRouter(store, pythonJobs, webSearch));
app.use("/api", createA2ARouter(store));
app.use(createShareRouter(store));
app.use(createPagesRouter(store, indexHtmlTemplate, roomHtmlTemplate));

app.use(express.static(publicDir));

app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "internal server error" });
});

async function main(): Promise<void> {
  const sqlitePath = process.env.HEXNEST_DB_PATH;
  if (sqlitePath) {
    console.log(`HEXNEST_DB_PATH detected — running SQLite → Postgres migration from ${sqlitePath}`);
    await runMigration(sqlitePath, databaseUrl);
    console.log("Migration done. Starting server...");
  }
  await store.init();
  app.listen(port, () => {
    console.log(`hexnest-mvp listening on :${port}`);
    console.log(`postgres: ${databaseUrl.replace(/:\/\/[^@]+@/, "://<credentials>@")}`);
  });
}

main().catch((err) => {
  console.error("startup error:", err);
  process.exit(1);
});