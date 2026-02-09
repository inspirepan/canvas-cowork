import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ClientMessage, ServerMessage, StreamDelta } from "../shared/protocol.js";
import { AgentManager } from "./agent-manager.js";
import { CanvasFS } from "./canvas-fs.js";
import type { ScreenshotCallback } from "./canvas-tools.js";

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const cwd = process.env.CWD || process.cwd();

type WS = Bun.ServerWebSocket<undefined>;

// Track connected WebSocket clients
const clients = new Set<WS>();

function broadcast(msg: ServerMessage) {
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === 1) {
      ws.send(data);
    }
  }
}

function send(ws: WS, msg: ServerMessage) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(msg));
  }
}

// Initialize CanvasFS: auto-create canvas/ and start file watcher
const canvasFS = new CanvasFS(cwd);
canvasFS.start((event) => {
  broadcast({ type: "canvas_fs_change", changes: [event] });
});

// Screenshot request/response infrastructure
const pendingScreenshots = new Map<
  string,
  { resolve: (v: { data: string; mimeType: string } | null) => void; timer: Timer }
>();

const screenshotCallback: ScreenshotCallback = (signal) => {
  return new Promise((resolve) => {
    if (clients.size === 0) {
      resolve(null);
      return;
    }

    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      pendingScreenshots.delete(requestId);
      resolve(null);
    }, 10000);

    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        pendingScreenshots.delete(requestId);
        resolve(null);
      });
    }

    pendingScreenshots.set(requestId, { resolve, timer });
    broadcast({ type: "screenshot_request", requestId });
  });
};

const manager = new AgentManager(
  cwd,
  (sessionId: string, delta: StreamDelta) => {
    broadcast({ type: "stream_delta", sessionId, delta });
  },
  (sessionId: string, isStreaming: boolean, title?: string) => {
    broadcast({ type: "session_updated", sessionId, isStreaming, title });
  },
  canvasFS,
  screenshotCallback,
);

async function handleMessage(ws: WS, raw: string) {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw);
  } catch {
    send(ws, { type: "error", message: "Invalid JSON" });
    return;
  }

  try {
    switch (msg.type) {
      case "create_session": {
        const result = await manager.createSession();
        send(ws, {
          type: "session_created",
          session: result.info,
          model: result.model,
          thinkingLevel: result.thinkingLevel,
          availableThinkingLevels: result.availableThinkingLevels,
        });
        break;
      }

      case "load_session": {
        const sessions = await manager.listSessions();
        const target = sessions.find((s) => s.id === msg.sessionId);
        if (!target) {
          send(ws, {
            type: "error",
            sessionId: msg.sessionId,
            message: "Session not found",
          });
          break;
        }
        // Use the pi SessionInfo from listing
        const piSessions = await (
          await import("@mariozechner/pi-coding-agent")
        ).SessionManager.list(cwd);
        const piSession = piSessions.find((s) => s.id === msg.sessionId);
        if (!piSession) {
          send(ws, {
            type: "error",
            sessionId: msg.sessionId,
            message: "Session file not found",
          });
          break;
        }
        const result = await manager.loadSession(piSession);
        send(ws, {
          type: "session_loaded",
          session: result.info,
          messages: result.messages,
          model: result.model,
          thinkingLevel: result.thinkingLevel,
          availableThinkingLevels: result.availableThinkingLevels,
        });
        break;
      }

      case "unload_session": {
        await manager.unloadSession(msg.sessionId);
        send(ws, { type: "session_unloaded", sessionId: msg.sessionId });
        break;
      }

      case "delete_session": {
        await manager.deleteSession(msg.sessionId);
        send(ws, { type: "session_deleted", sessionId: msg.sessionId });
        break;
      }

      case "list_sessions": {
        const sessions = await manager.listSessions();
        send(ws, { type: "sessions_list", sessions });
        break;
      }

      case "prompt": {
        // Fire and forget - events come through stream_delta
        manager.prompt(msg.sessionId, msg.text, msg.attachments).catch((err) => {
          send(ws, {
            type: "error",
            sessionId: msg.sessionId,
            message: err.message,
          });
        });
        break;
      }

      case "abort": {
        await manager.abort(msg.sessionId);
        break;
      }

      case "set_model": {
        const result = await manager.setModel(msg.sessionId, msg.provider, msg.modelId);
        send(ws, {
          type: "model_changed",
          sessionId: msg.sessionId,
          ...result,
        });
        break;
      }

      case "set_thinking_level": {
        manager.setThinkingLevel(msg.sessionId, msg.level);
        send(ws, {
          type: "thinking_level_changed",
          sessionId: msg.sessionId,
          thinkingLevel: msg.level,
        });
        break;
      }

      case "get_models": {
        const models = manager.getAvailableModels();
        send(ws, { type: "models_list", models });
        break;
      }

      case "canvas_init": {
        const snapshot = canvasFS.readCanvasJson();
        const files = canvasFS.scanDirectory();
        send(ws, {
          type: "canvas_state",
          snapshot: snapshot?.tldraw ?? null,
          shapeToFile: snapshot?.shapeToFile ?? {},
          files,
        });
        break;
      }

      case "canvas_sync": {
        for (const change of msg.changes) {
          switch (change.action) {
            case "create":
              if (change.shapeType === "frame") {
                canvasFS.createDirectory(change.path);
              } else if (change.shapeType === "named_text") {
                canvasFS.writeTextFile(change.path, change.content ?? "");
              }
              break;
            case "update":
              if (change.shapeType === "named_text") {
                canvasFS.writeTextFile(change.path, change.content ?? "");
              }
              break;
            case "delete":
              canvasFS.deleteFile(change.path);
              break;
            case "move":
            case "rename":
              if (change.oldPath) {
                canvasFS.renameFile(change.oldPath, change.path);
              }
              break;
          }
        }
        break;
      }

      case "canvas_save": {
        canvasFS.writeCanvasJson({
          version: 1,
          tldraw: msg.snapshot,
          shapeToFile: msg.shapeToFile,
        });
        break;
      }

      case "screenshot_response": {
        const pending = pendingScreenshots.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingScreenshots.delete(msg.requestId);
          pending.resolve({ data: msg.data, mimeType: msg.mimeType });
        }
        break;
      }

      case "screenshot_error": {
        const pending = pendingScreenshots.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingScreenshots.delete(msg.requestId);
          pending.resolve(null);
        }
        break;
      }
    }
  } catch (err: unknown) {
    send(ws, {
      type: "error",
      sessionId: "sessionId" in msg ? (msg as { sessionId?: string }).sessionId : undefined,
      message: err instanceof Error ? err.message : "Unknown error",
    });
  }
}

// Serve static files from dist/ in production
const distDir = resolve(import.meta.dir, "../../dist");

const server = Bun.serve({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade
    if (url.pathname === "/ws") {
      const success = server.upgrade(req);
      if (success) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Serve canvas/ files at /canvas/*
    if (url.pathname.startsWith("/canvas/")) {
      // POST /canvas/upload - image upload from tldraw
      if (url.pathname === "/canvas/upload" && req.method === "POST") {
        try {
          const formData = await req.formData();
          const file = formData.get("file") as File | null;
          const fileName = formData.get("fileName") as string | null;
          if (!(file && fileName)) {
            return new Response("Missing file or fileName", { status: 400 });
          }
          const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
          // Deduplicate: image-0209-143022.png -> image-0209-143022-1.png, -2, ...
          const dotIdx = safeName.lastIndexOf(".");
          const base = dotIdx > 0 ? safeName.slice(0, dotIdx) : safeName;
          const ext = dotIdx > 0 ? safeName.slice(dotIdx) : "";
          let finalName = `${base}-1${ext}`;
          let seq = 1;
          while (existsSync(join(canvasFS.canvasDir, finalName))) {
            seq++;
            finalName = `${base}-${seq}${ext}`;
          }
          const buffer = await file.arrayBuffer();
          canvasFS.writeBinaryFile(finalName, Buffer.from(buffer));
          return Response.json({ src: `/canvas/${finalName}` });
        } catch (_err) {
          return new Response("Upload failed", { status: 500 });
        }
      }

      // GET /canvas/* - serve canvas files
      const relPath = decodeURIComponent(url.pathname.slice("/canvas/".length));
      if (relPath.includes("..")) {
        return new Response("Forbidden", { status: 403 });
      }
      const canvasFilePath = join(canvasFS.canvasDir, relPath);
      if (existsSync(canvasFilePath)) {
        const file = Bun.file(canvasFilePath);
        return new Response(file);
      }
      return new Response("Not found", { status: 404 });
    }

    // Serve static files
    let filePath = join(distDir, url.pathname);
    if (url.pathname === "/" || !existsSync(filePath)) {
      filePath = join(distDir, "index.html");
    }

    if (existsSync(filePath)) {
      const file = Bun.file(filePath);
      return new Response(file);
    }

    return new Response("Not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      clients.add(ws);
    },
    message(ws, message) {
      const raw = typeof message === "string" ? message : message.toString();
      handleMessage(ws, raw);
    },
    close(ws) {
      clients.delete(ws);
    },
  },
});

// Graceful shutdown
process.on("SIGINT", async () => {
  canvasFS.stop();
  await manager.dispose();
  server.stop();
  process.exit(0);
});
