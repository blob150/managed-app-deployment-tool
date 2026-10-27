const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const dataDir = path.join(process.cwd(), "data");
const requestsPath = path.join(dataDir, "requests.json");

function ensureStore() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  if (!fs.existsSync(requestsPath)) {
    fs.writeFileSync(requestsPath, "[]", "utf8");
  }
}

function readRequests() {
  ensureStore();
  const raw = fs.readFileSync(requestsPath, "utf8");
  return JSON.parse(raw);
}

function writeRequests(requests) {
  ensureStore();
  fs.writeFileSync(requestsPath, JSON.stringify(requests, null, 2), "utf8");
}

function listRequests() {
  return readRequests()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function getRequestById(id) {
  return readRequests().find((request) => request.id === id) || null;
}

function createRequest(payload) {
  const requests = readRequests();
  const now = new Date().toISOString();

  const request = {
    id: crypto.randomUUID(),
    status: "requested",
    createdAt: now,
    updatedAt: now,
    logs: [],
    ...payload
  };

  requests.push(request);
  writeRequests(requests);
  return request;
}

function updateRequest(id, updater) {
  const requests = readRequests();
  const index = requests.findIndex((request) => request.id === id);

  if (index < 0) {
    return null;
  }

  const current = requests[index];
  const next = typeof updater === "function" ? updater(current) : { ...current, ...updater };
  next.updatedAt = new Date().toISOString();
  requests[index] = next;

  writeRequests(requests);
  return next;
}

function appendLog(id, line) {
  return updateRequest(id, (request) => ({
    ...request,
    logs: [...request.logs, `[${new Date().toISOString()}] ${line}`]
  }));
}

module.exports = {
  ensureStore,
  listRequests,
  getRequestById,
  createRequest,
  updateRequest,
  appendLog
};

