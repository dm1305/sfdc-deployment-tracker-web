/* auth.js - Salesforce OAuth + common UI wiring (minimal, stable)
   Build: 2026-02-10.2
   Notes:
   - Designed for GitHub Pages (static hosting).
   - Uses OAuth 2.0 implicit grant (response_type=token).
   - Stores auth state in localStorage.
*/
(function () {
  const LS = {
    clientId: "sfdc_client_id",
    loginHost: "sfdc_login_host",      // login.salesforce.com | test.salesforce.com | custom domain (no scheme)
    apiVersion: "sfdc_api_version",
    accessToken: "sfdc_access_token",
    instanceUrl: "sfdc_instance_url",
    identityUrl: "sfdc_identity_url",
    issuedAt: "sfdc_issued_at",
  };

  const state = {
    errors: [],
    bannerTimer: null,
    identity: null,
  };

  function $(id) { return document.getElementById(id); }

  function pushError(msg, err) {
    const detail = err && err.stack ? err.stack : (err && err.message ? err.message : "");
    const line = detail ? `${msg}\n${detail}` : msg;
    state.errors.unshift({ t: new Date().toISOString(), msg: line });
    // Keep bounded
    if (state.errors.length > 200) state.errors.length = 200;
    updateErrorsPill();
  }

  function updateErrorsPill() {
    const btn = $("errorsBtn");
    if (!btn) return;
    btn.textContent = `Errors: ${state.errors.length}`;
  }

  function showErrorsDialog() {
    const lines = state.errors.slice(0, 50).map(e => `[${e.t}] ${e.msg}`).join("\n\n");
    alert(lines || "No errors recorded.");
  }

  function setBanner(text, kind) {
    const el = $("banner");
    if (!el) return;
    el.textContent = text || "";
    el.className = `banner ${kind || ""}`.trim();
    el.style.display = text ? "block" : "none";
    if (state.bannerTimer) clearTimeout(state.bannerTimer);
    if (text && kind !== "error") {
      state.bannerTimer = setTimeout(() => { el.style.display = "none"; }, 8000);
    }
  }

  function safeParseHash(hash) {
    const h = (hash || "").replace(/^#/, "");
    const out = {};
    for (const part of h.split("&")) {
      if (!part) continue;
      const [k, v] = part.split("=");
      out[decodeURIComponent(k)] = decodeURIComponent(v || "");
    }
    return out;
  }

  function canonicalRedirectUri() {
    // Force index.html so the connected app can be configured deterministically.
    const url = new URL(window.location.href);
    const path = url.pathname;
    const base = path.endsWith("/") ? path : path.substring(0, path.lastIndexOf("/") + 1);
    url.pathname = base + "index.html";
    url.search = "";
    url.hash = "";
    return url.toString();
  }

  function getClientId() {
    return sessionStorage.getItem(SS.clientId) || localStorage.getItem(LS.clientId) || "";
  }

  function getLoginHost() {
    // Stored value is host only (no scheme)
    const v = (localStorage.getItem(LS.loginHost) || "").trim();
    return v || "login.salesforce.com";
  }

  function getApiVersion() {
    return (localStorage.getItem(LS.apiVersion) || "60.0").trim();
  }

  function isLoggedIn() {
    return !!localStorage.getItem(LS.accessToken) && !!localStorage.getItem(LS.instanceUrl);
  }

  function clearAuth() {
    Object.values(LS).forEach(k => localStorage.removeItem(k));
    Object.values(SS).forEach(k => sessionStorage.removeItem(k));
    state.identity = null;
  }

  async function sfFetch(path, opts) {
    const token = localStorage.getItem(LS.accessToken);
    const inst = localStorage.getItem(LS.instanceUrl);
    if (!token || !inst) throw new Error("Not logged in");

    const url = inst.replace(/\/$/, "") + path;
    const headers = Object.assign({}, (opts && opts.headers) || {}, {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/json",
    });
    const res = await fetch(url, Object.assign({}, opts || {}, { headers }));
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      const msg = `HTTP ${res.status} ${res.statusText}${bodyText ? " - " + bodyText.slice(0, 300) : ""}`;
      throw new Error(msg);
    }
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) return await res.json();
    return await res.text();
  }

  async function loadIdentity() {
    const idUrl = localStorage.getItem(LS.identityUrl);
    const token = localStorage.getItem(LS.accessToken);
    if (!idUrl || !token) return null;
    try {
      const res = await fetch(idUrl, {
        headers: { "Authorization": `Bearer ${token}`, "Accept": "application/json" }
      });
      if (!res.ok) return null;
      const j = await res.json();
      state.identity = j;
      return j;
    } catch {
      return null;
    }
  }

  function updateHeaderPills() {
    const orgP = $("orgPill");
    const instP = $("instPill");
    const userP = $("userPill");
    const apiP = $("apiPill");
    const apiMaxP = $("apiMaxPill");
    const buildP = $("buildPill");

    const inst = localStorage.getItem(LS.instanceUrl) || "—";
    const apiV = getApiVersion();
    if (instP) instP.textContent = inst && inst !== "—" ? inst : "—";
    if (apiP) apiP.textContent = `v${apiV}`;

    // Fill from identity if possible (Org + user)
    const id = state.identity;
    if (orgP) orgP.textContent = id?.organization_id || "—";
    if (userP) userP.textContent = id?.preferred_username || id?.username || "—";

    // api max is optional
    if (apiMaxP && window.API_MAX) apiMaxP.textContent = String(window.API_MAX);

    // build pill: allow page to set window.BUILD
    if (buildP) buildP.textContent = window.BUILD || "—";
  }

  function wireApiVersionSelect() {
    const sel = $("apiVersionSelect");
    if (!sel) return;
    const versions = ["62.0","61.0","60.0","59.0","58.0","57.0","56.0","55.0"];
    sel.innerHTML = versions.map(v => `<option value="${v}">v${v}</option>`).join("");
    sel.value = getApiVersion();
    sel.addEventListener("change", () => {
      localStorage.setItem(LS.apiVersion, sel.value);
      updateHeaderPills();
      setBanner(`API version set to v${sel.value}`, "ok");
    });
  }

  function wireButtons() {
    $("loginBtn")?.addEventListener("click", login);
    $("logoutBtn")?.addEventListener("click", () => { logout(); });
    $("clearStorageBtn")?.addEventListener("click", () => { clearAuth(); window.location.reload(); });
    $("orgDetailsBtn")?.addEventListener("click", () => {
      const inst = localStorage.getItem(LS.instanceUrl) || "—";
      const msg =
        `Login host: ${getLoginHost()}\n` +
        `Redirect URI: ${canonicalRedirectUri()}\n` +
        `Instance: ${inst}\n` +
        `API: v${getApiVersion()}\n` +
        `Client Id set: ${getClientId() ? "yes" : "no"}`;
      alert(msg);
    });
    $("errorsBtn")?.addEventListener("click", showErrorsDialog);
  }

  function login() {
    let clientId = getClientId();
    if (!clientId) {
      clientId = (window.prompt("3MVG9YFqzc_KnL.wada6.pbgp4zDPc8T6u6uR6srOVo1fS7XOD_kHsrDH_QurZzXeEgwzWBU365_xXQ54mMNn") || "").trim();
      if (!clientId) {
        setBanner("Missing Client ID. Provide a Connected App Consumer Key to log in.", "error");
        return;
      }
      sessionStorage.setItem(SS.clientId, clientId);
    }
    const host = getLoginHost();
    const redirectUri = canonicalRedirectUri();
    const scope = encodeURIComponent("api id");
    const url =
      `https://${host}/services/oauth2/authorize` +
      `?response_type=token` +
      `&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=${scope}` +
      `&prompt=login`;
    window.location.assign(url);
  }

  function logout() {
    clearAuth();
    updateHeaderPills();
    setBanner("Logged out (local tokens cleared).", "ok");
  }

  function handleOAuthCallback() {
    const h = safeParseHash(window.location.hash);
    if (h.error) {
      setBanner(`${h.error}: ${decodeURIComponent(h.error_description || "")}`, "error");
      pushError(`OAuth error: ${h.error} ${h.error_description || ""}`);
      // Clear hash
      history.replaceState(null, "", window.location.pathname + window.location.search);
      return;
    }
    if (!h.access_token) return;

    localStorage.setItem(LS.accessToken, h.access_token);
    if (h.instance_url) localStorage.setItem(LS.instanceUrl, h.instance_url);
    if (h.id) localStorage.setItem(LS.identityUrl, h.id);
    if (h.issued_at) localStorage.setItem(LS.issuedAt, h.issued_at);

    // Clear hash for cleanliness
    history.replaceState(null, "", canonicalRedirectUri());
    setBanner("Logged in.", "ok");
  }

  async function init() {
    try {
      handleOAuthCallback();
      wireApiVersionSelect();
      wireButtons();
      updateErrorsPill();

      // Toggle buttons based on auth state
      const li = $("loginBtn");
      const lo = $("logoutBtn");
      if (li) li.style.display = isLoggedIn() ? "none" : "inline-block";
      if (lo) lo.style.display = isLoggedIn() ? "inline-block" : "none";

      if (isLoggedIn()) {
        await loadIdentity();
      }
      updateHeaderPills();
    } catch (e) {
      pushError("Auth init failed.", e);
      setBanner(`Auth init failed: ${e.message}`, "error");
    }
  }

  window.Auth = {
    keys: LS,
    init,
    // Back-compat for older pages that expect these names
    handleRedirectIfPresent: init,
    loadToken: () => ({
      access_token: localStorage.getItem(LS.accessToken) || "",
      instance_url: localStorage.getItem(LS.instanceUrl) || "",
      id: localStorage.getItem(LS.identityUrl) || "",
      issued_at: localStorage.getItem(LS.issuedAt) || "",
    }),
    login,
    logout,
    isLoggedIn,
    getClientId,
    getLoginHost,
    getApiVersion,
    canonicalRedirectUri,
    sfFetch,
    setBanner,
    wireApiVersionSelect,
    // Back-compat aliases used across pages
    showBanner: setBanner,
    getState: () => ({ identity: state.identity, errors: state.errors.slice() }),
  };
})();
