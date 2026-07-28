const esbuild = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");
const tsconfig = path.join(__dirname, "tsconfig.json");

// node-pty is a native addon and cannot be bundled. It also cannot stay a plain
// "node-pty" external: npm workspaces hoists it to the repo root, which the packaged
// .vsix does not contain, and vsce refuses to package node_modules from a workspace.
// So we ship the package as dist/node_pty (a name vsce does not exclude) and point
// the require there.
const nodePtyPlugin = {
  name: "node-pty-redirect",
  setup(build) {
    build.onResolve({ filter: /^node-pty$/ }, () => ({
      path: "./node_pty/lib/index.js",
      external: true
    }));
  }
};

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: [path.join(__dirname, "src", "extension.ts")],
  bundle: true,
  outfile: path.join(__dirname, "dist", "extension.js"),
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["vscode"],
  plugins: [nodePtyPlugin],
  sourcemap: !production,
  minify: production,
  tsconfig
};

/** @type {import('esbuild').BuildOptions} */
const webviewConfig = {
  entryPoints: [path.join(__dirname, "..", "shared", "ui", "main.ts")],
  bundle: true,
  outfile: path.join(__dirname, "dist", "webview.js"),
  platform: "browser",
  format: "iife",
  sourcemap: !production,
  minify: production,
  tsconfig
};

function copyNodePty() {
  const source = path.join(__dirname, "..", "node_modules", "node-pty");
  const destination = path.join(__dirname, "dist", "node_pty");
  if (!fs.existsSync(source)) {
    throw new Error(`node-pty not found at ${source} — run npm install first`);
  }
  if (fs.existsSync(destination)) {
    return;
  }
  // Only what node-pty needs at runtime; deps/, src/ and scripts/ are build-time only.
  for (const entry of ["package.json", "lib", "prebuilds", "build", "third_party"]) {
    const from = path.join(source, entry);
    if (fs.existsSync(from)) {
      fs.cpSync(from, path.join(destination, entry), { recursive: true, dereference: true });
    }
  }
}

function copyStaticAssets() {
  fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, "..", "shared", "ui", "styles.css"),
    path.join(__dirname, "dist", "styles.css")
  );
  copyNodePty();
}

async function build() {
  copyStaticAssets();

  if (watch) {
    const extensionCtx = await esbuild.context(extensionConfig);
    const webviewCtx = await esbuild.context(webviewConfig);
    await Promise.all([extensionCtx.watch(), webviewCtx.watch()]);
  } else {
    await Promise.all([esbuild.build(extensionConfig), esbuild.build(webviewConfig)]);
  }
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
