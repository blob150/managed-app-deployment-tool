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

function loadCatalogConfig() {
  const filePath = path.join(getConfigDir(), "catalog.json");
  const config = readJson(filePath, {
    auth: {
      enabled: false,
      loginCommand: "ms auth login",
      statusCommand: "ms auth status"
    },
    environments: [],
    apps: [],
    targetMappings: []
  });

  if (!Array.isArray(config.environments)) {
    throw new Error("config/catalog.json environments must be an array.");
  }
  if (!Array.isArray(config.apps)) {
    throw new Error("config/catalog.json apps must be an array.");
  }
  if (!Array.isArray(config.targetMappings)) {
    throw new Error("config/catalog.json targetMappings must be an array.");
  }

  return config;
}

function resolveDeploymentTarget(catalog, sourceAppId, targetEnvironmentId) {
  return catalog.targetMappings.find(
    (item) => item.sourceAppId === sourceAppId && item.targetEnvironmentId === targetEnvironmentId
  ) || null;
}

module.exports = {
  loadCatalogConfig,
  resolveDeploymentTarget
};

