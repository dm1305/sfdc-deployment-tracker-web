// ====== CONFIG (edit these) ======
const CLIENT_ID = "3MVG9YFqzc_KnL.wada6.pbgp4zDPc8T6u6uR6srOVo1fS7XOD_kHsrDH_QurZzXeEgwzWBU365_xXQ54mMNn";
const LOGIN_DOMAIN = "https://gearsetcom-4bf-dev-ed.develop.my.salesforce.com";
// =================================

// Storage keys
const TOKEN_KEY = "sf_token";

// Latest API version from your /services/data output
const API_VERSION = "65.0";

// Polling
let pollTimer = null;

// Cached describes
const describeCache = new Map();

// Selection state
let selectedDeploy = null;

// Used for test ↔ deployment correlation
let cachedApexRuns = [];

// Capabilities matrix cache
let cachedCapabilities = [];

/* -------------------- UI helpers -------------------- */
function $(id) { return document.getElementById(id); }
function setText(id, text) { const el = $(id); if (el) el.textContent = text; }
function showBanner(msg) { const b = $("authBanner"); const m = $("authBannerMsg"); if (m) m.textContent = msg || ""; if (b) b.classList.add("show"); }
function hideBanner() { const b = $("authBanner"); if (b) b.classList.remove("show"); setText("authBannerMsg", ""); }
function log(msg) { const el = $("logPre") || $("status"); if (!el) return; const stamp = new Date().toISOString(); el.textContent = `[${stamp}] ${msg}\n` + el.textContent; }
function wireClick(id, handler) { const el = $(id); if (!el) return; el.addEventListener("click", handler); }
function wireChange(id, handler) { const el = $(id); if (!el) return; el.addEventListener("change", handler); }
function wireInput(id, handler) { const el = $(id); if (!el) return; el.addEventListener("input", handler); }

/* -------------------- Storage helpers -------------------- */
function saveToken(token) { localStorage.setItem(TOKEN_KEY, JSON.stringify(token)); }
function loadToken() { const raw = localStorage.getItem(TOKEN_KEY); return raw ? JSON.parse(raw) : null; }
function clearToken() { localStorage.removeItem(TOKEN_KEY); }
function clearSessionState() { sessionStorage.removeItem("pkce_verifier"); sessionStorage.removeItem("oauth_state"); }
function redactTokenForDisplay(token) { if (!token) return token; const copy = { ...token }; if (copy.access_token) copy.access_token = "(redacted)"; if (copy.refresh_token) copy.refresh_token = "(redacted)"; if (copy.id_token) copy.id_token = "(redacted)"; return copy; }

/* -------------------- PKCE helpers -------------------- */
function base64UrlEncode(bytes) { let bin = ""; bytes.forEach((b) => (bin += String.fromCharCode(b))); return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }
async function sha256Base64Url(text) { const data = new TextEncoder().encode(text); const digest = await crypto.subtle.digest("SHA-256", data); return base64UrlEncode(new Uint8Array(digest)); }
function randomString(length = 64) { const bytes = new Uint8Array(length); crypto.getRandomValues(bytes); const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"; return Array.from(bytes, (b) => chars[b % chars.length]).join(""); }
function getRedirectUri() { return window.location.origin + window.location.pathname; }

/* -------------------- OAuth -------------------- */
async function login() {
  if (!CLIENT_ID || CLIENT_ID.includes("PASTE_")) { alert("Set CLIENT_ID in app.js first."); return; }
  if (!LOGIN_DOMAIN || LOGIN_DOMAIN.includes("YOUR_MY_DOMAIN")) { alert("Set LOGIN_DOMAIN in app.js first."); return; }

  hideBanner();

  const codeVerifier = randomString(96);
  const codeChallenge = await sha256Base64Url(codeVerifier);
  sessionStorage.setItem("pkce_verifier", codeVerifier);

  const state = randomString(24);
  sessionStorage.setItem("oauth_state", state);

  const authUrl = new URL(`${LOGIN_DOMAIN}/services/oauth2/authorize`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", getRedirectUri());
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
    setText("authPill", "Auth: Error");
    showBanner(`OAuth error: ${error}${errorDesc ? " - " + errorDesc : ""}`);
    return;
  }
  if (!code) return;

  const expectedState = sessionStorage.getItem("oauth_state");
  if (!expectedState || state !== expectedState) {
    setText("authPill", "Auth: Error");
    showBanner("State mismatch. Aborting.");
    return;
  }

  const verifier = sessionStorage.getItem("pkce_verifier");
  if (!verifier) {
    setText("authPill", "Auth: Error");
    showBanner("Missing PKCE verifier. Aborting.");
    return;
  }

  url.searchParams.delete("code");
  url.searchParams.delete("state");
  window.history.replaceState({}, document.title, url.toString());

  const tokenUrl = `${LOGIN_DOMAIN}/services/oauth2/token`;
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("client_id", CLIENT_ID);
  body.set("redirect_uri", getRedirectUri());
  body.set("code", code);
  body.set("code_verifier", verifier);

  const resp = await fetch(tokenUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() });
  const json = await resp.json().catch(() => null);
  if (!resp.ok) {
    setText("authPill", "Auth: Error");
    showBanner(`Token exchange failed: ${json?.error_description || json?.error || resp.status}`);
    return;
  }

  saveToken(json);
  setText("orgPill", json.instance_url || "Connected");
  setText("apiPill", `v${API_VERSION}`);
  setText("authPill", "Auth: OK");
  hideBanner();

  log("Logged in ✅ Token stored in localStorage.");
  setText("selectedPre", "Logged in ✅\n" + JSON.stringify(redactTokenForDisplay(json), null, 2));
}

/* -------------------- Token refresh (fix for HTTP 401 Session expired or invalid) -------------------- */
async function refreshAccessToken() {
  const token = loadToken();
  if (!token?.refresh_token) return { ok: false, reason: "missing_refresh_token" };

  const tokenUrl = `${LOGIN_DOMAIN}/services/oauth2/token`;
  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("client_id", CLIENT_ID);
  body.set("refresh_token", token.refresh_token);

  const resp = await fetch(tokenUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() });
  const json = await resp.json().catch(() => null);

  if (!resp.ok) return { ok: false, reason: json?.error || resp.status, detail: json?.error_description };

  const merged = { ...token, ...json, refresh_token: token.refresh_token };
  saveToken(merged);

  setText("orgPill", merged.instance_url || "Connected");
  setText("apiPill", `v${API_VERSION}`);
  setText("authPill", "Auth: OK");
  hideBanner();

  log("Session restored.");
  return { ok: true };
}

/* -------------------- Logout -------------------- */
async function logout() {
  clearToken();
  clearSessionState();
  stopPolling();
  cachedApexRuns = [];
  selectedDeploy = null;

  setText("orgPill", "Not connected");
  setText("apiPill", "—");
  setText("authPill", "Auth: Logged out");
  setText("selectedDeployId", "Selected: —");
  hideBanner();

  log("Logged out.");
}

/* -------------------- REST helper (auto-refresh on 401) -------------------- */
function requireToken() { const token = loadToken(); if (!token?.access_token || !token?.instance_url) return null; return token; }

async function sfFetch(path, { tooling = false, method = "GET", headers = {}, body = null, retryOn401 = true } = {}) {
  const token = requireToken();
  if (!token) return { ok: false, status: 0, json: { message: "Not logged in" } };

  const base = tooling ? `${token.instance_url}/services/data/v${API_VERSION}/tooling` : `${token.instance_url}/services/data/v${API_VERSION}`;
  const url = `${base}${path}`;

  const resp = await fetch(url, { method, headers: { Authorization: `Bearer ${token.access_token}`, ...headers }, body });

  if (resp.status === 401 && retryOn401) {
    setText("authPill", "Auth: Expired");
    log(`HTTP 401 on ${path}: attempting token refresh…`);

    const refreshed = await refreshAccessToken();
    if (refreshed.ok) return sfFetch(path, { tooling, method, headers, body, retryOn401: false });

    stopPolling();
    const msg = refreshed.reason === "missing_refresh_token"
      ? "Session expired and no refresh_token is available. Click Login."
      : `Session expired and refresh failed (${refreshed.reason}${refreshed.detail ? ": " + refreshed.detail : ""}). Click Login.`;
    showBanner(msg);
    log(msg);
    return { ok: false, status: 401, json: { message: "Session expired or invalid" } };
  }

  const json = await resp.json().catch(() => null);
  return { ok: resp.ok, status: resp.status, json };
}

/* -------------------- Describe cache -------------------- */
async function describeSObject(name, { tooling = false } = {}) {
  const key = `${tooling ? "tooling" : "rest"}:${name}`;
  if (describeCache.has(key)) return describeCache.get(key);

  const { ok, status, json } = await sfFetch(`/sobjects/${name}/describe`, { tooling });
  if (!ok) { log(`Describe failed for ${name} (HTTP ${status}): ${json?.[0]?.message || json?.message || "Unknown error"}`); return null; }
  describeCache.set(key, json);
  return json;
}

/* -------------------- Time helpers -------------------- */
function parseDate(s) { if (!s) return null; const d = new Date(s); return Number.isFinite(d.getTime()) ? d : null; }
function fmtTime(d) { if (!d) return "—"; return d.toISOString().replace("T", " ").replace("Z", "Z"); }
function fmtDuration(ms) { if (ms == null || !Number.isFinite(ms) || ms < 0) return "—"; const sec = Math.floor(ms / 1000); const h = Math.floor(sec / 3600); const m = Math.floor((sec % 3600) / 60); const s = sec % 60; return `${h}h ${m}m ${s}s`; }
function percentile(values, p) { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); const idx = Math.ceil((p / 100) * sorted.length) - 1; return sorted[Math.max(0, Math.min(sorted.length - 1, idx))]; }

/* -------------------- Tabs -------------------- */
function showTab(tab) {
  const tDeploy = $("tabDeployments");
  const tTests = $("tabApexTests");
  const tPkg = $("tabPackages");
  const tCaps = $("tabCapabilities");
  const tHist = $("tabPackageHistory");
  const tDet = $("tabDeployDetails");

  [tDeploy, tTests, tPkg, tCaps, tHist, tDet].forEach((b) => b && b.classList.remove("active"));
  if (tab === "deployments") tDeploy && tDeploy.classList.add("active");
  if (tab === "tests") tTests && tTests.classList.add("active");
  if (tab === "packages") tPkg && tPkg.classList.add("active");
  if (tab === "caps") tCaps && tCaps.classList.add("active");
  if (tab === "history") tHist && tHist.classList.add("active");
  if (tab === "details") tDet && tDet.classList.add("active");

  setPanelVisible("deploymentsControls", tab === "deployments");
  setPanelVisible("apexTestsControls", tab === "tests");
  setPanelVisible("packagesControls", tab === "packages");
  setPanelVisible("capabilitiesControls", tab === "caps");
  setPanelVisible("packageHistoryControls", tab === "history");
  setPanelVisible("deployDetailsControls", tab === "details");
}
function setPanelVisible(id, isVisible) { const el = $(id); if (!el) return; el.style.display = isVisible ? "" : "none"; }

/* -------------------- Deployments -------------------- */
function statusClass(status) {
  const s = String(status || "").toLowerCase();
  if (["succeeded", "success", "completed"].some((k) => s.includes(k))) return "good";
  if (["failed", "error"].some((k) => s.includes(k))) return "bad";
  if (["inprogress", "in progress", "queued", "pending", "validat", "running", "processing"].some((k) => s.includes(k))) return "warn";
  return "";
}
function deriveBottleneck(queueMs, runMs) {
  if (queueMs == null || runMs == null) return "—";
  const total = queueMs + runMs;
  if (!Number.isFinite(total) || total <= 0) return "—";
  const qPct = queueMs / total;
  if (qPct >= 0.6) return "Queue";
  if (qPct <= 0.4) return "Run";
  return "Mixed";
}
function passesDeployFilter(r) {
  const filter = $("deployFilter")?.value || "all";
  const status = String(r.Status || "");
  const checkOnly = !!r.CheckOnly;
  if (filter === "active") { const active = ["InProgress", "Pending", "Queued", "Processing", "Running", "Validating"]; return active.includes(status); }
  if (filter === "failed") return status.toLowerCase().includes("fail") || status.toLowerCase().includes("error");
  if (filter === "checkonly") return checkOnly;
  if (filter === "real") return !checkOnly;
  return true;
}
function passesDeploySearch(r) {
  const q = ($("deploySearch")?.value || "").trim().toLowerCase();
  if (!q) return true;
  const blob = [r.Status, r.Type, r.CreatedBy?.Name, r.ErrorStatusCode, r.ErrorMessage, r.Id].filter(Boolean).join(" ").toLowerCase();
  return blob.includes(q);
}

function correlateTestsToDeploy(rec) {
  if (!cachedApexRuns.length) return "—";
  const created = parseDate(rec.CreatedDate);
  const started = parseDate(rec.StartDate) || created;
  const completed = parseDate(rec.CompletedDate);
  if (!started) return "—";
  const winStart = new Date(started.getTime() - 2 * 60 * 1000);
  const winEnd = new Date((completed ? completed.getTime() : Date.now()) + 2 * 60 * 1000);

  const hits = cachedApexRuns.filter((t) => {
    const s = t._start;
    const e = t._end || t._start;
    if (!s) return false;
    return s <= winEnd && (e || s) >= winStart;
  });

  if (!hits.length) return "None";
  const failed = hits.filter((h) => String(h.Outcome || "").toLowerCase().includes("fail")).length;
  const total = hits.length;
  return failed ? `${total} runs (${failed} failed)` : `${total} runs`;
}

function rowHtmlDeploy(r) {
  const now = new Date();
  const created = parseDate(r.CreatedDate);
  const started = parseDate(r.StartDate) || created;
  const completed = parseDate(r.CompletedDate);

  const queueMs = created && started ? started - created : null;
  const runMs = started ? (completed ? completed - started : now - started) : null;
  const totalMs = created ? (completed ? completed - created : now - created) : null;

  const bottleneck = deriveBottleneck(queueMs ?? 0, runMs ?? 0);
  const tests = correlateTestsToDeploy(r);

  const st = r.Status || "—";
  const cls = statusClass(st);

  return `
    <tr>
      <td class="${cls}">${st}</td>
      <td>${r.CreatedBy?.Name || "—"}</td>
      <td>${r.Type || "—"}</td>
      <td>${r.CheckOnly ? "Yes" : "No"}</td>
      <td class="mono">${fmtTime(created)}</td>
      <td class="mono">${fmtTime(parseDate(r.StartDate))}</td>
      <td class="mono">${fmtTime(completed)}</td>
      <td class="mono">${fmtDuration(queueMs)}</td>
      <td class="mono">${fmtDuration(runMs)}</td>
      <td class="mono">${fmtDuration(totalMs)}</td>
      <td>${bottleneck}</td>
      <td>${tests}</td>
      <td><button data-deploy-id="${r.Id}" data-action="selectDeploy">Details</button></td>
    </tr>
  `.trim();
}

function updateKPIs(rows) {
  const now = new Date();
  const totals = rows.map((r) => {
    const created = parseDate(r.CreatedDate);
    const completed = parseDate(r.CompletedDate);
    if (!created) return null;
    const ms = (completed ? completed : now) - created;
    return Number.isFinite(ms) ? ms : null;
  }).filter((x) => x != null);

  const p50 = totals.length ? percentile(totals, 50) : null;
  const p95 = totals.length ? percentile(totals, 95) : null;

  setText("kpiP50", `p50: ${p50 != null ? fmtDuration(p50) : "—"}`);
  setText("kpiP95", `p95: ${p95 != null ? fmtDuration(p95) : "—"}`);

  let qDom = 0, rDom = 0;
  for (const r of rows) {
    const created = parseDate(r.CreatedDate);
    const started = parseDate(r.StartDate) || created;
    const completed = parseDate(r.CompletedDate);
    if (!created || !started) continue;
    const queueMs = started - created;
    const runMs = (completed ? completed : now) - started;
    const b = deriveBottleneck(queueMs, runMs);
    if (b === "Queue") qDom++; else if (b === "Run") rDom++;
  }
  const label = rows.length ? (qDom > rDom ? "Queue-dominated" : rDom > qDom ? "Run-dominated" : "Mixed") : "—";
  setText("kpiBottleneck", `Bottleneck: ${label}`);
}

async function fetchDeployments() {
  const limit = Number($("deployLimit")?.value || 50);
  await describeSObject("DeployRequest", { tooling: true });

  const soql = `
    SELECT Id, Status, Type, CheckOnly,
           CreatedDate, StartDate, CompletedDate,
           CreatedBy.Name,
           ErrorStatusCode, ErrorMessage
    FROM DeployRequest
    ORDER BY CreatedDate DESC
    LIMIT ${limit}
  `.trim();

  const { ok, status, json } = await sfFetch(`/query?q=${encodeURIComponent(soql)}`, { tooling: true });
  if (!ok) {
    log(`DeployRequest query failed (HTTP ${status}): ${json?.[0]?.message || json?.message || "Unknown error"}`);
    setText("deploymentsTbody", `<tr><td class="muted small" colspan="13">DeployRequest query failed: ${json?.[0]?.message || json?.message || status}</td></tr>`);
    return;
  }

  const recs = json?.records || [];
  const filtered = recs.filter(passesDeployFilter).filter(passesDeploySearch);
  const tbody = $("deploymentsTbody");
  if (!tbody) return;

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td class="muted small" colspan="13">No deployments match the current filter.</td></tr>`;
    updateKPIs([]);
    return;
  }

  tbody.innerHTML = filtered.map(rowHtmlDeploy).join("\n");
  tbody.querySelectorAll('button[data-action="selectDeploy"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-deploy-id");
      const rec = filtered.find((x) => x.Id === id);
      if (rec) showDeploySelection(rec);
    });
  });

  updateKPIs(filtered);
  log(`Deployments refreshed (${filtered.length} rows).`);
}

async function showDeploySelection(rec) {
  selectedDeploy = rec;
  setText("selectedDeployId", `Selected: ${rec.Id}`);
  showTab("details");
  setText("selectedPre", JSON.stringify(rec, null, 2));
  await fetchDeployDetails();
}

function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
function startPolling() {
  stopPolling();
  const seconds = Number($("pollInterval")?.value || 0);
  if (!seconds) return;
  pollTimer = setInterval(() => fetchDeployments().catch((e) => log(`Polling error: ${e?.message || e}`)), seconds * 1000);
  log(`Auto-refresh enabled: every ${seconds}s`);
}

/* -------------------- Apex Tests -------------------- */
function testMatchesSearch(r) {
  const q = ($("testsSearch")?.value || "").trim().toLowerCase();
  if (!q) return true;
  const blob = [r.Outcome, r.Status, r.TestTime].filter(Boolean).join(" ").toLowerCase();
  return blob.includes(q);
}
function testRelatedToSelected(r) {
  if (!selectedDeploy) return "—";
  const started = parseDate(selectedDeploy.StartDate) || parseDate(selectedDeploy.CreatedDate);
  const completed = parseDate(selectedDeploy.CompletedDate) || new Date();
  const s = r._start;
  const e = r._end || r._start;
  if (!started || !s) return "—";
  return (s <= completed && (e || s) >= started) ? "Likely" : "No";
}
function testRowHtml(r) {
  const outcome = r.Outcome || "—";
  const status = r.Status || "—";
  const cls = statusClass(outcome) || statusClass(status);
  const tt = r.TestTime != null ? `${Math.round(r.TestTime)} ms` : "—";
  return `
    <tr>
      <td class="${cls}">${outcome}</td>
      <td>${status}</td>
      <td class="mono">${tt}</td>
      <td class="mono">${fmtTime(r._start)}</td>
      <td class="mono">${fmtTime(r._end)}</td>
      <td>${testRelatedToSelected(r)}</td>
    </tr>
  `.trim();
}
async function fetchApexTests() {
  await describeSObject("ApexTestRun", { tooling: true });
  const limit = Number($("testsLimit")?.value || 50);

  const soql = `
    SELECT Id, Status, Outcome, TestTime, CreatedDate
    FROM ApexTestRun
    ORDER BY CreatedDate DESC
    LIMIT ${limit}
  `.trim();

  const { ok, status, json } = await sfFetch(`/query?q=${encodeURIComponent(soql)}`, { tooling: true });
  if (!ok) {
    log(`ApexTestRun query failed (HTTP ${status}): ${json?.[0]?.message || json?.message || "Unknown error"}`);
    setText("testsTbody", `<tr><td class="muted small" colspan="6">ApexTestRun query failed: ${json?.[0]?.message || json?.message || status}</td></tr>`);
    cachedApexRuns = [];
    return;
  }

  cachedApexRuns = (json?.records || []).map((r) => ({ ...r, _start: parseDate(r.CreatedDate), _end: null }));
  const filtered = cachedApexRuns.filter(testMatchesSearch);

  const tbody = $("testsTbody");
  if (!tbody) return;
  tbody.innerHTML = filtered.length
    ? filtered.map(testRowHtml).join("\n")
    : `<tr><td class="muted small" colspan="6">No test runs match your search.</td></tr>`;

  log(`Apex tests refreshed (${filtered.length} rows).`);

  // keep deployments table in sync with test summaries
  if ($("tabDeployments")?.classList.contains("active")) fetchDeployments().catch(() => {});
}

/* -------------------- Packages (Metadata inventory) -------------------- */
function pkgRowHtml(r) {
  const pkg = r.SubscriberPackage || {};
  const ver = r.SubscriberPackageVersion || {};
  const version = [ver.MajorVersion, ver.MinorVersion, ver.PatchVersion, ver.BuildNumber].filter((x) => x !== null && x !== undefined).join(".");
  return `<tr><td>${pkg.Name || "—"}</td><td class="mono">${pkg.NamespacePrefix || "—"}</td><td class="mono">${version || "—"}</td></tr>`;
}
async function fetchPackages() {
  const soql = `
    SELECT Id, SubscriberPackage.Name, SubscriberPackage.NamespacePrefix,
           SubscriberPackageVersion.MajorVersion, SubscriberPackageVersion.MinorVersion,
           SubscriberPackageVersion.PatchVersion, SubscriberPackageVersion.BuildNumber
    FROM InstalledSubscriberPackage
    ORDER BY SubscriberPackage.Name
    LIMIT 200
  `.trim();

  const { ok, status, json } = await sfFetch(`/query?q=${encodeURIComponent(soql)}`, { tooling: true });
  if (!ok) {
    log(`Packages query failed (HTTP ${status}): ${json?.[0]?.message || json?.message || "Unknown error"}`);
    setText("packagesTbody", `<tr><td class="muted small" colspan="3">Packages query failed: ${json?.[0]?.message || json?.message || status}</td></tr>`);
    return;
  }

  const recs = json?.records || [];
  const q = ($("pkgSearch")?.value || "").trim().toLowerCase();
  const filtered = !q ? recs : recs.filter((r) => (`${r.SubscriberPackage?.Name || ""} ${r.SubscriberPackage?.NamespacePrefix || ""}`).toLowerCase().includes(q));

  const tbody = $("packagesTbody");
  if (!tbody) return;
  tbody.innerHTML = filtered.length
    ? filtered.map(pkgRowHtml).join("\n")
    : `<tr><td class="muted small" colspan="3">No packages match your search.</td></tr>`;

  log(`Packages refreshed (${filtered.length} rows).`);
}


/* -------------------- Capabilities matrix -------------------- */
function boolIcon(v) { return v ? "✔️" : "❌"; }

async function listSObjects({ tooling = false } = {}) {
  const { ok, status, json } = await sfFetch("/sobjects", { tooling });
  if (!ok) throw new Error(`sobjects list failed (HTTP ${status})`);
  return json?.sobjects || [];
}

async function canDescribeSObject(typeName) {
  const { ok } = await sfFetch(`/sobjects/${encodeURIComponent(typeName)}/describe`, { tooling: false, retryOn401: true });
  return !!ok;
}

async function fetchDescribeMetadataFromProxy(proxyUrl) {
  const token = requireToken();
  if (!token) throw new Error("Not logged in");
  const url = String(proxyUrl || "").trim().replace(/\/+$/, "") + "/metadata/describe";
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instanceUrl: token.instance_url, accessToken: token.access_token, apiVersion: API_VERSION })
  });
  const j = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error(j?.error || `Proxy HTTP ${resp.status}`);
  return j;
}

function renderCapabilitiesTable(rows) {
  const tbody = $("capsTbody");
  if (!tbody) return;

  const q = String($("capSearch")?.value || "").trim().toLowerCase();
  const filtered = q ? rows.filter(r => String(r.typeName).toLowerCase().includes(q)) : rows;

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td class="muted small" colspan="7">No types match your search.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(r => {
    const c = r.capabilities || {};
    return `<tr>
      <td>${escapeHtml(r.typeName)}</td>
      <td style="text-align:center;">${boolIcon(c.soql)}</td>
      <td style="text-align:center;">${boolIcon(c.tooling)}</td>
      <td style="text-align:center;">${boolIcon(c.metadataRetrieve)}</td>
      <td style="text-align:center;">${boolIcon(c.metadataDeploy)}</td>
      <td style="text-align:center;">${boolIcon(c.removable)}</td>
      <td style="text-align:center;">${boolIcon(c.rest)}</td>
    </tr>`;
  }).join("");
}

async function refreshCapabilities() {
  const tbody = $("capsTbody");
  if (tbody) tbody.innerHTML = `<tr><td class="muted small" colspan="7">Loading…</td></tr>`;

  try {
    const proxyUrl = $("proxyUrl")?.value || "";
    const limit = Number($("capsLimit")?.value || 200);

    const [restObjs, toolingObjs] = await Promise.all([
      listSObjects({ tooling: false }),
      listSObjects({ tooling: true }),
    ]);

    const restBy = new Map(restObjs.filter(o => o?.name).map(o => [o.name, o]));
    const toolingBy = new Map(toolingObjs.filter(o => o?.name).map(o => [o.name, o]));

    const mdBy = new Map(); // xmlName -> { readOnly }
    if (String(proxyUrl).trim()) {
      try {
        const md = await fetchDescribeMetadataFromProxy(proxyUrl);
        for (const o of (md?.metadataObjects || [])) {
          if (o?.xmlName) mdBy.set(o.xmlName, { readOnly: !!o.readOnly });
        }
        log(`Capabilities: describeMetadata returned ${mdBy.size} types.`);
      } catch (e) {
        log(`Capabilities: Metadata proxy failed (${e?.message || e}). Metadata columns will be ❌.`);
      }
    }

    let typeNames = [];
    if (mdBy.size) typeNames = Array.from(mdBy.keys());
    else typeNames = Array.from(new Set([...restBy.keys(), ...toolingBy.keys()]));
    typeNames.sort((a, b) => a.localeCompare(b));

    if (Number.isFinite(limit) && limit > 0) typeNames = typeNames.slice(0, limit);

    const rows = [];
    for (const typeName of typeNames) {
      const rest = restBy.get(typeName);
      const tool = toolingBy.get(typeName);
      const md = mdBy.get(typeName);

      const soql = !!rest?.queryable;
      const tooling = !!tool?.queryable;

      const metadataRetrieve = !!md;
      const metadataDeploy = !!md && md.readOnly === false;

      const removable = !!metadataDeploy;

      let restAccess = false;
      try { restAccess = await canDescribeSObject(typeName); } catch { restAccess = false; }

      rows.push({ typeName, capabilities: { soql, tooling, metadataRetrieve, metadataDeploy, removable, rest: restAccess } });
    }

    cachedCapabilities = rows;
    renderCapabilitiesTable(cachedCapabilities);
    log(`Capabilities refreshed (${rows.length} types).`);
  } catch (e) {
    const msg = e?.message || String(e);
    if (tbody) tbody.innerHTML = `<tr><td class="muted small" colspan="7">Failed: ${escapeHtml(msg)}</td></tr>`;
    log(`Capabilities refresh failed: ${msg}`);
  }
}

/* -------------------- Package history (scaffold) -------------------- */
async function discoverPackageHistorySources() {
  const { ok, status, json } = await sfFetch(`/sobjects/`, { tooling: false });
  if (!ok) { setText("packageHistoryPre", `Failed to list sObjects: HTTP ${status}\n${JSON.stringify(json, null, 2)}`); return; }
  const names = (json?.sobjects || []).map((s) => s.name).filter(Boolean);
  const candidates = names.filter((n) => /(package|install|subscriber|managed|unlocked|2gp|1gp)/i.test(n));
  setText("packageHistoryPre", "Discovered candidate objects (names only):\n\n" + candidates.sort().join("\n") + "\n\nNext: pick a candidate and query recent records (not implemented).");
  log(`Discovered ${candidates.length} candidate objects for package history.`);
}

/* -------------------- Deploy details -------------------- */
async function fetchDeployDetails() {
  if (!selectedDeploy?.Id) { setText("deployDetailsPre", "Select a deployment row (Details) to view diagnostics."); return; }

  const desc = await describeSObject("DeployRequest", { tooling: true });
  const fieldNames = new Set((desc?.fields || []).map((f) => f.name));
  const optionalFields = ["NumberComponentsDeployed","NumberComponentErrors","NumberTestsCompleted","NumberTestErrors","NumberTestsTotal"].filter((f) => fieldNames.has(f));

  const soql = `
    SELECT Id, Status, Type, CheckOnly, CreatedDate, StartDate, CompletedDate,
           CreatedBy.Name, ErrorStatusCode, ErrorMessage${optionalFields.length ? "," : ""} ${optionalFields.join(",")}
    FROM DeployRequest
    WHERE Id = '${selectedDeploy.Id}'
    LIMIT 1
  `.trim();

  const { ok, status, json } = await sfFetch(`/query?q=${encodeURIComponent(soql)}`, { tooling: true });
  if (!ok) { log(`Deploy details query failed (HTTP ${status}): ${json?.[0]?.message || json?.message || "Unknown error"}`); setText("deployDetailsPre", `Deploy details query failed: ${json?.[0]?.message || json?.message || status}`); return; }

  const rec = (json?.records || [])[0];
  if (!rec) { setText("deployDetailsPre", "No record found for selected deployment."); return; }

  const created = parseDate(rec.CreatedDate);
  const started = parseDate(rec.StartDate) || created;
  const completed = parseDate(rec.CompletedDate);
  const now = new Date();

  const queueMs = created && started ? started - created : null;
  const runMs = started ? (completed ? completed - started : now - started) : null;
  const bottleneck = deriveBottleneck(queueMs ?? 0, runMs ?? 0);

  const diagnosis = {
    Bottleneck: bottleneck,
    QueueTime: fmtDuration(queueMs),
    RunTime: fmtDuration(runMs),
    Notes: [
      bottleneck === "Queue" ? "Queue-dominated: likely org contention / deploy queue / concurrent work." : null,
      bottleneck === "Run" ? "Run-dominated: often compilation, tests, managed package dependencies, or DB load." : null,
      String(rec.Status || "").toLowerCase().includes("fail") ? "Failed: inspect ErrorStatusCode/ErrorMessage." : null,
      rec.CheckOnly ? "Check-only validation: typically runs tests/compile but no commit of changes." : null,
    ].filter(Boolean),
  };

  setText("deployDetailsPre", JSON.stringify({ SelectedDeployRequest: rec, Diagnosis: diagnosis, CorrelatedTests: cachedApexRuns.length ? correlateTestsToDeploy(rec) : "—" }, null, 2));
  log("Deploy details refreshed.");
}

/* -------------------- Page actions -------------------- */
async function refreshNow() {
  const token = loadToken();
  if (token?.instance_url) setText("orgPill", token.instance_url);
  setText("apiPill", `v${API_VERSION}`);

  const activeTabId = document.querySelector(".tab.active")?.id;
  try {
    if (activeTabId === "tabPackages") await fetchPackages();
    else if (activeTabId === "tabPackageHistory") log("Package history: click Discover objects.");
    else if (activeTabId === "tabDeployDetails") await fetchDeployDetails();
    else if (activeTabId === "tabApexTests") await fetchApexTests();
    else await fetchDeployments();
  } catch (e) { log(`Refresh error: ${e?.message || e}`); }
}
function clearSession() { clearToken(); clearSessionState(); stopPolling(); setText("authPill","Auth: Cleared"); setText("orgPill","Not connected"); setText("apiPill","—"); location.reload(); }

/* -------------------- Wire up -------------------- */
wireClick("loginBtn", login);
wireClick("logoutBtn", logout);
wireClick("refreshBtn", refreshNow);
wireClick("clearStorageBtn", clearSession);
wireClick("bannerLoginBtn", login);
wireClick("bannerLogoutBtn", logout);

wireClick("tabDeployments", () => { showTab("deployments"); refreshNow(); });
wireClick("tabApexTests", () => { showTab("tests"); refreshNow(); });
wireClick("tabPackages", () => { showTab("packages"); refreshNow(); });
wireClick("tabCapabilities", () => { showTab("caps"); /* no auto-refresh to avoid heavy calls */ });
wireClick("tabPackageHistory", () => { showTab("history"); refreshNow(); });
wireClick("tabDeployDetails", () => { showTab("details"); refreshNow(); });

wireChange("pollInterval", () => startPolling());
wireChange("deployFilter", () => fetchDeployments());
wireChange("deployLimit", () => fetchDeployments());
wireInput("deploySearch", () => fetchDeployments());

wireChange("testsLimit", () => fetchApexTests());
wireInput("testsSearch", () => fetchApexTests());
wireClick("refreshTestsBtn", fetchApexTests);

wireInput("pkgSearch", () => fetchPackages());
wireClick("refreshPackagesBtn", fetchPackages);
wireClick("refreshCapsBtn", refreshCapabilities);

wireClick("discoverHistoryBtn", discoverPackageHistorySources);
wireClick("refreshHistoryBtn", () => log("History refresh not implemented yet—use Discover first."));
wireClick("fetchDeployDetailsBtn", fetchDeployDetails);

/* -------------------- Init -------------------- */
(async function init() {
  showTab("deployments");
  await handleRedirectIfPresent();

  const token = loadToken();
  if (token?.access_token) {
    setText("orgPill", token.instance_url || "Connected");
    setText("apiPill", `v${API_VERSION}`);
    setText("authPill", "Auth: OK");
    hideBanner();

    log("Already logged in ✅ Token loaded from localStorage.");
    await fetchApexTests().catch(() => {});
    await fetchDeployments();
    startPolling();
  } else {
    setText("orgPill", "Not connected");
    setText("apiPill", "—");
    setText("authPill", "Auth: Logged out");
    log("Not logged in.");
  }
})();
