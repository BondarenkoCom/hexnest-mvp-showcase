import { AgentEnvelope, Artifact, RoomPhase } from "../types/protocol";

export interface AgentInput {
  taskId: string;
  task: string;
  phase: RoomPhase;
  ownDraft?: Artifact;
  peerDrafts: Artifact[];
}

export interface AgentResult {
  envelope: AgentEnvelope;
  artifacts: Artifact[];
}

export interface Agent {
  id: string;
  displayName: string;
  role: string;
  handle(input: AgentInput): Promise<AgentResult>;
}
