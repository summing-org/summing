/** Navigation stays separate from panel content so returning never discards a draft. */
export const NAVIGATION_HTML = `
    <nav class="primary-nav" aria-label="Основные разделы">
      <button type="button" data-section="overview" class="active" aria-current="page"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg><span>Обзор</span></button>
      <button type="button" data-section="work"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 6 2 2 4-4M12 6h9M3 13h4m5 0h9M3 20h4m5 0h9"/></svg><span>Работа</span></button>
      <button type="button" data-section="files"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h5l3 4h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg><span>Файлы</span></button>
      <button type="button" data-section="settings"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h4m6 0h6M4 17h10m6 0h0"/><circle cx="11" cy="7" r="3"/><circle cx="17" cy="17" r="3"/></svg><span>Настройки</span></button>
    </nav>
    <nav class="tabs section-tabs hidden" role="tablist" aria-label="Вкладки раздела">
      <button type="button" data-tab="runs">Правки агента</button>
      <button type="button" data-tab="results">Результаты</button>
      <button type="button" data-tab="launch">Раннер</button>
      <button type="button" data-tab="files">Дерево</button>
      <button type="button" data-tab="changes">Изменения <span id="changeBadge" class="badge hidden">0</span></button>
      <button type="button" data-tab="history">История</button>
      <button type="button" data-tab="model">Модель</button>
      <button type="button" data-tab="repository">Репозиторий</button>
      <button type="button" id="environmentTab" data-tab="environment" class="hidden">Переменные</button>
    </nav>
`;

export const NAVIGATION_CSS = `
#app{height:100dvh;display:grid;grid-template-rows:64px 54px auto auto minmax(0,1fr);grid-template-areas:"header" "topic" "primary" "secondary" "content";overflow:hidden}
#app>.topbar{grid-area:header;position:relative;height:auto;min-width:0}
#app>.topic-bar{grid-area:topic;height:auto;min-width:0}
#app>main{grid-area:content;height:auto;min-height:0;min-width:0;overflow:hidden}
.primary-nav{grid-area:primary;display:flex;min-width:0;gap:4px;min-height:54px;padding:0 14px;background:var(--surface);border-bottom:1px solid var(--border)}
.primary-nav button{display:flex;align-items:center;justify-content:center;gap:9px;position:relative;min-width:110px;padding:14px 18px;border:0;background:transparent;color:var(--muted);font-size:13px;cursor:pointer}
.primary-nav button svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;flex:none}
.primary-nav button.active{color:var(--accent-light)}
.primary-nav button.active:after{content:"";position:absolute;left:14px;right:14px;bottom:0;height:3px;border-radius:3px 3px 0 0;background:var(--accent)}
.primary-nav button:hover:not(.active){color:var(--text)}
.section-tabs{grid-area:secondary;height:44px;background:var(--bg);min-width:0;flex-shrink:0}
.section-tabs button{font-size:12px;min-height:44px}
.section-tabs button[hidden]{display:none!important}
.section-tabs button.active:after{background:var(--primary);height:2px}
.panel[role="tabpanel"]:focus-visible{outline:2px solid var(--primary);outline-offset:-2px}
@media(max-width:760px){
  #app{grid-template-rows:60px 52px auto minmax(0,1fr) calc(64px + env(safe-area-inset-bottom,0px));grid-template-areas:"header" "topic" "secondary" "content" "primary"}
  .primary-nav{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0;min-height:0;padding:0 6px env(safe-area-inset-bottom,0px);border-top:1px solid var(--border-strong);border-bottom:0;z-index:12;box-shadow:0 -6px 24px color-mix(in srgb,var(--bg) 55%,transparent)}
  .primary-nav button{flex-direction:column;gap:5px;padding:10px 2px 8px;min-width:0;font-size:10px;min-height:64px}
  .primary-nav button svg{width:20px;height:20px}
  .primary-nav button.active:after{top:0;bottom:auto;left:25%;right:25%;height:2px;border-radius:0 0 3px 3px}
  .section-tabs{padding:0 8px;height:44px}
  .section-tabs button{flex:1;padding:0 12px}
  .overview-shell{padding-bottom:28px}
}
`;

export const NAVIGATION_JS = String.raw`
  const navigationSections={overview:["overview"],work:["runs","results","launch"],files:["files","changes","history"],settings:["model","repository","environment"]};
  const navigationLabels={overview:"Обзор",work:"Работа",files:"Файлы",settings:"Настройки"};
  const navigationKey="summingViewerNavigation:"+state.conversation;
  const navigation={last:{overview:"overview",work:"runs",files:"files",settings:"model"},loaded:new Set(),loading:new Map(),positions:new Map(),initialized:false};
  function tabSection(name){return Object.keys(navigationSections).find(section=>navigationSections[section].includes(name))||null}
  function canOpenTab(name){return Boolean(tabSection(name))&&(name!=="environment"||Boolean(state.session&&state.session.environmentAccess))}
  function readNavigation(){
    try{const saved=JSON.parse(sessionStorage.getItem(navigationKey)||"null");if(!saved||typeof saved!=="object")return null;
      for(const section of Object.keys(navigationSections)){const tab=saved.last&&saved.last[section];if(navigationSections[section].includes(tab))navigation.last[section]=tab}
      return typeof saved.tab==="string"&&tabSection(saved.tab)?saved.tab:null;
    }catch{return null}
  }
  const rememberedTab=readNavigation();
  function rememberNavigation(){try{sessionStorage.setItem(navigationKey,JSON.stringify({tab:state.tab,last:navigation.last}))}catch{}}
  function rememberPanelPosition(name){
    const panel=$(name+"Panel");if(!panel)return;
    navigation.positions.set(name,[panel,...panel.querySelectorAll("pre,aside,article,textarea")].map(element=>({element,top:element.scrollTop,left:element.scrollLeft})));
  }
  function restorePanelPosition(name){
    if(state.tab!==name)return;
    for(const position of navigation.positions.get(name)||[]){if(position.element.isConnected){position.element.scrollTop=position.top;position.element.scrollLeft=position.left}}
  }
  function panelLoader(name){return {overview:loadOverview,results:loadOverview,runs:loadRuns,launch:()=>Promise.all([loadServices(),loadJobs()]),files:loadTree,changes:loadWorkingDiff,history:loadCommits,model:loadModel,repository:loadRepository,environment:loadEnvironment}[name]}
  function ensurePanelLoaded(name,force=false){
    if(navigation.loading.has(name))return navigation.loading.get(name);
    if(!force&&navigation.loaded.has(name))return Promise.resolve();
    const loader=panelLoader(name);if(!loader)return Promise.resolve();
    const request=Promise.resolve().then(loader).then(()=>{navigation.loaded.add(name)}).catch(error=>toast(error.message)).finally(()=>navigation.loading.delete(name));
    navigation.loading.set(name,request);return request;
  }
  function updateNavigation(name){
    const section=tabSection(name);
    document.querySelectorAll(".primary-nav button").forEach(button=>{const selected=button.dataset.section===section;button.classList.toggle("active",selected);if(selected)button.setAttribute("aria-current","page");else button.removeAttribute("aria-current")});
    const subtabs=document.querySelector(".section-tabs");subtabs.classList.toggle("hidden",section==="overview");subtabs.setAttribute("aria-label",navigationLabels[section]+": вкладки");
    document.querySelectorAll(".section-tabs button").forEach(button=>{
      const tab=button.dataset.tab,selected=tab===name;button.hidden=tabSection(tab)!==section||!canOpenTab(tab);button.classList.toggle("active",selected);button.setAttribute("role","tab");button.setAttribute("aria-selected",String(selected));button.setAttribute("aria-controls",tab+"Panel");button.id=button.id||"tab-"+tab;button.tabIndex=selected?0:-1;
      const panel=$(tab+"Panel");panel.setAttribute("role","tabpanel");panel.setAttribute("aria-labelledby",button.id);
    });
    const activeTab=document.querySelector('.section-tabs button[data-tab="'+name+'"]');
    if(activeTab&&!activeTab.hidden)subtabs.scrollLeft=Math.max(0,activeTab.offsetLeft-(subtabs.clientWidth-activeTab.offsetWidth)/2);
  }
  function setTab(name,options={}){
    if(!canOpenTab(name))name="overview";
    if(navigation.initialized&&state.tab===name)return;
    if(navigation.initialized)rememberPanelPosition(state.tab);
    state.tab=name;navigation.initialized=true;navigation.last[tabSection(name)]=name;
    document.querySelectorAll(".panel").forEach(panel=>panel.classList.toggle("active",panel.id===name+"Panel"));
    updateNavigation(name);restorePanelPosition(name);rememberNavigation();
    if(options.history!=="none"){
      const url=new URL(location.href),changed=url.searchParams.get("tab")!==name;url.searchParams.set("tab",name);
      try{if(options.history==="replace")history.replaceState({viewerTab:name},"",url.href);else if(changed)history.pushState({viewerTab:name},"",url.href)}catch{}
    }
    ensurePanelLoaded(name).then(()=>restorePanelPosition(name));
  }
  function setSection(section){if(!Object.hasOwn(navigationSections,section))return;const tab=navigation.last[section];setTab(canOpenTab(tab)?tab:navigationSections[section][0])}
  function initializeNavigation(){
    if(navigation.initialized)return;
    if(state.overview){navigation.loaded.add("overview");navigation.loaded.add("results")}
    const requested=new URL(location.href).searchParams.get("tab");
    setTab(canOpenTab(requested)?requested:canOpenTab(rememberedTab)?rememberedTab:"overview",{history:"replace"});
  }
  async function refreshCurrentTab(name=state.tab){if(state.tab!==name)return;rememberPanelPosition(name);await ensurePanelLoaded(name,true);restorePanelPosition(name)}
  document.querySelectorAll(".primary-nav button").forEach(button=>button.addEventListener("click",()=>setSection(button.dataset.section)));
  document.querySelectorAll(".section-tabs button").forEach(button=>button.addEventListener("click",()=>setTab(button.dataset.tab)));
  document.querySelector(".section-tabs").addEventListener("keydown",event=>{
    if(!["ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;
    const buttons=[...document.querySelectorAll(".section-tabs button")].filter(button=>!button.hidden&&!button.classList.contains("hidden"));
    const current=buttons.indexOf(document.activeElement);if(current<0||!buttons.length)return;event.preventDefault();
    const next=event.key==="Home"?0:event.key==="End"?buttons.length-1:(current+(event.key==="ArrowRight"?1:-1)+buttons.length)%buttons.length;
    const button=buttons[next];setTab(button.dataset.tab);button.focus();
  });
  window.addEventListener("popstate",()=>setTab(new URL(location.href).searchParams.get("tab")||"overview",{history:"none"}));
`;
