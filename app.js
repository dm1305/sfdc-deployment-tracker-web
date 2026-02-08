<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>SFDC Deployment Tracker (Web)</title>

  <style>
    body {
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
      margin: 24px;
      line-height: 1.4;
    }

    h1 {
      margin: 0 0 12px;
    }

    .row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 12px 0;
    }

    button {
      padding: 8px 12px;
      cursor: pointer;
      border-radius: 6px;
      border: 1px solid #ccc;
      background: #f7f7f7;
    }

    button:hover {
      background: #eee;
    }

    input {
      padding: 8px;
      border-radius: 6px;
      border: 1px solid #ccc;
      min-width: 360px;
    }

    pre {
      background: #111;
      color: #eee;
      padding: 12px;
      border-radius: 8px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      margin-top: 16px;
    }

    .hint {
      color: #555;
      font-size: 14px;
      margin-top: 8px;
    }
  </style>
</head>

<body>
  <h1>SFDC Deployment Tracker (Web)</h1>

  <!-- Auth + basic info -->
  <div class="row">
    <button id="loginBtn">Login</button>
    <button id="logoutBtn">Logout</button>
    <button id="tokenBtn">Token summary</button>
    <button id="meBtn">Call /userinfo</button>
  </div>

  <!-- Deployment overview -->
  <div class="row">
    <button id="deploymentsBtn">List deployments</button>
    <button id="activeDeploymentsBtn">List active deployments</button>
  </div>

  <!-- Metadata deploy details -->
  <div class="row">
    <input
      id="metadataDeployIdInput"
      placeholder="Paste Metadata deploy id (async id)"
    />
    <button id="deployDetailsBtn">
      Deploy details (components)
    </button>
  </div>

  <div class="hint">
    Flow:
    <ol>
      <li>Click <b>Login</b> and authenticate with Salesforce.</li>
      <li>Use <b>List deployments</b> to see recent org deployments.</li>
      <li>If you have a Metadata deploy async id, paste it above and click
          <b>Deploy details (components)</b> to see component names, types, counts,
          and failures.</li>
    </ol>
  </div>

  <pre id="status">Not logged in</pre>

  <script src="app.js"></script>
</body>
</html>
