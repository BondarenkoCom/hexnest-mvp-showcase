export type MessageType =
  | "task"
  | "proposal"
  | "critique"
  | "synthesis"
  | "human_override"
  | "chat"
  | "system";

export type RoomPhase =
  | "open_room"
  | "independent_answers"
  | "cross_critique"
  | "synthesis"
  | "human_gate";

export type RoomStatus = "open" | "draft" | "running" | "awaiting_human" | "finalized";
export type MessageScope = "room" | "direct";

export interface Artifact {
  id: string;
  taskId: string;
  type: "draft" | "critique" | "synthesis" | "note";
  label: string;
  content: string;
  producer: string;
  timestamp: string;
}

export interface AgentEnvelope {
  message_type: MessageType;
  from_agent: string;
  to_agent: string | "room";
  scope: MessageScope;
  triggered_by: string | null;
  task_id: string;
  intent: string;
  artifacts: string[];
  status: "ok" | "needs_input" | "blocked";
  confidence: number;
  assumptions: string[];
  risks: string[];
  need_human: boolean;
  explanation: string;
}

export interface RoomEvent {
  id: string;
  timestamp: string;
  phase: RoomPhase;
  envelope: AgentEnvelope;
}

export interface ConnectedAgent {
  id: string;
  name: string;
  owner: string;
  endpointUrl: string;
  note: string;
  joinedAt: string;
}

export type PythonJobStatus =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "timeout"
  | "rejected";

export interface PythonJob {
  id: string;
  roomId: string;
  agentId: string;
  agentName: string;
  status: PythonJobStatus;
  code: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  timeoutSec: number;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  error?: string;
  outputTruncated?: boolean;
}

export interface SubNest {
  id: string;
  name: string;
  label: string;
  description: string;
  icon: string;
}

export interface WebSearchJob {
  id: string;
  roomId: string;
  agentId: string;
  agentName: string;
  status: "queued" | "running" | "done" | "failed" | "timeout";
  query: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  results?: Array<{ title: string; url: string; snippet: string }>;
  error?: string;
}

export interface RoomSnapshot {
  id: string;
  name: string;
  task: string;
  subnest: string;
  settings: {
    pythonShellEnabled: boolean;
    webSearchEnabled?: boolean;
    isPublic: boolean;
  };
  status: RoomStatus;
  phase: RoomPhase;
  createdAt: string;
  updatedAt: string;
  agentIds: string[];
  connectedAgents: ConnectedAgent[];
  pythonJobs: PythonJob[];
  searchJobs?: WebSearchJob[];
  timeline: RoomEvent[];
  artifacts: Artifact[];
  finalOutput?: string;
  messageCount?: number;
  pythonJobsCount?: number;
}

export interface DirectoryAgent {
  id: string;
  name: string;
  description: string;
  protocol: string;
  endpointUrl: string;
  owner: string;
  category: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
}

export interface SharedLink {
  id: string;
  roomId: string;
  messageId: string;
  shortCode: string;
  createdAt: string;
}

export interface PlatformAgent {
  id: string;
  nickname: string;
  handle: string;
  organization?: string;
  specialty: string[];
  tags: string[];
  theme: string;
  modelFamily?: string;
  publicKey?: string;
  verificationUrl?: string;
  homeUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterAgentInput {
  nickname: string;
  organization?: string;
  specialty?: string[];
  tags?: string[];
  theme?: string;
  modelFamily?: string;
  publicKey?: string;
  verificationUrl?: string;
  homeUrl?: string;
}

export type WebhookEventType =
  | "room.created"
  | "room.deleted"
  | "room.agent_joined"
  | "room.message_posted"
  | "room.message_flagged"
  | "room.artifact_created"
  | "python_job.finished"
  | "search_job.finished"
  | "share.created"
  | "webhook.test";

export const WEBHOOK_EVENT_TYPES: WebhookEventType[] = [
  "room.created",
  "room.deleted",
  "room.agent_joined",
  "room.message_posted",
  "room.message_flagged",
  "room.artifact_created",
  "python_job.finished",
  "search_job.finished",
  "share.created",
  "webhook.test"
];

export interface WebhookEndpoint {
  id: string;
  url: string;
  secret: string;
  events: WebhookEventType[];
  active: boolean;
  description: string;
  createdAt: string;
  updatedAt: string;
  lastDeliveryAt?: string;
  lastError?: string;
}

export interface CreateWebhookEndpointInput {
  url: string;
  secret: string;
  events: WebhookEventType[];
  active?: boolean;
  description?: string;
}

export interface UpdateWebhookEndpointInput {
  url?: string;
  secret?: string;
  events?: WebhookEventType[];
  active?: boolean;
  description?: string;
}

export interface WebhookEventEnvelope {
  id: string;
  type: WebhookEventType;
  version: "v1";
  source: string;
  occurredAt: string;
  data: Record<string, unknown>;
  links?: Record<string, string>;
}
