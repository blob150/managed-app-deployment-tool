const fs = require("fs");
const path = require("path");

const dataDir = path.join(process.cwd(), "data");
const mappingsPath = path.join(dataDir, "app-mappings.json");

function ensureStore() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  if (!fs.existsSync(mappingsPath)) {
    fs.writeFileSync(mappingsPath, "[]", "utf8");
  }
}

function readMappings() {
  ensureStore();
  const raw = fs.readFileSync(mappingsPath, "utf8");
  return JSON.parse(raw);
}

function writeMappings(mappings) {
  ensureStore();
  fs.writeFileSync(mappingsPath, JSON.stringify(mappings, null, 2), "utf8");
}

function keyFor(sourceAppId, targetEnvironmentId) {
  return `${sourceAppId}::${targetEnvironmentId}`;
}

// Tracks, for a given (sourceAppId, targetEnvironmentId) pair, the app we
// already created in the target environment and the local working directory
// bound to it. This lets repeat moves update the SAME target app instead of
// creating a new one every time.
function findMapping(sourceAppId, targetEnvironmentId) {
  const mappings = readMappings();
  return mappings.find((entry) => entry.key === keyFor(sourceAppId, targetEnvironmentId)) || null;
}

function saveMapping({ sourceAppId, sourceAppName, targetEnvironmentId, targetAppId, targetAppName, workDir }) {
  const mappings = readMappings();
  const key = keyFor(sourceAppId, targetEnvironmentId);
  const existingIndex = mappings.findIndex((entry) => entry.key === key);

  const record = {
    key,
    sourceAppId,
    sourceAppName,
    targetEnvironmentId,
    targetAppId,
    targetAppName,
    workDir,
    updatedAt: new Date().toISOString()
  };

  if (existingIndex >= 0) {
    mappings[existingIndex] = { ...mappings[existingIndex], ...record };
  } else {
    mappings.push({ ...record, createdAt: record.updatedAt });
  }

  writeMappings(mappings);
  return record;
}

module.exports = {
  findMapping,
  saveMapping
};
