// inventory.js (FULL FILE)
// Inventory across *all types selected by default* + checkbox type picker + changed-between filter.
// Notes:
// - This is Tooling API inventory, not full Metadata API retrieve.
// - “Changed between” uses LastModifiedDate when present in the object; if absent, we fall back to CreatedDate filter.
// - Some Tooling objects are huge; “includeLargeTypes” controls heavy ones.

(function () {
  const BUILD = (window.Auth && Auth.BUILD) ? Auth.BUILD : "unknown";

  function $(id) { return document.getElementById(id); }

  function setText(id, t) { const el = $(id); if (el) el.textContent = t; }

  function nowIso() { return new Date().toISOString(); }

  function log(msg) {
    const el = $("logPre");
    if (!el) return;
    el.textContent = `[${nowIso()}] ${msg}\n` + el.textContent;
  }

  function setSelected(objOrText) {
    const el = $("selectedPre");
    if (!el) return;
    el.textContent = typeof objOrText === "string" ? objOrText : JSON.stringify(objOrText, null, 2);
  }

  function setBusy(on, label = null) {
    const pill = $("busyPill");
    if (pill) pill.textContent = on ? (label || "Working…") : "Idle";
    ["runInventoryBtn", "downloadCsvBtn"].forEach((id) => {
      const b = $(id);
      if (b) b.disabled = on || (id === "downloadCsvBtn" && (!state.filteredRows.length));
    });
  }

  function setProgress(pct, label) {
    const prog = $("invProgress");
    const pctEl = $("progressPct");
    const labelEl = $("progressLabel");
    if (prog) prog.value = Math.max(0, Math.min(100, pct));
    if (pctEl) pctEl.textContent = `${Math.round(pct)}%`;
    if (labelEl) labelEl.textContent = label || "—";
  }

  function setLastRefreshed() {
    setText("lastRefreshed", `Last run: ${new Date().toISOString().replace("T", " ").replace("Z", "Z")}`);
  }

  function setLastRequest(text) {
    setText("lastRequest", `Last request: ${text}`);
  }

  function debounce(fn, ms = 250) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function fmtTime(s) {
    if (!s) return "—";
    const d = new Date(s);
    if (!Number.isFinite(d.getTime())) return "—";
    return d.toISOString().replace("T", " ").replace("Z", "Z");
  }

  function toUtcStartIso(dateStr) {
    // dateStr is yyyy-mm-dd; interpret as UTC 00:00:00
    if (!dateStr) return null;
    const d = new Date(dateStr + "T00:00:00.000Z");
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }

  function toUtcEndIso(dateStr) {
    // dateStr is yyyy-mm-dd; interpret as UTC 23:59:59.999
    if (!dateStr) return null;
    const d = new Date(dateStr + "T23:59:59.999Z");
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }

  // Candidate Tooling objects that look like “metadata inventory”.
  // This is intentionally broad. Some orgs won’t have all of these; we skip those that error.
  const BASE_TYPES = [
    // Code
    "ApexClass", "ApexTrigger", "ApexPage", "ApexComponent",
    "ApexEmailNotification", "ApexTestSuite",

    // LWC/Aura
    "LightningComponentBundle", "LightningComponentResource",
    "AuraDefinitionBundle", "AuraDefinition",

    // Static / labels
    "StaticResource", "CustomLabel",

    // Objects & fields
    "CustomObject", "CustomField", "FieldSet", "Index", "EntityDefinition", "FieldDefinition",

    // Automation
    "Flow", "FlowDefinition", "FlowTest", "WorkflowRule",
    "ValidationRule", "DuplicateRule", "MatchingRule",
    "ApexWorkflowNotification", "ApexTestQueueItem",

    // Permissions / security (heavy in some orgs)
    "PermissionSet", "Profile", "PermissionSetGroup",

    // Tabs / apps / nav
    "CustomTab", "AppMenuItem", "LightningExperienceTheme",

    // Layout/CompactLayout/RecordType
    "Layout", "CompactLayout", "RecordType", "BusinessProcess",

    // Email templates / documents
    "EmailTemplate", "Document",

    // Reports/Dashboards
    "Report", "Dashboard", "ReportType",

    // Named creds / auth
    "NamedCredential", "ExternalCredential", "AuthProvider", "ConnectedApplication",

    // Custom metadata
    "CustomMetadata", "CustomMetadataType",

    // Packaging / deployed artifacts
    "InstalledSubscriberPackage", "Package2", "Package2Version",

    // Flexipages
    "FlexiPage",

    // Queues / groups
    "QueueSobject", "Group",

    // Remote sites / CSP
    "RemoteProxy", "CspTrustedSite", "TrustedSite",

    // Misc common
    "AssignmentRule", "EscalationRule", "AutoResponseRule",
    "HomePageLayout", "SearchLayouts",
  ];

  const LARGE_TYPES = new Set(["Profile", "PermissionSet", "PermissionSetGroup"]);

  const RECOMMENDED_TYPES = new Set([
    "ApexClass", "ApexTrigger", "ApexPage", "ApexComponent",
    "LightningComponentBundle", "AuraDefinitionBundle",
    "StaticResource", "CustomObject", "CustomField",
    "Flow", "FlowDefinition", "ValidationRule",
    "RecordType", "Layout", "FlexiPage",
    "NamedCredential", "AuthProvider", "RemoteProxy", "CspTrustedSite",
  ]);

  const state = {
    allTypes: [],
    selectedTypes: new Set(),
    rows: [],          // full scan rows
    filteredRows: [],  // filtered for display/export
    lastCsv: "",
  };

  function getSelectedTypesFromUi() {
    const wrap = $("typeCheckboxWrap");
    if (!wrap) return [];
    const inputs = wrap.querySelectorAll("input[type=checkbox][data-type]");
    const chosen = [];
    inputs.forEach((cb) => {
      if (cb.checked) chosen.push(cb.getAttribute("data-type"));
    });
    return chosen;
  }

  function renderTypeCheckboxes() {
    const wrap = $("typeCheckboxWrap");
    if (!wrap) return;

    const q = ($("typeSearch")?.value || "").trim().toLowerCase();
    const includeLarge = !!$("includeLargeTypes")?.checked;

    const list = state.allTypes
      .filter((t) => includeLarge ? true : !LARGE_TYPES.has(t))
      .filter((t) => !q || t.toLowerCase().includes(q));

    setText("typeCountLabel", `${list.length} shown / ${state.allTypes.length} total`);

    wrap.innerHTML = list.map((t) => {
      const checked = state.selectedTypes.has(t);
      const isLarge = LARGE_TYPES.has(t);
      const isRec = RECOMMENDED_TYPES.has(t);
      return `
        <label style="display:flex; gap:10px; align-items:center; padding:6px 6px; border-bottom:1px solid rgba(255,255,255,.06);">
          <input type="checkbox" data-type="${t}" ${checked ? "checked" : ""} />
          <span class="mono">${t}</span>
          ${isRec ? `<span class="muted small">(recommended)</span>` : ""}
          ${isLarge ? `<span class="muted small">(large)</span>` : ""}
        </label>
      `.trim();
    }).join("");

    // Track changes back into state.selectedTypes
    wrap.querySelectorAll("input[type=checkbox][data-type]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const t = cb.getAttribute("data-type");
        if (!t) return;
        if (cb.checked) state.selectedTypes.add(t);
        else state.selectedTypes.delete(t);
      });
    });
  }

  function selectAllTypes() {
    const includeLarge = !!$("includeLargeTypes")?.checked;
    state.selectedTypes = new Set(state.allTypes.filter((t) => includeLarge ? true : !LARGE_TYPES.has(t)));
    renderTypeCheckboxes();
  }

  function selectNoTypes() {
    state.selectedTypes = new Set();
    renderTypeCheckboxes();
  }

  function selectRecommendedTypes() {
    const includeLarge = !!$("includeLargeTypes")?.checked;
    const chosen = state.allTypes.filter((t) => RECOMMENDED_TYPES.has(t) && (includeLarge ? true : !LARGE_TYPES.has(t)));
    state.selectedTypes = new Set(chosen);
    renderTypeCheckboxes();
  }

  function passesTextFilter(row) {
    const q = ($("textFilter")?.value || "").trim().toLowerCase();
    if (!q) return true;
    const blob = [
      row.type, row.name, row.namespace, row.lastModifiedBy, row.createdBy, row.id
    ].filter(Boolean).join(" ").toLowerCase();
    return blob.includes(q);
  }

  function applyFiltersAndRender() {
    const filtered = (state.rows || []).filter(passesTextFilter);
    state.filteredRows = filtered;

    setText("resultsCountLabel", `${filtered.length} rows`);
    renderTable(filtered);
    const dl = $("downloadCsvBtn");
    if (dl) dl.disabled = filtered.length === 0;
  }

  function renderTable(rows) {
    const tbody = $("invTbody");
    if (!tbody) return;

    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="muted small">No rows match current filters.</td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map((r, idx) => {
      return `
        <tr data-idx="${idx}">
          <td class="mono">${r.type || "—"}</td>
          <td class="mono">${r.name || "—"}</td>
          <td class="mono">${r.namespace || "—"}</td>
          <td class="mono">${fmtTime(r.lastModifiedDate)}</td>
          <td>${r.lastModifiedBy || "—"}</td>
          <td class="mono">${fmtTime(r.createdDate)}</td>
          <td>${r.createdBy || "—"}</td>
          <td class="mono">${r.id || "—"}</td>
        </tr>
      `.trim();
    }).join("\n");

    tbody.querySelectorAll("tr[data-idx]").forEach((tr) => {
      tr.addEventListener("click", () => {
        const i = Number(tr.getAttribute("data-idx"));
        const rec = rows[i];
        if (rec) setSelected(rec);
      });
    });
  }

  function csvEscape(v) {
    const s = (v == null) ? "" : String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  function buildCsv(rows) {
    const header = ["Type", "API Name", "Namespace", "LastModifiedDate", "LastModifiedBy", "CreatedDate", "CreatedBy", "Id"];
    const lines = [header.join(",")];
    (rows || []).forEach((r) => {
      lines.push([
        r.type, r.name, r.namespace, r.lastModifiedDate, r.lastModifiedBy, r.createdDate, r.createdBy, r.id
      ].map(csvEscape).join(","));
    });
    return lines.join("\n");
  }

  function downloadCsv() {
    const csv = buildCsv(state.filteredRows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `metadata_inventory_${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function queryType(typeName, limit, changedFromIso, changedToIso) {
    // We use a best-effort field set. Some objects won’t support some fields; we progressively simplify on failure.
    const fieldSets = [
      ["Id", "DeveloperName", "NamespacePrefix", "LastModifiedDate", "LastModifiedBy.Name", "CreatedDate", "CreatedBy.Name"],
      ["Id", "Name", "NamespacePrefix", "LastModifiedDate", "LastModifiedBy.Name", "CreatedDate", "CreatedBy.Name"],
      ["Id", "DeveloperName", "LastModifiedDate", "LastModifiedBy.Name", "CreatedDate", "CreatedBy.Name"],
      ["Id", "Name", "LastModifiedDate", "LastModifiedBy.Name", "CreatedDate", "CreatedBy.Name"],
      ["Id", "Name", "LastModifiedDate", "CreatedDate"],
      ["Id", "Name", "CreatedDate"],
      ["Id", "CreatedDate"],
      ["Id"],
    ];

    const dateWhere = (() => {
      const parts = [];
      // Prefer LastModifiedDate; if object doesn’t have it we’ll fall back by retrying queries without the where.
      if (changedFromIso) parts.push(`LastModifiedDate >= ${changedFromIso}`);
      if (changedToIso) parts.push(`LastModifiedDate <= ${changedToIso}`);
      if (!parts.length) return "";
      return ` WHERE ${parts.join(" AND ")}`;
    })();

    const baseOrder = " ORDER BY LastModifiedDate DESC NULLS LAST";
    const baseLimit = ` LIMIT ${limit}`;

    for (let i = 0; i < fieldSets.length; i++) {
      const fields = fieldSets[i].join(", ");
      const soql = `SELECT ${fields} FROM ${typeName}${dateWhere}${baseOrder}${baseLimit}`;
      setLastRequest(`tooling query ${typeName}`);

      const { ok, status, json } = await Auth.sfFetch(`/query?q=${encodeURIComponent(soql)}`, { tooling: true });

      if (ok) {
        const recs = json?.records || [];
        return { ok: true, records: recs, usedFields: fieldSets[i], usedWhere: !!dateWhere };
      }

      // If the failure is “No such column LastModifiedDate”, try without date filter by switching to CreatedDate filter.
      const msg = (Auth.extractSfError ? Auth.extractSfError(json) : (json?.[0]?.message || json?.message || "")).toString();

      const lastModMissing = /No such column 'LastModifiedDate'/i.test(msg) || /LastModifiedDate.*not supported/i.test(msg);
      if (lastModMissing && (changedFromIso || changedToIso)) {
        // Try CreatedDate window instead for this type.
        const parts = [];
        if (changedFromIso) parts.push(`CreatedDate >= ${changedFromIso}`);
        if (changedToIso) parts.push(`CreatedDate <= ${changedToIso}`);
        const where2 = parts.length ? ` WHERE ${parts.join(" AND ")}` : "";
        const soql2 = `SELECT ${fields} FROM ${typeName}${where2} ORDER BY CreatedDate DESC NULLS LAST${baseLimit}`;
        setLastRequest(`tooling query ${typeName} (CreatedDate fallback)`);

        const r2 = await Auth.sfFetch(`/query?q=${encodeURIComponent(soql2)}`, { tooling: true });
        if (r2.ok) {
          const recs2 = r2.json?.records || [];
          return { ok: true, records: recs2, usedFields: fieldSets[i], usedWhere: !!where2 };
        }
      }

      // Otherwise, try next simpler field set.
      log(`Type ${typeName}: retrying with fewer fields (attempt ${i + 2}/${fieldSets.length})`);
    }

    return { ok: false, records: [], usedFields: [], usedWhere: false };
  }

  function normalizeRow(typeName, r) {
    const name = r?.DeveloperName || r?.Name || r?.FullName || r?.MasterLabel || r?.Label || "";
    const ns = r?.NamespacePrefix || r?.Namespace || r?.Namespace__c || "";
    const lastModBy = r?.LastModifiedBy?.Name || "";
    const createdBy = r?.CreatedBy?.Name || "";
    return {
      type: typeName,
      id: r?.Id || "",
      name,
      namespace: ns,
      lastModifiedDate: r?.LastModifiedDate || null,
      lastModifiedBy: lastModBy,
      createdDate: r?.CreatedDate || null,
      createdBy,
      raw: r,
    };
  }

  async function runInventory() {
    const token = Auth.loadToken();
    if (!token?.access_token) {
      Auth.showBanner("Not logged in. Click Login.");
      return;
    }

    const limit = Number($("invLimit")?.value || 250);
    const includeLarge = !!$("includeLargeTypes")?.checked;

    // Date window
    const fromIso = toUtcStartIso($("changedFrom")?.value || "");
    const toIso = toUtcEndIso($("changedTo")?.value || "");

    // Read selected types from UI (checkbox list)
    let selected = getSelectedTypesFromUi();

    // If none selected, default to all (per your requirement)
    if (!selected.length) {
      selected = state.allTypes.filter((t) => includeLarge ? true : !LARGE_TYPES.has(t));
      state.selectedTypes = new Set(selected);
      renderTypeCheckboxes();
    }

    // Apply includeLarge gating at runtime too
    selected = selected.filter((t) => includeLarge ? true : !LARGE_TYPES.has(t));

    if (!selected.length) {
      Auth.showBanner("No types selected.");
      return;
    }

    Auth.showBanner("");
    setBusy(true, "Scanning…");
    setProgress(0, "Starting…");
    setSelected("Running…");
    $("invTbody").innerHTML = `<tr><td colspan="8" class="muted small">Loading…</td></tr>`;

    state.rows = [];
    state.filteredRows = [];

    const startedMsg = `Scan started (API v${Auth.getApiVersion()}) across ${selected.length} types` +
      (fromIso || toIso ? ` | changed between ${$("changedFrom")?.value || "—"} and ${$("changedTo")?.value || "—"} (UTC)` : "");
    log(startedMsg);

    const total = selected.length;
    let done = 0;

    for (const t of selected) {
      done += 1;
      const pct = (done - 1) / total * 100;
      setProgress(pct, `Querying ${t} (${done}/${total})`);
      log(`Querying ${t}…`);

      try {
        const res = await queryType(t, limit, fromIso, toIso);
        if (!res.ok) {
          log(`${t}: failed or unsupported (skipped)`);
          continue;
        }

        const rows = (res.records || []).map((r) => normalizeRow(t, r));
        state.rows.push(...rows);
        log(`${t}: ${rows.length} rows`);
      } catch (e) {
        // Record error via global error system if available
        if (Auth.reportError) {
          Auth.reportError({
            scope: "inventory",
            message: `Failed querying ${t}`,
            detail: e?.message || String(e),
          });
        }
        log(`${t}: ERROR ${e?.message || e}`);
      }
    }

    setProgress(100, "Finalizing…");
    setLastRefreshed();
    log(`Scan complete. Total rows: ${state.rows.length}`);

    // Default view is “all types/all rows”, but allow free-text filter
    applyFiltersAndRender();

    setBusy(false);
    setProgress(100, "Done");
    setSelected({ summary: { totalRows: state.rows.length, typesSelected: selected.length, limitPerType: limit, fromIso, toIso } });
  }

  /* ---------- Wiring ---------- */

  // Auth wiring + page chrome
  $("loginBtn")?.addEventListener("click", () => Auth.login());
  $("logoutBtn")?.addEventListener("click", () => Auth.logout());

  $("runInventoryBtn")?.addEventListener("click", runInventory);
  $("downloadCsvBtn")?.addEventListener("click", downloadCsv);

  $("textFilter")?.addEventListener("input", debounce(applyFiltersAndRender, 200));

  $("typeSearch")?.addEventListener("input", debounce(renderTypeCheckboxes, 150));
  $("includeLargeTypes")?.addEventListener("change", () => {
    // When toggled off, remove large types from selected
    if (!$("includeLargeTypes")?.checked) {
      LARGE_TYPES.forEach((t) => state.selectedTypes.delete(t));
    }
    renderTypeCheckboxes();
  });

  $("selectAllTypesBtn")?.addEventListener("click", selectAllTypes);
  $("selectNoTypesBtn")?.addEventListener("click", selectNoTypes);
  $("selectRecommendedBtn")?.addEventListener("click", selectRecommendedTypes);

  /* ---------- Init ---------- */
  (async function init() {
    // Wire shared chrome + api selector
    Auth.wireApiVersionSelect();

    setText("buildPill", BUILD);
    setText("apiPill", `v${Auth.getApiVersion()}`);

    // Build type list (broad list) and default-select all (per requirement)
    state.allTypes = Array.from(new Set(BASE_TYPES)).sort((a, b) => a.localeCompare(b));
    state.selectedTypes = new Set(state.allTypes); // default: all selected
    renderTypeCheckboxes();

    // Restore session (if any) and hydrate org context
    await Auth.handleRedirectIfPresent();

    const token = Auth.loadToken();
    if (token?.access_token) {
      setText("orgPill", token.instance_url || "Connected");
      log("Session restored (token found).");
      if (Auth.loadOrgContext) await Auth.loadOrgContext(true);
    } else {
      setText("orgPill", "Not connected");
      log("Not logged in.");
    }

    // Default date filters: empty (means “all time”)
    setProgress(0, "Idle");
    applyFiltersAndRender();
  })();
})();
