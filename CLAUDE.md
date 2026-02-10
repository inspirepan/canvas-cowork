# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Canvas Cowork is a spatial canvas interface where humans and AI agents collaborate through a shared workspace. The canvas is abstracted as a file system -- users interact visually on the canvas (tldraw), while agents read and write files. Bidirectional sync keeps both sides consistent.

## Commands

```bash
bun run dev           # Start both Vite dev server (5173) and Bun backend (3000)
bun run dev:server    # Start only the Bun backend server
bun run dev:web       # Start only the Vite dev server
bun run build         # Production build (Vite output to dist/)
bun run start         # Start production server
bun run lint          # Biome check
bun run lint:fix      # Biome check with auto-fix
bun run format        # Biome format
bun run check         # Biome check + fix + unsafe fixes
bun test              # Run all tests (Bun built-in test runner)
bun test <file>       # Run a single test file
```

## Tech Stack

- **Runtime**: Bun (NOT Node.js)
- **Frontend**: React 19, tldraw v4, Tailwind CSS v4, shadcn/ui (New York style, neutral base)
- **Build**: Vite 7
- **Backend**: Bun HTTP/WebSocket server (no framework)
- **Linting/Formatting**: Biome (NOT ESLint/Prettier)
- **Agent**: `@mariozechner/pi-coding-agent` for AI session management
- **Image Processing**: sharp (server-side), Google Gemini API (generation)

## Architecture

```
src/
  server/              # Bun HTTP/WebSocket server
    index.ts           # Server entry: WebSocket handler, file upload endpoints, static serving
    canvas-fs.ts       # File system watcher for canvas/ directory, metadata (.canvas.json) management
    agent-manager.ts   # AI agent session lifecycle, multi-provider LLM support
    canvas-tools.ts    # Tools exposed to agent: canvas_snapshot, canvas_screenshot, generate_image
    canvas-system-prompt.md  # System prompt loaded at agent init
  shared/
    protocol.ts        # WebSocket message types (client <-> server)
  web/src/
    App.tsx            # Root component: canvas + agent panel layout
    canvas/
      canvas-sync.ts       # Core bidirectional sync engine (shape <-> file mapping)
      canvas-sync-utils.ts # Dedup, move detection, cache busting helpers
      NamedTextShapeUtil.tsx   # Custom tldraw shape: named text blocks
      NamedImageShapeUtil.tsx  # Custom tldraw shape: named images
      NoNestFrameShapeUtil.tsx # Custom frame that disallows nesting, auto-resizes
    components/
      CanvasEditor.tsx   # Tldraw editor wrapper with custom tools
      AgentPanel.tsx     # Session list / active chat panel
      SessionChat.tsx    # Chat UI with streaming, tool calls, @mentions
      OutlinePanel.tsx   # File-tree sidebar mirroring canvas structure
    hooks/
      use-agent.ts       # WebSocket connection, session state, message streaming
      useCanvasSelection.ts  # Tracks canvas selection for agent context
canvas/                # Agent workspace directory (gitignored), files here map to canvas shapes
scripts/
  generate_image.py    # Python uv script for Gemini image generation
```

### Core Concept: Canvas FS

The central abstraction is bidirectional mapping between canvas elements and files:

| Canvas Element | File System      |
|----------------|------------------|
| Text block     | `name.txt`/`.md` |
| Image          | `name.png`/etc   |
| Frame          | subdirectory     |
| Arrow          | connection metadata (not a file) |

- `canvas-fs.ts` (server) watches the `canvas/` directory and broadcasts changes via WebSocket
- `canvas-sync.ts` (client) applies file changes to tldraw shapes and vice versa
- `.canvas.json` in `canvas/` stores the tldraw snapshot and shape-to-file mapping
- Frames cannot be nested (only one level of subdirectories)

### WebSocket Protocol

All client-server communication uses a typed WebSocket protocol defined in `src/shared/protocol.ts`. Message types cover: session management, prompt/abort, model selection, canvas sync, and screenshot request/response.

### Dev Server Proxying

Vite proxies `/ws` (WebSocket) and `/canvas/*` (file serving/upload) to the Bun backend at `localhost:3000`.

## Code Style

- **Biome** enforces formatting and linting (2-space indent, 100 char line width, double quotes, semicolons)
- Strict unused variable/import/parameter checking (errors, not warnings)
- `noForEach` is enforced -- use `for...of` loops
- `noBarrelFile` and `noReExportAll` are enforced
- TypeScript strict mode with `@/*` path alias mapping to `src/web/src/*`
- Use `import type` for type-only imports (`useImportType`/`useExportType` enforced)

## Environment Variables

LLM providers (set whichever you use): `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `AZURE_OPENAI_API_KEY`, `XAI_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`

Image generation: `GEMINI_API_KEY` or Vertex AI config (`GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `GOOGLE_APPLICATION_CREDENTIALS`)
