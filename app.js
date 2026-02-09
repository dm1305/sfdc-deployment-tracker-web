// app.js (FULL FILE - UPDATED)
// v2026-02-09.9
// Fixes:
// - Prevents redeclaration errors if the script is loaded twice (guard + IIFE)
// - Ensures UI shows a clear message when not logged in.

(() => {
  "use strict";
  if (window.__SFDC_DEPLOY_APP_LOADED__) return;
  window.__SFDC_DEPLOY_APP_LOADED__ = true;

  let trendChart = null;
  let heatmapChart = null;
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

    ["refreshBtn", "exportCsvBtn"].forEach((id) => {
      const b = $(id);
      if (b) b.disabled = !!on;
    });
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

  function tokenOrBanner() {
    const tok = window.Auth?.loadToken?.();
    if (!tok) {
      window.Auth?.setBanner?.("Not logged in. Click Login.", "error");
      return null;
    }
    return tok;
  }

  async function queryDeployments() {
    const tok = tokenOrBanner();
    if (!tok) return [];

    const limit = parseInt($("deployLimit")?.value || "20", 10);
    const soql = `
      SELECT Id, Status, Type, CheckOnly, CreatedDate, StartDate, CompletedDate, CreatedBy.Name
      FROM DeployRequest
      ORDER BY CreatedDate DESC
      LIMIT ${limit}
    `.trim().replace(/\s+/g, " ");

    const res = await window.Auth.sfFetch(`/services/data/${window.Auth.apiVersion()}/tooling/query/?q=${encodeURIComponent(soql)}`);
    return res.records || [];
  }

  function renderDeployments(rows) {
    const tbody = $("deploymentsTbody");
    if (!tbody) return;
    tbody.innerHTML = "";

    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="14" class="muted small">No rows.</td></tr>`;
      return;
    }

    for (const r of rows) {
      const tr = document.createElement("tr");
      const created = r.CreatedDate ? new Date(r.CreatedDate) : null;
      const started = r.StartDate ? new Date(r.StartDate) : null;
      const completed = r.CompletedDate ? new Date(r.CompletedDate) : null;

      const queueMs = (created && started) ? (started - created) : null;
      const runMs = (started && completed) ? (completed - started) : null;
      const totalMs = (created && completed) ? (completed - created) : null;

      tr.innerHTML = `
        <td class="${statusClass(r.Status)}">${r.Status || "—"}</td>
        <td>${r.CreatedBy?.Name || "—"}</td>
        <td>${(r.Type || "—")}${r.CheckOnly ? " (checkOnly)" : ""}</td>
        <td>${r.CreatedDate || "—"}</td>
        <td>${r.StartDate || "—"}</td>
        <td>${r.CompletedDate || "—"}</td>
        <td>${fmtDuration(queueMs)}</td>
        <td>${fmtDuration(runMs)}</td>
        <td>${fmtDuration(totalMs)}</td>
        <td>—</td>
        <td>—</td>
        <td>—</td>
        <td class="mono">${r.Id}</td>
        <td><button class="btnSmall" data-id="${r.Id}">Details</button></td>
      `.trim();

      tr.addEventListener("click", () => {
        setSelected(r);
      });

      tbody.appendChild(tr);
    }
  }

  async function refreshDeployments() {
    if (inFlight) return;
    setBusy(true, "Refreshing…");
    try {
      log("Refreshing deployments…");
      const rows = await queryDeployments();
      lastDeployments = rows;
      renderDeployments(rows);
      setText("lastRefreshed", "Last refreshed: " + new Date().toLocaleString());
      window.Auth?.setBanner?.("", "info");
    } catch (e) {
      window.Auth?.pushError?.({ where: "refreshDeployments", message: e.message, stack: e.stack });
      window.Auth?.setBanner?.("Refresh failed: " + (e.message || e), "error");
      log("Refresh failed: " + (e.message || e));
    } finally {
      setBusy(false);
    }
  }

  function startPolling() {
    const sel = $("pollInterval");
    if (!sel) return;
    const secs = parseInt(sel.value || "0", 10);
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (secs > 0) {
      pollTimer = setInterval(() => refreshDeployments(), secs * 1000);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("refreshBtn")?.addEventListener("click", () => refreshDeployments());
    $("pollInterval")?.addEventListener("change", () => startPolling());
    startPolling();
    // initial render
    refreshDeployments();
  });
})();
