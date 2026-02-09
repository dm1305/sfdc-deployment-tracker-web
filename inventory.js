// inventory.js
// Tooling-based "inventory" scan of many metadata-like sObjects.
// NOTE: Tooling API does not expose *all* Metadata API types; this page reports what Tooling can query.
//
// Improvements in this version:
// - Expanded default target list (many more tooling objects)
// - Optional inclusion of large types (Profile/PermissionSet)
// - Client-side filters (type + free-text + modified-after)
// - Progress bar + per-type logging
// - CSV download

const BUILD = Auth.BUILD;

let invRows = [];
let lastRawRows = [];

function $(id){ return document.getElementById(id); }

function setBusy(isBusy, label=null){
  const pill = $("busyPill");
  if (pill) pill.textContent = isBusy ? (label || "Working…") : "Idle";
  const btn = $("runInventoryBtn");
  if (btn) btn.disabled = !!isBusy;
  const dl = $("downloadCsvBtn");
  if (dl) dl.disabled = !!isBusy || !invRows.length;
}

function setLastRun(){
  Auth.setText("lastRefreshed", `Last run: ${new Date().toISOString().replace("T"," ").replace("Z","Z")}`);
}

function setLastRequest(txt){
  Auth.setText("lastRequest", `Last request: ${txt}`);
}

function setProgress(pct, label){
  const prog = $("invProgress");
  const pctEl = $("progressPct");
  const lbl = $("progressLabel");
  if (prog) prog.value = Math.max(0, Math.min(100, pct));
  if (pctEl) pctEl.textContent = `${Math.round(pct)}%`;
  if (lbl) lbl.textContent = label || "";
}

function normalizeText(s){
  return String(s || "").toLowerCase();
}

/* -------------------- Target lists -------------------- */

function baseTargets(){
  // Curated list of common metadata-ish Tooling sObjects.
  // Each entry: { typeLabel, sobject, nameField }
  return [
    { typeLabel:"ApexClass", sobject:"ApexClass", nameField:"Name" },
    { typeLabel:"ApexTrigger", sobject:"ApexTrigger", nameField:"Name" },
    { typeLabel:"ApexPage", sobject:"ApexPage", nameField:"Name" },
    { typeLabel:"ApexComponent", sobject:"ApexComponent", nameField:"Name" },
    { typeLabel:"AuraDefinitionBundle", sobject:"AuraDefinitionBundle", nameField:"DeveloperName" },
    { typeLabel:"LightningComponentBundle", sobject:"LightningComponentBundle", nameField:"DeveloperName" },
    { typeLabel:"StaticResource", sobject:"StaticResource", nameField:"Name" },

    { typeLabel:"CustomObject", sobject:"CustomObject", nameField:"DeveloperName" },
    { typeLabel:"CustomField", sobject:"CustomField", nameField:"DeveloperName" },
    { typeLabel:"Layout", sobject:"Layout", nameField:"Name" },
    { typeLabel:"RecordType", sobject:"RecordType", nameField:"DeveloperName" },
    { typeLabel:"ValidationRule", sobject:"ValidationRule", nameField:"ValidationName" },

    { typeLabel:"Flow", sobject:"Flow", nameField:"DeveloperName" },
    { typeLabel:"FlowDefinition", sobject:"FlowDefinition", nameField:"DeveloperName" },

    { typeLabel:"EmailTemplate", sobject:"EmailTemplate", nameField:"DeveloperName" },
    { typeLabel:"Report", sobject:"Report", nameField:"DeveloperName" },
    { typeLabel:"Dashboard", sobject:"Dashboard", nameField:"DeveloperName" },

    { typeLabel:"RemoteSiteSetting", sobject:"RemoteSiteSetting", nameField:"DeveloperName" },
    { typeLabel:"NamedCredential", sobject:"NamedCredential", nameField:"DeveloperName" },
    { typeLabel:"AuthProvider", sobject:"AuthProvider", nameField:"DeveloperName" },

    { typeLabel:"CustomMetadata", sobject:"CustomMetadata", nameField:"DeveloperName" },
    { typeLabel:"CustomLabel", sobject:"ExternalString", nameField:"Name" }, // orgs may not have this; will be skipped on error

    { typeLabel:"CustomPermission", sobject:"CustomPermission", nameField:"DeveloperName" },
    { typeLabel:"PermissionSetGroup", sobject:"PermissionSetGroup", nameField:"DeveloperName" },
  ];
}

function largeTargets(){
  return [
    { typeLabel:"PermissionSet", sobject:"PermissionSet", nameField:"Name" },
    { typeLabel:"Profile", sobject:"Profile", nameField:"Name" },
  ];
}

function scopeTargets(scope){
  const all = baseTargets();

  if (scope === "code") {
    return all.filter(t => ["ApexClass","ApexTrigger","ApexPage","ApexComponent","AuraDefinitionBundle","LightningComponentBundle","StaticResource"].includes(t.typeLabel));
  }
  if (scope === "automation") {
    return all.filter(t => ["Flow","FlowDefinition","ValidationRule","RecordType"].includes(t.typeLabel));
  }
  if (scope === "security") {
    return all.filter(t => ["RemoteSiteSetting","NamedCredential","AuthProvider","CustomPermission","PermissionSetGroup"].includes(t.typeLabel));
  }
  if (scope === "content") {
    return all.filter(t => ["EmailTemplate","Report","Dashboard"].includes(t.typeLabel));
  }
  if (scope === "metadata") {
    return all.filter(t => ["CustomObject","CustomField","Layout","CustomMetadata","CustomPermission"].includes(t.typeLabel));
  }

  // "all" and "auto" both use the same curated list here (Tooling doesn't fully cover Metadata API)
  return all;
}

/* -------------------- Query helpers -------------------- */

function buildSoql(t, limit, modifiedAfterIso){
  // Note: not all objects have NamespacePrefix; we still request it and tolerate missing.
  // We attempt a minimal common set; if a field doesn't exist, SF will error and we'll log+skip.
  const fields = [
    "Id",
    t.nameField,
    "NamespacePrefix",
    "LastModifiedDate",
    "LastModifiedBy.Name",
    "CreatedDate",
    "CreatedBy.Name",
  ];

  let where = "";
  if (modifiedAfterIso) {
    // Tooling SOQL uses ISO datetime literal without quotes if using 2026-...Z? Safer: wrap in 2026-..Z in quotes.
    where = ` WHERE LastModifiedDate >= ${modifiedAfterIso.includes("'") ? modifiedAfterIso : ("'" + modifiedAfterIso + "'")}`;
  }

  return `SELECT ${fields.join(", ")} FROM ${t.sobject}${where} ORDER BY LastModifiedDate DESC LIMIT ${limit}`;
}

function rowToModel(t, r){
  const apiName = r[t.nameField] || r.Name || r.DeveloperName || r.FullName || r.Id;
  return {
    Type: t.typeLabel,
    ApiName: apiName,
    Namespace: r.NamespacePrefix || "",
    LastModifiedDate: r.LastModifiedDate || "",
    LastModifiedBy: r.LastModifiedBy?.Name || "",
    CreatedDate: r.CreatedDate || "",
    CreatedBy: r.CreatedBy?.Name || "",
    Id: r.Id || "",
    _raw: r,
  };
}

/* -------------------- Filtering / rendering -------------------- */

function passesFilters(row){
  const typeQ = normalizeText($("typeFilter")?.value || "");
  const textQ = normalizeText($("textFilter")?.value || "");

  if (typeQ && !normalizeText(row.Type).includes(typeQ)) return false;

  if (textQ) {
    const blob = normalizeText([
      row.Type, row.ApiName, row.Namespace, row.LastModifiedBy, row.CreatedBy, row.Id
    ].filter(Boolean).join(" "));
    if (!blob.includes(textQ)) return false;
  }

  const modAfter = $("modifiedAfter")?.value || "";
  if (modAfter) {
    const after = new Date(modAfter + "T00:00:00Z");
    const lm = row.LastModifiedDate ? new Date(row.LastModifiedDate) : null;
    if (lm && lm < after) return false;
  }

  return true;
}

function render(){
  const tbody = $("invTbody");
  if (!tbody) return;

  const rows = (invRows || []).filter(passesFilters);

  if (!rows.length) {
    tbody.innerHTML = `<tr><td class="muted small" colspan="8">No rows match the current filters.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map((r, idx) => `
    <tr data-idx="${idx}">
      <td>${r.Type || "—"}</td>
      <td class="mono">${escapeHtml(r.ApiName || "—")}</td>
      <td class="mono">${escapeHtml(r.Namespace || "—")}</td>
      <td class="mono">${escapeHtml(r.LastModifiedDate || "—")}</td>
      <td>${escapeHtml(r.LastModifiedBy || "—")}</td>
      <td class="mono">${escapeHtml(r.CreatedDate || "—")}</td>
      <td>${escapeHtml(r.CreatedBy || "—")}</td>
      <td class="mono">${escapeHtml(r.Id || "—")}</td>
    </tr>
  `).join("\n");

  tbody.querySelectorAll("tr[data-idx]").forEach(tr => {
    tr.addEventListener("click", () => {
      const i = Number(tr.getAttribute("data-idx"));
      const rec = rows[i];
      if (!rec) return;
      Auth.setSelected(rec);
    });
  });
}

function escapeHtml(s){
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

/* -------------------- CSV -------------------- */

function downloadCsv(){
  if (!invRows.length) return;

  const headers = ["Type","ApiName","Namespace","LastModifiedDate","LastModifiedBy","CreatedDate","CreatedBy","Id"];
  const lines = [headers.join(",")];

  // Export filtered view (what user sees), not necessarily all.
  const rows = invRows.filter(passesFilters);

  for (const r of rows) {
    const vals = [
      r.Type, r.ApiName, r.Namespace, r.LastModifiedDate, r.LastModifiedBy, r.CreatedDate, r.CreatedBy, r.Id
    ].map(v => `"${String(v ?? "").replace(/"/g,'""')}"`);
    lines.push(vals.join(","));
  }

  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `metadata_inventory_v${Auth.getApiVersion()}_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);

  Auth.log(`CSV downloaded (${rows.length} rows).`);
}

/* -------------------- Inventory scan -------------------- */

async function runInventory(){
  Auth.showBanner("");

  const token = Auth.loadToken();
  if (!token?.access_token) {
    Auth.showBanner("Not logged in. Click Login.");
    return;
  }

  const scope = $("invScope")?.value || "auto";
  const limit = Number($("invLimit")?.value || 250);
  const includeLarge = !!$("includeLargeTypes")?.checked;

  const modifiedAfter = $("modifiedAfter")?.value || "";
  const modifiedAfterIso = modifiedAfter ? new Date(modifiedAfter + "T00:00:00Z").toISOString() : null;

  let targets = scopeTargets(scope);
  if (includeLarge) targets = targets.concat(largeTargets());

  // Optional type filter to reduce scan set early
  const typeQ = normalizeText($("typeFilter")?.value || "");
  if (typeQ) {
    targets = targets.filter(t => normalizeText(t.typeLabel).includes(typeQ) || normalizeText(t.sobject).includes(typeQ));
  }

  if (!targets.length) {
    Auth.log("No targets to scan (filters removed all).");
    return;
  }

  setBusy(true, "Scanning…");
  setProgress(0, `Starting (API v${Auth.getApiVersion()}) …`);
  setLastRequest(`scan ${targets.length} types`);

  invRows = [];
  lastRawRows = [];

  Auth.log(`Scan started (API v${Auth.getApiVersion()}) across ${targets.length} types.`);

  for (let i=0; i<targets.length; i++){
    const t = targets[i];
    const pct = (i / targets.length) * 100;

    setProgress(pct, `${t.typeLabel}…`);
    setLastRequest(`${t.typeLabel} (limit ${limit})`);

    const soql = buildSoql(t, limit, modifiedAfterIso);
    const { ok, status, json } = await Auth.sfFetch(`/query?q=${encodeURIComponent(soql)}`, { tooling: true });

    if (!ok) {
      const msg = Auth.extractSfError(json);
      // If 401, stop immediately (token invalid)
      if (status === 401) {
        Auth.log(`Error 401 on ${t.typeLabel}. Token likely expired.`);
        Auth.showBanner("Session expired/invalid (401). Click Login again.");
        break;
      }
      Auth.log(`${t.typeLabel}: skipped (query failed): ${msg}`);
      continue;
    }

    const recs = json?.records || [];
    Auth.log(`${t.typeLabel}: ${recs.length} rows`);
    for (const r of recs) {
      try {
        const model = rowToModel(t, r);
        invRows.push(model);
        lastRawRows.push({ t, r });
      } catch (e) {
        Auth.log(`${t.typeLabel}: row parse error: ${e?.message || e}`);
      }
    }
  }

  setProgress(100, "Complete.");
  setBusy(false);
  setLastRun();

  Auth.log(`Scan complete. Total rows: ${invRows.length}`);
  Auth.setSelected({ summary: { totalRows: invRows.length, apiVersion: Auth.getApiVersion() }, sample: invRows.slice(0, 5) });

  const dl = $("downloadCsvBtn");
  if (dl) dl.disabled = !invRows.length;

  render();
}

/* -------------------- Wiring / init -------------------- */

function debounce(fn, ms = 250){
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

$("runInventoryBtn")?.addEventListener("click", runInventory);
$("downloadCsvBtn")?.addEventListener("click", downloadCsv);

$("typeFilter")?.addEventListener("input", debounce(render, 150));
$("textFilter")?.addEventListener("input", debounce(render, 150));
$("modifiedAfter")?.addEventListener("change", debounce(render, 0));
$("invScope")?.addEventListener("change", () => Auth.log(`Scope set: ${$("invScope").value}`));
$("invLimit")?.addEventListener("change", () => Auth.log(`Per-type limit set: ${$("invLimit").value}`));
$("includeLargeTypes")?.addEventListener("change", () => Auth.log(`include large types: ${$("includeLargeTypes").checked}`));

$("loginBtn")?.addEventListener("click", Auth.login);
$("logoutBtn")?.addEventListener("click", Auth.logout);

(async function init(){
  Auth.wireErrorUI();
  Auth.wireApiVersionSelect();

  Auth.setText("buildPill", BUILD);
  Auth.setText("apiPill", `v${Auth.getApiVersion()}`);
  Auth.showBanner("");

  setProgress(0, "Idle");
  setBusy(false);

  await Auth.handleRedirectIfPresent();

  const token = Auth.loadToken();
  if (token?.access_token) {
    await Auth.ensureOrgContext();
    Auth.renderOrgContext();
    Auth.renderErrors();
    Auth.renderOrgDetails();
    Auth.log("Session restored.");
  } else {
    Auth.setText("orgPill", "Not connected");
    Auth.log("Not logged in.");
  }

  render();
})();
