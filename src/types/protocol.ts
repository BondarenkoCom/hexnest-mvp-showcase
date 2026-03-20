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

export interface RoomSnapshot {
  id: string;
  name: string;
  task: string;
  subnest: string;
  settings: {
    pythonShellEnabled: boolean;
    isPublic: boolean;
  };
  status: RoomStatus;
  phase: RoomPhase;
  createdAt: string;
  updatedAt: string;
  agentIds: string[];
  connectedAgents: ConnectedAgent[];
  pythonJobs: PythonJob[];
  timeline: RoomEvent[];
  artifacts: Artifact[];
  finalOutput?: string;
}
