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
  const el = $("logPre");
  if (!el) return;
  const stamp = nowIso();
  el.textContent = `[${stamp}] ${msg}\n` + el.textContent;
}

function setSelected(objOrText) {
  const el = $("selectedPre");
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

  log("Logged in. Token stored in localStorage.");
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

  show($("deploymentsControls"), tab === "deployments");
  show($("apexTestsControls"), tab === "tests");
  show($("packagesControls"), tab === "packages");
  show($("packageHistoryControls"), tab === "history");
  show($("deployDetailsControls"), tab === "details");

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
  if (["inprogress", "in progress", "queued", "pending"]()
