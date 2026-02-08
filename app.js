// ====== CONFIG (edit these) ======
const CLIENT_ID = "3MVG9YFqzc_KnL.wada6.pbgp4zDPc8T6u6uR6srOVo1fS7XOD_kHsrDH_QurZzXeEgwzWBU365_xXQ54mMNn";
const LOGIN_DOMAIN = "https://gearsetcom-4bf-dev-ed.develop.my.salesforce.com"; // your org My Domain
// =================================

// Build label
const BUILD = "2026-02-08.2";

// Storage keys
const TOKEN_KEY = "sf_token";
const API_VER_KEY = "sf_api_version";

// Default API version
const DEFAULT_API_VERSION = "65.0";

/* -------------------- Helpers -------------------- */
function $(id){ return document.getElementById(id); }

function nowIso(){ return new Date().toISOString(); }

function setText(id, text){
  const el = $(id);
  if (el) el.textContent = text;
}

function showBanner(message){
  const b = $("authBanner");
  if (!b) return;
  b.textContent = message || "";
  b.style.display = message ? "block" : "none";
}

function log(msg){
  const el = $("logPre");
  if (!el) return;
  el.textContent = `[${nowIso()}] ${msg}\n` + el.textContent;
}

function setSelected(objOrText){
  const el = $("selectedPre");
  if (!el) return;
  el.textContent = typeof objOrText === "string" ? objOrText : JSON.stringify(objOrText, null, 2);
}

function getRedirectUri(){
  return window.location.origin + window.location.pathname;
}

/* -------------------- API version selection -------------------- */
function getApiVersion(){
  return localStorage.getItem(API_VER_KEY) || DEFAULT_API_VERSION;
}

function setApiVersion(v){
  localStorage.setItem(API_VER_KEY, v);
  setText("apiPill", `v${v}`);
}

function wireApiVersionSelect(){
  const sel = $("apiVersionSelect");
  if (!sel) return;

  // populate some common versions (adjust if you want)
  const versions = ["58.0","59.0","60.0","61.0","62.0","63.0","64.0","65.0"];
  sel.innerHTML = versions.map(v => `<option value="${v}">${v}</option>`).join("");
  sel.value = getApiVersion();

  sel.addEventListener("change", () => {
    setApiVersion(sel.value);
    log(`API version set to v${sel.value}`);
  });

  setText("apiPill", `v${getApiVersion()}`);
}

/* -------------------- Storage -------------------- */
function saveToken(token){ localStorage.setItem(TOKEN_KEY, JSON.stringify(token)); }
function loadToken(){
  const raw = localStorage.getItem(TOKEN_KEY);
  return raw ? JSON.parse(raw) : null;
}
function clearToken(){ localStorage.removeItem(TOKEN_KEY); }

/* -------------------- PKCE helpers -------------------- */
function base64UrlEncode(bytes){
  let bin = "";
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
}

async function sha256Base64Url(text){
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(digest));
}

function randomString(length=64){
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  return Array.from(bytes, b => chars[b % chars.length]).join("");
}

/* -------------------- OAuth (PKCE) -------------------- */
async function login(){
  if (!CLIENT_ID) {
    alert("Missing CLIENT_ID in auth.js");
    return;
  }

  const redirectUri = getRedirectUri();

  const verifier = randomString(96);
  const challenge = await sha256Base64Url(verifier);
  sessionStorage.setItem("pkce_verifier", verifier);

  const state = randomString(24);
  sessionStorage.setItem("oauth_state", state);

  const authUrl = new URL(`${LOGIN_DOMAIN}/services/oauth2/authorize`);
  authUrl.searchParams.set("response_type","code");
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope","refresh_token full");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method","S256");

  window.location.href = authUrl.toString();
}

async function handleRedirectIfPresent(){
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDesc = url.searchParams.get("error_description");

  if (error){
    showBanner(`OAuth error: ${error}${errorDesc ? " - " + errorDesc : ""}`);
    log(`OAuth error: ${error}${errorDesc ? " - " + errorDesc : ""}`);
    return false;
  }
  if (!code) return false;

  const expected = sessionStorage.getItem("oauth_state");
  if (!expected || state !== expected){
    showBanner("State mismatch. Aborting.");
    log("State mismatch. Aborting.");
    return false;
  }

  const verifier = sessionStorage.getItem("pkce_verifier");
  if (!verifier){
    showBanner("Missing PKCE verifier. Aborting.");
    log("Missing PKCE verifier. Aborting.");
    return false;
  }

  // clean URL
  url.searchParams.delete("code");
  url.searchParams.delete("state");
  window.history.replaceState({}, document.title, url.toString());

  // token exchange
  const tokenUrl = `${LOGIN_DOMAIN}/services/oauth2/token`;
  const body = new URLSearchParams();
  body.set("grant_type","authorization_code");
  body.set("client_id", CLIENT_ID);
  body.set("redirect_uri", getRedirectUri());
  body.set("code", code);
  body.set("code_verifier", verifier);

  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type":"application/x-www-form-urlencoded" },
    body: body.toString()
  });

  const json = await resp.json().catch(() => null);
  sessionStorage.removeItem("pkce_verifier");
  sessionStorage.removeItem("oauth_state");

  if (!resp.ok){
    const msg = json?.error_description || json?.error || `HTTP ${resp.status}`;
    showBanner(`Token error: ${msg}`);
    log(`Token exchange failed: ${msg}`);
    return false;
  }

  saveToken(json);
  showBanner("");

  setText("orgPill", json.instance_url || "Connected");
  setText("buildPill", BUILD);
  setText("apiPill", `v${getApiVersion()}`);

  log("Logged in. Token stored (includes refresh_token if your Connected App allows it).");
  setSelected(redactTokenForDisplay(json));
  return true;
}

function redactTokenForDisplay(token){
  if (!token) return token;
  const t = { ...token };
  if (t.access_token) t.access_token = "(redacted)";
  if (t.refresh_token) t.refresh_token = "(redacted)";
  if (t.id_token) t.id_token = "(redacted)";
  return t;
}

async function logout(){
  clearToken();
  showBanner("");
  setText("orgPill", "Not connected");
  setSelected("Nothing selected.");
  log("Logged out.");
}

/* -------------------- Refresh token (401 fix) -------------------- */
async function refreshAccessToken(){
  const t = loadToken();
  if (!t?.refresh_token){
    return { ok: false, reason: "no_refresh_token" };
  }

  const tokenUrl = `${LOGIN_DOMAIN}/services/oauth2/token`;
  const body = new URLSearchParams();
  body.set("grant_type","refresh_token");
  body.set("client_id", CLIENT_ID);
  body.set("refresh_token", t.refresh_token);

  const resp = await fetch(tokenUrl, {
    method:"POST",
    headers:{ "Content-Type":"application/x-www-form-urlencoded" },
    body: body.toString()
  });

  const json = await resp.json().catch(() => null);
  if (!resp.ok){
    const msg = json?.error_description || json?.error || `HTTP ${resp.status}`;
    log(`Refresh failed: ${msg}`);
    return { ok:false, reason: msg };
  }

  // Salesforce typically returns a new access_token + instance_url; refresh_token may be omitted (keep old)
  const merged = { ...t, ...json };
  if (!merged.refresh_token) merged.refresh_token = t.refresh_token;

  saveToken(merged);
  setText("orgPill", merged.instance_url || "Connected");
  log("Access token refreshed.");
  return { ok:true, token: merged };
}

/* -------------------- REST fetch wrapper -------------------- */
function requireToken(){
  const t = loadToken();
  if (!t?.access_token || !t?.instance_url) return null;
  return t;
}

function extractSfError(json){
  if (!json) return "Unknown error";
  if (Array.isArray(json) && json[0]?.message) return json[0].message;
  if (json?.message) return json.message;
  if (json?.error_description) return json.error_description;
  if (json?.error) return json.error;
  return JSON.stringify(json);
}

async function sfFetch(path, { tooling=false, method="GET", headers={}, body=null, retry=true } = {}){
  const t = requireToken();
  if (!t){
    showBanner("Not logged in. Click Login.");
    return { ok:false, status:0, json:null };
  }

  const v = getApiVersion();
  const base = tooling
    ? `${t.instance_url}/services/data/v${v}/tooling`
    : `${t.instance_url}/services/data/v${v}`;
  const url = `${base}${path}`;

  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${t.access_token}`,
      ...headers
    },
    body
  });

  const json = await resp.json().catch(() => null);

  if (resp.status === 401 && retry){
    log("HTTP 401 received. Attempting refresh_token flow…");
    const r = await refreshAccessToken();
    if (r.ok){
      return sfFetch(path, { tooling, method, headers, body, retry:false });
    }
    showBanner("Session expired/invalid. Click Login again.");
    return { ok:false, status:401, json };
  }

  if (!resp.ok){
    log(`SF request failed (HTTP ${resp.status}): ${extractSfError(json)}`);
  }

  return { ok: resp.ok, status: resp.status, json };
}

/* -------------------- Exported to window -------------------- */
window.Auth = {
  BUILD,
  CLIENT_ID,
  LOGIN_DOMAIN,
  login,
  logout,
  handleRedirectIfPresent,
  loadToken,
  redactTokenForDisplay,
  sfFetch,
  getApiVersion,
  setApiVersion,
  wireApiVersionSelect,
  log,
  setSelected,
  setText,
  showBanner,
  extractSfError
};
