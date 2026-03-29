#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-${BASE_URL:-http://localhost:10000}}"

json_pick() {
  local path="$1"
  node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync(0,'utf8')); const keys=process.argv[1].split('.'); let v=data; for (const key of keys){ if(v==null){break;} v=v[key]; } if(v===undefined||v===null){ process.exit(2); } process.stdout.write(typeof v==='object' ? JSON.stringify(v) : String(v));" "$path"
}

echo "BASE_URL=${BASE_URL}"
echo "[1/12] GET /openapi.json"
curl -fsS "${BASE_URL}/openapi.json" | json_pick "openapi" >/dev/null
echo "ok"

echo "[2/12] GET /api/docs"
curl -fsS "${BASE_URL}/api/docs" | json_pick "jsonrpc.endpoint" >/dev/null
echo "ok"

echo "[3/12] GET /api/a2a"
curl -fsS "${BASE_URL}/api/a2a" | json_pick "methods.message/send" >/dev/null
echo "ok"

echo "[4/12] POST /api/rooms"
ROOM_JSON="$(curl -fsS -X POST "${BASE_URL}/api/rooms" \
  -H "Content-Type: application/json" \
  -d '{"name":"Smoke Room","task":"API hardening smoke test","pythonShellEnabled":true,"webSearchEnabled":false,"subnest":"general"}')"
ROOM_ID="$(printf "%s" "$ROOM_JSON" | json_pick "id")"
echo "roomId=${ROOM_ID}"

echo "[5/12] POST /api/rooms/{roomId}/agents (join primary)"
AGENT1_JSON="$(curl -fsS -X POST "${BASE_URL}/api/rooms/${ROOM_ID}/agents" \
  -H "Content-Type: application/json" \
  -d '{"name":"Smoke-Agent-A","owner":"smoke","endpointUrl":"https://agent-a.example.com"}')"
AGENT1_ID="$(printf "%s" "$AGENT1_JSON" | json_pick "joinedAgent.id")"
echo "agent1Id=${AGENT1_ID}"

echo "[6/12] POST /api/rooms/{roomId}/agents (join target)"
AGENT2_JSON="$(curl -fsS -X POST "${BASE_URL}/api/rooms/${ROOM_ID}/agents" \
  -H "Content-Type: application/json" \
  -d '{"name":"Smoke-Agent-B","owner":"smoke","endpointUrl":"https://agent-b.example.com"}')"
AGENT2_ID="$(printf "%s" "$AGENT2_JSON" | json_pick "joinedAgent.id")"
echo "agent2Id=${AGENT2_ID}"

echo "[7/12] POST room + direct messages"
curl -fsS -X POST "${BASE_URL}/api/rooms/${ROOM_ID}/messages" \
  -H "Content-Type: application/json" \
  -d "{\"agentId\":\"${AGENT1_ID}\",\"text\":\"Room broadcast\",\"scope\":\"room\"}" >/dev/null
curl -fsS -X POST "${BASE_URL}/api/rooms/${ROOM_ID}/messages" \
  -H "Content-Type: application/json" \
  -d "{\"agentId\":\"${AGENT1_ID}\",\"text\":\"Direct ping\",\"scope\":\"direct\",\"toAgentId\":\"${AGENT2_ID}\"}" >/dev/null
echo "ok"

echo "[8/12] GET scoped messages"
curl -fsS "${BASE_URL}/api/rooms/${ROOM_ID}/messages?scope=room&limit=20" | json_pick "scope" >/dev/null
curl -fsS "${BASE_URL}/api/rooms/${ROOM_ID}/messages?scope=direct&limit=20" | json_pick "scope" >/dev/null
echo "ok"

echo "[9/12] POST /api/rooms/{roomId}/python-jobs and poll /api/python-jobs/{jobId}"
PY_JOB_JSON="$(curl -fsS -X POST "${BASE_URL}/api/rooms/${ROOM_ID}/python-jobs" \
  -H "Content-Type: application/json" \
  -d "{\"agentId\":\"${AGENT1_ID}\",\"code\":\"print(2+2)\",\"timeoutSec\":20}")"
PY_JOB_ID="$(printf "%s" "$PY_JOB_JSON" | json_pick "id")"
echo "pythonJobId=${PY_JOB_ID}"

for _ in $(seq 1 20); do
  STATUS="$(curl -fsS "${BASE_URL}/api/python-jobs/${PY_JOB_ID}" | json_pick "status" || true)"
  if [[ "${STATUS}" == "done" || "${STATUS}" == "failed" || "${STATUS}" == "timeout" ]]; then
    break
  fi
  sleep 1
done
echo "pythonStatus=${STATUS}"

echo "[10/12] POST JSON-RPC tasks/send"
TASK_JSON="$(curl -fsS -X POST "${BASE_URL}/api/a2a" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0",
    "id":"smoke-task-send",
    "method":"tasks/send",
    "params":{"task":{"name":"Smoke A2A","description":"Verify tasks/send + tasks/get","agentId":"a2a-smoke-agent","agentName":"Smoke-A2A","pythonShellEnabled":true,"webSearchEnabled":false}}
  }')"
TASK_ROOM_ID="$(printf "%s" "$TASK_JSON" | json_pick "result.metadata.roomId")"
echo "taskRoomId=${TASK_ROOM_ID}"

echo "[11/12] POST JSON-RPC message/send + tasks/get"
curl -fsS -X POST "${BASE_URL}/api/a2a" \
  -H "Content-Type: application/json" \
  -d "{
    \"jsonrpc\":\"2.0\",
    \"id\":\"smoke-msg-send\",
    \"method\":\"message/send\",
    \"params\":{\"message\":{\"roomId\":\"${TASK_ROOM_ID}\",\"agentId\":\"a2a-smoke-agent\",\"agentName\":\"Smoke-A2A\",\"text\":\"A2A smoke message\",\"scope\":\"room\"}}
  }" >/dev/null
curl -fsS -X POST "${BASE_URL}/api/a2a" \
  -H "Content-Type: application/json" \
  -d "{
    \"jsonrpc\":\"2.0\",
    \"id\":\"smoke-task-get\",
    \"method\":\"tasks/get\",
    \"params\":{\"id\":\"${TASK_ROOM_ID}\"}
  }" | json_pick "result.id" >/dev/null
echo "ok"

echo "[12/12] GET list endpoints with limit"
curl -fsS "${BASE_URL}/api/rooms?limit=2" | json_pick "limit" >/dev/null
curl -fsS "${BASE_URL}/api/agents/directory?limit=2" | json_pick "limit" >/dev/null
echo "ok"

echo "Smoke scenario finished successfully."
