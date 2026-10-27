const fs = require("fs");
const path = require("path");

function readJson(filePath, fallbackValue) {
  if (!fs.existsSync(filePath)) {
    return fallbackValue;
  }

  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function getConfigDir() {
  return process.env.CONFIG_DIR || path.join(process.cwd(), "config");
}

function loadAppsConfig() {
  const filePath = path.join(getConfigDir(), "apps.json");
  const config = readJson(filePath, { apps: [] });

  if (!Array.isArray(config.apps)) {
    throw new Error("config/apps.json must contain an 'apps' array.");
  }

  return config;
}

function findAppById(appId) {
  const config = loadAppsConfig();
  return config.apps.find((app) => app.id === appId) || null;
}

function findAppEnvironment(app, targetEnv) {
  if (!app || !app.environments) {
    return null;
  }

  return app.environments[targetEnv] || null;
}

// Generic deploy behavior applied to any live-selected app/environment pair,
// since arbitrary managed apps discovered via the live CLI have no per-app
// entry in apps.json. Defaults to mock so the UI/flow can be exercised safely.
function loadDeployConfig() {
  const filePath = path.join(getConfigDir(), "deploy.json");
  const config = readJson(filePath, {
    mode: "mock",
    workspaceRoot: "",
    repoPath: "",
    steps: []
  });

  if (!["mock", "shell", "replicate"].includes(config.mode)) {
    throw new Error("config/deploy.json mode must be 'mock', 'shell', or 'replicate'.");
  }

  if (!Array.isArray(config.steps)) {
    throw new Error("config/deploy.json steps must be an array.");
  }

  return config;
}

module.exports = {
  loadAppsConfig,
  findAppById,
  findAppEnvironment,
  loadDeployConfig
};
