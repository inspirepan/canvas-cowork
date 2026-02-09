import { Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import type {
  Attachment,
  ModelInfo,
  SessionInfo,
  ThinkingLevel,
} from "../../../shared/protocol.js";
import type { CanvasContext } from "./AgentPanel.js";
import { InputBox, stripSystemTags } from "./SessionChat.js";

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return "just now";
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 30) return `${days}d`;
  return new Date(timestamp).toLocaleDateString();
}

interface SessionListProps {
  sessions: SessionInfo[];
  onSelectSession: (session: SessionInfo) => void;
  onCreateSession: (text: string, attachments?: Attachment[]) => void;
  onDeleteSession: (sessionId: string) => void;
  onNewSession: () => void;
  models: ModelInfo[];
  defaultModel: ModelInfo | null;
  defaultThinkingLevel: ThinkingLevel;
  defaultAvailableThinkingLevels: ThinkingLevel[];
  onDefaultModelChange: (model: ModelInfo) => void;
  onDefaultThinkingLevelChange: (level: ThinkingLevel) => void;
  canvasContext?: CanvasContext;
}

export function SessionList({
  sessions,
  onSelectSession,
  onCreateSession,
  onDeleteSession,
  onNewSession,
  models,
  defaultModel,
  defaultThinkingLevel,
  defaultAvailableThinkingLevels,
  onDefaultModelChange,
  onDefaultThinkingLevelChange,
  canvasContext,
}: SessionListProps) {
  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-4 pt-4 pb-3">
        <h2 className="text-sm font-medium text-foreground">Tasks</h2>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onNewSession}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      <Separator className="shrink-0" />

      {/* Session list */}
      <ScrollArea className="flex-1 min-h-0 [&>[data-slot=scroll-area-viewport]>div]:!block">
        <div className="py-1">
          {sessions.length === 0 ? (
            <div className="px-4 py-12 text-center">
              <p className="text-sm text-muted-foreground">No conversations yet</p>
            </div>
          ) : (
            sessions.map((session) => (
              <button
                type="button"
                key={session.id}
                className="w-full text-left px-4 py-2.5 hover:bg-accent transition-colors flex items-center gap-2 group min-w-0"
                onClick={() => onSelectSession(session)}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm truncate flex-1 text-foreground">{stripSystemTags(session.title)}</span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {formatRelativeTime(session.modifiedAt)}
                    </span>
                  </div>
                </div>
                {session.isStreaming && (
                  <Loader2 className="h-3.5 w-3.5 text-muted-foreground animate-spin shrink-0" />
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteSession(session.id);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                </Button>
              </button>
            ))
          )}
        </div>
      </ScrollArea>

      {/* Bottom input */}
      <InputBox
        autoFocus
        onSubmit={onCreateSession}
        model={defaultModel}
        models={models}
        thinkingLevel={defaultThinkingLevel}
        availableThinkingLevels={defaultAvailableThinkingLevels}
        onModelChange={(provider, modelId) => {
          const m = models.find((m) => m.provider === provider && m.id === modelId);
          if (m) onDefaultModelChange(m);
        }}
        onThinkingLevelChange={onDefaultThinkingLevelChange}
        canvasContext={canvasContext}
      />
    </div>
  );
}
