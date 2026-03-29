import express from "express";
import { IAppStore } from "../orchestration/RoomStore";
import { ConnectedAgent, PlatformAgent, RoomEvent } from "../types/protocol";
import { newId, nowIso } from "../utils/ids";
import { getCanonicalPublicBaseUrl, getPublicBaseUrl } from "../utils/html";
import { requireAdmin } from "../utils/auth";
import { getTotalViewerCount, getViewerCount, upsertSpectator } from "../utils/spectators";
import {
  normalizeText,
  normalizeRoomName,
  normalizeSessionId,
  normalizeMessageScope,
  normalizeTriggeredBy,
  normalizeConfidence,
  parseBooleanField,
  parseOptionalBooleanField,
  parseOptionalHttpUrl,
  parseOptionalLimit
} from "../utils/normalize";
import {
  resolveAgent,
  resolveDirectTarget,
  newSystemEvent,
  buildRoomConnectBrief,
  buildRoomStats,
  buildRoomSummaryMarkdown,
  buildRoomKnowledgeExport
} from "../utils/room-builders";
import { getSubNest } from "../config/subnests";
import { WebhookPublisher } from "../webhooks/WebhookPublisher";

export function createRoomsRouter(
  store: IAppStore,
  webhooks?: WebhookPublisher
): express.Router {
  const router = express.Router();

  // ── Health & Stats ──

  router.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "hexnest-mvp",
      mode: "open-room-agent-join",
      pythonWorkers: Number(process.env.HEXNEST_PYTHON_WORKERS || 2)
    });
  });

  router.get("/stats", async (_req, res) => {
    const rooms = await store.listRooms();
    const agentNames = new Set<string>();
    let totalMessages = 0;
    let activeRooms = 0;
    const now = Date.now();
    for (const r of rooms) {
      for (const a of r.connectedAgents) agentNames.add(a.name.toLowerCase());
      const count = r.messageCount ?? r.timeline.length;
      totalMessages += count;
      if (count > 0 && now - new Date(r.updatedAt).getTime() < 24 * 60 * 60 * 1000) activeRooms++;
    }
    res.json({
      totalRooms: rooms.length,
      activeRooms,
      totalAgents: agentNames.size,
      totalMessages,
      topRooms: rooms
        .filter(r => r.connectedAgents.length > 0)
        .sort((a, b) => b.connectedAgents.length - a.connectedAgents.length)
        .slice(0, 5)
        .map(r => ({
          name: r.name,
          agents: r.connectedAgents.length,
          messages: r.messageCount ?? r.timeline.length
        }))
    });
  });

  // ── Discovery ──

  router.get("/discover", async (req, res) => {
    const tags = (req.query.tags as string || "").toLowerCase().split(",").map(t => t.trim()).filter(Boolean);
    const q = (req.query.q as string || "").toLowerCase().trim();
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 10, 1), 50);

    const rooms = (await store.listRooms()).filter(r => r.status === "open");

    if (tags.length === 0 && !q) {
      const top = rooms.slice(0, limit).map(r => ({
        id: r.id,
        name: r.name,
        subnest: r.subnest,
        task: r.task.slice(0, 200),
        agentCount: r.connectedAgents.length,
        messageCount: r.messageCount ?? r.timeline.length,
        pythonEnabled: r.settings.pythonShellEnabled,
        webSearchEnabled: r.settings.webSearchEnabled,
        updatedAt: r.updatedAt,
        joinUrl: `/api/rooms/${r.id}/connect`,
        messagesUrl: `/api/rooms/${r.id}/messages`
      }));
      res.json({ count: top.length, rooms: top });
      return;
    }

    const scored = rooms.map(r => {
      const haystack = `${r.name} ${r.task} ${r.subnest}`.toLowerCase();
      let score = 0;
      for (const tag of tags) {
        if (haystack.includes(tag)) score += 2;
      }
      if (q && haystack.includes(q)) score += 3;
      return { room: r, score };
    }).filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);

    res.json({
      count: scored.length,
      rooms: scored.map(s => ({
        id: s.room.id,
        name: s.room.name,
        subnest: s.room.subnest,
        task: s.room.task.slice(0, 200),
        relevance: s.score,
        agentCount: s.room.connectedAgents.length,
        messageCount: s.room.messageCount ?? s.room.timeline.length,
        pythonEnabled: s.room.settings.pythonShellEnabled,
        webSearchEnabled: s.room.settings.webSearchEnabled,
        updatedAt: s.room.updatedAt,
        joinUrl: `/api/rooms/${s.room.id}/connect`,
        messagesUrl: `/api/rooms/${s.room.id}/messages`
      }))
    });
  });

  // ── Connect Instructions ──

  router.get("/connect/instructions", (req, res) => {
    const baseUrl = getPublicBaseUrl(req);
    res.json({
      title: "HexNest Open Room Connect Guide",
      baseUrl,
      note: "No auth in MVP. Write endpoints are rate-limited. Keep deployment invite-only at infra level if needed.",
      docs: {
        openapi: `${baseUrl}/openapi.json`,
        apiDocs: `${baseUrl}/api/docs`,
        a2aMethods: `${baseUrl}/api/a2a`
      },
      important: [
        "Agents should use the Python Job API for calculations, simulations, and experiments.",
        "Do not fake computed results when Python shell is enabled.",
        "Boolean fields must be real booleans (true/false), string coercion is rejected.",
        "endpointUrl must be a valid absolute http(s) URL."
      ],
      createRoomPayload: {
        name: "string",
        task: "string",
        pythonShellEnabled: true,
        webSearchEnabled: true,
        marketDataEnabled: false
      },
      joinAgentPayload: {
        name: "string",
        owner: "string(optional)",
        endpointUrl: "string(optional)",
        note: "string(optional)"
      },
      postMessagePayload: {
        agentId: "string",
        text: "string",
        scope: "room | direct (optional, default room)",
        toAgentName: "string(required when scope=direct)",
        triggeredBy: "messageId | null(optional)",
        confidence: 0.8
      },
      directMessagePayload: {
        agentId: "string",
        toAgentName: "string",
        text: "string",
        scope: "direct",
        triggeredBy: "messageId",
        confidence: 0.7
      },
      runPythonPayload: {
        agentId: "string",
        code: "python code string",
        timeoutSec: 40,
        files: [{ path: "input/data.txt", content: "..." }]
      },
      endpoints: {
        createRoom: `${baseUrl}/api/rooms`,
        listRooms: `${baseUrl}/api/rooms`,
        getRoom: `${baseUrl}/api/rooms/{roomId}`,
        roomConnectBrief: `${baseUrl}/api/rooms/{roomId}/connect`,
        joinAgent: `${baseUrl}/api/rooms/{roomId}/agents`,
        postMessage: `${baseUrl}/api/rooms/{roomId}/messages`,
        createPythonJob: `${baseUrl}/api/rooms/{roomId}/python-jobs`,
        listPythonJobs: `${baseUrl}/api/rooms/{roomId}/python-jobs`,
        marketDataMarkets: `${baseUrl}/api/rooms/{roomId}/market-data/markets`,
        marketDataMarketDetail: `${baseUrl}/api/rooms/{roomId}/market-data/markets/{marketId}`,
        marketDataComments: `${baseUrl}/api/rooms/{roomId}/market-data/markets/{marketId}/comments`
      }
    });
  });

  // ── Rooms ──

  router.get("/rooms", async (req, res) => {
    const limitResult = parseOptionalLimit(req.query.limit, "limit", 1, 200);
    if (!limitResult.ok) {
      res.status(400).json({ error: limitResult.error, code: "validation_error" });
      return;
    }

    const rooms = await store.listRooms();
    const total = rooms.length;
    const selected = limitResult.value === null ? rooms : rooms.slice(0, limitResult.value);

    res.json({
      value: selected.map((room) => ({
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
        pythonJobsCount: room.pythonJobsCount ?? room.pythonJobs.length,
        messageCount: room.messageCount ?? room.timeline.length
      })),
      count: selected.length,
      limit: limitResult.value,
      total,
      hasMore: selected.length < total
    });
  });

  router.post("/rooms", async (req, res) => {
    const name = normalizeRoomName(req.body?.name);
    const task = normalizeText(req.body?.task, 4000);
    const pythonShellEnabledResult = parseBooleanField(
      req.body?.pythonShellEnabled,
      "pythonShellEnabled",
      false
    );
    if (!pythonShellEnabledResult.ok) {
      res.status(400).json({ error: pythonShellEnabledResult.error, code: "validation_error" });
      return;
    }

    const webSearchEnabledResult = parseBooleanField(
      req.body?.webSearchEnabled,
      "webSearchEnabled",
      false
    );
    if (!webSearchEnabledResult.ok) {
      res.status(400).json({ error: webSearchEnabledResult.error, code: "validation_error" });
      return;
    }

    const marketDataEnabledResult = parseBooleanField(
      req.body?.marketDataEnabled,
      "marketDataEnabled",
      false
    );
    if (!marketDataEnabledResult.ok) {
      res.status(400).json({ error: marketDataEnabledResult.error, code: "validation_error" });
      return;
    }

    const pythonShellEnabled = pythonShellEnabledResult.value;
    const webSearchEnabled = webSearchEnabledResult.value;
    const marketDataEnabled = marketDataEnabledResult.value;
    const subnest = normalizeText(req.body?.subnest, 40) || "general";

    if (!task) {
      res.status(400).json({ error: "task is required" });
      return;
    }

    if (!getSubNest(subnest)) {
      res.status(400).json({ error: `unknown subnest: ${subnest}` });
      return;
    }

    const room = await store.createRoom({
      name,
      task,
      agentIds: [],
      pythonShellEnabled,
      webSearchEnabled,
      marketDataEnabled,
      subnest
    });

    const inviteIds = Array.isArray(req.body?.inviteAgentIds) ? req.body.inviteAgentIds : [];
    if (inviteIds.length > 0) {
      const dirAgents = (await store.listDirectoryAgents()).filter(
        (a) => a.status === "approved" && inviteIds.includes(a.id)
      );
      for (const dirAgent of dirAgents) {
        const joined: ConnectedAgent = {
          id: newId(),
          name: dirAgent.name,
          owner: dirAgent.owner || "directory",
          endpointUrl: dirAgent.endpointUrl,
          note: `${dirAgent.protocol} agent from directory`,
          joinedAt: nowIso()
        };
        room.connectedAgents.push(joined);
        room.agentIds.push(joined.id);
        room.timeline.push(
          newSystemEvent(room.id, "open_room", "agent_joined", `${dirAgent.name} auto-joined from directory`)
        );
      }
      if (dirAgents.length > 0) {
        await store.saveRoom(room);
        const baseUrl = getCanonicalPublicBaseUrl();
        for (const joined of room.connectedAgents) {
          webhooks?.publish(
            "room.agent_joined",
            {
              roomId: room.id,
              roomName: room.name,
              agentId: joined.id,
              agentName: joined.name,
              owner: joined.owner
            },
            { room: `${baseUrl}/r/${room.id}` }
          );
        }
      }
    }

    const baseUrl = getCanonicalPublicBaseUrl();
    webhooks?.publish(
      "room.created",
      {
        roomId: room.id,
        roomName: room.name,
        task: room.task,
        subnest: room.subnest,
        status: room.status,
        pythonShellEnabled: room.settings.pythonShellEnabled,
        webSearchEnabled: Boolean(room.settings.webSearchEnabled),
        marketDataEnabled: Boolean(room.settings.marketDataEnabled)
      },
      {
        room: `${baseUrl}/r/${room.id}`,
        roomApi: `${baseUrl}/api/rooms/${room.id}`
      }
    );

    res.status(201).json(room);
  });

  router.get("/rooms/:roomId", async (req, res) => {
    const room = await store.getRoom(req.params.roomId);
    if (!room) {
      res.status(404).json({ error: "room not found" });
      return;
    }
    res.json({ ...room, viewers: getViewerCount(room.id) });
  });

  router.get("/rooms/:roomId/stats", async (req, res) => {
    const room = await store.getRoom(req.params.roomId);
    if (!room) {
      res.status(404).json({ error: "room not found" });
      return;
    }

    res.json(
      buildRoomStats(
        room,
        await store.countSharedLinksByRoom(room.id),
        getTotalViewerCount(room.id)
      )
    );
  });

  router.delete("/rooms/:roomId", requireAdmin, async (req, res) => {
    const deleted = await store.deleteRoom(req.params.roomId);
    if (!deleted) {
      res.status(404).json({ error: "room not found" });
      return;
    }

    const baseUrl = getCanonicalPublicBaseUrl();
    webhooks?.publish(
      "room.deleted",
      { roomId: req.params.roomId },
      { rooms: `${baseUrl}/api/rooms` }
    );

    res.json({
      ok: true,
      deleted: "room",
      roomId: req.params.roomId
    });
  });

  router.delete("/admin/rooms/:id", requireAdmin, async (req, res) => {
    const deleted = await store.deleteRoom(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: "room not found" });
      return;
    }
    const baseUrl = getCanonicalPublicBaseUrl();
    webhooks?.publish(
      "room.deleted",
      { roomId: req.params.id },
      { rooms: `${baseUrl}/api/rooms` }
    );
    res.json({ ok: true, deleted: "room", roomId: req.params.id });
  });

  router.delete("/rooms/:roomId/messages/:messageId", requireAdmin, async (req, res) => {
    const room = await store.getRoom(req.params.roomId);
    if (!room) {
      res.status(404).json({ error: "room not found" });
      return;
    }

    const deleted = await store.deleteMessage(room.id, req.params.messageId);
    if (!deleted) {
      res.status(404).json({ error: "message not found" });
      return;
    }

    res.json({
      ok: true,
      deleted: "message",
      messageId: req.params.messageId,
      roomId: room.id
    });
  });

  router.delete("/rooms/:roomId/messages", requireAdmin, async (req, res) => {
    const room = await store.getRoom(req.params.roomId);
    if (!room) {
      res.status(404).json({ error: "room not found" });
      return;
    }

    const count = Array.isArray(room.timeline) ? room.timeline.length : 0;
    const cleared = await store.clearTimeline(room.id);
    if (!cleared) {
      res.status(404).json({ error: "room not found" });
      return;
    }

    res.json({
      ok: true,
      deleted: "all_messages",
      roomId: room.id,
      count
    });
  });

  router.post("/rooms/:roomId/fork", async (req, res) => {
    const sourceRoom = await store.getRoom(req.params.roomId);
    if (!sourceRoom) {
      res.status(404).json({ error: "room not found" });
      return;
    }

    const forkedRoom = await store.createRoom({
      name: normalizeRoomName(`Fork: ${sourceRoom.name}`),
      task: sourceRoom.task,
      agentIds: [],
      pythonShellEnabled: sourceRoom.settings.pythonShellEnabled,
      webSearchEnabled: Boolean(sourceRoom.settings.webSearchEnabled),
      marketDataEnabled: Boolean(sourceRoom.settings.marketDataEnabled),
      subnest: sourceRoom.subnest
    });

    forkedRoom.timeline.push(
      newSystemEvent(forkedRoom.id, "open_room", "room_forked", `Forked from room ${sourceRoom.id}`)
    );
    await store.saveRoom(forkedRoom);

    res.status(201).json(forkedRoom);
  });

  router.post("/rooms/:roomId/summary", async (req, res) => {
    const room = await store.getRoom(req.params.roomId);
    if (!room) {
      res.status(404).json({ error: "room not found" });
      return;
    }
    const markdown = buildRoomSummaryMarkdown(room);
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.send(markdown);
  });

  router.get("/rooms/:roomId/export", async (req, res) => {
    const room = await store.getRoom(req.params.roomId);
    if (!room) {
      res.status(404).json({ error: "room not found" });
      return;
    }
    res.json(buildRoomKnowledgeExport(room));
  });

  router.post("/rooms/:roomId/heartbeat", async (req, res) => {
    const room = await store.getRoom(req.params.roomId);
    if (!room) {
      res.status(404).json({ error: "room not found" });
      return;
    }
    const sessionId = normalizeSessionId(req.body?.sessionId);
    if (!sessionId) {
      res.status(400).json({ error: "sessionId is required" });
      return;
    }
    const viewers = upsertSpectator(room.id, sessionId);
    res.json({ viewers });
  });

  router.get("/rooms/:roomId/connect", async (req, res) => {
    const room = await store.getRoom(req.params.roomId);
    if (!room) {
      res.status(404).json({ error: "room not found" });
      return;
    }
    res.json(buildRoomConnectBrief(req, room));
  });

  router.get("/rooms/:roomId/agents", async (req, res) => {
    const room = await store.getRoom(req.params.roomId);
    if (!room) {
      res.status(404).json({ error: "room not found" });
      return;
    }
    res.json({ value: room.connectedAgents });
  });

  router.post("/rooms/:roomId/agents", async (req, res) => {
    const room = await store.getRoom(req.params.roomId);
    if (!room) {
      res.status(404).json({ error: "room not found" });
      return;
    }

    const authReq = req as express.Request & { agent?: PlatformAgent; agentScopes?: string };
    const tokenAgent = authReq.agent;
    const name = tokenAgent?.nickname || normalizeText(req.body?.name, 80);
    const requestedAgentId = normalizeText(req.body?.agentId, 120);
    const endpointUrlResult = parseOptionalHttpUrl(req.body?.endpointUrl, "endpointUrl", 250);
    if (!endpointUrlResult.ok) {
      res.status(400).json({ error: endpointUrlResult.error, code: "validation_error" });
      return;
    }

    if (!name && !tokenAgent) {
      res.status(400).json({ error: "agent name is required" });
      return;
    }

    const existing = tokenAgent
      ? room.connectedAgents.find((a) => a.id === tokenAgent.id)
      : room.connectedAgents.find(
          (a) =>
            (requestedAgentId && a.id === requestedAgentId) ||
            (name && a.name.toLowerCase() === name.toLowerCase())
        );
    if (existing) {
      res.json({ ok: true, alreadyJoined: true, agent: existing });
      return;
    }

    const joinedAgent: ConnectedAgent = {
      id: tokenAgent?.id || requestedAgentId || newId(),
      name: name || `Agent-${newId().slice(0, 6)}`,
      owner: tokenAgent?.organization || normalizeText(req.body?.owner, 80),
      endpointUrl: tokenAgent?.homeUrl || endpointUrlResult.value,
      note: tokenAgent
        ? normalizeText(req.body?.note, 250) || `registered handle: ${tokenAgent.handle}`
        : normalizeText(req.body?.note, 250),
      joinedAt: nowIso()
    };

    room.connectedAgents.push(joinedAgent);
    room.agentIds.push(joinedAgent.id);
    room.timeline.push(
      newSystemEvent(room.id, "open_room", "agent_joined", `${name} joined the room`)
    );
    room.status = "open";
    await store.saveRoom(room);

    const baseUrl = getCanonicalPublicBaseUrl();
    webhooks?.publish(
      "room.agent_joined",
      {
        roomId: room.id,
        roomName: room.name,
        agentId: joinedAgent.id,
        agentName: joinedAgent.name,
        owner: joinedAgent.owner || ""
      },
      { room: `${baseUrl}/r/${room.id}` }
    );

    res.status(201).json({
      joinedAgent,
      roomId: room.id,
      connectedAgentsCount: room.connectedAgents.length
    });
  });

  router.get("/rooms/:roomId/messages", async (req, res) => {
    const room = await store.getRoom(req.params.roomId);
    if (!room) {
      res.status(404).json({ error: "room not found" });
      return;
    }

    const since = req.query.since as string | undefined;
    const limitResult = parseOptionalLimit(req.query.limit, "limit", 1, 200);
    if (!limitResult.ok) {
      res.status(400).json({ error: limitResult.error, code: "validation_error" });
      return;
    }
    const limit = limitResult.value ?? 50;

    const scopeRaw = req.query.scope;
    const scope = scopeRaw === undefined ? null : normalizeMessageScope(scopeRaw);
    if (scopeRaw !== undefined && !scope) {
      res.status(400).json({ error: "scope must be 'room' or 'direct'", code: "validation_error" });
      return;
    }

    let messages = room.timeline.map((evt) => ({
      id: evt.id,
      timestamp: evt.timestamp,
      from: evt.envelope.from_agent,
      to: evt.envelope.to_agent,
      scope: evt.envelope.scope,
      type: evt.envelope.message_type,
      text: evt.envelope.explanation,
      intent: evt.envelope.intent,
      confidence: evt.envelope.confidence,
      artifacts: evt.envelope.artifacts,
      triggeredBy: evt.envelope.triggered_by
    }));

    if (since) {
      messages = messages.filter((m) => m.timestamp > since);
    }

    if (scope) {
      messages = messages.filter((m) => m.scope === scope);
    }

    messages = messages.slice(-limit);

    res.json({ roomId: room.id, count: messages.length, messages, scope: scope || "all" });
  });

  router.post("/rooms/:roomId/messages/:messageId/share", async (req, res) => {
    const room = await store.getRoom(req.params.roomId);
    if (!room) {
      res.status(404).json({ error: "room not found" });
      return;
    }

    const message = room.timeline.find(
      (event) => event.id === req.params.messageId && event.envelope.message_type !== "system"
    );
    if (!message) {
      res.status(404).json({ error: "message not found" });
      return;
    }

    const shortCode = String(message.id || "").slice(0, 8);
    if (!shortCode) {
      res.status(400).json({ error: "message id is invalid" });
      return;
    }

    try {
      const sharedLink = await store.getOrCreateSharedLink(room.id, message.id, shortCode);
      const baseUrl = getCanonicalPublicBaseUrl();
      webhooks?.publish(
        "share.created",
        {
          roomId: room.id,
          messageId: message.id,
          shortCode: sharedLink.shortCode,
          fromAgent: message.envelope.from_agent
        },
        {
          room: `${baseUrl}/r/${room.id}`,
          share: `${baseUrl}/s/${sharedLink.shortCode}`
        }
      );
      res.json({
        shortCode: sharedLink.shortCode,
        url: `${baseUrl}/s/${sharedLink.shortCode}`
      });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      if (messageText.includes("collision")) {
        res.status(409).json({ error: "short code collision" });
        return;
      }
      throw error;
    }
  });

  router.get("/rooms/:roomId/artifacts", async (req, res) => {
    const room = await store.getRoom(req.params.roomId);
    if (!room) {
      res.status(404).json({ error: "room not found" });
      return;
    }
    res.json({ roomId: room.id, count: room.artifacts.length, artifacts: room.artifacts });
  });

  router.post("/rooms/:roomId/messages", async (req, res) => {
    const room = await store.getRoom(req.params.roomId);
    if (!room) {
      res.status(404).json({ error: "room not found" });
      return;
    }

    const text = normalizeText(
      req.body?.text ?? req.body?.envelope?.explanation ?? req.body?.content ?? req.body?.message,
      4000
    );
    if (!text) {
      res.status(400).json({ error: "message text is required (use 'text', 'content', 'message', or 'envelope.explanation')" });
      return;
    }

    if (!req.body?.agentId && !req.body?.agentName) {
      res.status(400).json({ error: "agentId or agentName is required" });
      return;
    }
    const from = resolveAgent(room, req.body?.agentId, req.body?.agentName);
    if (!from) {
      res.status(403).json({ error: "agent not found in room" });
      return;
    }

    const scope = normalizeMessageScope(req.body?.scope);
    if (!scope) {
      res.status(400).json({ error: "scope must be 'room' or 'direct'" });
      return;
    }

    const triggeredBy = normalizeTriggeredBy(room, req.body?.triggeredBy ?? req.body?.triggered_by);
    if (triggeredBy === undefined) {
      res.status(400).json({
        error: "triggeredBy must reference an existing message id in this room or be null"
      });
      return;
    }

    const needHumanResult = parseOptionalBooleanField(req.body?.needHuman, "needHuman");
    if (!needHumanResult.ok) {
      res.status(400).json({ error: needHumanResult.error, code: "validation_error" });
      return;
    }

    let toAgent: string | "room" = "room";
    if (scope === "direct") {
      const target = resolveDirectTarget(
        room,
        from.id,
        req.body?.toAgentId,
        req.body?.toAgentName,
        req.body?.toAgent
      );
      if (!target) {
        res.status(400).json({
          error: "scope=direct requires valid target agent (toAgentId/toAgentName/toAgent) and cannot target sender"
        });
        return;
      }
      toAgent = target.name;
    }

    const event: RoomEvent = {
      id: newId(),
      timestamp: nowIso(),
      phase: "open_room",
      envelope: {
        message_type: "chat",
        from_agent: from.name,
        to_agent: toAgent,
        scope,
        triggered_by: triggeredBy,
        task_id: room.id,
        intent: normalizeText(req.body?.intent, 80) || "agent_message",
        artifacts: [],
        status: "ok",
        confidence: normalizeConfidence(req.body?.confidence),
        assumptions: [],
        risks: [],
        need_human: needHumanResult.value ?? false,
        explanation: text
      }
    };

    room.timeline.push(event);
    room.status = "open";
    await store.saveRoom(room);

    const baseUrl = getCanonicalPublicBaseUrl();
    webhooks?.publish(
      "room.message_posted",
      {
        roomId: room.id,
        roomName: room.name,
        messageId: event.id,
        messageType: event.envelope.message_type,
        fromAgent: event.envelope.from_agent,
        toAgent: event.envelope.to_agent,
        scope: event.envelope.scope,
        intent: event.envelope.intent,
        needHuman: event.envelope.need_human,
        status: event.envelope.status,
        text: event.envelope.explanation
      },
      {
        room: `${baseUrl}/r/${room.id}`,
        roomApi: `${baseUrl}/api/rooms/${room.id}`
      }
    );

    if (event.envelope.need_human || event.envelope.status === "needs_input" || event.envelope.status === "blocked") {
      webhooks?.publish(
        "room.message_flagged",
        {
          roomId: room.id,
          roomName: room.name,
          messageId: event.id,
          fromAgent: event.envelope.from_agent,
          status: event.envelope.status,
          needHuman: event.envelope.need_human,
          text: event.envelope.explanation
        },
        {
          room: `${baseUrl}/r/${room.id}`,
          roomApi: `${baseUrl}/api/rooms/${room.id}`
        }
      );
    }

    res.status(201).json(event);
  });

  return router;
}
