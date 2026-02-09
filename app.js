const BUILD = Auth.BUILD;

let pollTimer = null;
let realtimeTimer = null;
let inFlight = false;
let lastPollSkipped = false;

let lastDeployments = [];
let lastTestRuns = [];
let deployToTest = new Map();

let trendChart = null;
let heatmapChart = null;
let activeJobs = new Set();

function setLastRefreshed(){
  Auth.setText("lastRefreshed", `Last refreshed: ${new Date().toISOString().replace("T"," ").replace("Z","Z")}`);
}

function setLastRequest(text){
  Auth.setText("lastRequest", `Last request: ${text}`);
}

function setBusy(isBusy, label=null){
  inFlight = isBusy;
  const pill = document.getElementById("busyPill");
  if (pill) pill.textContent = isBusy ? (label || "Working…") : "Idle";
  ["refreshBtn","refreshPackagesBtn","refreshTestsBtn"].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.disabled = !!isBusy;
  });
}

/* -------------------- Browser notifications -------------------- */

function requestNotifyPermission(){
  if (!("Notification" in window)){
    Auth.log("Notifications not supported by this browser.");
    return;
  }
  Notification.requestPermission().then((p) => {
    if (p === "granted"){
      Auth.log("Notifications enabled.");
      notifyUser("Alerts enabled", "Deployment completion alerts are on.");
    } else {
      Auth.log("Notifications permission not granted.");
    }
  }).catch((e) => Auth.log(`Notifications error: ${e?.message || e}`));
}

function notifyUser(title, body){
  try{
    if (Notification.permission === "granted"){
      new Notification(title, { body, icon: "https://www.salesforce.com/favicon.ico" });
    }
  } catch (e) {
    // ignore
  }
}

function stopPolling(){
  if (pollTimer){
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling(){
  stopPolling();
  const seconds = Number(document.getElementById("pollInterval")?.value || 0);
  if (!seconds){
    Auth.log("Auto-refresh disabled.");
    return;
  }
  pollTimer = setInterval(async () => {
    if (inFlight){
      lastPollSkipped = true;
      return;
    }
    lastPollSkipped = false;
    await refreshActiveTab(true);
  }, seconds * 1000);
  Auth.log(`Auto-refresh enabled: every ${seconds}s`);
}

/* -------------------- Real-time deployment monitor -------------------- */

function stopRealtimeMonitor(){
  if (realtimeTimer){
    clearInterval(realtimeTimer);
    realtimeTimer = null;
  }
  activeJobs = new Set();
}

function startRealtimeMonitor(){
  stopRealtimeMonitor();
  // keep this separate from the main polling interval: completions are useful even when the UI isn't actively refreshing
  realtimeTimer = setInterval(async () => {
    if (inFlight) return;
    await pollActiveDeployments();
  }, 5000);
}

async function pollActiveDeployments(){
  const soql = `SELECT Id, Status, CreatedDate FROM DeployRequest WHERE Status IN ('InProgress','Queued','Pending','Processing','Validating') ORDER BY CreatedDate DESC LIMIT 100`;
  const resp = await Auth.sfFetch(`/query?q=${encodeURIComponent(soql)}`, { tooling: true });
  if (!resp.ok) return;
  const current = new Set((resp.json?.records || []).map((r) => r.Id));

  activeJobs.forEach((id) => {
    if (!current.has(id)){
      notifyUser("Deployment complete", `Job ${id} finished.`);
      Auth.log(`Realtime: deploy completed: ${id}`);
    }
  });
  activeJobs = current;
}

/* -------------------- Tab switching -------------------- */
function show(el, on){ if (el) el.style.display = on ? "" : "none"; }

function setPanelVisible(id, on){
  const el = document.getElementById(id);
  if (el) el.style.display = on ? "" : "none";
}

function setResultsView(view){
  show(document.getElementById("deploymentsTableWrap"), view==="deployments");
  show(document.getElementById("testsTableWrap"), view==="tests");
  show(document.getElementById("packagesTableWrap"), view==="packages");
}

function showTab(tab){
  const tabs = ["tabDeployments","tabApexTests","tabPackages"];
  tabs.forEach(id => document.getElementById(id)?.classList.remove("active"));

  if (tab==="deployments") document.getElementById("tabDeployments")?.classList.add("active");
  if (tab==="tests") document.getElementById("tabApexTests")?.classList.add("active");
  if (tab==="packages") document.getElementById("tabPackages")?.classList.add("active");

  setPanelVisible("deploymentsControls", tab==="deployments");
  setPanelVisible("apexTestsControls", tab==="tests");
  setPanelVisible("packagesControls", tab==="packages");

  setResultsView(tab);

  const title = document.getElementById("resultsTitle");
  if (title){
    title.textContent =
      tab==="deployments" ? "Results (Deployments)" :
      tab==="tests" ? "Results (Apex tests)" :
      "Results (Packages)";
  }
}

/* -------------------- Formatting -------------------- */
function parseDate(s){
  if (!s) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}
function fmtTime(d){
  if (!d) return "—";
  return d.toISOString().replace("T"," ").replace("Z","Z");
}
function fmtDuration(ms){
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const sec = Math.floor(ms/1000);
  const h = Math.floor(sec/3600);
  const m = Math.floor((sec%3600)/60);
  const s = sec%60;
  return `${h}h ${m}m ${s}s`;
}
function statusClass(status){
  const s = String(status||"").toLowerCase();
  if (["succeeded","success","completed"].some(k => s.includes(k))) return "good";
  if (["failed","error"].some(k => s.includes(k))) return "bad";
  if (["inprogress","queued","pending","validat","running","processing"].some(k => s.includes(k))) return "warn";
  return "";
}
function correlationBadge(c){
  if (!c) return `<span class="badge muted">Unknown</span>`;
  const out = c.outcome || "Unknown";
  const cls = /fail/i.test(out) ? "bad" : /pass|succeed/i.test(out) ? "good" : "warn";
  return `<span class="badge"><span class="status ${cls}">${out}</span><span class="muted">(${c.confidence||"Low"})</span></span>`;
}

/* -------------------- Filters -------------------- */
function passesDeployFilter(r){
  const filter = document.getElementById("deployFilter")?.value || "all";
  const status = String(r.Status||"");
  const checkOnly = !!r.CheckOnly;

  if (filter==="active"){
    const active = ["InProgress","Pending","Queued","Processing","Running","Validating"];
    return active.includes(status);
  }
  if (filter==="failed") return status.toLowerCase().includes("fail") || status.toLowerCase().includes("error");
  if (filter==="checkonly") return checkOnly;
  if (filter==="real") return !checkOnly;
  return true;
}

function passesDeploySearch(r){
  const q = (document.getElementById("deploySearch")?.value || "").trim().toLowerCase();
  if (!q) return true;
  const blob = [r.Status,r.Type,r.CreatedBy?.Name,r.ErrorStatusCode,r.ErrorMessage,r.Id].filter(Boolean).join(" ").toLowerCase();
  return blob.includes(q);
}

function passesTestFilter(r){
  const f = document.getElementById("testFilter")?.value || "all";
  const outcome = String(r.Outcome || r.Status || "").toLowerCase();
  if (f==="failed") return /(fail|error)/i.test(outcome) || Number(r.Failures||0)>0;
  if (f==="passed") return /(pass|success)/i.test(outcome) && Number(r.Failures||0)===0;
  return true;
}

function passesTestSearch(r){
  const q = (document.getElementById("testSearch")?.value || "").trim().toLowerCase();
  if (!q) return true;
  const blob = [r.Id,r.Outcome,r.Status,r.CreatedBy?.Name].filter(Boolean).join(" ").toLowerCase();
  return blob.includes(q);
}

/* -------------------- Render: Deployments -------------------- */
function renderDeploymentsTable(rows){
  const tbody = document.getElementById("deploymentsTbody");
  if (!tbody) return;

  if (!rows.length){
    tbody.innerHTML = `<tr><td class="muted small" colspan="14">No deployments match the current filter/search.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(r => {
    const now = new Date();
    const created = parseDate(r.CreatedDate);
    const started = parseDate(r.StartDate) || created;
    const completed = parseDate(r.CompletedDate);

    const queueMs = created && started ? started - created : null;
    const runMs = started ? (completed ? completed - started : now - started) : null;
    const totalMs = created ? (completed ? completed - created : now - created) : null;

    const st = r.Status || "—";
    const stClass = statusClass(st);
    const corr = deployToTest.get(r.Id) || null;

    return `
      <tr class="rowClickable" data-row="deploy" data-id="${r.Id}" title="Click to load deploy details">
        <td class="status ${stClass}">${st}</td>
        <td>${r.CreatedBy?.Name || "—"}</td>
        <td>${r.Type || "—"}${r.CheckOnly ? ' <span class="muted">(checkOnly)</span>' : ""}</td>
        <td class="mono">${fmtTime(created)}</td>
        <td class="mono">${fmtTime(parseDate(r.StartDate))}</td>
        <td class="mono">${fmtTime(completed)}</td>
        <td class="mono">${fmtDuration(queueMs)}</td>
        <td class="mono">${fmtDuration(runMs)}</td>
        <td class="mono">${fmtDuration(totalMs)}</td>
        <td>${correlationBadge(corr)}</td>
        <td class="mono">${corr?.failures ?? "—"}</td>
        <td class="mono">${fmtDuration(corr?.durationMs ?? null)}</td>
        <td class="mono">${r.Id}</td>
        <td>
          <div class="rowActions">
            <button class="btnSmall" data-action="selectDeploy" data-id="${r.Id}">Details</button>
            <button class="btnSmall" data-action="copy" data-text="${r.Id}">Copy id</button>
            ${corr?.runId ? `<button class="btnSmall" data-action="selectTestRun" data-id="${corr.runId}">Test run</button>` : ""}
          </div>
        </td>
      </tr>
    `.trim();
  }).join("\n");

  tbody.querySelectorAll("button[data-action]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const action = btn.getAttribute("data-action");
      const id = btn.getAttribute("data-id");
      const text = btn.getAttribute("data-text");

      if (action==="copy"){
        try { await navigator.clipboard.writeText(text || ""); Auth.log("Copied to clipboard."); }
        catch { Auth.log("Clipboard copy failed."); }
        return;
      }

      if (action==="selectDeploy"){
        const rec = rows.find(x => x.Id === id);
        if (!rec) return;
        Auth.setSelected({
          kind: "DeployRequest",
          Id: rec.Id,
          Status: rec.Status,
          Type: rec.Type,
          CheckOnly: rec.CheckOnly,
          CreatedBy: rec.CreatedBy?.Name,
          CreatedDate: rec.CreatedDate,
          StartDate: rec.StartDate,
          CompletedDate: rec.CompletedDate,
          ErrorStatusCode: rec.ErrorStatusCode,
          ErrorMessage: rec.ErrorMessage,
          CorrelatedTest: deployToTest.get(rec.Id) || null
        });
        await loadDeploymentDetails(rec.Id);
        return;
      }

      if (action==="selectTestRun"){
        showTab("tests");
        await refreshTests(false);
        await selectTestRunAndFailures(id);
      }
    });
  });

  tbody.querySelectorAll("tr.rowClickable[data-row='deploy']").forEach((tr) => {
    tr.addEventListener("click", async (e) => {
      if (e.target?.closest && e.target.closest("button")) return;
      const id = tr.getAttribute("data-id");
      if (!id) return;
      await loadDeploymentDetails(id);
    });
  });
}

/* -------------------- Data: Deployments -------------------- */
async function fetchDeployments(){
  const limit = Number(document.getElementById("deployLimit")?.value || 20);
  const start = document.getElementById("deployStart")?.value || "";
  const end = document.getElementById("deployEnd")?.value || "";

  const filters = [];
  if (start){
    const iso = new Date(start + "T00:00:00Z").toISOString().replace(".000Z","Z");
    filters.push(`CreatedDate >= ${iso}`);
  }
  if (end){
    const iso = new Date(end + "T23:59:59Z").toISOString().replace(".000Z","Z");
    filters.push(`CreatedDate <= ${iso}`);
  }
  const where = filters.length ? (" WHERE " + filters.join(" AND ")) : "";
  const soql = `
    SELECT Id, Status, Type, CheckOnly,
           CreatedDate, StartDate, CompletedDate,
           CreatedBy.Name, CreatedById,
           ErrorStatusCode, ErrorMessage
    FROM DeployRequest${where}
    ORDER BY CreatedDate DESC
    LIMIT ${limit}
  `.trim();

  setBusy(true, "Deploys…");
  setLastRequest(`tooling query DeployRequest (limit ${limit})`);
  const { ok, status, json } = await Auth.sfFetch(`/query?q=${encodeURIComponent(soql)}`, { tooling:true });
  setBusy(false);

  if (!ok){
    Auth.setSelected(`DeployRequest query failed (HTTP ${status}):\n${Auth.extractSfError(json)}`);
    return [];
  }

  const recs = json?.records || [];
  lastDeployments = recs;

  if (!lastTestRuns.length) await refreshTests(true);
  correlateDeploymentsToTests(recs, lastTestRuns);

  const filtered = recs.filter(passesDeployFilter).filter(passesDeploySearch);
  renderDeploymentsTable(filtered);
  updateTrendChart(filtered);
  return filtered;
}

/* -------------------- Tests -------------------- */
function testOutcomeClass(outcome){
  const s = String(outcome||"").toLowerCase();
  if (/(pass|success)/i.test(s)) return "good";
  if (/(fail|error)/i.test(s)) return "bad";
  return "warn";
}

function renderTestsTable(rows){
  const tbody = document.getElementById("testsTbody");
  if (!tbody) return;

  if (!rows.length){
    tbody.innerHTML = `<tr><td class="muted small" colspan="9">No test runs match the current filter/search.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(r => {
    const started = parseDate(r.StartTime);
    const ended = parseDate(r.EndTime);
    const dur = started ? ((ended ? ended - started : new Date() - started)) : null;
    const outcome = r.Outcome || r.Status || "—";
    const cls = testOutcomeClass(outcome);

    return `
      <tr>
        <td class="status ${cls}">${outcome}</td>
        <td>${r.CreatedBy?.Name || "—"}</td>
        <td class="mono">${fmtTime(started)}</td>
        <td class="mono">${fmtTime(ended)}</td>
        <td class="mono">${fmtDuration(dur)}</td>
        <td class="mono">${r.TestsRan ?? "—"}</td>
        <td class="mono">${r.Failures ?? "—"}</td>
        <td class="mono">${r.Id}</td>
        <td>
          <div class="rowActions">
            <button class="btnSmall" data-action="selectRun" data-id="${r.Id}">Details</button>
            <button class="btnSmall" data-action="loadFailures" data-id="${r.Id}">Failures</button>
            <button class="btnSmall" data-action="copy" data-text="${r.Id}">Copy</button>
          </div>
        </td>
      </tr>
    `.trim();
  }).join("\n");

  tbody.querySelectorAll("button[data-action]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const action = btn.getAttribute("data-action");
      const id = btn.getAttribute("data-id");
      const text = btn.getAttribute("data-text");

      if (action==="copy"){
        try { await navigator.clipboard.writeText(text || ""); Auth.log("Copied to clipboard."); }
        catch { Auth.log("Clipboard copy failed."); }
        return;
      }
      if (action==="selectRun"){
        const rec = rows.find(x => x.Id === id);
        if (!rec) return;
        Auth.setSelected({ kind:"ApexTestRun", ...rec });
        return;
      }
      if (action==="loadFailures"){
        await selectTestRunAndFailures(id);
      }
    });
  });
}

async function refreshTests(silent=false){
  const limit = Number(document.getElementById("testLimit")?.value || 20);
  const soql = `
    SELECT Id, Status, Outcome, StartTime, EndTime, TestsRan, Failures,
           CreatedBy.Name, CreatedById
    FROM ApexTestRun
    ORDER BY StartTime DESC
    LIMIT ${limit}
  `.trim();

  if (!silent){
    setBusy(true, "Tests…");
    setLastRequest(`tooling query ApexTestRun (limit ${limit})`);
  }
  const { ok, status, json } = await Auth.sfFetch(`/query?q=${encodeURIComponent(soql)}`, { tooling:true });
  if (!silent) setBusy(false);

  if (!ok){
    if (!silent) Auth.setSelected(`ApexTestRun query failed (HTTP ${status}):\n${Auth.extractSfError(json)}`);
    return [];
  }

  const recs = json?.records || [];
  lastTestRuns = recs;

  if (lastDeployments.length){
    correlateDeploymentsToTests(lastDeployments, lastTestRuns);
    if (document.getElementById("tabDeployments")?.classList.contains("active")){
      const filtered = lastDeployments.filter(passesDeployFilter).filter(passesDeploySearch);
      renderDeploymentsTable(filtered);
    }
  }

  const filtered = recs.filter(passesTestFilter).filter(passesTestSearch);
  if (!silent) renderTestsTable(filtered);
  return filtered;
}

async function selectTestRunAndFailures(runId){
  const run = lastTestRuns.find(x => x.Id === runId) || { Id: runId };
  Auth.setSelected({ kind:"ApexTestRun", ...run, loadingFailures:true });

  const soql = `
    SELECT Id, Outcome, ApexClass.Name, MethodName, Message, StackTrace, RunTime
    FROM ApexTestResult
    WHERE ApexTestRunId = '${runId}'
    AND (Outcome != 'Pass' OR Message != null)
    ORDER BY RunTime DESC
    LIMIT 50
  `.trim();

  setBusy(true, "Failures…");
  setLastRequest(`tooling query ApexTestResult (run ${runId})`);
  const { ok, status, json } = await Auth.sfFetch(`/query?q=${encodeURIComponent(soql)}`, { tooling:true });
  setBusy(false);

  if (!ok){
    Auth.setSelected(`ApexTestResult query failed (HTTP ${status}):\n${Auth.extractSfError(json)}`);
    return;
  }

  const failures = json?.records || [];
  Auth.setSelected({
    kind:"ApexTestRun",
    runId,
    summary: {
      outcome: run.Outcome || run.Status || "—",
      testsRan: run.TestsRan,
      failures: run.Failures,
      start: run.StartTime,
      end: run.EndTime
    },
    failureCount: failures.length,
    failures: failures.map(f => ({
      outcome: f.Outcome,
      class: f.ApexClass?.Name,
      method: f.MethodName,
      message: f.Message,
      runtimeMs: f.RunTime,
      stack: f.StackTrace
    }))
  });

  Auth.log(`Loaded ${failures.length} failing/non-pass test results for run ${runId}.`);
}

/* -------------------- Correlation -------------------- */
function correlateDeploymentsToTests(deployments, testRuns){
  deployToTest = new Map();

  const runs = (testRuns||[]).map(r => {
    const start = parseDate(r.StartTime);
    const end = parseDate(r.EndTime);
    const durMs = start ? ((end ? end - start : new Date() - start)) : null;
    const failures = Number(r.Failures || 0);
    const outcome = r.Outcome || r.Status || "Unknown";
    return {
      runId: r.Id,
      start, end,
      durationMs: durMs,
      failures,
      outcome,
      createdById: r.CreatedById,
      createdByName: r.CreatedBy?.Name
    };
  }).filter(x => x.start);

  runs.sort((a,b) => b.start - a.start);

  for (const d of deployments||[]){
    const created = parseDate(d.CreatedDate);
    const started = parseDate(d.StartDate) || created;
    const completed = parseDate(d.CompletedDate);
    if (!started) continue;

    const windowMs = 10 * 60 * 1000;
    const lo = new Date(started.getTime() - windowMs);
    const hi = new Date((completed ? completed.getTime() : started.getTime()) + windowMs);
    const userId = d.CreatedById;

    let best = null;
    for (const r of runs){
      if (r.start < lo) break;
      if (r.start > hi) continue;

      let score = 0;
      if (userId && r.createdById && userId === r.createdById) score += 3;

      const dt = Math.abs(r.start - started);
      if (dt < 2*60*1000) score += 3;
      else if (dt < 5*60*1000) score += 2;
      else score += 1;

      if (r.end) score += 1;

      if (!best || score > best.score) best = { ...r, score };
    }
    if (!best) continue;

    const confidence = best.score >= 6 ? "High" : best.score >= 4 ? "Medium" : "Low";
    deployToTest.set(d.Id, {
      runId: best.runId,
      outcome: best.failures > 0 ? "Fail" : (String(best.outcome).match(/pass|success/i) ? "Pass" : best.outcome),
      failures: best.failures,
      durationMs: best.durationMs,
      confidence
    });
  }

  Auth.log(`Correlation updated: ${deployToTest.size} deployments matched to test runs.`);
}

/* -------------------- Charts + exports -------------------- */

function updateTrendChart(records){
  const canvas = document.getElementById("trendChart");
  if (!canvas || typeof Chart === "undefined") return;

  const points = (records || [])
    .filter((r) => r.CompletedDate)
    .slice()
    .reverse()
    .map((r) => {
      const created = new Date(r.CreatedDate);
      const completed = new Date(r.CompletedDate);
      const sec = Math.max(0, (completed - created) / 1000);
      return { label: created.toLocaleString(), sec };
    });

  const labels = points.map((p) => p.label);
  const data = points.map((p) => p.sec);

  if (trendChart) trendChart.destroy();
  trendChart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [{ label: "Deploy duration (s)", data, tension: 0.25, fill: false }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 6 } },
      },
    },
  });
}

function exportDeploymentsToCSV(){
  const rows = (lastDeployments || []).filter(passesDeployFilter).filter(passesDeploySearch);
  const header = [
    "Id","Status","Type","CheckOnly","CreatedDate","StartDate","CompletedDate",
    "QueueMs","RunMs","TotalMs","CorrelatedRunId","CorrelatedFailures","CorrelatedTestMs"
  ];
  const out = [header];

  const now = new Date();
  for (const r of rows){
    const created = r.CreatedDate ? new Date(r.CreatedDate) : null;
    const started = r.StartDate ? new Date(r.StartDate) : created;
    const completed = r.CompletedDate ? new Date(r.CompletedDate) : null;
    const queueMs = created && started ? (started - created) : "";
    const runMs = started ? ((completed ? completed : now) - started) : "";
    const totalMs = created ? ((completed ? completed : now) - created) : "";

    const corr = deployToTest.get(r.Id) || null;
    out.push([
      r.Id,
      r.Status || "",
      r.Type || "",
      r.CheckOnly ? "true" : "false",
      r.CreatedDate || "",
      r.StartDate || "",
      r.CompletedDate || "",
      queueMs,
      runMs,
      totalMs,
      corr?.runId || "",
      corr?.failures ?? "",
      corr?.durationMs ?? "",
    ]);
  }

  const csv = out.map((row) => row.map((v) => {
    const s = String(v ?? "");
    if (/[\n\r\",]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }).join(",")).join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "deployments.csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* -------------------- Deploy details (Metadata API) -------------------- */

async function fetchMetadataDeployResult(asyncId){
  // Metadata REST resource: /services/data/vXX.X/metadata/deployRequest/<id>?includeDetails=true
  setLastRequest(`metadata deployRequest ${asyncId}`);
  return await Auth.sfFetch(`/metadata/deployRequest/${encodeURIComponent(asyncId)}?includeDetails=true`, { tooling:false });
}

function groupByComponentType(details){
  const suc = details?.componentSuccesses || [];
  const fail = details?.componentFailures || [];
  const map = new Map();
  const add = (t, key) => {
    const type = String(t || "Unknown");
    const cur = map.get(type) || { type, success: 0, fail: 0 };
    cur[key] += 1;
    map.set(type, cur);
  };
  suc.forEach((c) => add(c.componentType, "success"));
  fail.forEach((c) => add(c.componentType, "fail"));
  return Array.from(map.values()).sort((a,b) => (b.fail - a.fail) || (b.success - a.success));
}

function buildBottleneckInsights(deploy, mdDetails, corr){
  const insights = [];
  const created = deploy?.CreatedDate ? new Date(deploy.CreatedDate) : null;
  const started = deploy?.StartDate ? new Date(deploy.StartDate) : created;
  const completed = deploy?.CompletedDate ? new Date(deploy.CompletedDate) : null;
  const now = new Date();

  const queueMs = (created && started) ? (started - created) : null;
  const runMs = started ? ((completed ? completed : now) - started) : null;
  const totalMs = created ? ((completed ? completed : now) - created) : null;

  if (queueMs != null && queueMs > 2 * 60 * 1000) insights.push(`High queue time: ${fmtDuration(queueMs)} (possible org contention or queued jobs).`);
  if (runMs != null && runMs > 10 * 60 * 1000) insights.push(`Slow deployment runtime: ${fmtDuration(runMs)}.`);

  const totalComps = mdDetails ? ((mdDetails.componentSuccesses?.length || 0) + (mdDetails.componentFailures?.length || 0)) : null;
  if (totalComps != null && totalComps > 500) insights.push(`Large metadata payload: ${totalComps} components (Metadata API download often slows with large zips).`);

  if (corr?.durationMs != null && corr.durationMs > 5 * 60 * 1000) insights.push(`Slow correlated Apex tests: ${fmtDuration(corr.durationMs)}.`);
  if (corr?.failures != null && corr.failures > 0) insights.push(`Correlated tests failed: ${corr.failures}.`);

  if (!insights.length) insights.push("No obvious bottlenecks detected by heuristics.");
  return insights;
}

async function fetchConcurrentJobs(start, end){
  if (!start || !end) return [];
  const iso = (d) => d.toISOString();
  const soql = `SELECT Id, Status, JobType, MethodName, ApexClass.Name, CreatedDate, CompletedDate, TotalJobItems, JobItemsProcessed, NumberOfErrors FROM AsyncApexJob WHERE CreatedDate >= ${iso(start)} AND CreatedDate <= ${iso(end)} ORDER BY CreatedDate DESC LIMIT 100`;
  setLastRequest("rest query AsyncApexJob");
  const { ok, json } = await Auth.sfFetch(`/query?q=${encodeURIComponent(soql)}`, { tooling:false });
  if (!ok) return [];
  return json?.records || [];
}

async function renderTestHeatmap(runId){
  const canvas = document.getElementById("testHeatmap");
  if (!canvas || typeof Chart === "undefined") return;
  if (!runId) {
    if (heatmapChart) heatmapChart.destroy();
    heatmapChart = null;
    return;
  }

  const soql = `SELECT ApexClass.Name, RunTime, Outcome, MethodName FROM ApexTestResult WHERE ApexTestRunId = '${runId}' ORDER BY RunTime DESC LIMIT 200`;
  setLastRequest("tooling query ApexTestResult (heatmap)");
  const { ok, json } = await Auth.sfFetch(`/query?q=${encodeURIComponent(soql)}`, { tooling:true });
  if (!ok) return;

  const recs = json?.records || [];
  const agg = new Map();
  for (const r of recs){
    const cls = r.ApexClass?.Name || "(unknown)";
    const cur = agg.get(cls) || { cls, ms: 0, count: 0, fails: 0 };
    cur.ms += Number(r.RunTime || 0);
    cur.count += 1;
    if (String(r.Outcome || "").toLowerCase() !== "pass") cur.fails += 1;
    agg.set(cls, cur);
  }
  const top = Array.from(agg.values()).sort((a,b) => b.ms - a.ms).slice(0, 12);
  const labels = top.map((x) => x.cls);
  const data = top.map((x) => x.ms);

  if (heatmapChart) heatmapChart.destroy();
  heatmapChart = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: { labels, datasets: [{ label: "Total test runtime (ms)", data }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      indexAxis: "y",
      scales: {
        x: { ticks: { maxTicksLimit: 6 } },
      },
    },
  });
}

async function loadDeploymentDetails(asyncId){
  const deploy = (lastDeployments || []).find((d) => d.Id === asyncId) || { Id: asyncId };
  const corr = deployToTest.get(asyncId) || null;

  const t0 = performance.now();
  setBusy(true, "Details…");

  try{
    const md = await fetchMetadataDeployResult(asyncId);
    const dr = md.ok ? md.json?.deployResult : null;
    const details = dr?.details || null;

    // Summary
    document.getElementById("kvStatus")?.textContent = deploy.Status || dr?.status || "—";
    document.getElementById("kvComp")?.textContent = String((details?.componentSuccesses?.length || 0) + (details?.componentFailures?.length || 0));
    document.getElementById("kvCompErr")?.textContent = String(details?.componentFailures?.length || 0);
    document.getElementById("kvTests")?.textContent = String(dr?.numberTestsTotal ?? deploy.NumberTestsTotal ?? "—");
    document.getElementById("kvTestErr")?.textContent = String(dr?.numberTestErrors ?? deploy.NumberTestErrors ?? "—");
    document.getElementById("kvQueue")?.textContent = fmtDuration((deploy.StartDate ? new Date(deploy.StartDate) : new Date()) - (deploy.CreatedDate ? new Date(deploy.CreatedDate) : new Date()));
    document.getElementById("kvRun")?.textContent = fmtDuration((deploy.CompletedDate ? new Date(deploy.CompletedDate) : new Date()) - (deploy.StartDate ? new Date(deploy.StartDate) : (deploy.CreatedDate ? new Date(deploy.CreatedDate) : new Date())));
    document.getElementById("kvTotal")?.textContent = fmtDuration((deploy.CompletedDate ? new Date(deploy.CompletedDate) : new Date()) - (deploy.CreatedDate ? new Date(deploy.CreatedDate) : new Date()));

    // Metadata breakdown + failures
    const breakdown = groupByComponentType(details);
    const mdLines = [];
    mdLines.push("Metadata breakdown (by type)\n");
    for (const g of breakdown.slice(0, 15)){
      mdLines.push(`${g.type}: ${g.fail} failures, ${g.success} successes`);
    }

    if (details?.componentFailures?.length){
      mdLines.push("\nComponent failures (top 25)\n");
      details.componentFailures.slice(0,25).forEach((f) => {
        mdLines.push(`- ${f.componentType} ${f.fullName}: ${f.problem}`);
      });
    }
    if (dr?.errorMessage){
      mdLines.push(`\nDeploy errorMessage: ${dr.errorMessage}`);
    }
    document.getElementById("deployDetailsPre")?.textContent = mdLines.join("\n");

    // Insights
    const insights = buildBottleneckInsights(deploy, details, corr);
    const insLines = [];
    insLines.push("Bottleneck insights\n");
    insights.forEach((i) => insLines.push(`- ${i}`));
    if (corr?.runId){
      insLines.push(`\nCorrelated ApexTestRun: ${corr.runId} (${corr.confidence || ""})`);
      if (corr.durationMs != null) insLines.push(`Test duration: ${fmtDuration(corr.durationMs)}`);
      if (corr.failures != null) insLines.push(`Test failures: ${corr.failures}`);
    }
    document.getElementById("insightsPre")?.textContent = insLines.join("\n");

    // Concurrent jobs
    const created = deploy.CreatedDate ? new Date(deploy.CreatedDate) : null;
    const started = deploy.StartDate ? new Date(deploy.StartDate) : created;
    const completed = deploy.CompletedDate ? new Date(deploy.CompletedDate) : (started ? new Date(started.getTime() + 10*60*1000) : null);
    if (started && completed){
      const win = 10 * 60 * 1000;
      const jobs = await fetchConcurrentJobs(new Date(started.getTime() - win), new Date(completed.getTime() + win));
      const top = jobs.filter((j) => j.Status && !/Completed|Aborted|Failed/i.test(j.Status)).slice(0, 25);
      const jobLines = [];
      jobLines.push(`Concurrent AsyncApexJob (window ±10m): ${jobs.length} found`);
      if (!jobs.length){
        jobLines.push("(none)");
      } else {
        top.forEach((j) => {
          jobLines.push(`- ${j.Status} ${j.JobType || ""} ${j.ApexClass?.Name || ""} ${j.MethodName || ""} (${j.Id})`);
        });
      }
      document.getElementById("jobsPre")?.textContent = jobLines.join("\n");
    }

    // Dependency mapping (simple): deployment failures + correlated failing tests
    const depLines = [];
    depLines.push("Dependency map (heuristic)\n");
    if (details?.componentFailures?.length){
      depLines.push("Failed components:");
      details.componentFailures.slice(0, 10).forEach((f) => depLines.push(`- ${f.componentType} ${f.fullName}`));
    } else {
      depLines.push("No component failures reported.");
    }
    if (corr?.runId){
      depLines.push("\nCorrelated failing tests:");
      const soql = `SELECT ApexClass.Name, MethodName, Outcome, Message, StackTrace, RunTime FROM ApexTestResult WHERE ApexTestRunId = '${corr.runId}' AND Outcome != 'Pass' ORDER BY RunTime DESC LIMIT 25`;
      setLastRequest("tooling query ApexTestResult (dependency)");
      const tr = await Auth.sfFetch(`/query?q=${encodeURIComponent(soql)}`, { tooling:true });
      const fails = tr.ok ? (tr.json?.records || []) : [];
      if (!fails.length){
        depLines.push("(no failing test results returned)");
      } else {
        fails.forEach((t) => {
          const cpuRisk = Number(t.RunTime || 0) >= 8000 ? " ⚠️CPU-risk" : "";
          depLines.push(`- ${t.ApexClass?.Name}.${t.MethodName} (${t.Outcome}) ${t.RunTime}ms${cpuRisk}`);
        });
      }
    }
    document.getElementById("dependencyPre")?.textContent = depLines.join("\n");

    // Heatmap
    await renderTestHeatmap(corr?.runId || null);

    // Selected
    const t1 = performance.now();
    Auth.setSelected({
      kind: "DeployRequest",
      Id: asyncId,
      Status: deploy.Status || dr?.status,
      CreatedDate: deploy.CreatedDate,
      StartDate: deploy.StartDate,
      CompletedDate: deploy.CompletedDate,
      metadataDetailsOk: md.ok,
      detailsFetchMs: Math.round(t1 - t0),
      correlatedTest: corr,
    });
  } finally {
    setBusy(false);
  }
}

async function buildDeployProfile(asyncId){
  const deploy = (lastDeployments || []).find((d) => d.Id === asyncId) || { Id: asyncId };
  const corr = deployToTest.get(asyncId) || null;
  const md = await fetchMetadataDeployResult(asyncId);
  const details = md.ok ? md.json?.deployResult?.details : null;
  const groups = groupByComponentType(details);
  return {
    id: asyncId,
    status: deploy.Status || md.json?.deployResult?.status,
    compTotal: (details?.componentSuccesses?.length || 0) + (details?.componentFailures?.length || 0),
    compErrors: details?.componentFailures?.length || 0,
    testErrors: md.json?.deployResult?.numberTestErrors,
    correlated: corr,
    typeGroups: groups.slice(0, 10),
    mdOk: md.ok,
    mdError: md.ok ? null : Auth.extractSfError(md.json),
  };
}

function compareProfiles(a, b){
  const lines = [];
  const add = (k, va, vb) => lines.push(`${k}:\n  A: ${va}\n  B: ${vb}`);
  add("Status", a.status || "—", b.status || "—");
  add("Components total", a.compTotal || "—", b.compTotal || "—");
  add("Component errors", a.compErrors || "—", b.compErrors || "—");
  add("Test errors", a.testErrors || "—", b.testErrors || "—");
  add("Correlated ApexTestRun", a.correlated?.runId || "—", b.correlated?.runId || "—");
  add("Correlated failures", a.correlated?.failures ?? "—", b.correlated?.failures ?? "—");
  add("Correlated test time", fmtDuration(a.correlated?.durationMs ?? null), fmtDuration(b.correlated?.durationMs ?? null));
  const tg = (p) => (p.typeGroups || []).map((x) => `${x.type}(${x.fail}f/${x.success}s)`).join(", ") || "—";
  add("Top metadata types", tg(a), tg(b));
  if (!a.mdOk) lines.push(`\nA metadata details failed: ${a.mdError}`);
  if (!b.mdOk) lines.push(`\nB metadata details failed: ${b.mdError}`);
  return lines.join("\n\n");
}

/* -------------------- Packages -------------------- */
function pkgRowHtml(r){
  const pkg = r.SubscriberPackage || {};
  const ver = r.SubscriberPackageVersion || {};
  const version = [ver.MajorVersion,ver.MinorVersion,ver.PatchVersion,ver.BuildNumber].filter(x => x!=null).join(".");
  return `
    <tr>
      <td>${pkg.Name || "—"}</td>
      <td class="mono">${pkg.NamespacePrefix || "—"}</td>
      <td class="mono">${version || "—"}</td>
    </tr>
  `.trim();
}

async function fetchPackages(){
  const soql = `
    SELECT
      Id,
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

  const tbody = document.getElementById("packagesTbody");
  if (tbody) tbody.innerHTML = `<tr><td colspan="3" class="muted small">Loading…</td></tr>`;

  setBusy(true, "Packages…");
  setLastRequest("tooling query InstalledSubscriberPackage");
  const { ok, status, json } = await Auth.sfFetch(`/query?q=${encodeURIComponent(soql)}`, { tooling:true });
  setBusy(false);

  if (!ok){
    Auth.log(`Packages query failed (HTTP ${status}): ${Auth.extractSfError(json)}`);
    if (tbody) tbody.innerHTML = `<tr><td colspan="3" class="muted small">Failed to load packages.</td></tr>`;
    Auth.setSelected(`Packages query failed:\n${Auth.extractSfError(json)}`);
    return;
  }

  const recs = json?.records || [];
  const q = (document.getElementById("pkgSearch")?.value || "").trim().toLowerCase();
  const filtered = !q ? recs : recs.filter(r => {
    const p = r.SubscriberPackage || {};
    return `${p.Name||""} ${p.NamespacePrefix||""}`.toLowerCase().includes(q);
  });

  if (!filtered.length){
    if (tbody) tbody.innerHTML = `<tr><td colspan="3" class="muted small">No packages match your search.</td></tr>`;
    return;
  }

  if (tbody) tbody.innerHTML = filtered.map(pkgRowHtml).join("\n");
  Auth.log(`Packages refreshed (${filtered.length} rows).`);
}

/* -------------------- Refresh orchestration -------------------- */
async function refreshActiveTab(isPoll=false){
  const active =
    document.getElementById("tabDeployments")?.classList.contains("active") ? "deployments" :
    document.getElementById("tabApexTests")?.classList.contains("active") ? "tests" :
    "packages";

  if (inFlight){
    if (isPoll) lastPollSkipped = true;
    return;
  }

  try{
    if (active==="deployments"){
      document.getElementById("deploymentsTbody").innerHTML = `<tr><td colspan="14" class="muted small">Loading…</td></tr>`;
      await fetchDeployments();
    } else if (active==="tests"){
      document.getElementById("testsTbody").innerHTML = `<tr><td colspan="9" class="muted small">Loading…</td></tr>`;
      await refreshTests(false);
    } else {
      await fetchPackages();
    }
    setLastRefreshed();
    if (isPoll && lastPollSkipped) Auth.log("Polling: one tick was skipped due to in-flight request.");
  } catch (e){
    Auth.log(`Refresh error: ${e?.message || e}`);
  }
}

/* -------------------- Wiring -------------------- */
document.getElementById("loginBtn")?.addEventListener("click", Auth.login);
document.getElementById("logoutBtn")?.addEventListener("click", async () => {
  stopPolling();
  stopRealtimeMonitor();
  await Auth.logout();
});
document.getElementById("refreshBtn")?.addEventListener("click", () => refreshActiveTab(false));
document.getElementById("notifyBtn")?.addEventListener("click", requestNotifyPermission);
document.getElementById("exportBtn")?.addEventListener("click", exportDeploymentsToCSV);

document.getElementById("tabDeployments")?.addEventListener("click", async () => { showTab("deployments"); await refreshActiveTab(false); });
document.getElementById("tabApexTests")?.addEventListener("click", async () => { showTab("tests"); await refreshActiveTab(false); });
document.getElementById("tabPackages")?.addEventListener("click", async () => { showTab("packages"); await refreshActiveTab(false); });

document.getElementById("pollInterval")?.addEventListener("change", startPolling);

document.getElementById("deployFilter")?.addEventListener("change", () => refreshActiveTab(false));
document.getElementById("deployLimit")?.addEventListener("change", () => refreshActiveTab(false));
document.getElementById("deployStart")?.addEventListener("change", () => refreshActiveTab(false));
document.getElementById("deployEnd")?.addEventListener("change", () => refreshActiveTab(false));
document.getElementById("deploySearch")?.addEventListener("input", () => {
  const filtered = (lastDeployments||[]).filter(passesDeployFilter).filter(passesDeploySearch);
  renderDeploymentsTable(filtered);
});

document.getElementById("testLimit")?.addEventListener("change", () => refreshTests(false));
document.getElementById("testFilter")?.addEventListener("change", () => {
  const filtered = (lastTestRuns||[]).filter(passesTestFilter).filter(passesTestSearch);
  renderTestsTable(filtered);
});
document.getElementById("testSearch")?.addEventListener("input", () => {
  const filtered = (lastTestRuns||[]).filter(passesTestFilter).filter(passesTestSearch);
  renderTestsTable(filtered);
});
document.getElementById("refreshTestsBtn")?.addEventListener("click", () => refreshTests(false));

document.getElementById("pkgSearch")?.addEventListener("input", () => fetchPackages());
document.getElementById("refreshPackagesBtn")?.addEventListener("click", fetchPackages);

document.getElementById("compareBtn")?.addEventListener("click", async () => {
  const a = (document.getElementById("compareA")?.value || "").trim();
  const b = (document.getElementById("compareB")?.value || "").trim();
  if (!a || !b){
    Auth.setText("comparePre", "Enter two deployment async IDs.");
    return;
  }
  setBusy(true, "Compare…");
  const t0 = performance.now();
  const p1 = await getDeployProfile(a);
  const p2 = await getDeployProfile(b);
  setBusy(false);
  const dt = (performance.now()-t0)/1000;
  Auth.setText("comparePre", `Compare (${dt.toFixed(2)}s)\n\nA: ${a}\n${JSON.stringify(p1, null, 2)}\n\nB: ${b}\n${JSON.stringify(p2, null, 2)}`);
});

document.getElementById("compareBtn")?.addEventListener("click", async () => {
  const a = (document.getElementById("compareA")?.value || "").trim();
  const b = (document.getElementById("compareB")?.value || "").trim();
  if (!a || !b){
    document.getElementById("comparePre")?.textContent = "Provide two deploy async ids.";
    return;
  }
  setBusy(true, "Compare…");
  try{
    const pa = await buildDeployProfile(a);
    const pb = await buildDeployProfile(b);
    document.getElementById("comparePre")?.textContent = compareProfiles(pa,pb);
  } finally {
    setBusy(false);
  }
});

document.getElementById("compareBtn")?.addEventListener("click", async () => {
  const a = (document.getElementById("compareA")?.value || "").trim();
  const b = (document.getElementById("compareB")?.value || "").trim();
  if (!a || !b){
    document.getElementById("comparePre")?.textContent = "Enter two deploy async ids to compare.";
    return;
  }
  setBusy(true, "Compare…");
  try{
    const [pa, pb] = await Promise.all([buildDeployProfile(a), buildDeployProfile(b)]);
    document.getElementById("comparePre")?.textContent = compareProfiles(pa, pb);
  } finally {
    setBusy(false);
  }
});

/* -------------------- Init -------------------- */
(async function init(){
  Auth.wireApiVersionSelect();
  Auth.wireErrorUI();
  Auth.wireOrgUI();

  Auth.setText("buildPill", BUILD);
  Auth.setText("apiPill", `v${Auth.getApiVersion()}`);
  Auth.showBanner("");

  showTab("deployments");

  await Auth.handleRedirectIfPresent();

  const token = Auth.loadToken();
  if (token?.access_token){
    await Auth.ensureOrgContext();
    Auth.renderOrgContext();
    Auth.renderErrors();
    Auth.renderOrgDetails();
    Auth.log("Session restored (token found).");
    await refreshTests(true);
    await fetchDeployments();
    setLastRefreshed();
    startPolling();
    startRealtimeMonitor();
  } else {
    Auth.setText("orgPill", "Not connected");
    Auth.log("Not logged in.");
  }
})();
