import { collectionKey, documentLabel, libraryLabel, modificationAge, visibleDocuments, type LibraryEntry } from './document-library.js';
import { loadDocumentImages, sanitizeDocument } from './document-images.js';
import { DocumentScopeState, documentScopeLabel } from './document-scope.js';
import { atelierUrl, createAtelierFrame } from './local-atelier.js';
type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;
export function initialDocument(entries: readonly LibraryEntry[], saved?: string): string | undefined {
  if (saved) return saved;
  const pages = entries.filter(entry => !entry.directory);
  for (const name of ['index.html', 'objectifs.html', 'README.md', 'index.md', 'objectifs.md']) {
    const entry = pages.find(item => item.name.toLowerCase() === name.toLowerCase());
    if (entry) return entry.relative;
  }
  return pages.find(entry => entry.name.toLowerCase() !== 'agents.md')?.relative;
}
const escape = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/** Plain text never passes through either the HTML or Markdown source parser. */
export function parseDocument(source:string,format:string):Document {
  if(format==='html'||format==='markdown')return new DOMParser().parseFromString(format==='markdown'?markdownHtml(source):source,'text/html');
  const parsed=new DOMParser().parseFromString('','text/html');
  const pre=parsed.createElement('pre');pre.style.whiteSpace='pre-wrap';pre.textContent=source;parsed.body.append(pre);
  return parsed;
}

// Small, escaped Markdown renderer. Raw HTML is text, never executable markup.
export function markdownHtml(source: string): string {
  const inline = (text: string): string => {
    const tokens = /`([^`]+)`|(!?)\[([^\]]*)\]\(<?([^\s)>]+)>?(?:\s+"[^"\n]*")?\)|\*\*([^*]+)\*\*|\*([^*]+)\*/g;
    let result = '', end = 0;
    for (const token of text.matchAll(tokens)) {
      result += escape(text.slice(end, token.index)); end = token.index + token[0].length;
      if (token[1] !== undefined) result += `<code>${escape(token[1])}</code>`;
      else if (token[4] !== undefined) result += token[2] === '!'
        ? `<img src="${escape(token[4])}" alt="${escape(token[3] ?? '')}">`
        : `<a href="${escape(token[4])}">${escape(token[3] ?? '')}</a>`;
      else if (token[5] !== undefined) result += `<strong>${escape(token[5])}</strong>`;
      else result += `<em>${escape(token[6] ?? '')}</em>`;
    }
    return result + escape(text.slice(end));
  };
  const lines = source.replaceAll('\r', '').split('\n');
  const result: string[] = [];
  let code: string[] | null = null;
  let list = '';
  const closeList = (): void => { if (list) { result.push(`</${list}>`); list = ''; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^\s*```/.test(line)) {
      closeList();
      if (code) { result.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`); code = null; }
      else code = [];
      continue;
    }
    if (code) { code.push(line); continue; }
    const item = /^\s*(?:([-*+])|\d+\.)\s+(.+)$/.exec(line);
    if (item) {
      const tag = item[1] ? 'ul' : 'ol';
      if (list !== tag) { closeList(); result.push(`<${tag}>`); list = tag; }
      result.push(`<li>${inline(item[2] ?? '')}</li>`); continue;
    }
    closeList();
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = String(heading[1]?.length ?? 1), title = heading[2] ?? '';
      result.push(`<h${level} id="${escape(title.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-'))}">${inline(title)}</h${level}>`);
    } else if (line.includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? '')) {
      const cells = (row: string): string[] => row.trim().replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim()));
      result.push(`<table><thead><tr>${cells(line).map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>`);
      i += 2;
      while (i < lines.length && lines[i]?.includes('|')) { result.push(`<tr>${cells(lines[i] ?? '').map(c => `<td>${c}</td>`).join('')}</tr>`); i++; }
      i--; result.push('</tbody></table>');
    } else if (/^>\s?/.test(line)) result.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`);
    else if (/^\s*([-*_])\1{2,}\s*$/.test(line)) result.push('<hr>');
    else if (line.trim()) result.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  if (code) result.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`);
  return result.join('\n');
}

export function initDocuments(invoke: Invoke): void {
  const byId=<T extends HTMLElement>(id:string):T=>document.getElementById(id) as T;
  const host=byId<HTMLElement>('view-documents'),frame=byId<HTMLIFrameElement>('document-frame');
  const appFrame=createAtelierFrame();frame.parentElement?.append(appFrame);
  const closeApp=():void=>{appFrame.hidden=true;appFrame.removeAttribute('src');frame.hidden=false;};
  const scope=byId<HTMLSelectElement>('document-scope'),collection=byId<HTMLSelectElement>('document-collection');
  let savedScope:unknown=scope.value;
  try{savedScope=localStorage.getItem('mind-wake.reader-scope')??scope.value;}catch{/* Optional storage. */}
  const scopeState=new DocumentScopeState(savedScope);scope.value=scopeState.current;
  const search=byId<HTMLInputElement>('document-search'),format=byId<HTMLSelectElement>('document-format');
  const files=byId<HTMLElement>('document-files'),status=byId<HTMLElement>('document-status');
  const location=byId<HTMLElement>('document-location'),title=byId<HTMLElement>('document-title');
  const outline=byId<HTMLSelectElement>('document-sections'),library=byId<HTMLElement>('document-library');
  const explore=byId<HTMLButtonElement>('document-explore');
  const back=byId<HTMLButtonElement>('document-back'),forward=byId<HTMLButtonElement>('document-forward');
  const previous=byId<HTMLButtonElement>('document-previous'),next=byId<HTMLButtonElement>('document-next');
  let entries:LibraryEntry[]=[],current='',documentScope='agent',generation=0,catalogGeneration=0,pendingOpen=false;
  let renderedRelative='',renderedScope='agent',cloneVersion:string|undefined;
  const scopeHistories=new Map<string,{history:string[];position:number}>();
  let history:string[]=[],position=-1,truncated=false;
  type ContextFile={scope:'agent'|'project';relative:string;name:string};
  let contextQueue:ContextFile[]=[],contextMode=false;
  const queueHost=document.createElement('div');queueHost.id='document-context-queue';queueHost.hidden=true;queueHost.style.cssText='flex:0 0 auto;display:none;gap:10px;align-items:start;font-size:11px;';
  const queueDetails=document.createElement('details'),queueSummary=document.createElement('summary'),queueList=document.createElement('ol'),recent=document.createElement('button');
  queueList.style.cssText='max-height:130px;overflow:auto;margin:7px 0;padding-left:20px;';queueDetails.append(queueSummary,queueList);recent.type='button';recent.textContent='Revenir aux récents';recent.style.cssText='font:inherit;padding:5px 8px;margin-left:auto;';queueHost.append(queueDetails,recent);host.insertBefore(queueHost,host.querySelector('.document-workspace'));
  const requestFile=(file:ContextFile):void=>{window.dispatchEvent(new CustomEvent('wake-open-document',{detail:{scope:file.scope,relative:file.relative}}));};
  function renderQueue():void{
    const visible=scopeState.local!==null&&contextQueue.length>0;
    queueHost.hidden=!visible;queueHost.style.display=visible?'flex':'none';queueSummary.textContent='Fichiers évoqués · '+contextQueue.length;recent.hidden=!contextMode;queueList.replaceChildren();
    for(const file of contextQueue){const item=document.createElement('li'),button=document.createElement('button');button.type='button';button.textContent=(file.scope==='agent'?'Atelier':'Projet Wake')+' / '+file.relative;button.style.cssText='font:inherit;text-align:left;padding:4px;';button.addEventListener('click',()=>{contextMode=true;renderQueue();requestFile(file);});item.append(button);queueList.append(item);}
  }
  recent.addEventListener('click',()=>{contextMode=false;renderQueue();pagination();});
  let positions:Record<string,number>={};
  try{
    const saved:unknown=JSON.parse(localStorage.getItem('mind-wake.reader-positions')??'{}');
    if(saved&&typeof saved==='object'&&!Array.isArray(saved))positions=Object.fromEntries(Object.entries(saved).filter(([,value])=>typeof value==='number'&&Number.isFinite(value)&&value>=0));
  }catch{/* Storage is optional. */}
  const stateKey=():string=>'mind-wake.reader-current.'+scope.value;
  const feedback=(error:unknown):void=>{status.textContent='Lecture indisponible : '+String(error);};
  const shown=():LibraryEntry[]=>visibleDocuments(entries,collection.value,search.value,format.value);
  const remember=():void=>{
    if(renderedRelative&&frame.contentWindow)positions[renderedScope+':'+renderedRelative]=frame.contentWindow.scrollY;
    try{localStorage.setItem('mind-wake.reader-positions',JSON.stringify(positions));if(current)localStorage.setItem('mind-wake.reader-current.'+documentScope,current);}catch{/* Keep working without storage. */}
  };
  function setLibrary(open:boolean):void{
    library.hidden=!open;host.dataset['library']=open?'open':'closed';explore.setAttribute('aria-expanded',String(open));
  }
  function pagination():void{
    const list=contextMode&&scopeState.local!==null?contextQueue:shown().map(entry=>({...entry,scope:scope.value}));
    const index=list.findIndex(e=>e.relative===current&&e.scope===scope.value);
    const before=index>0?list[index-1]:undefined,after=index<0?list[0]:list[index+1];
    previous.dataset['scope']=before?.scope??scope.value;next.dataset['scope']=after?.scope??scope.value;
    previous.disabled=!before;next.disabled=!after;
    byId('document-previous-title').textContent=before?documentLabel(before):'Début de la liste';
    byId('document-next-title').textContent=after?documentLabel(after):'Fin de la liste';
    previous.dataset['relative']=before?.relative??'';next.dataset['relative']=after?.relative??'';
    back.disabled=position<=0;forward.disabled=position>=history.length-1;
  }
  function refreshFileAges():void {
    const now=Date.now();
    for(const time of files.querySelectorAll<HTMLTimeElement>('time[data-modified-at]')) {
      const age=modificationAge(Number(time.dataset['modifiedAt']),now);
      time.textContent=age.label;
      time.setAttribute('aria-label','Dernière modification : '+age.label);
      if(age.date){time.dateTime=age.date;time.title='Modifié le '+new Date(age.date).toLocaleString('fr-FR');}
      else {time.removeAttribute('datetime');time.title='Date de modification indisponible';}
    }
  }
  setInterval(refreshFileAges,60_000);
  function renderFiles():void{
    const list=shown();files.replaceChildren();
    byId('document-count').textContent=list.length+' document'+(list.length===1?'':'s')+(scopeState.current==='aurore'?' · catalogue Git':' · plus récents en premier')+(truncated?' · catalogue partiel':'');
    if(!list.length){const empty=document.createElement('p');empty.className='reader-empty';empty.textContent='Aucun document affiché. Consultez l’état de lecture ou modifiez les filtres.';files.append(empty);}
    for(const entry of list){
      const button=document.createElement('button');button.type='button';button.className='reader-file';button.title=entry.relative;
      button.setAttribute('aria-current',String(entry.relative===current));
      const name=document.createElement('strong');name.textContent=documentLabel(entry);
      const meta=document.createElement('small');const ext=/\.html?$/i.test(entry.relative)?'HTML':/\.txt$/i.test(entry.relative)?'TXT':'MD';
      meta.textContent=ext+' · '+entry.relative.split('/').slice(0,-1).join('/');
      const age=document.createElement('time');age.dataset['modifiedAt']=String(entry.modifiedAt??0);age.className='reader-file-age';
      button.append(name,meta,age);button.addEventListener('click',()=>{contextMode=false;renderQueue();void open(entry.relative);if(host.clientWidth<720)setLibrary(false);});files.append(button);
    }
    refreshFileAges();
    pagination();
  }
  function breadcrumbs():void{
    location.replaceChildren();
    const home=document.createElement('button');home.type='button';home.textContent=documentScopeLabel(scopeState.current);
    home.addEventListener('click',()=>{collection.value='';search.value='';renderFiles();setLibrary(true);});location.append(home);
    if(!current)return;
    const key=collectionKey(current),part=document.createElement('button');part.type='button';part.textContent=libraryLabel(key);
    part.addEventListener('click',()=>{collection.value=key;search.value='';renderFiles();setLibrary(true);});
    const separator=document.createElement('span');separator.textContent='›';location.append(separator,part);
    const leaf=document.createElement('span');leaf.textContent=current.split('/').at(-1)??current;leaf.setAttribute('aria-current','page');
    const separator2=document.createElement('span');separator2.textContent='›';location.append(separator2,leaf);
  }
  async function loadCatalog(restore=false):Promise<void>{
    generation++;pendingOpen=false;
    const ticket=++catalogGeneration,scopeTicket=scopeState.capture(),targetScope=scopeState.current;
    status.textContent='Ouverture de la bibliothèque…';
    try{
      const data=await invoke('document_browse',{scope:targetScope,relative:'',read:false,recursive:true}) as {entries:LibraryEntry[];truncated?:boolean;state?:string;version?:string};
      if(ticket!==catalogGeneration||!scopeState.accepts(scopeTicket))return;
      if(targetScope==='aurore'&&data.state!=='available'){
        showCloneState(data.state==='empty'&&data.truncated?'partial':data.state);return;
      }
      cloneVersion=targetScope==='aurore'?data.version:undefined;
      entries=data.entries;truncated=Boolean(data.truncated);
      // Aurore names must not enter the owner's conversation catalog/context queue.
      if(targetScope!=='aurore')window.dispatchEvent(new CustomEvent('wake-document-catalog',{detail:{scope:targetScope,entries,truncated}}));
      const selected=collection.value;collection.replaceChildren(new Option('Tous les projets',''));
      for(const key of [...new Set(entries.map(e=>collectionKey(e.relative)))].sort((a,b)=>libraryLabel(a).localeCompare(libraryLabel(b))))collection.add(new Option(libraryLabel(key),key));
      if([...collection.options].some(o=>o.value===selected))collection.value=selected;
      renderFiles();breadcrumbs();status.textContent=truncated?'Une partie du catalogue est affichée.':targetScope==='aurore'?'Clone lié · '+(cloneVersion??'version inconnue')+' · lecture seule':'';
      if(restore&&!current&&!pendingOpen){
        let saved='';try{saved=localStorage.getItem(stateKey())??'';}catch{/* No saved document. */}
        const initial=entries.find(e=>e.relative===saved)??entries.find(e=>e.relative==='artifacts/projets.html')??shown()[0];
        if(initial)await open(initial.relative);else setLibrary(true);
      }
    }catch(error){if(ticket===catalogGeneration&&scopeState.accepts(scopeTicket)){if(targetScope==='aurore')showCloneState('unavailable');else feedback(error);}}
  }
  async function open(relative:string,record=true,anchor='',historyIndex?:number):Promise<void>{
    const targetScope=scopeState.current;
    remember();const ticket=++generation,scopeTicket=scopeState.capture();pendingOpen=true;status.textContent='Ouverture du document…';
    try{
      const data=await invoke('document_browse',{scope:targetScope,relative,read:true,...(targetScope==='aurore'?{version:cloneVersion}:{})}) as {text:string;format:string;localApp?:unknown;state?:string};
      if(ticket!==generation||!scopeState.accepts(scopeTicket))return;
      if(targetScope==='aurore'&&data.state!=='available'){showCloneState(data.state);return;}
      current=relative;documentScope=targetScope;
      if(record){history=history.slice(0,position+1);if(history.at(-1)!==relative)history.push(relative);position=history.length-1;}
      else if(historyIndex!==undefined)position=historyIndex;
      const key=collectionKey(relative);
      if(collection.value&&collection.value!==key)collection.value='';
      const appUrl=atelierUrl(targetScope,relative,data.localApp);
      if(appUrl){
        frame.onload=null;renderedRelative='';frame.hidden=true;appFrame.hidden=false;
        appFrame.src=appUrl;title.textContent='Atelier DJ · création et mix';
        outline.replaceChildren(new Option('Application interactive',''));outline.disabled=true;
        breadcrumbs();renderFiles();setLibrary(false);
        try{localStorage.setItem(stateKey(),current);}catch{/* Optional storage. */}
        status.textContent='Atelier DJ local · commandes et audio sur action explicite. Si le service supervisé est arrêté, la page est indisponible ; Actualiser après reprise.';
        return;
      }
      closeApp();
      const parsed=parseDocument(data.text,data.format);
      const images=sanitizeDocument(parsed,relative);
      const style=document.createElement('style');style.textContent='html{color-scheme:light;scroll-padding-top:20px}body{font:15px/1.75 system-ui;margin:28px;color:#203f34;overflow-wrap:anywhere}pre{overflow:auto;padding:16px;background:#8882}table{border-collapse:collapse}td,th{border:1px solid #8886;padding:8px}a{color:#238967}img{max-width:100%}';parsed.head.prepend(style);
      title.textContent=parsed.querySelector('h1')?.textContent??documentLabel(entries.find(e=>e.relative===relative)??{name:relative.split('/').at(-1)??relative,relative});
      frame.onload=()=>{
        if(ticket!==generation||!scopeState.accepts(scopeTicket))return;
        const doc=frame.contentDocument;if(!doc)return;
        const version=cloneVersion;
        const imageInvoke:Invoke=(command,args)=>invoke(command,{...args,...(targetScope==='aurore'?{version}:{})});
        void loadDocumentImages(images,doc,targetScope,imageInvoke,()=>ticket===generation&&scopeState.accepts(scopeTicket)&&frame.contentDocument===doc);
        renderedRelative=relative;renderedScope=targetScope;
        outline.replaceChildren(new Option('Aller à une section…',''));
        const usedHeadingIds=new Set<string>();
        let n=0;for(const heading of doc.querySelectorAll('h1,h2,h3')){
          if(!heading.id||usedHeadingIds.has(heading.id)){do{n++;}while(doc.getElementById('wake-section-'+n));heading.id='wake-section-'+n;}
          usedHeadingIds.add(heading.id);
          outline.add(new Option((heading.tagName==='H3'?'↳ ':'')+(heading.textContent??'Section'),heading.id));
        }
        outline.disabled=outline.options.length<=1;
        const stored=positions[targetScope+':'+relative];
        if(anchor)doc.getElementById(anchor)?.scrollIntoView();else if(typeof stored==='number'&&Number.isFinite(stored))frame.contentWindow?.scrollTo(0,stored);
        doc.addEventListener('scroll',()=>{if(ticket===generation&&scopeState.accepts(scopeTicket)&&frame.contentDocument===doc)positions[targetScope+':'+relative]=doc.defaultView?.scrollY??0;},{passive:true});
        doc.addEventListener('click',event=>{
          if(ticket!==generation||!scopeState.accepts(scopeTicket)||frame.contentDocument!==doc)return;
          const link=(event.target as Element|null)?.closest('a');if(!link)return;event.preventDefault();const href=link.getAttribute('href')??'';
          try{
            if(href.startsWith('#')){doc.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView();return;}
            if(/^[a-z][a-z0-9+.-]*:/i.test(href)||href.startsWith('/')||href.startsWith(String.fromCharCode(92))){status.textContent='Ce lecteur ouvre les documents locaux HTML, Markdown et texte brut.';return;}
            const url=new URL(href,'https://documents.invalid/'+relative),path=decodeURIComponent(url.pathname.slice(1));
            if(!/\.(md|markdown|html?|htm|txt)$/i.test(path)){status.textContent='Ce lien ne pointe pas vers un document HTML, Markdown ou texte brut.';return;}
            void open(path,true,decodeURIComponent(url.hash.slice(1)));
          }catch(error){feedback(error);}
        });
      };
      frame.srcdoc='<!doctype html>'+parsed.documentElement.outerHTML;
      breadcrumbs();renderFiles();try{localStorage.setItem(stateKey(),current);}catch{/* Storage is optional. */}
      status.textContent=targetScope==='aurore'?'Clone lié · '+(cloneVersion??'version inconnue')+' · lecture seule':data.format==='html'?'Page HTML · lecture seule':data.format==='text'?'Texte brut · lecture seule':'';
    }catch(error){if(ticket===generation&&scopeState.accepts(scopeTicket)){if(targetScope==='aurore')showCloneState('unavailable');else feedback(error);}}
    finally{if(ticket===generation)pendingOpen=false;}
  }
  explore.addEventListener('click',()=>setLibrary(Boolean(library.hidden)));
  collection.addEventListener('change',()=>{contextMode=false;renderQueue();search.value='';renderFiles();const first=shown()[0];if(first)void open(first.relative);});
  search.addEventListener('input',renderFiles);format.addEventListener('change',renderFiles);
  outline.addEventListener('change',()=>{if(outline.value)frame.contentDocument?.getElementById(outline.value)?.scrollIntoView();});
  back.addEventListener('click',()=>{if(position>0){const index=position-1;void open(history[index]??'',false,'',index);}});
  forward.addEventListener('click',()=>{if(position+1<history.length){const index=position+1;void open(history[index]??'',false,'',index);}});
  const pageClick=(button:HTMLButtonElement):void=>{const relative=button.dataset['relative'];if(!relative)return;if(contextMode&&scopeState.local!==null)requestFile({scope:button.dataset['scope']==='project'?'project':'agent',relative,name:relative.split('/').at(-1)??relative});else void open(relative);};
  previous.addEventListener('click',()=>pageClick(previous));
  next.addEventListener('click',()=>pageClick(next));
  byId('document-latest').addEventListener('click',()=>{contextMode=false;renderQueue();const first=shown()[0];if(first)void open(first.relative);});
  function showCloneState(state:unknown):void{
    generation++;pendingOpen=false;current='';renderedRelative='';entries=[];history=[];position=-1;
    frame.onload=null;closeApp();frame.srcdoc='';outline.replaceChildren(new Option('Sommaire indisponible',''));outline.disabled=true;
    collection.replaceChildren(new Option('Tous les projets',''));
    title.textContent='Atelier d’Aurore';
    status.textContent=state==='not-configured'?'Liaison fichiers non configurée.':state==='invalid-origin'?'Origine du clone invalide.':state==='empty'?'Clone lié sans document lisible.':state==='partial'?'Catalogue du clone partiel · aucun document affiché.':state==='version-changed'?'Version du clone modifiée · actualisez le catalogue.':'Lecture du clone indisponible.';
    breadcrumbs();renderFiles();renderQueue();setLibrary(true);
  }
  function changeScope(value:unknown,restore:boolean,keepContext=false):void{
    remember();scopeHistories.set(scopeState.current,{history:[...history],position});scopeState.select(value);scope.value=scopeState.current;
    generation++;catalogGeneration++;pendingOpen=false;current='';documentScope=scopeState.current;renderedRelative='';
    entries=[];history=[...(scopeHistories.get(scopeState.current)?.history??[])];position=scopeHistories.get(scopeState.current)?.position??-1;cloneVersion=undefined;truncated=false;contextMode=keepContext;collection.replaceChildren(new Option('Tous les projets',''));search.value='';
    frame.onload=null;closeApp();frame.srcdoc='';outline.replaceChildren(new Option('Sommaire indisponible',''));outline.disabled=true;
    collection.disabled=false;search.disabled=false;format.disabled=false;
    byId<HTMLButtonElement>('document-latest').disabled=false;byId<HTMLButtonElement>('document-refresh').disabled=false;
    title.textContent=documentScopeLabel(scopeState.current);renderFiles();breadcrumbs();renderQueue();
    try{localStorage.setItem('mind-wake.reader-scope',scopeState.current);}catch{/* Optional storage. */}
    void loadCatalog(restore);
  }
  scope.addEventListener('change',()=>changeScope(scope.value,true));
  byId('document-refresh').addEventListener('click',()=>{const scopeTicket=scopeState.capture();void (async()=>{await loadCatalog();if(scopeState.accepts(scopeTicket)&&current)await open(current,false);})().catch(error=>{if(scopeState.accepts(scopeTicket))feedback(error);});});
  byId('tab-documents').addEventListener('click',()=>{if(!entries.length)void loadCatalog(true);else setLibrary(Boolean(library.hidden));});
  window.addEventListener('beforeunload',remember);
  window.addEventListener('wake-open-document',event=>{
    const data=(event as CustomEvent<{scope?:string;relative?:string}>).detail;
    if(!data||!['agent','project'].includes(data.scope??'')||typeof data.relative!=='string')return;
    setLibrary(false);
    if(scope.value!==data.scope)changeScope(data.scope,false,contextMode);
    void open(data.relative);
  });
  window.addEventListener('wake-document-queue',event=>{
    const data=(event as CustomEvent<{entries:ContextFile[]}>).detail;if(!Array.isArray(data?.entries))return;
    const seen=new Set<string>();contextQueue=data.entries.filter(file=>{if(!file||!['agent','project'].includes(file.scope)||typeof file.relative!=='string'||typeof file.name!=='string')return false;const key=file.scope+':'+file.relative.toLowerCase();if(seen.has(key))return false;seen.add(key);return true;});
    contextMode=Boolean(contextQueue.length);renderQueue();pagination();
  });
  setLibrary(false);changeScope(scopeState.current,true);
}
