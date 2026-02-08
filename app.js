const BUILD = Auth.BUILD;

let pollTimer = null;
let inFlight = false;
let lastPollSkipped = false;

let lastDeployments = [];
let lastTestRuns = [];
let deployToTest = new Map();

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
      <tr>
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
        return;
      }

      if (action==="selectTestRun"){
        showTab("tests");
        await refreshTests(false);
        await selectTestRunAndFailures(id);
      }
    });
  });
}

/* -------------------- Data: Deployments -------------------- */
async function fetchDeployments(){
  const limit = Number(document.getElementById("deployLimit")?.value || 20);
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
document.getElementById("logoutBtn")?.addEventListener("click", Auth.logout);
document.getElementById("refreshBtn")?.addEventListener("click", () => refreshActiveTab(false));

document.getElementById("tabDeployments")?.addEventListener("click", async () => { showTab("deployments"); await refreshActiveTab(false); });
document.getElementById("tabApexTests")?.addEventListener("click", async () => { showTab("tests"); await refreshActiveTab(false); });
document.getElementById("tabPackages")?.addEventListener("click", async () => { showTab("packages"); await refreshActiveTab(false); });

document.getElementById("pollInterval")?.addEventListener("change", startPolling);

document.getElementById("deployFilter")?.addEventListener("change", () => refreshActiveTab(false));
document.getElementById("deployLimit")?.addEventListener("change", () => refreshActiveTab(false));
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

/* -------------------- Init -------------------- */
(async function init(){
  Auth.wireApiVersionSelect();

  Auth.setText("buildPill", BUILD);
  Auth.setText("apiPill", `v${Auth.getApiVersion()}`);
  Auth.showBanner("");

  showTab("deployments");

  await Auth.handleRedirectIfPresent();

  const token = Auth.loadToken();
  if (token?.access_token){
    Auth.setText("orgPill", token.instance_url || "Connected");
    Auth.log("Session restored (token found).");
    await refreshTests(true);
    await fetchDeployments();
    setLastRefreshed();
    startPolling();
  } else {
    Auth.setText("orgPill", "Not connected");
    Auth.log("Not logged in.");
  }
})();
