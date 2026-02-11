// ====== CONFIG (edit these) ======
const CLIENT_ID = "PASTE_YOUR_CONSUMER_KEY_HERE";
const LOGIN_DOMAIN = "https://YOUR_MY_DOMAIN.my.salesforce.com"; // e.g. https://gearsetcom-4bf-dev-ed.develop.my.salesforce.com
// =================================

// Storage keys
const TOKEN_KEY = "sf_token";

// Pick an API version your org supports (you saw v65.0 in /services/data)
const API_VERSION = "65.0";

// Polling
let pollTimer = null;

// Cached metadata type list + describes
let toolingSobjects = [];
const describeCache = new Map();

/* -------------------- UI helpers -------------------- */

function el(id){ return document.getElementById(id); }

function setText(id, text){
  const e = el(id);
  if(!e) return;
  e.textContent = text;
}

function log(msg){
  const e = el("logPre") || el("status");
  if(!e) return;
  const stamp = new Date().toISOString();
  e.textContent = `[${stamp}] ${msg}\n` + e.textContent;
}

function setAuthPill(text){
  const p = el("authPill");
  if(!p) return;
  p.innerHTML = `<strong>Auth</strong>: ${escapeHtml(text)}`;
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function wireClick(id, handler){
  const e = el(id);
  if(!e) return;
  e.addEventListener("click", handler);
}

function wireChange(id, handler){
  const e = el(id);
  if(!e) return;
  e.addEventListener("change", handler);
}

function showPanel(id, show){
  const e = el(id);
  if(!e) return;
  e.style.display = show ? "" : "none";
}

function setActiveTab(tabId){
  ["tabDeployments","tabPackages","tabMetadata"].forEach(id=>{
    const t = el(id);
    if(!t) return;
    t.classList.toggle("active", id === tabId);
  });
  showPanel("deploymentsControls", tabId === "tabDeployments");
  showPanel("packagesControls", tabId === "tabPackages");
  showPanel("metadataControls", tabId === "tabMetadata");
}

/* -------------------- Storage helpers -------------------- */

function saveToken(token){ localStorage.setItem(TOKEN_KEY, JSON.stringify(token)); }
function loadToken(){ const raw = localStorage.getItem(TOKEN_KEY); return raw ? JSON.parse(raw) : null; }
function clearToken(){ localStorage.removeItem(TOKEN_KEY); }
function clearSessionState(){ sessionStorage.removeItem("pkce_verifier"); sessionStorage.removeItem("oauth_state"); }

function redactTokenForDisplay(token){
  if(!token) return token;
  const copy = { ...token };
  if(copy.access_token) copy.access_token = "(redacted)";
  if(copy.refresh_token) copy.refresh_token = "(redacted)";
  if(copy.id_token) copy.id_token = "(redacted)";
  return copy;
}

/* -------------------- PKCE helpers -------------------- */

function base64UrlEncode(bytes){
  let bin = "";
  bytes.forEach(b => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Base64Url(text){
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(digest));
}

function randomString(length = 64){
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  return Array.from(bytes, b => chars[b % chars.length]).join("");
}

function getRedirectUri(){
  return window.location.origin + window.location.pathname;
}

/* -------------------- OAuth -------------------- */

async function login(){
  if(!CLIENT_ID || CLIENT_ID.includes("PASTE_")){
    alert("Set CLIENT_ID in app.js first.");
    return;
  }
  if(!LOGIN_DOMAIN || !LOGIN_DOMAIN.startsWith("https://")){
    alert("Set LOGIN_DOMAIN to your org My Domain, e.g. https://yourdomain.my.salesforce.com");
    return;
  }

  // PKCE
  const codeVerifier = randomString(96);
  const codeChallenge = await sha256Base64Url(codeVerifier);
  sessionStorage.setItem("pkce_verifier", codeVerifier);

  const state = randomString(24);
  sessionStorage.setItem("oauth_state", state);

  const authUrl = new URL(`${LOGIN_DOMAIN}/services/oauth2/authorize`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", getRedirectUri());
  authUrl.searchParams.set("scope", "refresh_token full");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  window.location.href = authUrl.toString();
}

async function handleRedirectIfPresent(){
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDesc = url.searchParams.get("error_description");

  if(error){
    log(`OAuth error: ${error}${errorDesc ? " - " + errorDesc : ""}`);
    setAuthPill("OAuth error");
    return;
  }
  if(!code) return;

  const expectedState = sessionStorage.getItem("oauth_state");
  if(!expectedState || state !== expectedState){
    log("State mismatch. Aborting.");
    setAuthPill("State mismatch");
    return;
  }

  const verifier = sessionStorage.getItem("pkce_verifier");
  if(!verifier){
    log("Missing PKCE verifier. Aborting.");
    setAuthPill("Missing verifier");
    return;
  }

  // Clean URL
  url.searchParams.delete("code");
  url.searchParams.delete("state");
  window.history.replaceState({}, document.title, url.toString());

  // Token exchange
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
  if(!resp.ok){
    log(`Token exchange failed (HTTP ${resp.status}): ${json?.error_description || json?.error || "Unknown error"}`);
    setAuthPill("Token exchange failed");
    return;
  }

  saveToken(json);
  const safe = redactTokenForDisplay(json);

  setText("orgPill", `Org: ${json.instance_url || "Connected"}`);
  setText("apiPill", `API: v${API_VERSION}`);
  setAuthPill("OK");

  log("Logged in ✅ Token stored in localStorage.");
  log("Tip: If you see 401s later, click Clear storage then Login again.");
  log("Token (redacted): " + JSON.stringify(safe));
}

async function logout(){
  clearToken();
  clearSessionState();
  stopPolling();
  setText("orgPill", "Org: Not connected");
  setText("apiPill", "API: —");
  setAuthPill("Unknown");
  log("Logged out.");
}

/* -------------------- REST helpers -------------------- */

function requireToken(){
  const token = loadToken();
  if(!token?.access_token || !token?.instance_url){
    log("Not logged in. Click Login.");
    setAuthPill("Not logged in");
    return null;
  }
  return token;
}

async function sfFetch(path, { tooling = false, method = "GET", headers = {}, body = null } = {}){
  const token = requireToken();
  if(!token) return { ok:false, status:0, json:null };

  const base = tooling
    ? `${token.instance_url}/services/data/v${API_VERSION}/tooling`
    : `${token.instance_url}/services/data/v${API_VERSION}`;

  const url = `${base}${path}`;

  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      ...headers,
    },
    body,
  });

  const json = await resp.json().catch(() => null);
  if(resp.status === 401){
    setAuthPill("401");
  }
  return { ok: resp.ok, status: resp.status, json };
}

/* -------------------- Time formatting -------------------- */

function parseDate(s){ if(!s) return null; const d = new Date(s); return Number.isFinite(d.getTime()) ? d : null; }
function fmtTime(d){ if(!d) return "—"; return d.toISOString().replace("T"," ").replace("Z","Z"); }
function fmtDuration(ms){
  if(ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const sec = Math.floor(ms/1000);
  const h = Math.floor(sec/3600);
  const m = Math.floor((sec%3600)/60);
  const s = sec%60;
  return `${h}h ${m}m ${s}s`;
}

function statusClass(status){
  const s = String(status||"").toLowerCase();
  if(["succeeded","success","completed"].some(k=>s.includes(k))) return "good";
  if(["failed","error"].some(k=>s.includes(k))) return "bad";
  if(["inprogress","queued","pending","validat","running","processing"].some(k=>s.includes(k))) return "warn";
  return "";
}

/* -------------------- Deployments -------------------- */

function passesDeployFilter(r){
  const filter = el("deployFilter")?.value || "all";
  const status = String(r.Status || "");
  const checkOnly = !!r.CheckOnly;

  if(filter === "active"){
    const active = ["InProgress","Pending","Queued","Processing","Running","Validating"];
    return active.includes(status);
  }
  if(filter === "failed") return status.toLowerCase().includes("fail") || status.toLowerCase().includes("error");
  if(filter === "checkonly") return checkOnly;
  if(filter === "real") return !checkOnly;
  return true;
}

function passesDeploySearch(r){
  const q = (el("deploySearch")?.value || "").trim().toLowerCase();
  if(!q) return true;
  const blob = [r.Status, r.Type, r.CreatedBy?.Name, r.ErrorStatusCode, r.ErrorMessage, r.Id].filter(Boolean).join(" ").toLowerCase();
  return blob.includes(q);
}

function rowHtmlDeploy(r){
  const now = new Date();
  const created = parseDate(r.CreatedDate);
  const started = parseDate(r.StartDate) || created;
  const completed = parseDate(r.CompletedDate);

  const queueMs = created && started ? (started - created) : null;
  const runMs = started ? (completed ? (completed - started) : (now - started)) : null;
  const totalMs = created ? (completed ? (completed - created) : (now - created)) : null;

  const st = r.Status || "—";
  const cls = statusClass(st);
  const user = r.CreatedBy?.Name || "—";
  const type = r.Type || "—";

  return `
    <tr>
      <td class="status ${cls}">${escapeHtml(st)}</td>
      <td>${escapeHtml(user)}</td>
      <td>${escapeHtml(type)}${r.CheckOnly ? ' <span class="muted">(checkOnly)</span>' : ""}</td>
      <td class="mono">${escapeHtml(fmtTime(created))}</td>
      <td class="mono">${escapeHtml(fmtTime(parseDate(r.StartDate)))}</td>
      <td class="mono">${escapeHtml(fmtTime(completed))}</td>
      <td class="mono">${escapeHtml(fmtDuration(queueMs))}</td>
      <td class="mono">${escapeHtml(fmtDuration(runMs))}</td>
      <td class="mono">${escapeHtml(fmtDuration(totalMs))}</td>
    </tr>
  `;
}

async function fetchDeployments(){
  const limit = Number(el("deployLimit")?.value || 100);

  const soql = `
    SELECT Id, Status, Type, CheckOnly,
           CreatedDate, StartDate, CompletedDate,
           CreatedBy.Name,
           ErrorStatusCode, ErrorMessage
    FROM DeployRequest
    ORDER BY CreatedDate DESC
    LIMIT ${limit}
  `.trim();

  const { ok, status, json } = await sfFetch(`/query?q=${encodeURIComponent(soql)}`, { tooling: true });

  if(!ok){
    log(`DeployRequest query failed (HTTP ${status}): ${json?.[0]?.message || json?.message || "Unknown error"}`);
    return;
  }

  const recs = json?.records || [];
  const filtered = recs.filter(passesDeployFilter).filter(passesDeploySearch);

  const tbody = el("deploymentsTbody");
  if(!tbody) return;

  if(!filtered.length){
    tbody.innerHTML = `<tr><td class="muted small" colspan="9">No deployments match the current filter.</td></tr>`;
    log("Deployments refreshed (0 rows).");
    return;
  }

  tbody.innerHTML = filtered.map(rowHtmlDeploy).join("\n");
  log(`Deployments refreshed (${filtered.length} rows).`);
}

/* -------------------- Polling -------------------- */

function stopPolling(){
  if(pollTimer){
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling(){
  stopPolling();
  const seconds = Number(el("pollInterval")?.value || 0);
  if(!seconds) return;

  pollTimer = setInterval(() => {
    fetchDeployments().catch(e => log(`Polling error: ${e?.message || e}`));
  }, seconds * 1000);

  log(`Auto-refresh enabled: every ${seconds}s`);
}

/* -------------------- Packages -------------------- */

function pkgRowHtml(r){
  const pkg = r.SubscriberPackage || {};
  const ver = r.SubscriberPackageVersion || {};
  const version = [ver.MajorVersion, ver.MinorVersion, ver.PatchVersion, ver.BuildNumber]
    .filter(x => x !== null && x !== undefined)
    .join(".");

  return `
    <tr>
      <td>${escapeHtml(pkg.Name || "—")}</td>
      <td class="mono">${escapeHtml(pkg.NamespacePrefix || "—")}</td>
      <td class="mono">${escapeHtml(version || "—")}</td>
    </tr>
  `;
}

async function fetchPackages(){
  const soql = `
    SELECT Id,
      SubscriberPackage.Name,
      SubscriberPackage.NamespacePrefix,
      SubscriberPackageVersion.MajorVersion,
      SubscriberPackageVersion.MinorVersion,
      SubscriberPackageVersion.PatchVersion,
      SubscriberPackageVersion.BuildNumber
    FROM InstalledSubscriberPackage
    ORDER BY SubscriberPackage.Name
    LIMIT 200
  `.trim();

  const { ok, status, json } = await sfFetch(`/query?q=${encodeURIComponent(soql)}`, { tooling: true });

  const tbody = el("packagesTbody");
  if(!tbody) return;

  if(!ok){
    log(`Packages query failed (HTTP ${status}): ${json?.[0]?.message || json?.message || "Unknown error"}`);
    tbody.innerHTML = `<tr><td class="muted small" colspan="3">Failed to load packages.</td></tr>`;
    return;
  }

  const recs = json?.records || [];
  const q = (el("pkgSearch")?.value || "").trim().toLowerCase();
  const filtered = !q ? recs : recs.filter(r => {
    const pkg = r.SubscriberPackage || {};
    return `${pkg.Name||""} ${pkg.NamespacePrefix||""}`.toLowerCase().includes(q);
  });

  if(!filtered.length){
    tbody.innerHTML = `<tr><td class="muted small" colspan="3">No packages match your search.</td></tr>`;
    log("Packages refreshed (0 rows).");
    return;
  }

  tbody.innerHTML = filtered.map(pkgRowHtml).join("\n");
  log(`Packages refreshed (${filtered.length} rows).`);
}

/* -------------------- Metadata inventory (Tooling approximation) -------------------- */

/**
 * GitHub Pages + browser-only cannot reliably call Metadata SOAP due to CORS.
 * This tab approximates Workbench “metadata listing” by:
 *  - discovering Tooling API sObjects
 *  - letting you list members for common metadata-like objects
 *  - using describe() to find the best name field (Name / DeveloperName / FullName / QualifiedApiName)
 */
const COMMON_METADATA_TYPES = [
  "ApexClass","ApexTrigger","ApexPage","ApexComponent",
  "FlowDefinition","Flow",
  "CustomObject","CustomField",
  "Layout","PermissionSet","Profile",
  "StaticResource","LightningComponentBundle",
  "EmailTemplate","Report","Dashboard",
  "RemoteProxy","NamedCredential","AuthProvider"
];

function looksMetadataLike(name){
  return /(Apex|Flow|Custom|Layout|Permission|Profile|StaticResource|Lightning|EmailTemplate|Report|Dashboard|Remote|NamedCredential|AuthProvider)/i.test(name);
}

async function toolingDescribe(sobject){
  if(describeCache.has(sobject)) return describeCache.get(sobject);

  const { ok, status, json } = await sfFetch(`/sobjects/${encodeURIComponent(sobject)}/describe`, { tooling: true });
  if(!ok){
    log(`Describe failed for ${sobject} (HTTP ${status}): ${json?.[0]?.message || json?.message || "Unknown error"}`);
    describeCache.set(sobject, null);
    return null;
  }
  describeCache.set(sobject, json);
  return json;
}

function pickNameField(describeJson){
  if(!describeJson?.fields) return null;
  const candidates = ["Name","DeveloperName","FullName","QualifiedApiName","ApiName","NamespacePrefix"];
  const fields = describeJson.fields.map(f => f.name);
  for(const c of candidates){
    if(fields.includes(c)) return c;
  }
  // fallback: first string-like + name-ish
  const byName = describeJson.fields.find(f => /name/i.test(f.name) && f.type === "string");
  return byName?.name || null;
}

function hasField(describeJson, fieldName){
  return !!describeJson?.fields?.some(f => f.name === fieldName);
}

async function discoverToolingTypes(){
  const { ok, status, json } = await sfFetch(`/sobjects/`, { tooling: true });
  if(!ok){
    log(`Tooling sobjects discovery failed (HTTP ${status}): ${json?.[0]?.message || json?.message || "Unknown error"}`);
    return;
  }

  const names = (json?.sobjects || []).map(s => s.name).filter(Boolean);
  toolingSobjects = names;

  // Build select list: prefer common types that actually exist, then add other metadata-like
  const existingCommon = COMMON_METADATA_TYPES.filter(n => names.includes(n));
  const extra = names.filter(n => !existingCommon.includes(n) && looksMetadataLike(n)).slice(0, 120);

  const options = [...existingCommon, ...extra].map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("");
  const sel = el("metadataTypeSelect");
  if(sel){
    sel.innerHTML = options || `<option value="">(No metadata-like Tooling objects found)</option>`;
  }

  log(`Metadata inventory: discovered ${names.length} Tooling sObjects. Loaded ${existingCommon.length + extra.length} into the picker.`);
}

function metadataRowHtml(type, member, lastModified, modifiedBy, id){
  return `
    <tr>
      <td>${escapeHtml(type)}</td>
      <td>${escapeHtml(member || "—")}</td>
      <td class="mono">${escapeHtml(lastModified || "—")}</td>
      <td>${escapeHtml(modifiedBy || "—")}</td>
      <td class="mono">${escapeHtml(id || "—")}</td>
    </tr>
  `;
}

async function fetchAllQueryRecords(initialPath, { tooling=true } = {}){
  let all = [];
  let path = initialPath;

  for(let i=0; i<20; i++){
    const { ok, status, json } = await sfFetch(path, { tooling });
    if(!ok){
      return { ok:false, status, json, records: all };
    }
    const recs = json?.records || [];
    all = all.concat(recs);
    if(json?.nextRecordsUrl){
      // nextRecordsUrl is absolute-ish (starts with /services/..). We need to call it against base.
      // We'll pass it as path relative to the same tooling base by stripping the /services/data/vXX.X/tooling prefix if present.
      const nr = String(json.nextRecordsUrl);
      const marker = `/services/data/v${API_VERSION}/tooling`;
      path = nr.startsWith(marker) ? nr.slice(marker.length) : nr; // ok if it already begins with /query/...
    }else{
      break;
    }
  }
  return { ok:true, status:200, json:null, records: all };
}

async function listMetadataMembers(){
  const type = el("metadataTypeSelect")?.value;
  const tbody = el("metadataTbody");
  if(!tbody) return;

  if(!type){
    tbody.innerHTML = `<tr><td class="muted small" colspan="5">Pick a type first.</td></tr>`;
    return;
  }

  const d = await toolingDescribe(type);
  if(!d){
    tbody.innerHTML = `<tr><td class="muted small" colspan="5">Type ${escapeHtml(type)} is not describable in Tooling API for this org.</td></tr>`;
    return;
  }

  const nameField = pickNameField(d);
  if(!nameField){
    tbody.innerHTML = `<tr><td class="muted small" colspan="5">No obvious name field found for ${escapeHtml(type)}.</td></tr>`;
    return;
  }

  const fields = [ "Id", nameField ];
  const canLastMod = hasField(d,"LastModifiedDate");
  const canLastModBy = hasField(d,"LastModifiedById");
  if(canLastMod) fields.push("LastModifiedDate");
  // Relationship select requires relationshipName; for User it's usually LastModifiedBy
  if(canLastModBy && hasField(d,"LastModifiedBy")) fields.push("LastModifiedBy.Name");

  // Some Tooling objects don't support ORDER BY on LastModifiedDate; keep it simple.
  const soql = `SELECT ${fields.join(", ")} FROM ${type} LIMIT 2000`;

  log(`Metadata inventory: querying ${type}…`);

  const result = await fetchAllQueryRecords(`/query?q=${encodeURIComponent(soql)}`, { tooling:true });
  if(!result.ok){
    log(`Metadata query failed (HTTP ${result.status}): ${result.json?.[0]?.message || result.json?.message || "Unknown error"}`);
    tbody.innerHTML = `<tr><td class="muted small" colspan="5">Query failed for ${escapeHtml(type)}.</td></tr>`;
    return;
  }

  const recs = result.records || [];
  const q = (el("metadataSearch")?.value || "").trim().toLowerCase();

  const rows = recs
    .map(r => {
      const member = r[nameField];
      const lastMod = canLastMod ? (r.LastModifiedDate || null) : null;
      const modBy = (r.LastModifiedBy && r.LastModifiedBy.Name) ? r.LastModifiedBy.Name : null;
      return { type, member, lastMod, modBy, id: r.Id };
    })
    .filter(x => !q ? true : String(x.member||"").toLowerCase().includes(q));

  if(!rows.length){
    tbody.innerHTML = `<tr><td class="muted small" colspan="5">No members returned (or filtered out).</td></tr>`;
    log(`Metadata inventory: ${type} returned 0 rows (after filter).`);
    return;
  }

  tbody.innerHTML = rows
    .sort((a,b)=>String(a.member||"").localeCompare(String(b.member||"")))
    .slice(0, 2000)
    .map(r => metadataRowHtml(r.type, r.member, r.lastMod, r.modBy, r.id))
    .join("\n");

  log(`Metadata inventory: ${type} loaded (${rows.length} rows).`);
}

/* -------------------- Misc actions -------------------- */

async function refreshNow(){
  const token = loadToken();
  if(token?.instance_url){
    setText("orgPill", `Org: ${token.instance_url}`);
    setText("apiPill", `API: v${API_VERSION}`);
    setAuthPill("OK");
  }

  const active = document.querySelector(".tab.active")?.id || "tabDeployments";
  if(active === "tabPackages") return fetchPackages();
  if(active === "tabMetadata") return; // user-driven (discover/list)
  return fetchDeployments();
}

function clearStorageAndReload(){
  clearToken();
  clearSessionState();
  stopPolling();
  location.reload();
}

/* -------------------- Wiring -------------------- */

wireClick("loginBtn", login);
wireClick("logoutBtn", logout);
wireClick("clearStorageBtn", clearStorageAndReload);
wireClick("refreshBtn", refreshNow);

wireClick("tabDeployments", () => { setActiveTab("tabDeployments"); refreshNow(); });
wireClick("tabPackages", () => { setActiveTab("tabPackages"); fetchPackages(); });
wireClick("tabMetadata", () => { setActiveTab("tabMetadata"); });

wireChange("pollInterval", startPolling);
wireChange("deployFilter", fetchDeployments);
wireChange("deployLimit", fetchDeployments);
el("deploySearch")?.addEventListener("input", () => fetchDeployments().catch(()=>{}));

wireClick("refreshPackagesBtn", fetchPackages);
el("pkgSearch")?.addEventListener("input", () => fetchPackages().catch(()=>{}));

wireClick("discoverMetadataBtn", discoverToolingTypes);
wireClick("fetchMetadataBtn", listMetadataMembers);
el("metadataSearch")?.addEventListener("input", () => listMetadataMembers().catch(()=>{}));

/* -------------------- Init -------------------- */

(async function init(){
  setActiveTab("tabDeployments");

  await handleRedirectIfPresent();

  const token = loadToken();
  if(token?.access_token){
    setText("orgPill", `Org: ${token.instance_url || "Connected"}`);
    setText("apiPill", `API: v${API_VERSION}`);
    setAuthPill("OK");
    log("Session restored.");
    await fetchDeployments();
    startPolling();
  }else{
    setText("orgPill", "Org: Not connected");
    setText("apiPill", "API: —");
    setAuthPill("Unknown");
    log("Not logged in.");
  }
})();
