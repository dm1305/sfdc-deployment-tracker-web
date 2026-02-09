// app.js (INSERT THIS FULL FILE)
// v2026-02-09.4
// Notes:
// - Removes the Deployments date range filter completely (no From/To fields referenced)
// - Ensures Refresh/Clear/Export/Alerts work
// - Does not depend on page-specific auth wiring; Auth is handled in auth.js
// - Keeps deployments table + trend chart working

let trendChart = null;
let pollTimer = null;
let inFlight = false;

let lastDeployments = [];
let lastTestRuns = [];
let deployToTest = new Map();

function $(id) { return document.getElementById(id); }

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

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

  // Disable main actions while in-flight
  ["refreshBtn", "exportCsvBtn", "enableAlertsBtn"].forEach((id) => {
    const b = $(id);
    if (b) b.disabled = !!on;
  });
}

/* -------------------- Time formatting -------------------- */

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

/* -------------------- Status + filters -------------------- */

function statusClass(status) {
  const s = String(status || "").toLowerCase();
  if (["succeeded", "success", "completed"].some((k) => s.includes(k))) return "good";
  if (["failed", "error"].some((k) => s.includes(k))) return "bad";
  if (["inprogress", "in progress", "queued", "pending", "validat", "running", "processing"].some((k) => s.includes(k)))
    return "warn";
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

/* -------------------- Correlation badge (optional) -------------------- */

function correlationBadge(c) {
  if (!c) return `<span class="badge muted">Unknown</span>`;
  const conf = c.confidence || "Low";
  const out = c.outcome || "Unknown";
  const cls =
    /fail/i.test(out) ? "bad" :
    /pass|succeed/i.test(out) ? "good" :
    "warn";
  return `<span class="badge"><span class="status ${cls}">${out}</span><span class="muted">(${conf})</span></span>`;
}

/* -------------------- Render: Deployments table -------------------- */

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

  // Row click loads details (except buttons)
  tbody.querySelectorAll("tr[data-id]").forEach((tr) => {
    tr.addEventListener("click", async (e) => {
      if (e.target && e.target.tagName === "BUTTON") return;
      const id = tr.getAttribute("data-id");
      if (id) await loadDeployDetails(id);
    });
  });

  // Button actions
  tbody.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const action = btn.getAttribute("data-action");
      const id = btn.getAttribute("data-id");
      const text = btn.getAttribute("data-text");

      if (action === "details" && id) {
        await loadDeployDetails(id);
        return;
      }

      if (action === "copy") {
        try {
          await navigator.clipboard.writeText(text || "");
          log("Copied to clipboard.");
        } catch {
          log("Clipboard copy failed (browser permissions).");
        }
      }
    });
  });
}

/* -------------------- Trend chart -------------------- */

function updateTrendChart(records) {
  const canvas = $("trendChart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  const chartData = [...records]
    .reverse()
    .filter(r => r.CompletedDate)
    .map(r => ({
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
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { display: false } }
    }
  });
}

/* -------------------- Salesforce fetches -------------------- */

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
    setSelected(`DeployRequest query failed (HTTP ${status}). Check Errors drawer.`);
    return [];
  }

  const recs = json?.records || [];
  lastDeployments = recs;

  const filtered = recs.filter(passesDeployFilter).filter(passesDeploySearch);
  renderDeploymentsTable(filtered);
  updateTrendChart(filtered);

  // Active count pill
  const activeStatuses = new Set(["InProgress", "Queued", "Pending", "Processing", "Running", "Validating"]);
  const active = filtered.filter(r => activeStatuses.has(r.Status)).length;
  setText("activeCountPill", `Active: ${active}`);

  return filtered;
}

async function loadDeployDetails(id) {
  setSelected({ kind: "DeployRequest", Id: id, loading: true });

  const panel = $("deployDetailsPanel");
  if (panel) panel.textContent = "Loading deploy details…";

  // NOTE: Component-level detail requires Metadata API deployStatus (SOAP) or proxy.
  // This is a stable detail view from Tooling DeployRequest.
  const soql = `
    SELECT Id, Status, Type, CheckOnly,
           CreatedDate, StartDate, CompletedDate,
           ErrorStatusCode, ErrorMessage
    FROM DeployRequest
    WHERE Id='${id}'
    LIMIT 1
  `.trim();

  setBusy(true, "Details…");
  const { ok, status, json } = await Auth.sfFetch(`/query?q=${encodeURIComponent(soql)}`, { tooling: true });
  setBusy(false);

  if (!ok) {
    if (panel) panel.textContent = "Failed to load deploy details. Check Errors drawer.";
    setSelected(`Deploy detail query failed (HTTP ${status}).`);
    return;
  }

  const rec = json?.records?.[0];
  if (!rec) {
    if (panel) panel.textContent = "No details returned.";
    return;
  }

  setSelected(rec);
  if (panel) panel.textContent = "Loaded (Tooling DeployRequest). Component totals require Metadata deployStatus.";
}

/* -------------------- CSV export -------------------- */

function exportCsv() {
  const rows = [["Id", "Status", "Type", "CheckOnly", "CreatedDate", "StartDate", "CompletedDate", "ErrorStatusCode", "ErrorMessage"]];
  (lastDeployments || []).forEach(r => rows.push([
    r.Id, r.Status, r.Type, r.CheckOnly, r.CreatedDate, r.StartDate, r.CompletedDate, r.ErrorStatusCode, r.ErrorMessage
  ]));

  const csv = rows.map(r => r.map(v => {
    const s = (v == null) ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",")).join("\n");

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

/* -------------------- Notifications -------------------- */

function requestNotifyPermission() {
  if (!("Notification" in window)) {
    alert("Notifications not supported by this browser.");
    return;
  }
  Notification.requestPermission().then((p) => {
    if (p === "granted") log("Notifications enabled.");
    else log("Notifications permission not granted.");
  });
}

/* -------------------- Polling -------------------- */

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);

  const seconds = Number($("pollInterval")?.value || 0);
  if (!seconds) {
    log("Auto-refresh disabled.");
    return;
  }

  pollTimer = setInterval(async () => {
    if (inFlight) return;
    await refreshActiveTab(true);
  }, seconds * 1000);

  log(`Auto-refresh enabled: every ${seconds}s`);
}

async function refreshActiveTab(isPoll = false) {
  await fetchDeployments();
  setText("lastRefreshed", `Last refreshed: ${new Date().toISOString().replace("T", " ").replace("Z", "Z")}`);
}

/* -------------------- Page init + wiring -------------------- */

document.addEventListener("DOMContentLoaded", async () => {
  // Handle OAuth callback (if we just returned from login)
  await Auth.handleRedirectIfPresent();

  // Wire buttons
  $("refreshBtn")?.addEventListener("click", () => refreshActiveTab(false));
  $("clearStorageBtn")?.addEventListener("click", () => {
    localStorage.clear();
    sessionStorage.clear();
    location.reload();
  });

  $("exportCsvBtn")?.addEventListener("click", exportCsv);
  $("enableAlertsBtn")?.addEventListener("click", requestNotifyPermission);

  // Wire deployment controls
  $("pollInterval")?.addEventListener("change", startPolling);
  $("deployFilter")?.addEventListener("change", () => fetchDeployments());
  $("deployLimit")?.addEventListener("change", () => fetchDeployments());
  $("deploySearch")?.addEventListener("input", () => {
    const filtered = (lastDeployments || []).filter(passesDeployFilter).filter(passesDeploySearch);
    renderDeploymentsTable(filtered);
    updateTrendChart(filtered);
  });

  // Initial load if logged in
  const token = Auth.loadToken();
  if (token?.access_token) {
    await Auth.loadOrgContext(true);
    await fetchDeployments();
    startPolling();
  } else {
    Auth.showBanner("Not logged in. Click Login.");
  }
});
