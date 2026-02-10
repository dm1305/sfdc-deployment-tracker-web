// app.js - minimal wiring
(function () {
  function log(msg) {
    const el = document.getElementById("logPre");
    if (!el) return;
    el.textContent = `[${new Date().toISOString()}] ${msg}\n` + el.textContent;
  }

  document.addEventListener("DOMContentLoaded", async () => {
    if (!window.Auth) return;
    await Auth.init();

    document.getElementById("loginBtn").addEventListener("click", () => {
      Auth.login();
      log("Login clicked");
    });

    document.getElementById("logoutBtn").addEventListener("click", () => {
      Auth.logout();
      log("Logout clicked");
    });

    document.getElementById("refreshBtn").addEventListener("click", () => {
      log("Refresh clicked (stub)");
    });

    if (Auth.isLoggedIn()) {
      Auth.setStatus("Connected");
    }
  });
})();
