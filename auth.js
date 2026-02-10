// auth.js - minimal, stable OAuth shell (no top-level await)
(function () {
  const Auth = {};
  const keys = { token: "sf_access_token" };
  Auth.keys = keys;

  Auth.init = function () {
    return Promise.resolve();
  };

  Auth.isLoggedIn = function () {
    return !!localStorage.getItem(keys.token);
  };

  Auth.login = function () {
    localStorage.setItem(keys.token, "DUMMY");
    Auth.setStatus("Connected");
  };

  Auth.logout = function () {
    localStorage.removeItem(keys.token);
    Auth.setStatus("Not connected");
  };

  Auth.setStatus = function (txt) {
    const el = document.getElementById("statusPill");
    if (el) el.textContent = txt;
  };

  Auth.sfFetch = async function () {
    throw new Error("Salesforce fetch not wired yet");
  };

  window.Auth = Auth;
})();
