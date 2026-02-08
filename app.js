// ====== CONFIG (edit these) ======
const CLIENT_ID = "3MVG9YFqzc_KnL.wada6.pbgp4zDPc8T6u6uR6srOVo1fS7XOD_kHsrDH_QurZzXeEgwzWBU365_xXQ54mMNn";
const LOGIN_DOMAIN = "https://gearsetcom-4bf-dev-ed.develop.my.salesforce.com";
const API_VERSION = "65.0";
// =================================

const TOKEN_KEY = "sf_token";
let pollTimer = null;

/* -------------------- basic helpers -------------------- */

function el(id) {
  return document.getElementById(id);
}

function setText(id, text) {
  const e = el(id);
  if (e) e.textContent = text;
}

function log(msg) {
  const e = el("logPre");
  if (!e) return;
  const ts = new Date().toISOString();
  e.textContent = `[${ts}] ${msg}\n` + e.textContent;
}

function setStatus(msg) {
  const e = el("selectedPre") || el("logPre");
  if (e) e.textContent = msg;
}

/* -------------------- storage -------------------- */

function saveToken(t) {
  localStorage.setItem(TOKEN_KEY, JSON.stringify(t));
}

function loadToken() {
  const raw = localStorage.getItem(TOKEN_KEY);
  return raw ? JSON.parse(raw) : null;
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem("pkce_verifier");
  sessionStorage.removeItem("oauth_state");
}

/* -------------------- PKCE -------------------- */

function randomString(len = 64) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => chars[b % chars.length]).join("");
}

function base64UrlEncode(bytes) {
  let bin = "";
  bytes.forEach(b => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Base64Url(str) {
  const data = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(digest));
}

function redirectUri() {
  return window.location.origin + window.location.pathname;
}

/* -------------------- OAuth -------------------- */

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
    body: body.toString()
  });

  const json = await resp.json();
  if (!resp.ok) {
    setStatus(`Token error: ${json.error}`);
    return;
  }

  saveToken(json);
  setText("orgPill", json.instance_url);
  setText("apiPill", `v${API_VERSION}`);
  log("Logged in successfully");
}

/* -------------------- REST helper -------------------- */

async function sfFetch(path, tooling = false) {
  const token = loadToken();
  if (!token) throw new Error("Not logged in");

  const base = tooling
    ? `${token.instance_url}/services/data/v${API_VERSION}/tooling`
    : `${token.instance_url}/services/data/v${API_VERSION}`;

  const r = await fetch(base + path, {
    headers: { Authorization: `Bearer ${token.access_token}` }
  });

  const j = await r.json();
  if (!r.ok) throw new Error(j[0]?.message || j.message);
  return j;
}

/* -------------------- Deployments -------------------- */

function fmt(ms) {
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

  const tbody = el("deploymentsTbody");
  tbody.innerHTML = "";

  res.records.forEach(r => {
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
      <td>${fmt(s && c ? s - c : null)}</td>
      <td>${fmt(d && s ? d - s : null)}</td>
      <td>${fmt(d && c ? d - c : null)}</td>
      <td>${r.Id}</td>
    `;
    tbody.appendChild(tr);
  });

  log(`Loaded ${res.records.length} deployments`);
}

/* -------------------- Packages -------------------- */

async function loadPackages() {
  const soql = `
    SELECT SubscriberPackage.Name,
           SubscriberPackage.NamespacePrefix,
           SubscriberPackageVersion.MajorVersion,
           SubscriberPackageVersion.MinorVersion,
           SubscriberPackageVersion.PatchVersion,
           SubscriberPackageVersion.BuildNumber
    FROM InstalledSubscriberPackage
    ORDER BY SubscriberPackage.Name
  `;
  const res = await sfFetch(`/query?q=${encodeURIComponent(soql)}`, true);

  const tbody = el("packagesTbody");
  tbody.innerHTML = "";

  res.records.forEach(r => {
    const v = r.SubscriberPackageVersion;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.SubscriberPackage.Name}</td>
      <td>${r.SubscriberPackage.NamespacePrefix || "—"}</td>
      <td>${v.MajorVersion}.${v.MinorVersion}.${v.PatchVersion}.${v.BuildNumber}</td>
    `;
    tbody.appendChild(tr);
  });

  log(`Loaded ${res.records.length} packages`);
}

/* -------------------- Tabs -------------------- */

function showTab(name) {
  ["deployments","packages","packageHistory","deployDetails"].forEach(t => {
    const panel = el(t + "Panel");
    if (panel) panel.style.display = t === name ? "" : "none";
  });
}

/* -------------------- wiring -------------------- */

el("loginBtn")?.addEventListener("click", login);
el("logoutBtn")?.addEventListener("click", () => {
  clearToken();
  location.reload();
});

el("tabDeployments")?.addEventListener("click", () => {
  showTab("deployments");
  loadDeployments();
});

el("tabPackages")?.addEventListener("click", () => {
  showTab("packages");
  loadPackages();
});

/* -------------------- init -------------------- */

(async function init() {
  try {
    await handleRedirect();
    const t = loadToken();
    if (t) {
      setText("orgPill", t.instance_url);
      setText("apiPill", `v${API_VERSION}`);
      await loadDeployments();
      log("Session restored");
    } else {
      log("Not logged in");
    }
  } catch (e) {
    log(`Init error: ${e.message}`);
  }
})();
