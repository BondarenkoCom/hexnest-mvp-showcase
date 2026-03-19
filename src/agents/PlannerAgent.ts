import { Agent, AgentInput, AgentResult } from "./Agent";
import { Artifact } from "../types/protocol";
import { newId, nowIso } from "../utils/ids";

export class PlannerAgent implements Agent {
  public readonly id = "planner";
  public readonly displayName = "Planner";
  public readonly role = "strategy";

  public async handle(input: AgentInput): Promise<AgentResult> {
    if (input.phase === "independent_answers") {
      const draft = this.buildDraft(input.taskId, input.task);
      return {
        envelope: {
          message_type: "proposal",
          from_agent: this.id,
          to_agent: "room",
          scope: "room",
          triggered_by: null,
          task_id: input.taskId,
          intent: "propose_execution_plan",
          artifacts: [draft.id],
          status: "ok",
          confidence: 0.74,
          assumptions: ["Task can be split into explicit milestones."],
          risks: ["Plan quality depends on correct task scope."],
          need_human: false,
          explanation: "Structured plan proposed with clear milestones and acceptance criteria."
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
          scope: "room",
          triggered_by: null,
          task_id: input.taskId,
          intent: "stress_test_peer_drafts",
          artifacts: [critique.id],
          status: "ok",
          confidence: 0.67,
          assumptions: ["Peer drafts might skip acceptance criteria."],
          risks: ["Low-detail drafts can look good but fail in execution."],
          need_human: false,
          explanation: "Flagged missing guardrails and added measurable checkpoints."
        },
        artifacts: [critique]
      };
    }

    return {
      envelope: {
        message_type: "system",
        from_agent: this.id,
        to_agent: "room",
        scope: "room",
        triggered_by: null,
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
      "Execution plan:",
      "1. Clarify room objective and hard constraints.",
      "2. Generate independent candidate outputs from each agent.",
      "3. Run structured cross-critique with explicit risk tagging.",
      "4. Synthesize best parts into one actionable artifact.",
      "5. Require human sign-off before finalize.",
      "",
      `Task focus: ${task}`
    ].join("\n");

    return {
      id: newId(),
      taskId,
      type: "draft",
      label: "Planner initial draft",
      content,
      producer: this.id,
      timestamp: nowIso()
    };
  }

  private buildCritique(taskId: string, peerDrafts: Artifact[]): Artifact {
    const lines = ["Critique from planner:"];
    if (peerDrafts.length === 0) {
      lines.push("- No peer drafts found, cannot compare alternatives.");
    } else {
      lines.push("- Ensure each proposal has explicit stop conditions.");
      lines.push("- Add budget/time caps per phase to prevent loops.");
      lines.push(`- Peer drafts reviewed: ${peerDrafts.length}.`);
    }

    return {
      id: newId(),
      taskId,
      type: "critique",
      label: "Planner critique",
      content: lines.join("\n"),
      producer: this.id,
      timestamp: nowIso()
    };
  }
}
