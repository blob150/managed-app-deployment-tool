const fs = require("fs");
const path = require("path");
const { spawn, execSync } = require("child_process");
const { findMapping, saveMapping } = require("./mapping-store");
const { listAppsInEnvironment } = require("./live");
const { installRequirements } = require("./requirements");

// Strips sandbox/automation-only git overrides (e.g. GIT_TERMINAL_PROMPT=0,
// forced GIT_CONFIG_* credential.interactive=never) so spawned git/ms
// commands behave like a normal interactive terminal. Also explicitly forces
// Git Credential Manager to always attempt its interactive sign-in flow
// (GCM_INTERACTIVE=always) — merely removing the "disable" overrides was not
// reliable on its own: GCM would sometimes still refuse to prompt for a host
// it had never contacted before when run from a background/detached process,
// with "there is no cached credential and the session can't prompt for one."
// Forcing GCM_INTERACTIVE=always makes it always try to pop the sign-in
// browser window for any new host, rather than silently giving up.
function getCleanEnv(extra = {}) {
  const env = { ...process.env };
  delete env.GIT_ASKPASS;

  Object.keys(env).forEach((key) => {
    if (key.startsWith("GIT_CONFIG_")) {
      delete env[key];
    }
  });

  env.GIT_TERMINAL_PROMPT = "1";
  env.GCM_INTERACTIVE = "always";

  return { ...env, ...extra };
}

function runCommand(command, cwd, onLog, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: getCleanEnv(),
      stdio: ["ignore", "pipe", "pipe"]
    });

    let lastError = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      onLog(chunk.toString().trimEnd());
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      lastError = text.trim() || lastError;
      onLog(text.trimEnd());
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Command failed (${code}): ${command}${lastError ? ` -- ${lastError}` : ""}`));
    });
  });
}

function runJsonInDir(command, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: getCleanEnv(),
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || command));
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Could not parse JSON from '${command}': ${error.message}`));
      }
    });
  });
}

function removeDirIfExists(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Verifies a cloned/reused working copy's git repo is actually usable — i.e.
// HEAD resolves to a commit object that's really present and readable in the
// object store. Note: `git rev-parse --verify HEAD` is NOT sufficient here —
// it only resolves the ref syntactically and can report success even when
// the underlying object is missing/unreadable. `git cat-file -e` actually
// requires reading the object, which is what we need to catch the failure
// mode seen in practice: clones that come back with a ref recorded but the
// corresponding commit object missing or corrupted (surfaces later as
// "fatal: could not parse HEAD" / "fatal: bad object HEAD" on the very next
// git command, which otherwise crashes the whole move with a cryptic error).
function isRepoHealthy(dir) {
  try {
    execSync("git cat-file -e HEAD", {
      cwd: dir,
      stdio: ["ignore", "ignore", "ignore"],
      env: getCleanEnv()
    });
    return true;
  } catch (error) {
    return false;
  }
}

function extractRepositoryId(cloneUrl) {
  if (!cloneUrl) {
    return "";
  }
  const parts = cloneUrl.split("/");
  return parts[parts.length - 1] || "";
}

// `ms app clone` only restores whatever is committed in the app's repo. If an
// earlier attempt registered the app (via `ms app init`) but failed before its
// ms.config.json was committed and pushed, the clone comes back without that
// file — and `ms app init` cannot be re-run to fix it, because the server
// rejects re-registering a repo host that is already bound to an app
// ("not in the allowed-host list"). So when ms.config.json is missing from an
// already-registered app's working copy, we reconstruct it directly from
// `ms app info` instead of trying to re-initialize the app.
async function ensureMsConfig(targetDir, targetAppId, targetEnvironmentId, fallbackDisplayName, onLog) {
  const configPath = path.join(targetDir, "ms.config.json");
  if (fs.existsSync(configPath)) {
    return;
  }

  onLog("ms.config.json is missing from this app's repo (likely an earlier attempt never committed it). Reconstructing it from the app's registration...");
  const info = await runJsonInDir(`ms app info --app ${targetAppId} --environment-id ${targetEnvironmentId} --json`, targetDir);

  const config = {
    $schema: "https://raw.githubusercontent.com/microsoft/Managed-Apps/main/schemas/ms.config.schema.json",
    version: "0.0",
    appId: info.appId || targetAppId,
    appDisplayName: info.displayName || fallbackDisplayName,
    environmentId: info.environmentId || targetEnvironmentId,
    description: info.description || "",
    repoType: "native",
    cloud: "public",
    buildPath: "./dist",
    buildCommand: "npm run build",
    buildEntryPoint: "index.html",
    repositoryId: extractRepositoryId(info.cloneUrl)
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  onLog("Reconstructed ms.config.json. Note: connection references are not carried over — run 'ms app add data-source' in the target environment if this app uses data connections.");
}

// Files/folders that belong to the SOURCE app's registration and must not be
// carried into the target app's copy — the target gets its own ms.config.json,
// git history, and build output once it is registered.
const SKIP_ENTRIES = new Set([".git", "ms.config.json", ".ms", "node_modules", "dist"]);

function copyAppCode(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });

  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_ENTRIES.has(entry.name)) {
      continue;
    }

    const srcPath = path.join(sourceDir, entry.name);
    const destPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      fs.cpSync(srcPath, destPath, { recursive: true });
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Commits the current working tree as a brand-new root commit, inside a
// freshly re-cloned `.git` directory, and force-pushes it as `main`.
//
// Why: these target-environment repos are generated/synced copies — we don't
// need to preserve their commit history, only guarantee the *current* code is
// live. Depending on the EXISTING local repo's state caused real, repeatable
// failures in practice:
//   1. A freshly provisioned platform-managed repo ships its own unrelated
//      placeholder "Initial commit" (the same bootstrap problem the ALM
//      template's docs call out for `alm:bootstrap`), so a first push is
//      rejected as non-fast-forward with "no common commits".
//   2. A previous run's commit referenced by `main` can end up genuinely
//      missing its underlying object — confirmed via `git fsck` reporting
//      "invalid sha1 pointer" for a commit that simply isn't present
//      anywhere in the pack. Every subsequent clone of that repo then
//      inherits the same broken ref, surfacing as "fatal: could not parse
//      HEAD" / "bad object HEAD" on the very next git command.
//   3. Once HEAD is in that broken state, even `git checkout --orphan` fails
//      with "fatal: You are on a branch yet to be born".
//   4. A plain `git init` + `git remote add` (an earlier version of this
//      fix) loses something important: `ms app clone` writes a tenant/host-
//      specific `[credential "<host>"]` block into `.git/config` (OAuth
//      authorize/token/device endpoints and client ID for THIS platform
//      host) that Git Credential Manager needs to authenticate pushes to
//      it. A bare `git init` has none of that, so the push falls back to a
//      generic auth flow and fails outright with "Authentication failed" —
//      confirmed by diffing a known-good clone's `.git/config` against one
//      from `git init`.
// So instead of reinventing `.git` by hand, we get a known-good one the
// same way the rest of the pipeline does: a fresh `ms app clone` of this
// same app into a scratch folder, then swap that `.git` directory in. This
// guarantees both a healthy object store (fixing #2/#3) and correct
// credential config (fixing #4), and an orphan commit on top of it sidesteps
// #1 without depending on whatever the remote's `main` currently contains.
async function commitAndForcePush(targetDir, appId, message, onLog) {
  const scratchDir = `${targetDir}__gitscratch_${Date.now()}`;
  onLog("Fetching a fresh, correctly-configured .git directory via a scratch clone...");
  await runCommand(`ms app clone --app ${appId} "${scratchDir}"`, path.dirname(targetDir), onLog);

  if (!isRepoHealthy(scratchDir)) {
    removeDirIfExists(scratchDir);
    throw new Error(`Could not obtain a healthy git repo for app '${appId}' even from a fresh clone. The app's remote repo may itself be broken server-side.`);
  }

  onLog("Swapping in the fresh .git directory (keeps correct credential config and a healthy object store)...");
  removeDirIfExists(path.join(targetDir, ".git"));
  fs.renameSync(path.join(scratchDir, ".git"), path.join(targetDir, ".git"));
  removeDirIfExists(scratchDir);

  const tempBranch = `_sync_${Date.now()}`;
  onLog("Creating a fresh commit (not dependent on existing repo history) and force-pushing it...");
  await runCommand(`git checkout --orphan ${tempBranch}`, targetDir, onLog);
  await runCommand("git add -A", targetDir, onLog);
  await runCommand(`git commit -m "${message}" --allow-empty`, targetDir, onLog);
  await runCommand("git branch -D main", targetDir, onLog).catch(() => {});
  await runCommand(`git branch -m main`, targetDir, onLog);
  await runCommand("git push -f -u origin main", targetDir, onLog);
}

// Workspaces live OUTSIDE this project folder deliberately, even though the
// rest of the orchestrator's state (requests.json, app-mappings.json) is
// local. This project directory is synced by OneDrive, and the git clones
// here write pack files that OneDrive's sync engine then races against,
// turning them into cloud placeholders (confirmed via the `ReparsePoint`
// file attribute on freshly-written .pack files) before they're reliably
// readable. That produced exactly the symptoms seen repeatedly: a clone
// passing an integrity check one moment and failing "fatal: bad object HEAD"
// moments later with no code change in between, and failures that could not
// be fixed by re-cloning into the SAME synced folder. Using a local-only
// path (not synced by OneDrive) removes that race entirely.
function defaultWorkspaceRoot() {
  const base = process.env.LOCALAPPDATA || require("os").tmpdir();
  return path.join(base, "managed-app-deployment-tool", "workspaces");
}

// Clones (or re-clones fresh) the source app's code. Shared by the requirements
// check and the full replicate pipeline so both see identical source state.
async function cloneSource(sourceAppId, workspaceRoot, onLog) {
  const root = workspaceRoot || defaultWorkspaceRoot();
  const sourceDir = path.join(root, "source", sourceAppId);

  removeDirIfExists(sourceDir);
  fs.mkdirSync(path.dirname(sourceDir), { recursive: true });

  onLog(`Cloning source app (${sourceAppId})...`);
  await runCommand(`ms app clone --app ${sourceAppId} "${sourceDir}"`, root, onLog);

  if (!isRepoHealthy(sourceDir)) {
    onLog("Cloned source repo failed an integrity check. Re-cloning once before giving up...");
    removeDirIfExists(sourceDir);
    await runCommand(`ms app clone --app ${sourceAppId} "${sourceDir}"`, root, onLog);

    if (!isRepoHealthy(sourceDir)) {
      throw new Error(`Cloned source repo for app '${sourceAppId}' is still corrupted after a retry.`);
    }
    onLog("Re-clone succeeded and passed the integrity check.");
  }

  return sourceDir;
}

// Full replication pipeline for "grab the code from the source app and stand
// it up in the target environment":
//
//   1. Clone the source app's code from its platform-managed repo
//      (`ms app clone`).
//   2. First time for this (sourceAppId, targetEnvironmentId) pair: copy that
//      code into a fresh folder and register a brand-new app in the target
//      environment bound to it (`ms app init`), then remember the mapping so
//      we don't create a duplicate app next time.
//   3. Repeat moves for the same pair: overlay fresh source code onto the
//      SAME target app's existing working copy, commit, and redeploy —
//      updating the one app instead of creating another.
//   4. Install any required Dataverse solutions and wire up data-source
//      connections in the target (see installRequirements in requirements.js),
//      based on what the user approved in the UI.
//   5. `ms app deploy` builds and goes live in the target environment.
async function replicateApp(
  {
    sourceAppId,
    sourceAppName,
    targetEnvironmentId,
    targetEnvironmentName,
    workspaceRoot,
    sourceDir: precomputedSourceDir,
    requirementsReport,
    requirementSelections,
    selectedSolution
  },
  onLog
) {
  const root = workspaceRoot || defaultWorkspaceRoot();
  const sourceDir = precomputedSourceDir || await cloneSource(sourceAppId, root, onLog);

  const mapping = findMapping(sourceAppId, targetEnvironmentId);
  const hasExistingTarget = mapping
    && fs.existsSync(mapping.workDir)
    && fs.existsSync(path.join(mapping.workDir, "ms.config.json"))
    && fs.existsSync(path.join(mapping.workDir, ".git"));

  if (hasExistingTarget) {
    onLog(`Found existing target app '${mapping.targetAppName}' (${mapping.targetAppId}) from a previous move. Updating it.`);
    const targetDir = mapping.workDir;

    onLog("Copying latest source code over the existing target app's working copy...");
    copyAppCode(sourceDir, targetDir);

    if (requirementsReport) {
      await installRequirements(targetDir, targetEnvironmentId, requirementsReport, requirementSelections, selectedSolution, onLog);
    }

    onLog("Committing and pushing changes...");
    await commitAndForcePush(targetDir, mapping.targetAppId, `Sync from source app ${sourceAppName}`, onLog);

    onLog("Deploying updated code to target environment...");
    await runCommand("ms app deploy", targetDir, onLog);

    saveMapping({
      sourceAppId,
      sourceAppName,
      targetEnvironmentId,
      targetAppId: mapping.targetAppId,
      targetAppName: mapping.targetAppName,
      workDir: targetDir
    });

    onLog(`Move complete. Updated existing app '${mapping.targetAppName}' in the target environment.`);
    return { targetAppId: mapping.targetAppId, targetAppName: mapping.targetAppName, created: false };
  }

  const targetDir = path.join(root, "target", `${sourceAppId}__${targetEnvironmentId}`);
  const displayName = `${sourceAppName} [${targetEnvironmentName || targetEnvironmentId}]`;

  // A previous attempt may have already registered the target app but failed
  // on a later step (e.g. deploy), leaving no local mapping recorded. Check
  // the target environment by name before creating a duplicate.
  onLog("Checking target environment for an app from a previous attempt...");
  let existingRemoteApp = null;
  try {
    const remoteApps = await listAppsInEnvironment(targetEnvironmentId);
    existingRemoteApp = remoteApps.find((entry) => entry.displayName === displayName) || null;
  } catch (error) {
    onLog(`Warning: could not check for an existing app: ${error.message}`);
  }

  if (existingRemoteApp) {
    onLog(`Found an already-registered app '${existingRemoteApp.displayName}' (${existingRemoteApp.id}) in the target environment. Reusing it instead of creating a duplicate.`);
    removeDirIfExists(targetDir);
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });

    onLog("Cloning the existing target app's working copy...");
    await runCommand(`ms app clone --app ${existingRemoteApp.id} "${targetDir}"`, root, onLog);

    if (!isRepoHealthy(targetDir)) {
      // Not fatal here: commitAndForcePush below fully reinitializes local
      // git history anyway and only needs the remote URL (readable from
      // .git/config regardless of object-store corruption), so a broken
      // HEAD on the clone doesn't block us — just note it for visibility.
      onLog("Note: cloned repo's git history failed an integrity check, but this doesn't block the move — the push step always starts from a fresh local history.");
    }

    await ensureMsConfig(targetDir, existingRemoteApp.id, targetEnvironmentId, existingRemoteApp.displayName, onLog);

    onLog("Copying latest source code over it...");
    copyAppCode(sourceDir, targetDir);

    if (requirementsReport) {
      await installRequirements(targetDir, targetEnvironmentId, requirementsReport, requirementSelections, selectedSolution, onLog);
    }

    onLog("Committing and pushing changes...");
    await commitAndForcePush(targetDir, existingRemoteApp.id, `Sync from source app ${sourceAppName}`, onLog);

    saveMapping({
      sourceAppId,
      sourceAppName,
      targetEnvironmentId,
      targetAppId: existingRemoteApp.id,
      targetAppName: existingRemoteApp.displayName,
      workDir: targetDir
    });

    onLog("Deploying to the target environment...");
    await runCommand("ms app deploy", targetDir, onLog);

    onLog(`Move complete. Updated existing app '${existingRemoteApp.displayName}' in the target environment.`);
    return { targetAppId: existingRemoteApp.id, targetAppName: existingRemoteApp.displayName, created: false };
  }

  removeDirIfExists(targetDir);
  onLog("No existing target app found for this source/target pair. Creating a new one.");

  copyAppCode(sourceDir, targetDir);

  onLog(`Registering new app '${displayName}' in the target environment...`);
  await runCommand(
    `ms app init --display-name "${displayName}" --environment-id ${targetEnvironmentId} --repo native`,
    targetDir,
    onLog
  );

  onLog("Reading new app details...");
  let targetAppId = "";
  let targetAppName = displayName;
  try {
    const info = await runJsonInDir("ms app info --json", targetDir);
    targetAppId = info.appId || "";
    targetAppName = info.displayName || displayName;
  } catch (error) {
    onLog(`Warning: could not read new app info: ${error.message}`);
  }

  if (!targetAppId) {
    throw new Error("Could not determine the new app's ID after registration — cannot continue safely.");
  }

  // A freshly provisioned platform-managed repo ships its own unrelated
  // placeholder commit, which would otherwise require joining histories
  // (the same bootstrap problem the ALM template's docs call out for
  // `alm:bootstrap`). We sidestep that entirely with an orphan commit +
  // force-push — see commitAndForcePush for the full rationale.
  onLog("Committing and pushing initial app code...");
  await commitAndForcePush(targetDir, targetAppId, `Initial import from source app ${sourceAppName}`, onLog);

  // Save the mapping BEFORE deploying: if deploy fails, a retry will find
  // this app and update/redeploy it instead of registering a duplicate.
  saveMapping({
    sourceAppId,
    sourceAppName,
    targetEnvironmentId,
    targetAppId,
    targetAppName,
    workDir: targetDir
  });

  if (requirementsReport) {
    await installRequirements(targetDir, targetEnvironmentId, requirementsReport, requirementSelections, selectedSolution, onLog);

    onLog("Committing and pushing data source wiring...");
    await runCommand("git add -A", targetDir, onLog);
    await runCommand('git commit -m "Wire up data sources" --allow-empty', targetDir, onLog);
    await runCommand("git push", targetDir, onLog);
  }

  onLog("Deploying new app to the target environment...");
  await runCommand("ms app deploy", targetDir, onLog);

  onLog(`Move complete. Created new app '${targetAppName}' (${targetAppId}) in the target environment.`);
  return { targetAppId, targetAppName, created: true };
}

module.exports = {
  replicateApp,
  cloneSource,
  defaultWorkspaceRoot
};
