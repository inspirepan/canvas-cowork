import { Loader2 } from "lucide-react";
import type { CanvasAttachment } from "../canvas/canvas-attachments.js";
import type { UseAgentReturn } from "../hooks/use-agent.js";
import { SessionChat } from "./SessionChat.js";
import { SessionList } from "./SessionList.js";

export interface CanvasContext {
  selectionAttachments: CanvasAttachment[];
  getCanvasItems: () => {
    shapeId: string;
    path: string;
    type: "text" | "image" | "frame";
    name: string;
  }[];
  resolveCanvasItem: (shapeId: string, path: string) => CanvasAttachment | null;
}

export function AgentPanel({
  agent,
  canvasContext,
}: {
  agent: UseAgentReturn;
  canvasContext: CanvasContext;
}) {
  if (!agent.connected) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Connecting...
        </div>
      </div>
    );
  }

  const activeState = agent.activeSessionId ? agent.sessionStates.get(agent.activeSessionId) : null;

  // Show session chat if we have an active session with state
  if (agent.activeSessionId && activeState) {
    const sessionId = agent.activeSessionId;
    return (
      <SessionChat
        state={activeState}
        models={agent.models}
        onBack={() => agent.setActiveSessionId(null)}
        onSendPrompt={(text, attachments) => agent.sendPrompt(sessionId, text, attachments)}
        onAbort={() => agent.abort(sessionId)}
        onModelChange={(provider, modelId) => agent.setModel(sessionId, provider, modelId)}
        onThinkingLevelChange={(level) => agent.setThinkingLevel(sessionId, level)}
        canvasContext={canvasContext}
      />
    );
  }

  // Show session list
  return (
    <SessionList
      sessions={agent.sessions}
      onSelectSession={(session) => {
        if (agent.sessionStates.has(session.id)) {
          agent.setActiveSessionId(session.id);
        } else {
          agent.loadSession(session.id);
        }
      }}
      onCreateSession={agent.createSessionWithPrompt}
      onDeleteSession={(sessionId) => agent.deleteSession(sessionId)}
      onNewSession={agent.createSession}
      models={agent.models}
      defaultModel={agent.defaultModel}
      defaultThinkingLevel={agent.defaultThinkingLevel}
      defaultAvailableThinkingLevels={agent.defaultAvailableThinkingLevels}
      onDefaultModelChange={agent.setDefaultModel}
      onDefaultThinkingLevelChange={agent.setDefaultThinkingLevel}
      canvasContext={canvasContext}
    />
  );
}
