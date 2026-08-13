export const SECRET_BROKER_HTML = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="robots" content="noindex,nofollow">
  <title>Connections · SUMMING</title>
  <link rel="stylesheet" href="/connections/app.css">
</head>
<body>
  <main>
    <div class="brand"><span class="mark">S</span><span>SUMMING CONNECTIONS</span></div>
    <section class="card">
      <div id="state" class="eyebrow">ПРОВЕРКА ДОСТУПА</div>
      <h1 id="title">Подключение</h1>
      <p id="description">Загружаем одноразовый запрос…</p>
      <div id="details" class="details"></div>
      <form id="secretForm" class="hidden">
        <div id="fields"></div>
        <div id="rawApproval" class="warning hidden">
          <strong>RAW ACCESS</strong>
          <p>Код проекта получит credential и технически сможет прочитать, вывести или отправить его наружу.</p>
          <label for="rawGrant">Разрешение</label>
          <select id="rawGrant">
            <option value="once">Только для одного job</option>
            <option value="project">Для последующих job проекта</option>
          </select>
          <label class="confirm"><input id="rawConfirm" type="checkbox"> Я явно разрешаю проекту получить долгоживущий credential.</label>
        </div>
        <button type="submit">Сохранить подключение</button>
      </form>
      <button id="grantButton" class="warning-button hidden">Выдать новое raw-разрешение без замены ключа</button>
      <button id="oauthButton" class="hidden">Продолжить через OAuth</button>
      <button id="revokeButton" class="danger hidden">Отключить и отозвать</button>
      <p class="note">Значение не передаётся в Telegram или Codex и после сохранения не показывается.</p>
    </section>
  </main>
  <script src="/connections/app.js"></script>
</body>
</html>`;

export const SECRET_BROKER_CSS = `
:root{color-scheme:dark;--bg:#0a0a0c;--surface:#151519;--surface2:#1d1d22;--border:#34343b;--text:#eeeef1;--muted:#9999a4;--accent:#ff2e6b;--ok:#8ed6bd;--danger:#ff759b;font-family:Inter,ui-sans-serif,system-ui,sans-serif}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 80% 0,#371020 0,transparent 33%),var(--bg);color:var(--text)}main{width:min(680px,100%);margin:0 auto;padding:32px 18px 60px}.brand{display:flex;align-items:center;gap:10px;font-size:11px;letter-spacing:.14em;color:var(--muted);margin-bottom:24px}.mark{display:grid;place-items:center;width:34px;height:34px;border-radius:50%;background:var(--accent);color:white;font-weight:800;font-size:18px}.card{padding:26px;border:1px solid var(--border);border-radius:12px;background:color-mix(in srgb,var(--surface) 94%,transparent);box-shadow:0 22px 70px #0008}.eyebrow{font-size:10px;letter-spacing:.14em;color:var(--accent);font-weight:700}h1{font-size:28px;margin:10px 0 8px}p{color:var(--muted);line-height:1.55}.details{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:20px 0}.detail{padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--surface2)}.detail span,.detail strong{display:block}.detail span{font-size:9px;color:var(--muted);text-transform:uppercase}.detail strong{margin-top:6px;font-size:13px;overflow-wrap:anywhere}.field{margin:14px 0}.field label{display:block;font-size:12px;margin-bottom:7px}.field input{width:100%;border:1px solid var(--border);border-radius:8px;background:#0f0f12;color:var(--text);padding:12px;font:14px ui-monospace,monospace}.field input:focus{outline:2px solid color-mix(in srgb,var(--accent) 45%,transparent);border-color:var(--accent)}.warning{margin:18px 0;padding:14px;border:1px solid #b77b35;border-radius:8px;background:#2b1d0e}.warning strong{color:#ffbd70;font-size:11px;letter-spacing:.12em}.warning p{color:#efcda8;font-size:12px}.warning select{width:100%;padding:10px;background:#15100b;color:var(--text);border:1px solid #79552c;border-radius:7px}.confirm{display:flex;gap:9px;align-items:flex-start;margin-top:12px;color:#f3d5b3;font-size:12px;line-height:1.4}.confirm input{margin-top:2px}.warning-button{background:#8b5520}button{width:100%;border:0;border-radius:8px;background:var(--accent);color:white;font-weight:750;padding:13px 16px;margin-top:12px;cursor:pointer}button:disabled{opacity:.5;cursor:wait}button.danger{background:transparent;border:1px solid var(--danger);color:var(--danger)}.note{font-size:11px;margin:18px 0 0}.hidden{display:none!important}.success{color:var(--ok)}.error{color:var(--danger)}@media(max-width:520px){main{padding-top:20px}.card{padding:20px}.details{grid-template-columns:1fr}h1{font-size:23px}}
`;

export const SECRET_BROKER_JS = `(()=>{
  const $=(id)=>document.getElementById(id);
  const state={ticket:"",session:null};
  const fragment=new URLSearchParams(location.hash.slice(1));
  state.ticket=fragment.get("ticket")||sessionStorage.getItem("summingConnectionTicket")||"";
  if(state.ticket){sessionStorage.setItem("summingConnectionTicket",state.ticket);history.replaceState(null,"",location.pathname)}
  const api=async(path,options={})=>{const response=await fetch(path,{...options,headers:{authorization:"Bearer "+state.ticket,...(options.headers||{})}});const text=await response.text();let value;try{value=text?JSON.parse(text):null}catch{value={error:text}}if(!response.ok)throw new Error(value&&value.error||"HTTP "+response.status);return value};
  const showError=(error)=>{$("state").textContent="ОШИБКА";$("state").className="eyebrow error";$("title").textContent="Подключение не выполнено";$("description").textContent=error.message||String(error);$("secretForm").classList.add("hidden");$("oauthButton").classList.add("hidden");$("grantButton").classList.add("hidden");$("revokeButton").classList.add("hidden")};
  const detail=(name,value)=>"<div class='detail'><span>"+name+"</span><strong>"+String(value).replace(/[&<>'\"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'\"':"&quot;"}[c]))+"</strong></div>";
  async function load(){if(!state.ticket)throw new Error("Одноразовый ticket отсутствует. Откройте Connections из Telegram ещё раз.");state.session=await api("/connections/api/session");const i=state.session.integration,c=state.session.connection,ready=c&&c.status==="connected"&&(i.mode!=="raw"||c.rawGrant);$("state").textContent=ready?"ГОТОВО К ЗАПУСКУ":c&&c.status==="connected"?"НУЖНО RAW-РАЗРЕШЕНИЕ":"ТРЕБУЕТСЯ ДОСТУП";$("state").className="eyebrow "+(ready?"success":"");$("title").textContent=i.id+" · "+i.provider;$("description").textContent=i.mode==="gateway"?"SUMMING выдаст только ограниченную capability.":i.mode==="lease"?"Runtime получит только временный access token; refresh token останется в брокере.":"Выбран raw-режим для совместимости со стандартным SDK.";$("details").innerHTML=detail("Проект",state.session.projectId)+detail("Окружение",i.environment)+detail("Режим",i.mode)+detail("Действия",i.actions.join(", "));if(c&&c.status==="connected"){$("revokeButton").classList.remove("hidden")}if(i.auth==="api_key"){$("fields").innerHTML=i.secrets.map(field=>"<div class='field'><label>"+field.name+"</label><input required autocomplete='off' spellcheck='false' type='password' name='"+field.name+"'></div>").join("");$("secretForm").classList.remove("hidden");if(i.mode==="raw"){$("rawApproval").classList.remove("hidden");if(c&&c.status==="connected")$("grantButton").classList.remove("hidden")}}else if(i.auth==="oauth2"){$("oauthButton").classList.remove("hidden")}else{$("description").textContent="Для этой capability не требуются credentials."}}
  $("secretForm").addEventListener("submit",async(event)=>{event.preventDefault();const button=event.currentTarget.querySelector("button"),raw=state.session.integration.mode==="raw";if(raw&&!$("rawConfirm").checked){$("description").textContent="Сначала подтвердите явное raw-разрешение.";return}button.disabled=true;try{const values={};new FormData(event.currentTarget).forEach((value,key)=>values[key]=String(value));await api("/connections/api/secret",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({values,...(raw?{grant:$("rawGrant").value}:{})})});sessionStorage.removeItem("summingConnectionTicket");$("state").textContent="ГОТОВО";$("state").className="eyebrow success";$("description").textContent=raw?"Секрет зашифрован; raw-доступ разрешён в выбранном объёме.":"Секрет зашифрован и подключение готово.";$("secretForm").classList.add("hidden");$("grantButton").classList.add("hidden");$("revokeButton").classList.add("hidden")}catch(error){showError(error)}finally{button.disabled=false}});
  $("grantButton").addEventListener("click",async()=>{if(!$("rawConfirm").checked){$("description").textContent="Сначала подтвердите явное raw-разрешение.";return}const button=$("grantButton");button.disabled=true;try{await api("/connections/api/raw-grant",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({grant:$("rawGrant").value})});sessionStorage.removeItem("summingConnectionTicket");$("state").textContent="ГОТОВО";$("state").className="eyebrow success";$("description").textContent="Raw-доступ выдан в выбранном объёме.";$("secretForm").classList.add("hidden");button.classList.add("hidden");$("revokeButton").classList.add("hidden")}catch(error){showError(error)}finally{button.disabled=false}});
  $("oauthButton").addEventListener("click",async()=>{const button=$("oauthButton");button.disabled=true;try{const result=await api("/connections/api/oauth/start",{method:"POST"});location.assign(result.authorizationUrl)}catch(error){showError(error);button.disabled=false}});
  $("revokeButton").addEventListener("click",async()=>{if(!confirm("Отозвать подключение? Следующие run не получат доступ."))return;const button=$("revokeButton");button.disabled=true;try{await api("/connections/api/revoke",{method:"POST"});sessionStorage.removeItem("summingConnectionTicket");$("state").textContent="ОТОЗВАНО";$("state").className="eyebrow";$("description").textContent="Ciphertext удалён. Для повторного подключения откройте новый ticket.";$("secretForm").classList.add("hidden");$("oauthButton").classList.add("hidden");button.classList.add("hidden")}catch(error){showError(error)}});
  load().catch(showError);
})();`;
