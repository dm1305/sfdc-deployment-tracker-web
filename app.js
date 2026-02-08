// ====== CONFIG (edit these) ======
const CLIENT_ID = "3MVG9YFqzc_KnL.wada6.pbgp4zDPc8T6u6uR6srOVo1fS7XOD_kHsrDH_QurZzXeEgwzWBU365_xXQ54mMNn";
const LOGIN_DOMAIN = "https://gearsetcom-4bf-dev-ed.develop.my.salesforce.com"; // your org My Domain
// =================================

// Build label (helps with caching / verifying deploy)
const BUILD = "2026-02-08.1";

// Storage keys
const TOKEN_KEY = "sf_token";

// API version (from /services/data)
const API_VERSION = "65.0";

// Polling
let pollTimer = null;

// Busy state (prevents stacked requests)
let inFlight = false;
let lastPollSkipped = false;

// Cached datasets
let lastDeployments = [];
let lastTestRuns = [];

// Correlation cache: deployId -> correlation object
let deployToTest = new Map();

/* -------------------- UI helpers -------------------- */

function $(id) { return document.getElementById(id); }

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function show(el, on) {
  if (!el) return;
  el.style.display = on ? "" : "none";
}

function setBusy(isBusy, label = null) {
  inFlight = isBusy;
  const pill = $("busyPill");
  if (pill) pill.textContent = isBusy ? (label || "Working…") : "Idle";
  // disable main actions while busy
  const ids = ["refreshBtn", "refreshPackagesBtn", "refreshTestsBtn", "discoverHistoryBtn", "fetchDeployDetailsBtn"];
  ids.forEach((i) => {
    const b = $(i);
    if (b) b.disabled = !!isBusy;
  });
}

function nowIso() {
  return new Date().toISOString();
}

function log(msg) {
  const el = $("logPre") || $("status");
  if (!el) return;
  const stamp = nowIso();
  el.textContent = `[${stamp}] ${msg}\n` + el.textContent;
}

function setSelected(objOrText) {
  const el = $("selectedPre") || $("status");
  if (!el) return;
  el.textContent = typeof objOrText === "string" ? objOrText : JSON.stringify(objOrText, null, 2);
}

function showBanner(message) {
  const b = $("authBanner");
  if (!b) return;
  b.textContent = message;
  b.style.display = message ? "block" : "none";
}

function setLastRefreshed() {
  setText("lastRefreshed", `Last refreshed: ${new Date().toISOString().replace("T", " ").replace("Z", "Z")}`);
}

function setLastRequest(text) {
  setText("lastRequest", `Last request: ${text}`);
}

function wireClick(id, handler) {
  const el = $(id);
  if (!el) return;
  el.addEventListener("click", (e) => handler(e));
}

function wireChange(id, handler) {
  const el = $(id);
  if (!el) return;
  el.addEventListener("change", (e) => handler(e));
}

function wireInput(id, handler) {
  const el = $(id);
  if (!el) return;
  el.addEventListener("input", (e) => handler(e));
}

function debounce(fn, ms = 250) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
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

/* -------------------- Global error traps -------------------- */

window.addEventListener("error", (e) => {
  log(`JS error: ${e?.message || e}`);
});

window.addEventListener("unhandledrejection", (e) => {
  const reason = e?.reason?.message || String(e?.reason || e);
  log(`Unhandled promise rejection: ${reason}`);
});

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
  return window.location.origin + window.location.pathname;
}

/* -------------------- OAuth -------------------- */

async function login() {
  if (!CLIENT_ID) {
    alert("Missing CLIENT_ID in app.js.");
    return;
  }

  const redirectUri = getRedirectUri();

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
    showBanner(`OAuth error: ${error}${errorDesc ? " - " + errorDesc : ""}`);
    log(`OAuth error: ${error}${errorDesc ? " - " + errorDesc : ""}`);
    return;
  }

  if (!code) return;

  const expectedState = sessionStorage.getItem("oauth_state");
  if (!expectedState || state !== expectedState) {
    showBanner("State mismatch. Aborting.");
    log("State mismatch. Aborting.");
    return;
  }

  const verifier = sessionStorage.getItem("pkce_verifier");
  if (!verifier) {
    showBanner("Missing PKCE verifier. Aborting.");
    log("Missing PKCE verifier. Aborting.");
    return;
  }

  // Clean URL
  url.searchParams.delete("code");
  url.searchParams.delete("state");
  window.history.replaceState({}, document.title, url.toString());

  // Exchange for token
  setBusy(true, "Auth…");
  setLastRequest("token exchange");
  const tokenUrl = `${LOGIN_DOMAIN}/services/oauth2/token`;

  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("client_id", CLIENT_ID);
  body.set("redirect_uri", getRedirectUri());
  body.set("code", code);
  body.set("code_verifier", verifier);

  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const json = await resp.json().catch(() => null);
  setBusy(false);

  if (!resp.ok) {
    const msg = json?.error_description || json?.error || `HTTP ${resp.status}`;
    showBanner(`Token error: ${msg}`);
    log(`Token exchange failed: ${msg}`);
    return;
  }

  saveToken(json);
  clearSessionState();
  showBanner("");

  setText("orgPill", json.instance_url || "Connected");
  setText("apiPill", `v${API_VERSION}`);
  setText("buildPill", BUILD);

  log("Logged in ✅ Token stored in localStorage.");
  setSelected(redactTokenForDisplay(json));
}

/* -------------------- Auth lifecycle -------------------- */

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling() {
  stopPolling();
  const seconds = Number($("pollInterval")?.value || 0);
  if (!seconds) {
    log("Auto-refresh disabled.");
    return;
  }

  pollTimer = setInterval(async () => {
    if (inFlight) {
      lastPollSkipped = true;
      return;
    }
    lastPollSkipped = false;
    await refreshActiveTab(true);
  }, seconds * 1000);

  log(`Auto-refresh enabled: every ${seconds}s`);
}

async function logout() {
  clearToken();
  clearSessionState();
  stopPolling();
  deployToTest = new Map();
  lastDeployments = [];
  lastTestRuns = [];
  showBanner("");
  setText("orgPill", "Not connected");
  setText("apiPill", "—");
  setText("buildPill", BUILD);
  setSelected("Nothing selected.");
  log("Logged out.");
}

/* -------------------- REST helpers -------------------- */

function requireToken() {
  const token = loadToken();
  if (!token?.access_token || !token?.instance_url) return null;
  return token;
}

function isSessionInvalid(sfJson) {
  const msg = (sfJson?.[0]?.errorCode || sfJson?.error || sfJson?.message || "").toString();
  return /INVALID_SESSION_ID|invalid_grant|expired|session/i.test(msg);
}

function extractSfError(json) {
  if (!json) return "Unknown error";
  if (Array.isArray(json) && json[0]?.message) return json[0].message;
  if (json?.message) return json.message;
  if (json?.error_description) return json.error_description;
  if (json?.error) return json.error;
  return JSON.stringify(json);
}

async function sfFetch(path, { tooling = false, method = "GET", headers = {}, body = null } = {}) {
  const token = requireToken();
  if (!token) {
    showBanner("Not logged in. Click Login.");
    return { ok: false, status: 0, json: null };
  }

  const base = tooling
    ? `${token.instance_url}/services/data/v${API_VERSION}/tooling`
    : `${token.instance_url}/services/data/v${API_VERSION}`;
  const url = `${base}${path}`;

  setLastRequest(`${tooling ? "tooling" : "rest"} ${method} ${path}`);

  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      ...headers,
    },
    body,
  });

  const json = await resp.json().catch(() => null);

  if (!resp.ok) {
    const sfErr = extractSfError(json);
    // If token is invalid, stop polling and show banner
    if (resp.status === 401 || isSessionInvalid(json)) {
      stopPolling();
      showBanner(`Session expired/invalid. Click Login again. (HTTP ${resp.status})`);
      log(`Auth/session error: ${sfErr}`);
    } else {
      log(`SF request failed (HTTP ${resp.status}): ${sfErr}`);
    }
  }

  return { ok: resp.ok, status: resp.status, json };
}

/* -------------------- Time formatting -------------------- */

function parseDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}

function fmtTime(d) {
  if (!d) return "—";
  return d.toISOString().replace("T", " ").replace("Z", "Z");
}

function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}h ${m}m ${s}s`;
}

/* -------------------- Tabs / panels -------------------- */

function setPanelVisible(id, on) {
  const el = $(id);
  if (el) el.style.display = on ? "" : "none";
}

function setResultsView(view) {
  show($("deploymentsTableWrap"), view === "deployments");
  show($("testsTableWrap"), view === "tests");
  show($("packagesTableWrap"), view === "packages");
  show($("packageHistoryWrap"), view === "history");
  show($("deployDetailsWrap"), view === "details");
}

function showTab(tab) {
  const tabs = ["tabDeployments", "tabApexTests", "tabPackages", "tabPackageHistory", "tabDeployDetails"];
  tabs.forEach((id) => $(id)?.classList.remove("active"));

  if (tab === "deployments") $("tabDeployments")?.classList.add("active");
  if (tab === "tests") $("tabApexTests")?.classList.add("active");
  if (tab === "packages") $("tabPackages")?.classList.add("active");
  if (tab === "history") $("tabPackageHistory")?.classList.add("active");
  if (tab === "details") $("tabDeployDetails")?.classList.add("active");

  setPanelVisible("deploymentsControls", tab === "deployments");
  setPanelVisible("apexTestsControls", tab === "tests");
  setPanelVisible("packagesControls", tab === "packages");
  setPanelVisible("packageHistoryControls", tab === "history");
  setPanelVisible("deployDetailsControls", tab === "details");

  setResultsView(tab);

  const title = $("resultsTitle");
  if (title) {
    title.textContent =
      tab === "deployments" ? "Results (Deployments)" :
      tab === "tests" ? "Results (Apex tests)" :
      tab === "packages" ? "Results (Packages)" :
      tab === "history" ? "Results (Package history)" :
      "Results (Deploy details)";
  }
}

/* -------------------- Deployments + correlation -------------------- */

function statusClass(status) {
  const s = String(status || "").toLowerCase();
  if (["succeeded", "success", "completed"].some((k) => s.includes(k))) return "good";
  if (["failed", "error"].some((k) => s.includes(k))) return "bad";
  if (["inprogress", "in progress", "queued", "pending", "validat", "running", "processing"].some((k) => s.includes(k)))
    return "warn";
  return "";
}

function passesDeployFilter(r) {
  const filter = $("deployFilter")?.value || "all";
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
  const q = ($("deploySearch")?.value || "").trim().toLowerCase();
  if (!q) return true;
  const blob = [
    r.Status,
    r.Type,
    r.CreatedBy?.Name,
    r.ErrorStatusCode,
    r.ErrorMessage,
    r.Id,
  ].filter(Boolean).join(" ").toLowerCase();
  return blob.includes(q);
}

function correlationBadge(c) {
  if (!c) return `<span class="badge muted">Unknown</span>`;
  const conf = c.confidence || "Low";
  const out = c.outcome || "Unknown";
  const cls =
    /fail/i.test(out) ? "bad" :
    /pass|succeed/i.test(out) ? "good" :
    "warn";
  return `<span class="badge"><span class="status ${cls}">${out}</span><span class="muted">(${conf})</span></span>`;
}

function fmtInt(n) {
  if (n == null || n === "") return "—";
  if (!Number.isFinite(Number(n))) return String(n);
  return String(n);
}

function renderDeploymentsTable(rows) {
  const tbody = $("deploymentsTbody");
  if (!tbody) return;

  if (!rows.length) {
    tbody.innerHTML = `<tr><td class="muted small" colspan="14">No deployments match the current filter/search.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map((r) => {
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

    const corr = deployToTest.get(r.Id) || null;
    const testFails = corr?.failures ?? null;
    const testMs = corr?.durationMs ?? null;

    return `
      <tr>
        <td class="status ${stClass}">${st}</td>
        <td>${user}</td>
        <td>${type}${r.CheckOnly ? ' <span class="muted">(checkOnly)</span>' : ""}</td>
        <td class="mono">${fmtTime(created)}</td>
        <td class="mono">${fmtTime(parseDate(r.StartDate))}</td>
        <td class="mono">${fmtTime(completed)}</td>
        <td class="mono">${fmtDuration(queueMs)}</td>
        <td class="mono">${fmtDuration(runMs)}</td>
        <td class="mono">${fmtDuration(totalMs)}</td>
        <td>${correlationBadge(corr)}</td>
        <td class="mono">${fmtInt(testFails)}</td>
        <td class="mono">${fmtDuration(testMs)}</td>
        <td class="mono">${r.Id}</td>
        <td>
          <div class="rowActions">
            <button class="btnSmall" data-action="selectDeploy" data-id="${r.Id}">Details</button>
            <button class="btnSmall" data-action="copy" data-text="${r.Id}">Copy id</button>
            ${corr?.runId ? `<button class="btnSmall" data-action="selectTestRun" data-id="${corr.runId}">Test run</button>` : ""}
          </div>
        </td>
      </tr>
    `.trim();
  }).join("\n");

  // Event delegation
  tbody.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const action = btn.getAttribute("data-action");
      const id = btn.getAttribute("data-id");
      const text = btn.getAttribute("data-text");

      if (action === "selectDeploy") {
        const rec = rows.find((x) => x.Id === id);
        if (!rec) return;

        setSelected({
          kind: "DeployRequest",
          Id: rec.Id,
          Status: rec.Status,
          Type: rec.Type,
          CheckOnly: rec.CheckOnly,
          CreatedBy: rec.CreatedBy?.Name,
          CreatedDate: rec.CreatedDate,
          StartDate: rec.StartDate,
          CompletedDate: rec.CompletedDate,
          ErrorStatusCode: rec.ErrorStatusCode,
          ErrorMessage: rec.ErrorMessage,
          CorrelatedTest: deployToTest.get(rec.Id) || null,
        });
        return;
      }

      if (action === "copy") {
        try {
          await navigator.clipboard.writeText(text || "");
          log("Copied to clipboard.");
        } catch {
          log("Clipboard copy failed (browser permissions).");
        }
        return;
      }

      if (action === "selectTestRun") {
        // Switch to tests tab and load failures
        showTab("tests");
        await refreshTests(false);
        await selectTestRunAndFailures(id);
      }
    });
  });
}

async function fetchDeployments() {
  const limit = Number($("deployLimit")?.value || 20);
  // Tooling DeployRequest
  const soql = `
    SELECT Id, Status, Type, CheckOnly,
           CreatedDate, StartDate, CompletedDate,
           CreatedBy.Name, CreatedById,
           ErrorStatusCode, ErrorMessage
    FROM DeployRequest
    ORDER BY CreatedDate DESC
    LIMIT ${limit}
  `.trim();

  setBusy(true, "Deploys…");
  const { ok, status, json } = await sfFetch(`/query?q=${encodeURIComponent(soql)}`, { tooling: true });
  setBusy(false);

  if (!ok) {
    const msg = extractSfError(json);
    setSelected(`DeployRequest query failed (HTTP ${status}):\n${msg}`);
    return [];
  }

  const recs = json?.records || [];
  lastDeployments = recs;

  // Ensure we also have test runs cached (for correlation)
  if (!lastTestRuns.length) {
    await refreshTests(true); // silent refresh
  }

  correlateDeploymentsToTests(recs, lastTestRuns);

  const filtered = recs.filter(passesDeployFilter).filter(passesDeploySearch);
  renderDeploymentsTable(filtered);
  return filtered;
}

/* -------------------- Apex Tests -------------------- */

function passesTestFilter(r) {
  const f = $("testFilter")?.value || "all";
  const outcome = String(r.Outcome || r.Status || "").toLowerCase();
  if (f === "failed") return /(fail|error)/i.test(outcome) || Number(r.Failures || 0) > 0;
  if (f === "passed") return /(pass|success)/i.test(outcome) && Number(r.Failures || 0) === 0;
  return true;
}

function passesTestSearch(r) {
  const q = ($("testSearch")?.value || "").trim().toLowerCase();
  if (!q) return true;
  const blob = [r.Id, r.Outcome, r.Status, r.CreatedBy?.Name].filter(Boolean).join(" ").toLowerCase();
  return blob.includes(q);
}

function testOutcomeClass(outcome) {
  const s = String(outcome || "").toLowerCase();
  if (/(pass|success)/i.test(s)) return "good";
  if (/(fail|error)/i.test(s)) return "bad";
  return "warn";
}

function renderTestsTable(rows) {
  const tbody = $("testsTbody");
  if (!tbody) return;

  if (!rows.length) {
    tbody.innerHTML = `<tr><td class="muted small" colspan="9">No test runs match the current filter/search.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map((r) => {
    const started = parseDate(r.StartTime);
    const ended = parseDate(r.EndTime);
    const dur = started ? ((ended ? ended - started : new Date() - started)) : null;
    const outcome = r.Outcome || r.Status || "—";
    const cls = testOutcomeClass(outcome);

    return `
      <tr>
        <td class="status ${cls}">${outcome}</td>
        <td>${r.CreatedBy?.Name || "—"}</td>
        <td class="mono">${fmtTime(started)}</td>
        <td class="mono">${fmtTime(ended)}</td>
        <td class="mono">${fmtDuration(dur)}</td>
        <td class="mono">${fmtInt(r.TestsRan)}</td>
        <td class="mono">${fmtInt(r.Failures)}</td>
        <td class="mono">${r.Id}</td>
        <td>
          <div class="rowActions">
            <button class="btnSmall" data-action="selectRun" data-id="${r.Id}">Details</button>
            <button class="btnSmall" data-action="loadFailures" data-id="${r.Id}">Failures</button>
            <button class="btnSmall" data-action="copy" data-text="${r.Id}">Copy</button>
          </div>
        </td>
      </tr>
    `.trim();
  }).join("\n");

  tbody.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const action = btn.getAttribute("data-action");
      const id = btn.getAttribute("data-id");
      const text = btn.getAttribute("data-text");

      if (action === "copy") {
        try {
          await navigator.clipboard.writeText(text || "");
          log("Copied to clipboard.");
        } catch {
          log("Clipboard copy failed.");
        }
        return;
      }

      if (action === "selectRun") {
        const rec = rows.find((x) => x.Id === id);
        if (!rec) return;
        setSelected({ kind: "ApexTestRun", ...rec });
        return;
      }

      if (action === "loadFailures") {
        await selectTestRunAndFailures(id);
      }
    });
  });
}

async function refreshTests(silent = false) {
  const limit = Number($("testLimit")?.value || 20);

  // ApexTestRun is in Tooling API
  // Note: fields vary by org; these are commonly available
  const soql = `
    SELECT Id, Status, Outcome, StartTime, EndTime, TestsRan, Failures,
           CreatedBy.Name, CreatedById
    FROM ApexTestRun
    ORDER BY StartTime DESC
    LIMIT ${limit}
  `.trim();

  if (!silent) setBusy(true, "Tests…");
  const { ok, status, json } = await sfFetch(`/query?q=${encodeURIComponent(soql)}`, { tooling: true });
  if (!silent) setBusy(false);

  if (!ok) {
    const msg = extractSfError(json);
    if (!silent) setSelected(`ApexTestRun query failed (HTTP ${status}):\n${msg}`);
    return [];
  }

  const recs = json?.records || [];
  lastTestRuns = recs;

  // re-run correlation if deployments already loaded
  if (lastDeployments.length) {
    correlateDeploymentsToTests(lastDeployments, lastTestRuns);
    // if currently on deployments tab, re-render deployments table
    if ($("tabDeployments")?.classList.contains("active")) {
      const filtered = lastDeployments.filter(passesDeployFilter).filter(passesDeploySearch);
      renderDeploymentsTable(filtered);
    }
  }

  const filtered = recs.filter(passesTestFilter).filter(passesTestSearch);
  if (!silent) renderTestsTable(filtered);

  return filtered;
}

async function selectTestRunAndFailures(runId) {
  const run = lastTestRuns.find((x) => x.Id === runId) || { Id: runId };
  setSelected({ kind: "ApexTestRun", ...run, loadingFailures: true });

  // ApexTestResult holds individual test outcomes for a run
  const soql = `
    SELECT Id, Outcome, ApexClass.Name, MethodName, Message, StackTrace, RunTime
    FROM ApexTestResult
    WHERE ApexTestRunId = '${runId}'
    AND (Outcome != 'Pass' OR Message != null)
    ORDER BY RunTime DESC
    LIMIT 50
  `.trim();

  setBusy(true, "Failures…");
  const { ok, status, json } = await sfFetch(`/query?q=${encodeURIComponent(soql)}`, { tooling: true });
  setBusy(false);

  if (!ok) {
    const msg = extractSfError(json);
    setSelected(`ApexTestResult query failed (HTTP ${status}):\n${msg}`);
    return;
  }

  const failures = json?.records || [];
  setSelected({
    kind: "ApexTestRun",
    runId,
    summary: {
      outcome: run.Outcome || run.Status || "—",
      testsRan: run.TestsRan,
      failures: run.Failures,
      start: run.StartTime,
      end: run.EndTime,
    },
    failureCount: failures.length,
    failures: failures.map((f) => ({
      outcome: f.Outcome,
      class: f.ApexClass?.Name,
      method: f.MethodName,
      message: f.Message,
      runtimeMs: f.RunTime,
      stack: f.StackTrace,
    })),
  });

  log(`Loaded ${failures.length} failing/non-pass test results for run ${runId}.`);
}

/* -------------------- Correlation: deployments ↔ test runs -------------------- */

function correlateDeploymentsToTests(deployments, testRuns) {
  deployToTest = new Map();

  const runs = (testRuns || []).map((r) => {
    const start = parseDate(r.StartTime);
    const end = parseDate(r.EndTime);
    const durMs = start ? ((end ? end - start : new Date() - start)) : null;
    const failures = Number(r.Failures || 0);
    const outcome = r.Outcome || r.Status || "Unknown";
    return {
      runId: r.Id,
      start,
      end,
      durationMs: durMs,
      failures,
      outcome,
      createdById: r.CreatedById,
      createdByName: r.CreatedBy?.Name,
      raw: r,
    };
  }).filter((x) => x.start);

  // Sort runs by start time descending for quick scanning
  runs.sort((a, b) => b.start - a.start);

  for (const d of deployments || []) {
    const created = parseDate(d.CreatedDate);
    const started = parseDate(d.StartDate) || created;
    const completed = parseDate(d.CompletedDate);
    if (!started) continue;

    // Window: +- 10 minutes around deployment start
    const windowMs = 10 * 60 * 1000;
    const lo = new Date(started.getTime() - windowMs);
    const hi = new Date((completed ? completed.getTime() : started.getTime()) + windowMs);

    const userId = d.CreatedById;

    let best = null;

    for (const r of runs) {
      if (r.start < lo) break; // runs are sorted desc; once below low, stop
      if (r.start > hi) continue;

      // scoring
      let score = 0;
      if (userId && r.createdById && userId === r.createdById) score += 3;

      // closeness
      const dt = Math.abs(r.start - started);
      if (dt < 2 * 60 * 1000) score += 3;
      else if (dt < 5 * 60 * 1000) score += 2;
      else score += 1;

      // prefer runs with explicit end time (finished)
      if (r.end) score += 1;

      if (!best || score > best.score) {
        best = { ...r, score };
      }
    }

    if (!best) continue;

    let confidence = "Low";
    if (best.score >= 6) confidence = "High";
    else if (best.score >= 4) confidence = "Medium";

    deployToTest.set(d.Id, {
      runId: best.runId,
      outcome: best.failures > 0 ? "Fail" : (String(best.outcome).match(/pass|success/i) ? "Pass" : best.outcome),
      failures: best.failures,
      durationMs: best.durationMs,
      confidence,
      runStart: best.start?.toISOString(),
      runEnd: best.end?.toISOString(),
      createdBy: best.createdByName,
    });
  }

  log(`Correlation updated: ${deployToTest.size} deployments matched to test runs.`);
}

/* -------------------- Packages -------------------- */

function pkgRowHtml(r) {
  const pkg = r.SubscriberPackage || {};
  const ver = r.SubscriberPackageVersion || {};
  const version = [ver.MajorVersion, ver.MinorVersion, ver.PatchVersion, ver.BuildNumber]
    .filter((x) => x !== null && x !== undefined)
    .join(".");
  return `
    <tr>
      <td>${pkg.Name || "—"}</td>
      <td class="mono">${pkg.NamespacePrefix || "—"}</td>
      <td class="mono">${version || "—"}</td>
    </tr>
  `.trim();
}

async function fetchPackages() {
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

  const tbody = $("packagesTbody");
  if (tbody) tbody.innerHTML = `<tr><td colspan="3" class="muted small">Loading…</td></tr>`;

  setBusy(true, "Packages…");
  const { ok, status, json } = await sfFetch(`/query?q=${encodeURIComponent(soql)}`, { tooling: true });
  setBusy(false);

  if (!ok) {
    const msg = extractSfError(json);
    log(`Packages query failed (HTTP ${status}): ${msg}`);
    if (tbody) tbody.innerHTML = `<tr><td colspan="3" class="muted small">Failed to load packages.</td></tr>`;
    setSelected(`Packages query failed:\n${msg}`);
    return;
  }

  const recs = json?.records || [];
  const q = ($("pkgSearch")?.value || "").trim().toLowerCase();

  const filtered = !q ? recs : recs.filter((r) => {
    const p = r.SubscriberPackage || {};
    const blob = `${p.Name || ""} ${p.NamespacePrefix || ""}`.toLowerCase();
    return blob.includes(q);
  });

  if (!filtered.length) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="3" class="muted small">No packages match your search.</td></tr>`;
    return;
  }

  if (tbody) tbody.innerHTML = filtered.map(pkgRowHtml).join("\n");
  log(`Packages refreshed (${filtered.length} rows).`);
}

/* -------------------- Package history discovery -------------------- */

async function discoverPackageHistorySources() {
  setBusy(true, "Discover…");
  const { ok, status, json } = await sfFetch(`/sobjects/`, { tooling: false });
  setBusy(false);

  if (!ok) {
    const msg = extractSfError(json);
    setText("packageHistoryPre", `Failed to list sObjects (HTTP ${status}):\n${msg}`);
    return;
  }

  const names = (json?.sobjects || []).map((s) => s.name).filter(Boolean);
  const candidates = names.filter((n) => /(package|install|subscriber|managed|unlocked|2gp|1gp)/i.test(n));

  setText(
    "packageHistoryPre",
    "Candidate objects (names only):\n\n" + candidates.sort().join("\n") +
      "\n\nNext step: pick the best candidate and query recent records for install events."
  );

  log(`Discovered ${candidates.length} candidate objects for package history.`);
}

/* -------------------- Deploy details placeholder -------------------- */

async function fetchDeployDetails() {
  const id = ($("metadataDeployIdInput")?.value || "").trim();
  if (!id) {
    setText("deployDetailsPre", "Paste a Metadata deploy async id first.");
    return;
  }
  setText(
    "deployDetailsPre",
    "Deploy details UI placeholder.\n\n" +
    "To implement this without Gearset APIs, you'd call Salesforce Metadata API deployStatus for the async id.\n" +
    "That requires SOAP Metadata API calls (not REST), so it's a bigger step.\n\n" +
    `Async id: ${id}`
  );
  log("Deploy details placeholder shown.");
}

/* -------------------- Refresh orchestration -------------------- */

async function refreshActiveTab(isPoll = false) {
  const active =
    $("tabDeployments")?.classList.contains("active") ? "deployments" :
    $("tabApexTests")?.classList.contains("active") ? "tests" :
    $("tabPackages")?.classList.contains("active") ? "packages" :
    $("tabPackageHistory")?.classList.contains("active") ? "history" :
    "details";

  // prevent overlap
  if (inFlight) {
    if (isPoll) lastPollSkipped = true;
    return;
  }

  try {
    if (active === "deployments") {
      $("deploymentsTbody").innerHTML = `<tr><td colspan="14" class="muted small">Loading…</td></tr>`;
      await fetchDeployments();
    } else if (active === "tests") {
      $("testsTbody").innerHTML = `<tr><td colspan="9" class="muted small">Loading…</td></tr>`;
      await refreshTests(false);
    } else if (active === "packages") {
      await fetchPackages();
    } else if (active === "history") {
      log("Package history: use Discover candidate objects.");
    } else {
      log("Deploy details: paste async id then Fetch.");
    }

    setLastRefreshed();
    if (isPoll && lastPollSkipped) log("Polling: one tick was skipped due to in-flight request.");
  } catch (e) {
    log(`Refresh error: ${e?.message || e}`);
  }
}

function clearStorageAndReload() {
  clearToken();
  clearSessionState();
  stopPolling();
  deployToTest = new Map();
  localStorage.removeItem(TOKEN_KEY);
  showBanner("");
  log("Cleared local + session storage. Reloading…");
  location.reload();
}

/* -------------------- Wiring -------------------- */

wireClick("loginBtn", login);
wireClick("logoutBtn", logout);
wireClick("refreshBtn", () => refreshActiveTab(false));
wireClick("clearStorageBtn", clearStorageAndReload);

wireClick("tabDeployments", async () => { showTab("deployments"); await refreshActiveTab(false); });
wireClick("tabApexTests", async () => { showTab("tests"); await refreshActiveTab(false); });
wireClick("tabPackages", async () => { showTab("packages"); await refreshActiveTab(false); });
wireClick("tabPackageHistory", async () => { showTab("history"); await refreshActiveTab(false); });
wireClick("tabDeployDetails", async () => { showTab("details"); await refreshActiveTab(false); });

wireChange("pollInterval", () => startPolling());
wireChange("deployFilter", debounce(() => refreshActiveTab(false), 0));
wireChange("deployLimit", debounce(() => refreshActiveTab(false), 0));
wireInput("deploySearch", debounce(() => {
  // re-render locally without round-trip
  const filtered = (lastDeployments || []).filter(passesDeployFilter).filter(passesDeploySearch);
  renderDeploymentsTable(filtered);
}, 200));

wireChange("testLimit", debounce(() => refreshTests(false), 0));
wireChange("testFilter", debounce(() => {
  const filtered = (lastTestRuns || []).filter(passesTestFilter).filter(passesTestSearch);
  renderTestsTable(filtered);
}, 0));
wireInput("testSearch", debounce(() => {
  const filtered = (lastTestRuns || []).filter(passesTestFilter).filter(passesTestSearch);
  renderTestsTable(filtered);
}, 200));
wireClick("refreshTestsBtn", () => refreshTests(false));

wireInput("pkgSearch", debounce(() => fetchPackages(), 200));
wireClick("refreshPackagesBtn", fetchPackages);

wireClick("discoverHistoryBtn", discoverPackageHistorySources);
wireClick("refreshHistoryBtn", () => log("History refresh placeholder. Use Discover first."));

wireClick("fetchDeployDetailsBtn", fetchDeployDetails);

/* -------------------- Init -------------------- */

(async function init() {
  setText("buildPill", BUILD);
  setText("apiPill", `v${API_VERSION}`);
  showBanner("");

  // default tab
  showTab("deployments");

  await handleRedirectIfPresent();

  const token = loadToken();
  if (token?.access_token) {
    setText("orgPill", token.instance_url || "Connected");
    log("Session restored (token found in localStorage).");

    // initial loads
    await refreshTests(true);  // prime correlation
    await fetchDeployments();
    setLastRefreshed();
    startPolling();
  } else {
    setText("orgPill", "Not connected");
    log("Not logged in.");
  }
})();
