/** Project activity UI, embedded in the existing authenticated viewer. */
export const OVERVIEW_HTML = `
    <div class="topic-bar">
      <label for="topicSelect">Рабочий топик</label>
      <select id="topicSelect" disabled aria-label="Рабочий топик"><option>Загрузка…</option></select>
      <a id="topicTelegram" class="topic-telegram hidden" target="_blank" rel="noreferrer">В Telegram ↗</a>
    </div>
`;

export const OVERVIEW_PANEL = `
      <section id="overviewPanel" class="panel overview-panel active">
        <div class="overview-shell">
          <div class="overview-heading"><div><span class="eyebrow">ПРОЕКТ · <span id="overviewWorkspace">—</span></span><h1>Обзор проекта</h1><p id="overviewSummary">Загружаем состояние работы…</p></div><span id="overviewFreshness" class="freshness" role="status" aria-live="polite">Подключение…</span></div>
          <div class="overview-metrics" aria-label="Активность проекта">
            <div><span>Топики в работе</span><strong id="activeTopics">—</strong><small>выполнение и подготовка</small></div>
            <div><span>В очереди</span><strong id="queuedInputs">—</strong><small>сообщений ожидают обработки</small></div>
            <div><span>Требуют внимания</span><strong id="attentionTopics">—</strong><small>топики с последней ошибкой</small></div>
          </div>
          <div class="overview-grid">
            <article class="overview-card"><div class="overview-card-heading"><h2>Рабочие топики</h2><span id="overviewTopicCount"></span></div><div id="overviewTopics"><p class="overview-empty">Загрузка…</p></div></article>
            <article class="overview-card"><div class="overview-card-heading"><h2>Ближайшие запуски</h2></div><div id="overviewSchedules"><p class="overview-empty">Загрузка…</p></div><p class="overview-footnote">Расписания общие для рабочего пространства. Изменить их можно через агента в Telegram.</p></article>
          </div>
          <article class="overview-card overview-results"><div class="overview-card-heading"><h2>Последние результаты</h2><span>Все рабочие топики</span></div><div id="overviewRecent"><p class="overview-empty">Результаты появятся после первой задачи.</p></div></article>
        </div>
      </section>
`;

export const OVERVIEW_CSS = `
.topic-bar{height:54px;display:flex;align-items:center;gap:12px;padding:0 24px;background:var(--bg);border-bottom:1px solid var(--border)}.topic-bar label{font-size:11px;color:var(--muted);flex:none}.topic-bar select{min-width:0;max-width:440px;flex:1;padding:9px 12px;border:1px solid var(--border);border-radius:6px;color:var(--text);background:var(--surface2);font-family:inherit;font-size:12px}.topic-telegram{color:var(--primary);font-size:12px;white-space:nowrap;text-decoration:none}.repo-title span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}main{height:calc(100dvh - 164px)}.overview-shell{max-width:1140px;margin:auto;padding:32px 24px 64px}.overview-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:24px}.overview-heading h1{font-size:28px;letter-spacing:-.035em;margin:10px 0}.overview-heading p{font-size:13px;color:var(--muted);line-height:1.5;margin:0}.freshness{font:11px var(--mono);color:var(--primary);padding:9px 0;max-width:240px;text-align:right;line-height:1.6}.freshness.stale{color:var(--warning)}.overview-metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:24px}.overview-metrics>div{padding:20px;border:1px solid var(--border);border-radius:10px;background:var(--surface3)}.overview-metrics span,.overview-metrics small{display:block;color:var(--muted);font-size:12px;line-height:1.4}.overview-metrics strong{display:block;font-size:36px;letter-spacing:-.05em;line-height:1.3;margin:7px 0;color:var(--text)}.overview-metrics strong.has-attention{color:var(--accent-light)}.overview-grid{display:grid;grid-template-columns:1.25fr 1fr;gap:16px;margin-bottom:16px}.overview-card{min-width:0;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:20px}.overview-card-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:12px}.overview-card h2{font-size:15px;margin:0;letter-spacing:-.015em}.overview-card-heading>span{font-size:11px;color:var(--muted)}.overview-topic{display:block;width:100%;text-align:left;border:1px solid transparent;background:none;color:var(--text);border-radius:7px;padding:14px 12px;margin:3px 0;cursor:pointer}.overview-topic:hover{background:var(--surface2)}.overview-topic.selected{background:var(--surface2);border-color:var(--border-strong)}.overview-topic-head,.overview-result-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.overview-topic strong{font-size:13px;overflow-wrap:anywhere}.overview-topic p{margin:8px 0 0;font-size:12px;color:var(--muted);line-height:1.5;overflow-wrap:anywhere}.overview-topic small{display:block;margin-top:6px;color:var(--muted);font-size:10px}.activity-status{display:inline-flex;align-items:center;flex:none;gap:6px;font-size:10px;color:var(--muted);white-space:nowrap}.activity-status:before{content:"";height:6px;width:6px;border-radius:50%;background:var(--muted)}.activity-status.running,.activity-status.preparing{color:var(--primary)}.activity-status.running:before,.activity-status.preparing:before{background:var(--primary)}.activity-status.failed,.activity-status.interrupted{color:var(--accent-light)}.activity-status.failed:before,.activity-status.interrupted:before{background:var(--accent)}.activity-status.completed{color:var(--primary)}.overview-empty,.overview-footnote{font-size:12px;line-height:1.6;color:var(--muted);margin:14px 0}.overview-footnote{padding-top:14px;border-top:1px solid var(--border);margin-bottom:0}.overview-schedule{padding:14px 0;border-bottom:1px solid var(--border)}.overview-schedule:last-child{border-bottom:0}.overview-schedule strong{font-size:13px;overflow-wrap:anywhere}.overview-schedule time{display:block;color:var(--primary);font-size:13px;margin-top:8px}.overview-schedule p{font-size:11px;color:var(--muted);line-height:1.5;margin:6px 0 0;overflow-wrap:anywhere}.overview-result{padding:18px 0;border-top:1px solid var(--border)}.overview-result-head{align-items:flex-start}.overview-result-head strong{font-size:13px;font-weight:500;line-height:1.5;overflow-wrap:anywhere}.overview-result p{font-size:12px;color:var(--muted);line-height:1.65;white-space:pre-line;overflow-wrap:anywhere;margin:10px 0}.overview-result details>p{max-height:240px;overflow:auto}.overview-result summary{font-size:12px;cursor:pointer;color:var(--primary);margin-top:10px}.overview-result footer{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:12px}.overview-result footer span{color:var(--muted);font-size:10px;line-height:1.5}.overview-result a{font-size:11px;color:var(--primary);text-decoration:none;white-space:nowrap}button:focus-visible,a:focus-visible,select:focus-visible{outline:2px solid var(--primary);outline-offset:3px}
@media(max-width:760px){.topic-bar{gap:8px;padding:0 14px}.topic-bar label{display:none}.topic-telegram{font-size:11px}.overview-shell{padding:22px 14px 48px}.overview-heading{display:block}.overview-heading h1{font-size:25px}.freshness{display:block;text-align:left;max-width:none;margin-top:10px;padding:0}.overview-grid{grid-template-columns:1fr}.overview-metrics{gap:8px;margin-bottom:16px}.overview-metrics>div{padding:13px 10px}.overview-metrics strong{font-size:29px}.overview-metrics span{font-size:10px;min-height:28px}.overview-metrics small{font-size:10px}.overview-card{padding:16px}.overview-topic{padding:12px 8px}.overview-result-head{display:block}.overview-result-head>strong{display:block}.overview-result-head .activity-status{margin-top:8px}.overview-card-heading>span{font-size:10px}.overview-topic-head{gap:8px}}
`;

export const OVERVIEW_JS = String.raw`
  Object.assign(state,{overview:null,overviewTimer:null,overviewRequest:null,overviewFailures:0,overviewRendered:{},environmentSaved:null,modelSaved:null,liveRefreshRequest:null});
  const activityLabels={running:"В работе",preparing:"Подготовка",queued:"В очереди",idle:"Свободен",completed:"Готово",failed:"Ошибка",interrupted:"Прервано",cancelled:"Остановлено"};
  const activityStatus=(status)=>"<span class='activity-status "+(Object.hasOwn(activityLabels,status)?status:"idle")+"'>"+esc(activityLabels[status]||status)+"</span>";
  function renderOverviewPart(id,html){
    if(state.overviewRendered[id]===html)return;
    const element=$(id),opened=id==="overviewRecent"?[...element.querySelectorAll("[data-result] details[open]")].map(item=>item.closest("[data-result]").dataset.result):[];
    state.overviewRendered[id]=html;element.innerHTML=html;
    if(opened.length)element.querySelectorAll("[data-result]").forEach(item=>{const details=item.querySelector("details");if(details&&opened.includes(item.dataset.result))details.open=true});
  }
  function hasUnsavedSettings(){return (state.environmentSaved!==null&&$("environmentText").value!==state.environmentSaved)||(state.modelSaved&&($("modelSelect").value!==state.modelSaved.model||($("modelSelect").value&&$("modelEffort").value!==state.modelSaved.effort)))}
  function switchTopic(id){
    if(id===state.conversation)return;
    if(!state.overview||!state.overview.topics.some(topic=>topic.id===id))return;
    if(hasUnsavedSettings()&&!confirm("В настройках есть несохранённые изменения. Перейти в другой топик?")){$("topicSelect").value=state.conversation;return}
    const url=new URL(location.href);url.searchParams.set("conversation",id);url.searchParams.set("tab",state.tab);url.searchParams.delete("run");
    location.assign(url.href);
  }
  function renderOverview(data){
    state.overview=data;
    $("projectName").textContent=data.project.name;$("overviewWorkspace").textContent=data.project.workspace;
    const active=data.topics.filter(topic=>["running","preparing"].includes(topic.status)).length;
    const queued=data.topics.reduce((sum,topic)=>sum+topic.pendingCount,0);
    const attention=data.topics.filter(topic=>topic.status==="idle"&&topic.latestRun&&["failed","interrupted"].includes(topic.latestRun.status)).length;
    $("activeTopics").textContent=active;$("queuedInputs").textContent=queued;$("attentionTopics").textContent=attention;$("attentionTopics").classList.toggle("has-attention",attention>0);
    $("overviewSummary").textContent=active?"Агент работает. Здесь собраны все рабочие топики этого пространства.":queued?"Есть сообщения в очереди. Состояние обновится автоматически.":attention?"Последние задачи в некоторых топиках завершились с ошибкой.":"Активных задач нет. Новое поручение можно отправить в Telegram.";
    $("overviewTopicCount").textContent=data.topics.length;
    if(document.activeElement!==$("topicSelect")){
      renderOverviewPart("topicSelect",data.topics.map(topic=>"<option value='"+esc(topic.id)+"'>"+esc(topic.name+" · "+topic.chat+(topic.primary?" · основной":"")+" · "+activityLabels[topic.status])+"</option>").join(""));
      $("topicSelect").value=state.conversation;
    }
    $("topicSelect").disabled=false;
    const selected=data.topics.find(topic=>topic.id===state.conversation),link=selected&&safeUrl(selected.telegramUrl);
    $("topicTelegram").classList.toggle("hidden",!link);if(link)$("topicTelegram").href=link;
    renderOverviewPart("overviewTopics",data.topics.map(topic=>{
      const run=topic.latestRun,status=topic.status==="idle"&&run&&["failed","interrupted"].includes(run.status)?run.status:topic.status;
      const description=topic.status==="running"&&run&&run.status==="running"?run.request:topic.status==="preparing"?"Подготовка к запуску…":topic.pendingCount?"Ожидают обработки: "+topic.pendingCount:status==="failed"||status==="interrupted"?(run.error||run.request):"Можно отправить новое поручение";
      return "<button class='overview-topic "+(topic.id===state.conversation?"selected":"")+"' data-conversation='"+esc(topic.id)+"' aria-current='"+(topic.id===state.conversation?"true":"false")+"'><span class='overview-topic-head'><strong>"+esc(topic.name)+"</strong>"+activityStatus(status)+"</span><small>"+esc(topic.chat+(topic.primary?" · основной":"")+(topic.id===state.conversation?" · выбран":""))+"</small><p>"+esc(description)+"</p></button>";
    }).join(""));
    renderOverviewPart("overviewSchedules",data.schedules===null?"<p class='overview-empty'>Расписания пока недоступны.</p>":data.schedules.length?data.schedules.map(schedule=>"<div class='overview-schedule'><strong>"+esc(schedule.name)+"</strong><time>"+esc(new Date(schedule.nextRunAt).toLocaleString("ru-RU",{timeZone:schedule.timeZone,day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}))+"</time><p>"+esc(schedule.timeZone)+" · по расписанию</p>"+(schedule.destination?"<p>Отчёт: "+esc(schedule.destination)+"</p>":"")+"</div>").join(""):"<p class='overview-empty'>Активных расписаний нет.</p>");
    renderOverviewPart("overviewRecent",data.recent.length?data.recent.map(run=>{
      const topic=data.topics.find(item=>item.id===run.conversationId),url=topic&&safeUrl(topic.telegramUrl);
      return "<div class='overview-result' data-result='"+esc(run.id)+"'><div class='overview-result-head'><strong>"+esc(run.request||"Задача #"+run.id)+"</strong>"+activityStatus(run.status)+"</div>"+(run.error?"<p>"+esc(run.error)+"</p>":"")+(run.result?"<details><summary>Результат</summary><p>"+esc(run.result)+"</p></details>":"")+"<footer><span>"+esc((topic?topic.name+" · ":"")+localTime(run.completedAt||run.startedAt)+" · #"+run.id)+"</span>"+(url?"<a href='"+esc(url)+"' target='_blank' rel='noreferrer'>Открыть топик ↗</a>":"")+"</footer></div>";
    }).join(""):"<p class='overview-empty'>Завершённых задач пока нет. Результаты появятся здесь после работы агента.</p>");
    $("overviewFreshness").classList.remove("stale");$("overviewFreshness").textContent="Обновлено "+new Date(data.updatedAt).toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit",second:"2-digit"});
  }
  async function loadOverview(){
    if(state.overviewRequest)return state.overviewRequest;
    state.overviewRequest=(async()=>{
      try{const data=await api("/api/viewer/overview?conversation="+encodeURIComponent(state.conversation));renderOverview(data);state.overviewFailures=0}
      catch(error){state.overviewFailures+=1;$("overviewFreshness").classList.add("stale");$("overviewFreshness").textContent=state.overview?"Нет связи · показаны данные на "+localTime(state.overview.updatedAt):error.message;throw error}
      finally{state.overviewRequest=null}
    })();
    return state.overviewRequest;
  }
  function scheduleOverviewRefresh(){clearTimeout(state.overviewTimer);if(document.hidden)return;state.overviewTimer=setTimeout(refreshLiveStatus,Math.min(30000,5000*Math.pow(2,state.overviewFailures)))}
  async function refreshLiveStatus(){
    clearTimeout(state.overviewTimer);if(document.hidden)return;
    if(state.liveRefreshRequest)return state.liveRefreshRequest;
    state.liveRefreshRequest=(async()=>{
      try{await loadOverview();if(!document.hidden&&state.tab==="launch")await Promise.all([loadServices(),loadJobs()])}catch{}
      finally{state.liveRefreshRequest=null;scheduleOverviewRefresh()}
    })();
    return state.liveRefreshRequest;
  }
  $("topicSelect").addEventListener("change",event=>switchTopic(event.target.value));
  $("overviewTopics").addEventListener("click",event=>{const button=event.target.closest("[data-conversation]");if(button)switchTopic(button.dataset.conversation)});
  document.addEventListener("visibilitychange",()=>{clearTimeout(state.overviewTimer);if(!document.hidden&&state.overview)refreshLiveStatus()});
  window.addEventListener("pagehide",()=>clearTimeout(state.overviewTimer));
`;
