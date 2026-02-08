// ====== CONFIG (edit these) ======
const CLIENT_ID = "3MVG9YFqzc_KnL.wada6.pbgp4zDPc8T6u6uR6srOVo1fS7XOD_kHsrDH_QurZzXeEgwzWBU365_xXQ54mMNn";
const LOGIN_DOMAIN = "https://gearsetcom-4bf-dev-ed.develop.my.salesforce.com";
const API_VERSION = "65.0";
// ========================================

const TOKEN_KEY = "sf_token";

/* ---------------- utilities ---------------- */

const $ = (id) => document.getElementById(id);

function log(msg) {
  const el = $("logPre");
  if (!el) return;
  el.textContent = `[${new Date().toISOString()}] ${msg}\n` + el.textContent;
}

function setStatus(msg) {
  const el = $("statusPre") || $("logPre");
  if (el) el.textContent = msg;
}

/* ---------------- storage ---------------- */

function saveToken(t) {
  localStorage.setItem(TOKEN_KEY, JSON.stringify(t));
}

function loadToken() {
  const raw = localStorage.getItem(TOKEN_KEY);
  return raw ? JSON.parse(raw) : null;
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.clear();
}

/* ---------------- PKCE helpers ---------------- */

function randomString(len = 64) {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

function base64UrlEncode(bytes) {
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Base64Url(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(digest));
}

function redirectUri() {
  return window.location.origin + window.location.pathname.replace(/index\.html$/i, "");
}

/* ---------------- OAuth ---------------- */

async function login() {
  const verifier = randomString(96);
  const challenge = await sha256Base64Url(verifier);
  const state = randomString(24);

  sessionStorage.setItem("pkce_verifier", verifier);
  sessionStorage.setItem("oauth_state", state);

  const url = new URL(`${LOGIN_DOMAIN}/services/oauth2/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("scope", "refresh_token full");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  window.location.href = url.toString();
}

async function handleRedirect() {
  const u = new URL(window.location.href);
  const code = u.searchParams.get("code");
  const state = u.searchParams.get("state");
  if (!code) return;

  if (state !== sessionStorage.getItem("oauth_state")) {
    setStatus("OAuth state mismatch");
    return;
  }

  const verifier = sessionStorage.getItem("pkce_verifier");

  u.searchParams.delete("code");
  u.searchParams.delete("state");
  history.replaceState({}, document.title, u.toString());

  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("client_id", CLIENT_ID);
  body.set("redirect_uri", redirectUri());
  body.set("code", code);
  body.set("code_verifier", verifier);

  const resp = await fetch(`${LOGIN_DOMAIN}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const json = await resp.json();
  if (!resp.ok) {
    setStatus(`Token error: ${json.error}`);
    return;
  }

  saveToken(json);
  $("orgPill") && ($("orgPill").textContent = json.instance_url);
  $("apiPill") && ($("apiPill").textContent = `v${API_VERSION}`);
  log("Logged in");
}

/* ---------------- REST helpers ---------------- */

async function sfFetch(path, tooling = false) {
  const token = loadToken();
  if (!token?.access_token || !token?.instance_url)
    throw new Error("Not logged in");

  const base = tooling
    ? `${token.instance_url}/services/data/v${API_VERSION}/tooling`
    : `${token.instance_url}/services/data/v${API_VERSION}`;

  const resp = await fetch(base + path, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });

  const json = await resp.json();
  if (!resp.ok) throw new Error(json[0]?.message || json.message);
  return json;
}

/* ---------------- Deployments ---------------- */

function msToDuration(ms) {
  if (!ms) return "—";
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

async function loadDeployments() {
  const soql = `
    SELECT Id, Status, Type, CheckOnly,
           CreatedDate, StartDate, CompletedDate,
           CreatedBy.Name
    FROM DeployRequest
    ORDER BY CreatedDate DESC
    LIMIT 20
  `;
  const res = await sfFetch(`/query?q=${encodeURIComponent(soql)}`, true);

  const tbody = $("deploymentsTbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  res.records.forEach((r) => {
    const c = new Date(r.CreatedDate);
    const s = r.StartDate ? new Date(r.StartDate) : null;
    const d = r.CompletedDate ? new Date(r.CompletedDate) : null;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.Status}</td>
      <td>${r.CreatedBy?.Name || "—"}</td>
      <td>${r.Type}${r.CheckOnly ? " (checkOnly)" : ""}</td>
      <td>${c.toISOString()}</td>
      <td>${s ? s.toISOString() : "—"}</td>
      <td>${d ? d.toISOString() : "—"}</td>
      <td>${msToDuration(s && c ? s - c : null)}</td>
      <td>${msToDuration(d && s ? d - s : null)}</td>
      <td>${msToDuration(d && c ? d - c : null)}</td>
      <td>${r.Id}</td>
    `;
    tbody.appendChild(tr);
  });

  log(`Loaded ${res.records.length} deployments`);
}

/* ---------------- Apex Tests ---------------- */

async function loadApexTests() {
  const soql = `
    SELECT Id, Status, StartTime, EndTime,
           MethodsCompleted, MethodsFailed,
           CreatedBy.Name
    FROM ApexTestRunResult
    ORDER BY StartTime DESC
    LIMIT 20
  `;
  const res = await sfFetch(`/query?q=${encodeURIComponent(soql)}`, true);

  const tbody = $("testsTbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  res.records.forEach((r) => {
    const s = r.StartTime ? new Date(r.StartTime) : null;
    const e = r.EndTime ? new Date(r.EndTime) : null;
    const dur = s && e ? e - s : null;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.Status}</td>
      <td>${r.CreatedBy?.Name || "—"}</td>
      <td>${s ? s.toISOString() : "—"}</td>
      <td>${e ? e.toISOString() : "—"}</td>
      <td>${msToDuration(dur)}</td>
      <td>${r.MethodsCompleted || 0}</td>
      <td>${r.MethodsFailed || 0}</td>
      <td>${r.Id}</td>
    `;
    tbody.appendChild(tr);
  });

  log(`Loaded ${res.records.length} Apex test runs`);
}

/* ---------------- Tabs ---------------- */

function showTab(name) {
  ["deployments", "tests"].forEach((t) => {
    const p = $(`${t}Panel`);
    if (p) p.style.display = t === name ? "" : "none";
  });
}

/* ---------------- wiring ---------------- */

$("loginBtn")?.addEventListener("click", login);
$("logoutBtn")?.addEventListener("click", () => {
  clearToken();
  location.reload();
});

$("tabDeployments")?.addEventListener("click", () => {
  showTab("deployments");
  loadDeployments();
});

$("tabTests")?.addEventListener("click", () => {
  showTab("tests");
  loadApexTests();
});

/* ---------------- init ---------------- */

(async function init() {
  try {
    await handleRedirect();
    const t = loadToken();
    if (t) {
      $("orgPill") && ($("orgPill").textContent = t.instance_url);
      $("apiPill") && ($("apiPill").textContent = `v${API_VERSION}`);
      await loadDeployments();
      log("Session restored");
    } else {
      log("Not logged in");
    }
  } catch (e) {
    log(`Init error: ${e.message}`);
  }
})();
