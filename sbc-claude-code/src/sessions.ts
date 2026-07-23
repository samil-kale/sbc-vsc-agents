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
          title: await extractTitle(filePath, id),
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

  async remove(_executable: string, cwd: string, sessionId: string): Promise<void> {
    const projectDir = await findProjectDir(cwd);
    if (!projectDir) {
      throw new Error("Claude project directory not found");
    }
    await fs.promises.rm(path.join(projectDir, `${sessionId}.jsonl`));
  },

  /**
   * Mirrors Claude Code's own (CLI-flag-less) `/rename` slash command: it persists a
   * rename as a `custom-title` transcript entry, which - like Claude's own title
   * resolution - always wins over the derived `ai-title`/`summary`/message fallback.
   */
  async rename(_executable: string, cwd: string, sessionId: string, title: string): Promise<void> {
    const trimmed = title.trim();
    if (!trimmed) {
      throw new Error("title must be non-empty");
    }
    const projectDir = await findProjectDir(cwd);
    if (!projectDir) {
      throw new Error("Claude project directory not found");
    }
    const line = JSON.stringify({ type: "custom-title", customTitle: trimmed, sessionId }) + "\n";
    await fs.promises.appendFile(path.join(projectDir, `${sessionId}.jsonl`), line);
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
 * Only ever shows a name Claude Code itself actually assigned - never a guess derived
 * from raw message content. A `custom-title` entry (Claude's own `/rename`) always
 * wins and is appended at the true end of the file, so it's found via a tail scan
 * rather than the head window below. Otherwise falls back to Claude's own
 * auto-generated "ai-title" (what `/resume` shows - re-checked on every occurrence
 * since a later one supersedes an earlier one), else a "summary" entry (only seen
 * after `/compact`). Falls back to "" - the UI shows a placeholder - if Claude hasn't
 * assigned any of these yet.
 */
async function extractTitle(filePath: string, sessionId: string): Promise<string> {
  const customTitle = await findLastCustomTitle(filePath, sessionId);
  if (customTitle) {
    return truncateTitle(customTitle);
  }

  const stream = fs.createReadStream(filePath, { encoding: "utf8", end: TITLE_SCAN_BYTE_LIMIT });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let aiTitle: string | undefined;
  let summary: string | undefined;
  try {
    for await (const line of lines) {
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (entry.type === "ai-title" && typeof entry.aiTitle === "string" && entry.aiTitle.trim()) {
        aiTitle = entry.aiTitle;
      } else if (summary === undefined && entry.type === "summary" && typeof entry.summary === "string" && entry.summary.trim()) {
        summary = entry.summary;
      }
    }
  } catch (error) {
    console.error("[sbc] claude title extraction failed:", error);
  } finally {
    lines.close();
    stream.destroy();
  }
  const title = aiTitle ?? summary;
  return title ? truncateTitle(title) : "";
}

/** Reads just the transcript's tail (custom-title is appended at the end, potentially
 * well past the head window above on a long-running session) and returns the last
 * custom-title entry found there, if any - matching Claude's own "last one wins". */
async function findLastCustomTitle(filePath: string, sessionId: string): Promise<string | undefined> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(filePath, "r");
    const { size } = await handle.stat();
    const start = Math.max(0, size - TITLE_SCAN_BYTE_LIMIT);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(lines[i]) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (
        entry.type === "custom-title" &&
        entry.sessionId === sessionId &&
        typeof entry.customTitle === "string" &&
        entry.customTitle.trim()
      ) {
        return entry.customTitle;
      }
    }
  } catch (error) {
    console.error("[sbc] claude custom-title scan failed:", error);
  } finally {
    await handle?.close();
  }
  return undefined;
}

function truncateTitle(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > TITLE_MAX_LENGTH ? `${normalized.slice(0, TITLE_MAX_LENGTH - 1)}…` : normalized;
}
