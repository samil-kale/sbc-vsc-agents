import * as vscode from "vscode";
import type { AgentConfig } from "./agent";

export interface AgentSettings {
  agentPath: string;
  notifications: boolean;
}

export function readSettings(agent: AgentConfig): AgentSettings {
  const config = vscode.workspace.getConfiguration(agent.settingsPrefix);
  return {
    agentPath: config.get<string>("agentPath", agent.executable),
    notifications: config.get<boolean>("notifications", true)
  };
}
