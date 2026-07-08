import type { SessionStatus } from "./session";

export type HostToWebviewMessage =
  | { type: "output"; data: string }
  | { type: "status"; status: SessionStatus };

export type WebviewToHostMessage =
  | { type: "ready" }
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "showShiftDropHint" }
  | { type: "dropFile"; name: string; dataBase64: string }
  | { type: "openFile"; path: string };
