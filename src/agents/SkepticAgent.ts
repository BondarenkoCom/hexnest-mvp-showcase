import { Agent, AgentInput, AgentResult } from "./Agent";
import { Artifact } from "../types/protocol";
import { newId, nowIso } from "../utils/ids";

export class SkepticAgent implements Agent {
  public readonly id = "skeptic";
  public readonly displayName = "Skeptic";
  public readonly role = "qa";

  public async handle(input: AgentInput): Promise<AgentResult> {
    if (input.phase === "independent_answers") {
      const draft = this.buildDraft(input.taskId, input.task);
      return {
        envelope: {
          message_type: "proposal",
          from_agent: this.id,
          to_agent: "room",
          task_id: input.taskId,
          intent: "identify_failure_modes",
          artifacts: [draft.id],
          status: "ok",
          confidence: 0.81,
          assumptions: ["Most MVP failures are orchestration and guardrail bugs."],
          risks: ["Underestimated abuse and loop risk in public rooms."],
          need_human: false,
          explanation: "Draft focused on risk controls and verification points."
        },
        artifacts: [draft]
      };
    }

    if (input.phase === "cross_critique") {
      const critique = this.buildCritique(input.taskId, input.peerDrafts);
      return {
        envelope: {
          message_type: "critique",
          from_agent: this.id,
          to_agent: "room",
          task_id: input.taskId,
          intent: "challenge_overconfidence",
          artifacts: [critique.id],
          status: "ok",
          confidence: 0.77,
          assumptions: ["Drafts may optimize for speed over reliability."],
          risks: ["No trust model means easy spoofing of capability claims."],
          need_human: false,
          explanation: "Critique adds concrete safeguards and human gates."
        },
        artifacts: [critique]
      };
    }

    return {
      envelope: {
        message_type: "system",
        from_agent: this.id,
        to_agent: "room",
        task_id: input.taskId,
        intent: "noop",
        artifacts: [],
        status: "ok",
        confidence: 1,
        assumptions: [],
        risks: [],
        need_human: false,
        explanation: "No output for this phase."
      },
      artifacts: []
    };
  }

  private buildDraft(taskId: string, task: string): Artifact {
    const content = [
      "Risk-first execution notes:",
      "1. Enforce max turn count and max budget per room.",
      "2. Require artifact schema validation before routing.",
      "3. Block direct agent-to-agent free chat in MVP.",
      "4. Log assumptions + risks in every envelope.",
      "5. Route unresolved conflicts to human gate.",
      "",
      `Task focus: ${task}`
    ].join("\n");

    return {
      id: newId(),
      taskId,
      type: "draft",
      label: "Skeptic initial draft",
      content,
      producer: this.id,
      timestamp: nowIso()
    };
  }

  private buildCritique(taskId: string, peerDrafts: Artifact[]): Artifact {
    const lines = ["Critique from skeptic:"];
    if (peerDrafts.length === 0) {
      lines.push("- No peer drafts were available for comparison.");
    } else {
      lines.push("- Add invite-only gate for V1 to control abuse.");
      lines.push("- Add explicit human override API in room workflow.");
      lines.push(`- Peer drafts reviewed: ${peerDrafts.length}.`);
    }

    return {
      id: newId(),
      taskId,
      type: "critique",
      label: "Skeptic critique",
      content: lines.join("\n"),
      producer: this.id,
      timestamp: nowIso()
    };
  }
}
