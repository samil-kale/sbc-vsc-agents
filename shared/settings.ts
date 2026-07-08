import * as vscode from "vscode";
import type { AgentConfig, NotificationSettings } from "./agent";

export interface AgentSettings {
  agentPath: string;
  notifications: NotificationSettings;
}

export function readSettings(agent: AgentConfig): AgentSettings {
  const config = vscode.workspace.getConfiguration(agent.settingsPrefix);
  return {
    agentPath: config.get<string>("agentPath", agent.executable),
    notifications: {
      finished: config.get<boolean>("notifyFinished", true),
      needsYou: config.get<boolean>("notifyNeedsYou", true),
      idleReminder: config.get<boolean>("notifyIdleReminder", false)
    }
  };
}
