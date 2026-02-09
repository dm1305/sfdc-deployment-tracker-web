// auth.js
// Shared auth + REST/Tooling helpers for the SFDC Deployment Tracker (Web)
//
// IMPORTANT: Configure CLIENT_ID and LOGIN_DOMAIN for your Salesforce Connected App.
(function () {
  // ====== CONFIG (edit these) ======
  const CLIENT_ID = "3MVG9YFqzc_KnL.wada6.pbgp4zDPc8T6u6uR6srOVo1fS7XOD_kHsrDH_QurZzXeEgwzWBU365_xXQ54mMNn";
  const LOGIN_DOMAIN = "https://gearsetcom-4bf-dev-ed.develop.my.salesforce.com"; // your org My Domain
  // =================================

  // Build label
  const BUILD = "2026-02-08.2";

  // Storage keys
  const TOKEN_KEY = "sf_token";
  const API_VERSION_KEY = "sf_api_version";

  // Default API version
  const DEFAULT_API_VERSION = "65.0";

  /* -------------------- UI helpers -------------------- */

  function $(id) { return document.getElementById(id); }

  function setText(id, text) {
    const el = $(id);
    if (el) el.textContent = text;
  }

  function showBanner(message) {
    const b = $("authBanner");
    if (!b) return;
    b.textContent = message || "";
    b.style.display = message ? "block" : "none";
  }

  function log(msg) {
    const el = $("logPre") || $("status");
    if (!el) return;
    const stamp = new Date().toISOString();
    el.textContent = `[${stamp}] ${msg}\n` + el.textContent;
  }

  function setSelected(objOrText) {
    const el = $("selectedPre") || $("status");
    if (!el) return;
    el.textContent = typeof objOrText === "string" ? objOrText : JSON.stringify(objOrText, null, 2);
  }

  // -------------------- Error capture + UI --------------------
  // Each page can show an "Errors" pill and a drawer with details.
  const _errors = [];

  function reportError({ scope = "sfFetch", title = "Error", detail = "", request = null, status = null, json = null } = {}) {
    const entry = {
      ts: new Date().toISOString(),
      scope,
      title,
      detail,
      request,
      status,
      json,
    };
    _errors.unshift(entry);

    // Update pill if present
    const countEl = $("errorCount");
    if (countEl) countEl.textContent = String(_errors.length);
    const pillEl = $("errorPill");
    if (pillEl) pillEl.classList.toggle("error", _errors.length > 0);
    const pill = $("errorPill");
    if (pill) pill.classList.toggle("error", _errors.length > 0);

    // If drawer is open, re-render
    if ($("errorPre")) renderErrors();

    // Emit an event so pages can react if they want
    try {
      window.dispatchEvent(new CustomEvent("app:error", { detail: entry }));
    } catch {}
  }

  function getErrors() {
    return [..._errors];
  }

  function clearErrors() {
    _errors.length = 0;
    const countEl = $("errorCount");
    if (countEl) countEl.textContent = "0";
    const pill = $("errorPill");
    if (pill) pill.classList.remove("error");
    renderErrors();
  }

  function renderErrors() {
    const pre = $("errorPre");
    if (!pre) return;
    if (!_errors.length) {
      pre.textContent = "No errors recorded on this page.";
      return;
    }
    pre.textContent = _errors.map((e, i) => {
      const head = `#${_errors.length - i} [${e.ts}] ${e.scope} — ${e.title}${e.status ? ` (HTTP ${e.status})` : ""}`;
      const req = e.request ? `Request: ${e.request}` : "";
      const det = e.detail ? `Detail: ${e.detail}` : "";
      const js = e.json ? `Response: ${typeof e.json === "string" ? e.json : JSON.stringify(e.json, null, 2)}` : "";
      return [head, req, det, js].filter(Boolean).join("\n");
    }).join("\n\n" + "-".repeat(50) + "\n\n");
  }

  function openErrorDrawer() {
    const overlay = $("errorOverlay");
    const drawer = $("errorDrawer");
    if (!overlay || !drawer) return;
    renderErrors();
    overlay.style.display = "block";
    drawer.style.transform = "translateX(0)";
  }

  function closeErrorDrawer() {
    const overlay = $("errorOverlay");
    const drawer = $("errorDrawer");
    if (!overlay || !drawer) return;
    drawer.style.transform = "translateX(100%)";
    overlay.style.display = "none";
  }

  
  /* -------------------- Org details drawer -------------------- */

  function openOrgDrawer() {
    const overlay = $("orgOverlay");
    const drawer = $("orgDrawer");
    if (!overlay || !drawer) return;
    overlay.style.display = "block";
    drawer.style.transform = "translateX(0)";
    renderOrgDetails();
  }

  function closeOrgDrawer() {
    const overlay = $("orgOverlay");
    const drawer = $("orgDrawer");
    if (!overlay || !drawer) return;
    drawer.style.transform = "translateX(100%)";
    overlay.style.display = "none";
  }

  function renderOrgDetails() {
    const pre = $("orgPre");
    if (!pre) return;
    const info = loadOrgInfo();
    if (!info) {
      pre.textContent = "No org context loaded yet.";
      return;
    }
    const details = {
      orgName: info.orgName,
      orgId: info.orgId,
      instanceName: info.instanceName,
      instanceUrl: info.instanceUrl,
      myDomain: info.myDomain,
      isSandbox: info.isSandbox,
      orgType: info.orgType,
      trialExpirationDate: info.trialExpirationDate,
      username: info.username,
      userId: info.userId,
      apiInUse: `v${getApiVersion()}`,
      apiMaxAdvertised: info.apiMax ? `v${info.apiMax}` : null,
      trustSearch: info.trustSearchUrl,
      trustInstance: info.trustInstanceUrl,
      notes: [
        "InstanceName is from Organization.InstanceName.",
        "Trust links: primary uses Trust search (My Domain / instance), secondary uses direct instance page when InstanceName is known.",
      ],
    };
    pre.textContent = JSON.stringify(details, null, 2);
  }

  function wireOrgUI() {
    const pill = $("orgDetailsBtn");
    if (pill) pill.addEventListener("click", openOrgDrawer);

    const overlay = $("orgOverlay");
    if (overlay) overlay.addEventListener("click", closeOrgDrawer);

    const close = $("orgCloseBtn");
    if (close) close.addEventListener("click", closeOrgDrawer);

    const refresh = $("orgRefreshBtn");
    if (refresh) refresh.addEventListener("click", async () => {
      await ensureOrgContext({ force: true });
      renderOrgContext();
      renderOrgDetails();
    });
  }

function wireErrorUI() {
    const pill = $("errorPill");
    if (pill) pill.addEventListener("click", openErrorDrawer);
    const overlay = $("errorOverlay");
    if (overlay) overlay.addEventListener("click", closeErrorDrawer);
    const closeBtn = $("errorCloseBtn");
    if (closeBtn) closeBtn.addEventListener("click", closeErrorDrawer);
    const clearBtn = $("errorClearBtn");
    if (clearBtn) clearBtn.addEventListener("click", clearErrors);
    // initialize
    const countEl = $("errorCount");
    if (countEl) countEl.textContent = String(_errors.length);
    const pillEl = $("errorPill");
    if (pillEl) pillEl.classList.toggle("error", _errors.length > 0);
    const pill = $("errorPill");
    if (pill) pill.classList.toggle("error", _errors.length > 0);
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
    // IMPORTANT: This must be whitelisted in the Connected App Callback URL.
    return window.location.origin + window.location.pathname;
  }

  /* -------------------- API version selection -------------------- */

  function getApiVersion() {
    return localStorage.getItem(API_VERSION_KEY) || DEFAULT_API_VERSION;
  }

  function setApiVersion(v) {
    if (!v) return;
    localStorage.setItem(API_VERSION_KEY, String(v));
    setText("apiPill", `v${getApiVersion()}`);
  }

  function wireApiVersionSelect() {
    const sel = $("apiVersionSelect");
    if (!sel) return;

    // Populate common recent versions; you can add more if needed.
    const versions = ["65.0", "64.0", "63.0", "62.0", "61.0", "60.0", "59.0", "58.0"];
    sel.innerHTML = versions.map(v => `<option value="${v}">${v}</option>`).join("");
    sel.value = getApiVersion();

    sel.addEventListener("change", () => {
      setApiVersion(sel.value);
      log(`API version set to v${getApiVersion()}`);
    });
  }

  /* -------------------- OAuth -------------------- */

  async function login() {
    if (!CLIENT_ID) {
      alert("Missing CLIENT_ID in auth.js.");
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
      const msg = `OAuth error: ${error}${errorDesc ? " - " + errorDesc : ""}`;
      showBanner(msg);
      log(msg);
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
    showBanner("");
    setText("busyPill", "Auth…");

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
    setText("busyPill", "Idle");

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
    setText("apiPill", `v${getApiVersion()}`);
    setText("buildPill", BUILD);

    log("Logged in. Token stored in localStorage.");
    setSelected(redactTokenForDisplay(json));
  }

  function redactTokenForDisplay(token) {
    if (!token) return token;
    const copy = { ...token };
    if (copy.access_token) copy.access_token = "(redacted)";
    if (copy.refresh_token) copy.refresh_token = "(redacted)";
    if (copy.id_token) copy.id_token = "(redacted)";
    return copy;
  }

  async function logout() {
    clearToken();
    clearSessionState();
    showBanner("");
    setText("orgPill", "Not connected");
    setText("apiPill", `v${getApiVersion()}`);
    setText("buildPill", BUILD);
    setSelected("Nothing selected.");
    log("Logged out.");
  }

  /* -------------------- REST helpers -------------------- */

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
    const token = loadToken();
    if (!token?.access_token || !token?.instance_url) {
      showBanner("Not logged in. Click Login.");
      return { ok: false, status: 0, json: null };
    }

    const apiVersion = getApiVersion();
    const base = tooling
      ? `${token.instance_url}/services/data/v${apiVersion}/tooling`
      : `${token.instance_url}/services/data/v${apiVersion}`;

    const url = `${base}${path}`;

    let resp = null;
    let json = null;
    try {
      resp = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token.access_token}`,
          ...headers,
        },
        body,
      });
      json = await resp.json().catch(() => null);
    } catch (e) {
      const msg = e?.message || String(e);
      showBanner(`Network error. See Errors. (${msg})`);
      log(`Network error: ${msg}`);
      reportError({ scope: "sfFetch", title: "Network error", detail: msg, request: `${tooling ? "tooling" : "rest"} ${method} ${path}` });
      return { ok: false, status: 0, json: null };
    }

    if (!resp.ok) {
      const sfErr = extractSfError(json);
      if (resp.status === 401 || isSessionInvalid(json)) {
        showBanner(`Session expired/invalid. Click Login again. (HTTP ${resp.status})`);
        log(`Auth/session error: ${sfErr}`);
        reportError({ scope: "sfFetch", title: "Session expired/invalid", detail: sfErr, request: `${tooling ? "tooling" : "rest"} ${method} ${path}`, status: resp.status, json });
      } else {
        log(`SF request failed (HTTP ${resp.status}): ${sfErr}`);
        reportError({ scope: "sfFetch", title: "Salesforce request failed", detail: sfErr, request: `${tooling ? "tooling" : "rest"} ${method} ${path}`, status: resp.status, json });
      }
    }

    return { ok: resp.ok, status: resp.status, json };
  }

  // Global error traps (useful on GitHub Pages)
  window.addEventListener("error", (e) => {
    log(`JS error: ${e?.message || e}`);
    reportError({ scope: "window", title: "JS error", detail: e?.message || String(e) });
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e?.reason?.message || String(e?.reason || e);
    log(`Unhandled promise rejection: ${reason}`);
    reportError({ scope: "window", title: "Unhandled promise rejection", detail: reason });
  });


  /* -------------------- Org context helpers -------------------- */

  const ORGINFO_KEY = "sf_orginfo";

  function saveOrgInfo(info) {
    if (!info) return;
    localStorage.setItem(ORGINFO_KEY, JSON.stringify(info));
  }

  function loadOrgInfo() {
    const raw = localStorage.getItem(ORGINFO_KEY);
    return raw ? JSON.parse(raw) : null;
  }

  function clearOrgInfo() {
    localStorage.removeItem(ORGINFO_KEY);
  }

  function getMyDomainFromInstanceUrl(instanceUrl) {
    // For https://mydomain.my.salesforce.com => "mydomain"
    try {
      const u = new URL(instanceUrl);
      const host = u.hostname || "";
      const sub = host.split(".")[0] || "";
      return sub;
    } catch {
      return "";
    }
  }

  function deriveMyDomain() {
    try {
      const host = new URL(LOGIN_DOMAIN).hostname;
      // For *.my.salesforce.com, *.sandbox.my.salesforce.com, *.develop.my.salesforce.com, etc.
      return host.split(".")[0] || null;
    } catch {
      return null;
    }
  }

  function trustSearchUrl(term) {
    const base = "https://status.salesforce.com/?fromSearch=true";
    if (!term) return base;
    // Some Trust deployments may ignore this param; we still include it, and we also display the search term in Org details.
    return `${base}&search=${encodeURIComponent(term)}`;
  }

  function trustInstanceUrl(instanceName) {
    // Direct instance page (if you know InstanceName).
    if (!instanceName) return "https://status.salesforce.com/";
    return `https://status.salesforce.com/instances/${encodeURIComponent(instanceName)}`;
  }

  async function fetchIdentity(token) {
    // token.id is an identity URL in Salesforce OAuth responses
    const idUrl = token?.id;
    if (!idUrl) return null;

    const resp = await fetch(idUrl, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const json = await resp.json().catch(() => null);
    if (!resp.ok) return null;
    return json;
  }

  async function fetchOrgRecord() {
    // REST query (not tooling)
    // Organization.InstanceName gives NAxx / EUxx / etc (or Hyperforce codes like GBR1)
    const soql = "SELECT Id, Name, InstanceName, IsSandbox, OrganizationType, TrialExpirationDate FROM Organization LIMIT 1";
    const { ok, json } = await sfFetch(`/query?q=${encodeURIComponent(soql)}`, { tooling: false });
    if (!ok) return null;
    return (json?.records || [])[0] || null;
  }

  async function fetchApiVersionList(token) {
    // /services/data returns supported versions list
    const url = `${token.instance_url}/services/data`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const json = await resp.json().catch(() => null);
    if (!resp.ok || !Array.isArray(json)) return null;
    // each item: {label, url, version}
    const versions = json.map(v => Number(v?.version)).filter(Number.isFinite);
    const max = versions.length ? Math.max(...versions) : null;
    return { maxApiVersion: max ? `${max.toFixed(1)}` : null, raw: json };
  }

  async function ensureOrgContext({ force = false } = {}) {
    const token = loadToken();
    if (!token?.access_token || !token?.instance_url) return null;

    const existing = loadOrgInfo();
    if (!force && existing?.fetchedAt) {
      // Cache for 15 minutes
      const ageMs = Date.now() - new Date(existing.fetchedAt).getTime();
      if (Number.isFinite(ageMs) && ageMs < 15 * 60 * 1000) return existing;
    }

    try {
      const identity = await fetchIdentity(token);
      const org = await fetchOrgRecord();
      const vers = await fetchApiVersionList(token);

      const info = {
        fetchedAt: new Date().toISOString(),
        instanceUrl: token.instance_url,
        myDomain: getMyDomainFromInstanceUrl(token.instance_url),
        orgId: org?.Id || identity?.organization_id || null,
        orgName: org?.Name || null,
        instanceName: org?.InstanceName || null,
        isSandbox: org?.IsSandbox ?? null,
        orgType: org?.OrganizationType || null,
        trialExpirationDate: org?.TrialExpirationDate || null,
        userId: identity?.user_id || null,
        username: identity?.username || null,
        displayName: identity?.display_name || null,
        apiMax: vers?.maxApiVersion || null,
        myDomain: deriveMyDomain(),
      trustSearchTerm: (deriveMyDomain() || org?.InstanceName || null),
      trustSearchUrl: trustSearchUrl(deriveMyDomain() || org?.InstanceName || null),
      trustInstanceUrl: trustInstanceUrl(org?.InstanceName),
      };

      saveOrgInfo(info);
      return info;
    } catch (e) {
      reportError({ scope: "org", title: "Org context fetch failed", detail: e?.message || String(e) });
      return existing || null;
    }
  }

  function renderOrgContext() {
    const info = loadOrgInfo();
    if (!info) return;

    setText("orgPill", info.instanceUrl || "Connected");
    setText("instancePill", info.instanceName || "—");
    setText("orgIdPill", info.orgId || "—");
    setText("userPill", info.username || info.displayName || "—");
    setText("apiMaxPill", info.apiMax ? `v${info.apiMax}` : "—");

    const trustSearch = document.getElementById("trustSearchLink");
    if (trustSearch) {
      trustSearch.href = info.trustSearchUrl || "https://status.salesforce.com/?fromSearch=true";
      trustSearch.textContent = "Trust (search)";
      trustSearch.target = "_blank";
      trustSearch.rel = "noopener noreferrer";
      trustSearch.style.display = "";
      trustSearch.title = info.trustSearchTerm
        ? `Open Salesforce Status (search). Search for: ${info.trustSearchTerm}`
        : "Open Salesforce Status";
    }

    const trustInstance = document.getElementById("trustInstanceLink");
    if (trustInstance) {
      if (info.instanceName) {
        trustInstance.href = info.trustInstanceUrl || "https://status.salesforce.com/";
        trustInstance.textContent = "Trust (instance)";
        trustInstance.target = "_blank";
        trustInstance.rel = "noopener noreferrer";
        trustInstance.style.display = "";
        trustInstance.title = `Open instance page for ${info.instanceName}`;
      } else {
        trustInstance.style.display = "none";
      }
    }
  }

  // Export as a global
  window.Auth = {
    BUILD,
    TOKEN_KEY,
    getApiVersion,
    setApiVersion,
    wireApiVersionSelect,

    saveToken,
    loadToken,
    clearToken,

    login,
    logout,
    handleRedirectIfPresent,

    sfFetch,
    extractSfError,

    setText,
    showBanner,
    log,
    setSelected,
    reportError,
    getErrors,
    clearErrors,
    renderErrors,
    openErrorDrawer,
    closeErrorDrawer,
    wireErrorUI,
    wireOrgUI,
    renderOrgDetails,
    ensureOrgContext,
    renderOrgContext,
    loadOrgInfo,
    clearOrgInfo,
  };
})();
