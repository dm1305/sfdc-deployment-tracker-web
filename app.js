// SFDC Deployment Tracker (Web)
// - OAuth (Auth Code + PKCE) -> stores token in localStorage
// - Deployments table (Tooling DeployRequest) + polling + durations
// - On-click details fetch (extra DeployRequest fields if available) + heuristics
// - Apex tests tab (Tooling ApexTestRun) + heuristic correlation to selected deployment
// - Insights panel (basic duration stats + failure taxonomy)
// NOTE: Tooling object field availability varies by org/API version. We dynamically DESCRIBE
//       DeployRequest and ApexTestRun to select only fields that exist.

// ====== CONFIG (edit these) ======
const CLIENT_ID = "3MVG9YFqzc_KnL.wada6.pbgp4zDPc8T6u6uR6srOVo1fS7XOD_kHsrDH_QurZzXeEgwzWBU365_xXQ54mMNn";
const LOGIN_DOMAIN = "https://gearsetcom-4bf-dev-ed.develop.my.salesforce.com"; // e.g. https://example--dev.sandbox.my.salesforce.com
// =================================

// Storage keys
const TOKEN_KEY = "sf_token";

// Pick an API version you know exists for your org (from /services/data).
// If you want, set to the latest from your /services/data output.
const API_VERSION = "65.0";

// Polling timer
let pollTimer = null;

// Cached describes
let deployRequestDescribe = null;
let apexTestRunDescribe = null;

// Selected deployment record (from the table)
let selectedDeployment = null;

// Cache of latest fetched test runs (for correlation)
let cachedTestRuns = [];

/* -------------------- UI helpers -------------------- */

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setHtml(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

function setStateBadge(text) {
  setText("stateBadge", text);
}

function log(msg) {
  const el = document.getElementById("logPre") || document.getElementById("status");
  if (!el) return;
  const stamp = new Date().toISOString();
  el.textContent = `[${stamp}] ${msg}\n` + el.textContent;
}

function setSelected(payload) {
  const el = document.getElementById("selectedPre");
  if (el) el.textContent = payload;
}

function wireClick(id, handler) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("click", handler);
}

function wireChange(id, handler) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("change", handler);
}

function wireInput(id, handler, debounceMs = 150) {
  const el = document.getElementById(id);
  if (!el) return;
  let t = null;
  el.addEventListener("input", () => {
    if (t) clearTimeout(t);
    t = setTimeout(handler, debounceMs);
  });
}

/* -------------------- Storage helpers -------------------- */

function saveToken(token) {
  localStorage.setItem(TOKEN_KEY, JSON.stringify(token));
}

function loadToken() {
  const raw = localStorage.getItem(TOKEN_KEY);
  return raw ? JSON.parse(raw) : null;
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

function clearSessionState() {
  sessionStorage.removeItem("pkce_verifier");
  sessionStorage.removeItem("oauth_state");
}

function redactTokenForDisplay(token) {
  if (!token) return token;
  const copy = { ...token };
  if (copy.access_token) copy.access_token = "(redacted)";
  if (copy.refresh_token) copy.refresh_token = "(redacted)";
  if (copy.id_token) copy.id_token = "(redacted)";
  return copy;
}

/* -------------------- PKCE helpers -------------------- */

function base64UrlEncode(bytes) {
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Base64Url(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(digest));
}

function randomString(length = 64) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

function getRedirectUri() {
  // GitHub Pages URL (same origin + path)
  return window.location.origin + window.location.pathname;
}

/* -------------------- OAuth -------------------- */

async function login() {
  if (!CLIENT_ID || CLIENT_ID.includes("PASTE_")) {
    alert("Set CLIENT_ID in app.js first.");
    return;
  }

  const redirectUri = getRedirectUri();

  // PKCE
  const codeVerifier = randomString(96);
  const codeChallenge = await sha256Base64Url(codeVerifier);
  sessionStorage.setItem("pkce_verifier", codeVerifier);

  const state = randomString(24);
  sessionStorage.setItem("oauth_state", state);

  const authUrl = new URL(`${LOGIN_DOMAIN}/services/oauth2/authorize`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", "refresh_token full");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  window.location.href = authUrl.toString();
}

async function handleRedirectIfPresent() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDesc = url.searchParams.get("error_description");

  if (error) {
    setStateBadge("Error");
    setSelected(`OAuth error: ${error}${errorDesc ? " - " + errorDesc : ""}`);
    return;
  }

  if (!code) return; // not returning from OAuth

  const expectedState = sessionStorage.getItem("oauth_state");
  if (!expectedState || state !== expectedState) {
    setStateBadge("Error");
    setSelected("State mismatch. Aborting.");
    return;
  }

  const verifier = sessionStorage.getItem("pkce_verifier");
  if (!verifier) {
    setStateBadge("Error");
    setSelected("Missing PKCE verifier. Aborting.");
    return;
  }

  // Clean URL (remove code/state from address bar)
  url.searchParams.delete("code");
  url.searchParams.delete("state");
  window.history.replaceState({}, document.title, url.toString());

  // Exchange code for token
  const tokenUrl = `${LOGIN_DOMAIN}/services/oauth2/token`;
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("client_id", CLIENT_ID);
  body.set("redirect_uri", getRedirectUri());
  body.set("code", code);
  body.set("code_verifier", verifier);

  setStateBadge("Auth");
  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const json = await resp.json().catch(() => null);
  if (!resp.ok) {
    setStateBadge("Error");
    setSelected(`Token exchange failed: ${json?.error_description || json?.error || resp.status}`);
    return;
  }

  saveToken(json);

  // Update pills
  setText("orgPill", `Org: ${json.instance_url || "Connected"}`);
  setText("apiPill", `API: v${API_VERSION}`);

  // Build pill = hash of this file (approx, from script tag URL + runtime)
  setBuildPill();

  // Don’t print secrets by default
  const safe = redactTokenForDisplay(json);
  log("Session restored / token stored in localStorage.");
  setSelected("Logged in ✅\n" + JSON.stringify(safe, null, 2));

  setStateBadge("Ready");
}

async function logout() {
  clearToken();
  clearSessionState();
  stopPolling();
  selectedDeployment = null;
  cachedTestRuns = [];
  setText("orgPill", "Org: Not connected");
  setText("apiPill", "API: —");
  setText("selectedDeployId", "—");
  setSelected("Nothing selected.");
  log("Logged out.");
  setStateBadge("Idle");
}

/* -------------------- REST helpers -------------------- */

function requireToken() {
  const token = loadToken();
  if (!token?.access_token || !token?.instance_url) {
    setStateBadge("Auth");
    setSelected("Not logged in. Click Login first.");
    return null;
  }
  return token;
}

async function sfFetch(path, { tooling = false, method = "GET", headers = {}, body = null } = {}) {
  const token = requireToken();
  if (!token) return { ok: false, status: 0, json: null };

  const base = tooling
    ? `${token.instance_url}/services/data/v${API_VERSION}/tooling`
    : `${token.instance_url}/services/data/v${API_VERSION}`;

  const url = `${base}${path}`;
  setText("lastRequestLabel", `Last request: ${new Date().toISOString()}`);

  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      ...headers,
    },
    body,
  });

  const json = await resp.json().catch(() => null);
  return { ok: resp.ok, status: resp.status, json };
}

/* -------------------- Describe helpers (field discovery) -------------------- */

function fieldsSetFromDescribe(describeJson) {
  const set = new Set();
  for (const f of (describeJson?.fields || [])) {
    if (f?.name) set.add(f.name);
  }
  return set;
}

async function getToolingDescribe(objectName) {
  const { ok, status, json } = await sfFetch(`/sobjects/${encodeURIComponent(objectName)}/describe`, { tooling: true });
  if (!ok) {
    log(`Describe failed for ${objectName} (HTTP ${status}): ${json?.[0]?.message || json?.message || "Unknown error"}`);
    return null;
  }
  return json;
}

async function ensureDescribes() {
  if (!deployRequestDescribe) deployRequestDescribe = await getToolingDescribe("DeployRequest");
  if (!apexTestRunDescribe) apexTestRunDescribe = await getToolingDescribe("ApexTestRun");
}

/* -------------------- Time formatting -------------------- */

function parseDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}

function fmtTime(d) {
  if (!d) return "—";
  // compact ISO
  return d.toISOString().replace("T", " ").replace("Z", "Z");
}

function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}h ${m}m ${s}s`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

/* -------------------- Tabs / panels -------------------- */

function setPanelVisible(id, isVisible) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = isVisible ? "" : "none";
}

function setActiveTab(tabId) {
  for (const id of ["tabDeployments", "tabApexTests", "tabPackages", "tabPackageHistory", "tabDeployDetails"]) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("active", id === tabId);
  }
}

function showTab(tab) {
  setActiveTab(
    tab === "deployments" ? "tabDeployments" :
    tab === "tests" ? "tabApexTests" :
    tab === "packages" ? "tabPackages" :
    tab === "history" ? "tabPackageHistory" :
    "tabDeployDetails"
  );

  setPanelVisible("deploymentsControls", tab === "deployments");
  setPanelVisible("apexTestsControls", tab === "tests");
  setPanelVisible("packagesControls", tab === "packages");
  setPanelVisible("packageHistoryControls", tab === "history");
  setPanelVisible("deployDetailsControls", tab === "details");

  setPanelVisible("deploymentsPanel", tab === "deployments");
  setPanelVisible("apexTestsPanel", tab === "tests");
  setPanelVisible("packagesPanel", tab === "packages");
  setPanelVisible("packageHistoryPanel", tab === "history");
  setPanelVisible("deployDetailsPanel", tab === "details");
}

/* -------------------- Step A: Deployments + details fetch -------------------- */

function statusClass(status) {
  const s = String(status || "").toLowerCase();
  if (["succeeded", "success", "completed"].some((k) => s.includes(k))) return "good";
  if (["failed", "error"].some((k) => s.includes(k))) return "bad";
  if (["inprogress", "in progress", "queued", "pending", "validat", "running", "processing"].some((k) => s.includes(k)))
    return "warn";
  return "";
}

function passesDeployFilter(r) {
  const filter = document.getElementById("deployFilter")?.value || "all";
  const status = String(r.Status || "");
  const checkOnly = !!r.CheckOnly;

  if (filter === "active") {
    const active = ["InProgress", "Pending", "Queued", "Processing", "Running", "Validating"];
    return active.includes(status);
  }
  if (filter === "failed") return status.toLowerCase().includes("fail") || status.toLowerCase().includes("error");
  if (filter === "checkonly") return checkOnly;
  if (filter === "real") return !checkOnly;
  return true;
}

function passesDeploySearch(r) {
  const q = (document.getElementById("deploySearch")?.value || "").trim().toLowerCase();
  if (!q) return true;
  const blob = [r.Status, r.Type, r.CreatedBy?.Name, r.ErrorStatusCode, r.ErrorMessage, r.Id]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return blob.includes(q);
}

function pickBottleneck(queueMs, runMs) {
  if (queueMs == null && runMs == null) return "—";
  if (queueMs == null) return "Run";
  if (runMs == null) return "Queue";
  if (queueMs > runMs) return "Queue";
  if (runMs > queueMs) return "Run";
  return "Even";
}

function summarizeTestsForRow(corr) {
  if (!corr) return "—";
  const { count, failed, durationMs } = corr;
  if (!count) return "—";
  const dur = durationMs != null ? fmtDuration(durationMs) : "—";
  const failTxt = failed ? ` / ${failed} fail` : "";
  return `${count} run${count === 1 ? "" : "s"}${failTxt} / ${dur}`;
}

function rowHtmlDeploy(r, corr) {
  const now = new Date();

  const created = parseDate(r.CreatedDate);
  const started = parseDate(r.StartDate) || created;
  const completed = parseDate(r.CompletedDate);

  const queueMs = created && started ? started - created : null;
  const runMs = started ? (completed ? completed - started : now - started) : null;
  const totalMs = created ? (completed ? completed - created : now - created) : null;

  const st = r.Status || "—";
  const stClass = statusClass(st);
  const type = r.Type || "—";
  const user = r.CreatedBy?.Name || "—";
  const bottleneck = pickBottleneck(queueMs, runMs);

  const testsSummary = summarizeTestsForRow(corr);

  return `
    <tr data-deploy-id="${r.Id}" style="cursor:pointer">
      <td class="status ${stClass}">${st}</td>
      <td>${user}</td>
      <td>${type}${r.CheckOnly ? ' <span class="muted">(checkOnly)</span>' : ""}</td>
      <td class="mono">${fmtTime(created)}</td>
      <td class="mono">${fmtTime(parseDate(r.StartDate))}</td>
      <td class="mono">${fmtTime(completed)}</td>
      <td class="mono">${fmtDuration(queueMs)}</td>
      <td class="mono">${fmtDuration(runMs)}</td>
      <td class="mono">${fmtDuration(totalMs)}</td>
      <td class="mono">${testsSummary}</td>
      <td>${bottleneck}</td>
      <td class="mono">${r.Id}</td>
    </tr>
  `.trim();
}

function safeSoqlFieldList(describe, desiredFields) {
  const set = fieldsSetFromDescribe(describe);
  return desiredFields.filter((f) => set.has(f));
}

async function fetchDeployments() {
  setStateBadge("Loading");
  await ensureDescribes();

  const limit = Number(document.getElementById("deployLimit")?.value || 20);

  // Base fields that we know are commonly present
  const baseFields = [
    "Id", "Status", "Type", "CheckOnly",
    "CreatedDate", "StartDate", "CompletedDate",
    "CreatedBy.Name",
    "ErrorStatusCode", "ErrorMessage"
  ];

  // Extra fields we might want if the org exposes them
  const extraFields = [
    "NumberComponentsTotal",
    "NumberComponentsDeployed",
    "NumberComponentErrors",
    "NumberTestsTotal",
    "NumberTestsCompleted",
    "NumberTestErrors",
    "RunTestsEnabled",
    "CancelDate",
    "IgnoreWarnings",
    "RollbackOnError",
    "TestLevel",
    "Failed", // some orgs
    "Success" // some orgs
  ];

  const fields = [...baseFields, ...safeSoqlFieldList(deployRequestDescribe, extraFields)];

  const soql = `
    SELECT ${fields.join(", ")}
    FROM DeployRequest
    ORDER BY CreatedDate DESC
    LIMIT ${limit}
  `.trim();

  const { ok, status, json } = await sfFetch(`/query?q=${encodeURIComponent(soql)}`, { tooling: true });

  if (!ok) {
    setStateBadge("Error");
    log(`DeployRequest query failed (HTTP ${status}): ${json?.[0]?.message || json?.message || "Unknown error"}`);
    setSelected(`DeployRequest query failed: ${json?.[0]?.message || json?.message || status}`);
    return;
  }

  const recs = json?.records || [];
  const filtered = recs.filter(passesDeployFilter).filter(passesDeploySearch);

  // If we have test runs cached, compute correlation summary per deployment
  const corrMap = correlateTestsToDeployments(filtered, cachedTestRuns);

  const tbody = document.getElementById("deploymentsTbody");
  if (!tbody) return;

  setText("resultsBadge", `${filtered.length} rows`);
  setText("lastRefreshedLabel", `Last refreshed: ${new Date().toISOString()}`);

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td class="muted small" colspan="12">No deployments match the current filter.</td></tr>`;
    setStateBadge("Ready");
    updateInsights(filtered);
    return;
  }

  tbody.innerHTML = filtered.map((r) => rowHtmlDeploy(r, corrMap.get(r.Id))).join("\n");

  // Row click selection
  tbody.querySelectorAll("tr[data-deploy-id]").forEach((tr) => {
    tr.addEventListener("click", async () => {
      const id = tr.getAttribute("data-deploy-id");
      const rec = filtered.find((x) => x.Id === id);
      if (!rec) return;
      await selectDeployment(rec);
    });
  });

  log(`Loaded ${filtered.length} deployments.`);
  setStateBadge("Ready");

  updateInsights(filtered);
}

async function selectDeployment(rec) {
  selectedDeployment = rec;
  setText("selectedDeployId", rec.Id);
  setSelected(JSON.stringify({
    Id: rec.Id,
    Status: rec.Status,
    Type: rec.Type,
    CheckOnly: rec.CheckOnly,
    CreatedBy: rec.CreatedBy?.Name,
    CreatedDate: rec.CreatedDate,
    StartDate: rec.StartDate,
    CompletedDate: rec.CompletedDate
  }, null, 2));

  // Show details tab content in-place (without forcing tab switch)
  await fetchSelectedDeploymentDetails();

  // Also refresh correlated tests note
  updateCorrelationNote();
}

async function fetchSelectedDeploymentDetails() {
  if (!selectedDeployment?.Id) {
    setText("deployDetailsPre", "Select a deployment first.");
    return;
  }

  setStateBadge("Loading");
  await ensureDescribes();

  // Re-query the selected deploy with as many useful fields as possible
  const desired = [
    "Id", "Status", "Type", "CheckOnly",
    "CreatedDate", "StartDate", "CompletedDate",
    "CreatedBy.Name", "LastModifiedDate",
    "ErrorStatusCode", "ErrorMessage",
    "NumberComponentsTotal", "NumberComponentsDeployed", "NumberComponentErrors",
    "NumberTestsTotal", "NumberTestsCompleted", "NumberTestErrors",
    "RunTestsEnabled", "TestLevel",
    "IgnoreWarnings", "RollbackOnError"
  ];

  const fields = safeSoqlFieldList(deployRequestDescribe, desired)
    // keep relationship field even if describe doesn't list it consistently
    .concat(desired.includes("CreatedBy.Name") ? ["CreatedBy.Name"] : []);

  // Deduplicate
  const uniq = [];
  for (const f of fields) if (!uniq.includes(f)) uniq.push(f);

  const soql = `
    SELECT ${uniq.join(", ")}
    FROM DeployRequest
    WHERE Id = '${selectedDeployment.Id}'
    LIMIT 1
  `.trim();

  const { ok, status, json } = await sfFetch(`/query?q=${encodeURIComponent(soql)}`, { tooling: true });
  if (!ok) {
    setStateBadge("Error");
    log(`Deploy details query failed (HTTP ${status}): ${json?.[0]?.message || json?.message || "Unknown error"}`);
    setText("deployDetailsPre", `Failed to fetch details: ${json?.[0]?.message || json?.message || status}`);
    return;
  }

  const full = (json?.records || [])[0] || selectedDeployment;

  // KPIs
  const created = parseDate(full.CreatedDate);
  const started = parseDate(full.StartDate) || created;
  const completed = parseDate(full.CompletedDate);
  const now = new Date();
  const queueMs = created && started ? started - created : null;
  const runMs = started ? (completed ? completed - started : now - started) : null;
  const totalMs = created ? (completed ? completed - created : now - created) : null;
  const bottleneck = pickBottleneck(queueMs, runMs);

  const compTotal = full.NumberComponentsTotal ?? null;
  const compDeployed = full.NumberComponentsDeployed ?? null;
  const compErr = full.NumberComponentErrors ?? null;

  const testsTotal = full.NumberTestsTotal ?? null;
  const testsDone = full.NumberTestsCompleted ?? null;
  const testsErr = full.NumberTestErrors ?? null;

  const delayCategory = classifyDelay(full, queueMs, runMs);
  const failureCategory = classifyFailure(full);

  const kpis = [
    { label: "Bottleneck", value: bottleneck },
    { label: "Delay category", value: delayCategory },
    { label: "Failure category", value: failureCategory },
    { label: "Queue", value: fmtDuration(queueMs) },
    { label: "Run", value: fmtDuration(runMs) },
    { label: "Total", value: fmtDuration(totalMs) },
    { label: "Components", value: compTotal != null ? `${compDeployed ?? "—"}/${compTotal} (${compErr ?? 0} err)` : "—" },
    { label: "Tests", value: testsTotal != null ? `${testsDone ?? "—"}/${testsTotal} (${testsErr ?? 0} err)` : "—" },
  ];

  setHtml("detailsKpis", kpis.map(k => `
    <div class="chip" title="${k.label}">
      <div class="label">${k.label}</div>
      <div class="value">${escapeHtml(String(k.value))}</div>
    </div>
  `).join(""));

  // Correlated test runs for this deployment
  const corr = correlateTestsToDeployment(selectedDeployment, cachedTestRuns);
  const corrSummary = corr?.count ? {
    correlatedTestRuns: corr.count,
    correlatedFailedRuns: corr.failed,
    correlatedDuration: fmtDuration(corr.durationMs),
    note: "Heuristic match (time window overlap / near start)."
  } : { correlatedTestRuns: 0, note: "No correlated test runs in current Apex tests cache. Refresh Apex tests tab if needed." };

  const payload = {
    Deployment: sanitizeRecordForDisplay(full),
    Derived: {
      queueMs, runMs, totalMs,
      bottleneck,
      delayCategory,
      failureCategory
    },
    CorrelatedTests: corrSummary
  };

  setText("deployDetailsPre", JSON.stringify(payload, null, 2));
  log(`Details loaded for ${selectedDeployment.Id}.`);
  setStateBadge("Ready");
}

/* -------------------- Step B: Apex tests tab + correlation -------------------- */

async function fetchApexTests() {
  setStateBadge("Loading");
  await ensureDescribes();

  const limit = Number(document.getElementById("testsLimit")?.value || 20);

  const baseFields = ["Id", "Status", "TestRunResult", "StartTime", "EndTime", "UserId", "CreatedDate"];
  const extraFields = [
    "ClassesCompleted", "ClassesFailed", "MethodsCompleted", "MethodsFailed",
    "Failures", "TotalTime", "ApexExecutionTime"
  ];

  const fields = [...baseFields, ...safeSoqlFieldList(apexTestRunDescribe, extraFields)];
  const soql = `
    SELECT ${fields.join(", ")}
    FROM ApexTestRun
    ORDER BY StartTime DESC
    LIMIT ${limit}
  `.trim();

  const { ok, status, json } = await sfFetch(`/query?q=${encodeURIComponent(soql)}`, { tooling: true });
  if (!ok) {
    setStateBadge("Error");
    log(`ApexTestRun query failed (HTTP ${status}): ${json?.[0]?.message || json?.message || "Unknown error"}`);
    setHtml("apexTestsTbody", `<tr><td class="muted small" colspan="9">Failed to load tests.</td></tr>`);
    return;
  }

  const recs = json?.records || [];
  cachedTestRuns = recs;

  renderApexTests(recs);
  log(`Loaded ${recs.length} Apex test runs.`);
  setStateBadge("Ready");

  // Refresh deployments display so "Tests" column updates based on cached tests
  if (document.getElementById("tabDeployments")?.classList.contains("active")) {
    fetchDeployments().catch((e) => log(`Deployments refresh failed: ${e?.message || e}`));
  }
}

function passesTestsFilter(r) {
  const filter = document.getElementById("testsFilter")?.value || "all";
  const status = String(r.Status || "").toLowerCase();
  const outcome = String(r.TestRunResult || "").toLowerCase();

  if (filter === "failed") return status.includes("fail") || outcome.includes("fail") || (Number(r.ClassesFailed || 0) > 0);
  if (filter === "completed") return status.includes("complete") || outcome.includes("complete") || status === "completed";
  if (filter === "running") return status.includes("run") || status.includes("inprogress");
  return true;
}

function passesTestsSearch(r) {
  const q = (document.getElementById("testsSearch")?.value || "").trim().toLowerCase();
  if (!q) return true;
  const blob = [r.Status, r.TestRunResult, r.UserId, r.Id].filter(Boolean).join(" ").toLowerCase();
  return blob.includes(q);
}

function testRowHtml(r) {
  const start = parseDate(r.StartTime) || parseDate(r.CreatedDate);
  const end = parseDate(r.EndTime);
  const durMs = start ? ((end ? end : new Date()) - start) : null;

  const st = r.Status || "—";
  const stClass = statusClass(st);
  const outcome = r.TestRunResult || "—";

  const completed = [
    r.ClassesCompleted != null ? `C:${r.ClassesCompleted}` : null,
    r.MethodsCompleted != null ? `M:${r.MethodsCompleted}` : null
  ].filter(Boolean).join(" ");

  const failed = [
    r.ClassesFailed != null ? `C:${r.ClassesFailed}` : null,
    r.MethodsFailed != null ? `M:${r.MethodsFailed}` : null
  ].filter(Boolean).join(" ");

  return `
    <tr>
      <td class="status ${stClass}">${escapeHtml(st)}</td>
      <td>${escapeHtml(outcome)}</td>
      <td class="mono">${fmtTime(start)}</td>
      <td class="mono">${fmtTime(end)}</td>
      <td class="mono">${fmtDuration(durMs)}</td>
      <td class="mono">${escapeHtml(String(r.UserId || "—"))}</td>
      <td class="mono">${escapeHtml(completed || "—")}</td>
      <td class="mono">${escapeHtml(failed || "—")}</td>
      <td class="mono">${escapeHtml(r.Id || "—")}</td>
    </tr>
  `.trim();
}

function renderApexTests(recs) {
  const tbody = document.getElementById("apexTestsTbody");
  if (!tbody) return;

  const filtered = recs.filter(passesTestsFilter).filter(passesTestsSearch);

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td class="muted small" colspan="9">No test runs match your filters.</td></tr>`;
    return;
  }
  tbody.innerHTML = filtered.map(testRowHtml).join("\n");
  updateCorrelationNote();
}

function correlateTestsToDeployment(deploy, testRuns) {
  if (!deploy || !testRuns?.length) return null;

  const created = parseDate(deploy.CreatedDate);
  const started = parseDate(deploy.StartDate) || created;
  const completed = parseDate(deploy.CompletedDate);

  // If still running, consider window to now; else completed+5m to catch trailing tests
  const windowStart = started || created;
  const windowEnd = completed ? new Date(completed.getTime() + 5 * 60 * 1000) : new Date();

  // Extra grace: tests sometimes start a little after deployment start
  const graceStart = windowStart ? new Date(windowStart.getTime() - 2 * 60 * 1000) : null;

  const matches = [];
  for (const tr of testRuns) {
    const ts = parseDate(tr.StartTime) || parseDate(tr.CreatedDate);
    const te = parseDate(tr.EndTime) || (ts ? new Date(ts.getTime() + 1) : null);
    if (!ts || !te || !graceStart) continue;

    const overlap = (ts <= windowEnd) && (te >= graceStart);
    if (overlap) matches.push({ tr, ts, te });
  }

  if (!matches.length) return { count: 0, failed: 0, durationMs: 0, matches: [] };

  let failed = 0;
  let totalDuration = 0;
  for (const m of matches) {
    const st = String(m.tr.Status || "").toLowerCase();
    const out = String(m.tr.TestRunResult || "").toLowerCase();
    const classFailed = Number(m.tr.ClassesFailed || 0);
    if (st.includes("fail") || out.includes("fail") || classFailed > 0) failed += 1;

    totalDuration += (m.te - m.ts);
  }

  return { count: matches.length, failed, durationMs: totalDuration, matches };
}

function correlateTestsToDeployments(deployments, testRuns) {
  const map = new Map();
  for (const d of deployments || []) {
    map.set(d.Id, correlateTestsToDeployment(d, testRuns));
  }
  return map;
}

function updateCorrelationNote() {
  const el = document.getElementById("correlationNote");
  if (!el) return;

  if (!selectedDeployment) {
    el.textContent = "Correlation heuristic: select a deployment to see matched test runs.";
    return;
  }
  const corr = correlateTestsToDeployment(selectedDeployment, cachedTestRuns);
  if (!corr?.count) {
    el.textContent = "Correlation heuristic: no matched test runs for the selected deployment (in current cache).";
    return;
  }
  el.textContent = `Correlation heuristic: matched ${corr.count} test run(s), ${corr.failed} failed, total test time ≈ ${fmtDuration(corr.durationMs)}.`;
}

/* -------------------- Step C: Insights (duration stats + taxonomy) -------------------- */

function normalizeMsg(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[0-9a-z]{15,18}/g, "<id>")      // SF ids
    .replace(/\bline\s*\d+\b/g, "line <n>")
    .replace(/\bcolumn\s*\d+\b/g, "column <n>")
    .replace(/\b\d+\b/g, "<n>")
    .trim();
}

function classifyFailure(rec) {
  const msg = normalizeMsg(rec?.ErrorMessage);
  const code = normalizeMsg(rec?.ErrorStatusCode);

  if (!msg && !code) return "None/Unknown";

  if (msg.includes("test") || msg.includes("code coverage") || msg.includes("assert") || msg.includes("apex")) return "Tests/Apex";
  if (msg.includes("duplicate") || msg.includes("already exists")) return "Conflicts/Duplicates";
  if (msg.includes("insufficient access") || msg.includes("permission") || msg.includes("profile")) return "Permissions";
  if (msg.includes("cannot obtain exclusive access") || msg.includes("lock") || msg.includes("row was locked")) return "Locks/Contention";
  if (msg.includes("invalid cross reference") || msg.includes("not found") || msg.includes("missing")) return "Missing dependencies";
  if (msg.includes("compile") || msg.includes("compilation")) return "Compilation";
  if (code) return `StatusCode:${code}`;
  return "Other";
}

function classifyDelay(rec, queueMs, runMs) {
  // Best-effort: if queue dominates -> contention/backlog; if run dominates -> tests/compilation/size
  const status = String(rec?.Status || "");
  const checkOnly = !!rec?.CheckOnly;

  if (status && status.toLowerCase().includes("inprogress")) return "In progress";

  if (queueMs != null && runMs != null) {
    if (queueMs > runMs * 1.5) return "Queue-heavy (contention/backlog)";
    if (runMs > queueMs * 1.5) {
      if (checkOnly) return "Run-heavy (validation/tests)";
      return "Run-heavy (deploy/tests)";
    }
  }

  if (checkOnly) return "Validation (checkOnly)";
  return "Mixed/Unknown";
}

function percentile(values, p) {
  if (!values?.length) return null;
  const sorted = [...values].sort((a,b) => a-b);
  const idx = Math.floor((p/100) * (sorted.length - 1));
  return sorted[idx];
}

function updateInsights(currentRows) {
  const rows = currentRows || [];
  const now = new Date();

  // durations
  const totals = [];
  const queues = [];
  const runs = [];

  const failureCounts = new Map();
  const delayCounts = new Map();

  for (const r of rows) {
    const created = parseDate(r.CreatedDate);
    const started = parseDate(r.StartDate) || created;
    const completed = parseDate(r.CompletedDate);

    const queueMs = created && started ? started - created : null;
    const runMs = started ? (completed ? completed - started : now - started) : null;
    const totalMs = created ? (completed ? completed - created : now - created) : null;

    if (totalMs != null) totals.push(totalMs);
    if (queueMs != null) queues.push(queueMs);
    if (runMs != null) runs.push(runMs);

    const failureCat = classifyFailure(r);
    failureCounts.set(failureCat, (failureCounts.get(failureCat) || 0) + 1);

    const delayCat = classifyDelay(r, queueMs, runMs);
    delayCounts.set(delayCat, (delayCounts.get(delayCat) || 0) + 1);
  }

  const topN = (map, n=5) =>
    [...map.entries()].sort((a,b)=>b[1]-a[1]).slice(0,n);

  const fmtMs = (ms) => ms == null ? "—" : fmtDuration(ms);

  const stats = {
    rows: rows.length,
    total_p50: fmtMs(percentile(totals, 50)),
    total_p95: fmtMs(percentile(totals, 95)),
    queue_p95: fmtMs(percentile(queues, 95)),
    run_p95: fmtMs(percentile(runs, 95)),
    top_delay_categories: topN(delayCounts, 5),
    top_failure_categories: topN(failureCounts, 5),
  };

  setText("insightsBadge", `${rows.length} rows`);
  setText("insightsPre", JSON.stringify(stats, null, 2));
}

/* -------------------- Packages (unchanged) -------------------- */

function pkgRowHtml(r) {
  const pkg = r.SubscriberPackage || {};
  const ver = r.SubscriberPackageVersion || {};
  const version = [ver.MajorVersion, ver.MinorVersion, ver.PatchVersion, ver.BuildNumber]
    .filter((x) => x !== null && x !== undefined)
    .join(".");

  return `
    <tr>
      <td>${escapeHtml(pkg.Name || "—")}</td>
      <td class="mono">${escapeHtml(pkg.NamespacePrefix || "—")}</td>
      <td class="mono">${escapeHtml(version || "—")}</td>
    </tr>
  `.trim();
}

async function fetchPackages() {
  setStateBadge("Loading");
  const soql = `
    SELECT
      Id,
      SubscriberPackage.Name,
      SubscriberPackage.NamespacePrefix,
      SubscriberPackageVersion.MajorVersion,
      SubscriberPackageVersion.MinorVersion,
      SubscriberPackageVersion.PatchVersion,
      SubscriberPackageVersion.BuildNumber
    FROM InstalledSubscriberPackage
    ORDER BY SubscriberPackage.Name
    LIMIT 200
  `.trim();

  const { ok, status, json } = await sfFetch(`/query?q=${encodeURIComponent(soql)}`, { tooling: true });

  const tbody = document.getElementById("packagesTbody");
  if (!tbody) return;

  if (!ok) {
    setStateBadge("Error");
    log(`Packages query failed (HTTP ${status}): ${json?.[0]?.message || json?.message || "Unknown error"}`);
    tbody.innerHTML = `<tr><td class="muted small" colspan="3">Failed to load packages.</td></tr>`;
    return;
  }

  const recs = json?.records || [];
  const q = (document.getElementById("pkgSearch")?.value || "").trim().toLowerCase();
  const filtered = !q
    ? recs
    : recs.filter((r) => {
        const pkg = r.SubscriberPackage || {};
        const blob = `${pkg.Name || ""} ${pkg.NamespacePrefix || ""}`.toLowerCase();
        return blob.includes(q);
      });

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td class="muted small" colspan="3">No packages match your search.</td></tr>`;
    setStateBadge("Ready");
    return;
  }

  tbody.innerHTML = filtered.map(pkgRowHtml).join("\n");
  log(`Packages refreshed (${filtered.length} rows).`);
  setStateBadge("Ready");
}

/* -------------------- Package history discovery -------------------- */

async function discoverPackageHistorySources() {
  setStateBadge("Loading");
  const { ok, status, json } = await sfFetch(`/sobjects/`, { tooling: false });
  if (!ok) {
    setText("packageHistoryPre", `Failed to list sObjects: HTTP ${status}\n${JSON.stringify(json, null, 2)}`);
    setStateBadge("Error");
    return;
  }

  const names = (json?.sobjects || []).map((s) => s.name).filter(Boolean);
  const candidates = names.filter((n) => /(package|install|subscriber|managed|unlocked|2gp|1gp)/i.test(n));

  setText(
    "packageHistoryPre",
    "Candidate objects (names only):\n\n" + candidates.sort().join("\n") +
      "\n\nPick one and we can implement a real history query."
  );

  log(`Discovered ${candidates.length} candidate objects for package history.`);
  setStateBadge("Ready");
}

/* -------------------- Polling -------------------- */

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling() {
  stopPolling();
  const seconds = Number(document.getElementById("pollInterval")?.value || 0);
  if (!seconds) return;

  pollTimer = setInterval(() => {
    // only poll on deployments tab
    if (document.getElementById("tabDeployments")?.classList.contains("active")) {
      fetchDeployments().catch((e) => log(`Polling error: ${e?.message || e}`));
    }
  }, seconds * 1000);

  log(`Auto-refresh enabled: every ${seconds}s`);
}

/* -------------------- Misc / utilities -------------------- */

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function sanitizeRecordForDisplay(rec) {
  // Remove heavy attributes field, keep relationship labels
  const copy = { ...rec };
  delete copy.attributes;
  // Some sub-objects are large; keep just simple ones
  if (copy.CreatedBy && typeof copy.CreatedBy === "object") {
    copy.CreatedBy = { Name: copy.CreatedBy.Name, Id: copy.CreatedBy.Id };
  }
  return copy;
}

function setBuildPill() {
  // crude build identifier: hash of CONFIG + API version + pathname
  const seed = `${CLIENT_ID}|${LOGIN_DOMAIN}|${API_VERSION}|${window.location.pathname}`;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) - h) + seed.charCodeAt(i) | 0;
  const hex = (h >>> 0).toString(16).padStart(8, "0");
  setText("buildPill", `Build: ${hex}`);
}

async function refreshNow() {
  const token = loadToken();
  if (token?.instance_url) setText("orgPill", `Org: ${token.instance_url}`);
  setText("apiPill", `API: v${API_VERSION}`);
  setBuildPill();

  if (document.getElementById("tabDeployments")?.classList.contains("active")) {
    await fetchDeployments();
  } else if (document.getElementById("tabApexTests")?.classList.contains("active")) {
    await fetchApexTests();
  } else if (document.getElementById("tabPackages")?.classList.contains("active")) {
    await fetchPackages();
  } else if (document.getElementById("tabPackageHistory")?.classList.contains("active")) {
    log("Package history: click Discover objects.");
  } else if (document.getElementById("tabDeployDetails")?.classList.contains("active")) {
    await fetchSelectedDeploymentDetails();
  }
}

function clearStorageAndReload() {
  clearToken();
  clearSessionState();
  stopPolling();
  location.reload();
}

/* -------------------- Wire up -------------------- */

wireClick("loginBtn", login);
wireClick("logoutBtn", logout);
wireClick("refreshBtn", () => refreshNow().catch((e) => log(`Refresh error: ${e?.message || e}`)));
wireClick("clearStorageBtn", clearStorageAndReload);
wireClick("refreshPackagesBtn", () => fetchPackages().catch((e) => log(`Packages error: ${e?.message || e}`)));
wireClick("discoverHistoryBtn", () => discoverPackageHistorySources().catch((e) => log(`Discover error: ${e?.message || e}`)));
wireClick("refreshHistoryBtn", () => log("History refresh not implemented — pick an object first."));
wireClick("reFetchSelectedBtn", () => fetchSelectedDeploymentDetails().catch((e) => log(`Details error: ${e?.message || e}`)));

wireClick("tabDeployments", () => { showTab("deployments"); refreshNow(); });
wireClick("tabApexTests", () => { showTab("tests"); refreshNow(); });
wireClick("tabPackages", () => { showTab("packages"); refreshNow(); });
wireClick("tabPackageHistory", () => { showTab("history"); refreshNow(); });
wireClick("tabDeployDetails", () => { showTab("details"); refreshNow(); });

wireChange("pollInterval", startPolling);
wireChange("deployFilter", () => fetchDeployments().catch((e) => log(`Filter error: ${e?.message || e}`)));
wireChange("deployLimit", () => fetchDeployments().catch((e) => log(`Limit error: ${e?.message || e}`)));
wireInput("deploySearch", () => fetchDeployments().catch((e) => log(`Search error: ${e?.message || e}`)));

wireChange("testsLimit", () => fetchApexTests().catch((e) => log(`Tests error: ${e?.message || e}`)));
wireChange("testsFilter", () => renderApexTests(cachedTestRuns));
wireInput("testsSearch", () => renderApexTests(cachedTestRuns));

wireInput("pkgSearch", () => fetchPackages().catch((e) => log(`Pkg search error: ${e?.message || e}`)), 250);

/* -------------------- Init -------------------- */

(async function init() {
  showTab("deployments");
  setBuildPill();

  await handleRedirectIfPresent();

  const token = loadToken();
  if (token?.access_token) {
    setText("orgPill", `Org: ${token.instance_url || "Connected"}`);
    setText("apiPill", `API: v${API_VERSION}`);
    log("Session restored.");
    setStateBadge("Ready");

    // Load tests in background-ish (awaited, but doesn't change UI tab)
    try { await fetchApexTests(); } catch (e) { log(`Apex tests load failed: ${e?.message || e}`); }

    await fetchDeployments();
    startPolling();
  } else {
    setText("orgPill", "Org: Not connected");
    setText("apiPill", "API: —");
    setStateBadge("Idle");
    log("Not logged in.");
  }
})();
