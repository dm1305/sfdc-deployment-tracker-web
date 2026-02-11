// ====== CONFIG ======
const CLIENT_ID = "3MVG9YFqzc_KnL.wada6.pbgp4zDPc8T6u6uR6srOVo1fS7XOD_kHsrDH_QurZzXeEgwzWBU365_xXQ54mMNn";
const LOGIN_DOMAIN = "https://gearsetcom-4bf-dev-ed.develop.my.salesforce.com";
const API_VERSION = "65.0";
// =====================

const TOKEN_KEY = "sf_token";

function log(msg) {
  const el = document.getElementById("logPre");
  const stamp = new Date().toISOString();
  el.textContent = `[${stamp}] ${msg}\n` + el.textContent;
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
  return window.location.origin + window.location.pathname;
}

async function login() {
  const redirectUri = getRedirectUri();
  const authUrl = new URL(`${LOGIN_DOMAIN}/services/oauth2/authorize`);
  authUrl.searchParams.set("response_type", "token");
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  window.location.href = authUrl.toString();
}

function handleHashLogin() {
  if (!window.location.hash) return;
  const params = new URLSearchParams(window.location.hash.substring(1));
  const access_token = params.get("access_token");
  const instance_url = params.get("instance_url");
  if (access_token && instance_url) {
    saveToken({ access_token, instance_url });
    log("Logged in.");
    window.location.hash = "";
  }
}

async function sfFetch(path) {
  const token = loadToken();
  if (!token) {
    log("Not logged in.");
    return null;
  }
  const url = `${token.instance_url}/services/data/v${API_VERSION}${path}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token.access_token}` }
  });
  if (!resp.ok) {
    log("API error: " + resp.status);
    return null;
  }
  return resp.json();
}

async function fetchDeployments() {
  const soql = `
    SELECT Id, Status, Type, CreatedDate, StartDate, CompletedDate, CreatedBy.Name
    FROM DeployRequest
    ORDER BY CreatedDate DESC
    LIMIT 20
  `;
  const result = await sfFetch(`/tooling/query?q=${encodeURIComponent(soql)}`);
  if (!result) return;

  const tbody = document.getElementById("deploymentsTbody");
  tbody.innerHTML = result.records.map(r => `
    <tr>
      <td>${r.Status}</td>
      <td>${r.CreatedBy?.Name || ""}</td>
      <td>${r.Type}</td>
      <td>${r.CreatedDate || ""}</td>
      <td>${r.StartDate || ""}</td>
      <td>${r.CompletedDate || ""}</td>
    </tr>
  `).join("");
  log("Deployments refreshed.");
}

function logout() {
  clearToken();
  log("Logged out.");
}

document.getElementById("loginBtn").addEventListener("click", login);
document.getElementById("logoutBtn").addEventListener("click", logout);
document.getElementById("refreshBtn").addEventListener("click", fetchDeployments);

handleHashLogin();
