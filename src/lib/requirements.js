const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

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

function run(command, cwd, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: getCleanEnv(),
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`Command timed out after ${timeoutMs}ms (likely waiting on an interactive prompt that nobody can see): ${command}`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

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
      if (code !== 0) {
        reject(new Error(`Command failed (${code}): ${command} -- ${stderr.trim() || stdout.trim()}`));
        return;
      }
      resolve(stdout);
    });
  });
}

// Same as run(), but streams stdout/stderr to onLog as it arrives instead of
// buffering silently — used for the install steps so the UI's progress log
// shows what's actually happening during potentially slow solution imports.
// Also has a much longer timeout since solution imports can genuinely take
// several minutes, but still guards against a truly stuck process.
function runWithLog(command, cwd, onLog, timeoutMs = 20 * 60 * 1000) {
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
      // Deliberately worded to NOT contain "timed out" — that phrase is also
      // what real network-layer timeouts look like, and those two cases need
      // different handling. A genuine network timeout means the connection
      // itself died, so the operation never started/continued server-side
      // and a retry is safe. This is different: it means WE gave up waiting
      // after timeoutMs while the process was still running — for something
      // like `pac solution import`, the import job may well still be
      // executing server-side even though we killed our local CLI process.
      // Blindly retrying in that case could start a second, conflicting
      // import. So this message is excluded from the transient-retry pattern
      // on purpose; see runWithRetry.
      reject(new Error(`Local watchdog gave up waiting after ${timeoutMs}ms and killed the process (command may still be running server-side): ${command}`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { onLog(chunk.toString().trimEnd()); });
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
      if (code !== 0) {
        reject(new Error(`Command failed (${code}): ${command}${lastError ? ` -- ${lastError}` : ""}`));
        return;
      }
      resolve();
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retries a transient network failure once. `pac`/Dataverse operations like
// solution import occasionally hit "An existing connection was forcibly
// closed by the remote host" — confirmed in practice to be a one-off network
// blip rather than a real problem: re-running the exact same command
// immediately afterward succeeded cleanly. Only matches genuine network-layer
// failures (the connection itself died, so nothing is left running server-
// side and a retry is safe) — deliberately does NOT match our own local
// watchdog timeout message (see runWithLog), because that case means the
// command may still be executing server-side and blindly retrying it could
// start a conflicting second operation (e.g. two concurrent solution
// imports) instead of safely recovering.
const TRANSIENT_ERROR_PATTERN = /forcibly closed|ECONNRESET|socket hang up|ETIMEDOUT|EPIPE/i;

async function runWithRetry(fn, onLog, description) {
  try {
    return await fn();
  } catch (error) {
    if (/Local watchdog gave up waiting/.test(error.message)) {
      // Non-retryable on purpose: the operation may still be running
      // server-side. Surface that clearly instead of guessing.
      onLog(`${description} exceeded its local wait limit, but it may still be completing on the server. Check its status (e.g. 'pac solution list' for a solution import) before retrying — do not assume it's safe to simply run the move again yet.`);
      throw error;
    }

    if (!TRANSIENT_ERROR_PATTERN.test(error.message)) {
      throw error;
    }

    onLog(`${description} hit a transient network error. Waiting 10s and retrying once...`);
    await delay(10000);
    return fn();
  }
}

// Verifies the `pac` CLI already has at least one signed-in auth profile.
// Deliberately does NOT create a new named profile per environment: an
// earlier version did that via `pac auth create --environment <id> --name
// alm-<hash>`, and that command can silently hang forever waiting on an
// interactive browser/device-code sign-in for a brand-new profile, with zero
// visibility when run from a background worker process — exactly the same
// class of bug we hit with git credential prompts. Every `pac` call below
// passes `--environment <id>` explicitly instead, which works against
// whatever profile the user already has active/signed in.
let cachedAuthCheck = null;
async function ensurePacAuth() {
  if (cachedAuthCheck) {
    return cachedAuthCheck;
  }

  const output = await run("pac auth list", undefined, 15000);
  if (!/UNIVERSAL/i.test(output)) {
    throw new Error("No signed-in 'pac' profile found. Run 'pac auth create --environment <any-environment-id>' once, interactively, then retry.");
  }

  cachedAuthCheck = true;
  return cachedAuthCheck;
}

function parseSolutionList(output) {
  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
  const headerIndex = lines.findIndex((line) => line.startsWith("Unique Name"));
  if (headerIndex < 0) {
    return [];
  }

  // pac's column output pads with however many spaces fit its computed
  // column width, not a fixed number — a long friendly name can collapse
  // that padding down to a single space, so a regex assuming "2+ spaces
  // before the version" silently drops rows. Parse by tokens instead: the
  // last token is True/False, the one before it is the version (digits and
  // dots), the first token is the unique name, and everything in between is
  // the friendly name.
  const solutions = [];
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const tokens = lines[i].split(/\s+/).filter(Boolean);
    if (tokens.length < 4) {
      continue;
    }

    const managedToken = tokens[tokens.length - 1];
    const versionToken = tokens[tokens.length - 2];
    if (!/^(True|False)$/.test(managedToken) || !/^[\d.]+$/.test(versionToken)) {
      continue;
    }

    solutions.push({
      uniqueName: tokens[0],
      friendlyName: tokens.slice(1, tokens.length - 2).join(" "),
      version: versionToken,
      managed: managedToken === "True"
    });
  }
  return solutions;
}

async function listSolutions(environmentId) {
  await ensurePacAuth();
  const output = await run(`pac solution list --environment ${environmentId}`, undefined, 60000);
  return parseSolutionList(output);
}

function isCustomSolution(solution) {
  return !["Default", "Crdeeb7", "Crfbcd5"].includes(solution.uniqueName)
    && !/common data services default solution/i.test(solution.friendlyName)
    && solution.friendlyName.toLowerCase() !== "default solution";
}

// Lists the custom (non-default) solutions available in the source
// environment, for the user to pick from in the UI — this is Option A: let
// the user explicitly choose which solution (Dataverse tables, connections,
// agents, or any other solution-ready components) to bring along, rather
// than guessing. Also reports whether each one is already installed in the
// target environment.
async function listAvailableSolutions(sourceEnvironmentId, targetEnvironmentId) {
  const [sourceSolutions, targetSolutions] = await Promise.all([
    listSolutions(sourceEnvironmentId),
    listSolutions(targetEnvironmentId)
  ]);

  const targetUniqueNames = new Set(targetSolutions.map((entry) => entry.uniqueName));

  return sourceSolutions
    .filter(isCustomSolution)
    .map((solution) => ({
      uniqueName: solution.uniqueName,
      friendlyName: solution.friendlyName,
      version: solution.version,
      installedInTarget: targetUniqueNames.has(solution.uniqueName)
    }));
}

// Reads the connection/table requirements a cloned source app's ms.config.json
// declares. This is the source of truth for "what Dataverse (or other
// connector) data does this app need in order to run."
function readConnectionRequirements(sourceDir) {
  const configPath = path.join(sourceDir, "ms.config.json");
  if (!fs.existsSync(configPath)) {
    return [];
  }

  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const refs = config.connectionReferences || {};

  return Object.entries(refs).map(([refId, ref]) => ({
    refId,
    connectorId: ref.id,
    connectorApiName: (ref.id || "").split("/").pop(),
    displayName: ref.displayName || ref.id,
    authenticationType: ref.authenticationType || "",
    tables: Object.keys(ref.dataverseTables || {})
  }));
}

function extractSolutionZip(zipPath, destDir) {
  // Zip extraction via PowerShell's Expand-Archive avoids adding a node zip
  // dependency, and works reliably for the .zip format solution exports use.
  fs.mkdirSync(destDir, { recursive: true });
  execFileSync("powershell", [
    "-NoProfile",
    "-Command",
    `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`
  ]);
}

// Exports (managed) the solution the user explicitly picked in the UI, from
// the source environment. Cached under cacheRoot so repeat moves of the same
// app don't re-export every time. Returns the local zip path, ready to pass
// to `pac solution import`.
async function exportManagedSolutionZip(sourceEnvironmentId, uniqueName, cacheRoot) {
  await ensurePacAuth();
  const exportDir = path.join(cacheRoot, "exports", sourceEnvironmentId, uniqueName);
  const zipPath = path.join(exportDir, "managed.zip");

  if (!fs.existsSync(zipPath)) {
    fs.mkdirSync(exportDir, { recursive: true });
    const exportCommand = `pac solution export --name ${uniqueName} --path "${zipPath}" --managed --environment ${sourceEnvironmentId}`;
    try {
      // Solution exports can legitimately take several minutes for larger solutions.
      await run(exportCommand, undefined, 5 * 60 * 1000);
    } catch (error) {
      if (!TRANSIENT_ERROR_PATTERN.test(error.message)) {
        throw error;
      }
      // Same transient-network retry as runWithRetry, inlined here since this
      // call site has no onLog callback to report progress through.
      await delay(10000);
      await run(exportCommand, undefined, 5 * 60 * 1000);
    }
  }

  return zipPath;
}

async function isSolutionInstalled(targetEnvironmentId, uniqueName) {
  const solutions = await listSolutions(targetEnvironmentId);
  return solutions.some((entry) => entry.uniqueName === uniqueName);
}

async function hasConnectorConnection(targetEnvironmentId, connectorId) {
  await ensurePacAuth();
  try {
    const output = await run(`pac connection list --environment ${targetEnvironmentId}`, undefined, 60000);
    return output.includes(connectorId);
  } catch (error) {
    return false;
  }
}

const DATAVERSE_CONNECTOR_API_NAME = "shared_commondataserviceforapps";

// Builds the full requirements report for the UI: for each connector the
// source app uses, whether it's Dataverse-backed (needs a solution for
// schema) or any other connector (just needs a connection, no solution
// concept applies at all — e.g. SharePoint sites/lists live outside any
// environment's Dataverse and aren't packaged in solutions), and whether a
// usable connection already exists in the target environment.
async function buildRequirementsReport(sourceDir, sourceEnvironmentId, targetEnvironmentId) {
  const requirements = readConnectionRequirements(sourceDir);
  const report = [];

  for (const requirement of requirements) {
    const isDataverse = requirement.connectorApiName === DATAVERSE_CONNECTOR_API_NAME;

    const entry = {
      id: requirement.refId,
      connectorId: requirement.connectorId,
      connectorApiName: requirement.connectorApiName,
      displayName: requirement.displayName,
      tables: requirement.tables,
      isDataverse,
      connectionSatisfied: await hasConnectorConnection(targetEnvironmentId, requirement.connectorId)
    };

    report.push(entry);
  }

  return report;
}

// Executes what the user approved in the UI, before the app is deployed:
//
//   - Dataverse schema (Option A, user-picked, optional): if the user
//     selected a solution from the source environment's solution list and it
//     isn't already installed in the target, export it (managed) and import
//     it. Picking a solution is OPTIONAL — the user may skip it if the
//     target's tables already exist some other way, or just to test the
//     connection step; if they skip it and the tables genuinely don't exist,
//     the data-source wiring step below will fail with its own real error
//     rather than being silently blocked up front.
//   - Per-connector connections (selectable, independent of the solution
//     choice): for each requirement the user approved, wire up a data source
//     in the target app's working copy (reusing an existing connection or
//     creating a new SSO one). Applies identically to Dataverse and non-
//     Dataverse connectors (SharePoint, SQL, Office 365, etc.).
//
// `selections` is an array of { id, approved } matching the report entries'
// `id` (the connectionReferences key). `selectedSolution` is
// { uniqueName, sourceEnvironmentId, cacheRoot } or null if the user chose
// not to pick one.
async function installRequirements(targetDir, targetEnvironmentId, report, selections, selectedSolution, onLog) {
  const selectionById = new Map((selections || []).map((entry) => [entry.id, entry]));
  const approvedEntries = report.filter((entry) => selectionById.get(entry.id)?.approved);
  const needsDataverseSchema = approvedEntries.some((entry) => entry.isDataverse && entry.tables.length > 0);

  if (needsDataverseSchema && (!selectedSolution || !selectedSolution.uniqueName)) {
    onLog("No solution selected for Dataverse requirements. Skipping solution install and proceeding straight to connection setup — this will fail if the required tables don't already exist in the target environment.");
  }

  if (needsDataverseSchema && selectedSolution && selectedSolution.uniqueName) {
    const alreadyInstalled = await isSolutionInstalled(targetEnvironmentId, selectedSolution.uniqueName);
    if (alreadyInstalled) {
      onLog(`Solution '${selectedSolution.uniqueName}' is already installed in the target environment.`);
    } else {
      onLog(`Exporting solution '${selectedSolution.uniqueName}' from the source environment...`);
      const zipPath = await exportManagedSolutionZip(
        selectedSolution.sourceEnvironmentId,
        selectedSolution.uniqueName,
        selectedSolution.cacheRoot
      );

      onLog(`Installing solution '${selectedSolution.uniqueName}' into the target environment...`);
      try {
        await runWithRetry(
          () => runWithLog(
            `pac solution import --path "${zipPath}" --environment ${targetEnvironmentId} --publish-changes`,
            targetDir,
            onLog,
            90 * 60 * 1000 // solution imports can legitimately take a long time for larger solutions; pac itself blocks until Dataverse's import job finishes, so this is a safety net, not an expected ceiling.
          ),
          onLog,
          "Solution import"
        );
        onLog(`Solution '${selectedSolution.uniqueName}' installed.`);
      } catch (error) {
        // Don't trust the CLI's exit code alone. A dropped HTTP connection
        // between `pac` and Dataverse can fail the CLI call while the import
        // job itself keeps running (or already completed) server-side —
        // confirmed in practice: a command that errored out with "connection
        // forcibly closed" turned out to have left the solution genuinely
        // installed when checked directly afterward. Dataverse's own solution
        // list is the only reliable source of truth here, so check it before
        // deciding this actually failed.
        onLog(`Solution import command reported an error ('${error.message}'). Checking the target environment directly to see if it installed anyway, rather than trusting the command's exit code alone...`);
        const installedAfterAll = await isSolutionInstalled(targetEnvironmentId, selectedSolution.uniqueName);
        if (installedAfterAll) {
          onLog(`Solution '${selectedSolution.uniqueName}' IS present in the target environment despite the error — the import evidently completed server-side. Treating this as a success and continuing.`);
        } else {
          onLog(`Confirmed: solution '${selectedSolution.uniqueName}' is NOT present in the target environment. The import genuinely failed.`);
          throw error;
        }
      }
    }
  }

  for (const entry of report) {
    const selection = selectionById.get(entry.id);

    // Connection wiring is opt-in: skip if the user didn't approve it.
    if (!selection || !selection.approved) {
      onLog(`Skipping connection setup for '${entry.displayName}' (not selected).`);
      continue;
    }

    if (entry.connectionSatisfied && !selection.forceRecreate) {
      onLog(`Connection for '${entry.displayName}' already exists in the target environment. Reusing it.`);
    }

    const tables = entry.tables && entry.tables.length > 0 ? entry.tables : [null];
    for (const table of tables) {
      const tableArgs = table ? `--as table --table ${table} --dataverse-environment-id ${targetEnvironmentId}` : "--as action";
      onLog(`Wiring data source${table ? ` '${table}'` : ""} for connector '${entry.connectorApiName}'...`);
      await runWithRetry(
        () => runWithLog(
          `ms app add data-source --connector ${entry.connectorApiName} ${tableArgs} --use-sso --non-interactive`,
          targetDir,
          onLog
        ),
        onLog,
        "Data source wiring"
      );
    }
  }
}

module.exports = {
  ensurePacAuth,
  listSolutions,
  isCustomSolution,
  listAvailableSolutions,
  readConnectionRequirements,
  exportManagedSolutionZip,
  isSolutionInstalled,
  hasConnectorConnection,
  buildRequirementsReport,
  installRequirements,
  run
};
