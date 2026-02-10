/* auth.js - stable SPA auth + API helper (PKCE)
   Build: 2026-02-09.15
   Stores:
     localStorage.sfdc_client_id
     localStorage.sfdc_login_host
     localStorage.sfdc_api_version
     sessionStorage.sfdc_pkce_verifier
     sessionStorage.sfdc_oauth_state
     localStorage.sfdc_access_token
     localStorage.sfdc_instance_url
*/

(function() {
  const LS = {
    clientId: "sfdc_client_id",
    loginHost: "sfdc_login_host",
    apiVersion: "sfdc_api_version",
    accessToken: "sfdc_access_token",
    instanceUrl: "sfdc_instance_url",
    lastAuthAt: "sfdc_last_auth_at"
  };
  const SS = {
    verifier: "sfdc_pkce_verifier",
    state: "sfdc_oauth_state"
  };

  function qs(name) {
    const u = new URL(location.href);
    return u.searchParams.get(name);
  }

  function b64url(bytes) {
    let s = btoa(String.fromCharCode.apply(null, bytes));
    return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  async function sha256(str) {
    const enc = new TextEncoder().encode(str);
    const hash = await crypto.subtle.digest("SHA-256", enc);
    return new Uint8Array(hash);
  }

  function randString(len=64) {
    const arr = new Uint8Array(len);
    crypto.getRandomValues(arr);
    return b64url(arr);
  }

  function canonicalRedirectUri() {
    // Always normalize to the repo root folder URL (trailing slash).
    // This avoids redirect_uri_mismatch when jumping between index/inventory/workbench.
    return new URL("./", location.href).href;
  }

  function getClientId() {
    return (localStorage.getItem(LS.clientId) || "").trim();
  }

  function getLoginHost() {
    return (localStorage.getItem(LS.loginHost) || "").trim() || "login.salesforce.com";
  }

  function getApiVersion() {
    return (localStorage.getItem(LS.apiVersion) || "").trim() || "60.0";
  }

  function setBanner(msg, kind="error") {
    const el = document.getElementById("authBanner");
    if (!el) return;
    if (!msg) {
      el.style.display = "none";
      el.textContent = "";
      el.classList.remove("warn","ok","error");
      return;
    }
    el.style.display = "block";
    el.textContent = msg;
    el.classList.remove("warn","ok","error");
    el.classList.add(kind === "ok" ? "ok" : kind === "warn" ? "warn" : "error");
  }

  function ensureSettings() {
    const clientId = getClientId();
    if (clientId) return true;

    // Lightweight: prompt the first time (keeps UI stable).
    const entered = prompt("Missing Client ID. Paste your Salesforce Connected App Consumer Key (Client Id):");
    if (!entered) return false;
    localStorage.setItem(LS.clientId, entered.trim());
    return true;
  }

  async function startLogin() {
    if (!ensureSettings()) return;

    const clientId = getClientId();
    const loginHost = getLoginHost();
    const redirectUri = canonicalRedirectUri();

    const verifier = randString(64);
    const challenge = b64url(await sha256(verifier));

    // Preserve where the user was.
    const returnTo = location.pathname + location.search + location.hash;
    const stateObj = {
      nonce: randString(24),
      returnTo
    };
    const state = b64url(new TextEncoder().encode(JSON.stringify(stateObj)));

    sessionStorage.setItem(SS.verifier, verifier);
    sessionStorage.setItem(SS.state, state);

    const authUrl = new URL(`https://${loginHost}/services/oauth2/authorize`);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("scope", "api id"); // keep minimal
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("prompt", "login");

    location.assign(authUrl.toString());
  }

  async function completeLoginFromRedirect() {
    const code = qs("code");
    const err = qs("error");
    const errDesc = qs("error_description");

    if (err) {
      setBanner(`OAuth error: ${decodeURIComponent(err)} ${errDesc ? " - " + decodeURIComponent(errDesc) : ""}`, "error");
      return false;
    }
    if (!code) return false;

    const state = qs("state") || "";
    const expectedState = sessionStorage.getItem(SS.state) || "";
    if (!expectedState || state !== expectedState) {
      setBanner("OAuth state mismatch. Click Login again.", "error");
      return false;
    }

    const verifier = sessionStorage.getItem(SS.verifier);
    if (!verifier) {
      setBanner("Missing PKCE verifier. Click Login again.", "error");
      return false;
    }

    const clientId = getClientId();
    const loginHost = getLoginHost();
    const redirectUri = canonicalRedirectUri();

    setBanner("Completing login…", "warn");

    const tokenUrl = `https://${loginHost}/services/oauth2/token`;
    const body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("client_id", clientId);
    body.set("code", code);
    body.set("redirect_uri", redirectUri);
    body.set("code_verifier", verifier);

    let json;
    try {
      const resp = await fetch(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
      });
      const text = await resp.text();
      try { json = JSON.parse(text); } catch { json = { error: "parse_error", raw: text }; }
      if (!resp.ok) {
        throw new Error(json.error_description || json.error || `Token exchange failed (${resp.status})`);
      }
    } catch (e) {
      setBanner(`Auth failed during token exchange. If you see a NetworkError, verify login host and that the Connected App allows this callback: ${redirectUri}. Details: ${e.message}`, "error");
      return false;
    }

    localStorage.setItem(LS.accessToken, json.access_token);
    localStorage.setItem(LS.instanceUrl, json.instance_url);
    localStorage.setItem(LS.lastAuthAt, new Date().toISOString());

    sessionStorage.removeItem(SS.verifier);
    sessionStorage.removeItem(SS.state);

    // Clean the URL (remove code/state)
    const u = new URL(location.href);
    u.searchParams.delete("code");
    u.searchParams.delete("state");
    u.searchParams.delete("error");
    u.searchParams.delete("error_description");
    history.replaceState(null, "", u.toString());

    // Return to original page.
    try {
      const stateObj = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(state.replace(/-/g,"+").replace(/_/g,"/")), c=>c.charCodeAt(0))));
      if (stateObj && stateObj.returnTo && stateObj.returnTo !== (location.pathname + location.search + location.hash)) {
        location.replace(stateObj.returnTo);
        return true;
      }
    } catch (_) {}

    setBanner("", "ok");
    return true;
  }

  function isLoggedIn() {
    return !!localStorage.getItem(LS.accessToken) && !!localStorage.getItem(LS.instanceUrl);
  }

  function logout() {
    localStorage.removeItem(LS.accessToken);
    localStorage.removeItem(LS.instanceUrl);
    setBanner("Logged out (local token cleared).", "ok");
    renderAuthButtons();
  }

  function renderAuthButtons() {
    const loginBtn = document.getElementById("loginBtn");
    const logoutBtn = document.getElementById("logoutBtn");
    if (loginBtn) loginBtn.style.display = isLoggedIn() ? "none" : "";
    if (logoutBtn) logoutBtn.style.display = isLoggedIn() ? "" : "none";
  }

  async function sfFetch(path, opts={}) {
    if (!isLoggedIn()) throw new Error("Not logged in.");
    const base = localStorage.getItem(LS.instanceUrl);
    const url = new URL(path, base).toString();

    const headers = Object.assign({}, opts.headers || {});
    headers["Authorization"] = "Bearer " + localStorage.getItem(LS.accessToken);
    headers["Accept"] = "application/json";

    const resp = await fetch(url, Object.assign({}, opts, { headers }));
    if (resp.status === 401) {
      logout();
      throw new Error("Session expired (401). Click Login.");
    }
    const text = await resp.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    if (!resp.ok) {
      const msg = json && (json[0]?.message || json.message || json.error_description || json.error) ? (json[0]?.message || json.message || json.error_description || json.error) : `Request failed (${resp.status})`;
      throw new Error(msg);
    }
    return json;
  }

  async function loadOrgContext() {
    const apiV = getApiVersion();
    const pills = {
      orgPill: "Not connected",
      instancePill: "—",
      orgIdPill: "—",
      userPill: "—",
      apiPill: "v" + apiV,
      apiMaxPill: "—",
      buildPill: "2026-02-09.15"
    };

    const instance = localStorage.getItem(LS.instanceUrl);
    if (instance) pills.instancePill = instance;

    const setText = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };

    Object.entries(pills).forEach(([k,v]) => setText(k, v));

    if (!isLoggedIn()) return;

    try {
      const me = await sfFetch(`/services/data/v${apiV}/chatter/users/me`);
      const orgId = me?.organizationId || me?.organization?.id || "—";
      const user = me?.name || me?.displayName || me?.username || "—";
      setText("orgPill", "Connected");
      setText("orgIdPill", orgId);
      setText("userPill", user);

      const limits = await sfFetch(`/services/data/v${apiV}/limits`);
      const api = limits?.DailyApiRequests || limits?.DailyApiRequestsMax;
      if (limits?.DailyApiRequests) {
        setText("apiMaxPill", `${limits.DailyApiRequests.Max}`);
      }
    } catch (e) {
      // Often CORS whitelist not configured. Show actionable banner.
      setBanner(`Connected, but API calls failed. If you see CORS errors in DevTools, add this origin in Salesforce Setup → CORS: ${location.origin}. Details: ${e.message}`, "warn");
    }
  }

  function initApiVersionSelect() {
    const sel = document.getElementById("apiVersionSelect");
    if (!sel) return;
    const current = getApiVersion();
    sel.innerHTML = "";
    ["40.0","45.0","50.0","55.0","56.0","57.0","58.0","59.0","60.0"].forEach(v => {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = "v" + v;
      if (v === current) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener("change", () => {
      localStorage.setItem(LS.apiVersion, sel.value);
      loadOrgContext();
    });
  }

  async function init() {
    initApiVersionSelect();
    renderAuthButtons();

    const loginBtn = document.getElementById("loginBtn");
    if (loginBtn) loginBtn.addEventListener("click", startLogin);

    const logoutBtn = document.getElementById("logoutBtn");
    if (logoutBtn) logoutBtn.addEventListener("click", logout);

    const clearBtn = document.getElementById("clearStorageBtn");
    if (clearBtn) clearBtn.addEventListener("click", () => {
      if (!confirm("Clear local storage (tokens/settings)?")) return;
      Object.values(LS).forEach(k => localStorage.removeItem(k));
      setBanner("Storage cleared.", "ok");
      renderAuthButtons();
      loadOrgContext();
    });

    await completeLoginFromRedirect();
    await loadOrgContext();
  }

  window.Auth = {
    keys: LS,
    init,
    isLoggedIn,
    login: startLogin,
    logout,
    sfFetch,
    getApiVersion,
    getLoginHost,
    getClientId,
    canonicalRedirectUri,
    setBanner
  };
})();
