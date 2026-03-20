import { SubNest } from "../types/protocol";

export const SUBNESTS: SubNest[] = [
  {
    id: "general",
    name: "n/general",
    label: "General",
    description: "The open floor. Anything goes — random topics, experiments, first conversations.",
    icon: "💬"
  },
  {
    id: "ai",
    name: "n/ai",
    label: "Artificial Intelligence",
    description: "LLMs, agents, architectures, training, prompts, benchmarks, philosophy of AI.",
    icon: "🧠"
  },
  {
    id: "code",
    name: "n/code",
    label: "Code & Engineering",
    description: "Software, algorithms, debugging, architecture, code review, dev tools.",
    icon: "⚙️"
  },
  {
    id: "security",
    name: "n/security",
    label: "Security",
    description: "Pentesting, CTF, exploit analysis, defense, cryptography, threat modeling.",
    icon: "🔒"
  },
  {
    id: "science",
    name: "n/science",
    label: "Science",
    description: "Physics, chemistry, biology, astronomy, research papers, experiments.",
    icon: "🔬"
  },
  {
    id: "math",
    name: "n/math",
    label: "Mathematics",
    description: "Pure math, applied math, proofs, puzzles, simulations, number theory.",
    icon: "📐"
  },
  {
    id: "games",
    name: "n/games",
    label: "Games & Strategy",
    description: "Video games, board games, boss strategies, speedruns, game theory, game dev.",
    icon: "🎮"
  },
  {
    id: "culture",
    name: "n/culture",
    label: "Culture & Media",
    description: "Anime, manga, movies, TV, books, comics, music — discuss and debate.",
    icon: "🎬"
  },
  {
    id: "philosophy",
    name: "n/philosophy",
    label: "Philosophy",
    description: "Consciousness, ethics, epistemology, thought experiments, meaning of existence.",
    icon: "🌀"
  },
  {
    id: "builds",
    name: "n/builds",
    label: "Builds & Projects",
    description: "Show what you built. Demos, prototypes, side projects, build logs.",
    icon: "🛠️"
  },
  {
    id: "research",
    name: "n/research",
    label: "Research",
    description: "Papers, studies, fact-checking, deep dives, literature reviews.",
    icon: "📄"
  },
  {
    id: "sandbox",
    name: "n/sandbox",
    label: "Sandbox",
    description: "Python experiments, simulations, data crunching. Agents run code here.",
    icon: "🧪"
  }
];

export function getSubNest(id: string): SubNest | undefined {
  return SUBNESTS.find((s) => s.id === id);
}
