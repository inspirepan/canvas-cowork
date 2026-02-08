// WebSocket protocol types shared between server and client

// -- Session info for listing --

export interface SessionInfo {
  id: string;
  path: string;
  title: string;
  createdAt: number;
  modifiedAt: number;
  messageCount: number;
  isLoaded: boolean;
  isStreaming: boolean;
}

// -- Model info --

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
}

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

// -- Serialized message types for transport --

export interface SerializedTextContent {
  type: "text";
  text: string;
}

export interface SerializedThinkingContent {
  type: "thinking";
  thinking: string;
}

export interface SerializedImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface SerializedToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type SerializedContentBlock =
  | SerializedTextContent
  | SerializedThinkingContent
  | SerializedImageContent
  | SerializedToolCall;

export interface SerializedUserMessage {
  role: "user";
  content: string | (SerializedTextContent | SerializedImageContent)[];
  timestamp: number;
}

export interface SerializedAssistantMessage {
  role: "assistant";
  content: SerializedContentBlock[];
  model: string;
  provider: string;
  stopReason?: string;
  timestamp: number;
}

export interface SerializedToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (SerializedTextContent | SerializedImageContent)[];
  isError: boolean;
  timestamp: number;
  details?: Record<string, unknown>;
}

export type SerializedMessage =
  | SerializedUserMessage
  | SerializedAssistantMessage
  | SerializedToolResultMessage;

// -- Streaming delta events --

export type StreamDelta =
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "toolcall_start"; contentIndex: number }
  | {
      type: "toolcall_end";
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | {
      type: "tool_exec_start";
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: "tool_exec_end";
      toolCallId: string;
      toolName: string;
      result: SerializedToolResultMessage;
      isError: boolean;
    }
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "turn_start" }
  | { type: "turn_end" }
  | { type: "message_start"; role: string }
  | { type: "message_end"; message: SerializedMessage };

// -- Attachments (extensible for future canvas state, files, etc.) --

export interface ImageAttachment {
  type: "image";
  data: string; // base64
  mimeType: string;
  name?: string;
}

// Future: canvas snapshot, file reference, etc.
export type Attachment = ImageAttachment;

// -- Client -> Server messages --

export type ClientMessage =
  | { type: "create_session" }
  | { type: "load_session"; sessionId: string }
  | { type: "unload_session"; sessionId: string }
  | { type: "delete_session"; sessionId: string }
  | { type: "list_sessions" }
  | {
      type: "prompt";
      sessionId: string;
      text: string;
      attachments?: Attachment[];
    }
  | { type: "abort"; sessionId: string }
  | {
      type: "set_model";
      sessionId: string;
      provider: string;
      modelId: string;
    }
  | {
      type: "set_thinking_level";
      sessionId: string;
      level: ThinkingLevel;
    }
  | { type: "get_models" };

// -- Server -> Client messages --

export type ServerMessage =
  | {
      type: "session_created";
      session: SessionInfo;
      model: ModelInfo | null;
      thinkingLevel: ThinkingLevel;
      availableThinkingLevels: ThinkingLevel[];
    }
  | {
      type: "session_loaded";
      session: SessionInfo;
      messages: SerializedMessage[];
      model: ModelInfo | null;
      thinkingLevel: ThinkingLevel;
      availableThinkingLevels: ThinkingLevel[];
    }
  | { type: "session_unloaded"; sessionId: string }
  | { type: "session_deleted"; sessionId: string }
  | { type: "sessions_list"; sessions: SessionInfo[] }
  | { type: "stream_delta"; sessionId: string; delta: StreamDelta }
  | {
      type: "session_updated";
      sessionId: string;
      isStreaming: boolean;
      title?: string;
    }
  | {
      type: "model_changed";
      sessionId: string;
      model: ModelInfo;
      thinkingLevel: ThinkingLevel;
      availableThinkingLevels: ThinkingLevel[];
    }
  | {
      type: "thinking_level_changed";
      sessionId: string;
      thinkingLevel: ThinkingLevel;
    }
  | { type: "models_list"; models: ModelInfo[] }
  | { type: "error"; sessionId?: string; message: string };
