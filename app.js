const API_VERSION = "65.0";
const TOKEN_KEY = "sf_token";

const $ = (id) => document.getElementById(id);

let cachedRecords = [];
let trendChart = null;
let activeJobs = new Set();

/* ---------------- Core Fetch ---------------- */

async function sfFetch(path) {
  const raw = localStorage.getItem(TOKEN_KEY);
  if (!raw) throw new Error("Missing sf_token");

  const token = JSON.parse(raw);
  const url = `${token.instance_url}/services/data/v${API_VERSION}${path}`;

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token.access_token}` }
  });

  const text = await resp.text();
  const json = text ? JSON.parse(text) : {};

  if (!resp.ok) {
    const msg = json?.[0]?.message || json.message || "API error";
    throw new Error(msg);
  }

  return json;
}

/* ---------------- Notifications ---------------- */

function requestNotifyPermission() {
  Notification.requestPermission().then(p => {
    if (p === "granted") alert("Notifications enabled!");
  });
}

function notifyUser(title, body) {
  if (Notification.permission === "granted") {
    new Notification(title, {
      body,
      icon: "https://www.salesforce.com/favicon.ico"
    });
  }
}

/* ---------------- Live Monitor ---------------- */

async function pollActiveDeployments() {
  try {
    const soql =
      "SELECT Id, Status FROM DeployRequest WHERE Status IN ('InProgress','Queued')";
    const res = await sfFetch(`/tooling/query?q=${encodeURIComponent(soql)}`);

    const current = new Set(res.records.map(r => r.Id));

    activeJobs.forEach(id => {
      if (!current.has(id)) {
        notifyUser("Deployment Complete", `Job ${id} completed`);
        loadRecent();
      }
    });

    activeJobs = current;

    $("liveMonitorList").innerHTML = res.records.length
      ? res.records.map(r =>
          `<div class="status-badge status-InProgress">${r.Id.substring(0,15)}...</div>`
        ).join("")
      : "<small>All quiet.</small>";
  } catch (e) {
    console.error(e);
  }
}

/* ---------------- Deployment Details ---------------- */

async function analyzeDeployment(id) {
  $("detailsPanel").style.display = "block";
  $("dependencyMap").innerHTML = "<small>Loading...</small>";

  try {
    const data = await sfFetch(
      `/metadata/deployRequest/${id}?includeDetails=true`
    );

    const details = data.details || {};
    const tests = data.runTestResult?.failures || [];

    let html = "";

    (details.componentFailures || []).forEach(f => {
      html += `
        <div class="dep-card">
          <strong>${f.componentType}:</strong> ${f.fullName}
          <br><small style="color:red">${f.problem}</small>
        </div>`;
    });

    tests.forEach(t => {
      html += `
        <div class="dep-card test-fail">
          <strong>${t.name}.${t.methodName}</strong>
          <pre>${t.message}\n${t.stackTrace || ""}</pre>
        </div>`;
    });

    $("dependencyMap").innerHTML = html || "<p>No blockers found.</p>";
  } catch (e) {
    $("dependencyMap").innerHTML =
      `<p style="color:red">Failed to load: ${e.message}</p>`;
  }
}

/* ---------------- Filtering + Load ---------------- */

function toSoql(dt) {
  return dt.toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function loadRecent() {
  const start = $("filterStart").value;
  const end = $("filterEnd").value;

  let q =
    "SELECT Id, Status, CreatedDate, CompletedDate FROM DeployRequest";
  const f = [];

  if (start) f.push(`CreatedDate >= ${toSoql(new Date(start))}`);
  if (end) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() + 1);
    f.push(`CreatedDate < ${toSoql(d)}`);
  }

  if (f.length) q += " WHERE " + f.join(" AND ");
  q += " ORDER BY CreatedDate DESC LIMIT 50";

  const res = await sfFetch(`/tooling/query?q=${encodeURIComponent(q)}`);
  cachedRecords = res.records;

  $("deploymentsTbody").innerHTML = cachedRecords.map(r => `
    <tr onclick="analyzeDeployment('${r.Id}')">
      <td><span class="status-badge status-${r.Status}">${r.Status}</span></td>
      <td>${r.CompletedDate
        ? ((new Date(r.CompletedDate) - new Date(r.CreatedDate))/1000).toFixed(0) + "s"
        : "—"}</td>
    </tr>
  `).join("");

  updateTrendChart(cachedRecords);
}

/* ---------------- CSV Export ---------------- */

function exportToCSV() {
  const rows = [["Id","Status","Created","Duration"]];
  cachedRecords.forEach(r => {
    const d = r.CompletedDate
      ? (new Date(r.CompletedDate) - new Date(r.CreatedDate))/1000
      : 0;
    rows.push([r.Id, r.Status, r.CreatedDate, d]);
  });

  const csv = "data:text/csv;charset=utf-8," +
    rows.map(r => r.join(",")).join("\n");

  const a = document.createElement("a");
  a.href = encodeURI(csv);
  a.download = "deployments.csv";
  a.click();
}

/* ---------------- Chart ---------------- */

function updateTrendChart(records) {
  const ctx = $("trendChart").getContext("2d");

  const data = records
    .filter(r => r.CompletedDate)
    .reverse()
    .map(r => ({
      t: new Date(r.CreatedDate).toLocaleTimeString(),
      y: (new Date(r.CompletedDate) - new Date(r.CreatedDate))/1000
    }));

  if (trendChart) trendChart.destroy();

  trendChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: data.map(d => d.t),
      datasets: [{
        data: data.map(d => d.y),
        borderColor: "#10ad9d",
        fill: false
      }]
    },
    options: { maintainAspectRatio: false }
  });
}

/* ---------------- Init ---------------- */

setInterval(pollActiveDeployments, 5000);

if (localStorage.getItem(TOKEN_KEY)) {
  loadRecent();
}
