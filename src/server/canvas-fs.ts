import type { FSWatcher } from "node:fs";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join } from "node:path";
import type { CanvasFileEntry, CanvasFSEvent, CanvasShapeType } from "../shared/protocol.js";

// Mapping rule: file extension -> shape type
const EXT_TO_SHAPE: Record<string, CanvasShapeType> = {
  ".txt": "named_text",
  ".md": "named_text",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".webp": "image",
  ".gif": "image",
  ".svg": "image",
};

export function fileToShapeType(filePath: string): CanvasShapeType | null {
  const ext = extname(filePath).toLowerCase();
  return EXT_TO_SHAPE[ext] ?? null;
}

export function isCanvasFile(filePath: string): boolean {
  return fileToShapeType(filePath) !== null;
}

// .canvas.json schema
export interface CanvasJsonData {
  version: 1;
  tldraw: Record<string, unknown>;
  shapeToFile: Record<string, string>; // shape ID -> relative file path
}

const CANVAS_JSON = ".canvas.json";
const DEBOUNCE_MS = 300;

export class CanvasFS {
  readonly canvasDir: string;
  private watcher: FSWatcher | null = null;
  private debounceTimers = new Map<string, Timer>();
  private listener: ((event: CanvasFSEvent) => void) | null = null;
  // Paths written by canvas_sync that the watcher should ignore
  private ignorePaths = new Set<string>();
  private ignoreTimers = new Map<string, Timer>();

  constructor(cwd: string) {
    this.canvasDir = join(cwd, "canvas");
  }

  // Ensure canvas/ directory exists
  ensureDir(): void {
    if (!existsSync(this.canvasDir)) {
      mkdirSync(this.canvasDir, { recursive: true });
    }
  }

  // Start watching canvas/ for file changes
  start(listener: (event: CanvasFSEvent) => void): void {
    this.ensureDir();
    this.listener = listener;

    this.watcher = watch(this.canvasDir, { recursive: true }, (eventType, filename) => {
      if (!filename) return;

      // Normalize path separators
      const relPath = filename.replace(/\\/g, "/");

      // Ignore .canvas.json changes (self-triggered)
      if (relPath === CANVAS_JSON || relPath.endsWith(`/${CANVAS_JSON}`)) return;

      // Ignore hidden files/directories (starting with .)
      const parts = relPath.split("/");
      if (parts.some((p) => p.startsWith(".") && p !== CANVAS_JSON)) return;

      this.debounce(relPath, () => {
        // Skip if this path was written by canvas_sync (loop prevention)
        if (this.ignorePaths.has(relPath)) {
          this.ignorePaths.delete(relPath);
          return;
        }

        const absPath = join(this.canvasDir, relPath);
        const exists = existsSync(absPath);

        let isDirectory = false;
        let stat: ReturnType<typeof statSync> | null = null;
        if (exists) {
          try {
            stat = statSync(absPath);
            isDirectory = stat.isDirectory();
          } catch {
            // File may have been deleted between check and stat
            return;
          }
        }

        const action: CanvasFSEvent["action"] = exists
          ? eventType === "rename"
            ? "created"
            : "modified"
          : "deleted";

        // For deleted entries, infer directory from path (no trailing extension = likely dir)
        const event: CanvasFSEvent = {
          action,
          path: relPath,
          isDirectory: exists ? isDirectory : !extname(relPath),
          timestamp: Date.now(),
        };

        if (exists && !isDirectory && stat) {
          event.size = stat.size;
          event.mtimeMs = stat.mtimeMs;
        }

        // Include text content for created/modified text files
        if (exists && !isDirectory && (action === "created" || action === "modified")) {
          const shapeType = fileToShapeType(relPath);
          if (shapeType === "named_text") {
            try {
              event.content = readFileSync(absPath, "utf-8");
            } catch {
              // ignore read errors
            }
          }
        }

        this.listener?.(event);
      });
    });
  }

  // Stop watching
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.listener = null;
  }

  // Debounce rapid changes to the same path
  private debounce(path: string, fn: () => void): void {
    const existing = this.debounceTimers.get(path);
    if (existing) clearTimeout(existing);
    this.debounceTimers.set(
      path,
      setTimeout(() => {
        this.debounceTimers.delete(path);
        fn();
      }, DEBOUNCE_MS),
    );
  }

  // -- .canvas.json read/write --

  readCanvasJson(): CanvasJsonData | null {
    const filePath = join(this.canvasDir, CANVAS_JSON);
    if (!existsSync(filePath)) return null;
    try {
      const raw = readFileSync(filePath, "utf-8");
      return JSON.parse(raw) as CanvasJsonData;
    } catch (_err) {
      return null;
    }
  }

  writeCanvasJson(data: CanvasJsonData): void {
    const filePath = join(this.canvasDir, CANVAS_JSON);
    try {
      writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch {
      // Ignore write errors (e.g. disk full)
    }
  }

  // -- File manipulation (called from canvas_sync handler, marks paths to ignore) --

  private markIgnore(relPath: string): void {
    this.ignorePaths.add(relPath);
    // Auto-clear after 2s in case watcher never fires (e.g. no-op write)
    const existing = this.ignoreTimers.get(relPath);
    if (existing) clearTimeout(existing);
    this.ignoreTimers.set(
      relPath,
      setTimeout(() => {
        this.ignorePaths.delete(relPath);
        this.ignoreTimers.delete(relPath);
      }, 2000),
    );
  }

  writeTextFile(relPath: string, content: string): void {
    this.markIgnore(relPath);
    const absPath = join(this.canvasDir, relPath);
    const dir = dirname(absPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(absPath, content, "utf-8");
  }

  writeBinaryFile(relPath: string, data: Buffer): void {
    this.markIgnore(relPath);
    const absPath = join(this.canvasDir, relPath);
    const dir = dirname(absPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(absPath, data);
  }

  readTextFile(relPath: string): string | null {
    const absPath = join(this.canvasDir, relPath);
    if (!existsSync(absPath)) return null;
    try {
      return readFileSync(absPath, "utf-8");
    } catch {
      return null;
    }
  }

  deleteFile(relPath: string): void {
    this.markIgnore(relPath);
    const absPath = join(this.canvasDir, relPath);
    if (!existsSync(absPath)) return;
    try {
      const stat = statSync(absPath);
      if (stat.isDirectory()) {
        rmSync(absPath, { recursive: true });
      } else {
        unlinkSync(absPath);
      }
    } catch {
      // ignore
    }
  }

  createDirectory(relPath: string): void {
    this.markIgnore(relPath);
    const absPath = join(this.canvasDir, relPath);
    if (!existsSync(absPath)) {
      mkdirSync(absPath, { recursive: true });
    }
  }

  renameFile(oldRelPath: string, newRelPath: string): void {
    this.markIgnore(oldRelPath);
    this.markIgnore(newRelPath);
    const oldAbs = join(this.canvasDir, oldRelPath);
    const newAbs = join(this.canvasDir, newRelPath);
    if (!existsSync(oldAbs)) return;
    const dir = dirname(newAbs);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    renameSync(oldAbs, newAbs);
  }

  moveFile(oldRelPath: string, newRelPath: string): void {
    this.renameFile(oldRelPath, newRelPath);
  }

  // -- Directory scanning --

  scanDirectory(): CanvasFileEntry[] {
    const entries: CanvasFileEntry[] = [];
    this.scanRecursive(this.canvasDir, "", entries);
    return entries;
  }

  private scanRecursive(absDir: string, relDir: string, entries: CanvasFileEntry[]): void {
    let items: string[];
    try {
      items = readdirSync(absDir);
    } catch {
      return;
    }

    for (const item of items) {
      if (item.startsWith(".")) continue;
      const absPath = join(absDir, item);
      const relPath = relDir ? `${relDir}/${item}` : item;

      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(absPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        entries.push({ path: relPath, type: "directory" });
        this.scanRecursive(absPath, relPath, entries);
      } else {
        const shapeType = fileToShapeType(relPath);
        if (shapeType) {
          const entry: CanvasFileEntry = {
            path: relPath,
            type: shapeType,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
          };
          if (shapeType === "named_text") {
            try {
              entry.content = readFileSync(absPath, "utf-8");
            } catch {
              // ignore
            }
          }
          entries.push(entry);
        }
      }
    }
  }
}
