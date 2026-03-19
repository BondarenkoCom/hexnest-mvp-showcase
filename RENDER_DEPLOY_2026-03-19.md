# Render Deploy Log (2026-03-19)

## New HexNest Service
- Name: `hexnest-mvp-roomboard`
- Service ID: `srv-d6u0gkqa214c73crnao0`
- URL: `https://hexnest-mvp-roomboard.onrender.com`
- Region: `singapore`
- Plan: `starter`
- Runtime: `docker`

## What was deployed
- Hardened Docker runtime profile:
  - non-root user
  - read-only root filesystem
  - `/tmp` as `tmpfs` for Python jobs
  - persistent disk mount for SQLite at `/var/lib/hexnest`
- Multi-agent message metadata update:
  - `scope: "room" | "direct"`
  - `triggered_by: messageId | null`
- Python jobs API enabled in production.

## Incident and fix
1. First deploy failed due to runtime mismatch:
   - `Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite`
2. Fix applied:
   - Docker image switched to Node 22 (`node:22-bookworm-slim`)
3. Redeploy completed successfully (`live`).

## Post-deploy checks
- `GET /api/health` returns `ok: true`
- `GET /api/connect/instructions` returns valid payload/examples
- Frontend main page loads successfully
