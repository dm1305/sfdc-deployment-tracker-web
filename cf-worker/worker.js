// cf-worker/worker.js
// Cloudflare Worker skeleton (CORS-enabled) for Workbench Mode.
// NOTE: This is a stub; Metadata API is SOAP. These endpoints return 501 until implemented.
// You deploy this as a Worker and put its URL into the Workbench page "Proxy URL" field.

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
      if (url.pathname === "/metadata/list" && req.method === "POST") {
        // Expected body: { instanceUrl, accessToken, apiVersion, type }
        // TODO: implement SOAP listMetadata
        return json({ error: "Not implemented: listMetadata SOAP" }, 501);
      }

      if (url.pathname === "/metadata/retrieve" && req.method === "POST") {
        // Expected body: { instanceUrl, accessToken, apiVersion, packageXml }
        // TODO: implement SOAP retrieve
        return json({ error: "Not implemented: retrieve SOAP" }, 501);
      }

      if (url.pathname === "/metadata/check" && req.method === "GET") {
        // Expected query: ?id=<asyncId>
        // TODO: implement SOAP checkStatus + retrieveResult and return:
        // { status: "InProgress"|"Succeeded"|"Failed", done: boolean, zipUrl?: string, errorMessage?: string }
        return json({ error: "Not implemented: checkStatus/retrieveResult SOAP" }, 501);
      }

      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: e?.message || String(e) }, 500);
    }
  },
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}
