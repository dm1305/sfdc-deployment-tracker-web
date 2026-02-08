const BUILD = Auth.BUILD;
let invRows = [];

function setBusy(isBusy, label=null){
  const pill = document.getElementById("busyPill");
  if (pill) pill.textContent = isBusy ? (label || "Working…") : "Idle";
  document.getElementById("runInventoryBtn").disabled = !!isBusy;
}

function setLastRun(){
  const el = document.getElementById("lastRefreshed");
  if (el) el.textContent = `Last run: ${new Date().toISOString().replace("T"," ").replace("Z","Z")}`;
}

function setLastRequest(text){
  const el = document.getElementById("lastRequest");
  if (el) el.textContent = `Last request: ${text}`;
}

/* ---------- Progress bar ---------- */
function setProgress(pct, label){
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  const bar = document.getElementById("invProgress");
  const pctEl = document.getElementById("progressPct");
  const lbl = document.getElementById("progressLabel");
  if (bar) bar.value = p;
  if (pctEl) pctEl.textContent = `${p}%`;
  if (lbl) lbl.textContent = label || (p === 100 ? "Done" : "Working…");
}

/* ---------- Inventory definition ---------- */
/**
 * NOTE: This is Tooling-based inventory (fast, CORS-friendly in browser),
 * not a full Metadata API fileProperties list.
 * It still covers many “files” people care about (Apex, LWC, Aura, Flow, StaticResource).
 */
const INVENTORY_TYPES = [
  {
    key: "ApexClass",
    scope: "code",
    nameField: "Name",
    soql: (limit) => `
      SELECT Id, Name, NamespacePrefix,
             CreatedDate, CreatedBy.Name,
             LastModifiedDate, LastModifiedBy.Name
      FROM ApexClass
      ORDER BY LastModifiedDate DESC
      LIMIT ${limit}
    `.trim()
  },
  {
    key: "ApexTrigger",
    scope: "code",
    nameField: "Name",
    soql: (limit) => `
      SELECT Id, Name, NamespacePrefix,
             CreatedDate, CreatedBy.Name,
             LastModifiedDate, LastModifiedBy.Name
      FROM ApexTrigger
      ORDER BY LastModifiedDate DESC
      LIMIT ${limit}
    `.trim()
  },
  {
    key: "LightningComponentBundle",
    scope: "code",
    nameField: "DeveloperName",
    soql: (limit) => `
      SELECT Id, DeveloperName, NamespacePrefix,
             CreatedDate, CreatedBy.Name,
             LastModifiedDate, LastModifiedBy.Name
      FROM LightningComponentBundle
      ORDER BY LastModifiedDate DESC
      LIMIT ${limit}
    `.trim()
  },
  {
    key: "AuraDefinitionBundle",
    scope: "code",
    nameField: "DeveloperName",
    soql: (limit) => `
      SELECT Id, DeveloperName, NamespacePrefix,
             CreatedDate, CreatedBy.Name,
             LastModifiedDate, LastModifiedBy.Name
      FROM AuraDefinitionBundle
      ORDER BY LastModifiedDate DESC
      LIMIT ${limit}
    `.trim()
  },
  {
    key: "Flow",
    scope: "automation",
    nameField: "DeveloperName",
    soql: (limit) => `
      SELECT Id, DeveloperName, NamespacePrefix,
             CreatedDate, CreatedBy.Name,
             LastModifiedDate, LastModifiedBy.Name
      FROM Flow
      ORDER BY LastModifiedDate DESC
      LIMIT ${limit}
    `.trim()
  },
  {
    key: "StaticResource",
    scope: "assets",
    nameField: "Name",
    soql: (limit) => `
      SELECT Id, Name, NamespacePrefix,
             CreatedDate, CreatedBy.Name,
             LastModifiedDate, LastModifiedBy.Name
      FROM StaticResource
      ORDER BY LastModifiedDate DESC
      LIMIT ${limit}
    `.trim()
  }
];

function currentInventorySet(){
  const scope = document.getElementById("invScope")?.value || "all";
  if (scope === "all") return INVENTORY_TYPES;
  return INVENTORY_TYPES.filter(t => t.scope === scope);
}

function fmtTime(s){
  if (!s) return "—";
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toISOString().replace("T"," ").replace("Z","Z") : "—";
}

function escapeHtml(s){
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function renderTable(rows){
  const tbody = document.getElementById("invTbody");
  if (!tbody) return;

  if (!rows.length){
    tbody.innerHTML = `<tr><td colspan="8" class="muted small">No results.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(r => `
    <tr class="row">
      <td>${escapeHtml(r.type)}</td>
      <td class="mono">${escapeHtml(r.apiName)}</td>
      <td class="mono">${escapeHtml(r.namespace || "—")}</td>
      <td class="mono">${escapeHtml(fmtTime(r.lastModifiedDate))}</td>
      <td>${escapeHtml(r.lastModifiedBy || "—")}</td>
      <td class="mono">${escapeHtml(fmtTime(r.createdDate))}</td>
      <td>${escapeHtml(r.createdBy || "—")}</td>
      <td class="mono">${escapeHtml(r.id)}</td>
    </tr>
  `).join("\n");

  // click to select (delegation)
  tbody.querySelectorAll("tr").forEach((tr, idx) => {
    tr.addEventListener("click", () => {
      const row = rows[idx];
      Auth.setSelected(row);
    });
  });
}

async function runInventory(){
  const token = Auth.loadToken();
  if (!token?.access_token){
    Auth.showBanner("Not logged in. Click Login.");
    return;
  }

  invRows = [];
  renderTable(invRows);
  document.getElementById("downloadCsvBtn").disabled = true;

  const perLimit = Number(document.getElementById("invLimit")?.value || 250);
  const types = currentInventorySet();
  const totalSteps = types.length;
  let done = 0;

  setBusy(true, "Scanning…");
  setProgress(0, "Starting…");
  Auth.showBanner("");

  for (const t of types){
    done += 1;
    const pct = (done - 1) / totalSteps * 100;
    setProgress(pct, `Querying ${t.key}…`);
    setLastRequest(`tooling query ${t.key}`);

    const soql = t.soql(perLimit);
    const { ok, status, json } = await Auth.sfFetch(`/query?q=${encodeURIComponent(soql)}`, { tooling:true });

    if (!ok){
      // If this type isn't queryable in the org, skip it but log the failure
      Auth.log(`Inventory: ${t.key} failed (HTTP ${status}). Skipping. ${Auth.extractSfError(json)}`);
      continue;
    }

    const recs = json?.records || [];
    const nameField = t.nameField;

    recs.forEach(r => {
      invRows.push({
        type: t.key,
        apiName: r[nameField] || r.Name || r.DeveloperName || "(unknown)",
        namespace: r.NamespacePrefix || "",
        lastModifiedDate: r.LastModifiedDate,
        lastModifiedBy: r.LastModifiedBy?.Name,
        createdDate: r.CreatedDate,
        createdBy: r.CreatedBy?.Name,
        id: r.Id
      });
    });

    // live render as we go
    renderTable(invRows);
    setProgress(done / totalSteps * 100, `Loaded ${t.key} (${recs.length})`);
  }

  // sort by lastModified desc
  invRows.sort((a,b) => (b.lastModifiedDate || "").localeCompare(a.lastModifiedDate || ""));

  renderTable(invRows);
  setProgress(100, `Done (${invRows.length} rows)`);
  setLastRun();
  setBusy(false);

  document.getElementById("downloadCsvBtn").disabled = invRows.length === 0;
  Auth.log(`Inventory complete. Rows: ${invRows.length}`);
}

function downloadCsv(){
  if (!invRows.length) return;

  const headers = ["type","apiName","namespace","lastModifiedDate","lastModifiedBy","createdDate","createdBy","id"];
  const lines = [headers.join(",")];

  for (const r of invRows){
    const row = headers.map(h => {
      const v = (r[h] ?? "").toString();
      const escaped = v.includes(",") || v.includes('"') || v.includes("\n")
        ? `"${v.replaceAll('"','""')}"`
        : v;
      return escaped;
    });
    lines.push(row.join(","));
  }

  const blob = new Blob([lines.join("\n")], { type:"text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `metadata-inventory_${new Date().toISOString().slice(0,19).replaceAll(":","-")}Z.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ---------- Wiring ---------- */
document.getElementById("loginBtn")?.addEventListener("click", Auth.login);
document.getElementById("logoutBtn")?.addEventListener("click", Auth.logout);
document.getElementById("runInventoryBtn")?.addEventListener("click", runInventory);
document.getElementById("downloadCsvBtn")?.addEventListener("click", downloadCsv);

/* ---------- Init ---------- */
(async function init(){
  Auth.wireApiVersionSelect();
  Auth.setText("buildPill", BUILD);
  Auth.setText("apiPill", `v${Auth.getApiVersion()}`);

  await Auth.handleRedirectIfPresent();

  const token = Auth.loadToken();
  if (token?.access_token){
    Auth.setText("orgPill", token.instance_url || "Connected");
    Auth.log("Session restored.");
  } else {
    Auth.setText("orgPill", "Not connected");
    Auth.log("Not logged in.");
  }

  setProgress(0, "Idle");
})();
