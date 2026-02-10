# SFDC Deployment Tracker (Web) — Auth fix + restored Metadata inventory

This bundle restores the **Metadata inventory** tab and fixes repeated `HTTP 401: Session expired or invalid` by adding automatic `refresh_token` refresh.

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
