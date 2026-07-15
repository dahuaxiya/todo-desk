import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const outputDir = resolve(process.argv[2] ?? "../../outputs/todo-desk-release");
const requiredArchitectures = new Set(["arm64", "x86_64"]);

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();

  if (result.status !== 0) {
    throw new Error(
      `Command failed (${command} ${args.join(" ")}):\n${output || `exit ${result.status}`}`,
    );
  }
  return output;
}

function collect(root, predicate, stopAtMatch = false) {
  const matches = [];

  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (predicate(path, entry)) {
        matches.push(path);
        if (stopAtMatch) continue;
      }
      if (entry.isDirectory()) walk(path);
    }
  }

  walk(root);
  return matches;
}

function verifyApp(appPath) {
  console.log(`\nVerifying ${appPath}`);
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);

  // codesign writes display information to stderr, which run() intentionally combines.
  const signature = run("codesign", ["--display", "--verbose=4", appPath]);
  if (!/Authority=Developer ID Application:/.test(signature)) {
    throw new Error(`${appPath} is not signed with a Developer ID Application certificate.`);
  }

  const teamIdentifier = signature.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
  if (!teamIdentifier || teamIdentifier === "not set") {
    throw new Error(`${appPath} has no TeamIdentifier.`);
  }
  if (!/^flags=.*\bruntime\b/m.test(signature)) {
    throw new Error(`${appPath} was not signed with Hardened Runtime.`);
  }

  const gatekeeper = run("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]);
  if (!/accepted/i.test(gatekeeper)) {
    throw new Error(`Gatekeeper did not accept ${appPath}:\n${gatekeeper}`);
  }

  run("xcrun", ["stapler", "validate", "-v", appPath]);

  const executableName = run("plutil", [
    "-extract",
    "CFBundleExecutable",
    "raw",
    "-o",
    "-",
    join(appPath, "Contents", "Info.plist"),
  ]);
  const architectures = run("lipo", [
    "-archs",
    join(appPath, "Contents", "MacOS", executableName),
  ]).split(/\s+/);

  console.log(`  Team: ${teamIdentifier}`);
  console.log(`  Architectures: ${architectures.join(", ")}`);
  return architectures;
}

function verifyDmg(dmgPath) {
  console.log(`\nVerifying disk image ${basename(dmgPath)}`);
  run("codesign", ["--verify", "--verbose=2", dmgPath]);
  run("spctl", [
    "--assess",
    "--type",
    "open",
    "--context",
    "context:primary-signature",
    "--verbose=4",
    dmgPath,
  ]);

  const mountRoot = mkdtempSync(join(tmpdir(), "todo-desk-dmg-"));
  try {
    // Verifying the mounted app catches a correctly signed DMG that accidentally contains
    // an unsigned, unstapled, or otherwise different application bundle.
    run("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mountRoot, dmgPath]);
    const apps = collect(mountRoot, (path) => path.endsWith(".app"), true);
    if (apps.length !== 1) {
      throw new Error(`${dmgPath} should contain exactly one app, found ${apps.length}.`);
    }
    verifyApp(apps[0]);
  } finally {
    spawnSync("hdiutil", ["detach", mountRoot, "-force"], { encoding: "utf8" });
    rmSync(mountRoot, { recursive: true, force: true });
  }
}

if (process.platform !== "darwin") {
  throw new Error("macOS release verification must run on macOS.");
}

const apps = collect(outputDir, (path) => path.endsWith(".app"), true);
const dmgs = collect(outputDir, (path, entry) => entry.isFile() && path.endsWith(".dmg"));
const zips = collect(outputDir, (path, entry) => entry.isFile() && path.endsWith(".zip"));

if (apps.length < 2 || dmgs.length !== 2 || zips.length !== 2) {
  throw new Error(
    `Expected arm64 and x64 app/DMG/ZIP outputs; found ${apps.length} apps, ${dmgs.length} DMGs, and ${zips.length} ZIPs in ${outputDir}.`,
  );
}

const discoveredArchitectures = new Set();
for (const app of apps) {
  for (const architecture of verifyApp(app)) discoveredArchitectures.add(architecture);
}
for (const dmg of dmgs) verifyDmg(dmg);

for (const architecture of requiredArchitectures) {
  if (!discoveredArchitectures.has(architecture)) {
    throw new Error(`Missing required ${architecture} application build.`);
  }
}

for (const architecture of ["arm64", "x64"]) {
  if (!dmgs.some((path) => basename(path).includes(`-${architecture}.dmg`))) {
    throw new Error(`Missing ${architecture} DMG artifact.`);
  }
  if (!zips.some((path) => basename(path).includes(`-${architecture}.zip`))) {
    throw new Error(`Missing ${architecture} ZIP artifact.`);
  }
}

console.log("\nmacOS release verification passed.");
