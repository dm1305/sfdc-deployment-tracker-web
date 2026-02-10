/* inventory.js - Metadata inventory (Tooling objects) minimal, stable
   Build: 2026-02-09.15
*/

(function() {
  function $(id) { return document.getElementById(id); }
  const state = {
    types: [],
    selected: new Set(),
    results: []
  };

  function log(msg) {
    const el = $("logPre");
    if (!el) return;
    const stamp = new Date().toISOString();
    el.textContent = `[${stamp}] ${msg}\n` + el.textContent;
  }

  function setBusy(on) {
    $("runInventoryBtn") && ($("runInventoryBtn").disabled = !!on);
    $("downloadCsvBtn") && ($("downloadCsvBtn").disabled = !!on || !state.results.length);
  }

  function getApiV() { return Auth.getApiVersion(); }

  function limit() {
    const v = Number($("invLimit")?.value || 250);
    return Number.isFinite(v) ? Math.max(1, Math.min(2000, v)) : 250;
  }

  function parseDate(id) {
    const el = $(id);
    if (!el || !el.value) return null; // yyyy-mm-dd from input type=date
    return el.value;
  }

  function renderTypes() {
    const wrap = $("typeCheckboxWrap");
    if (!wrap) return;
    if (!state.types.length) {
      wrap.innerHTML = `<div class="muted small">No types loaded.</div>`;
      return;
    }
    wrap.innerHTML = state.types.map(t => {
      const checked = state.selected.has(t) ? "checked" : "";
      return `
        <label class="chkRow">
          <input type="checkbox" data-type="${t}" ${checked}>
          <span class="mono">${t}</span>
        </label>`;
    }).join("");

    wrap.querySelectorAll("input[type=checkbox][data-type]").forEach(cb => {
      cb.addEventListener("change", () => {
        const t = cb.getAttribute("data-type");
        if (!t) return;
        if (cb.checked) state.selected.add(t); else state.selected.delete(t);
      });
    });
  }

  async function loadTypes() {
    if (!Auth.isLoggedIn()) {
      Auth.setBanner("Not logged in. Click Login.", "warn");
      return;
    }
    setBusy(true);
    try {
      const apiV = getApiV();
      const res = await Auth.sfFetch(`/services/data/v${apiV}/tooling/sobjects/`);
      const names = (res.sobjects || []).map(s => s.name).filter(Boolean);

      const preferred = ["ApexClass","ApexTrigger","ApexPage","ApexComponent","AuraDefinitionBundle","LightningComponentBundle","PermissionSet","Profile","CustomObject","CustomField","Layout","FlowDefinition","Flow","EmailTemplate"];
      const sorted = Array.from(new Set(names)).sort((a,b) => {
        const ai = preferred.includes(a) ? -1 : 0;
        const bi = preferred.includes(b) ? -1 : 0;
        if (ai !== bi) return ai - bi;
        return a.localeCompare(b);
      });

      state.types = sorted;

      state.selected = new Set(preferred.filter(p => sorted.includes(p)));
      if (!state.selected.size) sorted.slice(0, 25).forEach(x => state.selected.add(x));

      renderTypes();
      log(`Loaded ${sorted.length} Tooling sObjects.`);
    } catch (e) {
      Auth.setBanner(`Failed to load types: ${e.message}`, "error");
      log(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function describeType(typeName) {
    const apiV = getApiV();
    return Auth.sfFetch(`/services/data/v${apiV}/tooling/sobjects/${encodeURIComponent(typeName)}/describe`);
  }

  function buildSoql(typeName, nameField, fromDate, toDate, lim) {
    const fields = ["Id"];
    if (nameField && nameField !== "Id") fields.push(nameField);
    fields.push("LastModifiedDate");
    fields.push("LastModifiedById");

    let soql = `SELECT ${fields.join(", ")} FROM ${typeName}`;
    const where = [];
    if (fromDate) where.push(`LastModifiedDate >= ${fromDate}T00:00:00.000Z`);
    if (toDate) where.push(`LastModifiedDate <= ${toDate}T23:59:59.999Z`);
    if (where.length) soql += " WHERE " + where.join(" AND ");
    soql += " ORDER BY LastModifiedDate DESC";
    soql += ` LIMIT ${lim}`;
    return soql;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  }

  function renderResults() {
    const wrap = $("resultsWrap");
    if (!wrap) return;

    if (!state.results.length) {
      wrap.innerHTML = `<div class="muted small">No results yet.</div>`;
      return;
    }

    wrap.innerHTML = `
      <div class="muted small" style="margin-bottom:8px;">Rows: ${state.results.length}</div>
      <div style="max-height: 420px; overflow:auto; border:1px solid rgba(255,255,255,.10); border-radius:12px;">
        <table class="table">
          <thead>
            <tr><th>Type</th><th>Name</th><th>Last modified</th><th>Id</th></tr>
          </thead>
          <tbody>
            ${state.results.slice(0, 2000).map(r => `
              <tr>
                <td class="mono">${r.Type}</td>
                <td>${escapeHtml(r.Name || "—")}</td>
                <td class="mono small">${r.LastModifiedDate || "—"}</td>
                <td class="mono small">${r.Id}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>`;
  }

  async function runInventory() {
    if (!Auth.isLoggedIn()) {
      Auth.setBanner("Not logged in. Click Login.", "warn");
      return;
    }
    const selected = Array.from(state.selected);
    if (!selected.length) {
      Auth.setBanner("Select at least one type.", "warn");
      return;
    }

    const fromDate = parseDate("changedFrom");
    const toDate = parseDate("changedTo");
    const lim = limit();

    setBusy(true);
    state.results = [];
    try {
      const apiV = getApiV();

      for (const typeName of selected) {
        log(`Describing ${typeName}…`);
        let desc;
        try {
          desc = await describeType(typeName);
        } catch (e) {
          log(`Skip ${typeName} (describe failed): ${e.message}`);
          continue;
        }

        const nameField = desc?.nameField || desc?.fields?.find(f => f.name === "Name")?.name || null;
        const soql = buildSoql(typeName, nameField, fromDate, toDate, lim);
        const q = encodeURIComponent(soql);

        log(`Query ${typeName}…`);
        try {
          const res = await Auth.sfFetch(`/services/data/v${apiV}/tooling/query?q=${q}`);
          const recs = res.records || [];
          recs.forEach(r => state.results.push({
            Type: typeName,
            Id: r.Id || "",
            Name: (nameField && r[nameField]) ? r[nameField] : "",
            LastModifiedDate: r.LastModifiedDate || "",
            LastModifiedById: r.LastModifiedById || ""
          }));
          log(`${typeName}: ${recs.length} rows.`);
        } catch (e) {
          log(`Skip ${typeName} (query failed): ${e.message}`);
        }
      }

      renderResults();
      $("downloadCsvBtn") && ($("downloadCsvBtn").disabled = !state.results.length);
      log(`Done. Total rows: ${state.results.length}`);
    } catch (e) {
      Auth.setBanner(`Inventory failed: ${e.message}`, "error");
    } finally {
      setBusy(false);
    }
  }

  function exportCsv() {
    if (!state.results.length) return;
    const cols = ["Type","Name","LastModifiedDate","LastModifiedById","Id"];
    const lines = [cols.join(",")];
    for (const r of state.results) {
      lines.push(cols.map(c => `"${String(r[c]||"").replace(/"/g,'""')}"`).join(","));
    }
    const blob = new Blob([lines.join("\n")], {type:"text/csv"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "metadata_inventory.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function wireUi() {
    $("runInventoryBtn")?.addEventListener("click", runInventory);
    $("downloadCsvBtn")?.addEventListener("click", exportCsv);

    $("selectAllTypesBtn")?.addEventListener("click", () => {
      state.types.forEach(t => state.selected.add(t));
      renderTypes();
    });
    $("selectNoTypesBtn")?.addEventListener("click", () => {
      state.selected.clear();
      renderTypes();
    });
    $("selectRecommendedBtn")?.addEventListener("click", () => {
      const preferred = ["ApexClass","ApexTrigger","ApexPage","ApexComponent","AuraDefinitionBundle","LightningComponentBundle","PermissionSet","Profile","CustomObject","CustomField","Layout","FlowDefinition","Flow","EmailTemplate"];
      state.selected = new Set(preferred.filter(p => state.types.includes(p)));
      renderTypes();
    });

    $("typeSearch")?.addEventListener("input", () => {
      const q = ($("typeSearch").value || "").trim().toLowerCase();
      const wrap = $("typeCheckboxWrap");
      if (!wrap) return;
      wrap.querySelectorAll("label.chkRow").forEach(lab => {
        const t = lab.textContent.toLowerCase();
        lab.style.display = (!q || t.includes(q)) ? "" : "none";
      });
    });

    $("orgDetailsBtn")?.addEventListener("click", () => {
      const inst = localStorage.getItem(Auth.keys.instanceUrl) || "—";
      alert(`Instance: ${inst}\nRedirect URI: ${Auth.canonicalRedirectUri()}\nOrigin: ${location.origin}\nIf CORS errors: Setup → CORS → add origin.`);
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    await Auth.init();
    wireUi();

    // Add Results card if not present in HTML (older versions)
    if (!$("resultsWrap")) {
      const cards = document.querySelectorAll(".card");
      if (cards.length) {
        const div = document.createElement("div");
        div.className = "card";
        div.innerHTML = `<div class="cardTitle">Results</div><div id="resultsWrap"><div class="muted small">No results yet.</div></div>`;
        cards[cards.length-1].parentElement.appendChild(div);
      }
    }

    if (Auth.isLoggedIn()) loadTypes();
  });
})();
