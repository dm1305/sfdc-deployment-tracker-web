// auth.js (FULL FILE - UPDATED)
// v2026-02-09.11
// Purpose: OAuth (Authorization Code + PKCE) + shared Salesforce REST helper + shared UI wiring.
// Notes:
// - Works for GitHub Pages / localhost.
// - Uses PKCE (no client secret in browser).
// - Stores token in localStorage so all pages share auth state.
// - Provides both camelCase and snake_case token shapes for compatibility.

(() => {
  "use strict";

      const BUILD = "2026-02-09.11";

  const LS = {
    clientId: "sfdc_client_id",
    loginHost: "sfdc_login_host",           // "login.salesforce.com" or "test.salesforce.com" or custom domain
    accessToken: "sfdc_access_token",
    instanceUrl: "sfdc_instance_url",
    idUrl: "sfdc_id_url",
    issuedAt: "sfdc_issued_at",
    scope: "sfdc_scope",
    tokenType: "sfdc_token_type",
    apiVersion: "sfdc_api_version",
    pkceVerifier: "sfdc_pkce_verifier",
    lastErrors: "sfdc_last_errors",
  };

  function $(id) { return document.getElementById(id); }

  function nowIso() { return new Date().toISOString(); }

  function safeJsonParse(s, fallback) {
    try { return JSON.parse(s); } catch { return fallback; }
  }

  function pushError(entry) {
    const cur = safeJsonParse(localStorage.getItem(LS.lastErrors) || "[]", []);
    cur.unshift({ ts: nowIso(), ...entry });
    localStorage.setItem(LS.lastErrors, JSON.stringify(cur.slice(0, 50)));
    renderErrorCount();
  }

  function renderErrorCount() {
    const el = $("errorCount");
    if (!el) return;
    const cur = safeJsonParse(localStorage.getItem(LS.lastErrors) || "[]", []);
    el.textContent = String(cur.length);
  }

  function setBanner(msg, kind = "info") {
    const el = $("authBanner");
    if (!el) return;
    el.textContent = msg || "";
    el.style.display = msg ? "block" : "none";
    el.dataset.kind = kind;
  }

  function setPill(id, val) {
    const el = $(id);
    if (el) el.textContent = val ?? "—";
  }

  function getLoginHost() {
    return (localStorage.getItem(LS.loginHost) || "login.salesforce.com").trim();
  }

  function getClientId() {
    return (localStorage.getItem(LS.clientId) || "").trim();
  }

  function getRedirectUri() {
    // Canonical: origin + pathname (no query/hash)
    return window.location.origin + window.location.pathname;
  }

  function base64UrlEncode(bytes) {
    const bin = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  async function sha256Base64Url(input) {
    const data = new TextEncoder().encode(input);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return base64UrlEncode(new Uint8Array(digest));
  }

  function randomString(len = 64) {
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
    const rnd = crypto.getRandomValues(new Uint8Array(len));
    return Array.from(rnd, (b) => chars[b % chars.length]).join("");
  }

  function loadToken() {
    const accessToken = localStorage.getItem(LS.accessToken);
    const instanceUrl = localStorage.getItem(LS.instanceUrl);
    const idUrl = localStorage.getItem(LS.idUrl) || null;
    const issuedAt = localStorage.getItem(LS.issuedAt) || null;
    const scope = localStorage.getItem(LS.scope) || null;
    const tokenType = localStorage.getItem(LS.tokenType) || null;

    if (accessToken && instanceUrl) {
      return {
        // camelCase
        accessToken,
        instanceUrl,
        idUrl,
        issuedAt,
        scope,
        tokenType,
        // snake_case
        access_token: accessToken,
        instance_url: instanceUrl,
        id: idUrl,
        issued_at: issuedAt,
      };
    }
    return null;
  }

  function saveToken(tokenResp) {
    localStorage.setItem(LS.accessToken, tokenResp.access_token);
    localStorage.setItem(LS.instanceUrl, tokenResp.instance_url);
    if (tokenResp.id) localStorage.setItem(LS.idUrl, tokenResp.id);
    if (tokenResp.issued_at) localStorage.setItem(LS.issuedAt, tokenResp.issued_at);
    if (tokenResp.scope) localStorage.setItem(LS.scope, tokenResp.scope);
    if (tokenResp.token_type) localStorage.setItem(LS.tokenType, tokenResp.token_type);
  }

  function clearToken() {
    [LS.accessToken, LS.instanceUrl, LS.idUrl, LS.issuedAt, LS.scope, LS.tokenType, LS.pkceVerifier].forEach((k) => localStorage.removeItem(k));
  }

  function ensureApiVersionSelect() {
    const sel = $("apiVersionSelect");
    if (!sel) return;

    if (sel.options.length === 0) {
      // Populate 60.0 down to 40.0
      for (let v = 60; v >= 40; v--) {
        const opt = document.createElement("option");
        opt.value = `v${v}.0`;
        opt.textContent = `v${v}.0`;
        sel.appendChild(opt);
      }
    }

    const stored = localStorage.getItem(LS.apiVersion);
    if (stored) sel.value = stored;

    sel.addEventListener("change", () => {
      localStorage.setItem(LS.apiVersion, sel.value);
      setPill("apiPill", sel.value);
    });
  }

  function apiVersion() {
    return localStorage.getItem(LS.apiVersion) || "v60.0";
  }

  async function sfFetch(path, init = {}) {
    const tok = loadToken();
    if (!tok) throw new Error("Not logged in.");

    const url = path.startsWith("http") ? path : `${tok.instanceUrl}${path}`;
    const headers = new Headers(init.headers || {});
    headers.set("Authorization", `Bearer ${tok.accessToken}`);
    if (!headers.has("Content-Type") && init.body && typeof init.body === "string") {
      headers.set("Content-Type", "application/json");
    }

    const res = await fetch(url, { ...init, headers });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }

    if (!res.ok) {
      const msg = (body && body[0] && body[0].message) ? body[0].message : res.statusText;
      const err = new Error(`Salesforce ${res.status}: ${msg}`);
      err.status = res.status;
      err.body = body;
      err.url = url;
      pushError({ where: "sfFetch", status: res.status, url, body });
      throw err;
    }

    return body;
  }

  async function fetchIdentityAndUpdatePills() {
    const tok = loadToken();
    if (!tok) {
      setPill("orgPill", "Not connected");
      setPill("instancePill", "—");
      setPill("orgIdPill", "—");
      setPill("userPill", "—");
      setPill("apiPill", "—");
      setPill("apiMaxPill", "—");
      setPill("buildPill", "—");
      return;
    }

    setPill("instancePill", tok.instanceUrl);
    setPill("apiPill", apiVersion());
    setPill("buildPill", BUILD);

    // Avoid calling token response "id" URL (often on login.salesforce.com) — it lacks CORS headers.
    // Use same-instance REST endpoints instead.

    // User info
    try {
      const me = await sfFetch(`/services/data/${apiVersion()}/chatter/users/me`);
      if (me) {
        setPill("userPill", me.username || me.email || me.name || "—");
      }
    } catch (e) {
      pushError({ where: "chatter_me", message: e.message });
    }

    // Org info
    try {
      const soql = "SELECT Id, Name FROM Organization LIMIT 1";
      const orgRes = await sfFetch(`/services/data/${apiVersion()}/query/?q=${encodeURIComponent(soql)}`);
      const org = orgRes?.records?.[0];
      if (org) {
        setPill("orgIdPill", org.Id || "—");
        setPill("orgPill", org.Name || org.Id || "Connected");
      } else {
        setPill("orgPill", "Connected");
      }
    } catch (e) {
      pushError({ where: "org_query", message: e.message });
      setPill("orgPill", "Connected");
    }

    // API request limit (best-effort)
    try {
      const limits = await sfFetch(`/services/data/${apiVersion()}/limits`);
      if (limits?.DailyApiRequests?.Max != null) {
        setPill("apiMaxPill", String(limits.DailyApiRequests.Max));
      }
    } catch {}
  }

    setPill("instancePill", tok.instanceUrl);
    setPill("apiPill", apiVersion());
    setPill("buildPill", BUILD);

    // Try identity endpoint (id URL returned by token response)
    if (tok.idUrl) {
      try {
        const ident = await sfFetch(tok.idUrl);
        // identity payload typically includes user_id and organization_id and username
        setPill("orgIdPill", ident.organization_id || "—");
        setPill("userPill", ident.username || "—");
        setPill("orgPill", ident.organization_id ? ident.organization_id : "Connected");
      } catch (e) {
        // Not fatal
        pushError({ where: "identity", message: e.message });
      }
    } else {
      setPill("orgPill", "Connected");
    }

    // Try limits to show API max
    try {
      const limits = await sfFetch(`/services/data/${apiVersion()}/limits`);
      if (limits?.DailyApiRequests) {
        setPill("apiMaxPill", String(limits.DailyApiRequests.Max));
      }
    } catch {
      // ignore
    }
  }

  function showLoginState() {
    const tok = loadToken();
    const loginBtn = $("loginBtn");
    const logoutBtn = $("logoutBtn");
    if (loginBtn) loginBtn.style.display = tok ? "none" : "inline-flex";
    if (logoutBtn) logoutBtn.style.display = tok ? "inline-flex" : "none";
  }

  async function login() {
    const clientId = getClientId();
    if (!clientId) {
      // Minimal UX: prompt for Client ID once, store for future use.
      const entered = window.prompt("Enter Salesforce Connected App Consumer Key (Client ID):");
      if (entered && entered.trim()) {
        localStorage.setItem(LS.clientId, entered.trim());
      } else {
        setBanner("Missing Client ID. Cannot start login.", "error");
        throw new Error("Missing Client ID");
      }
    }

    // Optional: allow switching between login and test quickly if not set.
    const hostStored = localStorage.getItem(LS.loginHost);
    if (!hostStored) {
      const hostEntered = window.prompt("Login host (default login.salesforce.com). Use test.salesforce.com for sandboxes:", "login.salesforce.com");
      if (hostEntered && hostEntered.trim()) localStorage.setItem(LS.loginHost, hostEntered.trim());
    }

    const verifier = randomString(96);
    localStorage.setItem(LS.pkceVerifier, verifier);
    const challenge = await sha256Base64Url(verifier);

    const host = getLoginHost();
    const redirect = getRedirectUri();

    const params = new URLSearchParams();
    params.set("response_type", "code");
    params.set("client_id", clientId);
    params.set("redirect_uri", redirect);
    params.set("scope", "api id");
    params.set("prompt", "login");
    params.set("code_challenge", challenge);
    params.set("code_challenge_method", "S256");

    window.location.assign(`https://${host}/services/oauth2/authorize?${params.toString()}`);
  }

  async function handleRedirectIfPresent() {
    const url = new URL(window.location.href);
    const err = url.searchParams.get("error");
    const code = url.searchParams.get("code");

    if (err) {
      const desc = url.searchParams.get("error_description") || "";
      pushError({ where: "oauth_redirect", error: err, error_description: desc });
      setBanner(`OAuth error: ${err} ${desc}`, "error");
      // Clean URL
      url.searchParams.delete("error");
      url.searchParams.delete("error_description");
      window.history.replaceState({}, "", url.toString());
      return;
    }

    if (!code) return;

    const verifier = localStorage.getItem(LS.pkceVerifier) || "";
    if (!verifier) {
      setBanner("Missing PKCE verifier. Try logging in again (Clear storage).", "error");
      return;
    }

    const tokenUrl = `https://${getLoginHost()}/services/oauth2/token`;
    const body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("client_id", getClientId());
    body.set("code", code);
    body.set("redirect_uri", getRedirectUri());
    body.set("code_verifier", verifier);

    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = { error: "invalid_json", raw: text }; }

    if (!res.ok) {
      pushError({ where: "token_exchange", status: res.status, body: json });
      setBanner(`Token exchange failed: ${json.error || res.status} ${json.error_description || ""}`, "error");
      return;
    }

    saveToken(json);
    localStorage.removeItem(LS.pkceVerifier);

    // Clean URL
    url.searchParams.delete("code");
    url.searchParams.delete("state");
    window.history.replaceState({}, "", url.origin + url.pathname);

    setBanner("Logged in.", "ok");
  }

  async function logout() {
    clearToken();
    showLoginState();
    await fetchIdentityAndUpdatePills();
    setBanner("Logged out.", "info");
  }

  async function renderOrgDetails() {
    const drawer = $("orgDetailsDrawer");
    const pre = $("orgDetailsPre");
    if (!drawer || !pre) return;

    drawer.classList.add("open");
    pre.textContent = "Loading…";

    try {
      const tok = loadToken();
      if (!tok) throw new Error("Not logged in.");

      const [versions, limits] = await Promise.all([
        sfFetch("/services/data/"),
        sfFetch(`/services/data/${apiVersion()}/limits`),
      ]);

      const out = {
        build: BUILD,
        instanceUrl: tok.instanceUrl,
        apiVersion: apiVersion(),
        services: versions,
        limits,
      };

      pre.textContent = JSON.stringify(out, null, 2);

      const trustSearch = $("trustSearchLink");
      const trustInstance = $("trustInstanceLink");
      if (trustSearch) trustSearch.href = "https://status.salesforce.com/";
      if (trustInstance) trustInstance.href = "https://status.salesforce.com/";
    } catch (e) {
      pushError({ where: "renderOrgDetails", message: e.message });
      pre.textContent = `Error loading org details: ${e.message || e}`;
    }
  }

  function renderErrorsDrawer() {
    const drawer = $("errorsDrawer");
    const pre = $("errorsPre");
    if (!drawer || !pre) return;
    drawer.classList.add("open");
    const cur = safeJsonParse(localStorage.getItem(LS.lastErrors) || "[]", []);
    pre.textContent = cur.length ? JSON.stringify(cur, null, 2) : "No errors.";
  }

  function wireCloseButtons() {
    document.querySelectorAll(".closeDrawer").forEach((btn) => {
      btn.addEventListener("click", () => {
        btn.closest(".drawer")?.classList.remove("open");
      });
    });
  }

  // Expose API
  const api = {
    BUILD,
    LS,
    getClientId,
    getLoginHost,
    loadToken,
    login,
    logout,
    handleRedirectIfPresent,
    sfFetch,
    apiVersion,
    // Backwards-compat alias used by older pages
    writeApiVersionSelect: ensureApiVersionSelect,
    renderOrgDetails,
    renderErrorsDrawer,
    pushError,
    setBanner,
  };

  window.Auth = api;

  // Wiring
  document.addEventListener("DOMContentLoaded", async () => {
    try {
      ensureApiVersionSelect();
      renderErrorCount();
      wireCloseButtons();

      await api.handleRedirectIfPresent();
      showLoginState();
      await fetchIdentityAndUpdatePills();

      $("loginBtn")?.addEventListener("click", () => api.login());
      $("logoutBtn")?.addEventListener("click", () => api.logout());

      $("orgDetailsBtn")?.addEventListener("click", () => api.renderOrgDetails());
      $("refreshOrgDetailsBtn")?.addEventListener("click", () => api.renderOrgDetails());

      $("errorsBtn")?.addEventListener("click", () => api.renderErrorsDrawer());
      $("clearErrorsBtn")?.addEventListener("click", () => {
        localStorage.removeItem(LS.lastErrors);
        renderErrorCount();
        const pre = $("errorsPre");
        if (pre) pre.textContent = "No errors.";
      });

      // If this is a page with a Refresh button, let app.js own the actual refresh; here we just ensure banner.
      $("clearStorageBtn")?.addEventListener("click", () => {
        localStorage.clear();
        renderErrorCount();
        setBanner("Storage cleared.", "info");
        showLoginState();
        fetchIdentityAndUpdatePills();
      });

      // Set build pill always if present
      setPill("buildPill", BUILD);
    } catch (e) {
      pushError({ where: "auth_init", message: e.message || String(e) });
      setBanner(`Auth init failed: ${e.message || e}`, "error");
      // Still try to show build
      setPill("buildPill", BUILD);
    }
  });

})();
