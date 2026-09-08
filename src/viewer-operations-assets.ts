/** A separate read-only snapshot keeps unavailable runner I/O away from the topic overview. */
export const OPERATIONS_HTML = `
  <article class="overview-card operations-card">
    <div class="overview-card-heading"><h2>Запуски и сервисы</h2><span id="operationsFreshness" role="status">Ожидаем проверку…</span></div>
    <div class="operations-grid">
      <section><h3>Джобы</h3><div id="operationsJobs"><p class="overview-empty">Получаем состояние…</p></div></section>
      <section><h3>Сервисы</h3><div id="operationsServices"><p class="overview-empty">Получаем состояние…</p></div></section>
    </div>
  </article>
  <div class="overview-grid">
    <article class="overview-card"><h2>История расписаний</h2><div id="operationsExecutions"><p class="overview-empty">Загрузка…</p></div></article>
    <article class="overview-card"><h2>Доставка результатов</h2><div id="operationsDeliveries"><p class="overview-empty">Загрузка…</p></div></article>
  </div>
`;
export const OPERATIONS_CSS = `
.operations-card{margin-bottom:16px}.operations-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}.operations-grid section{min-width:0}.operations-grid h3{font-size:13px;margin:0 0 8px}.operation-row{padding:12px 0;border-bottom:1px solid var(--border);overflow-wrap:anywhere}.operation-row:last-child{border-bottom:0}.operation-title{display:flex;gap:10px;align-items:baseline;justify-content:space-between}.operation-title strong{font-size:13px}.operation-status{font-size:11px;color:var(--muted);white-space:nowrap}.operation-attention{color:var(--accent,#ff3366)}.operation-row p,.operation-row small{display:block;font-size:12px;color:var(--muted);line-height:1.6;margin:5px 0 0}.operation-row code{font-size:11px}.operations-card .overview-card-heading{flex-wrap:wrap}#operationsFreshness{font-size:11px;color:var(--muted)}@media(max-width:700px){.operations-grid{grid-template-columns:1fr;gap:18px}}
`;
export const OPERATIONS_JS = `
  state.operationsRequest=null;
  const operationLabels={claimed:"Проверяется запуск",reconciling:"Нужна проверка",queued:"В очереди",running:"Работает",cancelling:"Останавливается",completed:"Готово",cancelled:"Отменено",failed:"Ошибка",interrupted:"Прервано",skipped:"Пропущено",deploying:"Обновляется",stopped:"Остановлен",unhealthy:"Требует внимания"};
  const operationActions={build:"Сборка",validate:"Проверка","dry-run":"Пробный запуск",run:"Рабочий запуск",provision:"Настройка окружения"};
  function operationRow(title,status,details){return "<div class='operation-row'><div class='operation-title'><strong>"+esc(title)+"</strong><span class='operation-status "+(["failed","unhealthy","reconciling","interrupted"].includes(status)?"operation-attention":"")+"'>"+esc(operationLabels[status]||status)+"</span></div>"+details.map(text=>"<p>"+esc(text)+"</p>").join("")+"</div>"}
  function renderOperations(data){
    if(!data){$("operationsFreshness").textContent="Состояние пока недоступно";return}
    state.operations=data;
    $("operationsFreshness").textContent=data.available?"Проверено "+localTime(data.lastSuccessAt):data.lastSuccessAt?"Нет связи с раннером · данные на "+localTime(data.lastSuccessAt):"Ожидаем первую успешную проверку раннера";
    renderOverviewPart("operationsJobs",(data.jobs||[]).slice(0,8).map(job=>operationRow(operationActions[job.action]||job.action,job.status,
      [localTime(job.createdAt)+" · версия "+(job.revision||"").slice(0,8)+" · "+job.id.slice(0,8),
       ...(job.queueReason?[job.queueReason+" · ожидание "+Math.floor(job.waitSeconds/60)+" мин."]:[]),
       ...(job.initiatedBy?["Инициатор: "+job.initiatedBy]:[])])).join("")||"<p class='overview-empty'>Запусков пока нет.</p>");
    renderOverviewPart("operationsServices",(data.services||[]).map(service=>operationRow(service.name,service.status,
      ["Версия "+(service.current?service.current.revision.slice(0,8):"не выбрана")+(Number.isInteger(service.restartCount)?" · перезапусков: "+service.restartCount:""),
       ...(service.error?[service.error]:[])])).join("")||"<p class='overview-empty'>Сервисы не развёрнуты.</p>");
    renderOverviewPart("operationsExecutions",(data.executions||[]).slice(0,12).map(execution=>operationRow(execution.name,execution.status,
      ["Назначен на "+localTime(execution.scheduledFor),...(execution.reason?[execution.reason]:[]),
       ...(["claimed","reconciling"].includes(execution.status)?["Попросите агента проверить запуск "+execution.id]:[])])).join("")||"<p class='overview-empty'>Запусков по расписанию пока нет.</p>");
    renderOverviewPart("operationsDeliveries",(data.deliveryFailures||[]).map(delivery=>operationRow("Доставка ожидает повтора","failed",
      [delivery.error,"Попыток: "+delivery.attempts+" · следующая: "+localTime(delivery.nextAttemptAt)])).join("")||"<p class='overview-empty'>Ошибок передачи результатов в очередь отправки нет.</p>");
  }
  async function loadOperations(){
    if(state.operationsRequest)return state.operationsRequest;
    const conversation=state.conversation;
    state.operationsRequest=(async()=>{
      try{const data=await api("/api/viewer/operations?conversation="+encodeURIComponent(conversation));if(state.conversation===conversation)renderOperations(data)}
      catch{if(state.conversation===conversation)$("operationsFreshness").textContent=state.operations&&state.operations.lastSuccessAt?"Нет связи · данные на "+localTime(state.operations.lastSuccessAt):"Не удалось получить состояние запусков"}
      finally{state.operationsRequest=null}
    })();
    return state.operationsRequest;
  }
`;
