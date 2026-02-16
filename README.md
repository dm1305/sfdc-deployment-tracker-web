# SFDC Deployment Tracker (Web)

This repo is a static (GitHub Pages) Salesforce “Workbench-lite”:

- Deployments / package history
- A “Capabilities” matrix (SOQL / Tooling / Metadata API / REST)
- **Metadata Types**: lists *all* metadata types available in your org via the Metadata API `describeMetadata()` call.

## Why you were seeing those log lines
- `... query failed (HTTP 401): Session expired or invalid`  
  Your **access_token expired** while auto-refresh/polling was running.
  The previous app version did not refresh tokens, so every query started failing.

- `Package history: click Discover objects.`  
  Informational: that tab is a scaffold until you click **Discover objects**.

## What the fix does
On any API call that returns **401**:
1) it calls `POST /services/oauth2/token` with `grant_type=refresh_token`  
2) if refresh succeeds it retries the failed call once  
3) if refresh fails it stops polling and shows a banner prompting re-login

## Config reminders
- `LOGIN_DOMAIN` must be your **My Domain**: `https://<mydomain>.my.salesforce.com`  
  (Not `salesforce-setup.com`.)

## Metadata API proxy (required)
GitHub Pages cannot call the Salesforce **Metadata SOAP API** directly because Salesforce does not allow browser CORS to the SOAP endpoints.

This repo includes a Cloudflare Worker proxy under `cf-worker/worker.js`.

1) Deploy the Worker in Cloudflare
2) Confirm the Worker URL returns `OK` on a browser GET (health check)
3) In the app, set the **Proxy URL** to that Worker base URL (example: `https://httphandler.example.workers.dev`)
4) Go to **Metadata Types** and click **Refresh types**.

If the proxy is not configured, the Metadata columns in Capabilities will show ❌ and the type list will not load.

Security note: do not paste access tokens into screenshots or commits. If you accidentally did, revoke the session / rotate the Connected App secret.
