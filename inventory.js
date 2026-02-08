const TOKEN_KEY = "sf_token";
const API_VERSION_KEY = "sf_api_version";
const DEFAULT_API_VERSION = "65.0";

function $(id){return document.getElementById(id);}
function getApiVersion(){return localStorage.getItem(API_VERSION_KEY)||DEFAULT_API_VERSION;}

function log(msg){
  $("log").textContent = `[${new Date().toISOString()}] ${msg}\n` + $("log").textContent;
}

function loadToken(){
  const r = localStorage.getItem(TOKEN_KEY);
  return r ? JSON.parse(r) : null;
}

async function sfTooling(q){
  const t = loadToken();
  if(!t){log("Not logged in");return null;}
  const v = getApiVersion();
  const url = `${t.instance_url}/services/data/v${v}/tooling/query?q=${encodeURIComponent(q)}`;
  const r = await fetch(url,{headers:{Authorization:`Bearer ${t.access_token}`}});
  const j = await r.json().catch(()=>null);
  if(!r.ok){log(`Error ${r.status}`);return null;}
  return j.records||[];
}

let rows=[];

async function scan(){
  rows=[];
  const soql = `
    SELECT Id, Name, LastModifiedDate, LastModifiedBy.Name
    FROM ApexClass ORDER BY LastModifiedDate DESC LIMIT 200
  `;
  const recs = await sfTooling(soql);
  if(!recs) return;

  rows = recs.map(r=>({
    type:"ApexClass",
    name:r.Name,
    mod:r.LastModifiedDate,
    user:r.LastModifiedBy?.Name,
    id:r.Id
  }));

  render();
  log(`Scan complete (${rows.length})`);
}

function render(){
  const tb = $("tbody");
  tb.innerHTML = rows.map(r=>`
    <tr>
      <td>${r.type}</td>
      <td>${r.name}</td>
      <td>${r.mod}</td>
      <td>${r.user||"—"}</td>
      <td>${r.id}</td>
    </tr>
  `).join("");
}

function download(name, text){
  const a=document.createElement("a");
  a.href=URL.createObjectURL(new Blob([text]));
  a.download=name;
  a.click();
}

$("scanBtn").onclick=scan;
$("csvBtn").onclick=()=>download("inventory.csv",
  ["Type,Name,LastModified,User,Id",
   ...rows.map(r=>`${r.type},${r.name},${r.mod},${r.user},${r.id}`)].join("\n")
);
$("jsonBtn").onclick=()=>download("inventory.json",JSON.stringify(rows,null,2));

(function init(){
  $("apiVersionSelect").value=getApiVersion();
  $("apiVersionSelect").onchange=e=>{
    localStorage.setItem(API_VERSION_KEY,e.target.value);
    log(`API version set to v${e.target.value}`);
  };
})();
