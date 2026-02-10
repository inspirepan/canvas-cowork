import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { compressImage } from "./agent-manager.js";
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

  tools.push(createGenerateImageTool(canvasFS.canvasDir));

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
      const compressed = await compressImage(result.data, result.mimeType);
      return {
        content: [{ type: "image", data: compressed.data, mimeType: compressed.mimeType }],
        details: {},
      };
    },
  };
}

// -- generate_image tool --

const GENERATE_IMAGE_SCRIPT = join(import.meta.dir, "../../scripts/generate_image.py");

function createGenerateImageTool(canvasDir: string): ToolDefinition {
  return {
    name: "generate_image",
    label: "Generate Image",
    description: `Generate or edit images using AI (Gemini image generation).
- For pure generation: provide a text prompt describing the desired image.
- For editing/composition: provide reference images along with a prompt describing the desired changes.
- Generated images are saved to the canvas/ directory and appear on the user's canvas.
- Supports up to 14 input images for multi-image composition.

Prompt input: supports both inline "prompt" and "prompt_file" (path to a .txt file).
- Prompts longer than 200 characters are automatically saved as a companion txt file (e.g. "sunset-prompt.txt" for "sunset.png").
- When retrying or iterating, prefer passing the saved prompt_file path instead of re-typing the full prompt. You can edit the file first with the Edit tool, then pass it as prompt_file.

When using multiple reference images:
- Be explicit about which image controls LAYOUT (spatial arrangement, camera angle, composition) vs STYLE (lighting, color, atmosphere) vs CONTENT (objects, elements to include).
- Assign each image a distinct role: edit_target for preserving layout/structure, style_reference for visual style only, content_reference for objects/elements.
- In the prompt, list specific spatial features to preserve (e.g. "water at bottom, buildings at top") rather than abstract instructions like "keep the same layout".`,
    parameters: Type.Object({
      name: Type.String({
        description:
          "Output image path relative to canvas/. Can include a subdirectory for organization (e.g. 'sunset-scene/v2-warm.png' or '日落场景/v2-暖色.png'). Parent directories are created automatically. Always use the same language as the user for naming.",
      }),
      prompt: Type.Optional(
        Type.String({
          description:
            "Image generation/editing prompt. For multi-image inputs, reference images by index and describe how they interact (e.g. \"apply Image 2's style to Image 1\", \"put the bird from Image 1 on the elephant in Image 2\"). Either prompt or prompt_file must be provided.",
        }),
      ),
      prompt_file: Type.Optional(
        Type.String({
          description:
            "Path to a .txt file containing the generation prompt. Long prompts (>200 chars) are auto-saved as companion files (e.g. canvas/sunset-prompt.txt). For retries or iterations, pass the saved file path here instead of re-typing the prompt. Edit the file first if you need to modify it. Takes precedence over prompt.",
        }),
      ),
      reference_images: Type.Optional(
        Type.Array(
          Type.Object({
            file_path: Type.String({ description: "Path to the image file" }),
            role: Type.Union(
              [
                Type.Literal("edit_target"),
                Type.Literal("style_reference"),
                Type.Literal("content_reference"),
              ],
              {
                description:
                  "'edit_target': the base image whose spatial layout, composition, and structure should be preserved in the output; " +
                  "'style_reference': use for visual style, lighting, color grading, atmosphere only - do NOT replicate its layout; " +
                  "'content_reference': use for content, objects, or scene elements to incorporate",
              },
            ),
            description: Type.String({
              description:
                "Describe what this image contributes to the output. " +
                "Specify clearly: does it provide layout/composition, or style/atmosphere, or specific content elements? " +
                "Example: 'provides the building layout and camera angle - preserve exact spatial arrangement' " +
                "or 'provides lighting mood and color palette only - do not copy its composition'",
            }),
          }),
          { description: "Reference/input images with their roles and usage descriptions" },
        ),
      ),
      resolution: Type.Optional(
        Type.Union([Type.Literal("1K"), Type.Literal("2K"), Type.Literal("4K")], {
          description: "Output resolution: 1K (default), 2K, or 4K",
        }),
      ),
    }),
    async execute(
      _toolCallId,
      params: {
        name: string;
        prompt?: string;
        prompt_file?: string;
        reference_images?: Array<{
          file_path: string;
          role: "edit_target" | "style_reference" | "content_reference";
          description: string;
        }>;
        resolution?: "1K" | "2K" | "4K";
      },
    ) {
      // Build prompt from file or inline
      let prompt = params.prompt ?? "";
      if (params.prompt_file) {
        const promptFilePath = isAbsolute(params.prompt_file)
          ? params.prompt_file
          : resolve(params.prompt_file);
        if (!existsSync(promptFilePath)) {
          return {
            content: [{ type: "text" as const, text: `Prompt file not found: ${promptFilePath}` }],
            details: {},
          };
        }
        prompt = readFileSync(promptFilePath, "utf-8").trim();
      }

      if (!prompt) {
        return {
          content: [
            { type: "text" as const, text: "Either prompt or prompt_file must be provided." },
          ],
          details: {},
        };
      }

      // Augment prompt with reference image descriptions
      if (params.reference_images?.length) {
        const descriptions = params.reference_images.map((img, i) => {
          const roleLabels: Record<string, string> = {
            edit_target: "Edit target (preserve layout/structure)",
            style_reference: "Style reference (lighting/color/atmosphere only)",
            content_reference: "Content reference (objects/elements to include)",
          };
          const roleLabel = roleLabels[img.role] ?? img.role;
          return `[Image ${i + 1} - ${roleLabel}]: ${img.description}`;
        });
        prompt = `${descriptions.join("\n")}\n\n${prompt}`;
      }

      // Build output path (supports subdirectory paths like "folder/image.png")
      let filename = params.name;
      if (!/\.\w+$/.test(filename)) filename += ".png";
      const outputPath = join(canvasDir, filename);
      const outputDir = dirname(outputPath);
      if (!existsSync(outputDir)) {
        mkdirSync(outputDir, { recursive: true });
      }

      // Save prompt file before calling the model for traceability
      const PROMPT_FILE_THRESHOLD = 200;
      let savedPromptFilePath: string | null = null;
      if (prompt.length > PROMPT_FILE_THRESHOLD && !params.prompt_file) {
        savedPromptFilePath = savePromptFile(canvasDir, prompt, filename);
      }

      // Build command args
      const args = ["run", "--quiet", GENERATE_IMAGE_SCRIPT, "--prompt", prompt, "--filename", outputPath];

      if (params.resolution) {
        args.push("--resolution", params.resolution);
      }

      if (params.reference_images) {
        for (const img of params.reference_images) {
          const imgPath = isAbsolute(img.file_path) ? img.file_path : resolve(img.file_path);
          args.push("--input-image", imgPath);
        }
      }

      // Execute the Python script
      const proc = Bun.spawn(["uv", ...args], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: resolve("."),
      });

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Image generation failed (exit code ${exitCode}):\n${stderr}\n${stdout}`,
            },
          ],
          details: {},
        };
      }

      // Read generated image and return as base64
      if (!existsSync(outputPath)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Image generation completed but output file not found at ${outputPath}\n${stdout}`,
            },
          ],
          details: {},
        };
      }

      const imageBuffer = readFileSync(outputPath);
      const rawBase64 = imageBuffer.toString("base64");
      const compressed = await compressImage(rawBase64, "image/png");

      const resultContent: { type: "text"; text: string }[] = [
        { type: "text" as const, text: `Image saved to canvas/${filename}` },
      ];

      if (savedPromptFilePath) {
        resultContent.push({
          type: "text" as const,
          text: `<system>The image generation prompt has been saved to ${savedPromptFilePath}. For regeneration or iteration, pass this path as prompt_file to avoid re-typing the full prompt. To modify the prompt, use the Edit tool on the file then pass it as prompt_file. If the user wants to iteratively edit the generated image, use the image as a reference_image with role "edit_target" (to preserve its layout/structure) along with the editing instruction.</system>`,
        });
      } else if (params.prompt_file) {
        resultContent.push({
          type: "text" as const,
          text: `<system>This image was generated using prompt file ${params.prompt_file}. For regeneration, pass the same prompt_file. To modify, edit the file then regenerate.</system>`,
        });
      }

      return {
        content: [
          ...resultContent,
          { type: "image" as const, data: compressed.data, mimeType: compressed.mimeType },
        ],
        details: { path: `canvas/${filename}` },
      };
    },
  };
}

// -- Prompt file persistence --

function savePromptFile(canvasDir: string, content: string, associatedFile?: string): string | null {
  try {
    let filename: string;
    if (associatedFile) {
      // Associate prompt file with the generated image: "folder/sunset.png" -> "folder/sunset-prompt.txt"
      const base = associatedFile.replace(/\.\w+$/, "");
      filename = `${base}-prompt.txt`;
    } else {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      filename = `prompt-${timestamp}.txt`;
    }
    const filePath = join(canvasDir, filename);
    const fileDir = dirname(filePath);
    if (!existsSync(fileDir)) {
      mkdirSync(fileDir, { recursive: true });
    }
    writeFileSync(filePath, content, "utf-8");
    return `canvas/${filename}`;
  } catch {
    return null;
  }
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
