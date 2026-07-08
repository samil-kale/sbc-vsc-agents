import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * `claude --continue` resumes the newest session for the current cwd, but errors when
 * none exists — so only pass it when the CLI's per-project session directory
 * (~/.claude/projects/<cwd with non-alphanumerics replaced by "-">) has transcripts.
 */
export async function claudeResumeArgs(_executable: string, cwd: string): Promise<string[]> {
  try {
    const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
    const projectsDir = path.join(configDir, "projects");
    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
    // Windows paths are case-insensitive and the CLI preserves whatever casing it saw,
    // so the same project can have differently-cased directories there.
    const ignoreCase = process.platform === "win32";
    const wanted = ignoreCase ? encoded.toLowerCase() : encoded;
    for (const entry of await fs.promises.readdir(projectsDir)) {
      if ((ignoreCase ? entry.toLowerCase() : entry) !== wanted) {
        continue;
      }
      const files = await fs.promises.readdir(path.join(projectsDir, entry));
      if (files.some((file) => file.endsWith(".jsonl"))) {
        return ["--continue"];
      }
    }
  } catch (error) {
    console.error("[sbc] claude session detection failed:", error);
  }
  return [];
}
