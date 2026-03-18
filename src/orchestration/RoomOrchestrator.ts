import { Agent } from "../agents/Agent";
import {
  AgentEnvelope,
  Artifact,
  RoomEvent,
  RoomSnapshot
} from "../types/protocol";
import { newId, nowIso } from "../utils/ids";
import { RoomStore } from "./RoomStore";

export class RoomOrchestrator {
  constructor(
    private readonly agents: Map<string, Agent>,
    private readonly store: RoomStore
  ) {}

  public async runRoom(roomId: string): Promise<RoomSnapshot> {
    const room = this.store.getRoom(roomId);
    if (!room) {
      throw new Error(`Room not found: ${roomId}`);
    }

    room.status = "running";
    room.phase = "independent_answers";
    this.pushSystemEvent(room, "independent_answers", "run_started");

    await this.runIndependentPhase(room);
    room.phase = "cross_critique";
    this.pushSystemEvent(room, "cross_critique", "phase_switch");

    await this.runCritiquePhase(room);
    room.phase = "synthesis";
    this.pushSystemEvent(room, "synthesis", "phase_switch");

    this.createSynthesis(room);
    room.phase = "human_gate";
    room.status = "awaiting_human";
    this.pushSystemEvent(room, "human_gate", "awaiting_human_approval");

    return this.store.saveRoom(room);
  }

  public finalize(roomId: string, note: string): RoomSnapshot {
    const room = this.store.getRoom(roomId);
    if (!room) {
      throw new Error(`Room not found: ${roomId}`);
    }

    const finalNote: Artifact = {
      id: newId(),
      taskId: room.id,
      type: "note",
      label: "Human final note",
      content: note || "Approved without extra note.",
      producer: "human",
      timestamp: nowIso()
    };

    room.artifacts.push(finalNote);
    room.timeline.push(this.wrapEvent("human_gate", {
      message_type: "human_override",
      from_agent: "human",
      to_agent: "room",
      task_id: room.id,
      intent: "finalize_room",
      artifacts: [finalNote.id],
      status: "ok",
      confidence: 1,
      assumptions: [],
      risks: [],
      need_human: false,
      explanation: "Human approved the synthesized output."
    }));

    room.status = "finalized";
    return this.store.saveRoom(room);
  }

  private async runIndependentPhase(room: RoomSnapshot): Promise<void> {
    for (const agentId of room.agentIds) {
      const agent = this.agents.get(agentId);
      if (!agent) {
        continue;
      }

      const result = await agent.handle({
        taskId: room.id,
        task: room.task,
        phase: "independent_answers",
        peerDrafts: []
      });

      room.artifacts.push(...result.artifacts);
      room.timeline.push(this.wrapEvent("independent_answers", result.envelope));
    }
  }

  private async runCritiquePhase(room: RoomSnapshot): Promise<void> {
    const drafts = room.artifacts.filter((a) => a.type === "draft");
    for (const agentId of room.agentIds) {
      const agent = this.agents.get(agentId);
      if (!agent) {
        continue;
      }

      const ownDraft = drafts.find((d) => d.producer === agentId);
      const peerDrafts = drafts.filter((d) => d.producer !== agentId);
      const result = await agent.handle({
        taskId: room.id,
        task: room.task,
        phase: "cross_critique",
        ownDraft,
        peerDrafts
      });

      room.artifacts.push(...result.artifacts);
      room.timeline.push(this.wrapEvent("cross_critique", result.envelope));
    }
  }

  private createSynthesis(room: RoomSnapshot): void {
    const drafts = room.artifacts.filter((a) => a.type === "draft");
    const critiques = room.artifacts.filter((a) => a.type === "critique");

    const finalText = [
      "Synthesis output:",
      "",
      "Strong points from drafts:",
      ...drafts.map((d) => `- ${d.producer}: ${firstLine(d.content)}`),
      "",
      "Critical risks raised:",
      ...critiques.map((c) => `- ${c.producer}: ${firstLine(c.content)}`),
      "",
      "Recommended next step:",
      "- Keep room invite-only, enable human gate by default, and cap turns/budget."
    ].join("\n");

    const synthesis: Artifact = {
      id: newId(),
      taskId: room.id,
      type: "synthesis",
      label: "Room synthesis",
      content: finalText,
      producer: "orchestrator",
      timestamp: nowIso()
    };

    room.finalOutput = finalText;
    room.artifacts.push(synthesis);
    room.timeline.push(this.wrapEvent("synthesis", {
      message_type: "synthesis",
      from_agent: "orchestrator",
      to_agent: "room",
      task_id: room.id,
      intent: "merge_best_parts_and_risks",
      artifacts: [synthesis.id],
      status: "ok",
      confidence: 0.72,
      assumptions: ["Two-agent debate is enough for MVP signal."],
      risks: ["Not connected to external LLM adapters yet."],
      need_human: true,
      explanation: "Synthesis generated and routed to human gate."
    }));
  }

  private pushSystemEvent(room: RoomSnapshot, phase: RoomEvent["phase"], intent: string): void {
    room.timeline.push(this.wrapEvent(phase, {
      message_type: "system",
      from_agent: "orchestrator",
      to_agent: "room",
      task_id: room.id,
      intent,
      artifacts: [],
      status: "ok",
      confidence: 1,
      assumptions: [],
      risks: [],
      need_human: false,
      explanation: `System event: ${intent}`
    }));
  }

  private wrapEvent(phase: RoomEvent["phase"], envelope: AgentEnvelope): RoomEvent {
    return {
      id: newId(),
      timestamp: nowIso(),
      phase,
      envelope
    };
  }
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((x) => x.trim().length > 0) || "";
  return line.slice(0, 120);
}
