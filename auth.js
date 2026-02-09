// app.js (FULL FILE - UPDATED)
// Changes:
// - Removes any From/To date filter usage (since UI removed)
// - Ensures Refresh button works even if token absent (shows banner)
// - Uses Auth wiring; keeps existing features.

let trendChart = null;
let heatmapChart = null;
let pollTimer = null;
let inFlight = false;

let lastDeployments = [];
let lastTestRuns = [];
let deployToTest = new Map();

function $(id) { return document.getElementById(id); }

function setText(id, text) { const el = $(id); if (el) el.textContent = text; }

function log(msg) {
  const el = $("logPre");
  if (!el) return;
  const stamp = new Date().toISOString();
  el.textContent = `[${stamp}] ${msg}\n` + el.textContent;
}

function setSelected(objOrText) {
  const el = $("selectedPre");
  if (!el) return;
  el.textContent = typeof objOrText === "string" ? objOrText : JSON.stringify(objOrText, null, 2);
}

function setBusy(on, label = null) {
  inFlight = on;
  const pill = $("busyPill");
  if (pill) pill.textContent = on ? (label || "Working…") : "Idle";

  ["refreshBtn", "exportCsvBtn"].forEach((id) => {
    const b = $(id);
    if (b) b.disabled = !!on;
  });
}

function parseDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}

function fmtTime(d) {
  if (!d) return "—";
  return d.toISOString().replace("T", " ").replace("Z", "Z");
}

function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}h ${m}m ${s}s`;
}

function statusClass(status) {
  const s = String(status || "").toLowerCase();
  if (["succeeded", "success", "completed"].some((k) => s.includes(k))) return "good";
  if (["failed", "error"].some((k) => s.includes(k))) return "bad";
  if (["inprogress", "queued", "pending", "validat", "running", "processing"].some((k) => s.includes(k))) return "warn";
  return "";
}

function passesDeployFilter(r) {
  const filter = $("deployFilter")?.value || "all";
  const status = String(r.Status || "");
  const checkOnly = !!r.CheckOnly;

  if (filter === "active") {
    const active = ["InProgress", "Pending", "Queued", "Processing", "Running", "Validating"];
    return active.includes(status);
  }
  if (filter === "failed") return status.toLowerCase().includes("fail") || status.toLowerCase().includes("error");
  if (filter === "checkonly") return checkOnly;
  if (filter === "real") return !checkOnly;
  return true;
}

function passesDeploySearch(r) {
  const q = ($("deploySearch")?.value || "").trim().toLowerCase();
  if (!q) return true;
  const blob = [r.Status, r.Type, r.CreatedBy?.Name, r.ErrorStatusCode, r.ErrorMessage, r.Id].filter(Boolean).join(" ").toLowerCase();
  return blob.includes(q);
}

function correlationBadge(c) {
  if (!c) return `<span class="badge muted">Unknown</span>`;
  const conf = c.confidence || "Low";
  const out = c.outcome || "Unknown";
  const cls = /fail/i.test(out) ? "bad" : /pass|succeed/i.test(out) ? "good" : "warn";
  return `<span class="badge"><span class="status ${cls}">${out}</span><span class="muted">(${conf})</span></span>`;
}

function renderDeploymentsTable(rows) {
  const tbody = $("deploymentsTbody");
  if (!tbody) return;

  if (!rows.length) {
    tbody.innerHTML = `<tr><td class="muted small" colspan="14">No deployments match the current filter/search.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map((r) => {
    const now = new Date();
    const created = parseDate(r.CreatedDate);
    const started = parseDate(r.StartDate) || created;
    const completed = parseDate(r.CompletedDate);

    const queueMs = created && started ? started - created : null;
    const runMs = started ? (completed ? completed - started : now - started) : null;
    const totalMs = created ? (completed ? completed - created : now - created) : null;

    const st = r.Status || "—";
    const stClass = statusClass(st);

    const type = r.Type || "—";
    const user = r.CreatedBy?.Name || "—";

    const corr = deployToTest.get(r.Id) || null;
    const testFails = corr?.failures ?? null;
    const testMs = corr?.durationMs ?? null;

    return `
      <tr data-id="${r.Id}">
        <td class="status ${stClass}">${st}</td>
        <td>${user}</td>
        <td>${type}${r.CheckOnly ? ' <span class="muted">(checkOnly)</span>' : ""}</td>
        <td class="mono">${fmtTime(created)}</td>
        <td class="mono">${fmtTime(parseDate(r.StartDate))}</td>
        <td class="mono">${fmtTime(completed)}</td>
        <td class="mono">${fmtDuration(queueMs)}</td>
        <td class="mono">${fmtDuration(runMs)}</td>
        <td class="mono">${fmtDuration(totalMs)}</td>
        <td>${correlationBadge(corr)}</td>
        <td class="mono">${testFails ?? "—"}</td>
        <td class="mono">${testMs != null ? fmtDuration(testMs) : "—"}</td>
        <td class="mono">${r.Id}</td>
        <td>
          <div class="rowActions">
            <button class="btnSmall" data-action="details" data-id="${r.Id}">Details</button>
            <button class="btnSmall" data-action="copy" data-text="${r.Id}">Copy id</button>
          </div>
        </td>
      </tr>
    `.trim();
  }).join("\n");

  // Row click loads details
  tbody.querySelectorAll("tr[data-id]").forEach((tr) => {
    tr.addEventListener("click", async (e) => {
      const isButton = (e.target && e.target.tagName === "BUTTON");
      if (isButton) return;
      const id = tr.getAttribute("data-id");
      if (id) await loadDeployDetails(id);
    });
  });

  // Buttons
  tbody.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const action = btn.getAttribute("data-action");
      const id = btn.getAttribute("data-id");
      const text = btn.getAttribute("data-text");

      if (action === "details" && id) return loadDeployDetails(id);

      if (action === "copy") {
        try { await navigator.clipboard.writeText(text || ""); log("Copied to clipboard."); }
        catch { log("Clipboard copy failed."); }
      }
    });
  });
}

function updateTrendChart(records) {
  const ctx = $("trendChart")?.getContext("2d");
  if (!ctx) return;

  const chartData = [...records].reverse().filter(r => r.CompletedDate).map(r => ({
    t: new Date(r.CreatedDate).toLocaleTimeString(),
    y: (new Date(r.CompletedDate) - new Date(r.CreatedDate)) / 1000
  }));

  if (trendChart) trendChart.destroy();
  trendChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: chartData.map(d => d.t),
      datasets: [{ label: "Duration (sec)", data: chartData.map(d => d.y), fill: false }]
    },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false } } }
  });
}

async function fetchDeployments() {
  const limit = Number($("deployLimit")?.value || 20);

  const soql = `
    SELECT Id, Status, Type, CheckOnly,
           CreatedDate, StartDate, CompletedDate,
           CreatedBy.Name, CreatedById,
           ErrorStatusCode, ErrorMessage
    FROM DeployRequest
    ORDER BY CreatedDate DESC
    LIMIT ${limit}
  `.trim();

  setBusy(true, "Deploys…");
  const { ok, status, json } = await Auth.sfFetch(`/query?q=${encodeURIComponent(soql)}`, { tooling: true });
  setBusy(false);

  if (!ok) {
    setSelected(`DeployRequest query failed (HTTP ${status}). See Errors drawer.`);
    return [];
  }

  const recs = json?.records || [];
  lastDeployments = recs;

  const filtered = recs.filter(passesDeployFilter).filter(passesDeploySearch);
  renderDeploymentsTable(filtered);
  updateTrendChart(filtered);

  // Active count
  const active = filtered.filter(r => ["InProgress", "Queued", "Pending", "Processing", "Running", "Validating"].includes(r.Status)).length;
  setText("activeCountPill", `Active: ${active}`);

  return filtered;
}

/* Minimal deploy details placeholder; keep your richer logic if you already implemented it. */
async function loadDeployDetails(id) {
  setSelected({ kind: "DeployRequest", Id: id, loading: true });
  const panel = $("deployDetailsPanel");
  if (panel) panel.textContent = "Loading deploy details…";

  // NOTE: Metadata deploy details aren’t exposed directly via Tooling.
  // If you implemented proxy/SOAP metadata calls already, keep that logic here.
  // For now: show record details only.
  const soql = `SELECT Id, Status, Type, CheckOnly, CreatedDate, StartDate, CompletedDate, ErrorMessage, ErrorStatusCode FROM DeployRequest WHERE Id='${id}'`;
  setBusy(true, "Details…");
  const { ok, status, json } = await Auth.sfFetch(`/query?q=${encodeURIComponent(soql)}`, { tooling: true });
  setBusy(false);

  if (!ok) {
    if (panel) panel.textContent = "Failed to load deploy details. See Errors drawer.";
    return;
  }

  const rec = json?.records?.[0];
  if (!rec) {
    if (panel) panel.textContent = "No details returned.";
    return;
  }

  setSelected(rec);
  if (panel) panel.textContent = "Loaded. (Component-level details require Metadata API deployStatus/SOAP or a proxy.)";
}

function exportCsv() {
  const rows = [["Id", "Status", "Type", "CheckOnly", "CreatedDate", "StartDate", "CompletedDate"]];
  lastDeployments.forEach(r => rows.push([r.Id, r.Status, r.Type, r.CheckOnly, r.CreatedDate, r.StartDate, r.CompletedDate]));
  const csv = rows.map(r => r.map(v => (v == null ? "" : String(v).replace(/"/g, '""'))).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `deployments_${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function requestNotifyPermission() {
  if (!("Notification" in window)) return alert("Notifications not supported by this browser.");
  Notification.requestPermission().then(p => {
    if (p === "granted") log("Notifications enabled.");
    else log("Notifications permission not granted.");
  });
}

function notifyUser(title, body) {
  if (Notification.permission === "granted") new Notification(title, { body });
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  const seconds = Number($("pollInterval")?.value || 0);
  if (!seconds) return;

  pollTimer = setInterval(async () => {
    if (inFlight) return;
    await refreshActiveTab(true);
  }, seconds * 1000);

  log(`Auto-refresh enabled: every ${seconds}s`);
}

async function refreshActiveTab(isPoll = false) {
  // Only deployments wired here; extend for tests/packages if needed
  await fetchDeployments();
  setText("lastRefreshed", `Last refreshed: ${new Date().toISOString().replace("T", " ").replace("Z", "Z")}`);
}

/* Wiring */
document.addEventListener("DOMContentLoaded", async () => {
  // Complete OAuth redirect if present
  await Auth.handleRedirectIfPresent();

  // Buttons
  $("refreshBtn")?.addEventListener("click", () => refreshActiveTab(false));
  $("clearStorageBtn")?.addEventListener("click", () => {
    localStorage.clear();
    sessionStorage.clear();
    location.reload();
  });
  $("exportCsvBtn")?.addEventListener("click", exportCsv);
  $("enableAlertsBtn")?.addEventListener("click", requestNotifyPermission);

  $("pollInterval")?.addEventListener("change", startPolling);
  $("deployFilter")?.addEventListener("change", () => fetchDeployments());
  $("deployLimit")?.addEventListener("change", () => fetchDeployments());
  $("deploySearch")?.addEventListener("input", () => {
    const filtered = (lastDeployments || []).filter(passesDeployFilter).filter(passesDeploySearch);
    renderDeploymentsTable(filtered);
    updateTrendChart(filtered);
  });

  // First load if logged in
  const token = Auth.loadToken();
  if (token?.access_token) {
    await Auth.loadOrgContext(true);
    await fetchDeployments();
    startPolling();
  } else {
    Auth.showBanner("Not logged in. Click Login.");
  }
});
