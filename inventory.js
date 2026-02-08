const TOKEN_KEY = "sf_token";
const API_VERSION_KEY = "sf_api_version";
const DEFAULT_API_VERSION = "65.0";

function $(id){return document.getElementById(id);}
function getApiVersion(){return localStorage.getItem(API_VERSION_KEY)||DEFAULT_API_VERSION;}

function log(msg){
  $("log").textContent = `[${new Date().toISOString()}] ${msg}\n` + $("log").textContent;
}

function loadToken(){
  const r = localStorage.getItem(TOKEN_KEY);
  return r ? JSON.parse(r) : null;
}

async function sfToolingQuery(soql){
  const t = loadToken();
  if(!t){ log("Not logged in"); return { ok:false, rows:[], err:"Not logged in" }; }

  const v = getApiVersion();
  const url = `${t.instance_url}/services/data/v${v}/tooling/query?q=${encodeURIComponent(soql)}`;
  const r = await fetch(url,{headers:{Authorization:`Bearer ${t.access_token}`}});
  const j = await r.json().catch(()=>null);

  if(!r.ok){
    const err = j?.[0]?.message || j?.message || JSON.stringify(j) || `HTTP ${r.status}`;
    log(`Tooling query failed (${r.status}): ${err}`);
    return { ok:false, rows:[], err };
  }
  return { ok:true, rows: (j?.records || []), err:null };
}

/* ---- Progress UI helpers ---- */

function setProgressVisible(on){
  $("progressWrap").style.display = on ? "" : "none";
}

function setProgressIndeterminate(on){
  $("progressWrap").classList.toggle("indeterminate", !!on);
}

function setProgress(title, detail, pct){
  $("progressTitle").textContent = title || "Scanning…";
  $("progressDetail").textContent = detail ? ` — ${detail}` : "";
  const p = Math.max(0, Math.min(100, Number(pct || 0)));
  $("progressPct").textContent = `${Math.round(p)}%`;
  $("progressBar").style.width = `${p}%`;
}

function setButtonsEnabled(enabled){
  $("scanBtn").disabled = !enabled;
  $("csvBtn").disabled = !enabled || rows.length === 0;
  $("jsonBtn").disabled = !enabled || rows.length === 0;
}

/* ---- Inventory scan config ----
   Keep this list short at first; add more types as you need.
*/
const TARGETS = [
  { type:"ApexClass", sobject:"ApexClass", nameField:"Name" },
  { type:"ApexTrigger", sobject:"ApexTrigger", nameField:"Name" },
  { type:"LightningComponentBundle", sobject:"LightningComponentBundle", nameField:"DeveloperName" },
  { type:"AuraDefinitionBundle", sobject:"AuraDefinitionBundle", nameField:"DeveloperName" },
  { type:"StaticResource", sobject:"StaticResource", nameField:"Name" },
];

let rows = [];

function normalize(target, r){
  return {
    type: target.type,
    name: r[target.nameField] || "—",
    mod: r.LastModifiedDate || "",
    user: r.LastModifiedBy?.Name || "—",
    id: r.Id || ""
  };
}

function render(){
  const tb = $("tbody");
  if(!rows.length){
    tb.innerHTML = `<tr><td colspan="5">No rows returned.</td></tr>`;
    return;
  }
  tb.innerHTML = rows.map(r=>`
    <tr>
      <td>${r.type}</td>
      <td>${escapeHtml(r.name)}</td>
      <td>${r.mod}</td>
      <td>${escapeHtml(r.user)}</td>
      <td>${r.id}</td>
    </tr>
  `).join("");
}

function escapeHtml(s){
  return String(s ?? "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;")
    .replace(/'/g,"&#039;");
}

async function scan(){
  rows = [];
  render();
  setButtonsEnabled(false);

  const token = loadToken();
  if(!token){
    log("Not logged in. Go back to main page and Login first.");
    setButtonsEnabled(true);
    return;
  }

  setProgressVisible(true);
  setProgressIndeterminate(true);
  setProgress("Starting scan…", `API v${getApiVersion()}`, 0);
  log(`Scan started (API v${getApiVersion()}) across ${TARGETS.length} types.`);

  // switch to determinate once first response completes
  setProgressIndeterminate(false);

  const total = TARGETS.length;
  let done = 0;

  for(const t of TARGETS){
    done += 1;
    const pct = ((done - 1) / total) * 100;
    setProgress("Scanning…", `${t.type} (${done}/${total})`, pct);

    const soql = `
      SELECT Id, ${t.nameField}, LastModifiedDate, LastModifiedBy.Name
      FROM ${t.sobject}
      ORDER BY LastModifiedDate DESC
      LIMIT 500
    `.trim();

    const res = await sfToolingQuery(soql);
    if(res.ok){
      const mapped = res.rows.map(r => normalize(t, r));
      rows.push(...mapped);
      log(`${t.type}: ${mapped.length} rows`);
    } else {
      log(`${t.type}: skipped (${res.err || "error"})`);
    }

    setProgress("Scanning…", `${t.type} (${done}/${total})`, (done / total) * 100);
  }

  // Sort by last modified desc
  rows.sort((a,b)=> String(b.mod).localeCompare(String(a.mod)));

  render();

  setProgress("Complete", `${rows.length} total rows`, 100);
  setButtonsEnabled(true);
  $("csvBtn").disabled = rows.length === 0;
  $("jsonBtn").disabled = rows.length === 0;

  log(`Scan complete. Total rows: ${rows.length}`);
}

/* ---- Download helpers ---- */

function download(name, text, mime){
  const blob = new Blob([text], { type: mime || "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function toCsvValue(v){
  const s = String(v ?? "");
  return `"${s.replace(/"/g,'""')}"`;
}

function downloadCsv(){
  const header = ["Type","Name","LastModified","User","Id"];
  const lines = [header.map(toCsvValue).join(",")];
  for(const r of rows){
    lines.push([r.type,r.name,r.mod,r.user,r.id].map(toCsvValue).join(","));
  }
  download("metadata_inventory.csv", lines.join("\n"), "text/csv");
}

function downloadJson(){
  const payload = {
    generatedAt: new Date().toISOString(),
    apiVersion: getApiVersion(),
    rowCount: rows.length,
    rows
  };
  download("metadata_inventory.json", JSON.stringify(payload, null, 2), "application/json");
}

/* ---- Wiring ---- */

$("scanBtn").onclick = scan;
$("csvBtn").onclick = downloadCsv;
$("jsonBtn").onclick = downloadJson;

(function init(){
  $("apiVersionSelect").value = getApiVersion();
  $("apiVersionSelect").onchange = (e) => {
    localStorage.setItem(API_VERSION_KEY, e.target.value);
    log(`API version set to v${e.target.value}`);
  };

  setProgressVisible(false);
  setButtonsEnabled(true);
})();
