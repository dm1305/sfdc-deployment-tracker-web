// auth.js (FULL FILE - RESTORED)
// v2026-02-09.5
// Implements minimal Salesforce OAuth (implicit grant) + shared UI helpers used by index/inventory/workbench.
//
// This project expects a Salesforce Connected App "Consumer Key" (Client ID).
// If not configured, Login will prompt and store it in localStorage.
//
// Security note: This is a pure-static demo. Tokens are stored in localStorage for convenience.
// For production, prefer a backend and short-lived tokens.

(function () {
  const BUILD = "2026-02-09.5";
  const LS = {
    clientId: "sfdc_client_id",
    loginDomain: "sfdc_login_domain",      // "login" | "test" | custom (e.g. mydomain.my.salesforce.com)
    accessToken: "sfdc_access_token",
    instanceUrl: "sfdc_instance_url",
    idUrl: "sfdc_id_url",
    issuedAt: "sfdc_issued_at",
    apiVersion: "sfdc_api_version",
    errors: "sfdc_errors",
  };

  const DEFAULT_LOGIN_DOMAIN = "login"; // login.salesforce.com
  const DEFAULT_API_VERSION = "60.0";

  function $(id) { return document.getElementById(id); }
  function setText(id, t) { const el = $(id); if (el) el.textContent = t; }

  function showBanner(message, kind = "warn") {
    const el = $("authBanner");
    if (!el) return;
    el.textContent = message || "";
    el.classList.remove("good", "bad", "warn");
    if (message) el.classList.add(kind === "good" ? "good" : (kind === "bad" ? "bad" : "warn"));
  }

  function safeJsonParse(s, fallback) {
    try { return JSON.parse(s); } catch { return fallback; }
  }

  function loadErrors() {
    return safeJsonParse(localStorage.getItem(LS.errors) || "[]", []);
  }
  function saveErrors(arr) {
    localStorage.setItem(LS.errors, JSON.stringify(arr.slice(0, 200)));
    setText("errorCount", String(arr.length));
  }

  function reportError(err, ctx = {}) {
    const errors = loadErrors();
    const rec = {
      at: new Date().toISOString(),
      message: err?.message || String(err),
      name: err?.name,
      stack: err?.stack,
      ctx,
    };
    errors.unshift(rec);
    saveErrors(errors);
  }

  function renderErrors() {
    const pre = $("errorsPre");
    const errors = loadErrors();
    setText("errorCount", String(errors.length));
    if (!pre) return;
    if (!errors.length) {
      pre.textContent = "No errors.";
      return;
    }
    pre.textContent = errors.map((e, i) => {
      const c = e.ctx ? JSON.stringify(e.ctx) : "";
      return `#${i+1}  ${e.at}\n${e.message}\n${c}\n`;
    }).join("\n");
  }

  function wireErrorUI() {
    const errorsBtn = $("errorsBtn");
    const drawer = $("errorsDrawer");
    const clearBtn = $("clearErrorsBtn");

    if (errorsBtn && drawer) {
      errorsBtn.addEventListener("click", () => {
        drawer.classList.add("open");
        renderErrors();
      });
    }

    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        localStorage.removeItem(LS.errors);
        saveErrors([]);
        renderErrors();
      });
    }

    document.querySelectorAll(".closeDrawer").forEach((b) => {
      b.addEventListener("click", () => {
        const d = b.closest(".drawer");
        if (d) d.classList.remove("open");
      });
    });
  }

  function getClientId() {
    return (localStorage.getItem(LS.clientId) || "").trim();
  }

  function getLoginDomain() {
    return (localStorage.getItem(LS.loginDomain) || DEFAULT_LOGIN_DOMAIN).trim() || DEFAULT_LOGIN_DOMAIN;
  }

  function authBaseUrl() {
    const d = getLoginDomain();
    if (d.includes(".")) return `https://${d}`;
    if (d === "test") return "https://test.salesforce.com";
    return "https://login.salesforce.com";
  }

  function ensureClientConfig() {
    let clientId = getClientId();
    if (!clientId) {
      clientId = (prompt("Enter Salesforce Connected App Client ID (Consumer Key):") || "").trim();
      if (!clientId) return null;
      localStorage.setItem(LS.clientId, clientId);
    }

    let domain = getLoginDomain();
    if (!domain) {
      domain = DEFAULT_LOGIN_DOMAIN;
      localStorage.setItem(LS.loginDomain, domain);
    }
    return { clientId, domain };
  }

  function loadToken() {
    const accessToken = localStorage.getItem(LS.accessToken);
    const instanceUrl = localStorage.getItem(LS.instanceUrl);
    if (accessToken && instanceUrl) {
      return { accessToken, instanceUrl };
    }
    return null;
  }

  function clearToken() {
    [LS.accessToken, LS.instanceUrl, LS.idUrl, LS.issuedAt].forEach((k) => localStorage.removeItem(k));
  }

  function getApiVersion() {
    return (localStorage.getItem(LS.apiVersion) || DEFAULT_API_VERSION).trim() || DEFAULT_API_VERSION;
  }

  function setApiVersion(v) {
    if (!v) return;
    localStorage.setItem(LS.apiVersion, String(v));
    setText("apiPill", `v${v}`);
  }

  async function wireApiVersionSelect() {
    const sel = $("apiVersionSelect");
    if (!sel) return;

    sel.innerHTML = "";
    const current = getApiVersion();

    const tok = loadToken();
    if (!tok) {
      ["60.0","59.0","58.0","57.0","56.0"].forEach((v) => {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = `v${v}`;
        if (v === current) o.selected = true;
        sel.appendChild(o);
      });
    } else {
      try {
        const res = await fetch(`${tok.instanceUrl}/services/data/`, {
          headers: { Authorization: `Bearer ${tok.accessToken}` },
        });
        const data = await res.json();
        const versions = Array.isArray(data) ? data : [];
        const max = versions.length ? versions[versions.length - 1].version : current;

        versions.slice().reverse().forEach((row) => {
          const v = row.version;
          const o = document.createElement("option");
          o.value = v;
          o.textContent = `v${v}`;
          if (v === current) o.selected = true;
          sel.appendChild(o);
        });
        setText("apiMaxPill", max ? `v${max}` : "—");
      } catch (e) {
        reportError(e, { where: "wireApiVersionSelect" });
        ["60.0","59.0","58.0","57.0","56.0"].forEach((v) => {
          const o = document.createElement("option");
          o.value = v;
          o.textContent = `v${v}`;
          if (v === current) o.selected = true;
          sel.appendChild(o);
        });
      }
    }

    sel.addEventListener("change", () => {
      setApiVersion(sel.value);
      showBanner(`API version set to v${sel.value}`, "good");
    });
    setText("apiPill", `v${current}`);
  }

  function extractSfError(body, status) {
    if (!body) return `HTTP ${status}`;
    if (typeof body === "string") return body;
    if (Array.isArray(body) && body.length) {
      const first = body[0];
      const msg = first.message || JSON.stringify(first);
      const code = first.errorCode ? ` (${first.errorCode})` : "";
      return msg + code;
    }
    if (body.message) {
      const code = body.errorCode ? ` (${body.errorCode})` : "";
      return body.message + code;
    }
    return JSON.stringify(body);
  }

  async function sfFetch(path, opts = {}) {
    const tok = loadToken();
    if (!tok) {
      const e = new Error("Not connected to Salesforce. Click Login.");
      showBanner(e.message, "bad");
      reportError(e, { where: "sfFetch", path });
      throw e;
    }

    const apiVersion = getApiVersion();
    let url = path;

    if (path.startsWith("http://") || path.startsWith("https://")) {
      url = path;
    } else if (path.startsWith("/services/")) {
      url = tok.instanceUrl + path;
    } else if (path.startsWith("/")) {
      url = `${tok.instanceUrl}/services/data/v${apiVersion}${path}`;
    } else {
      url = `${tok.instanceUrl}/services/data/v${apiVersion}/${path}`;
    }

    const headers = new Headers(opts.headers || {});
    headers.set("Authorization", `Bearer ${tok.accessToken}`);
    if (!headers.has("Content-Type") && opts.body) headers.set("Content-Type", "application/json");

    const res = await fetch(url, { ...opts, headers });
    const ct = res.headers.get("content-type") || "";
    const isJson = ct.includes("application/json");

    let body = null;
    try {
      body = isJson ? await res.json() : await res.text();
    } catch {
      body = null;
    }

    if (!res.ok) {
      const msg = extractSfError(body, res.status);
      const e = new Error(msg);
      e.status = res.status;
      e.body = body;
      showBanner(`Salesforce error (${res.status}): ${msg}`, "bad");
      reportError(e, { where: "sfFetch", url, status: res.status, body });
      if (res.status === 401 || res.status === 403) {
        showBanner("Auth expired/invalid. Click Login to re-authenticate.", "bad");
      }
      throw e;
    }

    return body;
  }

  async function loadOrgContext() {
    const tok = loadToken();
    if (!tok) {
      renderOrgContext(null);
      return null;
    }

    try {
      const userinfo = await sfFetch("/services/oauth2/userinfo");
      renderOrgContext(userinfo);

      try {
        const limits = await sfFetch("/limits");
        if (limits?.DailyApiRequests?.Max != null) {
          setText("apiMaxPill", String(limits.DailyApiRequests.Max));
        }
      } catch {
        // ignore
      }

      return userinfo;
    } catch (e) {
      reportError(e, { where: "loadOrgContext" });
      return null;
    }
  }

  function renderOrgContext(userinfo) {
    const tok = loadToken();

    setText("buildPill", BUILD);

    if (!tok || !userinfo) {
      setText("orgPill", "Not connected");
      setText("instancePill", "—");
      setText("orgIdPill", "—");
      setText("userPill", "—");
      setText("apiPill", `v${getApiVersion()}`);
      return;
    }

    setText("instancePill", tok.instanceUrl || "—");
    setText("orgIdPill", userinfo.organization_id || "—");
    setText("userPill", userinfo.preferred_username || userinfo.email || userinfo.user_id || "—");
    setText("orgPill", userinfo.organization_id ? `${userinfo.organization_id}` : "Connected");
    setText("apiPill", `v${getApiVersion()}`);
  }

  async function renderOrgDetails() {
    const drawer = $("orgDetailsDrawer");
    const pre = $("orgDetailsPre");
    if (!pre) return;

    const tok = loadToken();
    if (!tok) {
      pre.textContent = "Not connected.";
      return;
    }

    try {
      const apiVersion = getApiVersion();
      const userinfo = await sfFetch("/services/oauth2/userinfo");
      const limits = await sfFetch("/limits").catch(() => null);
      const versions = await fetch(`${tok.instanceUrl}/services/data/`, {
        headers: { Authorization: `Bearer ${tok.accessToken}` },
      }).then(r => r.json()).catch(() => null);

      pre.textContent = JSON.stringify({
        build: BUILD,
        instanceUrl: tok.instanceUrl,
        apiVersion,
        userinfo,
        limits,
        versions,
      }, null, 2);

      const trustSearch = $("trustSearchLink");
      const trustInstance = $("trustInstanceLink");
      if (trustSearch) trustSearch.href = "https://trust.salesforce.com/en/";
      if (trustInstance) {
        try {
          const host = new URL(tok.instanceUrl).host;
          trustInstance.href = `https://trust.salesforce.com/en/status/?instance=${encodeURIComponent(host)}`;
        } catch {
          trustInstance.href = "https://trust.salesforce.com/en/status/";
        }
      }

      if (drawer) drawer.classList.add("open");
    } catch (e) {
      reportError(e, { where: "renderOrgDetails" });
      pre.textContent = `Error loading org details: ${e.message || e}`;
    }
  }

  function handleRedirectIfPresent() {
    const hash = window.location.hash || "";
    if (!hash.includes("access_token=")) return false;

    const params = new URLSearchParams(hash.replace(/^#/, ""));
    const accessToken = params.get("access_token");
    const instanceUrl = params.get("instance_url");
    const idUrl = params.get("id");
    const issuedAt = params.get("issued_at");

    if (accessToken && instanceUrl) {
      localStorage.setItem(LS.accessToken, accessToken);
      localStorage.setItem(LS.instanceUrl, instanceUrl);
      if (idUrl) localStorage.setItem(LS.idUrl, idUrl);
      if (issuedAt) localStorage.setItem(LS.issuedAt, issuedAt);

      history.replaceState(null, document.title, window.location.pathname + window.location.search);
      showBanner("Connected to Salesforce.", "good");
      return true;
    }

    showBanner("OAuth redirect received but missing access_token/instance_url.", "bad");
    return false;
  }

  function login() {
    const cfg = ensureClientConfig();
    if (!cfg) {
      showBanner("Client ID required to login.", "bad");
      return;
    }

    const redirectUri = window.location.origin + window.location.pathname;
    const authUrl = new URL(authBaseUrl() + "/services/oauth2/authorize");

    authUrl.searchParams.set("response_type", "token");
    authUrl.searchParams.set("client_id", cfg.clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("scope", "api id");
    authUrl.searchParams.set("prompt", "login");

    window.location.href = authUrl.toString();
  }

  function logout() {
    clearToken();
    showBanner("Logged out. Token cleared.", "warn");
    renderOrgContext(null);
    try { window.location.reload(); } catch {}
  }

  async function ensureOrgContext() {
    const tok = loadToken();
    if (!tok) {
      renderOrgContext(null);
      return false;
    }
    await loadOrgContext();
    return true;
  }

  function wireAuthButtons() {
    const loginBtn = $("loginBtn");
    const logoutBtn = $("logoutBtn");
    if (loginBtn) loginBtn.addEventListener("click", login);
    if (logoutBtn) logoutBtn.addEventListener("click", logout);

    const tok = loadToken();
    if (loginBtn) loginBtn.style.display = tok ? "none" : "inline-block";
    if (logoutBtn) logoutBtn.style.display = tok ? "inline-block" : "none";
  }

  function wireOrgDetailsUI() {
    const orgDetailsBtn = $("orgDetailsBtn");
    const refreshBtn = $("refreshOrgDetailsBtn");
    if (orgDetailsBtn) orgDetailsBtn.addEventListener("click", renderOrgDetails);
    if (refreshBtn) refreshBtn.addEventListener("click", renderOrgDetails);
  }

  async function init() {
    setText("buildPill", BUILD);

    wireErrorUI();
    wireAuthButtons();
    wireOrgDetailsUI();

    const didRedirect = handleRedirectIfPresent();
    if (didRedirect) wireAuthButtons();

    await wireApiVersionSelect();
    await loadOrgContext();

    if (!loadToken()) showBanner("Not connected. Click Login.", "warn");
  }

  window.Auth = {
    BUILD,
    LS,
    // UI
    $,
    setText,
    showBanner,
    wireErrorUI,
    renderErrors,
    reportError,
    // Auth
    login,
    logout,
    handleRedirectIfPresent,
    loadToken,
    clearToken,
    // Context / versions
    getApiVersion,
    setApiVersion,
    wireApiVersionSelect,
    loadOrgContext,
    ensureOrgContext,
    renderOrgContext,
    renderOrgDetails,
    // API
    sfFetch,
    extractSfError,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
