const { loadDeployConfig } = require("./lib/config");
const {
  ensureStore,
  listRequests,
  updateRequest,
  appendLog
} = require("./lib/store");
const { executeGenericDeployment } = require("./lib/executor");

const intervalMs = Number(process.env.WORKER_INTERVAL_MS || 5000);
let locked = false;

ensureStore();

function findNextRequest() {
  const requests = listRequests()
    .filter((request) => request.status === "approved")
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  return requests[0] || null;
}

async function processOne() {
  if (locked) {
    return;
  }

  const request = findNextRequest();
  if (!request) {
    return;
  }

  locked = true;

  try {
    const deployConfig = loadDeployConfig();
    const context = {
      sourceEnvironmentId: request.sourceEnvironmentId,
      sourceEnvironmentName: request.sourceEnvironmentName,
      sourceAppId: request.sourceAppId,
      sourceAppName: request.sourceAppName,
      targetEnvironmentId: request.targetEnvironmentId,
      targetEnvironmentName: request.targetEnvironmentName,
      requirementsReport: request.requirementsReport || null,
      requirementSelections: request.requirementSelections || [],
      selectedSolution: request.selectedSolution || null
    };

    updateRequest(request.id, {
      status: "running",
      startedAt: new Date().toISOString()
    });
    appendLog(request.id, `Request started by worker: ${context.sourceAppName} (${context.sourceEnvironmentName} -> ${context.targetEnvironmentName}).`);

    await executeGenericDeployment(deployConfig, context, (line) => {
      if (!line) {
        return;
      }
      appendLog(request.id, line);
    });

    updateRequest(request.id, {
      status: "succeeded",
      completedAt: new Date().toISOString(),
      outcome: "Deployment completed."
    });
    appendLog(request.id, "Request completed successfully.");
  } catch (error) {
    updateRequest(request.id, {
      status: "failed",
      completedAt: new Date().toISOString(),
      outcome: error.message || "Deployment failed."
    });
    appendLog(request.id, `Request failed: ${error.message || "Unknown error"}`);
  } finally {
    locked = false;
  }
}

setInterval(() => {
  processOne().catch((error) => {
    process.stderr.write(`Worker error: ${error.message}\n`);
  });
}, intervalMs);

process.stdout.write(`Worker running, polling every ${intervalMs}ms\n`);

