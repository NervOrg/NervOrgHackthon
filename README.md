# edu3d — NPC Maker World

A browser-based 3D world with two modes:

- **Maker Mode** — fly noclip, type prompts to spawn AI-generated NPCs (driven by **OpenAI + Blender MCP** running on your machine), edit their dialogue, drag them around.
- **Play Mode** — walk on the ground in first person, look at NPCs, press **E** to talk to them.

Generation runs as an OpenAI agent loop on your Node server. The agent is given the MCP tools exposed by `uvx blender-mcp` (which talks to your running Blender) and uses them to build, place, and export a GLB. While generation runs, a glowing pulsing blob stands in for the NPC.

## Architecture

```
┌───────────────────┐                ┌─────────────────────────┐                  ┌────────────────────┐
│      Browser      │  WebSocket ──▶ │   Node Server           │  MCP/stdio ───▶  │  uvx blender-mcp   │
│   Three.js scene  │  ◀──────       │   (your machine)        │  ◀── tools ───   │  (your machine)    │
│   /assets/*.glb   │  HTTP   ◀───── │   • OpenAI agent loop   │                  │     │              │
│   loading blob    │                │   • world.json          │                  │     ▼ socket       │
└───────────────────┘                │   • assets/*.glb        │                  │   Blender + addon  │
                                     └─────────────────────────┘                  └────────────────────┘
```

Everything runs on your computer. No DB, no cloud. Generation is per-request through OpenAI's API; tool calls are dispatched to the persistent Blender MCP connection.

## Quick start

```bash
npm install
cp .env.example .env
# edit .env: set OPENAI_API_KEY, optionally OPENAI_MODEL

# 1) Start Blender; enable the blender-mcp addon (it listens on a socket).
# 2) Then start the server:
npm start
```

Open <http://localhost:3000>.

For UI iteration without Blender or any API calls:

```bash
npm run dev   # FAKE_GENERATOR=1 — instant capsule placeholders
```

## Generator backends

Pick one with `GENERATOR=` (or override with `FAKE_GENERATOR=1`):

| Backend  | How to enable           | What it does                                                                                  |
| -------- | ----------------------- | --------------------------------------------------------------------------------------------- |
| `openai` | `npm start` (default)   | OpenAI agent loop drives the Blender MCP tools directly via the official `@modelcontextprotocol/sdk`. |
| `codex`  | `npm run start:codex`   | Spawns the Codex CLI per request (`codex exec ...`) with `blender-mcp` configured in MCP. Legacy. |
| `fake`   | `npm run dev`           | No Blender, no API calls. Renders a 3-second placeholder. For UI work.                        |

## System prompt — `config/systemPrompt.txt`

This file is loaded **fresh on every request** (no server restart needed when you edit it). The literal string `{{prompt}}` is replaced with what the user typed in the textbox. After your prompt, the server appends a strict "SERVER REQUIREMENTS" section that tells the agent the exact GLB export path, polygon budget, axis convention, and the rule "do not delete other objects in the scene" so the Blender world accumulates across requests.

Default contents (yours, verbatim):

```
Always search for and use existing model, because if there is an existing
model that suit the request, you don't have to do anything and your job is
then position that model in the scene in the suitable position. that model
not exist, then you start creating your own.
when creating your own, search online for a reference image, then for every
step, review if your action match that image (don't have to be exact 100%).
Always follow or use the same theme (for example: low-poly) when searching
for models or create your own.
Do everything step by step, Always use PRAV, always verify after each
action with more than one viewport and lot of vision capabilities like
math to understand exactly what you did.

Most importantly, all objects should be visible and not overlap on each
other.

Request: {{prompt}}
```

## Environment variables

| Variable             | Default            | Notes                                                                            |
| -------------------- | ------------------ | -------------------------------------------------------------------------------- |
| `PORT`               | `3000`             | HTTP / WebSocket port                                                            |
| `GENERATOR`          | `openai`           | `openai` \| `codex` \| (or set `FAKE_GENERATOR=1` to bypass)                     |
| `OPENAI_API_KEY`     | _(required)_       | For `GENERATOR=openai`                                                           |
| `OPENAI_MODEL`       | `gpt-4.1`          | Any tool-calling model. Vision-capable models can use Blender screenshots.       |
| `OPENAI_MAX_STEPS`   | `80`               | Max agent iterations (tool call rounds) per spawn                                |
| `MCP_CMD`            | `uvx`              | Command launched for the Blender MCP server                                      |
| `MCP_ARGS`           | `blender-mcp`      | Args for the MCP server (whitespace-split)                                       |
| `CODEX_TIMEOUT_MS`   | `900000` (15 min)  | Per-job timeout (also used as the OpenAI-agent timeout)                          |
| `CODEX_CMD`          | `codex`            | Override the Codex binary (only for `GENERATOR=codex`)                           |
| `FAKE_GENERATOR`     | _(unset)_          | Set to `1` to skip Blender/OpenAI                                                |
| `FAKE_DELAY_SEC`     | `3`                | Seconds to "render" in fake mode                                                 |

## What the agent loop actually does

1. On startup the server lazily spawns `uvx blender-mcp` once and connects an MCP client. That connection is reused for every job.
2. When a `spawn_npc` arrives, the server:
   - Generates a job id (`npc_<8>`).
   - Broadcasts `npc_pending` so all browsers show the **glowing pulsing blob** at the spawn point.
   - Loads `config/systemPrompt.txt`, fills in `{{prompt}}`, appends the server requirements (export path = `assets/<id>.glb`, feet-at-Y0, ≤50k polys, don't delete other objects, etc.).
   - Calls `openai.chat.completions.create` with all of Blender MCP's tools converted to OpenAI function specs, `tool_choice: 'auto'`, `parallel_tool_calls: false`.
   - For each tool call: dispatches to MCP, sends the text result back as a `tool` message. **Image content** from MCP (e.g. viewport screenshots) is forwarded as a follow-up `user` message with `image_url` blocks so vision-capable models can actually see the viewport.
   - Loops up to `OPENAI_MAX_STEPS` until the agent stops calling tools (or the GLB appears on disk early — useful as an exit-fast).
   - Validates the GLB exists and is ≥1KB.
   - Persists the NPC to `world.json` and broadcasts `npc_ready`.

If the agent ends with a message starting with `ERROR:`, the server treats it as a failure and broadcasts `npc_failed`. A 15-minute timeout (`CODEX_TIMEOUT_MS`) kills the loop hard.

## Controls

### Maker Mode

- **Click canvas** — capture mouse (pointer lock) for look
- **WASD** — move horizontally; **Space / Shift** — up / down; **Ctrl** — fly faster
- **Esc** — release mouse so you can click panels
- **Click an NPC** — open the edit panel (name, dialogue lines, position, rotation, scale, delete)
- **"Move (drag on ground)"** — drag the NPC across ground or up onto slopes
- **Type prompt → Spawn** (or **Cmd/Ctrl+Enter** in the textbox) — queue a generation 5 units in front of the camera, on the surface
- **Tab** — switch to Play Mode

### Play Mode

- **Click canvas** — capture mouse
- **WASD** — walk; mouse to look. Y is locked to ground level + eye height (you'll walk *over* the slopes, not through them).
- **E** — talk to the NPC under your crosshair (≤ 3.5 units)
- **Space / Click / Enter** — advance dialogue · **Esc** — close dialogue / release mouse
- **Tab** — switch to Maker Mode

## File layout

```
edu3d/
├── server.js                # Express + WS, routes, broadcast
├── worldStore.js            # world.json read/write + mutex
├── codexRunner.js           # generator dispatcher (fake | openai | codex)
├── openaiAgent.js           # OpenAI tool-calling loop
├── mcpClient.js             # singleton blender-mcp client
├── config/
│   └── systemPrompt.txt     # editable prompt template ({{prompt}} slot)
├── world.json               # persistent world state
├── assets/                  # generated GLBs land here, served at /assets/*
└── public/
    ├── index.html
    ├── styles.css
    └── js/
        ├── main.js
        ├── world.js         # NPC list + per-frame tick()
        ├── npc.js           # GLB loading, auto-scale to 1.8m, pulsing loading blob
        ├── terrain.js       # low-poly slope generator
        ├── makerMode.js
        ├── playMode.js      # ground-following walk camera
        ├── ws.js
        └── ui.js
```

## WebSocket protocol

Client → server:

```ts
{ type: 'spawn_npc',  prompt: string, position: [x,y,z], rotation: [x,y,z] }
{ type: 'update_npc', id: string, patch: { name?, dialogue?, position?, rotation?, scale? } }
{ type: 'delete_npc', id: string }
```

Server → all clients (broadcast):

```ts
{ type: 'world_state',  npcs: NPC[] }                     // sent on connect
{ type: 'npc_pending',  id, prompt, position, rotation }  // show loading blob
{ type: 'npc_progress', id, message }                     // agent step / tool name
{ type: 'npc_ready',    npc: NPC }                        // generation done
{ type: 'npc_failed',   id, error }                       // remove blob
{ type: 'npc_updated',  id, patch }                       // sync edits
{ type: 'npc_deleted',  id }
```

## Notes / known limitations (intentional, MVP scope)

- No auth — anyone with the URL can spawn / edit / delete.
- No moderation, no rate limits.
- One world. No per-user worlds, no rooms.
- No physics. Walking through NPCs is fine; interaction is by looking + E.
- No animation — generated GLBs are static.
- Desktop only; mouse + keyboard required.
- `assets/` grows forever. Clean up by deleting GLBs + their entries in `world.json`.
