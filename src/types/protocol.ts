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

export interface RoomSnapshot {
  id: string;
  name: string;
  task: string;
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
  timeline: RoomEvent[];
  artifacts: Artifact[];
  finalOutput?: string;
}
