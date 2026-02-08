const TOKEN_KEY = "sf_token";
const API_VERSION = "65.0";

function $(id){ return document.getElementById(id); }

let allRows = []; // normalized rows across types
let busy = false;

function setBusy(on, label){
  busy = on;
  $("busy").textContent = on ? (label || "Working…") : "Idle";
  $("scanBtn").disabled = on;
  $("exportBtn").disabled = on;
}

function banner(msg){
  const b = $("banner");
  b.textContent = msg || "";
  b.style.display = msg ? "block" : "none";
}

function log(msg){
  const el = $("log");
  const stamp = new Date().toISOString();
  el.textContent = `[${stamp}] ${msg}\n` + el.textContent;
}

function loadToken(){
  const raw = localStorage.getItem(TOKEN_KEY);
  return raw ? JSON.parse(raw) : null;
}

function extractSfError(json){
  if (!json) return "Unknown error";
  if (Array.isArray(json) && json[0]?.message) return json[0].message;
  if (json?.message) return json.message;
  if (json?.error_description) return json.error_description;
  if (json?.error) return json.error;
  return JSON.stringify(json);
}

async function sfFetchTooling(path){
  const t = loadToken();
  if (!t?.access_token || !t?.instance_url) {
    banner("Not logged in. Go back and Login first.");
    return { ok:false, status:0, json:null };
  }

  const url = `${t.instance_url}/services/data/v${API_VERSION}/tooling${path}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${t.access_token}` }});
  const json = await resp.json().catch(() => null);

  if (!resp.ok) {
    const msg = extractSfError(json);
    log(`Tooling request failed (HTTP ${resp.status}): ${msg}`);
  }

  return { ok: resp.ok, status: resp.status, json };
}

/*
  These are “file-like” metadata-ish assets that typically expose:
  - Id, Name/DeveloperName
  - LastModifiedDate, LastModifiedBy.Name
  - CreatedDate, CreatedBy.Name
  Coverage is best-effort; you can extend this list as you discover support in your org.
*/
const TARGETS = [
  { type: "ApexClass", sobject: "ApexClass", nameField: "Name", extra: ["ApiVersion", "Status"] },
  { type: "ApexTrigger", sobject: "ApexTrigger", nameField: "Name", extra: ["ApiVersion", "Status"] },
  { type: "LightningComponentBundle", sobject: "LightningComponentBundle", nameField: "DeveloperName", extra: ["NamespacePrefix", "Language"] },
  { type: "AuraDefinitionBundle", sobject: "AuraDefinitionBundle", nameField: "DeveloperName", extra: ["NamespacePrefix"] },
  { type: "StaticResource", sobject: "StaticResource", nameField: "Name", extra: ["ContentType", "CacheControl"] },
  { type: "CustomObject", sobject: "CustomObject", nameField: "DeveloperName", extra: ["NamespacePrefix"] },
  { type: "CustomField", sobject: "CustomField", nameField: "DeveloperName", extra: ["TableEnumOrId", "Type"] },
  { type: "CustomMetadata", sobject: "CustomMetadata", nameField: "DeveloperName", extra: ["NamespacePrefix"] },
  { type: "Layout", sobject: "Layout", nameField: "Name", extra: ["TableEnumOrId"] },
  { type: "PermissionSet", sobject: "PermissionSet", nameField: "Name", extra: ["NamespacePrefix", "IsOwnedByProfile"] },
  { type: "Profile", sobject: "Profile", nameField: "Name", extra: [] },
];

function toSoqlDateTimeLiteral(dt){
  // 2026-02-08T12:34:56Z (no milliseconds)
  return dt.toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function queryAll(soql){
  const rows = [];
  let next = `/query?q=${encodeURIComponent(soql)}`;

  while (next) {
    const { ok, status, json } = await sfFetchTooling(next);
    if (!ok) {
      return { ok:false, status, rows:[], error: extractSfError(json) };
    }
    rows.push(...(json.records || []));
    next = json.nextRecordsUrl || null;
    if (next && !next.startsWith("/")) next = "/" + next;
  }
  return { ok:true, status:200, rows };
}

function normalize(type, nameField, record, extraFields){
  const apiName = record?.[nameField] ?? "—";
  const extraObj = {};
  for (const f of extraFields || []) extraObj[f] = record?.[f];

  return {
    metadataType: type,
    apiName,
    lastModifiedDate: record.LastModifiedDate || null,
    lastModifiedBy: record.LastModifiedBy?.Name || "—",
    createdDate: record.CreatedDate || null,
    createdBy: record.CreatedBy?.Name || "—",
    id: record.Id,
    extra: extraObj,
    raw: record,
  };
}

function render(){
  const typeVal = $("typeFilter").value;
  const q = ($("search").value || "").trim().toLowerCase();
  const sinceVal = $("sinceDt").value;

  const since = sinceVal ? new Date(sinceVal) : null;

  let rows = allRows.slice();

  if (typeVal !== "all") rows = rows.filter(r => r.metadataType === typeVal);

  if (since) {
    rows = rows.filter(r => r.lastModifiedDate && new Date(r.lastModifiedDate) >= since);
  }

  if (q) {
    rows = rows.filter(r => {
      const blob = [
        r.metadataType,
        r.apiName,
        r.lastModifiedBy,
        r.createdBy,
        r.id,
        JSON.stringify(r.extra || {})
      ].join(" ").toLowerCase();
      return blob.includes(q);
    });
  }

  $("stats").textContent = `${rows.length} rows`;

  const tbody = $("tbody");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="muted small">No matches.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(r => {
    const extra = Object.entries(r.extra || {})
      .filter(([,v]) => v !== undefined && v !== null && v !== "")
      .map(([k,v]) => `${k}=${v}`)
      .join(", ");

    return `
      <tr>
        <td>${r.metadataType}</td>
        <td class="mono">${escapeHtml(r.apiName)}</td>
        <td class="mono">${fmt(r.lastModifiedDate)}</td>
        <td>${escapeHtml(r.lastModifiedBy)}</td>
        <td class="mono">${fmt(r.createdDate)}</td>
        <td>${escapeHtml(r.createdBy)}</td>
        <td class="mono">${r.id}</td>
        <td class="muted small">${escapeHtml(extra || "—")}</td>
      </tr>
    `;
  }).join("\n");
}

function fmt(s){
  if (!s) return "—";
  try { return new Date(s).toISOString().replace("T"," ").replace("Z","Z"); }
  catch { return String(s); }
}

function escapeHtml(str){
  return String(str ?? "")
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    .replace(/'/g,"&#039;");
}

function populateTypeFilter(){
  const sel = $("typeFilter");
  sel.innerHTML = `<option value="all" selected>All</option>`;
  for (const t of TARGETS.map(x => x.type)) {
    const opt = document.createElement("option");
    opt.value = t;
    opt.textContent = t;
    sel.appendChild(opt);
  }
}

async function scan(){
  banner("");
  const token = loadToken();
  if (!token?.access_token) {
    banner("Not logged in. Go back to the main page and click Login.");
    return;
  }

  setBusy(true, "Scanning…");
  log(`Scan started across ${TARGETS.length} tooling objects…`);

  const sinceVal = $("sinceDt").value;
  const since = sinceVal ? new Date(sinceVal) : null;

  const out = [];
  for (const target of TARGETS) {
    const fields = [
      "Id",
      target.nameField,
      "CreatedDate",
      "CreatedBy.Name",
      "LastModifiedDate",
      "LastModifiedBy.Name",
      ...(target.extra || []),
    ];

    let where = "";
    if (since) where = ` WHERE LastModifiedDate >= ${toSoqlDateTimeLiteral(since)}`;

    const soql =
      `SELECT ${fields.join(", ")} FROM ${target.sobject}${where} ORDER BY LastModifiedDate DESC LIMIT 2000`;

    log(`Query ${target.type}…`);
    const res = await queryAll(soql);
    if (!res.ok) {
      log(`Skipping ${target.type} (not supported / permission / query error).`);
      continue;
    }

    for (const r of res.rows) {
      out.push(normalize(target.type, target.nameField, r, target.extra));
    }
  }

  // Sort newest first
  out.sort((a,b) => (b.lastModifiedDate || "").localeCompare(a.lastModifiedDate || ""));

  allRows = out;

  $("lastRun").textContent = `Last run: ${new Date().toISOString().replace("T"," ").replace("Z","Z")}`;
  log(`Scan complete. Rows: ${allRows.length}`);
  setBusy(false);

  render();
}

function exportCsv(){
  const rows = [
    ["MetadataType","ApiName","LastModifiedDate","LastModifiedBy","CreatedDate","CreatedBy","Id","Extra"]
  ];

  for (const r of allRows) {
    const extra = JSON.stringify(r.extra || {});
    rows.push([
      r.metadataType,
      r.apiName,
      r.lastModifiedDate || "",
      r.lastModifiedBy || "",
      r.createdDate || "",
      r.createdBy || "",
      r.id,
      extra
    ]);
  }

  const csv = "data:text/csv;charset=utf-8," + rows.map(r =>
    r.map(cell => `"${String(cell).replace(/"/g,'""')}"`).join(",")
  ).join("\n");

  const a = document.createElement("a");
  a.href = encodeURI(csv);
  a.download = "metadata_inventory.csv";
  a.click();
}

/* ---- wiring ---- */
$("scanBtn").addEventListener("click", scan);
$("exportBtn").addEventListener("click", exportCsv);
$("typeFilter").addEventListener("change", render);
$("search").addEventListener("input", () => render());
$("sinceDt").addEventListener("change", render);

(function init(){
  populateTypeFilter();
  $("exportBtn").disabled = false;
  log("Inventory page ready. Click Scan.");
})();
