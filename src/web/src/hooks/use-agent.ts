import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Attachment,
  CanvasFileEntry,
  CanvasFSEvent,
  ClientMessage,
  ModelInfo,
  SerializedMessage,
  ServerMessage,
  SessionInfo,
  StreamDelta,
  ThinkingLevel,
} from "../../../shared/protocol.js";

// -- UI message types (extended from serialized for streaming state) --

export interface UITextBlock {
  type: "text";
  text: string;
}

export interface UIThinkingBlock {
  type: "thinking";
  thinking: string;
  isStreaming?: boolean;
}

export interface UIToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: {
    content: Array<{ type: string; text?: string; data?: string }>;
    isError: boolean;
    details?: Record<string, unknown>;
  };
  isExecuting?: boolean;
}

export type UIContentBlock = UITextBlock | UIThinkingBlock | UIToolCallBlock;

export interface UIImageAttachment {
  data: string; // base64
  mimeType: string;
  name?: string;
}

export interface UIUserMessage {
  role: "user";
  content: string;
  images?: UIImageAttachment[];
  timestamp: number;
}

export interface UIAssistantMessage {
  role: "assistant";
  content: UIContentBlock[];
  model: string;
  isStreaming?: boolean;
  errorMessage?: string;
  timestamp: number;
}

export type UIMessage = UIUserMessage | UIAssistantMessage;

export interface SessionState {
  info: SessionInfo;
  messages: UIMessage[];
  model: ModelInfo | null;
  thinkingLevel: ThinkingLevel;
  availableThinkingLevels: ThinkingLevel[];
}

export interface CanvasInitialState {
  snapshot: Record<string, unknown> | null;
  shapeToFile: Record<string, string>;
  files: CanvasFileEntry[];
}

export interface UseAgentReturn {
  connected: boolean;
  sessions: SessionInfo[];
  sessionStates: Map<string, SessionState>;
  activeSessionId: string | null;
  models: ModelInfo[];
  defaultModel: ModelInfo | null;
  defaultThinkingLevel: ThinkingLevel;
  defaultAvailableThinkingLevels: ThinkingLevel[];

  setActiveSessionId: (id: string | null) => void;
  createSession: () => void;
  createSessionWithPrompt: (text: string, attachments?: Attachment[]) => void;
  loadSession: (sessionId: string) => void;
  unloadSession: (sessionId: string) => void;
  deleteSession: (sessionId: string) => void;
  refreshSessions: () => void;
  sendPrompt: (sessionId: string, text: string, attachments?: Attachment[]) => void;
  abort: (sessionId: string) => void;
  setModel: (sessionId: string, provider: string, modelId: string) => void;
  setThinkingLevel: (sessionId: string, level: ThinkingLevel) => void;
  setDefaultModel: (model: ModelInfo) => void;
  setDefaultThinkingLevel: (level: ThinkingLevel) => void;
  fetchModels: () => void;

  // Canvas sync
  sendMsg: (msg: ClientMessage) => void;
  canvasState: CanvasInitialState | null;
  onCanvasFSChange: React.MutableRefObject<((changes: CanvasFSEvent[]) => void) | null>;
  onScreenshotRequest: React.MutableRefObject<((requestId: string) => void) | null>;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: message serialization with multiple role/type branches
function serializeToUIMessages(messages: SerializedMessage[]): UIMessage[] {
  const result: UIMessage[] = [];
  let currentAssistant: UIAssistantMessage | null = null;

  for (const msg of messages) {
    if (msg.role === "user") {
      currentAssistant = null;
      const text =
        typeof msg.content === "string"
          ? msg.content
          : msg.content
              .filter((c) => c.type === "text")
              .map((c) => c.text)
              .join("");
      result.push({ role: "user", content: text, timestamp: msg.timestamp });
    } else if (msg.role === "assistant") {
      const blocks: UIContentBlock[] = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          blocks.push({ type: "text", text: block.text });
        } else if (block.type === "thinking") {
          blocks.push({ type: "thinking", thinking: block.thinking });
        } else if (block.type === "toolCall") {
          blocks.push({
            type: "toolCall",
            id: block.id,
            name: block.name,
            arguments: block.arguments,
          });
        }
      }
      currentAssistant = {
        role: "assistant",
        content: blocks,
        model: msg.model,
        errorMessage: msg.errorMessage,
        timestamp: msg.timestamp,
      };
      result.push(currentAssistant);
    } else if (msg.role === "toolResult") {
      // Attach tool result to the matching tool call in the last assistant message
      if (currentAssistant) {
        const toolCall = currentAssistant.content.find(
          (b): b is UIToolCallBlock => b.type === "toolCall" && b.id === msg.toolCallId,
        );
        if (toolCall) {
          toolCall.result = {
            content: msg.content as Array<{ type: string; text?: string; data?: string }>,
            isError: msg.isError,
            details: msg.details,
          };
        }
      }
    }
  }

  return result;
}

export function useAgent(): UseAgentReturn {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionStates, setSessionStates] = useState<Map<string, SessionState>>(new Map());
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [defaultModel, setDefaultModel] = useState<ModelInfo | null>(null);
  const [defaultThinkingLevel, setDefaultThinkingLevel] = useState<ThinkingLevel>("off");
  const [defaultAvailableThinkingLevels, setDefaultAvailableThinkingLevels] = useState<
    ThinkingLevel[]
  >([]);

  const [canvasState, setCanvasState] = useState<CanvasInitialState | null>(null);
  const canvasFSChangeRef = useRef<((changes: CanvasFSEvent[]) => void) | null>(null);
  const screenshotRequestRef = useRef<((requestId: string) => void) | null>(null);

  const pendingPromptRef = useRef<{
    text: string;
    attachments?: Attachment[];
    model?: { provider: string; id: string };
    thinkingLevel?: ThinkingLevel;
  } | null>(null);

  const sendMsg = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const _getOrCreateAssistant = useCallback(
    (
      _sessionId: string,
      updater: (prev: Map<string, SessionState>) => Map<string, SessionState>,
    ) => {
      setSessionStates(updater);
    },
    [],
  );

  // Handle streaming deltas
  const handleStreamDelta = useCallback((sessionId: string, delta: StreamDelta) => {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: central state reducer for streaming deltas
    setSessionStates((prev) => {
      const state = prev.get(sessionId);
      if (!state) return prev;

      const next = new Map(prev);
      const messages = [...state.messages];
      const last = messages[messages.length - 1];

      switch (delta.type) {
        case "agent_start": {
          // Mark session as streaming
          const newInfo = { ...state.info, isStreaming: true };
          next.set(sessionId, { ...state, info: newInfo, messages });
          break;
        }

        case "agent_end": {
          const newInfo = { ...state.info, isStreaming: false };
          // Clear isStreaming on last assistant message
          if (last?.role === "assistant") {
            const updated = { ...last, isStreaming: false };
            // Also clear streaming on thinking blocks
            updated.content = updated.content.map((b) =>
              b.type === "thinking" ? { ...b, isStreaming: false } : b,
            );
            messages[messages.length - 1] = updated;
          }
          next.set(sessionId, { ...state, info: newInfo, messages });
          break;
        }

        case "message_start": {
          if (delta.role === "assistant") {
            messages.push({
              role: "assistant",
              content: [],
              model: "",
              isStreaming: true,
              timestamp: Date.now(),
            });
          }
          next.set(sessionId, { ...state, messages });
          break;
        }

        case "text_delta": {
          if (last?.role === "assistant") {
            const content = [...last.content];
            const lastBlock = content[content.length - 1];
            if (lastBlock?.type === "text") {
              content[content.length - 1] = {
                ...lastBlock,
                text: lastBlock.text + delta.delta,
              };
            } else {
              content.push({ type: "text", text: delta.delta });
            }
            messages[messages.length - 1] = { ...last, content };
          }
          next.set(sessionId, { ...state, messages });
          break;
        }

        case "thinking_delta": {
          if (last?.role === "assistant") {
            const content = [...last.content];
            const lastBlock = content[content.length - 1];
            if (lastBlock?.type === "thinking" && lastBlock.isStreaming) {
              content[content.length - 1] = {
                ...lastBlock,
                thinking: lastBlock.thinking + delta.delta,
              };
            } else {
              content.push({
                type: "thinking",
                thinking: delta.delta,
                isStreaming: true,
              });
            }
            messages[messages.length - 1] = { ...last, content };
          }
          next.set(sessionId, { ...state, messages });
          break;
        }

        case "toolcall_start": {
          // Nothing to do yet, wait for toolcall_end
          break;
        }

        case "toolcall_end": {
          if (last?.role === "assistant") {
            const content = [...last.content];
            content.push({
              type: "toolCall",
              id: delta.toolCallId,
              name: delta.toolName,
              arguments: delta.args,
              isExecuting: false,
            });
            messages[messages.length - 1] = { ...last, content };
          }
          next.set(sessionId, { ...state, messages });
          break;
        }

        case "tool_exec_start": {
          if (last?.role === "assistant") {
            const content = [...last.content];
            const tc = content.find(
              (b): b is UIToolCallBlock => b.type === "toolCall" && b.id === delta.toolCallId,
            );
            if (tc) {
              const idx = content.indexOf(tc);
              content[idx] = { ...tc, isExecuting: true };
              messages[messages.length - 1] = { ...last, content };
            }
          }
          next.set(sessionId, { ...state, messages });
          break;
        }

        case "tool_exec_end": {
          if (last?.role === "assistant") {
            const content = [...last.content];
            const tc = content.find(
              (b): b is UIToolCallBlock => b.type === "toolCall" && b.id === delta.toolCallId,
            );
            if (tc) {
              const idx = content.indexOf(tc);
              content[idx] = {
                ...tc,
                isExecuting: false,
                result: {
                  content: delta.result.content as Array<{
                    type: string;
                    text?: string;
                    data?: string;
                  }>,
                  isError: delta.isError,
                  details: delta.result.details,
                },
              };
              messages[messages.length - 1] = { ...last, content };
            }
          }
          next.set(sessionId, { ...state, messages });
          break;
        }

        case "message_end": {
          // Replace streamed assistant message with final version
          if (delta.message.role === "assistant" && last?.role === "assistant") {
            const finalMsg = serializeToUIMessages([delta.message])[0];
            if (finalMsg) {
              // Preserve tool results that were attached during streaming
              if (finalMsg.role === "assistant") {
                for (const block of last.content) {
                  if (block.type === "toolCall" && block.result) {
                    const match = finalMsg.content.find(
                      (b): b is UIToolCallBlock => b.type === "toolCall" && b.id === block.id,
                    );
                    if (match) {
                      match.result = block.result;
                    }
                  }
                }
              }
              messages[messages.length - 1] = finalMsg;
            }
          } else if (delta.message.role === "toolResult" && last?.role === "assistant") {
            // Attach tool result to matching tool call
            const toolResult = delta.message;
            const content = [...last.content];
            const tc = content.find(
              (b): b is UIToolCallBlock => b.type === "toolCall" && b.id === toolResult.toolCallId,
            );
            if (tc) {
              const idx = content.indexOf(tc);
              content[idx] = {
                ...tc,
                isExecuting: false,
                result: {
                  content: toolResult.content as Array<{
                    type: string;
                    text?: string;
                    data?: string;
                  }>,
                  isError: toolResult.isError,
                  details: toolResult.details,
                },
              };
              messages[messages.length - 1] = { ...last, content };
            }
          } else if (delta.message.role === "user") {
            // User message finalized - already added via sendPrompt
          }
          next.set(sessionId, { ...state, messages });
          break;
        }
      }

      return next;
    });
  }, []);

  // Handle server messages
  const handleServerMessage = useCallback(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: central message dispatcher
    (msg: ServerMessage) => {
      switch (msg.type) {
        case "sessions_list":
          setSessions(msg.sessions);
          break;

        case "session_created": {
          const pending = pendingPromptRef.current;
          pendingPromptRef.current = null;
          const initialMessages: UIMessage[] = [];
          if (pending) {
            const images = pending.attachments
              ?.filter((a) => a.type === "image")
              .map((a) => ({ data: a.data, mimeType: a.mimeType, name: a.name }));
            initialMessages.push({
              role: "user",
              content: pending.text,
              ...((images?.length ?? 0) > 0 ? { images } : {}),
              timestamp: Date.now(),
            });
          }
          // Update global defaults
          if (msg.model) setDefaultModel(msg.model);
          setDefaultThinkingLevel(msg.thinkingLevel);
          setDefaultAvailableThinkingLevels(msg.availableThinkingLevels);

          setSessions((prev) => [msg.session, ...prev]);
          setSessionStates((prev) => {
            const next = new Map(prev);
            next.set(msg.session.id, {
              info: msg.session,
              messages: initialMessages,
              model: msg.model,
              thinkingLevel: msg.thinkingLevel,
              availableThinkingLevels: msg.availableThinkingLevels,
            });
            return next;
          });
          setActiveSessionId(msg.session.id);
          if (pending) {
            // Apply model/thinkingLevel preferences if user changed them before creating
            if (pending.model) {
              sendMsg({
                type: "set_model",
                sessionId: msg.session.id,
                provider: pending.model.provider,
                modelId: pending.model.id,
              });
            }
            if (pending.thinkingLevel && pending.thinkingLevel !== msg.thinkingLevel) {
              sendMsg({
                type: "set_thinking_level",
                sessionId: msg.session.id,
                level: pending.thinkingLevel,
              });
            }
            sendMsg({
              type: "prompt",
              sessionId: msg.session.id,
              text: pending.text,
              ...((pending.attachments?.length ?? 0) > 0
                ? { attachments: pending.attachments }
                : {}),
            });
          }
          break;
        }

        case "session_loaded": {
          const uiMessages = serializeToUIMessages(msg.messages);
          // Update global defaults
          if (msg.model) setDefaultModel(msg.model);
          setDefaultThinkingLevel(msg.thinkingLevel);
          setDefaultAvailableThinkingLevels(msg.availableThinkingLevels);

          setSessions((prev) =>
            prev.map((s) => (s.id === msg.session.id ? { ...msg.session, isLoaded: true } : s)),
          );
          setSessionStates((prev) => {
            const next = new Map(prev);
            next.set(msg.session.id, {
              info: { ...msg.session, isLoaded: true },
              messages: uiMessages,
              model: msg.model,
              thinkingLevel: msg.thinkingLevel,
              availableThinkingLevels: msg.availableThinkingLevels,
            });
            return next;
          });
          setActiveSessionId(msg.session.id);
          break;
        }

        case "session_unloaded":
          setSessionStates((prev) => {
            const next = new Map(prev);
            next.delete(msg.sessionId);
            return next;
          });
          setSessions((prev) =>
            prev.map((s) => (s.id === msg.sessionId ? { ...s, isLoaded: false } : s)),
          );
          break;

        case "session_deleted":
          setSessionStates((prev) => {
            const next = new Map(prev);
            next.delete(msg.sessionId);
            return next;
          });
          setSessions((prev) => prev.filter((s) => s.id !== msg.sessionId));
          setActiveSessionId((prev) => (prev === msg.sessionId ? null : prev));
          break;

        case "stream_delta":
          handleStreamDelta(msg.sessionId, msg.delta);
          break;

        case "session_updated":
          setSessions((prev) =>
            prev.map((s) =>
              s.id === msg.sessionId
                ? {
                    ...s,
                    isStreaming: msg.isStreaming,
                    title: msg.title || s.title,
                  }
                : s,
            ),
          );
          setSessionStates((prev) => {
            const state = prev.get(msg.sessionId);
            if (!state) return prev;
            const next = new Map(prev);
            next.set(msg.sessionId, {
              ...state,
              info: {
                ...state.info,
                isStreaming: msg.isStreaming,
                title: msg.title || state.info.title,
              },
            });
            return next;
          });
          break;

        case "model_changed":
          setSessionStates((prev) => {
            const state = prev.get(msg.sessionId);
            if (!state) return prev;
            const next = new Map(prev);
            next.set(msg.sessionId, {
              ...state,
              model: msg.model,
              thinkingLevel: msg.thinkingLevel,
              availableThinkingLevels: msg.availableThinkingLevels,
            });
            return next;
          });
          break;

        case "thinking_level_changed":
          setSessionStates((prev) => {
            const state = prev.get(msg.sessionId);
            if (!state) return prev;
            const next = new Map(prev);
            next.set(msg.sessionId, {
              ...state,
              thinkingLevel: msg.thinkingLevel,
            });
            return next;
          });
          break;

        case "models_list":
          setModels(msg.models);
          setDefaultModel((prev) => {
            if (prev) return prev;
            return (
              msg.models.find(
                (m) => m.provider === "openrouter" && m.id === "anthropic/claude-opus-4.6",
              ) ||
              msg.models[0] ||
              null
            );
          });
          break;

        case "canvas_fs_change":
          canvasFSChangeRef.current?.(msg.changes);
          break;

        case "canvas_state":
          setCanvasState({
            snapshot: msg.snapshot,
            shapeToFile: msg.shapeToFile,
            files: msg.files,
          });
          break;

        case "screenshot_request":
          screenshotRequestRef.current?.(msg.requestId);
          break;

        case "error":
          break;
      }
    },
    [handleStreamDelta, sendMsg],
  );

  // WebSocket connection
  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      sendMsg({ type: "list_sessions" });
      sendMsg({ type: "get_models" });
      sendMsg({ type: "canvas_init" });
    };

    ws.onmessage = (e) => {
      try {
        const msg: ServerMessage = JSON.parse(e.data);
        handleServerMessage(msg);
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = () => {
      setConnected(false);
    };

    return () => {
      ws.close();
    };
  }, [handleServerMessage, sendMsg]);

  const createSession = useCallback(() => {
    sendMsg({ type: "create_session" });
  }, [sendMsg]);

  const createSessionWithPrompt = useCallback(
    (text: string, attachments?: Attachment[]) => {
      pendingPromptRef.current = {
        text,
        attachments,
        model: defaultModel ? { provider: defaultModel.provider, id: defaultModel.id } : undefined,
        thinkingLevel: defaultThinkingLevel,
      };
      sendMsg({ type: "create_session" });
    },
    [sendMsg, defaultModel, defaultThinkingLevel],
  );

  const loadSession = useCallback(
    (sessionId: string) => {
      sendMsg({ type: "load_session", sessionId });
    },
    [sendMsg],
  );

  const unloadSession = useCallback(
    (sessionId: string) => {
      sendMsg({ type: "unload_session", sessionId });
    },
    [sendMsg],
  );

  const deleteSession = useCallback(
    (sessionId: string) => {
      sendMsg({ type: "delete_session", sessionId });
    },
    [sendMsg],
  );

  const refreshSessions = useCallback(() => {
    sendMsg({ type: "list_sessions" });
  }, [sendMsg]);

  const sendPrompt = useCallback(
    (sessionId: string, text: string, attachments?: Attachment[]) => {
      // Optimistically add user message
      const images = attachments
        ?.filter((a) => a.type === "image")
        .map((a) => ({ data: a.data, mimeType: a.mimeType, name: a.name }));
      setSessionStates((prev) => {
        const state = prev.get(sessionId);
        if (!state) return prev;
        const next = new Map(prev);
        next.set(sessionId, {
          ...state,
          messages: [
            ...state.messages,
            {
              role: "user" as const,
              content: text,
              ...((images?.length ?? 0) > 0 ? { images } : {}),
              timestamp: Date.now(),
            },
          ],
        });
        return next;
      });
      sendMsg({
        type: "prompt",
        sessionId,
        text,
        ...((attachments?.length ?? 0) > 0 ? { attachments } : {}),
      });
    },
    [sendMsg],
  );

  const abort = useCallback(
    (sessionId: string) => {
      sendMsg({ type: "abort", sessionId });
    },
    [sendMsg],
  );

  const setModelFn = useCallback(
    (sessionId: string, provider: string, modelId: string) => {
      sendMsg({ type: "set_model", sessionId, provider, modelId });
    },
    [sendMsg],
  );

  const setThinkingLevelFn = useCallback(
    (sessionId: string, level: ThinkingLevel) => {
      sendMsg({ type: "set_thinking_level", sessionId, level });
    },
    [sendMsg],
  );

  const fetchModels = useCallback(() => {
    sendMsg({ type: "get_models" });
  }, [sendMsg]);

  return {
    connected,
    sessions,
    sessionStates,
    activeSessionId,
    models,
    defaultModel,
    defaultThinkingLevel,
    defaultAvailableThinkingLevels,
    setActiveSessionId,
    createSession,
    createSessionWithPrompt,
    loadSession,
    unloadSession,
    deleteSession,
    refreshSessions,
    sendPrompt,
    abort,
    setModel: setModelFn,
    setThinkingLevel: setThinkingLevelFn,
    setDefaultModel,
    setDefaultThinkingLevel,
    fetchModels,

    // Canvas sync
    sendMsg,
    canvasState,
    onCanvasFSChange: canvasFSChangeRef,
    onScreenshotRequest: screenshotRequestRef,
  };
}
