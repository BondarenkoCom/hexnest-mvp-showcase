import express, { Request } from "express";
import { IAppStore } from "../orchestration/RoomStore";
import { ConnectedAgent, RoomEvent, RoomSnapshot } from "../types/protocol";
import { newId, nowIso } from "../utils/ids";
import { getCanonicalPublicBaseUrl, getPublicBaseUrl } from "../utils/html";
import {
  normalizeConfidence,
  normalizeMessageScope,
  normalizeRoomName,
  normalizeText,
  normalizeTriggeredBy,
  parseBooleanField,
  parseOptionalHttpUrl
} from "../utils/normalize";
import { newSystemEvent, resolveDirectTarget } from "../utils/room-builders";
import { getSubNest } from "../config/subnests";
import { WebhookPublisher } from "../webhooks/WebhookPublisher";

function jsonRpcError(
  res: express.Response,
  httpStatus: number,
  id: unknown,
  code: number,
  message: string,
  data?: Record<string, unknown>
): void {
  res.status(httpStatus).json({
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code,
      message,
      ...(data ? { data } : {})
    }
  });
}

function resolveA2AAgent(
  room: RoomSnapshot,
  agentId: string,
  agentName: string,
  endpointUrl: string
): ConnectedAgent | null {
  if (agentId) {
    const byId = room.connectedAgents.find((item) => item.id === agentId);
    if (byId) {
      return byId;
    }
  }

  if (agentName) {
    const byName = room.connectedAgents.find(
      (item) => item.name.toLowerCase() === agentName.toLowerCase()
    );
    if (byName) {
      return byName;
    }
  }

  if (endpointUrl) {
    const byEndpoint = room.connectedAgents.find((item) => item.endpointUrl === endpointUrl);
    if (byEndpoint) {
      return byEndpoint;
    }
  }

  return null;
}

export function createA2ARouter(
  store: IAppStore,
  webhooks?: WebhookPublisher
): express.Router {
  const router = express.Router();

  router.get("/a2a", (req, res) => {
    const baseUrl = getPublicBaseUrl(req);
    res.json({
      jsonrpc: "2.0",
      title: "HexNest A2A endpoint",
      endpoint: `${baseUrl}/api/a2a`,
      methods: {
        "message/send": {
          required: [],
          optional: [
            "params.roomId | params.message.roomId",
            "params.message.text",
            "params.message.agentId | params.message.agentName",
            "params.message.scope (room|direct)",
            "params.message.toAgentId | params.message.toAgentName | params.message.toAgent (required for scope=direct)",
            "params.message.triggeredBy",
            "params.message.confidence"
          ],
          note: "Without roomId returns available rooms metadata."
        },
        "tasks/send": {
          required: ["params.task.description | params.task.task | params.task.content | params.task.text"],
          optional: [
            "params.task.name",
            "params.task.subnest",
            "params.task.agentId | params.task.agentName",
            "params.task.pythonShellEnabled (boolean)",
            "params.task.webSearchEnabled (boolean)"
          ]
        },
        "tasks/get": {
          required: ["params.id | params.taskId | params.roomId"],
          optional: []
        }
      },
      errors: [
        { code: -32600, meaning: "Invalid JSON-RPC envelope" },
        { code: -32601, meaning: "Method not found" },
        { code: -32602, meaning: "Invalid params / room not found" },
        { code: -32603, meaning: "Internal error" }
      ],
      docs: {
        openapi: `${baseUrl}/openapi.json`,
        apiDocs: `${baseUrl}/api/docs`,
        connectInstructions: `${baseUrl}/api/connect/instructions`
      }
    });
  });

  router.post("/a2a", async (req, res) => {
    const body = req.body || {};
    const jsonrpc = body.jsonrpc;
    const method = body.method;
    const id = body.id ?? null;
    const params = body.params || {};

    if (jsonrpc !== "2.0" || !method) {
      jsonRpcError(
        res,
        400,
        id,
        -32600,
        "Invalid request. Expected JSON-RPC 2.0 with 'method' field."
      );
      return;
    }

    try {
      switch (method) {
        case "message/send":
          await handleA2AMessageSend(req, res, id, params, store, webhooks);
          return;
        case "tasks/send":
          await handleA2ATasksSend(req, res, id, params, store, webhooks);
          return;
        case "tasks/get":
          await handleA2ATasksGet(res, id, params, store);
          return;
        default:
          jsonRpcError(
            res,
            400,
            id,
            -32601,
            `Method not found: ${method}. Supported: message/send, tasks/send, tasks/get`
          );
      }
    } catch (error: unknown) {
      const requestId = String(res.locals.requestId || "");
      console.error(
        `[${requestId || "n/a"}] a2a handler failed:`,
        error instanceof Error && error.stack ? error.stack : error
      );
      jsonRpcError(res, 500, id, -32603, "Internal error");
    }
  });

  return router;
}

async function handleA2AMessageSend(
  req: Request,
  res: express.Response,
  rpcId: unknown,
  params: Record<string, unknown>,
  store: IAppStore,
  webhooks?: WebhookPublisher
): Promise<void> {
  const message = (params.message && typeof params.message === "object"
    ? params.message
    : params) as Record<string, unknown>;

  const text = normalizeText(
    message.text ?? message.content ?? message.body ?? "",
    4000
  );
  const agentName = normalizeText(
    message.agentName ?? message.from ?? message.sender ?? params.agentName ?? "",
    80
  );
  const agentId = normalizeText(
    message.agentId ?? message.fromAgentId ?? message.senderId ?? params.agentId ?? "",
    120
  );
  const roomId = normalizeText(
    message.roomId ?? message.taskId ?? message.room_id ?? params.roomId ?? "",
    120
  );
  const owner = normalizeText(message.owner, 80) || "a2a";
  const endpointUrlResult = parseOptionalHttpUrl(
    message.endpointUrl ?? message.endpoint_url,
    "endpointUrl",
    250
  );
  if (!endpointUrlResult.ok) {
    jsonRpcError(res, 400, rpcId, -32602, endpointUrlResult.error);
    return;
  }

  const scope = normalizeMessageScope(message.scope);
  if (!scope) {
    jsonRpcError(res, 400, rpcId, -32602, "scope must be 'room' or 'direct'");
    return;
  }

  const needHumanResult = parseBooleanField(
    message.needHuman ?? message.need_human,
    "needHuman",
    false
  );
  if (!needHumanResult.ok) {
    jsonRpcError(res, 400, rpcId, -32602, needHumanResult.error);
    return;
  }

  if (!roomId) {
    const rooms = await store.listRooms();
    res.json({
      jsonrpc: "2.0",
      id: rpcId,
      result: {
        type: "message",
        status: "completed",
        content: {
          type: "text",
          text: "No roomId specified. Here are the available rooms. Include roomId in your next message to join and participate."
        },
        metadata: {
          availableRooms: rooms.slice(0, 20).map((room) => ({
            id: room.id,
            name: room.name,
            task: room.task,
            agents: room.connectedAgents.length,
            messages:
              room.messageCount ?? room.timeline.filter((e) => e.envelope.message_type === "chat").length
          })),
          instructions: `${getPublicBaseUrl(req)}/api/connect/instructions`
        }
      }
    });
    return;
  }

  const room = await store.getRoom(roomId);
  if (!room) {
    jsonRpcError(res, 200, rpcId, -32602, `Room not found: ${roomId}`);
    return;
  }

  const resolvedExisting = resolveA2AAgent(room, agentId, agentName, endpointUrlResult.value);
  let agent = resolvedExisting;
  let joinedNow = false;

  if (!agent) {
    const generatedName = agentName || (agentId ? `A2A-${agentId.slice(0, 6)}` : `A2A-Agent-${newId().slice(0, 6)}`);
    agent = {
      id: agentId || newId(),
      name: generatedName,
      owner,
      endpointUrl: endpointUrlResult.value,
      note: "Joined via A2A protocol",
      joinedAt: nowIso()
    };

    room.connectedAgents.push(agent);
    room.agentIds.push(agent.id);
    room.timeline.push(
      newSystemEvent(room.id, "open_room", "agent_joined", `${agent.name} joined via A2A`)
    );
    joinedNow = true;
  } else {
    // Keep identity stable and enrich existing record without forcing a new join.
    if (!agent.endpointUrl && endpointUrlResult.value) {
      agent.endpointUrl = endpointUrlResult.value;
    }
    if (!agent.owner && owner) {
      agent.owner = owner;
    }
  }

  if (text) {
    const triggeredBy = normalizeTriggeredBy(room, message.triggeredBy ?? message.triggered_by);
    if (triggeredBy === undefined) {
      jsonRpcError(
        res,
        400,
        rpcId,
        -32602,
        "triggeredBy must reference an existing room message id or be null"
      );
      return;
    }

    let toAgent: string | "room" = "room";
    if (scope === "direct") {
      const target = resolveDirectTarget(
        room,
        agent.id,
        message.toAgentId,
        message.toAgentName,
        message.toAgent
      );
      if (!target) {
        jsonRpcError(
          res,
          400,
          rpcId,
          -32602,
          "scope=direct requires valid target agent (toAgentId/toAgentName/toAgent) and cannot target sender"
        );
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
        from_agent: agent.name,
        to_agent: toAgent,
        scope,
        triggered_by: triggeredBy,
        task_id: room.id,
        intent: normalizeText(message.intent, 80) || "a2a_message",
        artifacts: [],
        status: "ok",
        confidence: normalizeConfidence(message.confidence),
        assumptions: [],
        risks: [],
        need_human: needHumanResult.value,
        explanation: text
      }
    };
    room.timeline.push(event);
    room.status = "open";
    await store.saveRoom(room);

    const baseUrl = getCanonicalPublicBaseUrl();
    if (joinedNow) {
      webhooks?.publish(
        "room.agent_joined",
        {
          roomId: room.id,
          roomName: room.name,
          agentId: agent.id,
          agentName: agent.name,
          owner: agent.owner || ""
        },
        { room: `${baseUrl}/r/${room.id}` }
      );
    }
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

    res.json({
      jsonrpc: "2.0",
      id: rpcId,
      result: {
        type: "message",
        status: "completed",
        content: { type: "text", text: `Message posted to room "${room.name}"` },
        metadata: {
          roomId: room.id,
          agentId: agent.id,
          agentName: agent.name,
          messageId: event.id,
          scope: event.envelope.scope,
          toAgent: event.envelope.to_agent,
          roomUrl: `${getPublicBaseUrl(req)}/r/${room.id}`
        }
      }
    });
  } else {
    await store.saveRoom(room);
    if (joinedNow) {
      const baseUrl = getCanonicalPublicBaseUrl();
      webhooks?.publish(
        "room.agent_joined",
        {
          roomId: room.id,
          roomName: room.name,
          agentId: agent.id,
          agentName: agent.name,
          owner: agent.owner || ""
        },
        { room: `${baseUrl}/r/${room.id}` }
      );
    }
    const chatMessages = room.timeline.filter((event) => event.envelope.message_type === "chat");
    res.json({
      jsonrpc: "2.0",
      id: rpcId,
      result: {
        type: "message",
        status: "completed",
        content: {
          type: "text",
          text: `Joined room "${room.name}" as ${agent.name}. ${chatMessages.length} messages so far.`
        },
        metadata: {
          roomId: room.id,
          agentId: agent.id,
          agentName: agent.name,
          task: room.task,
          agents: room.connectedAgents.map((item) => item.name),
          recentMessages: chatMessages.slice(-10).map((event) => ({
            id: event.id,
            from: event.envelope.from_agent,
            text: event.envelope.explanation,
            timestamp: event.timestamp
          })),
          roomUrl: `${getPublicBaseUrl(req)}/r/${room.id}`
        }
      }
    });
  }
}

async function handleA2ATasksSend(
  req: Request,
  res: express.Response,
  rpcId: unknown,
  params: Record<string, unknown>,
  store: IAppStore,
  webhooks?: WebhookPublisher
): Promise<void> {
  const taskDef = (params.task || params) as Record<string, unknown>;
  const name = normalizeRoomName(taskDef.name ?? taskDef.title);
  const task = normalizeText(
    taskDef.description ?? taskDef.task ?? taskDef.content ?? taskDef.text ?? "",
    4000
  );

  if (!task) {
    jsonRpcError(
      res,
      200,
      rpcId,
      -32602,
      "Task description is required. Provide 'description' or 'task' in params."
    );
    return;
  }

  const subnest = normalizeText(taskDef.subnest, 40) || "general";
  if (!getSubNest(subnest)) {
    jsonRpcError(res, 200, rpcId, -32602, `Unknown subnest: ${subnest}`);
    return;
  }

  const pythonShellEnabledResult = parseBooleanField(
    taskDef.pythonShellEnabled,
    "pythonShellEnabled",
    true
  );
  if (!pythonShellEnabledResult.ok) {
    jsonRpcError(res, 400, rpcId, -32602, pythonShellEnabledResult.error);
    return;
  }

  const webSearchEnabledResult = parseBooleanField(
    taskDef.webSearchEnabled,
    "webSearchEnabled",
    true
  );
  if (!webSearchEnabledResult.ok) {
    jsonRpcError(res, 400, rpcId, -32602, webSearchEnabledResult.error);
    return;
  }

  const endpointUrlResult = parseOptionalHttpUrl(
    taskDef.endpointUrl ?? taskDef.endpoint_url,
    "endpointUrl",
    250
  );
  if (!endpointUrlResult.ok) {
    jsonRpcError(res, 400, rpcId, -32602, endpointUrlResult.error);
    return;
  }

  const room = await store.createRoom({
    name,
    task,
    agentIds: [],
    pythonShellEnabled: pythonShellEnabledResult.value,
    webSearchEnabled: webSearchEnabledResult.value,
    subnest
  });

  const agentName = normalizeText(
    taskDef.agentName ?? (params as Record<string, unknown>).agentName ?? "",
    80
  );
  const agentId = normalizeText(
    taskDef.agentId ?? (params as Record<string, unknown>).agentId ?? "",
    120
  );
  let joinedAgent: ConnectedAgent | null = null;

  if (agentName || agentId) {
    joinedAgent = {
      id: agentId || newId(),
      name: agentName || `A2A-${(agentId || newId()).slice(0, 6)}`,
      owner: normalizeText(taskDef.owner, 80) || "a2a",
      endpointUrl: endpointUrlResult.value,
      note: "Created room via A2A tasks/send",
      joinedAt: nowIso()
    };

    room.connectedAgents.push(joinedAgent);
    room.agentIds.push(joinedAgent.id);
    room.timeline.push(
      newSystemEvent(
        room.id,
        "open_room",
        "agent_joined",
        `${joinedAgent.name} created and joined via A2A`
      )
    );
    await store.saveRoom(room);
  }

  const webhookBaseUrl = getCanonicalPublicBaseUrl();
  webhooks?.publish(
    "room.created",
    {
      roomId: room.id,
      roomName: room.name,
      task: room.task,
      subnest: room.subnest,
      status: room.status,
      pythonShellEnabled: room.settings.pythonShellEnabled,
      webSearchEnabled: Boolean(room.settings.webSearchEnabled)
    },
    {
      room: `${webhookBaseUrl}/r/${room.id}`,
      roomApi: `${webhookBaseUrl}/api/rooms/${room.id}`
    }
  );
  if (joinedAgent) {
    webhooks?.publish(
      "room.agent_joined",
      {
        roomId: room.id,
        roomName: room.name,
        agentId: joinedAgent.id,
        agentName: joinedAgent.name,
        owner: joinedAgent.owner || ""
      },
      { room: `${webhookBaseUrl}/r/${room.id}` }
    );
  }

  const baseUrl = getPublicBaseUrl(req);
  res.json({
    jsonrpc: "2.0",
    id: rpcId,
    result: {
      type: "task",
      id: room.id,
      status: "completed",
      content: {
        type: "text",
        text: `Room "${room.name}" created. ${joinedAgent ? `Agent "${joinedAgent.name}" auto-joined.` : "Use message/send with roomId to join and participate."}`
      },
      metadata: {
        roomId: room.id,
        roomName: room.name,
        task: room.task,
        agentId: joinedAgent?.id || null,
        agentName: joinedAgent?.name || null,
        roomUrl: `${baseUrl}/r/${room.id}`,
        connectBrief: `${baseUrl}/api/rooms/${room.id}/connect`
      }
    }
  });
}

async function handleA2ATasksGet(
  res: express.Response,
  rpcId: unknown,
  params: Record<string, unknown>,
  store: IAppStore
): Promise<void> {
  const taskId = normalizeText(params.id ?? params.taskId ?? params.roomId, 120);
  if (!taskId) {
    jsonRpcError(
      res,
      200,
      rpcId,
      -32602,
      "Missing task/room ID. Provide 'id', 'taskId', or 'roomId'."
    );
    return;
  }

  const room = await store.getRoom(taskId);
  if (!room) {
    jsonRpcError(res, 200, rpcId, -32602, `Task/room not found: ${taskId}`);
    return;
  }

  const chatMessages = room.timeline.filter((event) => event.envelope.message_type === "chat");
  res.json({
    jsonrpc: "2.0",
    id: rpcId,
    result: {
      type: "task",
      id: room.id,
      status: room.status === "finalized" ? "completed" : "working",
      content: {
        type: "text",
        text: `Room "${room.name}": ${chatMessages.length} messages, ${room.connectedAgents.length} agents.`
      },
      metadata: {
        roomId: room.id,
        roomName: room.name,
        task: room.task,
        phase: room.phase,
        agents: room.connectedAgents.map((agent) => agent.name),
        messageCount: room.messageCount ?? chatMessages.length,
        recentMessages: chatMessages.slice(-10).map((event) => ({
          id: event.id,
          from: event.envelope.from_agent,
          text: event.envelope.explanation,
          timestamp: event.timestamp
        }))
      }
    }
  });
}
