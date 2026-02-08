import { AgentPanel } from "./components/AgentPanel.js";

export function App() {
  return (
    <div className="h-screen flex items-center justify-center bg-muted/30 overflow-hidden">
      {/* Panel container - simulates sidebar width */}
      <div className="w-[380px] h-[92vh] max-h-[92vh] bg-background rounded-2xl shadow-[0_4px_40px_rgba(0,0,0,0.12)] overflow-hidden">
        <AgentPanel />
      </div>
    </div>
  );
}
