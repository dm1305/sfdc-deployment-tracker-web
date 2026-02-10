/* workbench.js - lightweight API tester (keeps UI, avoids metadata API complexity)
   Build: 2026-02-10.1

   Usage:
     - In "Type": enter a SOQL query (starts with SELECT), or a REST path (starts with /)
     - "Members": optional, unused for now (kept for future metadata retrieve support)
*/

(function() {
  function $(id) { return document.getElementById(id); }

  function log(msg) {
    const el = $("logPre");
    if (!el) return;
    const stamp = new Date().toISOString();
    el.textContent = `[${stamp}] ${msg}\n` + el.textContent;
  }

  function setOut(obj) {
    const el = $("outputPre");
    if (!el) return;
    el.textContent = (typeof obj === "string") ? obj : JSON.stringify(obj, null, 2);
  }

  function setBusy(on) {
    $("runBtn") && ($("runBtn").disabled = !!on);
    $("downloadBtn") && ($("downloadBtn").disabled = !!on);
  }

  async function run() {
    if (!Auth.isLoggedIn()) {
      Auth.setBanner("Not logged in. Click Login.", "warn");
      return;
    }
    const apiV = Auth.getApiVersion();
    const raw = ($("mdType")?.value || "").trim();
    const proxyUrl = ($("proxyUrl")?.value || "").trim();

    // Proxy placeholder: not implemented in this minimal build (kept for future).
    if (proxyUrl) {
      log("Proxy URL is set but not used in this minimal build.");
    }

    setBusy(true);
    try {
      if (!raw) {
        const res = await Auth.sfFetch(`/services/data/v${apiV}/limits`);
        setOut(res);
        log("Fetched /limits");
        return;
      }

      if (/^select\s/i.test(raw)) {
        const q = encodeURIComponent(raw);
        const res = await Auth.sfFetch(`/services/data/v${apiV}/query?q=${q}`);
        setOut(res);
        log(`Query returned ${res.records?.length || 0} records.`);
        return;
      }

      const path = raw.startsWith("/") ? raw : `/services/data/v${apiV}/${raw.replace(/^\/+/,"")}`;
      const res = await Auth.sfFetch(path);
      setOut(res);
      log(`Fetched ${path}`);
    } catch (e) {
      Auth.setBanner(`Workbench request failed: ${e.message}`, "error");
      log(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  function download() {
    const txt = $("outputPre")?.textContent || "";
    if (!txt) return;
    const blob = new Blob([txt], {type:"application/json"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "workbench_output.json";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function wireUi() {
    $("runBtn")?.addEventListener("click", run);
    $("downloadBtn")?.addEventListener("click", download);
    $("refreshOrgDetailsBtn")?.addEventListener("click", () => Auth.init());
    $("clearErrorsBtn")?.addEventListener("click", () => Auth.setBanner(""));
  }

  document.addEventListener("DOMContentLoaded", async () => {
    await Auth.init();
    wireUi();
    if (Auth.isLoggedIn()) run();
  });
})();
