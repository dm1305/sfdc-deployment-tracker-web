const CLIENT_ID = "3MVG9YFqzc_KnL.wada6.pbgp4zDPc8T6u6uR6srOVo1fS7XOD_kHsrDH_QurZzXeEgwzWBU365_xXQ54mMNn";
const LOGIN_DOMAIN = "https://gearsetcom-4bf-dev-ed.develop.my.salesforce.com";
const API_VERSION = "65.0";
const TOKEN_KEY = "sf_token";

const $ = (id) => document.getElementById(id);
let trendChart = null;
let comparisonBase = null; // Stores first selected deployment for comparison

/* ---------------- API & Init ---------------- */

async function sfFetch(path, tooling = false) {
    const token = JSON.parse(localStorage.getItem(TOKEN_KEY));
    const base = `${token.instance_url}/services/data/v${API_VERSION}${tooling ? '/tooling' : ''}`;
    const resp = await fetch(base + path, { headers: { Authorization: `Bearer ${token.access_token}` } });
    return await resp.json();
}

/* ---------------- Visualizations ---------------- */

function updateTrendChart(records) {
    const ctx = $('trendChart').getContext('2d');
    const data = [...records].reverse().map(r => {
        const start = new Date(r.StartDate || r.CreatedDate);
        const end = new Date(r.CompletedDate);
        return (r.CompletedDate) ? (end - start) / 1000 : 0;
    });
    const labels = [...records].reverse().map(r => new Date(r.CreatedDate).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}));

    if (trendChart) trendChart.destroy();
    trendChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: 'Execution Duration (Seconds)',
                data,
                borderColor: '#10ad9d',
                backgroundColor: 'rgba(16, 173, 157, 0.1)',
                fill: true,
                tension: 0.3
            }]
        },
        options: { responsive: true, maintainAspectRatio: false }
    });
}

/* ---------------- Deployment Logic ---------------- */

async function loadDeployments() {
    const soql = `SELECT Id, Status, CreatedDate, StartDate, CompletedDate FROM DeployRequest ORDER BY CreatedDate DESC LIMIT 20`;
    const res = await sfFetch(`/query?q=${encodeURIComponent(soql)}`, true);
    updateTrendChart(res.records);
    
    const tbody = $("deploymentsTbody");
    tbody.innerHTML = "";
    res.records.forEach(r => {
        const total = r.CompletedDate ? (new Date(r.CompletedDate) - new Date(r.StartDate || r.CreatedDate)) / 1000 : 0;
        const qTime = r.StartDate ? (new Date(r.StartDate) - new Date(r.CreatedDate)) / 1000 : 0;

        const tr = document.createElement("tr");
        tr.className = "row-click";
        tr.innerHTML = `
            <td><b>${r.Status}</b></td>
            <td>${total.toFixed(1)}s</td>
            <td>${qTime.toFixed(1)}s</td>
            <td><button class="outline" onclick="event.stopPropagation(); prepareComparison('${r.Id}')">Compare</button></td>
        `;
        tr.onclick = () => analyzeDeployment(r.Id, qTime);
        tbody.appendChild(tr);
    });
}

async function analyzeDeployment(id, qTime) {
    $("detailsPanel").style.display = "block";
    const data = await sfFetch(`/tooling/deployResponses/${id}`, false);
    const details = data.deployDetails;
    const successes = details.componentSuccesses || [];
    const failures = details.componentFailures || [];
    
    $("compTotal").textContent = successes.length + failures.length;
    $("runTimeLabel").textContent = `${((new Date(data.completedDate) - new Date(data.startDate))/1000).toFixed(1)}s`;

    // Insight: Sharing & CPU Timeout Detection
    const insights = [];
    if (successes.some(c => c.componentType === 'CustomField')) {
        insights.push(`<div class="insight-pill">⚠️ Sharing Recalc Risk</div>`);
    }

    let heatmapHtml = "";
    if (details.runTestResult?.successes) {
        details.runTestResult.successes.forEach(t => {
            const isHighRisk = t.time > 10000; // 10s threshold for CPU timeout risk detection
            heatmapHtml += `
                <div style="margin-bottom:0.5rem">
                    <small>${t.name} <span class="${isHighRisk ? 'risk-high' : ''}">(${t.time}ms)</span></small>
                    <progress value="${t.time}" max="30000"></progress>
                    ${isHighRisk ? '<small class="risk-high">Potential CPU Timeout Hazard</small>' : ''}
                </div>`;
        });
    }
    $("testHeatmap").innerHTML = heatmapHtml || "No tests found.";
    $("insightList").innerHTML = insights.join('');
    comparisonBase = { id, details }; // Store for potential comparison
}

/* ---------------- Comparison Tool ---------------- */

async function prepareComparison(targetId) {
    if (!comparisonBase) {
        alert("Select a deployment on the left first to set as baseline.");
        return;
    }
    const targetData = await sfFetch(`/tooling/deployResponses/${targetId}`, false);
    const targetDetails = targetData.deployDetails;

    $("comparisonSection").style.display = "block";
    $("compareContent").innerHTML = `
        <div>
            <h6>Base: ${comparisonBase.id.substring(0,8)}</h6>
            <p>Components: ${comparisonBase.details.componentSuccesses?.length || 0}</p>
            <p>Tests: ${comparisonBase.details.runTestResult?.numTestsRun || 0}</p>
        </div>
        <div>
            <h6>Target: ${targetId.substring(0,8)}</h6>
            <p>Components: ${targetDetails.componentSuccesses?.length || 0}</p>
            <p>Tests: ${targetDetails.runTestResult?.numTestsRun || 0}</p>
        </div>
    `;
}

/* ---------------- Wiring ---------------- */
$("loginBtn")?.addEventListener("click", () => { /* existing oauth logic */ });
$("logoutBtn")?.addEventListener("click", () => { localStorage.clear(); location.reload(); });

(async function init() {
    if (localStorage.getItem(TOKEN_KEY)) {
        $("orgPill").textContent = JSON.parse(localStorage.getItem(TOKEN_KEY)).instance_url;
        loadDeployments();
    }
})();
