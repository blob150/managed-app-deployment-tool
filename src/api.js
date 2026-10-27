const express = require("express");
const path = require("path");
const { spawn } = require("child_process");
const {
  loadAppsConfig,
  loadSecurityConfig
} = require("./lib/config");
const {
  loadCatalogConfig
} = require("./lib/catalog");
const {
  listEnvironments,
  listAppsInEnvironment
} = require("./lib/live");
const { cloneSource, defaultWorkspaceRoot } = require("./lib/replicate");
const { buildRequirementsReport, listAvailableSolutions } = require("./lib/requirements");
const {
  ensureStore,
  listRequests,
  getRequestById,
  createRequest,
  updateRequest
} = require("./lib/store");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "web")));

const port = Number(process.env.API_PORT || 7071);
ensureStore();

function getApiKey(req) {
  return req.header("x-api-key") || "";
}

function checkApiKey(req, res, next, { readOnly = false } = {}) {
  const authorized = authorizeApiKey(req, res, { readOnly });
  if (!authorized) {
    return;
  }

  next();
}

function authorizeApiKey(req, res, { readOnly = false } = {}) {
  const security = loadSecurityConfig();
  const required = security.apiKey && (!readOnly || security.requireApiKeyForRead);

  if (!required) {
    return true;
  }

  if (getApiKey(req) !== security.apiKey) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }

  return true;
}

function normalizeIdentity(value) {
  return String(value || "").trim().toLowerCase();
}

function enforceActorAllowed(actor, role, security) {
  if (!security.enforceUserLists) {
    return;
  }

  const value = normalizeIdentity(actor);
  if (!value) {
    throw new Error(`${role} is required.`);
  }

  const list = role === "requester"
    ? security.requestersAllowList.map(normalizeIdentity)
    : security.approversAllowList.map(normalizeIdentity);

  if (!list.includes(value)) {
    throw new Error(`${role} '${actor}' is not allowed.`);
  }
}

function assertShortText(name, value, maxLength) {
  if (String(value || "").length > maxLength) {
    throw new Error(`${name} exceeds max length ${maxLength}.`);
  }
}

function runCommand(command, timeoutMs = 180000) {
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
      if (code === 0) {
        resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
        return;
      }

      reject(new Error(`Command failed (${code}): ${stderr.trim() || stdout.trim() || command}`));
    });
  });
}

app.get("/health", (_req, res) => {
  const config = loadAppsConfig();
  res.json({
    ok: true,
    configuredApps: config.apps.length
  });
});

app.get("/apps", (req, res) => {
  checkApiKey(req, res, () => {
    const config = loadAppsConfig();
    const apps = config.apps.map((entry) => ({
      id: entry.id,
      displayName: entry.displayName || entry.id,
      mode: entry.mode || "mock",
      environments: Object.keys(entry.environments || {})
    }));
    res.json({ apps });
  }, { readOnly: true });
});

app.get("/catalog", (req, res) => {
  checkApiKey(req, res, () => {
    const catalog = loadCatalogConfig();
    res.json({
      auth: catalog.auth || {},
      environments: catalog.environments,
      apps: catalog.apps,
      targetMappings: catalog.targetMappings
    });
  }, { readOnly: true });
});

app.get("/catalog/managed-apps", (req, res) => {
  checkApiKey(req, res, () => {
    const catalog = loadCatalogConfig();
    const sourceEnvironmentId = String(req.query.sourceEnvironmentId || "").trim();
    if (!sourceEnvironmentId) {
      res.status(400).json({ error: "sourceEnvironmentId is required." });
      return;
    }

    const apps = catalog.apps.filter((entry) => entry.environmentId === sourceEnvironmentId);
    res.json({ apps });
  }, { readOnly: true });
});

// Live endpoints: pull real environments and managed apps using the signed-in
// account's actual access, via the `pac` and `ms` CLIs.
app.get("/live/environments", async (req, res, next) => {
  if (!authorizeApiKey(req, res, { readOnly: true })) {
    return;
  }

  try {
    const environments = await listEnvironments();
    res.json({ environments });
  } catch (error) {
    next(error);
  }
});

app.get("/live/apps", async (req, res, next) => {
  if (!authorizeApiKey(req, res, { readOnly: true })) {
    return;
  }

  try {
    const environmentId = String(req.query.environmentId || "").trim();
    if (!environmentId) {
      res.status(400).json({ error: "environmentId is required." });
      return;
    }

    const apps = await listAppsInEnvironment(environmentId);
    res.json({ apps });
  } catch (error) {
    next(error);
  }
});

// Clones the selected source app and inspects its ms.config.json
// connectionReferences to report, per connector: required Dataverse tables,
// whether an owning solution is already installed in the target environment,
// and whether a usable connection already exists there. This is read-only
// against both environments (export happens into a local cache, nothing is
// imported) so it's safe to call repeatedly while the user is choosing.
app.get("/requirements", async (req, res, next) => {
  if (!authorizeApiKey(req, res, { readOnly: true })) {
    return;
  }

  try {
    const sourceAppId = String(req.query.sourceAppId || "").trim();
    const sourceEnvironmentId = String(req.query.sourceEnvironmentId || "").trim();
    const targetEnvironmentId = String(req.query.targetEnvironmentId || "").trim();

    if (!sourceAppId || !sourceEnvironmentId || !targetEnvironmentId) {
      res.status(400).json({ error: "sourceAppId, sourceEnvironmentId, and targetEnvironmentId are required." });
      return;
    }

    const root = defaultWorkspaceRoot();
    const logLines = [];
    const sourceDir = await cloneSource(sourceAppId, root, (line) => logLines.push(line));

    const report = await buildRequirementsReport(sourceDir, sourceEnvironmentId, targetEnvironmentId);
    const needsDataverseSchema = report.some((entry) => entry.isDataverse && entry.tables.length > 0);
    const availableSolutions = needsDataverseSchema
      ? await listAvailableSolutions(sourceEnvironmentId, targetEnvironmentId)
      : [];

    res.json({ requirements: report, availableSolutions });
  } catch (error) {
    next(error);
  }
});

app.get("/auth/status", async (req, res, next) => {
  if (!authorizeApiKey(req, res, { readOnly: true })) {
    return;
  }

  try {
    const catalog = loadCatalogConfig();
    if (!catalog.auth || !catalog.auth.enabled) {
      res.json({ enabled: false, message: "Auth command integration is disabled." });
      return;
    }

    const result = await runCommand(catalog.auth.statusCommand || "ms auth status");
    res.json({
      enabled: true,
      command: catalog.auth.statusCommand,
      output: result.stdout || result.stderr
    });
  } catch (error) {
    next(error);
  }
});

app.post("/auth/login", async (req, res, next) => {
  if (!authorizeApiKey(req, res)) {
    return;
  }

  try {
    const catalog = loadCatalogConfig();
    if (!catalog.auth || !catalog.auth.enabled) {
      res.status(400).json({ error: "Auth command integration is disabled." });
      return;
    }

    const result = await runCommand(catalog.auth.loginCommand || "ms auth login");
    res.json({
      ok: true,
      command: catalog.auth.loginCommand,
      output: result.stdout || result.stderr || "Login command completed."
    });
  } catch (error) {
    next(error);
  }
});

app.get("/requests", (req, res) => {
  checkApiKey(req, res, () => {
    const status = String(req.query.status || "").trim();
    const items = listRequests();
    const filtered = status ? items.filter((request) => request.status === status) : items;
    res.json({ requests: filtered });
  }, { readOnly: true });
});

app.get("/requests/:id", (req, res) => {
  checkApiKey(req, res, () => {
    const request = getRequestById(req.params.id);
    if (!request) {
      res.status(404).json({ error: "Request not found." });
      return;
    }
    res.json(request);
  }, { readOnly: true });
});

app.post("/requests", (req, res) => {
  checkApiKey(req, res, () => {
    const {
      sourceEnvironmentId = "",
      sourceEnvironmentName = "",
      sourceAppId = "",
      sourceAppName = "",
      targetEnvironmentId = "",
      targetEnvironmentName = "",
      sourceRef = "",
      requestedBy = "",
      notes = ""
    } = req.body || {};
    const security = loadSecurityConfig();

    if (!requestedBy) {
      res.status(400).json({ error: "requestedBy is required." });
      return;
    }

    if (!sourceEnvironmentId || !sourceAppId || !targetEnvironmentId) {
      res.status(400).json({
        error: "sourceEnvironmentId, sourceAppId, and targetEnvironmentId are required."
      });
      return;
    }

    enforceActorAllowed(requestedBy, "requester", security);
    assertShortText("sourceRef", sourceRef, 256);
    assertShortText("notes", notes, 2000);

    const request = createRequest({
      sourceEnvironmentId,
      sourceEnvironmentName: sourceEnvironmentName || sourceEnvironmentId,
      sourceAppId,
      sourceAppName: sourceAppName || sourceAppId,
      targetEnvironmentId,
      targetEnvironmentName: targetEnvironmentName || targetEnvironmentId,
      sourceRef,
      requestedBy,
      notes,
      approvedBy: null,
      startedAt: null,
      completedAt: null,
      outcome: null
    });

    res.status(201).json(request);
  });
});

app.post("/promote-now", (req, res) => {
  checkApiKey(req, res, () => {
    const {
      sourceEnvironmentId = "",
      sourceEnvironmentName = "",
      sourceAppId = "",
      sourceAppName = "",
      targetEnvironmentId = "",
      targetEnvironmentName = "",
      sourceRef = "",
      notes = "",
      requestedBy = "interactive-user",
      requirementsReport = null,
      requirementSelections = [],
      selectedSolutionUniqueName = ""
    } = req.body || {};

    const security = loadSecurityConfig();

    if (!sourceEnvironmentId || !sourceAppId || !targetEnvironmentId) {
      res.status(400).json({
        error: "sourceEnvironmentId, sourceAppId, and targetEnvironmentId are required."
      });
      return;
    }

    enforceActorAllowed(requestedBy, "requester", security);
    enforceActorAllowed(requestedBy, "approver", security);
    assertShortText("sourceRef", sourceRef, 256);
    assertShortText("notes", notes, 2000);

    // Picking a solution is optional, not required: the user may skip it if
    // the target's Dataverse tables already exist some other way, or just to
    // test the connection step. If they skip it and the tables genuinely
    // don't exist, the data-source wiring step fails with its own real error
    // during the move instead of being blocked here up front.
    const selectedSolution = selectedSolutionUniqueName
      ? { uniqueName: selectedSolutionUniqueName, sourceEnvironmentId, cacheRoot: path.join(defaultWorkspaceRoot(), "requirements-cache") }
      : null;

    const request = createRequest({
      sourceEnvironmentId,
      sourceEnvironmentName: sourceEnvironmentName || sourceEnvironmentId,
      sourceAppId,
      sourceAppName: sourceAppName || sourceAppId,
      targetEnvironmentId,
      targetEnvironmentName: targetEnvironmentName || targetEnvironmentId,
      sourceRef,
      requestedBy,
      notes,
      requirementsReport,
      requirementSelections,
      selectedSolution,
      approvedBy: requestedBy,
      startedAt: null,
      completedAt: null,
      outcome: null
    });

    const approved = updateRequest(request.id, {
      status: "approved"
    });

    res.status(201).json({
      ...approved,
      message: "Promotion request submitted and auto-approved."
    });
  });
});

app.post("/requests/:id/approve", (req, res) => {
  checkApiKey(req, res, () => {
    const { approvedBy = "" } = req.body || {};
    const security = loadSecurityConfig();
    if (!approvedBy) {
      res.status(400).json({ error: "approvedBy is required." });
      return;
    }

    enforceActorAllowed(approvedBy, "approver", security);

    const updated = updateRequest(req.params.id, (request) => {
      if (request.status !== "requested") {
        throw new Error("Only requests in 'requested' status can be approved.");
      }

      return {
        ...request,
        status: "approved",
        approvedBy
      };
    });

    if (!updated) {
      res.status(404).json({ error: "Request not found." });
      return;
    }

    res.json(updated);
  });
});

app.post("/requests/:id/reject", (req, res) => {
  checkApiKey(req, res, () => {
    const { rejectedBy = "", reason = "" } = req.body || {};
    const security = loadSecurityConfig();
    if (!rejectedBy) {
      res.status(400).json({ error: "rejectedBy is required." });
      return;
    }

    enforceActorAllowed(rejectedBy, "approver", security);
    assertShortText("reason", reason, 2000);

    const updated = updateRequest(req.params.id, (request) => {
      if (request.status !== "requested") {
        throw new Error("Only requests in 'requested' status can be rejected.");
      }

      return {
        ...request,
        status: "rejected",
        outcome: reason || "Rejected."
      };
    });

    if (!updated) {
      res.status(404).json({ error: "Request not found." });
      return;
    }

    res.json(updated);
  });
});

app.post("/requests/:id/cancel", (req, res) => {
  checkApiKey(req, res, () => {
    const { cancelledBy = "", reason = "" } = req.body || {};
    const security = loadSecurityConfig();
    if (!cancelledBy) {
      res.status(400).json({ error: "cancelledBy is required." });
      return;
    }

    enforceActorAllowed(cancelledBy, "requester", security);
    assertShortText("reason", reason, 2000);

    const updated = updateRequest(req.params.id, (request) => {
      if (!["requested", "approved"].includes(request.status)) {
        throw new Error("Only requests in 'requested' or 'approved' status can be cancelled.");
      }

      return {
        ...request,
        status: "cancelled",
        outcome: reason || "Cancelled."
      };
    });

    if (!updated) {
      res.status(404).json({ error: "Request not found." });
      return;
    }

    res.json(updated);
  });
});

app.use((error, _req, res, _next) => {
  res.status(400).json({ error: error.message || "Unexpected error." });
});

app.listen(port, () => {
  process.stdout.write(`API listening on http://localhost:${port}\n`);
});
