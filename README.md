# Canvas Cowork

A spatial canvas interface where humans and AI agents collaborate through a shared workspace. The canvas is abstracted as a file system -- users interact visually on the canvas, while agents read and write files.

> Cursor is an AI in the IDE. Claude Code is an AI in the terminal. Canvas Cowork is an AI on the canvas.

## How It Works

### Canvas FS

Every canvas element maps bidirectionally to a file or directory:

| Canvas Element | File System | Description |
|----------------|-------------|-------------|
| Text | `name.txt` | Text content as file content |
| Image | `name.png` | Image file with optional annotation overlay |
| Frame | `name/` | Directory that groups elements |
| Arrow | Connection metadata | Semantic link between elements |

When a user drags an image into a frame on the canvas, the agent sees a file moved into a directory. When the agent writes a new file, it appears on the canvas automatically.

### Annotated Images

When an image has arrows or drawings on it, the agent receives two views: the **original image** and an **annotated image** (screenshot with all markups visible), enabling precise visual feedback.

### Agent Tools

- **`canvas_snapshot`** - Semantic snapshot of the canvas as a directory tree with arrow connections
- **`canvas_screenshot`** - Full canvas screenshot for visual context
- **`generate_image`** - AI image generation and editing
- Standard file operations (read, write, edit, bash) scoped to the canvas directory

### Chat with Context

The chat input supports `@` mentions to reference canvas elements and attaching the current canvas selection as context for the agent.

## Tech Stack

- **Runtime**: [Bun](https://bun.sh)
- **Canvas**: [tldraw](https://tldraw.dev) v4
- **Frontend**: React 19, Tailwind CSS v4, shadcn/ui
- **Build**: Vite
- **Agent**: Anthropic Claude via [picoagent](https://github.com/nicobailon/pi-coding-agent)

## Getting Started

```bash
bun install
bun run dev
```

This starts both the Vite dev server (port 5173) and the Bun backend (port 3000).

## Architecture

```
src/
  server/          # Bun HTTP/WebSocket server, agent session management, Canvas FS bridge
  shared/          # WebSocket protocol types
  web/src/
    components/    # React UI (canvas editor, agent panel, chat)
    canvas/        # Bidirectional canvas-filesystem sync logic
    hooks/         # WebSocket connection and agent state management
canvas/            # Canvas FS working directory (agent's workspace)
```

## License

MIT
