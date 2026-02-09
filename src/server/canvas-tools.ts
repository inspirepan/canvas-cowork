import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CanvasFS, CanvasJsonData } from "./canvas-fs.js";

// -- System prompt for Canvas FS awareness (loaded from markdown file) --

export const CANVAS_FS_SYSTEM_PROMPT = readFileSync(
  join(import.meta.dir, "canvas-system-prompt.md"),
  "utf-8",
);

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

  // Check for draw shapes overlapping images using bounding box intersection.
  // A draw shape whose bounds overlap an image's bounds is considered an annotation.
  const imageShapes: { id: string; x: number; y: number; w: number; h: number }[] = [];
  for (const [id, record] of shapeRecords) {
    if (record.type !== "image") continue;
    const props = record.props as Record<string, unknown> | undefined;
    if (props && typeof record.x === "number" && typeof record.y === "number") {
      const w = (props.w as number) ?? 0;
      const h = (props.h as number) ?? 0;
      if (w > 0 && h > 0) {
        imageShapes.push({ id, x: record.x as number, y: record.y as number, w, h });
      }
    }
  }

  for (const [_id, record] of shapeRecords) {
    if (record.type !== "draw") continue;
    const drawX = (record.x as number) ?? 0;
    const drawY = (record.y as number) ?? 0;
    // Draw shapes store segments; estimate bounds from the shape record
    const drawProps = record.props as Record<string, unknown> | undefined;
    // tldraw draw shapes have segments with points; use a rough bounding approach
    // Check against images in the same parent
    const parentId = record.parentId as string;

    for (const img of imageShapes) {
      const imgRecord = shapeRecords.get(img.id);
      if (!imgRecord) continue;
      // Must share the same parent (page or frame)
      if ((imgRecord.parentId as string) !== parentId) continue;

      // Bounding box overlap check
      // Draw shapes don't have explicit w/h in props, but we can check
      // if the draw's origin is within or near the image bounds
      const segments =
        (drawProps?.segments as Array<{ points: Array<{ x: number; y: number }> }>) ?? [];
      let drawMinX = drawX;
      let drawMinY = drawY;
      let drawMaxX = drawX;
      let drawMaxY = drawY;
      for (const seg of segments) {
        for (const pt of seg.points ?? []) {
          drawMinX = Math.min(drawMinX, drawX + pt.x);
          drawMinY = Math.min(drawMinY, drawY + pt.y);
          drawMaxX = Math.max(drawMaxX, drawX + pt.x);
          drawMaxY = Math.max(drawMaxY, drawY + pt.y);
        }
      }

      // Check overlap
      if (
        drawMinX < img.x + img.w &&
        drawMaxX > img.x &&
        drawMinY < img.y + img.h &&
        drawMaxY > img.y &&
        shapeToFile[img.id]
      ) {
        annotatedImages.add(shapeToFile[img.id]);
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
