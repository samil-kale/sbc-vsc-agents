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
        stats.map(async ({ id, filePath, mtime }) => {
          const { title, provisional } = await extractTitle(filePath, id);
          return { id, title, updatedAt: mtime, provisionalTitle: provisional };
        })
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

interface ResolvedTitle {
  title: string;
  /** No name assigned by Claude yet - `title` is the first prompt standing in for one. */
  provisional: boolean;
}

/**
 * Resolves a session's display name the same way Claude Code's own `/resume` list does
 * (order verified against the CLI, including that a rename outranks an "agent-name"):
 * a `custom-title` entry (Claude's own `/rename`, and what our rename writes) wins and
 * is appended at the true end of the file, so it's found via a tail scan rather than the
 * head window below. Otherwise "agent-name", else "ai-title" - for both, the last
 * occurrence *within that window* wins, since a later one supersedes an earlier one. A
 * title Claude only changed past the window would be missed; it re-emits the same one
 * every turn instead (54 identical entries across a 2MB transcript here), so that stays
 * theoretical. Else a "summary" entry (only seen after `/compact`), else the first
 * prompt the user typed: Claude assigns no title
 * at all to short sessions, and `/resume` labels those by that prompt rather than
 * leaving them blank. Falls back to "" - the UI shows a placeholder - for a transcript
 * with none of these.
 */
async function extractTitle(filePath: string, sessionId: string): Promise<ResolvedTitle> {
  const customTitle = await findLastCustomTitle(filePath, sessionId);
  if (customTitle) {
    return { title: truncateTitle(customTitle), provisional: false };
  }

  const stream = fs.createReadStream(filePath, { encoding: "utf8", end: TITLE_SCAN_BYTE_LIMIT });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let agentName: string | undefined;
  let aiTitle: string | undefined;
  let summary: string | undefined;
  let firstPrompt: string | undefined;
  try {
    for await (const line of lines) {
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      // agent-name/ai-title keep the last occurrence (a later one supersedes an earlier
      // one), summary and the first prompt the first - an empty value never displaces
      // what's already there either way.
      if (entry.type === "agent-name") {
        agentName = nonEmptyString(entry.agentName) ?? agentName;
      } else if (entry.type === "ai-title") {
        aiTitle = nonEmptyString(entry.aiTitle) ?? aiTitle;
      } else if (entry.type === "summary") {
        summary ??= nonEmptyString(entry.summary);
      } else if (firstPrompt === undefined && entry.type === "user") {
        firstPrompt = typedPromptText(entry);
      }
    }
  } catch (error) {
    console.error("[sbc] claude title extraction failed:", error);
  } finally {
    lines.close();
    stream.destroy();
  }
  const assigned = agentName ?? aiTitle ?? summary;
  const title = assigned ?? firstPrompt;
  return { title: title ? truncateTitle(title) : "", provisional: assigned === undefined };
}

/**
 * Most `user` entries are tool results the CLI writes back into the transcript itself;
 * only those tagged `origin.kind === "human"` are prompts the user actually typed.
 * Their `content` is a plain string (no block/array form seen in any transcript here).
 */
function typedPromptText(entry: Record<string, unknown>): string | undefined {
  const origin = entry.origin as { kind?: unknown } | undefined;
  if (origin?.kind !== "human") {
    return undefined;
  }
  const message = entry.message as { content?: unknown } | undefined;
  return nonEmptyString(message?.content);
}

/** Transcript fields are untrusted JSON - a title only counts if it's a non-blank string. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
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
      if (entry.type === "custom-title" && entry.sessionId === sessionId) {
        const customTitle = nonEmptyString(entry.customTitle);
        if (customTitle) {
          return customTitle;
        }
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
