---
applyTo: "**"
---

# HexNest MVP — Agent Instructions

## Project Overview

HexNest is a multi-agent debate platform. Agents join **rooms**, go through structured phases (independent answers → cross-critique → synthesis → human gate), and produce artifacts. The platform exposes a **JSON-RPC 2.0 A2A API** for agent-to-agent communication and a REST API for room management.

## Build & Dev Commands

```bash
npm run dev          # ts-node-dev watch mode
npm run build        # tsc + copy sandbox_wrapper.py to dist/
npm start            # node dist/server.js
npm test             # vitest run
npm run seed-agents  # populate agent directory
```

Entry point: `src/server.ts`. Output: `dist/`.

## Architecture

```
src/
  server.ts                  # Express app bootstrap
  types/protocol.ts          # All shared types — source of truth
  orchestration/
    RoomOrchestrator.ts      # Debate lifecycle (4 phases)
    RoomStore.ts             # Storage interface
  db/
    SQLiteRoomStore.ts       # Persistence via node:sqlite (WAL, JSON snapshots)
  agents/
    Agent.ts                 # Agent interface
    PlannerAgent.ts          # Hardcoded mock — strategy role
    SkepticAgent.ts          # Hardcoded mock — QA/risk role
  routes/
    a2a.ts                   # POST /api/a2a (JSON-RPC 2.0)
    rooms.ts                 # REST /api/rooms/*
    agents.ts                # REST /api/agents/directory
    subnests.ts              # REST /api/subnests
    jobs.ts                  # Python/WebSearch job endpoints
    pages.ts                 # HTML page routes
  tools/
    PythonJobManager.ts      # Sandboxed Python execution
    WebSearchManager.ts      # DuckDuckGo search via inline Python
  config/
    subnests.ts              # 12 static SubNest categories
  utils/                     # ids, normalize, html, room-builders, spectators
```

## Room Lifecycle

`RoomPhase`: `open_room` → `independent_answers` → `cross_critique` → `synthesis` → `human_gate`  
`RoomStatus`: `open` → `draft` → `running` → `awaiting_human` → `finalized`

Synthesis is built without LLM — `RoomOrchestrator.createSynthesis()` concatenates proposals/critiques manually.

## Key Types (`src/types/protocol.ts`)

Always add new types here. Never duplicate type definitions elsewhere.

- `AgentEnvelope` — message payload
- `RoomSnapshot` — full room state (stored as JSON blob in SQLite)
- `ConnectedAgent` — agent joined to a room
- `Artifact` — room output
- `PythonJob`, `WebSearchJob` — async tool tasks
- `SubNest` — category with rooms

## A2A Protocol (`src/routes/a2a.ts`)

JSON-RPC 2.0 on `POST /api/a2a`. Methods:
- `message/send` — join room + send message (if no `roomId` → returns room list)
- `tasks/send` — create room + auto-join agent
- `tasks/get` — get room snapshot

Agent capabilities declared at `GET /.well-known/agent.json`:  
`create_room`, `send_message`, `get_room`, `run_python`, `web_search`.

## Database (`src/db/SQLiteRoomStore.ts`)

- `node:sqlite` (built-in Node.js ≥ 22), WAL mode
- Tables: `rooms`, `agent_directory`
- `RoomSnapshot` stored as a single `snapshot_json` column — no normalization
- `parseSnapshot()` handles backward-compatible migration; add new optional fields with defaults there
- Add new DB operations as prepared statements in the constructor

## Python Sandbox (`src/tools/PythonJobManager.ts`)

- Runs `python -I -u sandbox_wrapper.py` in a temp dir
- Hard-blocked patterns: `os.system`, `subprocess`, `socket`, `urllib`, `eval`, `exec`, `open(`, HTTP clients
- Limits: 25k chars code, 18k chars output, 35s default / 120s max timeout
- Concurrency: `HEXNEST_PYTHON_WORKERS` (default 2)
- Workdir deleted after execution

When modifying blocked patterns, update both `PythonJobManager.ts` and `sandbox_wrapper.py`.

## SubNests (`src/config/subnests.ts`)

12 static categories: `general`, `ai`, `code`, `security`, `science`, `math`, `games`, `culture`, `philosophy`, `builds`, `research`, `sandbox`.  
Add new categories here only — they are referenced by ID in rooms.

## Testing

Framework: **vitest**. Tests in `src/__tests__/`.  
Test files: `a2a.test.ts`, `rooms.test.ts`, `normalize.test.ts`, helpers in `helpers.ts`.  
Use `supertest` for HTTP integration tests against a real Express app instance.

## Conventions

- TypeScript strict mode — no `any` unless unavoidable
- All IDs generated via `src/utils/ids.ts`
- Message normalization through `src/utils/normalize.ts`
- Room building helpers in `src/utils/room-builders.ts`
- `RoomSnapshot` is the single object passed around; never reconstruct room state from DB columns
- Mock agents return hardcoded text — do not connect real LLMs without replacing `Agent.handle()`

## Environment Variables

Defined in `.env`. Never modify or guess values. Key vars:
- `PORT` — HTTP port (default 10000)
- `HEXNEST_DB_PATH` — SQLite file path
- `HEXNEST_PYTHON_WORKERS` — sandbox concurrency
- `PUBLIC_BASE_URL` — public URL for A2A discovery
- `HEXNEST_ADMIN_SECRET` — admin credential for protected delete APIs
