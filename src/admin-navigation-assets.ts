/** Admin navigation keeps forms mounted and gives each section its own scroll position. */
export const ADMIN_NAVIGATION_HTML = `
  <nav class="admin-tabs" role="tablist" aria-label="Разделы управления">
    <button id="projectsTab" type="button" role="tab" data-admin-section="projects" aria-controls="projectsPanel" aria-selected="true" class="active"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg><span>Проекты</span></button>
    <button id="bindingsTab" type="button" role="tab" data-admin-section="bindings" aria-controls="bindingsPanel" aria-selected="false" tabindex="-1"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 3-6 18-4-8-8-4 18-6ZM11 13 21 3"/></svg><span>Telegram</span></button>
    <button id="knowledgeTab" type="button" role="tab" data-admin-section="knowledge" aria-controls="knowledgePanel" aria-selected="false" tabindex="-1"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5C9 3 6 3 3 4v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1ZM12 5v15"/></svg><span>База знаний</span></button>
    <button id="systemTab" type="button" role="tab" data-admin-section="system" aria-controls="systemPanel" aria-selected="false" tabindex="-1"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h4m6 0h6M4 17h10m6 0h0"/><circle cx="11" cy="7" r="3"/><circle cx="17" cy="17" r="3"/></svg><span>Система</span></button>
  </nav>
`;

export const ADMIN_NAVIGATION_CSS = `
body.admin-app{height:100vh;height:var(--tg-viewport-height,100dvh);min-height:0;display:grid;grid-template-rows:64px 54px minmax(0,1fr);grid-template-areas:"header" "navigation" "content";overflow:hidden}
.admin-app>.topbar{grid-area:header;position:relative;top:auto;height:auto;min-width:0}
.admin-app>.topbar .title strong,.admin-app>.topbar .title span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.admin-app>.shell{grid-area:content;min-height:0;min-width:0;overflow:auto;overscroll-behavior-y:contain;scroll-padding-block:20px;padding-bottom:32px}
.admin-app>.admin-tabs{grid-area:navigation;position:relative;top:auto;height:auto;min-width:0;gap:4px;overflow:visible}
.admin-tabs button{display:flex;align-items:center;justify-content:center;gap:9px;min-width:110px;min-height:48px;padding:12px 18px}
.admin-tabs button svg{width:20px;height:20px;flex:none;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.admin-tabs button.active{color:var(--accent-light)}
.admin-tabs button:hover:not(.active){color:var(--text)}
.admin-tabs button:focus-visible{outline:2px solid var(--accent);outline-offset:-5px;border-radius:7px}
.admin-panel[hidden]{display:none!important}
.admin-panel:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
@media(max-width:760px){
  body.admin-app{grid-template-rows:60px minmax(0,1fr) calc(64px + env(safe-area-inset-bottom,0px));grid-template-areas:"header" "content" "navigation"}
  .admin-app>.admin-tabs{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0;padding:0 max(6px,env(safe-area-inset-right)) env(safe-area-inset-bottom,0px) max(6px,env(safe-area-inset-left));border-bottom:0;border-top:1px solid var(--border-strong);box-shadow:0 -6px 24px color-mix(in srgb,var(--bg) 55%,transparent);z-index:12}
  .admin-tabs button{flex-direction:column;gap:5px;min-width:0;min-height:0;height:100%;padding:10px 2px 8px;font-size:10px;line-height:1.3}
  .admin-tabs button.active:after{top:0;bottom:auto;left:25%;right:25%;height:2px;border-radius:0 0 3px 3px}
  .admin-app>.shell{padding:22px max(14px,env(safe-area-inset-right)) 28px max(14px,env(safe-area-inset-left))}
  .admin-app #toast{bottom:calc(78px + env(safe-area-inset-bottom,0px))}
}
`;

export const ADMIN_NAVIGATION_JS = String.raw`
  const adminSections=["projects","bindings","knowledge","system"];
  const adminNavigation={initialized:false,positions:new Map(),loading:new Map(),generation:0};
  const adminNavigationKey="summingAdminSection";
  function stopAdminPolling(){for(const timer of ["deploymentTimer","syncTimer","recoveryTimer","portalTimer"]){clearTimeout(state[timer]);state[timer]=0}}
  function loadAdminSection(section){
    if(adminNavigation.loading.has(section))return adminNavigation.loading.get(section);
    const request=Promise.resolve().then(async()=>{
      if(!state.overview)await loadOverview();
      if(section==="bindings")await loadPortalDeliveries();
      if(section==="system")await loadSystem();
      if(section==="knowledge")await loadKnowledge();
    }).finally(()=>{adminNavigation.loading.delete(section);$(section+"Panel")?.removeAttribute("aria-busy")});
    $(section+"Panel").setAttribute("aria-busy","true");adminNavigation.loading.set(section,request);return request;
  }
  async function activateAdminSection(section,options={}){
    if(!adminSections.includes(section))return;
    const content=$("adminContent"),same=adminNavigation.initialized&&state.section===section;
    if(!same){
      if(adminNavigation.initialized)adminNavigation.positions.set(state.section,{top:content.scrollTop,left:content.scrollLeft});
      state.section=section;adminNavigation.initialized=true;stopAdminPolling();
      document.querySelectorAll("[data-admin-section]").forEach(button=>{
        const active=button.dataset.adminSection===section;button.classList.toggle("active",active);button.setAttribute("aria-selected",String(active));button.tabIndex=active?0:-1;
        const panel=$(button.getAttribute("aria-controls"));panel.classList.toggle("active",active);panel.hidden=!active;
      });
    }
    const position=adminNavigation.positions.get(section)||{top:0,left:0},generation=++adminNavigation.generation;
    if(!same){content.scrollTop=position.top;content.scrollLeft=position.left}
    const displayedTop=content.scrollTop,displayedLeft=content.scrollLeft;
    try{sessionStorage.setItem(adminNavigationKey,section)}catch{}
    if(options.history!=="none"){
      const url=new URL(location.href),changed=url.searchParams.get("section")!==section;url.searchParams.set("section",section);
      try{if(options.history==="replace")history.replaceState(null,"",url.href);else if(changed)history.pushState(null,"",url.href)}catch{}
    }
    await loadAdminSection(section);
    if(!same&&state.section===section&&adminNavigation.generation===generation&&content.scrollTop===displayedTop&&content.scrollLeft===displayedLeft){content.scrollTop=position.top;content.scrollLeft=position.left}
  }
  function initializeAdminNavigation(){
    let remembered;try{remembered=sessionStorage.getItem(adminNavigationKey)}catch{}
    const requested=new URL(location.href).searchParams.get("section");
    const section=adminSections.includes(requested)?requested:adminSections.includes(remembered)?remembered:"projects";
    return Promise.all([loadOverview(),activateAdminSection(section,{history:"replace"}).catch(error=>{if(state.overview)toast(error.message)})]);
  }
  document.querySelectorAll("[data-admin-section]").forEach(button=>button.addEventListener("click",()=>activateAdminSection(button.dataset.adminSection).catch(error=>toast(error.message))));
  document.querySelector(".admin-tabs").addEventListener("keydown",event=>{
    if(!["ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;
    const buttons=[...document.querySelectorAll("[data-admin-section]")],current=buttons.indexOf(document.activeElement);if(current<0)return;
    event.preventDefault();const index=event.key==="Home"?0:event.key==="End"?buttons.length-1:(current+(event.key==="ArrowRight"?1:-1)+buttons.length)%buttons.length;
    buttons[index].focus();activateAdminSection(buttons[index].dataset.adminSection).catch(error=>toast(error.message));
  });
  window.addEventListener("popstate",()=>{
    const requested=new URL(location.href).searchParams.get("section");
    activateAdminSection(adminSections.includes(requested)?requested:"projects",{history:"none"}).catch(error=>toast(error.message));
  });
`;
