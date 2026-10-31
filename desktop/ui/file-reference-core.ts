import { messageLinks } from './message-links.js';
/** Pure matching against known local documents; no filesystem or DOM access. */
export type FileScope = 'agent' | 'project';
export interface KnownFile { scope:FileScope; relative:string; name:string }
export interface FileCatalog { scope:FileScope; entries:readonly {relative:string;name?:string}[] }
export interface FileMention { start:number; end:number; text:string; files:KnownFile[] }

interface Span { start:number; end:number }
interface Index { aliases:Map<string,KnownFile[]>; matcher:RegExp|null }
let previousCatalogs:readonly FileCatalog[]=[];
let previousIndex:Index|null=null;

function normalizeReference(value:string):string|null {
  const slash=value.trim().replaceAll('\\','/');
  if(!slash||slash.startsWith('/')||/^[a-z][a-z0-9+.-]*:/i.test(slash)||/[\u0000-\u001f<>:"|?*]/.test(slash))return null;
  const parts=slash.split('/');
  if(parts.some(p=>p==='..'||p===''))return null;
  const normalized=parts.filter(p=>p!=='.').join('/');
  return /\.(?:md|markdown|html?|htm|txt)$/i.test(normalized)?normalized:null;
}
const key=(value:string):string=>value.toLowerCase();
const escapeRegex=(value:string):string=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

function indexFor(catalogs:readonly FileCatalog[]):Index {
  if(previousIndex&&catalogs.length===previousCatalogs.length&&catalogs.every((c,i)=>c===previousCatalogs[i]))return previousIndex;
  const aliases=new Map<string,KnownFile[]>(),patterns=new Map<string,string>();
  const add=(alias:string,file:KnownFile):void=>{
    const normalized=key(alias),matches=aliases.get(normalized)??[];
    if(!matches.some(m=>m.scope===file.scope&&key(m.relative)===key(file.relative)))matches.push(file);
    aliases.set(normalized,matches);patterns.set(normalized,alias.split('/').map(escapeRegex).join('[\\\\/](?:\\.[\\\\/])*'));
  };
  for(const catalog of catalogs){
    if(catalog.scope!=='agent'&&catalog.scope!=='project')continue;
    for(const entry of catalog.entries){
      const relative=normalizeReference(entry.relative);if(!relative)continue;
      const name=relative.split('/').at(-1)!;
      const file:KnownFile={scope:catalog.scope,relative,name};add(relative,file);add(name,file);
    }
  }
  const alternatives=[...patterns.entries()].sort((a,b)=>b[0].length-a[0].length).map(([,pattern])=>pattern);
  const matcher=alternatives.length?new RegExp('(?:\\.[\\\\/])*(?:'+alternatives.join('|')+')','giu'):null;
  previousCatalogs=[...catalogs];previousIndex={aliases,matcher};return previousIndex;
}
const overlaps=(start:number,end:number,spans:readonly Span[]):boolean=>spans.some(s=>start<s.end&&end>s.start);

function fencedSpans(text:string):Span[]{
  const spans:Span[]=[];
  let active:{start:number;char:string;length:number}|null=null,offset=0;
  for(const line of text.split(/(?<=\n)/)){
    const fence=/^[ \t]*(`{3,}|~{3,})(.*?)(?:\r?\n)?$/.exec(line);
    if(fence){
      if(!active)active={start:offset,char:fence[1]![0]!,length:fence[1]!.length};
      else if(fence[1]![0]===active.char&&fence[1]!.length>=active.length&&!fence[2]!.trim()){
        spans.push({start:active.start,end:offset+line.length});active=null;
      }
    }
    offset+=line.length;
  }
  if(active)spans.push({start:active.start,end:text.length});return spans;
}

/** Offsets are JavaScript UTF-16 offsets, suitable for splitting a DOM text node. */
export function findFileMentions(text:string,catalogs:readonly FileCatalog[]):FileMention[]{
  const index=indexFor(catalogs);if(!index.matcher||!text)return [];
  const protectedSpans=[...fencedSpans(text),...messageLinks(text).map(({start,end})=>({start,end}))],mentions:FileMention[]=[];
  const protect=(regex:RegExp):void=>{for(const m of text.matchAll(regex))protectedSpans.push({start:m.index,end:m.index+m[0].length});};
  // Protocols, web addresses and email are never treated as local filenames.
  protect(/\b[a-z][a-z0-9+.-]*:[^\s<>"'`]+/gi);
  protect(/\bwww\.[^\s<>"'`]+/gi);
  protect(/[^\s<>"'`@]+@[^\s<>"'`@]+\.[^\s<>"'`@]+/g);
  // Conservative protection for quoted/unquoted paths with spaces outside our roots.
  protect(/(?:^|(?<=[\s("'`]))[a-z]:[\\/][^\r\n"'<>`),;]*/gim);
  protect(/(?:^|(?<=[\s("'`]))(?:\\\\|\/|\.\.[\\/])[^\r\n"'<>`),;]*/gm);

  const ticks=/`+/g;
  let opening:RegExpExecArray|null;
  while((opening=ticks.exec(text))!==null){
    const start=opening.index;if(overlaps(start,ticks.lastIndex,protectedSpans))continue;
    const length=opening[0].length,innerStart=ticks.lastIndex;
    let closing:RegExpExecArray|null=null,run:RegExpExecArray|null;
    while((run=ticks.exec(text))!==null){if(run[0].length===length){closing=run;break;}}
    if(!closing){protectedSpans.push({start,end:text.indexOf('\n',start)<0?text.length:text.indexOf('\n',start)});break;}
    const blocked=overlaps(innerStart,closing.index,protectedSpans);
    const end=closing.index+length;protectedSpans.push({start,end});
    const raw=text.slice(innerStart,closing.index),trimmed=raw.trim();
    if(blocked||/[\r\n]/.test(raw))continue;
    const normalized=normalizeReference(trimmed),files=normalized?index.aliases.get(key(normalized)):undefined;
    if(files?.length){const matchStart=innerStart+raw.indexOf(trimmed);mentions.push({start:matchStart,end:matchStart+trimmed.length,text:trimmed,files:[...files]});}
  }
  const boundary=/[\p{L}\p{N}_@%~+./\\-]/u;
  index.matcher.lastIndex=0;
  for(const match of text.matchAll(index.matcher)){
    const start=match.index,end=start+match[0].length;
    const trailingPunctuation=/^\.+(?:$|(?=[\s"'`»…!?;:()[\]{}<>]))/u.test(text.slice(end));
    if(overlaps(start,end,protectedSpans)||start>0&&boundary.test(text[start-1]!)||end<text.length&&boundary.test(text[end]!)&&!trailingPunctuation)continue;
    const normalized=normalizeReference(match[0]),files=normalized?index.aliases.get(key(normalized)):undefined;
    if(files?.length)mentions.push({start,end,text:match[0],files:[...files]});
  }
  return mentions.sort((a,b)=>a.start-b.start||b.end-a.end);
}
