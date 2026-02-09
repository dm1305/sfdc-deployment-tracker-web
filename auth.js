// auth.js (FULL FILE - UPDATED)
// Fixes:
// - Wires login/logout/refresh/clear/org/errors buttons on DOM ready (so buttons always work)
// - Hides Login when logged in; hides Logout when logged out
// - Keeps top pills in sync
// - Keeps existing PKCE flow + sfFetch helpers (minimal but solid)

window.Auth = (function () {
  // ====== CONFIG (edit these) ======
  const CLIENT_ID = "3MVG9YFqzc_KnL.wada6.pbgp4zDPc8T6u6uR6srOVo1fS7XOD_kHsrDH_QurZzXeEgwzWBU365_xXQ54mMNn";
  const LOGIN_DOMAIN = "https://gearsetcom-4bf-dev-ed.develop.my.salesforce.com";
  // =================================

  const BUILD = "2026-02-09.4";
  const TOKEN_KEY = "sf_token";

  // Default API version; can be changed via selector
  let API_VERSION = "65.0";

  // Error store
  const errors = [];

  function $(id) { return document.getElementById(id); }
  function setText(id, t) { const el = $(id); if (el) el.textContent = t; }
  function show(el, on) { if (!el) return; el.style.display = on ? "" : "none"; }

  function showBanner(msg) {
    const b = $("authBanner");
    if (!b) return;
    b.textContent = msg || "";
    b.style.display = msg ? "block" : "none";
  }

  function loadToken() {
    const raw = localStorage.getItem(TOKEN_KEY);
    return raw ? JSON.parse(raw) : null;
  }

  function saveToken(t) { localStorage.setItem(TOKEN_KEY, JSON.stringify(t)); }
  function clearToken() { localStorage.removeItem(TOKEN_KEY); }

  function getRedirectUri() {
    return window.location.origin + window.location.pathname;
  }

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

  function setAuthUi() {
    const token = loadToken();
    const loggedIn = !!(token?.access_token && token?.instance_url);

    // Hide/show buttons
    show($("loginBtn"), !loggedIn);
    show($("logoutBtn"), loggedIn);

    // Pills
    setText("buildPill", BUILD);
    setText("apiPill", `v${API_VERSION}`);

    if (!loggedIn) {
      setText("orgPill", "Not connected");
      setText("instancePill", "—");
      setText("orgIdPill", "—");
      setText("userPill", "—");
      setText("apiMaxPill", "—");
    } else {
      setText("orgPill", token.instance_url || "Connected");
    }
  }

  function reportError(e) {
    const entry = {
      ts: new Date().toISOString(),
      scope: e?.scope || "unknown",
      message: e?.message || String(e),
      status: e?.status ?? null,
      request: e?.request ?? null,
      detail: e?.detail ?? null,
      json: e?.json ?? null,
    };
    errors.unshift(entry);
    setText("errorCount", String(errors.length));
    const pre = $("errorsPre");
    if (pre) pre.textContent = JSON.stringify(errors.slice(0, 50), null, 2);
  }

  function clearErrors() {
    errors.length = 0;
    setText("errorCount", "0");
    const pre = $("errorsPre");
    if (pre) pre.textContent = "No errors.";
  }

  function setLastRequest(text) {
    setText("lastRequest", `Last request: ${text}`);
  }

  function getApiVersion() { return API_VERSION; }

  function wireApiVersionSelect() {
    const sel = $("apiVersionSelect");
    if (!sel) return;

    // Populate a sane set (you can expand)
    const versions = ["65.0", "64.0", "63.0", "62.0", "61.0"];
    sel.innerHTML = versions.map(v => `<option value="${v}">v${v}</option>`).join("");
    sel.value = API_VERSION;

    sel.addEventListener("change", () => {
      API_VERSION = sel.value || "65.0";
      setText("apiPill", `v${API_VERSION}`);
    });
  }

  async function login() {
    if (!CLIENT_ID) {
      alert("Missing CLIENT_ID in auth.js");
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
      reportError({ scope: "oauth", message: "OAuth error", detail: `${error} ${errorDesc || ""}` });
      return;
    }
    if (!code) return;

    const expected = sessionStorage.getItem("oauth_state");
    if (!expected || state !== expected) {
      showBanner("State mismatch. Aborting.");
      reportError({ scope: "oauth", message: "State mismatch" });
      return;
    }

    const verifier = sessionStorage.getItem("pkce_verifier");
    if (!verifier) {
      showBanner("Missing PKCE verifier. Aborting.");
      reportError({ scope: "oauth", message: "Missing PKCE verifier" });
      return;
    }

    // Clean URL
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

    const resp = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    const json = await resp.json().catch(() => null);

    if (!resp.ok) {
      const msg = json?.error_description || json?.error || `HTTP ${resp.status}`;
      showBanner(`Token error: ${msg}`);
      reportError({ scope: "oauth", message: "Token exchange failed", status: resp.status, json });
      return;
    }

    saveToken(json);
    sessionStorage.removeItem("pkce_verifier");
    sessionStorage.removeItem("oauth_state");
    showBanner("");
    setAuthUi();

    // Hydrate org context best-effort (optional)
    try { await loadOrgContext(true); } catch {}
  }

  async function logout() {
    clearToken();
    sessionStorage.removeItem("pkce_verifier");
    sessionStorage.removeItem("oauth_state");
    showBanner("");
    setAuthUi();
  }

  function extractSfError(json) {
    if (!json) return "Unknown error";
    if (Array.isArray(json) && json[0]?.message) return json[0].message;
    if (json?.message) return json.message;
    if (json?.error_description) return json.error_description;
    if (json?.error) return json.error;
    return JSON.stringify(json);
  }

  function isSessionInvalid(sfJson) {
    const msg = (sfJson?.[0]?.errorCode || sfJson?.error || sfJson?.message || "").toString();
    return /INVALID_SESSION_ID|invalid_grant|expired|session/i.test(msg);
  }

  async function sfFetch(path, { tooling = false, method = "GET", headers = {}, body = null } = {}) {
    const token = loadToken();
    if (!token?.access_token || !token?.instance_url) {
      showBanner("Not logged in. Click Login.");
      return { ok: false, status: 0, json: null };
    }

    const base = tooling
      ? `${token.instance_url}/services/data/v${API_VERSION}/tooling`
      : `${token.instance_url}/services/data/v${API_VERSION}`;
    const url = `${base}${path}`;

    setLastRequest(`${tooling ? "tooling" : "rest"} ${method} ${path}`);

    try {
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
        const msg = extractSfError(json);
        if (resp.status === 401 || isSessionInvalid(json)) {
          showBanner(`Session expired/invalid. Click Login again. (HTTP ${resp.status})`);
        }
        reportError({ scope: "sfFetch", message: msg, status: resp.status, request: `${method} ${path}`, json });
      }

      return { ok: resp.ok, status: resp.status, json };
    } catch (e) {
      reportError({ scope: "sfFetch", message: "Network/Fetch error", detail: e?.message || String(e), request: `${method} ${path}` });
      return { ok: false, status: 0, json: null };
    }
  }

  // Org context (best effort)
  async function loadOrgContext(force = false) {
    const token = loadToken();
    if (!token?.access_token || !token?.instance_url) return;

    // OAuth identity gives org/user ids reliably
    if (token.id) {
      const resp = await fetch(token.id, { headers: { Authorization: `Bearer ${token.access_token}` } });
      const idJson = await resp.json().catch(() => null);
      if (idJson?.organization_id) setText("orgIdPill", idJson.organization_id);
      if (idJson?.username) setText("userPill", idJson.username);
    }

    // InstanceName (e.g. NAxx)
    const q = "SELECT InstanceName, IsSandbox FROM Organization LIMIT 1";
    const r = await sfFetch(`/query?q=${encodeURIComponent(q)}`, { tooling: false });
    if (r.ok) {
      const rec = r.json?.records?.[0];
      if (rec?.InstanceName) setText("instancePill", rec.InstanceName);
    }

    // API max from /services/data
    const vd = await fetch(`${token.instance_url}/services/data`, {
      headers: { Authorization: `Bearer ${token.access_token}` }
    }).then(r => r.json()).catch(() => null);

    if (Array.isArray(vd) && vd.length) {
      const max = vd.map(x => parseFloat(x.version)).filter(Number.isFinite).sort((a,b)=>b-a)[0];
      if (max) setText("apiMaxPill", `v${max.toFixed(1)}`);
    }

    // Trust links
    const myDomain = (token.instance_url || "").replace(/^https?:\/\//, "");
    const trustSearch = `https://status.salesforce.com/search?fromSearch=true&search=${encodeURIComponent(myDomain)}`;
    const trustA = $("trustSearchLink");
    if (trustA) trustA.href = trustSearch;

    const inst = $("instancePill")?.textContent || "";
    const instLink = $("trustInstanceLink");
    if (instLink) {
      if (inst && inst !== "—") {
        instLink.href = `https://status.salesforce.com/instances/${encodeURIComponent(inst)}`;
        instLink.style.display = "";
      } else {
        instLink.style.display = "none";
      }
    }

    // Org details drawer body (optional)
    const pre = $("orgDetailsPre");
    if (pre) {
      pre.textContent = JSON.stringify({
        instance_url: token.instance_url,
        apiVersion: API_VERSION,
        orgId: $("orgIdPill")?.textContent,
        user: $("userPill")?.textContent,
        instanceName: $("instancePill")?.textContent,
        trustSearch,
      }, null, 2);
    }
  }

  function toggleDrawer(drawerId, on) {
    const d = $(drawerId);
    if (!d) return;
    d.style.display = on ? "block" : "none";
  }

  function wireChrome() {
    // Always wire API selector
    wireApiVersionSelect();

    // Always wire auth buttons
    $("loginBtn")?.addEventListener("click", (e) => { e.preventDefault(); login(); });
    $("logoutBtn")?.addEventListener("click", (e) => { e.preventDefault(); logout(); });

    // Drawer wiring
    $("orgDetailsBtn")?.addEventListener("click", async () => {
      toggleDrawer("orgDetailsDrawer", true);
      try { await loadOrgContext(true); } catch {}
    });
    $("errorsBtn")?.addEventListener("click", () => toggleDrawer("errorsDrawer", true));
    $("refreshOrgDetailsBtn")?.addEventListener("click", async () => { await loadOrgContext(true); });
    $("clearErrorsBtn")?.addEventListener("click", clearErrors);
    document.querySelectorAll(".closeDrawer").forEach((b) => b.addEventListener("click", () => {
      toggleDrawer("orgDetailsDrawer", false);
      toggleDrawer("errorsDrawer", false);
    }));

    // Global traps
    window.addEventListener("error", (e) => reportError({ scope: "window.error", message: e?.message || String(e) }));
    window.addEventListener("unhandledrejection", (e) => {
      const reason = e?.reason?.message || String(e?.reason || e);
      reportError({ scope: "unhandledrejection", message: reason });
    });

    // Initial UI state
    setAuthUi();
  }

  // Ensure wiring always happens after DOM exists
  document.addEventListener("DOMContentLoaded", wireChrome);

  return {
    BUILD,
    login,
    logout,
    loadToken,
    handleRedirectIfPresent,
    sfFetch,
    extractSfError,
    showBanner,
    reportError,
    clearErrors,
    wireApiVersionSelect,
    getApiVersion,
    loadOrgContext,
  };
})();
