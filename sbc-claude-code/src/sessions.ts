import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import type { AgentSessionInfo, SessionProvider } from "@shared/agent";

/**
 * Claude Code has no session CLI - sessions are the `<uuid>.jsonl` transcripts in
 * ~/.claude/projects/<cwd with non-alphanumerics replaced by "-">, identified by
 * filename and ordered by mtime. Deleting a session means deleting its transcript.
 */
export const claudeSessionProvider: SessionProvider = {
  async list(_executable: string, cwd: string): Promise<AgentSessionInfo[]> {
    try {
      const projectDir = await findProjectDir(cwd);
      if (!projectDir) {
        return [];
      }
      const files = (await fs.promises.readdir(projectDir)).filter((file) => file.endsWith(".jsonl"));
      const stats = await Promise.all(
        files.map(async (file) => ({
          id: file.slice(0, -".jsonl".length),
          filePath: path.join(projectDir, file),
          mtime: (await fs.promises.stat(path.join(projectDir, file))).mtimeMs
        }))
      );
      stats.sort((a, b) => b.mtime - a.mtime);
      return await Promise.all(
        stats.map(async ({ id, filePath, mtime }) => ({
          id,
          title: await extractTitle(filePath),
          updatedAt: mtime
        }))
      );
    } catch (error) {
      console.error("[sbc] claude session listing failed:", error);
      return [];
    }
  },

  resumeArgs(sessionId: string): string[] {
    return ["--resume", sessionId];
  },

  continueArgs(): string[] {
    return ["--continue"];
  },

  async remove(_executable: string, cwd: string, sessionId: string): Promise<void> {
    const projectDir = await findProjectDir(cwd);
    if (!projectDir) {
      throw new Error("Claude project directory not found");
    }
    await fs.promises.rm(path.join(projectDir, `${sessionId}.jsonl`));
  }
};

async function findProjectDir(cwd: string): Promise<string | undefined> {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  const projectsDir = path.join(configDir, "projects");
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  // Windows paths are case-insensitive and the CLI preserves whatever casing it saw,
  // so the same project can have differently-cased directories there.
  const ignoreCase = process.platform === "win32";
  const wanted = ignoreCase ? encoded.toLowerCase() : encoded;
  for (const entry of await fs.promises.readdir(projectsDir)) {
    if ((ignoreCase ? entry.toLowerCase() : entry) === wanted) {
      return path.join(projectsDir, entry);
    }
  }
  return undefined;
}

const TITLE_MAX_LENGTH = 60;
const TITLE_SCAN_BYTE_LIMIT = 256 * 1024;

/**
 * Streams the transcript's first lines for something label-worthy: a summary entry's
 * text, else the first real user message. Synthetic messages (slash-command XML, meta,
 * subagent sidechains) are skipped. Falls back to "" - the UI shows a placeholder.
 */
async function extractTitle(filePath: string): Promise<string> {
  const stream = fs.createReadStream(filePath, { encoding: "utf8", end: TITLE_SCAN_BYTE_LIMIT });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (entry.type === "summary" && typeof entry.summary === "string" && entry.summary.trim()) {
        return truncateTitle(entry.summary);
      }
      if (entry.type !== "user" || entry.isMeta === true || entry.isSidechain === true) {
        continue;
      }
      const text = userMessageText(entry);
      if (text && !text.startsWith("<")) {
        return truncateTitle(text);
      }
    }
  } catch (error) {
    console.error("[sbc] claude title extraction failed:", error);
  } finally {
    lines.close();
    stream.destroy();
  }
  return "";
}

function userMessageText(entry: Record<string, unknown>): string | undefined {
  const message = entry.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    const textBlock = content.find(
      (block): block is { type: string; text: string } =>
        typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text"
    );
    return textBlock?.text.trim();
  }
  return undefined;
}

function truncateTitle(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > TITLE_MAX_LENGTH ? `${normalized.slice(0, TITLE_MAX_LENGTH - 1)}…` : normalized;
}
