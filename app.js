// ====== CONFIG (edit these) ======
const CLIENT_ID = "3MVG9YFqzc_KnL.wada6.pbgp4zDPc8T6u6uR6srOVo1fS7XOD_kHsrDH_QurZzXeEgwzWBU365_xXQ54mMNn";
const LOGIN_DOMAIN = "https://gearsetcom-4bf-dev-ed.develop.my.salesforce.com"; // your sandbox My Domain
// =================================

const TOKEN_KEY = "sf_token";

function base64UrlEncode(bytes) {
  let bin = "";
  bytes.forEach(b => (bin += String.fromCharCode(b)));
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
  return Array.from(bytes, b => chars[b % chars.length]).join("");
}

function setStatus(msg) {
  document.getElementById("status").textContent = msg;
}

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

function getRedirectUri() {
  // This is the URL of your GitHub Pages site (same origin as the page)
  // Example: https://dm1305.github.io/sfdc-deployment-tracker-web/
  return window.location.origin + window.location.pathname;
}

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
    setStatus(`OAuth error: ${error}${errorDesc ? " - " + errorDesc : ""}`);
    return;
  }

  if (!code) return; // not a redirect back from OAuth

  const expectedState = sessionStorage.getItem("oauth_state");
  if (!expectedState || state !== expectedState) {
    setStatus("State mismatch. Aborting.");
    return;
  }

  const verifier = sessionStorage.getItem("pkce_verifier");
  if (!verifier) {
    setStatus("Missing PKCE verifier. Aborting.");
    return;
  }

  // Clean URL (remove code/state from address bar)
  url.searchParams.delete("code");
  url.searchParams.delete("state");
  window.history.replaceState({}, document.title, url.toString());

  // Exchange code for token
  const redirectUri = getRedirectUri();
  const tokenUrl = `${LOGIN_DOMAIN}/services/oauth2/token`;

  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("client_id", CLIENT_ID);
  body.set("redirect_uri", redirectUri);
  body.set("code", code);
  body.set("code_verifier", verifier);

  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const json = await resp.json().catch(() => null);
  if (!resp.ok) {
    setStatus(`Token exchange failed: ${json?.error_description || json?.error || resp.status}`);
    return;
  }

  saveToken(json);
  setStatus("Logged in ✅ Token stored in localStorage.\n" + JSON.stringify(json, null, 2));
}

async function logout() {
  clearToken();
  setStatus("Logged out.");
}

document.getElementById("loginBtn").addEventListener("click", login);
document.getElementById("logoutBtn").addEventListener("click", logout);

// On load
(async function init() {
  await handleRedirectIfPresent();
  const token = loadToken();
  if (token && !document.getElementById("status").textContent.includes("Logged in")) {
    setStatus("Already logged in ✅ Token loaded from localStorage.");
  }
})();
