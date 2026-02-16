// inventory.js
// Lists ALL available Metadata API types via describeMetadata() through the proxy worker.
// This is the "metadata type catalog" (like Workbench), not an inventory of individual components.

(function () {
  function $(id) { return document.getElementById(id); }

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

  function setBusy(on, label) {
    const pill = $("busyPill");
    if (pill) pill.textContent = on ? (label || "Working…") : "Idle";
    const b = $("refreshTypesBtn");
    if (b) b.disabled = !!on;
  }

  function setCounts(shown, total) {
    const el = $("resultsCountLabel");
    if (el) el.textContent = `${shown} shown / ${total} total`;
  }

  function getProxyUrl() {
    const raw = localStorage.getItem("metadata_proxy_url") || $("proxyUrl")?.value || "";
    return (raw || "").trim().replace(/\/+$/, "");
  }

  function setProxyUrl(v) {
    const url = (v || "").trim();
    if (url) localStorage.setItem("metadata_proxy_url", url);
    else localStorage.removeItem("metadata_proxy_url");
  }

  function loadToken() {
    // Primary storage used by index.html/app.js
    const raw = localStorage.getItem("sf_token");
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  async function fetchDescribeMetadata() {
    const proxy = getProxyUrl();
    if (!proxy) throw new Error("No proxy URL set. Open Workbench tester, set Proxy URL, and Save.");

    const tok = loadToken();
    if (!tok || !tok.access_token || !tok.instance_url) {
      throw new Error("Not logged in (no access token / instance URL found).");
    }

    const apiVersion = "65.0";

    const res = await fetch(`${proxy}/metadata/describe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instanceUrl: tok.instance_url,
        accessToken: tok.access_token,
        apiVersion,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Proxy error ${res.status}: ${text.slice(0, 600)}`);
    }
    return res.json();
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function renderRows(types) {
    const tbody = $("typesTbody");
    if (!tbody) return;

    const q = ($("textFilter")?.value || "").trim().toLowerCase();
    const filtered = !q
      ? types
      : types.filter((t) => {
          const hay = `${t.xmlName || ""} ${t.directoryName || ""} ${t.suffix || ""}`.toLowerCase();
          return hay.includes(q);
        });

    setCounts(filtered.length, types.length);

    if (!filtered.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="muted small">No rows match.</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered
      .map((t) => {
        const ro = t.readOnly ? "✔" : "";
        const folder = t.inFolder ? "✔" : "";
        return `
          <tr class="row" data-xml="${escapeHtml(t.xmlName || "")}">
            <td class="mono">${escapeHtml(t.xmlName || "")}</td>
            <td class="mono">${escapeHtml(t.directoryName || "")}</td>
            <td class="mono">${escapeHtml(t.suffix || "")}</td>
            <td style="text-align:center;">${folder}</td>
            <td style="text-align:center;">${ro}</td>
          </tr>
        `.trim();
      })
      .join("");

    tbody.querySelectorAll("tr.row").forEach((tr) => {
      tr.addEventListener("click", () => {
        const xml = tr.getAttribute("data-xml");
        const hit = types.find((x) => x.xmlName === xml);
        setSelected(hit || "Nothing selected.");
      });
    });
  }

  const state = { types: [] };

  async function refresh() {
    setBusy(true, "Loading describeMetadata…");
    setSelected("Nothing selected.");
    log("Refreshing metadata type catalog (describeMetadata)…");

    try {
      const data = await fetchDescribeMetadata();
      const types = Array.isArray(data?.metadataObjects) ? data.metadataObjects : [];
      types.sort((a, b) => (a.xmlName || "").localeCompare(b.xmlName || ""));
      state.types = types;
      renderRows(state.types);
      log(`Loaded ${types.length} metadata types.`);
    } catch (e) {
      log(`ERROR: ${e?.message || String(e)}`);
      state.types = [];
      renderRows([]);
    } finally {
      setBusy(false);
    }
  }

  function wireUi() {
    // Load persisted proxy URL into the input.
    const saved = localStorage.getItem("metadata_proxy_url") || "";
    if ($("proxyUrl") && saved) $("proxyUrl").value = saved;

    $("saveProxyBtn")?.addEventListener("click", () => {
      const v = $("proxyUrl")?.value || "";
      setProxyUrl(v);
      log(`Proxy URL saved: ${getProxyUrl() || "(empty)"}`);
    });

    $("refreshTypesBtn")?.addEventListener("click", refresh);
    $("textFilter")?.addEventListener("input", () => renderRows(state.types));
  }

  wireUi();

  // Auto-load if token exists.
  if (loadToken()?.access_token) refresh();
  else renderRows([]);
})();
