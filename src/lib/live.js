const { spawn } = require("child_process");

function runJsonCommand(command, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Command timed out: ${command}`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Command failed (${code}): ${stderr.trim() || stdout.trim() || command}`));
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

// pac admin list --json returns environments the signed-in account can access.
async function listEnvironments() {
  const raw = await runJsonCommand("pac admin list --json");
  const items = Array.isArray(raw) ? raw : [];

  return items.map((entry) => ({
    id: entry.EnvironmentId,
    displayName: entry.DisplayName,
    url: entry.EnvironmentUrl,
    type: entry.Type
  }));
}

// ms app list --environment-id <id> --json returns managed apps the signed-in
// account can access in that environment.
async function listAppsInEnvironment(environmentId) {
  const raw = await runJsonCommand(`ms app list --environment-id ${environmentId} --json`);
  const items = Array.isArray(raw.items) ? raw.items : [];

  return items.map((entry) => ({
    id: entry.appId,
    displayName: entry.displayName,
    playUrl: entry.appPlayUri,
    hasEditAccess: !!entry.hasEditAccess,
    lastDeployedTime: entry.lastDeployedTime || null,
    cloneUrl: entry.cloneUrl || null
  }));
}

module.exports = {
  listEnvironments,
  listAppsInEnvironment
};
