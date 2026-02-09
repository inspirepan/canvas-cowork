# Canvas FS Implementation Plan

> Based on: `canvas-cowork-proposal.md`, `architecture.md`, `tldraw-research.md`, `pi-sdk-api.md`
>
> Created: 2026-02-09

---

## Current State

Phase 1 (TLDraw Integration) and Phase 2 (CanvasFS Core) are complete.

- **Backend**: Bun HTTP/WS server + `AgentManager` wrapping `@mariozechner/pi-coding-agent` SDK
- **Protocol**: Full WebSocket bidirectional protocol (stream delta, session lifecycle, canvas FS events)
- **Frontend**: `CanvasEditor` (tldraw full-screen) + floating `AgentPanel` sidebar (380px, toggleable)
- **CanvasFS**: `canvas/` auto-created on startup, recursive file watcher with 300ms debounce, `.canvas.json` read/write, file-to-shape mapping rules
- **New protocol types**: `canvas_fs_change` (server->client), `canvas_sync` (client->server), `CanvasFSEvent`, `CanvasSyncChange`

What does NOT exist yet:

- No custom shapes (NamedText) or tool restriction
- No bidirectional sync (canvas <-> filesystem)
- No agent custom tools or system prompt customization

---

## Phases Overview

```
Phase 1: TLDraw Integration + Layout                              [DONE]
Phase 2: CanvasFS Core (directory, file watcher, .canvas.json)     [DONE]
Phase 3: Custom Shapes + Tool Restriction (NamedText, Frame rules) [DONE]
Phase 4: Bidirectional Sync (canvas <-> filesystem)
Phase 5: Agent Tools + System Prompt (canvas_snapshot, screenshot)
Phase 6: Frontend Polish (auto-layout, frame resize, smooth transitions)
```

---

## Phase 1: TLDraw Integration + Layout

**Goal**: Embed tldraw as the primary canvas, reposition AgentPanel as a floating sidebar.

### 1.1 Install tldraw

```bash
bun add tldraw
```

### 1.2 Create `CanvasEditor` component

New file: `src/web/src/components/CanvasEditor.tsx`

- Render `<Tldraw>` with full viewport
- Import `tldraw/tldraw.css`
- Accept an `onMount` callback that receives the `Editor` instance
- Store the Editor ref for later use by sync layer

### 1.3 Refactor `App.tsx` layout

Change from centered AgentPanel to:

```
+--------------------------------------------------+
|                                                  |
|              TLDraw Canvas (full)        [Panel] |
|                                          380px   |
|                                                  |
+--------------------------------------------------+
```

- Canvas takes full viewport
- AgentPanel floats on the right side (absolute/fixed, 380px width, full height)
- Panel toggle button to show/hide

### 1.4 Verification

- Canvas renders, pan/zoom works
- AgentPanel overlays canvas, chat works
- Panel can be toggled

---

## Phase 2: CanvasFS Core

**Goal**: Establish the `canvas/` directory and the mapping data model. No sync yet -- just the backend foundation.

### 2.1 Auto-create `canvas/` directory

In `src/server/index.ts`, on startup:

```typescript
import { mkdirSync, existsSync } from "fs";
const canvasDir = join(cwd, "canvas");
if (!existsSync(canvasDir)) mkdirSync(canvasDir, { recursive: true });
```

### 2.2 Create `src/server/canvas-fs.ts`

The `CanvasFS` class manages the mapping between canvas shapes and filesystem:

**Element-to-file mapping rules** (from proposal):

| Canvas Element | File System | Notes |
|---|---|---|
| NamedText shape | `{name}.txt` | Text content = file content |
| Image shape | `{name}.png/jpg` | Binary file |
| Frame shape | `{name}/` directory | Mutually exclusive, no nesting |
| Arrow | Connection metadata | Two ends must attach to elements for semantics |
| Draw (brush) | No direct file | Has semantics only when overlaying an image |

**CanvasFS responsibilities**:

- Read `canvas/` directory and produce a shape-mapping manifest
- Write/delete/rename/move files in `canvas/` on canvas changes
- Parse `.canvas.json` for non-semantic data (positions, sizes, styles, arrow bindings)
- Produce the semantic snapshot (directory tree + arrow connections)

### 2.3 `.canvas.json` format

Stored at `canvas/.canvas.json`. Persists all canvas state that isn't file content:

```jsonc
{
  "version": 1,
  // Full tldraw snapshot for shapes, positions, styles, etc.
  // This is the serialized tldraw store state.
  "tldraw": { /* getSnapshot(editor.store) output */ },
  // Mapping from tldraw shape IDs to filesystem paths
  "shapeToFile": {
    "shape:abc123": "notes.txt",
    "shape:def456": "refs/style.png",
    "shape:frame1": "refs/"
  }
}
```

### 2.4 File watcher

Use `fs.watch` (or Bun's watcher) on `canvas/` recursively:

- Detect file created/modified/deleted/renamed
- Debounce rapid changes (agent edits often produce multiple writes)
- Emit events to the sync layer (Phase 4)
- Ignore `.canvas.json` changes (self-triggered)

---

## Phase 3: Custom Shapes + Tool Restriction

**Goal**: Constrain the canvas to project-relevant tools only. Create the NamedText custom shape.

### 3.1 Restrict tools/shapes

Only allow these tools in the tldraw toolbar:

| Tool | Purpose |
|---|---|
| Select | Default selection/move |
| Hand | Pan canvas |
| Frame | Create folders |
| NamedText | Create named text files |
| Image (upload) | Add images |
| Draw (brush) | Freehand annotation |
| Arrow | Connect elements |
| Eraser | Remove elements |

Remove: Geo, Note, Line, Highlight, Laser, Zoom tool (keep zoom via gestures).

Implementation: Pass custom `tools` and `shapeUtils` to `<Tldraw>` component. Override the default toolbar UI via tldraw's `components` prop or `overrides`.

### 3.2 NamedText custom shape

New file: `src/web/src/canvas/NamedTextShapeUtil.tsx`

This is the core custom shape. Unlike tldraw's built-in text shape, it has a **name** (like Figma's layer name).

**Props**:

```typescript
{
  name: string     // Displayed above text, maps to filename (e.g., "brief")
  text: string     // File content
  w: number        // Width
}
```

**Rendering**:

```
  brief.txt              <-- name label (small, muted, above the shape)
+---------------------+
| This is the design  |  <-- text content area (editable)
| brief for the       |
| project...          |
+---------------------+
```

- Name label renders above the shape boundary (similar to how frame names appear)
- Text area is editable on double-click
- Auto-height: height adjusts to fit text content
- Name is editable via a separate interaction (double-click the label, or property panel)

**File extension**: Always `.txt`. The name prop does NOT include the extension. File path = `{parent_frame_name}/{name}.txt` or `{name}.txt` if at root.

### 3.3 Frame shape adaptation

Use tldraw's built-in `FrameShapeUtil` with constraints:

- **No nesting**: Override `canReceiveNewChildrenOfType` to reject other frames. A frame cannot be dragged into another frame.
- **Mutual exclusivity**: A shape can only belong to one frame at a time (tldraw's default reparenting handles this).
- **Name = folder name**: Frame's `name` prop maps to directory name in `canvas/`.

### 3.4 Image shape

Use tldraw's built-in image shape. Considerations:

- Image name derived from asset filename or user-specified name
- Images inside frames map to `{frame_name}/{image_name}.png`
- Support drag-and-drop upload from desktop

---

## Phase 4: Bidirectional Sync

**Goal**: Canvas changes propagate to filesystem; filesystem changes (from agent) propagate to canvas.

This is the most complex phase. The key challenge is avoiding infinite loops (canvas change -> file write -> file watcher -> canvas update -> ...).

### 4.1 Sync direction markers

Every change has a **source**:

- `"canvas"`: User manipulated the canvas
- `"fs"`: Agent (or external process) modified files
- `"init"`: Loading from `.canvas.json` on startup

The sync layer **ignores changes from the opposite source** to break loops.

### 4.2 Canvas -> Filesystem (user edits)

Listen to tldraw `store.listen()` with `{ source: 'user', scope: 'document' }`:

**Shape created**:
- NamedText -> write `{name}.txt` with text content
- Frame -> create `{name}/` directory
- Image -> copy image data to `{name}.png`

**Shape updated**:
- NamedText text changed -> rewrite file content
- NamedText/Frame name changed -> rename file/directory
- Shape reparented (moved in/out of frame) -> move file between directories

**Shape deleted**:
- NamedText -> delete `.txt` file
- Frame -> delete directory (and contents? or prevent if non-empty?)
- Image -> delete image file

**Non-semantic changes** (position, size, style):
- Only update `.canvas.json` (debounced)
- Do NOT trigger file operations

### 4.3 Filesystem -> Canvas (agent edits)

File watcher detects changes in `canvas/`:

**File created**:
- `.txt` file -> create NamedText shape on canvas
- `.png/.jpg` file -> create Image shape on canvas
- New directory -> create Frame shape

**File modified**:
- `.txt` file -> update NamedText shape's text prop

**File deleted**:
- Remove corresponding shape from canvas

**File moved** (detected as delete + create with same content, or via rename event):
- `reparentShapes()` to move shape between frames

### 4.4 Position calculation for new shapes from FS

When agent creates a file and we need to place a new shape on canvas:

- If file is in a subdirectory (frame), place inside that frame with auto-layout
- If file is at root, place in an open area of the canvas
- Use a simple grid/flow layout within frames
- Avoid overlapping existing shapes

### 4.5 WebSocket protocol extensions

New message types in `protocol.ts`:

```typescript
// Server -> Client: filesystem changed, update canvas
| { type: "canvas_fs_change"; changes: CanvasFSChange[] }

// Client -> Server: canvas changed, update filesystem  
| { type: "canvas_sync"; changes: CanvasSyncChange[] }

interface CanvasFSChange {
  action: "create" | "update" | "delete" | "move"
  path: string           // relative to canvas/
  content?: string       // for text files
  oldPath?: string       // for moves
}

interface CanvasSyncChange {
  action: "create" | "update" | "delete" | "move" | "rename"
  shapeType: "named_text" | "frame" | "image"
  path: string
  content?: string
  oldPath?: string
}
```

### 4.6 `.canvas.json` persistence

- Debounced write (500ms) on any canvas store change
- Full tldraw snapshot + shape-to-file mapping
- On startup: if `.canvas.json` exists, load snapshot to restore canvas state
- If `.canvas.json` does not exist but `canvas/` has files, bootstrap canvas from filesystem

---

## Phase 5: Agent Tools + System Prompt

**Goal**: Give the agent awareness of Canvas FS through custom tools and system prompt.

### 5.1 `canvas_snapshot` tool

Register via `createAgentSession({ customTools: [canvasSnapshotTool] })`.

**Tool definition** (TypeBox schema):

```typescript
const canvasSnapshotTool: ToolDefinition = {
  name: "canvas_snapshot",
  label: "Canvas Snapshot",
  description: "Get a semantic snapshot of the current canvas state as a directory tree with connection (arrow) relationships.",
  parameters: Type.Object({
    include_coords: Type.Optional(Type.Boolean({
      description: "Include shape coordinates in output. Default: false."
    })),
    include_content: Type.Optional(Type.Boolean({
      description: "Include text file contents inline. Default: false."
    })),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // Read canvas/ directory structure
    // Parse .canvas.json for arrow bindings
    // Build tree output
    // Return formatted snapshot
  }
}
```

**Output format** (from proposal):

```
/
+-- refs/
|   +-- style.png (annotated)
|   +-- notes.txt
+-- reference.png
+-- brief.txt

Arrows:
  reference.png (0.25, 0.10) -> refs/style.png
```

The `(annotated)` marker (proposal uses emoji) indicates images with arrow/brush overlays. Agent can request the annotated view separately.

### 5.2 `canvas_screenshot` tool (lower priority)

Capture the entire canvas as a PNG image. Uses tldraw's export API (`editor.toImage()`).

```typescript
const canvasScreenshotTool: ToolDefinition = {
  name: "canvas_screenshot",
  label: "Canvas Screenshot",
  description: "Capture a visual screenshot of the entire canvas, including all non-semantic elements.",
  parameters: Type.Object({}),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // Request screenshot from frontend via WebSocket
    // Return as ImageContent
  }
}
```

This requires a round-trip: backend requests screenshot from frontend, frontend calls `editor.toImage()`, sends result back.

### 5.3 Image dual-view (annotated images)

From the proposal: "When an image has any arrow or brush annotation on it, Agent gets two images: the **original** and the **annotated** (screenshot-like, with arrows and brush strokes)."

**Implementation**:

- In `canvas_snapshot`, detect images that have arrows or draw shapes overlaying them
- Mark these with `(annotated)` in the snapshot output
- Provide a `get_annotated_image` tool (or parameter in `canvas_snapshot`) that:
  1. Identifies arrows/draw shapes that are on the image's layer (bound to or overlapping the image)
  2. Uses tldraw's export API to render that image region including overlays
  3. Returns both the original image file and the annotated screenshot

**Semantic boundary rules**:

- Arrows/draw strokes **on an image** (bound to or overlapping) -> **semantic**, included in annotated view
- Arrows **between elements** (connecting two shapes) -> **semantic**, included in snapshot Arrows section
- Floating arrows/draw strokes (not attached to anything) -> **non-semantic**, not in FS view

### 5.4 System prompt

Use `.pi/APPEND_SYSTEM.md` in the canvas/ working directory, or inject at runtime via the SDK.

In `agent-manager.ts`, after creating the session, append Canvas FS context to the system prompt:

```typescript
const canvasSystemPrompt = `
## Canvas FS

You are working in a Canvas FS environment. The \`canvas/\` directory is a bidirectional mirror of a spatial canvas that the user sees and interacts with.

### File-to-Canvas Mapping
- \`.txt\` files = text elements on the canvas (named text blocks the user can see)
- \`.png/.jpg\` files = image elements on the canvas
- Subdirectories = frames (visual groups/containers) on the canvas
- Frames are flat (one level only, no nested frames)

### How It Works
- When you create/edit/delete files in \`canvas/\`, the changes appear on the user's canvas in real-time
- When the user creates/edits/deletes elements on the canvas, the files update accordingly
- Moving a file between directories = moving an element between frames on the canvas

### Tools
- Use \`canvas_snapshot\` to see the current canvas structure (directory tree + arrow connections)
- Images marked as "(annotated)" have user annotations (arrows/drawings on them)
- Standard file tools (read, write, edit, bash) work on canvas/ files and are reflected on canvas

### Best Practices
- Use \`canvas_snapshot\` at the start of a task to understand the current canvas state
- Create subdirectories (frames) to organize related content
- Use descriptive filenames -- they become visible labels on the canvas
- When creating text files, the content appears directly on the canvas for the user to read
`;
```

Method: Append to system prompt via `session.agent.setSystemPrompt(session.systemPrompt + canvasSystemPrompt)` after session creation. Or use `APPEND_SYSTEM.md` if we want it file-based.

---

## Phase 6: Frontend Polish

**Goal**: Smooth UX for agent-driven canvas changes.

### 6.1 Agent file operations -> canvas animations

When agent creates/moves/deletes files and the canvas updates:

- **Create**: New shape fades in at calculated position
- **Delete**: Shape fades out
- **Move (reparent)**: Shape animates from old position to new frame
- **Rename**: Name label updates in-place

Implementation: Use tldraw's `editor.animateShapes()` for smooth transitions.

### 6.2 Frame auto-resize

When elements are added to or removed from a frame:

- Recalculate frame bounds to fit all children with padding
- Use `fitFrameToContent(editor, frameId, { padding: 16 })` from tldraw
- Trigger on `onChildrenChange` callback in FrameShapeUtil override
- Debounce to avoid resize flicker during batch operations

### 6.3 Auto-layout within frames

When agent creates multiple files in a frame:

- Stack text elements vertically with consistent spacing
- Arrange images in a grid layout
- New elements placed below existing ones (or in next available grid cell)
- Respect minimum spacing between elements

### 6.4 Smart placement for root-level shapes

When agent creates files at `canvas/` root (not in any frame):

- Find open area on canvas (avoid overlapping existing shapes)
- Place near the center of the current viewport if possible
- Group related creations together

### 6.5 Arrow semantic detection

For the annotated image feature:

- Detect arrows whose start or end binding is attached to an image shape
- Detect draw shapes that geometrically overlap an image shape's bounds
- Cache this overlay relationship and update when shapes move

---

## Technical Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Bidirectional sync loops | Canvas <-> FS infinite cycle | Source markers; ignore self-triggered changes |
| pi-coding-agent system prompt override | May lose built-in tool descriptions | Use `APPEND_SYSTEM.md` approach instead of full replace |
| tldraw snapshot size | `.canvas.json` could be large | Only store document scope, exclude session state. Debounce writes. |
| File watcher reliability | Missed events, platform differences | Use polling as fallback; reconcile on focus |
| Agent rapid file edits | Flood of canvas updates | Debounce FS events; batch canvas updates |
| tldraw `toImage()` for screenshots | Requires browser context | Screenshot tool needs WS round-trip to frontend |
| Frame nesting prevention | tldraw natively allows nested frames | Override `canReceiveNewChildrenOfType` on FrameShapeUtil |

---

## Dependency Changes

```bash
# Phase 1
bun add tldraw

# Phase 5 (for TypeBox schemas in custom tools)
bun add @sinclair/typebox
```

---

## File Structure (new/modified)

```
src/
  server/
    index.ts                   # Modified: auto-create canvas/, pass canvasFS to manager
    agent-manager.ts           # Modified: add customTools, system prompt
    canvas-fs.ts               # NEW: CanvasFS class (directory management, snapshot, file watcher)
  shared/
    protocol.ts                # Modified: add canvas_fs_change, canvas_sync messages
  web/
    src/
      App.tsx                  # Modified: canvas + floating panel layout
      components/
        CanvasEditor.tsx       # NEW: tldraw wrapper component
        AgentPanel.tsx         # Modified: positioning for floating sidebar
      canvas/
        NamedTextShapeUtil.tsx  # NEW: custom shape for named text files
        NamedTextTool.ts       # NEW: tool for creating NamedText shapes
        canvas-tools.ts        # NEW: tool/shape restriction config
        canvas-sync.ts         # NEW: bidirectional sync logic (canvas <-> WS <-> FS)
        layout.ts              # NEW: auto-layout calculations
```

---

## Tasks

> Each phase must satisfy: `bun run dev` starts normally (frontend 5173 + backend 3000), no compile errors, no runtime crashes. Each phase includes specific verification steps and test requirements.

---

### Phase 1: TLDraw Integration + Layout

**Run requirement**: After `bun run dev`, opening `localhost:5173` in browser shows full-screen canvas + floating Agent panel on the right.

**Verification**:
1. Open browser DevTools Console, confirm no JS errors
2. Drag to pan, scroll to zoom on canvas -- confirm canvas interaction works
3. Draw default shapes (rectangles etc.) on canvas -- confirm tldraw basic features work
4. Click panel toggle button -- confirm AgentPanel can expand/collapse
5. In AgentPanel, create new session, send a message -- confirm agent reply streams normally
6. When panel is collapsed, canvas should have no obstructed areas

**Tasks**:
- [x] Install tldraw dependency (`bun add tldraw`)
- [x] Create `CanvasEditor.tsx` component wrapping `<Tldraw>`
- [x] Refactor `App.tsx` to full-screen canvas + floating AgentPanel
- [x] Style AgentPanel as floating sidebar (absolute positioned, right side)
- [x] Add panel toggle button
- [x] Verify: canvas pan/zoom works, panel does not intercept canvas events
- [x] Verify: agent chat unaffected (create session, send message, streaming reply, tool call display)

---

### Phase 2: CanvasFS Core

**Run requirement**: After `bun run dev`, `{cwd}/canvas/` directory is auto-created. Manually creating/modifying/deleting files in `canvas/` produces corresponding file change events in server logs.

**Verification**:
1. Start server, confirm terminal outputs `[canvas-fs] watching: {cwd}/canvas/`
2. `touch canvas/test.txt` -> server log outputs `[canvas-fs] created: test.txt`
3. `echo "hello" > canvas/test.txt` -> log outputs `[canvas-fs] modified: test.txt`
4. `mkdir canvas/refs` -> log outputs `[canvas-fs] created: refs/`
5. `rm canvas/test.txt` -> log outputs `[canvas-fs] deleted: test.txt`
6. Rapid writes to same file (`for i in {1..10}; do echo $i > canvas/test.txt; done`) -- confirm debounce works, not 10 log entries
7. Modifying `canvas/.canvas.json` does NOT trigger file change events (self-ignore)
8. In browser DevTools Network WS panel, new canvas message types compile and are defined correctly

**Tasks**:
- [x] Auto-create `canvas/` directory on server startup
- [x] Create `canvas-fs.ts` with `CanvasFS` class skeleton (constructor, start/stop)
- [x] Implement file-to-shape mapping rule interface (txt -> named_text, png/jpg -> image, dir -> frame)
- [x] Implement `.canvas.json` read/write methods (serialize/deserialize)
- [x] Implement recursive file watcher on `canvas/` with 300ms debounce
- [x] File watcher outputs structured logs (type, path, timestamp)
- [x] Add `canvas_fs_change` and `canvas_sync` message types to `protocol.ts`
- [x] Confirm TypeScript compiles with no type errors

---

### Phase 3: Custom Shapes + Tool Restriction

**Run requirement**: After `bun run dev`, canvas toolbar shows only 8 tools (Select, Hand, Frame, NamedText, Image, Draw, Arrow, Eraser). NamedText shapes can be created and edited.

**Verification**:
1. Toolbar check: confirm only 8 tool buttons, no Geo/Note/Line/Highlight/Laser
2. Create NamedText: select NamedText tool, click on canvas -- confirm text block with name label appears
3. Edit text: double-click NamedText text area, type multi-line text -- confirm height auto-grows
4. Edit name: double-click name label (or via panel), change name -- confirm label updates
5. Name label style: name shows as small, muted text above shape boundary, similar to Figma layer name
6. Frame nesting test: create two Frames, try dragging one into the other -- confirm it's rejected (no nesting)
7. Frame children: create a Frame and a NamedText, drag NamedText into Frame -- confirm it becomes Frame's child
8. Exclusivity test: drag NamedText already in Frame A into Frame B -- confirm it leaves Frame A
9. Default text shape unavailable: confirm no native Text tool in toolbar (replaced by NamedText)

**Tasks**:
- [x] Create `NamedTextShapeUtil`: render name label + text content, extend appropriate base class
- [x] Create `NamedTextTool`: toolbar icon and interaction (click canvas to create shape)
- [x] Implement NamedText double-click text editing
- [x] Implement NamedText name editing interaction
- [x] Implement NamedText auto-height from text content
- [x] Configure tool restriction: pass `tools` and `shapeUtils` to `<Tldraw>`
- [x] Custom toolbar UI: only show the 8 allowed tools
- [x] Extend `FrameShapeUtil`: override `canReceiveNewChildrenOfType` to prevent frame nesting
- [ ] Verify: frame nesting is blocked
- [ ] Verify: NamedText can be created, edited, dragged between frames

---

### Phase 4: Bidirectional Sync

**Run requirement**: After `bun run dev`, canvas operations sync to `canvas/` filesystem in real-time, and vice versa. Page refresh restores canvas state from `.canvas.json`.

**Verification -- Canvas -> Filesystem**:
1. Create a NamedText on canvas (named "hello") -- confirm `canvas/hello.txt` is created
2. Edit that NamedText's text content -- confirm `canvas/hello.txt` content updates
3. Create a Frame on canvas (named "refs") -- confirm `canvas/refs/` directory is created
4. Drag NamedText into Frame -- confirm `canvas/hello.txt` moves to `canvas/refs/hello.txt`
5. Rename NamedText -- confirm filename changes accordingly
6. Delete NamedText -- confirm corresponding file is deleted
7. Move shape position (no content change) -- confirm only `.canvas.json` updates, no file operations

**Verification -- Filesystem -> Canvas**:
8. Terminal: `echo "world" > canvas/new.txt` -- confirm new NamedText shape appears on canvas
9. Terminal: `echo "updated" > canvas/new.txt` -- confirm NamedText content updates on canvas
10. Terminal: `mkdir canvas/folder && mv canvas/new.txt canvas/folder/` -- confirm NamedText moves into corresponding Frame
11. Terminal: `rm canvas/folder/new.txt` -- confirm NamedText disappears from canvas

**Verification -- Persistence & Recovery**:
12. Create multiple shapes on canvas, refresh page (F5) -- confirm all shapes positions and content restore
13. Stop server, restart `bun run dev` -- confirm `.canvas.json` loads correctly

**Verification -- Loop prevention**:
14. Create NamedText on canvas -> file created -> does NOT create duplicate shape on canvas
15. Write file in terminal -> shape appears on canvas -> does NOT write file again

**Tasks**:
- [ ] Implement canvas -> FS sync: NamedText create -> write .txt file
- [ ] Implement canvas -> FS sync: NamedText update -> rewrite file content
- [ ] Implement canvas -> FS sync: Frame create -> create directory
- [ ] Implement canvas -> FS sync: shape delete -> delete file/directory
- [ ] Implement canvas -> FS sync: shape reparent (drag in/out of frame) -> move file
- [ ] Implement canvas -> FS sync: shape/frame rename -> rename file/directory
- [ ] Implement canvas -> FS sync: non-semantic changes (position/size) -> only update .canvas.json
- [ ] Implement FS -> canvas sync: .txt file create -> create NamedText shape
- [ ] Implement FS -> canvas sync: .txt file modify -> update NamedText content
- [ ] Implement FS -> canvas sync: file delete -> remove canvas shape
- [ ] Implement FS -> canvas sync: file move -> reparentShapes
- [ ] Implement FS -> canvas sync: directory create -> create Frame shape
- [ ] Implement FS -> canvas sync: image file create -> create Image shape
- [ ] Implement sync source markers (source flag) to prevent canvas->fs->canvas loops
- [ ] Implement `.canvas.json` debounced persistence (500ms debounce)
- [ ] Implement `.canvas.json` loading on startup to restore canvas
- [ ] Implement bootstrap mode: `canvas/` has files but no `.canvas.json` -> build initial canvas from FS
- [ ] Implement auto-position calculation for new shapes (within frame / root level)

---

### Phase 5: Agent Tools + System Prompt

**Run requirement**: After `bun run dev`, agent in AgentPanel can use `canvas_snapshot` tool to view canvas state. Agent file operations on `canvas/` directory reflect on canvas in real-time.

**Verification -- canvas_snapshot**:
1. Manually create some elements on canvas (text, image, frame, arrows), then tell agent in AgentPanel "view the current canvas"
2. Confirm agent calls `canvas_snapshot` tool
3. Confirm tool result is correct directory tree format, including all files and Arrows connections
4. In tool call expand panel, can see formatted snapshot output

**Verification -- agent operates canvas**:
5. Tell agent "create a text named brief on the canvas, content is project introduction"
6. Confirm agent uses `write` tool to write `canvas/brief.txt`
7. Confirm NamedText shape appears on canvas in real-time with agent-written content
8. Tell agent "create a refs folder and move brief into it"
9. Confirm agent does `mkdir canvas/refs` then `mv canvas/brief.txt canvas/refs/`
10. Confirm Frame appears on canvas, NamedText moves into Frame

**Verification -- system prompt**:
11. After creating new session, check if agent's first reply demonstrates Canvas FS awareness (not treating it as a regular coding task)
12. In agent's tool list (`session.getAllTools()`) confirm `canvas_snapshot` is included

**Verification -- annotated images (if image feature is ready)**:
13. Place an image on canvas, draw an arrow pointing to it, run `canvas_snapshot` -- confirm that image is marked `(annotated)`
14. Images without arrow/brush overlay are NOT marked `(annotated)`

**Verification -- canvas_screenshot (lower priority)**:
15. Tell agent "take a screenshot of the canvas" -- confirm PNG image returned (via WS round-trip)

**Tasks**:
- [ ] Install `@sinclair/typebox` dependency (`bun add @sinclair/typebox`)
- [ ] Implement `canvas_snapshot` tool definition (TypeBox schema + execute)
- [ ] `canvas_snapshot` output: directory tree format + Arrows connections
- [ ] `canvas_snapshot` output: `(annotated)` marker detection (arrows/draws overlaying images)
- [ ] `canvas_snapshot` optional params: `include_coords` and `include_content`
- [ ] Implement `canvas_screenshot` tool (WS round-trip: backend request -> frontend `editor.toImage()` -> return base64)
- [ ] Write Canvas FS system prompt content
- [ ] Inject system prompt in `agent-manager.ts` (`APPEND_SYSTEM.md` or runtime append)
- [ ] Pass `customTools` to `createAgentSession()`
- [ ] Test: agent calls `canvas_snapshot`, output structure is correct
- [ ] Test: agent `write canvas/test.txt` -> NamedText appears on canvas
- [ ] Test: agent `mv` file -> canvas reparent
- [ ] Test: image annotated detection is correct

---

### Phase 6: Frontend Polish

**Run requirement**: After `bun run dev`, agent file operations produce smooth visual feedback on canvas. Frames auto-resize to fit content.

**Verification**:
1. Agent creates file -> new shape smoothly fades in on canvas (not sudden appearance)
2. Agent deletes file -> shape fades out
3. Agent moves file to another directory -> shape smoothly animates from old position to new frame
4. Add multiple elements to Frame -> Frame auto-expands to contain all children
5. Remove elements from Frame -> Frame auto-shrinks
6. Agent batch creates multiple files (e.g., writes 3 .txt at once) -> elements auto-arrange within frame, no overlap
7. Root-level file creation -> new shape placed in empty canvas area, no overlap with existing shapes
8. Performance: agent rapidly writes 10 files in succession, canvas updates smoothly without stuttering

**Verification -- Arrow semantics**:
9. Draw arrow on an image, run snapshot -> output marks that image as annotated
10. Connect arrow between two NamedTexts, snapshot -> Arrows section correctly lists the connection
11. Draw a floating arrow not attached to any element, snapshot -> that arrow does NOT appear in output

**End-to-end scenario test**:
12. Scenario: User places a reference image on canvas, draws an arrow pointing to it, creates a "brief" text. Then tells agent "based on the reference image and brief, write a detailed design description". Verify agent first calls snapshot to understand canvas, then creates new file, file appears on canvas, content is reasonable.

**Tasks**:
- [ ] Implement frame auto-resize on children change (`fitFrameToContent`, debounced)
- [ ] Implement auto-layout for children within frames (vertical stack, 12-16px spacing)
- [ ] Implement smart placement algorithm for root-level shapes (avoid overlaps, near viewport center)
- [ ] Add fade-in animation for agent-created elements
- [ ] Add fade-out animation for agent-deleted elements
- [ ] Add smooth reparent animation (shape moves from one frame to another)
- [ ] Implement arrow semantic boundary detection (distinguish: arrows/draws on images, arrows between elements, floating arrows/draws)
- [ ] End-to-end verification: full flow test (user creates canvas content -> chat with agent -> agent modifies canvas -> user sees real-time changes)
