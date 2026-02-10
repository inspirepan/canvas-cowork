import { describe, expect, it } from "bun:test";
import {
  buildCacheBustedSrc,
  detectMovesEnhanced,
  ensureUniquePath,
} from "../canvas-sync-utils.js";

describe("ensureUniquePath", () => {
  it("returns same path when available", () => {
    const existing = new Set<string>(["note.txt"]);
    expect(ensureUniquePath("brief.txt", existing)).toBe("brief.txt");
  });

  it("adds numeric suffix when path exists", () => {
    const existing = new Set<string>(["brief.txt", "brief-1.txt"]);
    expect(ensureUniquePath("brief.txt", existing)).toBe("brief-2.txt");
  });

  it("preserves directory while deduping", () => {
    const existing = new Set<string>(["folder/note.txt"]);
    expect(ensureUniquePath("folder/note.txt", existing)).toBe("folder/note-1.txt");
  });
});

describe("detectMovesEnhanced", () => {
  it("matches same filename across directories", () => {
    const deletes = [
      { action: "deleted", path: "a/note.txt", isDirectory: false, timestamp: 1 },
    ];
    const creates = [
      { action: "created", path: "b/note.txt", isDirectory: false, timestamp: 2 },
    ];
    const moves = detectMovesEnhanced(deletes, creates, new Map());
    expect(moves).toHaveLength(1);
    expect(moves[0]?.deleteEvent.path).toBe("a/note.txt");
    expect(moves[0]?.createEvent.path).toBe("b/note.txt");
  });

  it("matches by size and mtime when name changes", () => {
    const deletes = [
      { action: "deleted", path: "old.txt", isDirectory: false, timestamp: 1 },
    ];
    const creates = [
      {
        action: "created",
        path: "new.txt",
        isDirectory: false,
        timestamp: 2,
        size: 5,
        mtimeMs: 1000,
      },
    ];
    const meta = new Map([["old.txt", { size: 5, mtimeMs: 1000 }]]);
    const moves = detectMovesEnhanced(deletes, creates, meta);
    expect(moves).toHaveLength(1);
    expect(moves[0]?.createEvent.path).toBe("new.txt");
  });

  it("does not match when metadata differs", () => {
    const deletes = [
      { action: "deleted", path: "old.txt", isDirectory: false, timestamp: 1 },
    ];
    const creates = [
      {
        action: "created",
        path: "new.txt",
        isDirectory: false,
        timestamp: 2,
        size: 7,
        mtimeMs: 1000,
      },
    ];
    const meta = new Map([["old.txt", { size: 5, mtimeMs: 1000 }]]);
    const moves = detectMovesEnhanced(deletes, creates, meta);
    expect(moves).toHaveLength(0);
  });
});

describe("buildCacheBustedSrc", () => {
  it("uses mtimeMs when provided", () => {
    expect(buildCacheBustedSrc("img.png", 1234)).toBe("/canvas/img.png?v=1234");
  });

  it("adds version query when mtimeMs missing", () => {
    const src = buildCacheBustedSrc("img.png");
    expect(src.startsWith("/canvas/img.png?v=")).toBe(true);
  });
});