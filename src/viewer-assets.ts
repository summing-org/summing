export const VIEWER_HTML = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#111714">
  <title>Summate Project Viewer</title>
  <link rel="stylesheet" href="/app.css">
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <script src="/app.js" defer></script>
</head>
<body>
  <div id="app">
    <header class="topbar">
      <div class="brand"><span class="brand-mark">Σ</span><span>Summate</span></div>
      <div class="repo-title">
        <strong id="projectName">Project Viewer</strong>
        <span id="repoMeta">подключение…</span>
      </div>
      <button id="refreshButton" class="icon-button" aria-label="Обновить">↻</button>
    </header>
    <nav class="tabs" aria-label="Разделы">
      <button data-tab="files" class="active">Файлы</button>
      <button data-tab="changes">Изменения <span id="changeBadge" class="badge hidden">0</span></button>
      <button data-tab="history">История</button>
      <button data-tab="runs">Runs</button>
      <button data-tab="launch">Запуск</button>
    </nav>
    <main>
      <section id="filesPanel" class="panel split-panel active">
        <aside class="tree-pane">
          <label class="search"><span>⌕</span><input id="fileSearch" placeholder="Найти файл" autocomplete="off"></label>
          <div id="fileTree" class="file-tree"><div class="empty">Загрузка дерева…</div></div>
        </aside>
        <article class="content-pane">
          <div class="pane-heading"><span id="filePath">Выберите файл</span><span id="fileSize"></span></div>
          <pre id="fileContent" class="code-view"><code>Дерево проекта появится слева.</code></pre>
        </article>
      </section>
      <section id="changesPanel" class="panel">
        <div class="section-heading"><div><h2>Рабочие изменения</h2><p>Tracked и untracked файлы относительно HEAD.</p></div><button id="reloadDiff" class="secondary">Обновить</button></div>
        <pre id="workingDiff" class="code-view diff-view"><code>Откройте вкладку, чтобы загрузить diff.</code></pre>
      </section>
      <section id="historyPanel" class="panel two-column">
        <aside><div class="section-heading compact"><div><h2>Коммиты</h2><p>Последние ревизии ветки</p></div></div><div id="commitList" class="card-list"></div></aside>
        <article><div class="pane-heading"><span id="commitDiffTitle">Выберите коммит</span></div><pre id="commitDiff" class="code-view diff-view"><code></code></pre></article>
      </section>
      <section id="runsPanel" class="panel two-column">
        <aside><div class="section-heading compact"><div><h2>Изменения по run</h2><p>Снимок до и после работы Codex</p></div></div><div id="runList" class="card-list"></div></aside>
        <article><div class="pane-heading"><span id="runDiffTitle">Выберите run</span></div><pre id="runDiff" class="code-view diff-view"><code></code></pre></article>
      </section>
      <section id="launchPanel" class="panel launch-panel">
        <div class="section-heading"><div><h2>Сборка и запуск</h2><p>Runner получает неизменяемый Git snapshot. Live-запуск доступен только для чистого HEAD.</p></div></div>
        <div class="actions-grid">
          <button data-action="build"><strong>Build</strong><span>Собрать image и прогреть cache</span></button>
          <button data-action="validate"><strong>Validate</strong><span>Проверить production config без сети</span></button>
          <button data-action="dry-run"><strong>Dry run</strong><span>RSS + OpenAI, без картинок и Telegram</span></button>
          <button data-action="run" class="danger"><strong>Live run</strong><span>Отправить публикации в Telegram</span></button>
        </div>
        <div class="section-heading compact jobs-heading"><div><h2>Очередь runner</h2><p id="runnerStatus">Проверка…</p></div><button id="reloadJobs" class="secondary">Обновить</button></div>
        <div id="jobList" class="card-list jobs"></div>
        <pre id="jobLog" class="code-view log-view"><code>Выберите запуск, чтобы увидеть лог.</code></pre>
      </section>
    </main>
    <div id="toast" role="status" aria-live="polite"></div>
  </div>
</body>
</html>`;

export const VIEWER_CSS = `
:root{color-scheme:dark;--bg:#0d1210;--surface:#141b17;--surface2:#1a231e;--border:#29362f;--text:#eef5f0;--muted:#91a398;--accent:#b9ed6b;--accent2:#6be3b4;--danger:#ff816f;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);min-height:100vh;min-height:100dvh}button,input{font:inherit}.topbar{height:64px;display:flex;align-items:center;gap:18px;padding:0 20px;border-bottom:1px solid var(--border);background:rgba(13,18,16,.92);position:sticky;top:0;z-index:10;backdrop-filter:blur(18px)}.brand{display:flex;align-items:center;gap:9px;font-weight:700;letter-spacing:.02em}.brand-mark{display:grid;place-items:center;width:30px;height:30px;border:1px solid #405347;border-radius:9px;color:var(--accent);background:#18211c}.repo-title{min-width:0;display:flex;flex:1;flex-direction:column}.repo-title strong{font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.repo-title span{font:11px var(--mono);color:var(--muted);margin-top:3px}.icon-button,.secondary{border:1px solid var(--border);background:var(--surface2);color:var(--text);border-radius:9px;cursor:pointer}.icon-button{width:36px;height:36px;font-size:21px}.tabs{height:46px;display:flex;align-items:stretch;gap:2px;padding:0 14px;border-bottom:1px solid var(--border);overflow-x:auto;background:var(--surface)}.tabs button{position:relative;border:0;background:none;color:var(--muted);padding:0 14px;white-space:nowrap;cursor:pointer;font-size:13px}.tabs button.active{color:var(--text)}.tabs button.active:after{content:"";position:absolute;left:10px;right:10px;bottom:0;height:2px;background:var(--accent);border-radius:2px}.badge{display:inline-grid;place-items:center;min-width:18px;height:18px;padding:0 5px;margin-left:4px;border-radius:9px;background:#35452d;color:var(--accent);font:10px var(--mono)}.hidden{display:none!important}main{height:calc(100dvh - 110px)}.panel{display:none;height:100%;overflow:auto}.panel.active{display:block}.split-panel.active,.two-column.active{display:grid}.split-panel{grid-template-columns:minmax(240px,28%) 1fr}.two-column{grid-template-columns:minmax(280px,34%) 1fr}.tree-pane,.two-column>aside{border-right:1px solid var(--border);background:var(--surface);overflow:auto}.content-pane,.two-column>article{min-width:0;overflow:auto}.search{height:50px;display:flex;align-items:center;gap:8px;padding:0 14px;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--surface);z-index:2}.search span{color:var(--muted);font-size:20px}.search input{width:100%;border:0;outline:0;background:transparent;color:var(--text);font-size:13px}.file-tree{padding:9px 8px 30px}.file-item{width:100%;border:0;background:transparent;color:#c9d5ce;text-align:left;padding:7px 9px;border-radius:7px;font:12px var(--mono);cursor:pointer;display:flex;gap:7px;align-items:center}.file-item:hover,.file-item.active{background:var(--surface2);color:var(--text)}.file-item .path{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.file-item .dot{width:6px;height:6px;border-radius:50%;background:#53635a;flex:none}.file-item.changed .dot{background:#f5c96d}.file-item.untracked .dot{background:var(--accent2)}.empty{padding:28px 16px;text-align:center;color:var(--muted);font-size:13px}.pane-heading{height:50px;display:flex;align-items:center;justify-content:space-between;gap:20px;padding:0 18px;border-bottom:1px solid var(--border);background:var(--surface);position:sticky;top:0;z-index:2;font:12px var(--mono);color:#c9d5ce}.pane-heading span:last-child{color:var(--muted)}.code-view{margin:0;padding:18px 20px 60px;min-height:calc(100% - 50px);overflow:auto;background:var(--bg);font:12px/1.62 var(--mono);tab-size:2;white-space:pre;color:#dce8e0}.code-view code{display:block}.diff-line{display:block;margin:0 -20px;padding:0 20px;min-height:1.62em}.diff-line.add{color:#b9edc4;background:#173222}.diff-line.del{color:#ffb1a6;background:#351c1b}.diff-line.hunk{color:#9fc5ff;background:#172538}.diff-line.meta{color:#d9c578}.section-heading{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:24px 24px 16px}.section-heading.compact{padding:18px}.section-heading h2{font-size:17px;margin:0 0 5px}.section-heading p{font-size:12px;color:var(--muted);margin:0}.secondary{padding:8px 12px;font-size:12px}.card-list{padding:0 12px 24px}.card{display:block;width:100%;text-align:left;border:1px solid transparent;background:transparent;color:var(--text);border-radius:10px;padding:11px 12px;cursor:pointer;margin-bottom:4px}.card:hover,.card.active{background:var(--surface2);border-color:var(--border)}.card strong{display:block;font:12px var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.card span{display:block;color:var(--muted);font-size:11px;margin-top:5px}.launch-panel{padding-bottom:60px}.actions-grid{display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:12px;padding:0 24px}.actions-grid button{min-height:104px;text-align:left;padding:16px;border:1px solid var(--border);border-radius:13px;background:var(--surface);color:var(--text);cursor:pointer}.actions-grid button:hover{border-color:#5f7a69;background:var(--surface2)}.actions-grid button.danger:hover{border-color:var(--danger)}.actions-grid strong,.actions-grid span{display:block}.actions-grid strong{font-size:14px;margin-bottom:8px}.actions-grid span{color:var(--muted);font-size:11px;line-height:1.4}.jobs-heading{margin-top:16px}.jobs{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:6px;padding:0 24px 18px}.jobs .card{border-color:var(--border);background:var(--surface)}.status{float:right;text-transform:uppercase;font-size:9px!important;letter-spacing:.08em}.status.completed{color:var(--accent2)}.status.failed{color:var(--danger)}.status.running{color:#f5c96d}.log-view{margin:0 24px;border:1px solid var(--border);border-radius:12px;min-height:220px;max-height:420px;padding:16px}.log-view .diff-line{margin:0;padding:0}.dirty{color:#f5c96d!important}.clean{color:var(--accent2)!important}#toast{position:fixed;left:50%;bottom:22px;transform:translate(-50%,20px);opacity:0;pointer-events:none;padding:10px 14px;border:1px solid var(--border);border-radius:10px;background:#202c25;color:var(--text);font-size:12px;transition:.2s;z-index:30;box-shadow:0 12px 40px #0008}#toast.show{opacity:1;transform:translate(-50%,0)}
@media(max-width:760px){.brand span:last-child{display:none}.topbar{padding:0 12px;gap:12px}.tabs{padding:0 4px}.tabs button{padding:0 10px}.split-panel,.two-column{grid-template-columns:1fr}.tree-pane,.two-column>aside{border-right:0;border-bottom:1px solid var(--border);max-height:42dvh}.content-pane,.two-column>article{min-height:45dvh}.split-panel{overflow:auto}.split-panel .content-pane{overflow:visible}.actions-grid{grid-template-columns:1fr 1fr;padding:0 14px}.section-heading{padding-left:14px;padding-right:14px}.jobs{padding-left:14px;padding-right:14px}.log-view{margin:0 14px}.code-view{font-size:11px;padding-left:14px;padding-right:14px}.diff-line{margin-left:-14px;margin-right:-14px;padding-left:14px;padding-right:14px}}
`;

export const VIEWER_JS = `
(() => {
  const state={conversation:"",session:null,tree:[],tab:"files",token:"",initData:""};
  const $=(id)=>document.getElementById(id);
  const tg=window.Telegram&&window.Telegram.WebApp;
  if(tg){tg.ready();tg.expand();state.initData=tg.initData||"";}
  const hash=new URLSearchParams(location.hash.slice(1));
  if(hash.get("token")){sessionStorage.setItem("summateViewerToken",hash.get("token"));history.replaceState(null,"",location.pathname+location.search);}
  state.token=sessionStorage.getItem("summateViewerToken")||"";
  const query=new URLSearchParams(location.search);
  state.conversation=query.get("conversation")||(tg&&tg.initDataUnsafe&&tg.initDataUnsafe.start_param)||"";
  const headers=()=>state.initData?{"x-telegram-init-data":state.initData}:state.token?{authorization:"Bearer "+state.token}:{};
  const api=async(path,options={})=>{const response=await fetch(path,{...options,headers:{...headers(),...(options.headers||{})}});const body=await response.text();let value;try{value=body?JSON.parse(body):null}catch{value=body}if(!response.ok)throw new Error(value&&value.error||body||("HTTP "+response.status));return value};
  const esc=(value)=>String(value).replace(/[&<>]/g,(char)=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[char]));
  const toast=(message)=>{const el=$("toast");el.textContent=message;el.classList.add("show");clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.classList.remove("show"),2600)};
  const renderDiff=(element,value)=>{if(!value){element.innerHTML="<code><span class='empty'>Изменений нет.</span></code>";return}element.innerHTML="<code>"+value.split("\n").map(line=>{let kind="";if(line.startsWith("+++ ")||line.startsWith("--- ")||line.startsWith("diff ")||line.startsWith("index "))kind="meta";else if(line.startsWith("+"))kind="add";else if(line.startsWith("-"))kind="del";else if(line.startsWith("@@"))kind="hunk";return "<span class='diff-line "+kind+"'>"+esc(line)+"</span>"}).join("")+"</code>"};
  const setTab=(name)=>{state.tab=name;document.querySelectorAll(".tabs button").forEach(button=>button.classList.toggle("active",button.dataset.tab===name));document.querySelectorAll(".panel").forEach(panel=>panel.classList.remove("active"));$(name+"Panel").classList.add("active");if(name==="changes")loadWorkingDiff();if(name==="history")loadCommits();if(name==="runs")loadRuns();if(name==="launch")loadJobs()};
  document.querySelectorAll(".tabs button").forEach(button=>button.addEventListener("click",()=>setTab(button.dataset.tab)));
  const sessionUrl=()=>"/api/viewer/session?conversation="+encodeURIComponent(state.conversation);
  async function loadSession(){if(!state.conversation)throw new Error("Conversation не указан. Откройте viewer из команды /files.");state.session=await api(sessionUrl());$("projectName").textContent=state.session.project.name;const repo=state.session.repository;$("repoMeta").textContent=repo.branch+" · "+repo.shortHead+(repo.remote?" · origin":" · local only");$("repoMeta").className=repo.dirty?"dirty":"clean";$("changeBadge").textContent=repo.changes;$("changeBadge").classList.toggle("hidden",repo.changes===0);$("runnerStatus").textContent=state.session.runnerAvailable?"Runner доступен":"Runner пока недоступен";document.title=state.session.project.name+" · Summate";await loadTree()}
  async function loadTree(){const result=await api("/api/viewer/tree?conversation="+encodeURIComponent(state.conversation));state.tree=result.files;renderTree()}
  function renderTree(){const search=$("fileSearch").value.trim().toLowerCase();const files=state.tree.filter(item=>!search||item.path.toLowerCase().includes(search));$("fileTree").innerHTML=files.length?files.map(item=>{const depth=Math.min(item.path.split("/").length-1,5);const name=item.path.split("/").pop();const status=item.status==="untracked"?"untracked":item.status?"changed":"";return "<button class='file-item "+status+"' style='padding-left:"+(9+depth*12)+"px' data-path='"+esc(item.path)+"'><span class='dot'></span><span class='path' title='"+esc(item.path)+"'>"+esc(name)+"</span></button>"}).join(""):"<div class='empty'>Файлы не найдены.</div>";document.querySelectorAll(".file-item").forEach(button=>button.addEventListener("click",()=>openFile(button.dataset.path,button)))}
  async function openFile(path,button){document.querySelectorAll(".file-item").forEach(item=>item.classList.remove("active"));button.classList.add("active");$("filePath").textContent=path;$("fileContent").innerHTML="<code>Загрузка…</code>";try{const file=await api("/api/viewer/file?conversation="+encodeURIComponent(state.conversation)+"&path="+encodeURIComponent(path));$("fileSize").textContent=file.bytes<1024?file.bytes+" B":(file.bytes/1024).toFixed(1)+" KB";$("fileContent").innerHTML="<code>"+file.content.split("\n").map(line=>"<span class='diff-line'>"+esc(line)+"</span>").join("")+"</code>"}catch(error){$("fileContent").innerHTML="<code>"+esc(error.message)+"</code>"}}
  async function loadWorkingDiff(){$("workingDiff").innerHTML="<code>Загрузка…</code>";try{const result=await api("/api/viewer/diff?conversation="+encodeURIComponent(state.conversation)+"&mode=working");renderDiff($("workingDiff"),result.diff)}catch(error){renderDiff($("workingDiff"),error.message)}}
  async function loadCommits(){const result=await api("/api/viewer/commits?conversation="+encodeURIComponent(state.conversation));$("commitList").innerHTML=result.commits.map(commit=>"<button class='card' data-hash='"+commit.hash+"'><strong>"+esc(commit.shortHash+" "+commit.subject)+"</strong><span>"+esc(commit.author+" · "+new Date(commit.authoredAt).toLocaleString())+"</span></button>").join("")||"<div class='empty'>Коммитов нет.</div>";document.querySelectorAll("#commitList .card").forEach(button=>button.addEventListener("click",()=>loadCommitDiff(button.dataset.hash,button)))}
  async function loadCommitDiff(hash,button){document.querySelectorAll("#commitList .card").forEach(item=>item.classList.remove("active"));button.classList.add("active");$("commitDiffTitle").textContent=hash.slice(0,8)+" относительно parent";$("commitDiff").innerHTML="<code>Загрузка…</code>";try{const result=await api("/api/viewer/diff?conversation="+encodeURIComponent(state.conversation)+"&mode=commit&base="+encodeURIComponent(hash+"^")+"&head="+encodeURIComponent(hash));renderDiff($("commitDiff"),result.diff)}catch(error){renderDiff($("commitDiff"),error.message)}}
  async function loadRuns(){const result=await api("/api/viewer/runs?conversation="+encodeURIComponent(state.conversation));$("runList").innerHTML=result.runs.map(run=>"<button class='card' data-run='"+run.runId+"'><strong>Run #"+run.runId+(run.changed?" · changed":" · clean")+"</strong><span>"+esc(new Date(run.completedAt).toLocaleString())+"</span></button>").join("")||"<div class='empty'>Снимки появятся после следующего Codex run.</div>";document.querySelectorAll("#runList .card").forEach(button=>button.addEventListener("click",()=>loadRunDiff(button.dataset.run,button)))}
  async function loadRunDiff(runId,button){document.querySelectorAll("#runList .card").forEach(item=>item.classList.remove("active"));button.classList.add("active");$("runDiffTitle").textContent="Run #"+runId+" · before → after";const result=await api("/api/viewer/run-diff?conversation="+encodeURIComponent(state.conversation)+"&run="+encodeURIComponent(runId));renderDiff($("runDiff"),result.diff)}
  async function enqueue(action){if(action==="run"&&!confirm("Запустить live-публикацию из чистого HEAD?"))return;try{const result=await api("/api/viewer/jobs",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({conversation:state.conversation,action})});toast("Job "+result.job.id+" поставлен в очередь");await loadJobs()}catch(error){toast(error.message)}}
  async function loadJobs(){try{const result=await api("/api/viewer/jobs?conversation="+encodeURIComponent(state.conversation));$("runnerStatus").textContent=result.available?"Runner доступен":"Runner недоступен";$("jobList").innerHTML=result.jobs.map(job=>"<button class='card' data-job='"+job.id+"'><strong>"+esc(job.action+" · "+job.revision.slice(0,8))+"<span class='status "+job.status+"'>"+esc(job.status)+"</span></strong><span>"+esc(new Date(job.createdAt).toLocaleString())+"</span></button>").join("")||"<div class='empty'>Запусков пока нет.</div>";document.querySelectorAll("#jobList .card").forEach(button=>button.addEventListener("click",()=>loadJobLog(button.dataset.job)))}catch(error){$("runnerStatus").textContent=error.message;$("jobList").innerHTML="<div class='empty'>Runner недоступен.</div>"}}
  async function loadJobLog(id){const result=await api("/api/viewer/job-log?conversation="+encodeURIComponent(state.conversation)+"&job="+encodeURIComponent(id));$("jobLog").innerHTML="<code>"+esc(result.log||"Лог пуст.")+"</code>"}
  $("fileSearch").addEventListener("input",renderTree);$("refreshButton").addEventListener("click",async()=>{try{await loadSession();if(state.tab==="changes")await loadWorkingDiff();toast("Обновлено")}catch(error){toast(error.message)}});$("reloadDiff").addEventListener("click",loadWorkingDiff);$("reloadJobs").addEventListener("click",loadJobs);document.querySelectorAll("[data-action]").forEach(button=>button.addEventListener("click",()=>enqueue(button.dataset.action)));
  loadSession().catch(error=>{document.body.innerHTML="<main style='padding:32px;font-family:system-ui;color:#eef5f0;background:#0d1210;min-height:100vh'><h1>Project Viewer</h1><p style='color:#ff9c8e'>"+esc(error.message)+"</p><p>Откройте viewer из Telegram или передайте локальный token в URL fragment.</p></main>"});
})();
`;
