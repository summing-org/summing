export const ADMIN_BACK_HTML = `<a id="adminBack" class="admin-back" href="/admin?section=bindings&amp;restore=1" aria-label="Назад в управление" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5m6-6-6 6 6 6"/></svg><span>Управление</span></a>`;

export const ADMIN_BACK_CSS = `
.admin-back{display:inline-flex;align-items:center;gap:5px;flex:none;padding:6px 8px;border:1px solid var(--border-strong);border-radius:6px;color:var(--text);background:var(--surface);font:500 11px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-decoration:none}
.admin-back[hidden]{display:none}
.admin-back svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.admin-back:hover{border-color:var(--accent);color:var(--accent-light)}
.admin-back:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.topbar:has(.admin-back:not([hidden])) .brand{display:none}
@media(max-width:760px){.topbar:has(.admin-back:not([hidden])){gap:9px}}
`;

export const VIEWER_ADMIN_RETURN_JS = String.raw`
  const viewerFromAdmin=new URL(location.href).searchParams.get("from")==="admin";
  function returnToAdmin(event){
    if(event&&(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey))return;
    if(event)event.preventDefault();
    if(!viewerFromAdmin)return;
    if($("app")&&hasUnsavedSettings()&&!confirm("В настройках есть несохранённые изменения. Вернуться в управление?"))return;
    location.assign("/admin?section=bindings&restore=1");
  }
  function syncAdminBackButton(){
    const link=$("adminBack");if(link)link.hidden=!viewerFromAdmin;
    const back=tg&&tg.BackButton;if(!back)return;
    try{back.offClick(returnToAdmin);if(viewerFromAdmin){back.onClick(returnToAdmin);back.show()}else back.hide()}catch{}
  }
  $("adminBack").addEventListener("click",returnToAdmin);
  syncAdminBackButton();
  window.addEventListener("pageshow",syncAdminBackButton);
  window.addEventListener("pagehide",()=>{const back=tg&&tg.BackButton;if(back)try{back.offClick(returnToAdmin);back.hide()}catch{}});
`;

export const ADMIN_RETURN_STATE_JS = String.raw`
  const adminReturnKey="summingAdminReturn";
  function rememberAdminReturn(){
    const content=$("adminContent");
    try{sessionStorage.setItem(adminReturnKey,JSON.stringify({search:$("topicSearch").value,top:content.scrollTop,left:content.scrollLeft}))}catch{}
  }
  function restoreAdminReturn(){
    const url=new URL(location.href);
    if(url.searchParams.get("section")!=="bindings"||url.searchParams.get("restore")!=="1")return;
    try{
      const saved=JSON.parse(sessionStorage.getItem(adminReturnKey)||"null");
      if(saved&&typeof saved.search==="string"&&Number.isFinite(saved.top)&&saved.top>=0&&Number.isFinite(saved.left)&&saved.left>=0){
        $("topicSearch").value=saved.search;adminNavigation.positions.set("bindings",{top:saved.top,left:saved.left});
      }
    }catch{}
    url.searchParams.delete("restore");try{history.replaceState(null,"",url.href)}catch{}
  }
  document.addEventListener("click",event=>{if(event.target.closest(".topic-open-project,.topic-open-model"))rememberAdminReturn()});
  function hideAdminNativeBack(){if(tg&&tg.BackButton)try{tg.BackButton.hide()}catch{}}
  hideAdminNativeBack();window.addEventListener("pageshow",hideAdminNativeBack);
  restoreAdminReturn();
`;
