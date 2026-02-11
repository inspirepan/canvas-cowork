import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CanvasFS } from "../canvas-fs.js";

describe("CanvasFS scanDirectory metadata", () => {
  it("includes size and mtime for files", () => {
    const root = mkdtempSync(join(tmpdir(), "canvas-fs-"));
    const fs = new CanvasFS(root);
    fs.ensureDir();

    const content = "hello";
    writeFileSync(join(root, "canvas", "note.txt"), content, "utf-8");

    const entries = fs.scanDirectory();
    const entry = entries.find((e) => e.path === "note.txt");

    expect(entry).toBeDefined();
    expect(entry?.size).toBe(Buffer.byteLength(content));
    expect(typeof entry?.mtimeMs).toBe("number");
  });
});
