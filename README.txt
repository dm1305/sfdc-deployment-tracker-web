SFDC Deployment Tracker (Web) - Updated build

What changed in this drop:
A) Deployments -> click a row to fetch richer DeployRequest details (field availability varies by org).
B) Apex tests tab -> shows recent ApexTestRun entries, with heuristic correlation to selected deployment.
C) Insights -> duration percentiles + delay/failure taxonomy from current table rows.

Setup:
1) Edit app.js CONFIG:
   - CLIENT_ID: Connected App consumer key
   - LOGIN_DOMAIN: your My Domain base URL (e.g. https://foo--dev.sandbox.my.salesforce.com)
   - API_VERSION: use the latest from /services/data if desired

2) Commit/push to GitHub Pages repo.

View:
- https://<your-username>.github.io/<repo-name>/

Notes:
- Tooling API objects/fields differ by org and permissions. The app DESCRIBEs objects and only selects fields that exist.
- Correlation to deployments is time-window based; Salesforce does not always provide a hard link from a DeployRequest to a specific test run.
