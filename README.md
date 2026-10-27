# Managed App Deployment Tool

A local web tool for replicating a Microsoft Copilot Managed Runtime app from one Power Platform environment to another — including its Dataverse solution and connector wiring — through a one-click UI backed by a small API + background worker.

- **Live data** — source/target environments and managed apps are pulled dynamically from your actual Power Platform tenant via the `pac` and `ms` CLIs, not hardcoded config.
- **One-click move flow** — pick a source environment, pick a managed app, pick a target environment, click **Deploy App**.
- **Requirements detection** — before moving, inspect what the app's `ms.config.json` actually needs (Dataverse tables, SharePoint/other connector connections) and let you choose a solution and/or connections to set up in the target.
- **Live progress** — the UI polls and streams the move's log in real time instead of leaving you guessing.
- **Mock mode by default** for the deploy step, so you can exercise the whole flow safely before enabling real moves.

## How it works (architecture)

```
Browser UI  -->  API (Express, :7071)  -->  requests.json (file-backed queue)
                                                     |
                                              Worker (polls every 5s)
                                                     |
                                   pac / ms CLIs  (clone, install, deploy)
```

- **API** (`src/api.js`) — serves the UI, exposes live environment/app lookups, requirements detection, and request management endpoints.
- **Worker** (`src/worker.js`) — polls for approved requests and executes the actual move (clone → install requirements → commit/push → deploy).
- **Store** (`data/requests.json`, `data/app-mappings.json`) — simple file-based persistence; no database required for this local tool.
- **Workspaces** — all git clones happen in `%LOCALAPPDATA%\managed-app-deployment-tool\workspaces`, deliberately **outside** any OneDrive/cloud-sync folder (see **Important environment constraint** below).

## 1) Prerequisites

| Requirement | Why | Verify |
|---|---|---|
| **Node.js 20+** | Runs the API and worker | `node --version` |
| **.NET SDK** | Required to install `pac` as a dotnet global tool | `dotnet --version` |
| **Git** | Required by `ms app clone`/`deploy` and by this tool's own commit/push logic | `git --version` |
| **Git Credential Manager**, configured (not just installed) | Authenticates git pushes to each app's platform-managed repo | see step below |
| **Managed Apps CLI (`ms`)** | Clones/deploys managed apps | `ms --version` |
| **Power Platform CLI (`pac`)** | Lists environments, lists/imports Dataverse solutions, lists connections | `pac --version` |

Install the CLIs if missing:

```powershell
npm install -g @microsoft/managed-apps-cli@latest
dotnet tool install --global Microsoft.PowerPlatform.CLI.Tool
```

**Configure Git Credential Manager** — this step is easy to miss and causes pushes to fail with "Authentication failed" if skipped:

```powershell
git credential-manager configure
```

## 2) Sign in (one-time, interactive)

Sign in with the **same account** that has access to both your source and target Power Platform environments:

```powershell
ms auth login
pac auth create --environment <any-environment-id-you-have-access-to>
```

> **Important:** Use the account intended for this tool's operations — not necessarily your default/personal account. If multiple accounts are signed in, make sure the one you want active is selected (`ms auth status`, `pac auth list` / `pac auth select`).

The required permission level in each target environment is effectively **System Administrator** (or an equivalent custom role), because the tool registers new apps, imports Dataverse solutions, and creates connections there.

## 3) Project setup

```powershell
git clone https://github.com/<you>/managed-app-deployment-tool.git
cd managed-app-deployment-tool
npm install
Copy-Item .\config\deploy.example.json .\config\deploy.json
Copy-Item .\config\apps.example.json .\config\apps.json
Copy-Item .\config\catalog.example.json .\config\catalog.json
```

In `config\deploy.json`, set the real deploy mode:

```json
{
  "mode": "replicate",
  "workspaceRoot": "",
  "repoPath": "",
  "steps": []
}
```

- `"mock"` (default if you skip this) — simulates the move with realistic log lines; nothing is actually created or changed in Power Platform. Good for a first smoke test.
- `"replicate"` — the real pipeline: clone the source app, register/reuse a target app, install the selected Dataverse solution (if any), wire selected connections, commit, push, and deploy.

## 4) Run it

Two long-running processes, in separate terminals:

```powershell
npm run start:api      # terminal 1 — serves the UI + API on http://localhost:7071
npm run start:worker   # terminal 2 — executes approved move requests
```

Open **http://localhost:7071/** in your browser.

## 5) Using the tool

1. **Sign in** — click "Sign in" (runs `ms auth login`), or "Check Sign-in" to see cached accounts.
2. **Pick a Source Environment** — populated live from `pac admin list`.
3. **Pick a Managed App** — populated live from `ms app list --environment-id <source>`, scoped to the environment you picked.
4. **Pick a Target Environment.**
5. **Click "Check Requirements"** — clones the source app and inspects its `ms.config.json` for connector/Dataverse requirements:
   - **Dataverse requirement**: lists every custom solution available in the source environment so you can pick which one to bring along (or skip, if the tables already exist in the target). This is a user choice, not an auto-guess — the tool cannot reliably infer which solution "owns" a given table from `ms.config.json` alone.
   - **Non-Dataverse requirement** (SharePoint, SQL, Office 365, etc.): no solution concept applies — just a checkbox for whether to wire up a connection in the target.
6. **Click "Deploy App"** — submits the move; the worker picks it up and the UI streams live progress.

### What actually happens during a move

1. Clone the source app's code (`ms app clone`), if not already cloned during the requirements check.
2. Check whether a target app for this (source app, target environment) pair already exists — via a locally cached mapping from a prior move, or by searching the target environment's apps by display name (`ms app list`). This avoids registering a duplicate app on repeat moves.
3. **If reusing an existing target app**: re-clone its working copy (`ms app clone`), and if its `ms.config.json` is missing/incomplete, reconstruct it from the app's live registration details (`ms app info`).
   **If no target app exists yet**: register a brand-new one (`ms app init --repo native`), then read back its generated app ID (`ms app info --json`).
4. Copy the source app's code into the target working copy.
5. If a Dataverse solution was selected and isn't already installed in the target (checked via `pac solution list`): export it (managed) from the source environment and import it (`pac solution export` / `pac solution import`). If the import command itself reports an error, re-check `pac solution list` directly before concluding it actually failed — a dropped connection can fail the CLI call while the import completes server-side anyway.
6. For each approved connection: confirm it doesn't already exist (`pac connection list`), then wire it up in the target app's working copy (`ms app add data-source ... --use-sso`), which updates `ms.config.json` and regenerates the typed service code.
7. Commit the result and push it. This isn't a plain `git commit`/`git push` — to avoid the git corruption and credential-loss failure modes described below, the tool re-clones a disposable scratch copy of the same app (`ms app clone`), swaps its healthy `.git` directory into the target working copy, creates a fresh orphan commit (`git checkout --orphan` → `git add -A` → `git commit`), and force-pushes it (`git push -f`) — replacing the app's git history each time rather than trying to merge.
8. `ms app deploy` builds and goes live in the target environment.

All `pac` calls are preceded by a one-time, cached check that a `pac` profile is already signed in (`pac auth list`) — the tool never creates new named profiles per environment, since that can hang indefinitely waiting on an invisible sign-in prompt.

## 6) Configuration reference

### `config/deploy.json`

```json
{
  "mode": "replicate",
  "workspaceRoot": "",
  "repoPath": "",
  "steps": []
}
```

- `mode`: `"mock"`, `"shell"` (run custom `steps` against `repoPath`), or `"replicate"` (the real pipeline described above).
- `workspaceRoot`: override where clone workspaces live (defaults to `%LOCALAPPDATA%\managed-app-deployment-tool\workspaces`).

## 7) API reference

| Endpoint | Purpose |
|---|---|
| `GET /live/environments` | Environments the signed-in account can access (live via `pac admin list`) |
| `GET /live/apps?environmentId=...` | Managed apps in that environment (live via `ms app list`) |
| `GET /requirements?sourceAppId=&sourceEnvironmentId=&targetEnvironmentId=` | Clone + inspect connector/Dataverse requirements, plus available solutions to pick from. Under the hood: `ms app clone`, `pac auth list`, `pac connection list` (per connector), and (only if a Dataverse table is involved) `pac solution list` against both source and target. |
| `GET /auth/status` / `POST /auth/login` | Wraps `ms auth status` / `ms auth login` |
| `POST /promote-now` | One-shot move: auto-creates and auto-approves a request for the worker to execute. The worker then runs the full replicate pipeline — `ms app clone`, `ms app list`, `ms app init`/`ms app info` (new app) or re-`ms app clone` (existing app), `pac solution export`/`import`, `ms app add data-source`, a scratch-clone + orphan-commit + force-push `git` sequence, and finally `ms app deploy`. See "What actually happens during a move" above for the full sequence. |
| `GET /requests` / `GET /requests/:id` | List/inspect move requests and their live logs |
| `POST /requests/:id/approve` \| `/reject` \| `/cancel` | Manual request lifecycle (used by the legacy config-driven flow) |

## 8) Important environment constraint: avoid OneDrive/cloud-sync folders

**Do not let the workspace clone directory live inside a OneDrive-, Dropbox-, or other cloud-sync-managed folder.** This tool deliberately defaults its git clone workspaces to `%LOCALAPPDATA%\managed-app-deployment-tool\workspaces` — a location outside any such sync folder — because of a real, repeatedly-confirmed failure mode:

OneDrive's sync engine converts freshly-written files into cloud placeholders (visible via the Windows `ReparsePoint` file attribute) while git is still writing its pack files. This produces git repos that pass an integrity check one moment and fail with `fatal: bad object HEAD` / `fatal: could not parse HEAD` the next, with no code change in between — and re-cloning into the same synced folder does not reliably fix it. Moving workspaces outside the sync folder removes the race entirely.

If you move this tool to a machine where your home/profile folder is itself cloud-synced, the `%LOCALAPPDATA%` path is usually safe by default — but double-check before changing `workspaceRoot` in `config/deploy.json`.

## 9) Known limitations / backlog

- **Single-operator, local tool today.** There is no multi-user auth model, and the API has no access control — it trusts whoever can reach `localhost:7071` on your machine. To share this with other people, either (a) have each person run their own local copy following this README, or (b) build a hosted multi-user version (API/worker on a shared server behind Entra auth) — not yet implemented.
- **Dataverse table creation without a solution** is not implemented. If an app needs Dataverse tables and you don't have (or don't want to use) a solution that contains them, the move will fail at the data-source wiring step. Creating tables directly via CLI/API instead of a solution is tracked as a future option.
- **Solution picker lists the source environment's custom solutions only** — it does not validate that your chosen solution actually contains the tables the app needs; check the solution's contents if you're unsure.
- **No automated tests.** Validate changes by running a move in mock mode, then a real move against a disposable/test environment pair.

## 10) Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `git push` fails with "Authentication failed" on a newly cloned app | Run `git credential-manager configure` once; make sure GCM is actually registered as the credential helper (`git config --global --get credential.helper`). |
| A move hangs indefinitely with no log output | A credential/sign-in prompt may be waiting invisibly. This tool forces `GCM_INTERACTIVE=always` and strips sandbox-only `GIT_TERMINAL_PROMPT=0` overrides to avoid this, but if it still happens, check for a hidden browser/device-code prompt. |
| `fatal: bad object HEAD` / `could not parse HEAD` | See the OneDrive/cloud-sync warning above — confirm `workspaceRoot` is not inside a synced folder. |
| Solution import errors with "connection forcibly closed" | Usually a transient network blip; the tool retries once automatically, and separately re-checks Dataverse directly (`pac solution list`) to see if the import actually succeeded despite the error before deciding it truly failed. Check the move's log for which happened. |
| `ms app clone`/`deploy` fails with "no common commits" or similar history conflict | Shouldn't occur in the current pipeline (it always starts target-app git history fresh via a scratch clone + orphan commit + force-push) — if you see this, you may be on an older version of this tool. |
