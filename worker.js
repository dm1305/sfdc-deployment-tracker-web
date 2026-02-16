/**
 * Cloudflare Worker: Salesforce Metadata SOAP proxy
 *
 * Why:
 * - GitHub Pages is a static origin; you cannot call Salesforce's SOAP Metadata API directly due to CORS.
 * - This Worker performs the SOAP call server-side and returns JSON to the browser.
 *
 * Endpoints:
 * - GET  /                => 200 "OK" (health)
 * - POST /metadata/describe => { instanceUrl, accessToken, apiVersion } -> { metadataObjects: [...] }
 *
 * Notes:
 * - accessToken is used as the SOAP SessionHeader sessionId.
 * - apiVersion should match your REST version (e.g. 65.0). If omitted, defaults to 65.0.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Simple health check (useful in the CF dashboard / browser)
    if (request.method === "GET") {
      return new Response("OK", { status: 200, headers: CORS_HEADERS });
    }

    if (request.method !== "POST") {
      return new Response("Only POST allowed", { status: 405, headers: CORS_HEADERS });
    }

    if (url.pathname !== "/metadata/describe" && url.pathname !== "/") {
      return new Response("Not found", { status: 404, headers: CORS_HEADERS });
    }

    let payload;
    try {
      const text = await request.text();
      if (!text) throw new Error("Empty body");
      payload = JSON.parse(text);
    } catch (e) {
      return new Response(`Bad JSON body: ${e?.message || e}`, {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    // Support a couple of key spellings to reduce user error
    const instanceUrl = payload.instanceUrl || payload.instance_url;
    const accessToken = payload.accessToken || payload.access_token;
    const apiVersion = String(payload.apiVersion || payload.api_version || "65.0");

    if (!instanceUrl || !accessToken) {
      return new Response("Missing instanceUrl or accessToken", {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    const soapEndpoint = `${String(instanceUrl).replace(/\/+$/, "")}/services/Soap/m/${apiVersion}`;

    const envelope = `<?xml version="1.0" encoding="utf-8"?>
<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/">
  <env:Header>
    <SessionHeader xmlns="http://soap.sforce.com/2006/04/metadata">
      <sessionId>${escapeXml(accessToken)}</sessionId>
    </SessionHeader>
  </env:Header>
  <env:Body>
    <describeMetadata xmlns="http://soap.sforce.com/2006/04/metadata">
      <asOfVersion>${escapeXml(apiVersion)}</asOfVersion>
    </describeMetadata>
  </env:Body>
</env:Envelope>`;

    let sfResp;
    try {
      sfResp = await fetch(soapEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          "SOAPAction": "",
        },
        body: envelope,
      });
    } catch (e) {
      return new Response(`Failed to reach Salesforce SOAP endpoint: ${e?.message || e}`, {
        status: 502,
        headers: { ...CORS_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    const xml = await sfResp.text();

    if (!sfResp.ok) {
      return new Response(xml.slice(0, 8000), {
        status: sfResp.status,
        headers: { ...CORS_HEADERS, "Content-Type": "text/xml; charset=utf-8" },
      });
    }

    const parsed = parseDescribeMetadataResponse(xml);

    return new Response(JSON.stringify(parsed), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" },
    });
  },
};

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Very small, dependency-free parser.
// It extracts describeMetadataResult metadataObjects from the SOAP response.
function parseDescribeMetadataResponse(xml) {
  const out = {
    metadataObjects: [],
    raw: undefined,
  };

  // Fast fail if Salesforce returned a SOAP Fault
  if (xml.includes("<faultcode>") || xml.includes(":Fault")) {
    out.error = "SOAP Fault";
    out.raw = xml.slice(0, 8000);
    return out;
  }

  const blocks = xml.match(/<metadataObjects>[\s\S]*?<\/metadataObjects>/g) || [];
  out.metadataObjects = blocks.map((b) => {
    const xmlName = pickTag(b, "xmlName");
    const directoryName = pickTag(b, "directoryName");
    const suffix = pickTag(b, "suffix");
    const inFolder = pickTag(b, "inFolder") === "true";
    const readOnly = pickTag(b, "readOnly") === "true";

    return {
      xmlName,
      directoryName,
      suffix,
      inFolder,
      readOnly,
    };
  }).filter((x) => !!x.xmlName);

  return out;
}

function pickTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m ? decodeXml(m[1].trim()) : "";
}

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
