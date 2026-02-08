import { AgentManager } from "./agent-manager.js";
import type {
  ClientMessage,
  ServerMessage,
  StreamDelta,
} from "../shared/protocol.js";
import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";

const PORT = parseInt(process.env.PORT || "3000", 10);
const cwd = process.env.CWD || process.cwd();

// Track connected WebSocket clients
const clients = new Set<any>();

function broadcast(msg: ServerMessage) {
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === 1) {
      ws.send(data);
    }
  }
}

function send(ws: any, msg: ServerMessage) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(msg));
  }
}

const manager = new AgentManager(
  cwd,
  (sessionId: string, delta: StreamDelta) => {
    broadcast({ type: "stream_delta", sessionId, delta });
  },
  (sessionId: string, isStreaming: boolean, title?: string) => {
    broadcast({ type: "session_updated", sessionId, isStreaming, title });
  },
);

async function handleMessage(ws: any, raw: string) {
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
        const piSessions = await (await import("@mariozechner/pi-coding-agent")).SessionManager.list(cwd);
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
        const result = await manager.setModel(
          msg.sessionId,
          msg.provider,
          msg.modelId,
        );
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
    }
  } catch (err: any) {
    send(ws, {
      type: "error",
      sessionId: "sessionId" in msg ? (msg as any).sessionId : undefined,
      message: err.message || "Unknown error",
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
      console.log(`[ws] client connected (${clients.size} total)`);
    },
    message(ws, message) {
      const raw = typeof message === "string" ? message : message.toString();
      handleMessage(ws, raw);
    },
    close(ws) {
      clients.delete(ws);
      console.log(`[ws] client disconnected (${clients.size} total)`);
    },
  },
});

console.log(`[canvas-cowork] server running at http://localhost:${PORT}`);
console.log(`[canvas-cowork] cwd: ${cwd}`);
console.log(`[canvas-cowork] WebSocket: ws://localhost:${PORT}/ws`);

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n[canvas-cowork] shutting down...");
  await manager.dispose();
  server.stop();
  process.exit(0);
});
