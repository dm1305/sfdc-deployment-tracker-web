// workbench.js
// Workbench-like UI: listMetadata + retrieve benchmark (requires a proxy because Metadata API is SOAP + CORS).
const BUILD = Auth.BUILD;

let timerT0 = null;
let timerHandle = null;
let lastZipUrl = null;

function $(id) { return document.getElementById(id); }

function setBusy(on) {
  const pill = $("busyPill");
  if (pill) pill.textContent = on ? "Working…" : "Idle";
  const runBtn = $("runBtn");
  if (runBtn) runBtn.disabled = !!on;
  const dl = $("downloadBtn");
  if (dl) dl.disabled = !!on || !lastZipUrl;
}

function setLastRequest(t) {
  const el = $("lastRequest");
  if (el) el.textContent = `Last request: ${t}`;
}

function log(msg) {
  const el = $("logPre");
  if (!el) return;
  el.textContent = `[${new Date().toISOString()}] ${msg}\n` + el.textContent;
}

function setOut(objOrText) {
  const el = $("outputPre");
  if (!el) return;
  el.textContent = typeof objOrText === "string" ? objOrText : JSON.stringify(objOrText, null, 2);
}

function startTimer() {
  timerT0 = performance.now();
  stopTimer();
  timerHandle = setInterval(() => {
    const s = (performance.now() - timerT0) / 1000;
    const tl = $("timerLabel");
    if (tl) tl.textContent = `Timer: ${s.toFixed(1)}s`;
  }, 100);
}

function stopTimer() {
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
}

function buildPackageXml(type, members, apiVersion) {
  const mem = (members || "*").trim();
  const membersXml = mem.includes("*")
    ? `<members>*</members>`
    : mem.split(",").map(m => m.trim()).filter(Boolean).map(m => `<members>${m}</members>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
  <types>
    ${membersXml}
    <name>${type}</name>
  </types>
  <version>${apiVersion}</version>
</Package>`;
}

function getProxyBase() {
  const raw = ($("proxyUrl")?.value || "").trim();
  return raw.replace(/\/+$/g, "");
}

async function proxyPost(path, payload) {
  const base = getProxyBase();
  if (!base) {
    Auth.showBanner("Set Proxy URL first (Cloudflare Worker / Netlify Function).");
    throw new Error("Missing Proxy URL");
  }

  const resp = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const json = await resp.json().catch(() => null);
  if (!resp.ok) {
    const msg = json?.error || json?.message || JSON.stringify(json) || `HTTP ${resp.status}`;
    throw new Error(msg);
  }
  return json;
}

async function proxyGet(path) {
  const base = getProxyBase();
  if (!base) throw new Error("Missing Proxy URL");
  const resp = await fetch(`${base}${path}`);
  const json = await resp.json().catch(() => null);
  if (!resp.ok) {
    const msg = json?.error || json?.message || JSON.stringify(json) || `HTTP ${resp.status}`;
    throw new Error(msg);
  }
  return json;
}

async function run() {
  lastZipUrl = null;
  const dl = $("downloadBtn");
  if (dl) dl.disabled = true;

  const token = Auth.loadToken();
  if (!token?.access_token || !token?.instance_url) {
    Auth.showBanner("Not logged in. Click Login.");
    return;
  }

  const apiVersion = Auth.getApiVersion();
  const action = $("wbAction")?.value || "list";
  const type = ($("mdType")?.value || "").trim();
  const members = ($("mdMembers")?.value || "").trim() || "*";

  if (!type) {
    Auth.showBanner("Enter a metadata type (e.g. Flow, ApexClass).");
    return;
  }

  Auth.showBanner("");
  setBusy(true);
  startTimer();

  try {
    if (action === "list") {
      setLastRequest(`listMetadata ${type}`);
      log(`listMetadata: type=${type} apiVersion=${apiVersion}`);

      const json = await proxyPost("/metadata/list", {
        instanceUrl: token.instance_url,
        accessToken: token.access_token,
        apiVersion,
        type,
      });

      setOut(json);
      log("listMetadata complete.");
    } else {
      const packageXml = buildPackageXml(type, members, apiVersion);

      setLastRequest(`retrieve ${type} members=${members}`);
      log(`retrieve start: type=${type} members=${members} apiVersion=${apiVersion}`);

      const started = await proxyPost("/metadata/retrieve", {
        instanceUrl: token.instance_url,
        accessToken: token.access_token,
        apiVersion,
        packageXml,
      });

      const asyncId = started?.id;
      if (!asyncId) throw new Error("Proxy did not return an async retrieve id");

      log(`retrieve async id: ${asyncId}`);
      setOut({ started, packageXml });

      // Poll until done
      while (true) {
        await new Promise(r => setTimeout(r, 2000));
        setLastRequest(`check ${asyncId}`);

        const st = await proxyGet(`/metadata/check?id=${encodeURIComponent(asyncId)}`);
        setOut(st);

        if (st?.status === "Succeeded" || st?.done === true) {
          log("retrieve complete.");
          if (st.zipUrl) {
            lastZipUrl = st.zipUrl;
            const btn = $("downloadBtn");
            if (btn) btn.disabled = false;
          }
          break;
        }

        if (st?.status === "Failed") {
          log(`retrieve failed: ${st?.errorMessage || "unknown error"}`);
          break;
        }
      }
    }
  } catch (e) {
    log(`ERROR: ${e?.message || e}`);
    Auth.showBanner(`Error: ${e?.message || e}`);
    try { Auth.reportError({ scope: "workbench", title: "Proxy/metadata error", detail: (e?.message || String(e)), request: $("lastRequest")?.textContent || null }); } catch {}
  } finally {
    stopTimer();
    setBusy(false);
  }
}

/* ---------- Wiring ---------- */
$("runBtn")?.addEventListener("click", run);
$("downloadBtn")?.addEventListener("click", () => {
  if (lastZipUrl) window.open(lastZipUrl, "_blank");
});

$("loginBtn")?.addEventListener("click", Auth.login);
$("logoutBtn")?.addEventListener("click", Auth.logout);

/* ---------- Init ---------- */
(async function init() {
  Auth.wireErrorUI();
  Auth.wireApiVersionSelect();

  Auth.setText("buildPill", BUILD);
  Auth.setText("apiPill", `v${Auth.getApiVersion()}`);
  Auth.showBanner("");

  await Auth.handleRedirectIfPresent();

  const token = Auth.loadToken();
  if (token?.access_token) {
    await Auth.ensureOrgContext();
    Auth.renderOrgContext();
    Auth.renderErrors();
    Auth.renderOrgDetails();
    log("Session restored.");
  } else {
    Auth.setText("orgPill", "Not connected");
    log("Not logged in.");
  }
})();
