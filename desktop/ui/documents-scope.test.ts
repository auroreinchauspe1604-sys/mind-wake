/// <reference types="node" />
import { afterEach, expect, it, vi } from 'vitest';
import { initDocuments } from './documents.js';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
// @ts-expect-error The native-only reader is plain JavaScript, with no TS declaration.
import { browseGitDocuments, ORIGIN } from '../../services/shared-workspace/git-document-reader.mjs';

// Narrow inert DOM surface: exercises actual initDocuments handlers without a browser dependency.
class Element {
  id='';hidden=false;disabled=false;className='';type='';title='';srcdoc='';clientWidth=1000;
  src='';parentElement:Element|null=null;
  dataset:Record<string,string>={};style={cssText:'',display:''};
  children:Element[]=[];private text='';private chosen:string|undefined;
  onload:(()=>void)|null=null;contentDocument=null;
  contentWindow={scrollY:0,scrollTo:()=>{}};
  readonly attributes:Record<string,string>={};
  readonly listeners=new Map<string,((event:unknown)=>void)[]>();
  get textContent():string{return this.text+this.children.map(child=>child.textContent).join('');}
  set textContent(value:string){this.text=value;this.children=[];}
  get value():string{return this.chosen??this.children[0]?.value??'';}
  set value(value:string){this.chosen=value;}
  get options():Element[]{return this.children;}
  append(...children:Element[]):void{this.children.push(...children);}
  replaceChildren(...children:Element[]):void{this.text='';this.chosen=undefined;this.children=[...children];}
  add(child:Element):void{this.append(child);}
  insertBefore(child:Element):void{this.append(child);}
  setAttribute(name:string,value:string):void{this.attributes[name]=value;}
  removeAttribute(name:string):void{delete this.attributes[name];if(name==='src')this.src='';}
  querySelector():null{return null;}
  querySelectorAll():Element[]{return [];}
  addEventListener(name:string,callback:(event:unknown)=>void):void{this.listeners.set(name,[...(this.listeners.get(name)??[]),callback]);}
  dispatchEvent(event:{type:string}):boolean{for(const listener of this.listeners.get(event.type)??[])listener(event);return true;}
}
class Option extends Element {constructor(text:string,value:string){super();this.textContent=text;this.value=value;}}
function fixture(savedScope='agent') {
  vi.useFakeTimers();
  const nodes=new Map<string,Element>();
  const node=(id:string):Element=>{let found=nodes.get(id);if(!found){found=new Element();found.id=id;nodes.set(id,found);}return found;};
  node('document-scope').value='agent';
  node('document-frame').parentElement=node('view-documents');
  const window=new Element(),storage=new Map([['mind-wake.reader-scope',savedScope]]);
  vi.stubGlobal('document',{getElementById:node,createElement:()=>new Element()});
  vi.stubGlobal('window',window);vi.stubGlobal('Option',Option);
  vi.stubGlobal('CustomEvent',class {readonly detail:unknown;constructor(readonly type:string,options:{detail:unknown}){this.detail=options.detail;}});
  vi.stubGlobal('localStorage',{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value)});
  const parse=vi.fn<(...args:unknown[])=>unknown>(()=>{throw Error('A stale local document must not reach the renderer');});
  vi.stubGlobal('DOMParser',class {parseFromString=parse;});
  const requests:{args:Record<string,unknown>;resolve:(value:unknown)=>void;reject:(reason:unknown)=>void}[]=[];
  const invoke=vi.fn((_command:string,args:Record<string,unknown>)=>new Promise((resolve,reject)=>{requests.push({args,resolve,reject});}));
  initDocuments(invoke);
  const select=(value:string):void=>{node('document-scope').value=value;node('document-scope').dispatchEvent({type:'change'});};
  const event=(name:string,detail:unknown):void=>{window.dispatchEvent({type:name,detail} as {type:string});};
  return {node,storage,requests,invoke,select,event,parse};
}
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();});
const tick=async():Promise<void>=>{await Promise.resolve();await Promise.resolve();};

it('opens the native-approved atelier in its own frame and destroys it when leaving its scope',async()=>{
  const f=fixture();
  const app=f.node('view-documents').children.find(child=>child.id==='local-atelier-frame')!;
  expect(app.hidden).toBe(true);
  f.event('wake-open-document',{scope:'agent',relative:'artifacts/creations/atelier-dj/index.html'});
  f.requests.at(-1)!.resolve({text:'<script>instrument</script>',format:'html',localApp:{id:'atelier-dj',url:'http://127.0.0.1:8941/'}});
  await tick();
  expect(f.parse).not.toHaveBeenCalled();expect(app.src).toBe('http://127.0.0.1:8941/');
  expect(app.hidden).toBe(false);expect(f.node('document-frame').hidden).toBe(true);
  expect(f.node('document-title').textContent).toContain('Atelier DJ');
  f.select('aurore');
  expect(app.hidden).toBe(true);expect(f.node('document-frame').hidden).toBe(false);
  expect(app.src).toBe('');
});

it('connects a real committed Git fixture to the Aurore catalog, renderer and scoped image request',async()=>{
  const parent=path.resolve('output/scisense-raccord/fixtures');fs.mkdirSync(parent,{recursive:true});
  const base=fs.mkdtempSync(path.join(parent,'ui-')),clone=path.join(base,'linked-workspaces/aurore-mind-protocol');
  fs.mkdirSync(path.join(clone,'artifacts'),{recursive:true});
  const git=(...args:string[]):string=>execFileSync('git',['-C',clone,...args],{stdio:['ignore','pipe','pipe']}).toString().trim();
  git('init');git('remote','add','origin',ORIGIN);
  fs.writeFileSync(path.join(base,'atelier-aurore.json'),JSON.stringify({enabled:true,origin:ORIGIN}));
  fs.writeFileSync(path.join(clone,'artifacts/PERSONALITY.md'),'# Synthetic fixture\n![sample](sample.png)');
  fs.writeFileSync(path.join(clone,'artifacts/sample.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGD8AAAAASUVORK5CYII=','base64'));
  git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-m','Synthetic fixture');
  const version=git('rev-parse','HEAD'),f=fixture('aurore');
  const head={prepend:vi.fn()},parsed={querySelectorAll:vi.fn(()=>[]),querySelector:vi.fn(()=>null),createElement:()=>new Element(),head,documentElement:{outerHTML:'<html>Sanitized fixture</html>'}};
  f.parse.mockReturnValue(parsed);
  f.requests[0]!.resolve(browseGitDocuments(base,f.requests[0]!.args));await tick();
  expect(f.node('document-files').textContent).toContain('PERSONALITY');
  const read=f.requests.at(-1)!;expect(read.args).toMatchObject({scope:'aurore',version,read:true});
  read.resolve(browseGitDocuments(base,read.args));await tick();
  expect(f.parse).toHaveBeenCalled();expect(f.node('document-frame').srcdoc).toContain('Sanitized fixture');
  expect(f.node('document-status').textContent).toContain(version);
  const image=browseGitDocuments(base,{relative:'artifacts/sample.png',read:true,image:true,version});
  expect(image.state).toBe('available');expect(image.bytes.slice(0,4)).toEqual([137,80,78,71]);
});

it('shows wrong origin and changed version distinctly without a local fallback',async()=>{
  const f=fixture('aurore');f.requests[0]!.resolve({state:'invalid-origin'});await tick();
  expect(f.node('document-status').textContent).toBe('Origine du clone invalide.');
  f.node('document-refresh').dispatchEvent({type:'click'});
  f.requests.at(-1)!.resolve({state:'version-changed'});await tick();
  expect(f.node('document-status').textContent).toContain('Version du clone modifiée');
  expect(f.requests.every(r=>r.args['scope']==='aurore')).toBe(true);
});

it('keeps Aurore Next and history across a visit to another scope',async()=>{
  const f=fixture('aurore');
  f.parse.mockReturnValue({querySelectorAll:()=>[],querySelector:()=>null,createElement:()=>new Element(),head:{prepend:()=>{}},documentElement:{outerHTML:'<html>fixture</html>'}});
  const catalog={state:'available',version:'fixture-version',entries:[{name:'one.html',relative:'one.html'},{name:'two.html',relative:'two.html'}]};
  f.requests[0]!.resolve(catalog);await tick();
  f.requests.at(-1)!.resolve({state:'available',format:'html',text:'one'});await tick();
  f.node('document-next').dispatchEvent({type:'click'});
  expect(f.requests.at(-1)!.args).toMatchObject({scope:'aurore',relative:'two.html',version:'fixture-version'});
  f.requests.at(-1)!.resolve({state:'available',format:'html',text:'two'});await tick();
  f.select('project');const old=f.requests.at(-1)!;f.select('aurore');
  f.requests.at(-1)!.resolve(catalog);await tick();
  f.requests.at(-1)!.resolve({state:'available',format:'html',text:'two'});await tick();
  old.resolve({entries:[{name:'wrong.html',relative:'wrong.html'}]});await tick();
  expect(f.node('document-files').textContent).not.toContain('wrong');
  f.node('document-back').dispatchEvent({type:'click'});
  expect(f.requests.at(-1)!.args).toMatchObject({scope:'aurore',relative:'one.html',read:true});
});

it('restores Aurore through the clone binding with no local file fallback',async()=>{
  const f=fixture('aurore');
  expect(f.node('document-scope').value).toBe('aurore');expect(f.requests[0]?.args['scope']).toBe('aurore');
  f.requests[0]!.resolve({state:'not-configured'});await tick();
  expect(f.node('document-title').textContent).toBe('Atelier d’Aurore');
  expect(f.node('document-status').textContent).toBe('Liaison fichiers non configurée.');
  expect(f.node('document-frame').srcdoc).toBe('');expect(f.node('document-back').disabled).toBe(true);
  expect(f.node('document-next').disabled).toBe(true);expect(f.node('document-sections').disabled).toBe(true);
  expect(f.storage.has('mind-wake.reader-current.aurore')).toBe(false);
});

it('drops late catalogues and document responses after selection, and returns to both local scopes',async()=>{
  const f=fixture();expect(f.requests[0]?.args['scope']).toBe('agent');
  f.event('wake-open-document',{scope:'agent',relative:'private-local.md'});
  expect(f.requests[1]?.args).toMatchObject({scope:'agent',relative:'private-local.md',read:true});
  f.select('aurore');
  f.requests[0]!.resolve({entries:[{name:'Private local',relative:'private-local.md',directory:false}]});
  f.requests[1]!.resolve({text:'<h1>Private local</h1>',format:'html'});await tick();
  expect(f.parse).not.toHaveBeenCalled();expect(f.node('document-frame').srcdoc).toBe('');
  expect(f.node('document-title').textContent).toBe('Atelier d’Aurore');
  expect(f.node('document-files').textContent).not.toContain('private-local');
  expect(f.node('document-back').disabled).toBe(true);expect(f.node('document-forward').disabled).toBe(true);
  expect(f.node('document-next').dataset['relative']).toBe('');
  f.select('project');expect(f.requests.at(-1)?.args['scope']).toBe('project');
  expect(f.node('document-search').disabled).toBe(false);f.requests.at(-1)!.resolve({entries:[]});await tick();
  f.select('agent');expect(f.requests.at(-1)?.args['scope']).toBe('agent');
  expect(f.storage.get('mind-wake.reader-scope')).toBe('agent');
});

it('keeps local context queue navigation out of Aurore and explicitly selects its real scope on open',()=>{
  const f=fixture('aurore');
  f.event('wake-document-queue',{entries:[{scope:'agent',relative:'local.md',name:'local.md'}]});
  const queue=f.node('view-documents').children.find(child=>child.id==='document-context-queue');
  expect(queue?.hidden).toBe(true);expect(f.node('document-next').disabled).toBe(true);
  f.event('wake-open-document',{scope:'agent',relative:'local.md'});
  expect(f.node('document-scope').value).toBe('agent');
  expect(f.requests.map(request=>request.args['scope'])).toEqual(['aurore','agent','agent']);
  expect(f.requests[2]?.args).toMatchObject({read:true,relative:'local.md'});
  expect(f.storage.get('mind-wake.reader-scope')).toBe('agent');
  f.select('aurore');
  expect(f.storage.get('mind-wake.reader-scope')).toBe('aurore');expect(f.storage.has('mind-wake.reader-current.aurore')).toBe(false);
});

it('does not replace the pending notice with an error from a departed local scope',async()=>{
  const f=fixture();f.select('aurore');
  f.requests[1]!.resolve({state:'not-configured'});await tick();
  f.requests[0]!.reject(Error('old local catalogue'));await tick();
  expect(f.node('document-status').textContent).toBe('Liaison fichiers non configurée.');
  expect(f.node('document-refresh').disabled).toBe(false);
  expect(f.node('document-latest').disabled).toBe(false);
});

it('distinguishes empty, partial and unavailable responses without catalog contamination',async()=>{
  const f=fixture('aurore');
  f.requests[0]!.resolve({state:'empty',entries:[],truncated:false});await tick();
  expect(f.node('document-status').textContent).toBe('Clone lié sans document lisible.');
  f.node('document-refresh').dispatchEvent({type:'click'});
  f.requests.at(-1)!.resolve({state:'empty',entries:[],truncated:true});await tick();
  expect(f.node('document-status').textContent).toContain('Catalogue du clone partiel');
  f.node('document-refresh').dispatchEvent({type:'click'});
  f.requests.at(-1)!.reject(Error('secret native path or transport failure'));await tick();
  expect(f.node('document-status').textContent).toBe('Lecture du clone indisponible.');
  expect(f.node('document-frame').srcdoc).toBe('');expect(f.parse).not.toHaveBeenCalled();
});

it('shows a real clone catalog, keeps it out of local events and drops old clone reads on return',async()=>{
  const f=fixture('aurore'),catalogs:unknown[]=[];
  (window as unknown as Element).addEventListener('wake-document-catalog',event=>catalogs.push(event));
  f.requests[0]!.resolve({state:'available',entries:[{name:'REMOTE.md',relative:'REMOTE.md',directory:false}]});await tick();
  expect(f.node('document-files').textContent).toContain('REMOTE');expect(catalogs).toEqual([]);
  expect(f.requests.at(-1)?.args).toMatchObject({scope:'aurore',relative:'REMOTE.md',read:true});
  const old=f.requests.at(-1)!;
  f.select('agent');f.select('aurore');
  old.resolve({state:'available',text:'# Old clone response',format:'markdown'});await tick();
  expect(f.parse).not.toHaveBeenCalled();expect(f.node('document-frame').srcdoc).toBe('');
  expect(f.node('document-files').textContent).not.toContain('REMOTE');
  f.requests.at(-1)!.resolve({state:'not-configured'});await tick();
  expect(f.node('document-status').textContent).toBe('Liaison fichiers non configurée.');
});

it('routes clone text through the existing sanitizer and clears it after revocation',async()=>{
  const f=fixture('aurore');
  f.requests[0]!.resolve({state:'available',entries:[{name:'clone.html',relative:'clone.html'}]});await tick();
  const head={prepend:vi.fn()},root={outerHTML:'<html><body>Sanitized fixture</body></html>'};
  const parsed={querySelectorAll:vi.fn(()=>[]),querySelector:vi.fn(()=>null),createElement:()=>new Element(),head,documentElement:root};
  f.parse.mockReturnValue(parsed);
  f.requests.at(-1)!.resolve({state:'available',text:'<h1>Remote</h1>',format:'html'});await tick();
  expect(f.parse).toHaveBeenCalledWith('<h1>Remote</h1>','text/html');
  expect(head.prepend).toHaveBeenCalled();expect(f.node('document-frame').srcdoc).toContain('Sanitized fixture');
  expect(f.storage.get('mind-wake.reader-current.aurore')).toBe('clone.html');
  expect(f.storage.has('mind-wake.reader-current.agent')).toBe(false);
  f.node('document-refresh').dispatchEvent({type:'click'});
  f.requests.at(-1)!.resolve({state:'unavailable'});await tick();
  expect(f.node('document-frame').srcdoc).toBe('');expect(f.node('document-files').textContent).not.toContain('clone.html');
  expect(f.node('document-back').disabled).toBe(true);
  expect(f.requests.every(request=>request.args['scope']==='aurore')).toBe(true);
});

it('never treats clone pagination as a local message queue even when local context arrives',async()=>{
  const f=fixture('aurore');
  f.event('wake-document-queue',{entries:[{scope:'agent',relative:'LOCAL.md',name:'LOCAL.md'}]});
  f.requests[0]!.resolve({state:'available',entries:[{name:'REMOTE.md',relative:'REMOTE.md'}]});await tick();
  const opens:unknown[]=[];
  (window as unknown as Element).addEventListener('wake-open-document',event=>opens.push(event));
  // The pending read has not completed, so Next selects the first clone page.
  f.node('document-next').dispatchEvent({type:'click'});
  expect(opens).toEqual([]);
  expect(f.requests.at(-1)?.args).toMatchObject({scope:'aurore',relative:'REMOTE.md',read:true});
});
