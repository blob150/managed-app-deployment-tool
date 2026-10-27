const fs = require("fs");
const { spawn } = require("child_process");
const { replicateApp } = require("./replicate");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function interpolate(command, context) {
  return command
    .replaceAll("{{targetEnv}}", context.targetEnv || "")
    .replaceAll("{{sourceRef}}", context.sourceRef || "")
    .replaceAll("{{appId}}", context.appId || "");
}

async function runCommand(command, cwd, onLog) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    child.stdout.on("data", (chunk) => {
      onLog(chunk.toString().trimEnd());
    });

    child.stderr.on("data", (chunk) => {
      onLog(chunk.toString().trimEnd());
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Command failed (${code}): ${command}`));
    });
  });
}

async function runMock(app, envName, onLog) {
  onLog(`Mock deploy started for app '${app.id}' to '${envName}'.`);
  await delay(700);
  onLog("Validating request and permissions.");
  await delay(700);
  onLog("Checking branch policy and deployment guardrails.");
  await delay(700);
  onLog("Simulating managed app deploy command.");
  await delay(700);
  onLog("Mock deploy finished successfully.");
}

async function runShell(app, envName, envConfig, request, onLog) {
  if (!app.repoPath) {
    throw new Error(`App '${app.id}' is missing repoPath.`);
  }

  if (!fs.existsSync(app.repoPath)) {
    throw new Error(`repoPath does not exist: ${app.repoPath}`);
  }

  if (!Array.isArray(envConfig.steps) || envConfig.steps.length === 0) {
    throw new Error(`No deployment steps configured for app '${app.id}' in env '${envName}'.`);
  }

  const context = {
    targetEnv: envName,
    sourceRef: request.sourceRef || "",
    appId: app.id
  };

  for (const rawStep of envConfig.steps) {
    const command = interpolate(rawStep, context);
    onLog(`> ${command}`);
    await runCommand(command, app.repoPath, onLog);
  }
}

async function executeDeployment(app, envName, envConfig, request, onLog) {
  const mode = app.mode || "mock";

  if (mode === "mock") {
    await runMock(app, envName, onLog);
    return;
  }

  if (mode === "shell") {
    await runShell(app, envName, envConfig, request, onLog);
    return;
  }

  throw new Error(`Unsupported app mode '${mode}'. Use 'mock' or 'shell'.`);
}

function interpolateGeneric(command, context) {
  return command
    .replaceAll("{{sourceEnvironmentId}}", context.sourceEnvironmentId || "")
    .replaceAll("{{sourceEnvironmentName}}", context.sourceEnvironmentName || "")
    .replaceAll("{{sourceAppId}}", context.sourceAppId || "")
    .replaceAll("{{sourceAppName}}", context.sourceAppName || "")
    .replaceAll("{{targetEnvironmentId}}", context.targetEnvironmentId || "")
    .replaceAll("{{targetEnvironmentName}}", context.targetEnvironmentName || "");
}

async function runGenericMock(context, onLog) {
  onLog(`Mock move started: '${context.sourceAppName}' (${context.sourceAppId})`);
  onLog(`  from '${context.sourceEnvironmentName}' (${context.sourceEnvironmentId})`);
  onLog(`  to   '${context.targetEnvironmentName}' (${context.targetEnvironmentId})`);
  await delay(700);
  onLog("Validating permissions in target environment.");
  await delay(700);
  onLog("Checking for existing app registration in target environment.");
  await delay(700);
  onLog("Simulating deploy command.");
  await delay(700);
  onLog("Mock move finished successfully.");
}

async function runGenericShell(deployConfig, context, onLog) {
  if (!deployConfig.repoPath) {
    throw new Error("config/deploy.json is missing repoPath for shell mode.");
  }

  if (!fs.existsSync(deployConfig.repoPath)) {
    throw new Error(`repoPath does not exist: ${deployConfig.repoPath}`);
  }

  if (!Array.isArray(deployConfig.steps) || deployConfig.steps.length === 0) {
    throw new Error("config/deploy.json has no steps configured for shell mode.");
  }

  for (const rawStep of deployConfig.steps) {
    const command = interpolateGeneric(rawStep, context);
    onLog(`> ${command}`);
    await runCommand(command, deployConfig.repoPath, onLog);
  }
}

// Executes a move/promotion for a live-selected source app + target environment.
// context: { sourceEnvironmentId, sourceEnvironmentName, sourceAppId, sourceAppName,
//            targetEnvironmentId, targetEnvironmentName }
async function executeGenericDeployment(deployConfig, context, onLog) {
  const mode = deployConfig.mode || "mock";

  if (mode === "mock") {
    await runGenericMock(context, onLog);
    return;
  }

  if (mode === "shell") {
    await runGenericShell(deployConfig, context, onLog);
    return;
  }

  if (mode === "replicate") {
    await replicateApp(
      {
        sourceAppId: context.sourceAppId,
        sourceAppName: context.sourceAppName,
        targetEnvironmentId: context.targetEnvironmentId,
        targetEnvironmentName: context.targetEnvironmentName,
        workspaceRoot: deployConfig.workspaceRoot,
        requirementsReport: context.requirementsReport,
        requirementSelections: context.requirementSelections,
        selectedSolution: context.selectedSolution
      },
      onLog
    );
    return;
  }

  throw new Error(`Unsupported deploy mode '${mode}'. Use 'mock', 'shell', or 'replicate'.`);
}

module.exports = {
  executeDeployment,
  executeGenericDeployment
};

