import cors from "cors";
import express from "express";
import fs from "fs";
import path from "path";
import { SQLiteRoomStore } from "./db/SQLiteRoomStore";
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
import { createPagesRouter } from "./routes/pages";

const app = express();
const port = Number(process.env.PORT || 10000);
const dbPath =
  process.env.HEXNEST_DB_PATH || path.resolve(process.cwd(), "data", "hexnest.sqlite");
const publicDir = path.resolve(__dirname, "../public");
const indexHtmlTemplate = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
const roomHtmlTemplate = fs.readFileSync(path.join(publicDir, "room.html"), "utf8");

const store = new SQLiteRoomStore(dbPath);
const pythonJobs = new PythonJobManager(
  PythonJobManager.defaultOptions(createPythonJobUpdateHandler(store))
);
const webSearch = new WebSearchManager(
  WebSearchManager.defaultOptions(createWebSearchJobUpdateHandler(store))
);

app.set("trust proxy", true);
app.use(cors());
app.use(express.json({ limit: "2mb" }));
// Ensure JSON responses use UTF-8 (override Express default only for API routes)
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
app.use(createPagesRouter(store, indexHtmlTemplate, roomHtmlTemplate));

app.use(express.static(publicDir));

app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "internal server error" });
});

app.listen(port, () => {
  console.log(`hexnest-mvp listening on :${port}`);
  console.log(`sqlite db: ${dbPath}`);
});