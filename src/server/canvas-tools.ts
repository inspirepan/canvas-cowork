import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { CanvasFS, CanvasJsonData } from "./canvas-fs.js";

// -- System prompt for Canvas FS awareness --

export const CANVAS_FS_SYSTEM_PROMPT = `
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

// -- Screenshot request callback type --

export type ScreenshotCallback = (
  signal?: AbortSignal,
) => Promise<{ data: string; mimeType: string } | null>;

// -- Tool factory --

export function createCanvasTools(
  canvasFS: CanvasFS,
  screenshotCallback?: ScreenshotCallback,
): ToolDefinition[] {
  const tools: ToolDefinition[] = [createCanvasSnapshotTool(canvasFS)];

  if (screenshotCallback) {
    tools.push(createCanvasScreenshotTool(screenshotCallback));
  }

  return tools;
}

// -- canvas_snapshot tool --

function createCanvasSnapshotTool(canvasFS: CanvasFS): ToolDefinition {
  return {
    name: "canvas_snapshot",
    label: "Canvas Snapshot",
    description:
      "Get a semantic snapshot of the current canvas state as a directory tree with connection (arrow) relationships. Use this to understand what elements exist on the canvas and how they are connected.",
    parameters: Type.Object({
      include_coords: Type.Optional(
        Type.Boolean({
          description: "Include shape coordinates in output. Default: false.",
        }),
      ),
      include_content: Type.Optional(
        Type.Boolean({
          description: "Include text file contents inline. Default: false.",
        }),
      ),
    }),
    async execute(_toolCallId, params: { include_coords?: boolean; include_content?: boolean }) {
      const includeCoords = params.include_coords ?? false;
      const includeContent = params.include_content ?? false;

      const files = canvasFS.scanDirectory();
      const canvasJson = canvasFS.readCanvasJson();

      // Parse arrow connections and annotated images from tldraw snapshot
      const { arrows, annotatedImages, shapeCoords } = canvasJson
        ? parseCanvasState(canvasJson, canvasFS.canvasDir)
        : { arrows: [], annotatedImages: new Set<string>(), shapeCoords: new Map() };

      // Build directory tree
      const tree = buildDirectoryTree(
        files,
        annotatedImages,
        includeContent,
        includeCoords ? shapeCoords : null,
        canvasFS.canvasDir,
      );

      // Build arrows section
      const arrowsSection =
        arrows.length > 0
          ? `\nArrows:\n${arrows.map((a) => `  ${a.from} -> ${a.to}`).join("\n")}`
          : "";

      const output = `${tree}${arrowsSection}`;

      return {
        content: [{ type: "text", text: output }],
        details: {},
      };
    },
  };
}

// -- canvas_screenshot tool --

function createCanvasScreenshotTool(screenshotCallback: ScreenshotCallback): ToolDefinition {
  return {
    name: "canvas_screenshot",
    label: "Canvas Screenshot",
    description:
      "Capture a visual screenshot of the entire canvas, including all elements, annotations, and spatial layout.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      const result = await screenshotCallback(signal);
      if (!result) {
        return {
          content: [{ type: "text", text: "Screenshot failed: no connected client." }],
          details: {},
        };
      }
      return {
        content: [{ type: "image", data: result.data, mimeType: result.mimeType }],
        details: {},
      };
    },
  };
}

// -- Internal helpers --

interface ArrowConnection {
  from: string; // file path or shape description
  to: string;
}

interface ParsedCanvasState {
  arrows: ArrowConnection[];
  annotatedImages: Set<string>; // file paths of images with annotations
  shapeCoords: Map<string, { x: number; y: number }>; // file path -> coords
}

function parseCanvasState(canvasJson: CanvasJsonData, _canvasDir: string): ParsedCanvasState {
  const arrows: ArrowConnection[] = [];
  const annotatedImages = new Set<string>();
  const shapeCoords = new Map<string, { x: number; y: number }>();

  const { shapeToFile } = canvasJson;
  const tldraw = canvasJson.tldraw as Record<string, unknown>;
  if (!tldraw) return { arrows, annotatedImages, shapeCoords };

  // Extract shape records and binding records from the tldraw snapshot
  // The snapshot format is: { document: { store: { [id]: record } }, session: ... }
  const document = tldraw.document as Record<string, unknown> | undefined;
  const store = (document?.store ?? tldraw.store ?? {}) as Record<string, Record<string, unknown>>;

  // Build reverse mapping: shape ID -> file path
  const fileToShape = new Map<string, string>();
  for (const [shapeId, path] of Object.entries(shapeToFile)) {
    fileToShape.set(path, shapeId);
  }

  // Collect shape records for coordinate lookup
  const shapeRecords = new Map<string, Record<string, unknown>>();
  for (const [id, record] of Object.entries(store)) {
    if (id.startsWith("shape:") && record.typeName === "shape") {
      shapeRecords.set(id, record);
      // Extract coordinates
      const filePath = shapeToFile[id];
      if (filePath && typeof record.x === "number" && typeof record.y === "number") {
        shapeCoords.set(filePath, {
          x: Math.round(record.x),
          y: Math.round(record.y),
        });
      }
    }
  }

  // Find arrow bindings to determine connections
  const arrowBindings = new Map<string, { start?: string; end?: string }>();
  for (const [id, record] of Object.entries(store)) {
    if (id.startsWith("binding:") && record.typeName === "binding" && record.type === "arrow") {
      const fromId = record.fromId as string; // arrow shape ID
      const toId = record.toId as string; // target shape ID
      const props = record.props as Record<string, unknown> | undefined;
      const terminal = props?.terminal as string | undefined; // 'start' | 'end'

      if (!arrowBindings.has(fromId)) {
        arrowBindings.set(fromId, {});
      }
      const binding = arrowBindings.get(fromId)!;
      if (terminal === "start") {
        binding.start = toId;
      } else if (terminal === "end") {
        binding.end = toId;
      }
    }
  }

  // Build arrow connections
  for (const [_arrowId, binding] of arrowBindings) {
    if (!(binding.start && binding.end)) continue;

    const fromPath = shapeToFile[binding.start];
    const toPath = shapeToFile[binding.end];

    // Only include arrows where both ends attach to mapped shapes
    if (fromPath && toPath) {
      arrows.push({ from: fromPath, to: toPath });
    }

    // Check if either end is an image -> mark as annotated
    const startShape = shapeRecords.get(binding.start);
    const endShape = shapeRecords.get(binding.end);
    if (startShape?.type === "image" && shapeToFile[binding.start]) {
      annotatedImages.add(shapeToFile[binding.start]);
    }
    if (endShape?.type === "image" && shapeToFile[binding.end]) {
      annotatedImages.add(shapeToFile[binding.end]);
    }
  }

  // Also check for draw shapes overlapping images (by parent relationship)
  // Draw shapes that are children of the same parent as an image, or
  // that have their geometry overlapping an image, are considered annotations.
  // For simplicity, we check draw shapes whose parentId matches a frame containing images.
  for (const [_id, record] of shapeRecords) {
    if (record.type === "draw") {
      // Check if any arrow binds from this draw to an image
      // (draw shapes typically don't have bindings, but we check parent proximity)
      const parentId = record.parentId as string;
      // If the draw shape shares a parent with an image, mark those images as annotated
      for (const [imgId, imgRecord] of shapeRecords) {
        if (imgRecord.type !== "image") continue;
        if (imgRecord.parentId === parentId && shapeToFile[imgId]) {
          // Same parent container - could be an annotation
          // This is a heuristic; geometry overlap check would be more precise
          annotatedImages.add(shapeToFile[imgId]);
        }
      }
    }
  }

  return { arrows, annotatedImages, shapeCoords };
}

interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  content?: string;
  annotated?: boolean;
  coords?: { x: number; y: number };
  children: FileNode[];
}

function buildDirectoryTree(
  files: { path: string; type: string; content?: string }[],
  annotatedImages: Set<string>,
  includeContent: boolean,
  shapeCoords: Map<string, { x: number; y: number }> | null,
  _canvasDir: string,
): string {
  // Build tree structure
  const root: FileNode = { name: "/", path: "", isDir: true, children: [] };

  for (const file of files) {
    const parts = file.path.split("/");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const isDir = isLast ? file.type === "directory" : true;

      let child = current.children.find((c) => c.name === part);
      if (!child) {
        child = {
          name: part,
          path: parts.slice(0, i + 1).join("/"),
          isDir,
          children: [],
        };
        current.children.push(child);
      }

      if (isLast && !isDir) {
        child.annotated = annotatedImages.has(file.path);
        if (includeContent && file.content !== undefined) {
          child.content = file.content;
        }
        if (shapeCoords) {
          child.coords = shapeCoords.get(file.path);
        }
      }

      current = child;
    }
  }

  // Sort: directories first, then alphabetically
  function sortNodes(nodes: FileNode[]): void {
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) {
      sortNodes(node.children);
    }
  }
  sortNodes(root.children);

  // Render tree
  const lines: string[] = ["/"];

  function renderNode(node: FileNode, prefix: string, isLast: boolean): void {
    const connector = isLast ? "+-- " : "+-- ";
    let label = node.name;
    if (node.isDir) label += "/";
    if (node.annotated) label += " (annotated)";
    if (node.coords) label += ` [${node.coords.x}, ${node.coords.y}]`;
    lines.push(`${prefix}${connector}${label}`);

    if (node.content !== undefined) {
      const contentPrefix = prefix + (isLast ? "    " : "|   ");
      const contentLines = node.content.split("\n");
      const maxPreview = 5;
      const preview = contentLines.slice(0, maxPreview);
      for (const line of preview) {
        lines.push(`${contentPrefix}  ${line}`);
      }
      if (contentLines.length > maxPreview) {
        lines.push(`${contentPrefix}  ... (${contentLines.length - maxPreview} more lines)`);
      }
    }

    const childPrefix = prefix + (isLast ? "    " : "|   ");
    for (let i = 0; i < node.children.length; i++) {
      renderNode(node.children[i], childPrefix, i === node.children.length - 1);
    }
  }

  for (let i = 0; i < root.children.length; i++) {
    renderNode(root.children[i], "", i === root.children.length - 1);
  }

  return lines.join("\n");
}
