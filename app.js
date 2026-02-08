const CLIENT_ID = "3MVG9YFqzc_KnL.wada6.pbgp4zDPc8T6u6uR6srOVo1fS7XOD_kHsrDH_QurZzXeEgwzWBU365_xXQ54mMNn";
const LOGIN_DOMAIN = "https://gearsetcom-4bf-dev-ed.develop.my.salesforce.com";

const TOKEN_KEY = "sf_token";
const API_VERSION_KEY = "sf_api_version";
const DEFAULT_API_VERSION = "65.0";

function $(id){ return document.getElementById(id); }

function getApiVersion(){
  return localStorage.getItem(API_VERSION_KEY) || DEFAULT_API_VERSION;
}
function setApiVersion(v){
  localStorage.setItem(API_VERSION_KEY, v);
  $("apiPill").textContent = `v${v}`;
  log(`API version set to v${v}`);
}

function log(msg){
  const el = $("logPre");
  el.textContent = `[${new Date().toISOString()}] ${msg}\n` + el.textContent;
}

function loadToken(){
  const raw = localStorage.getItem(TOKEN_KEY);
  return raw ? JSON.parse(raw) : null;
}

function saveToken(t){ localStorage.setItem(TOKEN_KEY, JSON.stringify(t)); }
function clearToken(){ localStorage.removeItem(TOKEN_KEY); }

async function sfFetch(path){
  const t = loadToken();
  if(!t?.access_token){
    log("Not logged in.");
    return;
  }
  const apiV = getApiVersion();
  const url = `${t.instance_url}/services/data/v${apiV}${path}`;
  const r = await fetch(url,{headers:{Authorization:`Bearer ${t.access_token}`}});
  const j = await r.json().catch(()=>null);
  if(!r.ok){
    log(`SF error ${r.status}: ${JSON.stringify(j)}`);
    return null;
  }
  return j;
}

async function login(){
  const redirect = location.origin + location.pathname;
  const u = new URL(`${LOGIN_DOMAIN}/services/oauth2/authorize`);
  u.searchParams.set("response_type","token");
  u.searchParams.set("client_id",CLIENT_ID);
  u.searchParams.set("redirect_uri",redirect);
  window.location.href = u;
}

function handleRedirect(){
  if(location.hash.includes("access_token")){
    const p = new URLSearchParams(location.hash.slice(1));
    const token = Object.fromEntries(p.entries());
    saveToken(token);
    history.replaceState({},document.title,location.pathname);
    $("orgPill").textContent = token.instance_url;
    log("Logged in.");
  }
}

function logout(){
  clearToken();
  log("Logged out.");
}

(function init(){
  handleRedirect();

  const sel = $("apiVersionSelect");
  sel.value = getApiVersion();
  $("apiPill").textContent = `v${getApiVersion()}`;

  sel.addEventListener("change",()=>setApiVersion(sel.value));
  $("loginBtn").onclick = login;
  $("logoutBtn").onclick = logout;
  $("refreshBtn").onclick = ()=>log("Refresh clicked");
  $("clearStorageBtn").onclick = ()=>{localStorage.clear();location.reload();};

  const t = loadToken();
  if(t?.instance_url) $("orgPill").textContent = t.instance_url;
})();
