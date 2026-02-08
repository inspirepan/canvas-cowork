# Canvas Cowork Architecture

## Project Vision

Canvas Cowork is a canvas-based AI collaboration interface for Lovart. The core idea: abstract a spatial canvas as a file system for AI agents to operate on. Users interact through the canvas; agents interact through files. The canvas is the primary interface, not chat.

Analogy:
- Cursor = IDE with embedded AI (IDE is primary)
- Claude Code = AI in terminal (file system is primary)
- Canvas Cowork = AI in canvas (canvas is primary)

---

## Phase 1: Agent Panel (Current)

Before building the full canvas experience, we first build a standalone agent chat panel. This panel will eventually float as a sidebar on the right side of the tldraw canvas.

### UI Structure

Two views, navigation by push/pop:

1. **Session List (default view)**
   - Shows all conversation sessions with title, relative timestamp, streaming indicator
   - "New conversation" button at top and bottom
   - Click a session to enter it

2. **Session Chat (detail view)**
   - Header: back arrow + session title (truncated) + streaming indicator
   - Message list: user messages (right-aligned bubbles), assistant messages (left-aligned blocks)
   - Input box at bottom: textarea + send/stop button, model selector dropdown, thinking level dropdown

### Message Types Rendered

| Type | Rendering |
|------|-----------|
| User message | Right-aligned bubble with text |
| Assistant text | Left-aligned prose |
| Thinking/reasoning | Collapsible block, "Thinking..." while streaming, "Thought" when done |
| Tool call | Collapsible block showing tool name, status icon (spinning/check/error), expandable args + result |
| Tool result | Attached inline to its parent tool call block |

### Panel Dimensions

- Width: ~380px (narrower than Cursor's ~480px sidebar, designed to float on canvas)
- Full height of viewport

---

## Multi-Session Design

### Concurrent Sessions

Multiple AgentSession instances can run simultaneously in memory. Switching sessions does NOT dispose the previous one. A session running in background continues executing (LLM streaming, tool calls) and its events are still received and stored.

### Session Lifecycle

```
[On Disk] --load_session--> [Loaded/Idle] --prompt--> [Streaming]
                                  ^                        |
                                  |--- agent_end/abort ----|
[Loaded/Idle] --unload_session--> [On Disk]
```

- **On Disk**: Historical session files, listed via SessionManager.list(). Not in memory.
- **Loaded**: AgentSession instance alive in memory. Can receive prompts.
- **Streaming**: Actively running LLM / tools. Can be aborted.

### Session List Items

Each session shows:
- Title (first user message, truncated to 100 chars)
- Relative timestamp (e.g., "3m", "2h", "5d")
- Streaming indicator (spinner if agent is running)

---

## Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Runtime | Bun | Fast, built-in HTTP + WebSocket server |
| Agent SDK | @mariozechner/pi-coding-agent | Full coding agent with tools (read, write, edit, bash) |
| Frontend framework | React | Required by tldraw (future), good ecosystem |
| Build tool | Vite | Fast HMR, tldraw ecosystem standard |
| CSS | Tailwind CSS v4 | Utility-first, pairs with shadcn/ui |
| UI components | shadcn/ui (new-york style) | Composable primitives, good defaults |
| Font stack | Inter (sans), JetBrains Mono (mono) | Clean, readable |
| Color palette | Warm neutral (oklch-based) | Matches Anthropic/design-tool aesthetic |

---

## Server Architecture

### HTTP Server

- Serves built frontend assets from `dist/` in production
- In development, Vite dev server handles frontend with HMR; WebSocket proxied to Bun

### WebSocket Server

Single `/ws` endpoint. All communication between frontend and backend goes through WebSocket.

Message flow:
- **Client -> Server**: create/load/unload session, prompt, abort, set model, set thinking level, list sessions, get models
- **Server -> Client**: session created/loaded/unloaded, stream deltas (text, thinking, tool calls, tool results), session state updates, model/thinking changes, error

### AgentManager

Manages a `Map<sessionId, ManagedSession>`:
- Each ManagedSession holds an AgentSession + event subscription + metadata
- Creates sessions via `createAgentSession()` from pi SDK
- Subscribes to AgentSessionEvent and translates to StreamDelta for WebSocket
- Handles prompt routing (auto-detects streaming state for steer/followUp)

---

## WebSocket Protocol Design Decisions

1. **All messages carry sessionId** (except create_session request and list-level responses) to support concurrent sessions

2. **Stream deltas are granular**: text_delta, thinking_delta, toolcall_start/end, tool_exec_start/end. Frontend accumulates these incrementally.

3. **Optimistic user messages**: Frontend adds user message to UI immediately on send, before server confirms. Server's message_end for user messages is used for reconciliation if needed.

4. **Model/thinking changes are per-session**: Each session independently tracks its model and thinking level.

---

## Development Workflow

```
bun run dev        # Concurrent: Vite dev server (5173) + Bun server (3000)
bun run dev:server # Backend only with --watch
bun run dev:web    # Frontend only with Vite HMR
bun run build      # Vite production build to dist/
bun run start      # Production: Bun serves dist/ + WebSocket
```

Vite proxies `/ws` to `ws://localhost:3000` in dev mode.

---

## Future: Phase 2 - Canvas FS

The agent panel will be embedded as a floating sidebar in a tldraw canvas. The Canvas FS bridge will:

- Map canvas elements to files: text->txt, image->png, frame->folder, arrow->connection
- Bidirectional sync: canvas changes write files, file changes update canvas
- Agent operates on real files via standard tools; Canvas FS translates to/from canvas
- Custom tools: Snapshot (canvas state as directory tree), Screenshot (canvas visual capture)

This is documented separately in `canvas-cowork-proposal.md`.
