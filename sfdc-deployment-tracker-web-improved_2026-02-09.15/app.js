/* app.js - Deployments/Validations view (minimal, stable)
   Build: 2026-02-09.15
*/

(function() {
  function $(id) { return document.getElementById(id); }

  let lastRows = [];

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

  function setBusy(on) {
    const pill = $("busyPill");
    if (pill) pill.textContent = on ? "Working…" : "Idle";
    const btn = $("refreshBtn");
    if (btn) btn.disabled = !!on;
    const ex = $("exportCsvBtn");
    if (ex) ex.disabled = !!on || !lastRows.length;
  }

  function fmt(d) {
    if (!d) return "—";
    const dt = new Date(d);
    if (!Number.isFinite(dt.getTime())) return "—";
    return dt.toISOString().replace("T"," ").replace("Z","Z");
  }

  function statusClass(status) {
    const s = String(status || "").toLowerCase();
    if (s.includes("succeed")) return "good";
    if (s.includes("fail") || s.includes("error")) return "bad";
    if (s.includes("progress") || s.includes("queue") || s.includes("pending") || s.includes("valid")) return "warn";
    return "";
  }

  function applyFilter(rows) {
    const filter = ($("deployFilter")?.value || "all").toLowerCase();
    const q = ($("deploySearch")?.value || "").trim().toLowerCase();

    return rows.filter(r => {
      if (filter === "active") {
        return ["inprogress","queued","pending","processing","valid"].some(k => String(r.Status||"").toLowerCase().includes(k));
      }
      if (filter === "failed") {
        return ["fail","error"].some(k => String(r.Status||"").toLowerCase().includes(k));
      }
      if (filter === "checkonly") return !!r.CheckOnly;
      if (filter === "real") return !r.CheckOnly;

      return true;
    }).filter(r => {
      if (!q) return true;
      const blob = [
        r.Status, r.Type, r.Id,
        r.CreatedBy?.Name, r.CreatedBy?.Username,
        r.ErrorStatusCode, r.ErrorMessage
      ].filter(Boolean).join(" ").toLowerCase();
      return blob.includes(q);
    });
  }

  function render(rows) {
    const tbody = $("deploymentsTbody");
    if (!tbody) return;

    if (!rows.length) {
      tbody.innerHTML = `<tr><td class="muted small" colspan="14">No rows.</td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map((r, idx) => {
      const st = r.Status || "—";
      const cls = statusClass(st);
      return `
        <tr data-idx="${idx}" class="rowClick">
          <td><span class="status ${cls}">${st}</span></td>
          <td>${r.CreatedBy?.Name || "—"}</td>
          <td>${r.Type || "—"}</td>
          <td>${fmt(r.CreatedDate)}</td>
          <td>${fmt(r.StartDate)}</td>
          <td>${fmt(r.CompletedDate)}</td>
          <td>${r.CheckOnly ? "Yes" : "No"}</td>
          <td class="mono">${r.Id}</td>
          <td>${r.ErrorStatusCode || "—"}</td>
          <td class="small">${(r.ErrorMessage || "—").toString().slice(0,120)}</td>
          <td><button class="btnSmall" data-open="${r.Id}">Details</button></td>
        </tr>`;
    }).join("");

    tbody.querySelectorAll("tr.rowClick").forEach(tr => {
      tr.addEventListener("click", (e) => {
        const idx = Number(tr.getAttribute("data-idx"));
        const row = rows[idx];
        if (!row) return;
        setSelected(row);
      });
    });

    tbody.querySelectorAll("button[data-open]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-open");
        if (id) openDeployDetails(id);
      });
    });
  }

  async function fetchDeployments() {
    if (!window.Auth?.isLoggedIn()) {
      Auth.setBanner("Not logged in. Click Login.", "warn");
      return;
    }
    const apiV = Auth.getApiVersion();

    setBusy(true);
    try {
      // DeployRequest covers real deploys and validations (CheckOnly=true).
      const soql =
        "SELECT Id, Status, Type, CheckOnly, CreatedDate, StartDate, CompletedDate," +
        " ErrorStatusCode, ErrorMessage, CreatedBy.Name, CreatedBy.Username " +
        "FROM DeployRequest ORDER BY CreatedDate DESC LIMIT 200";
      const q = encodeURIComponent(soql);
      const res = await Auth.sfFetch(`/services/data/v${apiV}/tooling/query?q=${q}`);
      lastRows = res.records || [];
      render(applyFilter(lastRows));
      log(`Loaded ${lastRows.length} deploy requests.`);
      $("exportCsvBtn")?.removeAttribute("disabled");
    } catch (e) {
      Auth.setBanner(`Failed to load deployments: ${e.message}`, "error");
      log(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function openDeployDetails(deployId) {
    if (!deployId) return;
    if (!window.Auth?.isLoggedIn()) return;
    const apiV = Auth.getApiVersion();
    setBusy(true);
    try {
      const res = await Auth.sfFetch(`/services/data/v${apiV}/tooling/sobjects/DeployRequest/${deployId}`);
      setSelected(res);
      log(`Loaded details for ${deployId}`);
    } catch (e) {
      Auth.setBanner(`Failed to load deploy details: ${e.message}`, "error");
    } finally {
      setBusy(false);
    }
  }

  function exportCsv() {
    if (!lastRows.length) return;
    const cols = ["Status","CheckOnly","Type","CreatedDate","StartDate","CompletedDate","CreatedByName","Id","ErrorStatusCode","ErrorMessage"];
    const lines = [cols.join(",")];
    for (const r of applyFilter(lastRows)) {
      const row = {
        Status: r.Status || "",
        CheckOnly: r.CheckOnly ? "true" : "false",
        Type: r.Type || "",
        CreatedDate: r.CreatedDate || "",
        StartDate: r.StartDate || "",
        CompletedDate: r.CompletedDate || "",
        CreatedByName: r.CreatedBy?.Name || "",
        Id: r.Id || "",
        ErrorStatusCode: r.ErrorStatusCode || "",
        ErrorMessage: (r.ErrorMessage || "").replace(/\s+/g," ").trim()
      };
      lines.push(cols.map(c => `"${String(row[c]||"").replace(/"/g,'""')}"`).join(","));
    }
    const blob = new Blob([lines.join("\n")], {type:"text/csv"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "deployments.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function wireUi() {
    $("refreshBtn")?.addEventListener("click", fetchDeployments);
    $("deployFilter")?.addEventListener("change", () => render(applyFilter(lastRows)));
    $("deploySearch")?.addEventListener("input", () => render(applyFilter(lastRows)));
    $("exportCsvBtn")?.addEventListener("click", exportCsv);

    // Basic org details: just show instance + org id already in pills
    $("orgDetailsBtn")?.addEventListener("click", () => {
      const inst = localStorage.getItem(Auth.keys.instanceUrl) || "—";
      const msg = `Instance: ${inst}\nRedirect URI: ${Auth.canonicalRedirectUri()}\nLogin host: ${Auth.getLoginHost()}\nAPI: v${Auth.getApiVersion()}`;
      alert(msg);
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    if (!window.Auth) return;
    await Auth.init();
    wireUi();

    // Auto-load after login.
    if (Auth.isLoggedIn()) fetchDeployments();
  });
})();
