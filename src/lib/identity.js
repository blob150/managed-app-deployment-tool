const { execFileSync } = require("child_process");

// Identity management: lists the accounts already cached in `ms`/`pac` and
// lets the UI pick one to use. This replaces guessing/inheriting whatever
// happened to be globally active on the machine (which drifted silently
// and caused confusing cross-tenant errors in practice) with an explicit,
// visible choice the user makes once per session — the same way any normal
// app shows you which account you're signed in as and lets you switch.
//
// Key fact this relies on: `pac` commands that pass an explicit
// --environment <id> still authenticate using whichever profile is
// currently ACTIVE — the profile's bound environment is just its default,
// not an access restriction. So to "use account X for pac", we only need
// to activate any one cached profile belonging to X; which specific
// environment that profile defaults to doesn't matter.

function run(command) {
  return execFileSync(command, { shell: true, encoding: "utf8" });
}

function tryRun(command) {
  try {
    return { ok: true, output: run(command) };
  } catch (error) {
    return { ok: false, output: (error.stdout || "") + (error.stderr || ""), error };
  }
}

// Parses `ms auth status` text output into [{ email, active }].
function parseMsAccounts(output) {
  const lines = output.split("\n").map((line) => line.trimEnd());
  const headerIndex = lines.findIndex((line) => /Active\s+Username/.test(line));
  if (headerIndex < 0) {
    return [];
  }

  const accounts = [];
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) {
      continue;
    }
    const active = line.trim().startsWith("*");
    const withoutMarker = line.replace(/^\s*\*?\s*/, "");
    const match = withoutMarker.match(/^(\S+@\S+?)\s{2,}/);
    if (!match) {
      continue;
    }
    accounts.push({ email: match[1], active });
  }
  return accounts;
}

// Parses `pac auth list` text output into [{ index, active, name, user }],
// skipping the "OperatingSystem" row (not a usable Dataverse-signed-in user).
function parsePacProfiles(output) {
  const lines = output.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  const headerIndex = lines.findIndex((line) => /^Index\s+Active\s+Kind/.test(line));
  if (headerIndex < 0) {
    return [];
  }

  const profiles = [];
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    const indexMatch = line.match(/^\[(\d+)\]/);
    if (!indexMatch) {
      continue;
    }
    const active = /\]\s+\*/.test(line);
    const rest = line.replace(/^\[\d+\]\s*\*?\s*/, "");
    const tokens = rest.split(/\s+/).filter(Boolean);
    // tokens: Kind, [Name], User, Cloud, Type, Environment..., EnvironmentUrl
    const userTokenIndex = tokens.findIndex((token) => token.includes("@"));
    if (userTokenIndex < 0) {
      continue; // e.g. the OperatingSystem row with no signed-in user
    }
    // Skip Type=OperatingSystem rows: these use ambient OS/device identity
    // rather than a real interactive sign-in, and have no name/environment
    // binding — not a selectable "account" the UI should offer.
    if (tokens.includes("OperatingSystem")) {
      continue;
    }
    const name = tokens.slice(1, userTokenIndex).join(" ") || "";
    const user = tokens[userTokenIndex];
    profiles.push({ index: Number(indexMatch[1]), active, name, user });
  }
  return profiles;
}

// Merges ms's cached accounts with pac's cached profiles (grouped by user)
// into one list the UI can show: one row per distinct email, noting whether
// each CLI currently has it active and whether pac even has a usable
// profile for it at all (needed before it can be selected for pac).
function listIdentities() {
  const msResult = tryRun("ms auth status");
  const pacResult = tryRun("pac auth list");

  const msAccounts = msResult.ok ? parseMsAccounts(msResult.output) : [];
  const pacProfiles = pacResult.ok ? parsePacProfiles(pacResult.output) : [];

  const emails = new Set([
    ...msAccounts.map((a) => a.email.toLowerCase()),
    ...pacProfiles.map((p) => p.user.toLowerCase())
  ]);

  const identities = Array.from(emails).map((email) => {
    const msAccount = msAccounts.find((a) => a.email.toLowerCase() === email);
    const matchingPacProfiles = pacProfiles.filter((p) => p.user.toLowerCase() === email);
    const activePacProfile = matchingPacProfiles.find((p) => p.active);

    return {
      email: msAccount?.email || matchingPacProfiles[0]?.user,
      msActive: !!msAccount?.active,
      pacActive: !!activePacProfile,
      hasMsAccount: !!msAccount,
      hasPacProfile: matchingPacProfiles.length > 0,
      // Any one profile for this user works to activate pac for them.
      pacProfileNameToSelect: matchingPacProfiles[0]?.name
    };
  });

  identities.sort((a, b) => a.email.localeCompare(b.email));
  return identities;
}

// Activates the given account as the operating identity for BOTH CLIs.
// Requires the account to already be cached in both (no interactive sign-in
// here — that's a separate explicit "Sign in" action).
function selectIdentity(email) {
  const identities = listIdentities();
  const identity = identities.find((i) => i.email.toLowerCase() === email.toLowerCase());

  if (!identity) {
    throw new Error(`'${email}' is not a cached account. Sign in first.`);
  }

  const messages = [];

  if (identity.hasMsAccount) {
    run(`ms auth switch --account "${identity.email}" --non-interactive`);
    messages.push(`ms switched to ${identity.email}.`);
  } else {
    messages.push(`ms has no cached account for ${identity.email} — 'ms' commands will still use whatever was previously active there.`);
  }

  if (identity.hasPacProfile) {
    run(`pac auth select --name "${identity.pacProfileNameToSelect}"`);
    messages.push(`pac switched to ${identity.email} (profile '${identity.pacProfileNameToSelect}').`);
  } else {
    messages.push(`pac has no cached profile for ${identity.email} — run 'pac auth create --environment <any-id>' once, signed in as this account, then try again.`);
  }

  return { email: identity.email, messages };
}

module.exports = { listIdentities, selectIdentity };
