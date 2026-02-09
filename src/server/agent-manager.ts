import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { getModel } from "@mariozechner/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  type SessionInfo as PiSessionInfo,
  SessionManager,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import type {
  Attachment,
  ModelInfo,
  SerializedMessage,
  SessionInfo,
  StreamDelta,
  ThinkingLevel,
} from "../shared/protocol.js";
import type { CanvasFS } from "./canvas-fs.js";
import {
  CANVAS_FS_SYSTEM_PROMPT,
  createCanvasTools,
  type ScreenshotCallback,
} from "./canvas-tools.js";

type EventHandler = (sessionId: string, delta: StreamDelta) => void;
type SessionStateHandler = (sessionId: string, isStreaming: boolean, title?: string) => void;

interface ManagedSession {
  session: AgentSession;
  unsubscribe: () => void;
  title: string;
  createdAt: number;
}

// Threshold for auto-saving long messages/prompts to files
const PROMPT_FILE_THRESHOLD = 200;

const IMAGE_MAX_DIMENSION = 512;
const IMAGE_JPEG_QUALITY = 85;

export async function compressImage(
  base64: string,
  _mimeType: string,
): Promise<{ data: string; mimeType: string }> {
  const buf = Buffer.from(base64, "base64");
  const resized = await sharp(buf)
    .resize(IMAGE_MAX_DIMENSION, IMAGE_MAX_DIMENSION, { fit: "inside" })
    .jpeg({ quality: IMAGE_JPEG_QUALITY })
    .toBuffer();
  return { data: resized.toString("base64"), mimeType: "image/jpeg" };
}

export class AgentManager {
  private sessions = new Map<string, ManagedSession>();
  private cwd: string;
  private canvasDir: string | null;
  private onStreamDelta: EventHandler;
  private onSessionStateChange: SessionStateHandler;
  private modelRegistry: ModelRegistry;
  private canvasTools: ToolDefinition[];

  constructor(
    cwd: string,
    onStreamDelta: EventHandler,
    onSessionStateChange: SessionStateHandler,
    canvasFS?: CanvasFS,
    screenshotCallback?: ScreenshotCallback,
  ) {
    this.cwd = cwd;
    this.canvasDir = canvasFS?.canvasDir ?? null;
    this.onStreamDelta = onStreamDelta;
    this.onSessionStateChange = onSessionStateChange;
    const agentDir = join(homedir(), ".pi", "agent");
    const authStorage = new AuthStorage(join(agentDir, "auth.json"));
    this.modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.json"));
    this.canvasTools = canvasFS ? createCanvasTools(canvasFS, screenshotCallback) : [];
  }

  async createSession(): Promise<{
    info: SessionInfo;
    model: ModelInfo | null;
    thinkingLevel: ThinkingLevel;
    availableThinkingLevels: ThinkingLevel[];
  }> {
    const { session } = await createAgentSession({
      cwd: this.cwd,
      // biome-ignore lint/suspicious/noExplicitAny: pi SDK model ID type is not exported
      model: getModel("openrouter", "anthropic/claude-opus-4.6" as any),
      customTools: this.canvasTools,
    });

    this.injectCanvasSystemPrompt(session);

    const sessionId = session.sessionId;
    const unsub = this.subscribeToSession(sessionId, session);

    const managed: ManagedSession = {
      session,
      unsubscribe: unsub,
      title: "New conversation",
      createdAt: Date.now(),
    };

    this.sessions.set(sessionId, managed);

    return {
      info: this.toSessionInfo(sessionId, managed),
      model: this.getModelInfo(session),
      thinkingLevel: session.thinkingLevel as ThinkingLevel,
      availableThinkingLevels: session.getAvailableThinkingLevels() as ThinkingLevel[],
    };
  }

  async loadSession(piSessionInfo: PiSessionInfo): Promise<{
    info: SessionInfo;
    messages: SerializedMessage[];
    model: ModelInfo | null;
    thinkingLevel: ThinkingLevel;
    availableThinkingLevels: ThinkingLevel[];
  }> {
    // Check if already loaded
    const existing = this.sessions.get(piSessionInfo.id);
    if (existing) {
      return {
        info: this.toSessionInfo(piSessionInfo.id, existing),
        messages: this.serializeMessages(existing.session),
        model: this.getModelInfo(existing.session),
        thinkingLevel: existing.session.thinkingLevel as ThinkingLevel,
        availableThinkingLevels: existing.session.getAvailableThinkingLevels() as ThinkingLevel[],
      };
    }

    const { session } = await createAgentSession({
      cwd: this.cwd,
      sessionManager: SessionManager.open(piSessionInfo.path),
      customTools: this.canvasTools,
    });

    this.injectCanvasSystemPrompt(session);

    const sessionId = session.sessionId;
    const unsub = this.subscribeToSession(sessionId, session);

    const managed: ManagedSession = {
      session,
      unsubscribe: unsub,
      title: piSessionInfo.firstMessage || "Conversation",
      createdAt: piSessionInfo.created.getTime(),
    };

    this.sessions.set(sessionId, managed);

    return {
      info: this.toSessionInfo(sessionId, managed),
      messages: this.serializeMessages(session),
      model: this.getModelInfo(session),
      thinkingLevel: session.thinkingLevel as ThinkingLevel,
      availableThinkingLevels: session.getAvailableThinkingLevels() as ThinkingLevel[],
    };
  }

  async unloadSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId);
    if (!managed) return;

    if (managed.session.isStreaming) {
      await managed.session.abort();
    }
    managed.unsubscribe();
    managed.session.dispose();
    this.sessions.delete(sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    // Unload first if loaded
    await this.unloadSession(sessionId);

    // Find the session file path from listing
    const piSessions = await SessionManager.list(this.cwd);
    const session = piSessions.find((s) => s.id === sessionId);
    if (session) {
      const { unlink } = await import("node:fs/promises");
      await unlink(session.path);
    }
  }

  async listSessions(): Promise<SessionInfo[]> {
    const piSessions = await SessionManager.list(this.cwd);
    return piSessions.map((s) => {
      const loaded = this.sessions.get(s.id);
      return {
        id: s.id,
        path: s.path,
        title: loaded?.title || s.firstMessage || "Empty conversation",
        createdAt: s.created.getTime(),
        modifiedAt: s.modified.getTime(),
        messageCount: s.messageCount,
        isLoaded: !!loaded,
        isStreaming: loaded?.session.isStreaming ?? false,
      };
    });
  }

  async prompt(sessionId: string, text: string, attachments?: Attachment[]): Promise<void> {
    const managed = this.sessions.get(sessionId);
    if (!managed) throw new Error(`Session ${sessionId} not found`);

    // Update title from first user message (strip <system> tags from canvas attachments)
    if (managed.title === "New conversation") {
      managed.title = text.replace(/<system>[\s\S]*?<\/system>/g, "").trim().slice(0, 100);
    }

    // Auto-save long user messages to file for prompt persistence.
    // When attachments are present, the text format is:
    //   "User attached N item(s) from canvas:\n\n<doc ...>...</doc>\n\n---\n{userMessage}"
    // Only save the user's actual message, not the attachment metadata.
    let promptText = text;
    const attachmentSeparator = "\n\n---\n";
    const sepIndex = text.indexOf(attachmentSeparator);
    const rawUserMessage = sepIndex >= 0 ? text.slice(sepIndex + attachmentSeparator.length) : text;
    // Strip <system> tags so they don't get persisted to prompt files
    const userMessage = rawUserMessage.replace(/<system>[\s\S]*?<\/system>/g, "").trim();
    if (this.canvasDir && userMessage.length > PROMPT_FILE_THRESHOLD) {
      const savedPath = this.savePromptFile(userMessage);
      if (savedPath) {
        promptText = `${text}\n\n<system>The user message above has been saved to ${savedPath}. If the user provided an image generation prompt, you can use this file path as the prompt_file parameter for generate_image, or edit it with the Edit tool before passing it. This avoids re-typing the full prompt and prevents information loss during iteration.</system>`;
      }
    }

    // Convert attachments to pi SDK ImageContent, enforcing size limit
    const rawImages = attachments?.filter((a) => a.type === "image") ?? [];
    const images = rawImages.length > 0
      ? await Promise.all(
          rawImages.map(async (a) => {
            const { data, mimeType } = await compressImage(a.data, a.mimeType);
            return { type: "image" as const, data, mimeType };
          }),
        )
      : undefined;

    const opts = {
      ...((images?.length ?? 0) > 0 ? { images } : {}),
      ...(managed.session.isStreaming ? { streamingBehavior: "followUp" as const } : {}),
    };

    await managed.session.prompt(promptText, opts);
  }

  async abort(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId);
    if (!managed) return;
    await managed.session.abort();
  }

  async setModel(
    sessionId: string,
    provider: string,
    modelId: string,
  ): Promise<{
    model: ModelInfo;
    thinkingLevel: ThinkingLevel;
    availableThinkingLevels: ThinkingLevel[];
  }> {
    const managed = this.sessions.get(sessionId);
    if (!managed) throw new Error(`Session ${sessionId} not found`);

    // biome-ignore lint/suspicious/noExplicitAny: pi SDK types not exported
    const newModel = getModel(provider as any, modelId as any);
    await managed.session.setModel(newModel);

    const model = this.getModelInfo(managed.session);
    if (!model) throw new Error("Model not available after setModel");
    return {
      model,
      thinkingLevel: managed.session.thinkingLevel as ThinkingLevel,
      availableThinkingLevels: managed.session.getAvailableThinkingLevels() as ThinkingLevel[],
    };
  }

  setThinkingLevel(sessionId: string, level: ThinkingLevel): void {
    const managed = this.sessions.get(sessionId);
    if (!managed) throw new Error(`Session ${sessionId} not found`);
    managed.session.setThinkingLevel(level);
  }

  getAvailableModels(): ModelInfo[] {
    return this.modelRegistry.getAvailable().map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
    }));
  }

  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId)?.session;
  }

  async dispose(): Promise<void> {
    for (const [id] of this.sessions) {
      await this.unloadSession(id);
    }
  }

  // -- Private --

  private savePromptFile(content: string, prefix = "prompt"): string | null {
    if (!this.canvasDir) return null;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `${prefix}-${timestamp}.txt`;
    const filePath = join(this.canvasDir, filename);
    if (!existsSync(this.canvasDir)) {
      mkdirSync(this.canvasDir, { recursive: true });
    }
    writeFileSync(filePath, content, "utf-8");
    return `canvas/${filename}`;
  }

  private injectCanvasSystemPrompt(session: AgentSession): void {
    if (this.canvasTools.length === 0) return;
    const currentPrompt = session.systemPrompt;
    session.agent.setSystemPrompt(`${currentPrompt}\n${CANVAS_FS_SYSTEM_PROMPT}`);
  }

  private subscribeToSession(sessionId: string, session: AgentSession): () => void {
    return session.subscribe((event: AgentSessionEvent) => {
      const delta = this.eventToDelta(event);
      if (delta) {
        this.onStreamDelta(sessionId, delta);
      }

      if (event.type === "agent_start") {
        const managed = this.sessions.get(sessionId);
        this.onSessionStateChange(sessionId, true, managed?.title);
      } else if (event.type === "agent_end") {
        const managed = this.sessions.get(sessionId);
        this.onSessionStateChange(sessionId, false, managed?.title);
      }
    });
  }

  private eventToDelta(event: AgentSessionEvent): StreamDelta | null {
    switch (event.type) {
      case "agent_start":
        return { type: "agent_start" };
      case "agent_end":
        return { type: "agent_end" };
      case "turn_start":
        return { type: "turn_start" };
      case "turn_end":
        return { type: "turn_end" };

      case "message_start":
        return { type: "message_start", role: event.message.role };

      case "message_end": {
        const msg = event.message;
        if (msg.role === "user" || msg.role === "assistant" || msg.role === "toolResult") {
          return {
            type: "message_end",
            message: this.serializeMessage(msg) as SerializedMessage,
          };
        }
        return null;
      }

      case "message_update": {
        const ame = event.assistantMessageEvent;
        switch (ame.type) {
          case "text_delta":
            return { type: "text_delta", delta: ame.delta };
          case "thinking_delta":
            return { type: "thinking_delta", delta: ame.delta };
          case "toolcall_start":
            return {
              type: "toolcall_start",
              contentIndex: ame.contentIndex,
            };
          case "toolcall_end":
            return {
              type: "toolcall_end",
              toolCallId: ame.toolCall.id,
              toolName: ame.toolCall.name,
              args: ame.toolCall.arguments,
            };
          default:
            return null;
        }
      }

      case "tool_execution_start":
        return {
          type: "tool_exec_start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        };

      case "tool_execution_end": {
        const details =
          event.result &&
          typeof event.result === "object" &&
          "details" in event.result &&
          event.result.details
            ? (event.result.details as Record<string, unknown>)
            : undefined;
        return {
          type: "tool_exec_end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: {
            role: "toolResult",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            content:
              typeof event.result === "string"
                ? [{ type: "text", text: event.result }]
                : Array.isArray(event.result?.content)
                  ? event.result.content
                  : [
                      {
                        type: "text" as const,
                        text: JSON.stringify(event.result),
                      },
                    ],
            isError: event.isError,
            timestamp: Date.now(),
            details,
          },
          isError: event.isError,
        };
      }

      default:
        return null;
    }
  }

  private serializeMessages(session: AgentSession): SerializedMessage[] {
    return session.messages
      .map((msg) => this.serializeMessage(msg))
      .filter((m): m is SerializedMessage => m !== null);
  }

  // biome-ignore lint/suspicious/noExplicitAny: pi SDK message types not exported
  private serializeMessage(msg: any): SerializedMessage | null {
    switch (msg.role) {
      case "user":
        return {
          role: "user",
          content: msg.content,
          timestamp: msg.timestamp,
        };
      case "assistant":
        return {
          role: "assistant",
          content: msg.content,
          model: msg.model || "",
          provider: msg.provider || "",
          stopReason: msg.stopReason,
          errorMessage: msg.errorMessage,
          timestamp: msg.timestamp,
        };
      case "toolResult":
        return {
          role: "toolResult",
          toolCallId: msg.toolCallId,
          toolName: msg.toolName,
          content: msg.content,
          isError: msg.isError,
          timestamp: msg.timestamp,
          details: msg.details,
        };
      default:
        return null;
    }
  }

  private getModelInfo(session: AgentSession): ModelInfo | null {
    const model = session.model;
    if (!model) return null;
    return {
      provider: model.provider,
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
    };
  }

  private toSessionInfo(id: string, managed: ManagedSession): SessionInfo {
    return {
      id,
      path: managed.session.sessionFile || "",
      title: managed.title,
      createdAt: managed.createdAt,
      modifiedAt: Date.now(),
      messageCount: managed.session.messages.length,
      isLoaded: true,
      isStreaming: managed.session.isStreaming,
    };
  }
}
