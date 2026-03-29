import cors from "cors";
import express from "express";
import fs from "fs";
import path from "path";
import pgMigrate from "node-pg-migrate";
import { PostgresRoomStore } from "./db/PostgresRoomStore";
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
import { createApiDocsRouter } from "./routes/api-docs";
import { createShareRouter } from "./routes/share";
import { createPagesRouter } from "./routes/pages";
import { createIdentityRouter } from "./routes/identity";
import { createWebhooksRouter } from "./routes/webhooks";
import { createInternalWebhookInboxRouter } from "./routes/internal-webhook-inbox";
import { createDiscoveryRouter } from "./routes/discovery";
import { createAuthMiddleware } from "./middleware/auth";
import {
  createApiJsonParseErrorHandler,
  createApiResponseMiddleware,
  getRequestId
} from "./middleware/api-response";
import { createWriteRateLimitMiddleware } from "./middleware/rate-limit";
import { seedDirectoryAgents } from "./scripts/seed-agents";
import { WebhookDispatcher } from "./webhooks/WebhookDispatcher";
import { cleanupInactiveRooms } from "./utils/inactive-room-cleanup";
import { DiscoveryService } from "./discovery/DiscoveryService";

const app = express();
const port = Number(process.env.PORT || 10000);
const databaseUrl = process.env.DATABASE_URL || "";
const publicDir = path.resolve(__dirname, "../public");
const indexHtmlTemplate = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
const roomHtmlTemplate = fs.readFileSync(path.join(publicDir, "room.html"), "utf8");
const roomInactivityDeleteHours = Math.max(
  0,
  Number(process.env.HEXNEST_ROOM_INACTIVITY_DELETE_HOURS || 0)
);
const roomCleanupIntervalMs = Math.max(
  10_000,
  Number(process.env.HEXNEST_ROOM_CLEANUP_INTERVAL_MS || 60 * 60 * 1000)
);
const discoveryScanIntervalMs = Math.max(
  60_000,
  Number(process.env.HEXNEST_DISCOVERY_SCAN_INTERVAL_MS || 6 * 60 * 60 * 1000)
);
const discoveryScanOnStart = process.env.HEXNEST_DISCOVERY_SCAN_ON_START !== "false";
const discoveryHandshakeEnabled = process.env.HEXNEST_DISCOVERY_HANDSHAKE_ENABLED !== "false";
const discoveryHandshakeIntervalMs = Math.max(
  60_000,
  Number(process.env.HEXNEST_DISCOVERY_HANDSHAKE_INTERVAL_MS || 60 * 60 * 1000)
);
const discoveryHandshakeOnStart = process.env.HEXNEST_DISCOVERY_HANDSHAKE_ON_START !== "false";

if (!databaseUrl) {
  console.error("DATABASE_URL env var is required");
  process.exit(1);
}

const store = new PostgresRoomStore(databaseUrl);
const webhooks = new WebhookDispatcher(store);
const discovery = new DiscoveryService(store);
const pythonJobs = new PythonJobManager(
  PythonJobManager.defaultOptions(createPythonJobUpdateHandler(store, webhooks))
);
const webSearch = new WebSearchManager(
  WebSearchManager.defaultOptions(createWebSearchJobUpdateHandler(store, webhooks))
);

app.set("trust proxy", true);
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(createApiJsonParseErrorHandler());
app.use("/api", createApiResponseMiddleware());
app.use("/api", createWriteRateLimitMiddleware());
app.use(createAuthMiddleware(store));

app.use(createApiDocsRouter());
app.use("/api/agents", createAgentsRouter(store));
app.use("/api/subnests", createSubnestsRouter(store));
app.use("/api", createIdentityRouter(store));
app.use("/api", createWebhooksRouter(store, webhooks));
app.use("/api", createDiscoveryRouter(discovery));
app.use("/api", createInternalWebhookInboxRouter());
app.use("/api", createRoomsRouter(store, webhooks));
app.use("/api", createJobsRouter(store, pythonJobs, webSearch));
app.use("/api", createA2ARouter(store, webhooks));
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "api endpoint not found", code: "not_found" });
});
app.use(createShareRouter(store));
app.use(createPagesRouter(store, indexHtmlTemplate, roomHtmlTemplate));

app.use(express.static(publicDir));

app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const requestId = getRequestId(req);
  console.error(
    `[${requestId}] ${req.method} ${req.originalUrl} failed:`,
    err instanceof Error && err.stack ? err.stack : err
  );

  if (req.path.startsWith("/api")) {
    const statusCode = Number((err as { status?: unknown; statusCode?: unknown }).status
      ?? (err as { statusCode?: unknown }).statusCode);
    const safeStatus = Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600
      ? statusCode
      : 500;
    const message = safeStatus >= 500
      ? "internal server error"
      : (err instanceof Error ? err.message : "request failed");
    res.status(safeStatus).json({
      error: message,
      code: safeStatus >= 500 ? "internal_error" : "request_failed"
    });
    return;
  }

  res.status(500).type("text/plain").send("Internal Server Error");
});

async function main(): Promise<void> {
  console.log("Running DB migrations...");
  await pgMigrate({
    databaseUrl,
    dir: path.join(__dirname, "migrations"),
    direction: "up",
    migrationsTable: "pgmigrations",
    log: (msg: string) => console.log("[migrate]", msg)
  });
  console.log("Migrations complete.");

  await store.init();
  await seedDirectoryAgents(store);
  let roomCleanupRunning = false;
  let discoveryScanRunning = false;
  let discoveryHandshakeRunning = false;
  const runRoomCleanup = async (): Promise<void> => {
    if (roomInactivityDeleteHours <= 0 || roomCleanupRunning) {
      return;
    }

    roomCleanupRunning = true;
    try {
      const result = await cleanupInactiveRooms(store, webhooks, {
        inactivityMs: roomInactivityDeleteHours * 60 * 60 * 1000
      });
      if (result.deletedRoomIds.length > 0 || result.failedRoomIds.length > 0) {
        console.log(
          `[cleanup] scanned=${result.scanned} deleted=${result.deletedRoomIds.length} failed=${result.failedRoomIds.length}`
        );
      }
    } catch (error) {
      console.error("[cleanup] room inactivity cleanup failed:", error);
    } finally {
      roomCleanupRunning = false;
    }
  };
  const runDiscoveryScan = async (): Promise<void> => {
    if (discoveryScanRunning) {
      return;
    }
    discoveryScanRunning = true;
    try {
      const result = await discovery.runScan();
      console.log(
        `[discovery] scanned=${result.scanned} upserted=${result.upserted} errors=${result.errors.length}`
      );
    } catch (error) {
      console.error("[discovery] scan failed:", error);
    } finally {
      discoveryScanRunning = false;
    }
  };
  const runDiscoveryHandshake = async (): Promise<void> => {
    if (!discoveryHandshakeEnabled || discoveryHandshakeRunning) {
      return;
    }
    discoveryHandshakeRunning = true;
    try {
      const result = await discovery.runHandshakeQueue();
      if (result.attempted > 0 || result.failed > 0) {
        console.log(
          `[discovery-handshake] considered=${result.considered} attempted=${result.attempted} connected=${result.connected} failed=${result.failed}`
        );
      }
    } catch (error) {
      console.error("[discovery-handshake] queue failed:", error);
    } finally {
      discoveryHandshakeRunning = false;
    }
  };
  app.listen(port, () => {
    console.log(`hexnest-mvp listening on :${port}`);
    console.log(`postgres: ${databaseUrl.replace(/:\/\/[^@]+@/, "://<credentials>@")}`);
    if (roomInactivityDeleteHours > 0) {
      const interval = setInterval(() => {
        void runRoomCleanup();
      }, roomCleanupIntervalMs);
      interval.unref();
      void runRoomCleanup();
      console.log(
        `[cleanup] enabled: delete rooms inactive for >= ${roomInactivityDeleteHours}h, check every ${Math.round(roomCleanupIntervalMs / 1000)}s`
      );
    } else {
      console.log("[cleanup] disabled: HEXNEST_ROOM_INACTIVITY_DELETE_HOURS <= 0");
    }

    const discoveryInterval = setInterval(() => {
      void runDiscoveryScan();
    }, discoveryScanIntervalMs);
    discoveryInterval.unref();
    if (discoveryScanOnStart) {
      void runDiscoveryScan();
    }
    console.log(
      `[discovery] enabled: scan every ${Math.round(discoveryScanIntervalMs / 1000)}s` +
      `${discoveryScanOnStart ? " (startup scan enabled)" : " (startup scan disabled)"}`
    );

    if (discoveryHandshakeEnabled) {
      const handshakeInterval = setInterval(() => {
        void runDiscoveryHandshake();
      }, discoveryHandshakeIntervalMs);
      handshakeInterval.unref();
      if (discoveryHandshakeOnStart) {
        void runDiscoveryHandshake();
      }
      console.log(
        `[discovery-handshake] enabled: run every ${Math.round(discoveryHandshakeIntervalMs / 1000)}s` +
        `${discoveryHandshakeOnStart ? " (startup run enabled)" : " (startup run disabled)"}`
      );
    } else {
      console.log("[discovery-handshake] disabled: HEXNEST_DISCOVERY_HANDSHAKE_ENABLED=false");
    }
  });
}

main().catch((err) => {
  console.error("startup error:", err);
  process.exit(1);
});
