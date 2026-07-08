const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const extensionDirs = ["sbc-claude-code", "sbc-open-code"];

function findVsix(dir) {
  const vsixFiles = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".vsix"))
    .map((file) => ({ file, mtime: fs.statSync(path.join(dir, file)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (vsixFiles.length === 0) {
    throw new Error(`No .vsix file found in ${dir} after packaging`);
  }
  return path.join(dir, vsixFiles[0].file);
}

for (const dirName of extensionDirs) {
  const dir = path.join(__dirname, "..", dirName);
  execSync("npm run package", { cwd: dir, stdio: "inherit" });
  const vsixPath = findVsix(dir);
  execSync(`code --install-extension "${vsixPath}" --force`, { stdio: "inherit" });
}
