import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {browseGitDocuments,ORIGIN} from './git-document-reader.mjs';
const parent=path.resolve('output/scisense-raccord/fixtures');fs.mkdirSync(parent,{recursive:true});
function fixture(){
 const base=fs.mkdtempSync(path.join(parent,'git-')),clone=path.join(base,'linked-workspaces/aurore-mind-protocol');fs.mkdirSync(clone,{recursive:true});
 const git=(...args)=>execFileSync('git',['-C',clone,...args],{windowsHide:true,stdio:['ignore','pipe','pipe']}).toString().trim();
 git('init');git('remote','add','origin',ORIGIN);
 const enable=()=>fs.writeFileSync(path.join(base,'atelier-aurore.json'),JSON.stringify({enabled:true,origin:ORIGIN}));
 const browse=(request={relative:'',read:false})=>browseGitDocuments(base,request);
 const commit=()=>{git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-m','Synthetic fixture only');return git('rev-parse','HEAD');};
 return {base,clone,git,enable,browse,commit};
}
test('inert default, disabled and path configuration cannot grant arbitrary access',()=>{
 const f=fixture();assert.equal(browseGitDocuments(undefined,{}).state,'not-configured');assert.equal(f.browse().state,'not-configured');
 fs.writeFileSync(path.join(f.base,'atelier-aurore.json'),JSON.stringify({enabled:false}));assert.equal(f.browse().state,'not-configured');
 fs.writeFileSync(path.join(f.base,'atelier-aurore.json'),JSON.stringify({enabled:true,origin:ORIGIN,clonePath:f.base}));assert.equal(f.browse().state,'invalid-origin');
});
test('linked unborn clone is empty and wrong origin is distinct',()=>{
 const f=fixture();f.enable();assert.deepEqual(f.browse(),{state:'empty',entries:[],version:null});
 f.git('remote','set-url','origin','https://github.com/nlr-ai/other.git');assert.equal(f.browse().state,'invalid-origin');
});
test('Git commit -> versioned catalog -> committed Markdown and image, no local fallback',()=>{
 const f=fixture();f.enable();fs.mkdirSync(path.join(f.clone,'artifacts'));fs.writeFileSync(path.join(f.clone,'artifacts/PERSONALITY.md'),'# Synthetic fixture\n![sample](sample.png)');
 fs.writeFileSync(path.join(f.clone,'artifacts/sample.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGD8AAAAASUVORK5CYII=','base64'));
 const version=f.commit();fs.writeFileSync(path.join(f.clone,'MARCO.md'),'must never appear');fs.writeFileSync(path.join(f.clone,'artifacts/PERSONALITY.md'),'uncommitted replacement');
 const catalog=f.browse();assert.equal(catalog.state,'available');assert.equal(catalog.version,version);assert.deepEqual(catalog.entries.map(e=>e.relative),['artifacts/PERSONALITY.md']);
 const doc=f.browse({relative:'artifacts/PERSONALITY.md',read:true,version});assert.match(doc.text,/# Synthetic fixture/);assert.equal(doc.format,'markdown');
 const image=f.browse({relative:'artifacts/sample.png',read:true,image:true,version});assert.equal(image.state,'available');assert.equal(Buffer.from(image.bytes).subarray(0,8).toString('hex'),'89504e470d0a1a0a');
 assert.equal(f.browse({relative:'MARCO.md',read:true,version}).state,'error');
 assert.equal(f.browse({relative:'artifacts/PERSONALITY.md',read:true,version:'0'.repeat(40)}).state,'version-changed');
 const output=execFileSync(process.execPath,['services/shared-workspace/git-document-reader-main.mjs'],{input:JSON.stringify({relative:'',read:false}),env:{...process.env,MIND_WAKE_DATA_DIR:f.base}});
 assert.equal(JSON.parse(output).version,version);
});
test('traversal, absolute paths, outbound junction and tracked Git symlink are refused',()=>{
 const f=fixture();f.enable();fs.writeFileSync(path.join(f.clone,'safe.md'),'fixture');
 fs.mkdirSync(path.join(f.clone,'escape'));fs.writeFileSync(path.join(f.clone,'escape/secret.md'),'tracked fixture');f.commit();
 for(const relative of ['../safe.md','C:/Windows/a.md','/safe.md','safe.md:stream','https://host/a.md']) assert.equal(f.browse({relative,read:true}).state,'error');
 const outside=path.join(f.base,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'secret.md'),'outside');
 // A real Windows junction requires no symlink privilege.
 fs.renameSync(path.join(f.clone,'escape'),path.join(f.clone,'original-folder'));
 fs.symlinkSync(outside,path.join(f.clone,'escape'),'junction');assert.equal(f.browse({relative:'escape/secret.md',read:true}).state,'error');
 assert(!f.browse().entries.some(e=>e.relative==='escape/secret.md'));
 // Build a symlink index record without requiring Windows symlink creation.
 const target=execFileSync('git',['-C',f.clone,'hash-object','-w','--stdin'],{input:'../outside/secret.md'}).toString().trim();
 f.git('update-index','--add','--cacheinfo','120000',target,'out.md');f.git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-m','Synthetic link');
 assert(!f.browse().entries.some(e=>e.relative==='out.md'));assert.equal(f.browse({relative:'out.md',read:true}).state,'error');
});
test('missing origin is invalid and a junction cannot replace the dedicated clone',()=>{
 const f=fixture();f.enable();f.git('remote','remove','origin');assert.equal(f.browse().state,'invalid-origin');
 const other=fixture();other.enable();fs.renameSync(other.clone,other.clone+'-moved');
 fs.symlinkSync(other.clone+'-moved',other.clone,'junction');assert.equal(other.browse().state,'error');
});
test('missing clone is error, never another scope; corrupt HEAD is not empty',()=>{
 const f=fixture();f.enable();fs.writeFileSync(path.join(f.clone,'.git/HEAD'),'ref: refs/heads/main\n');fs.mkdirSync(path.join(f.clone,'.git/refs/heads'),{recursive:true});fs.writeFileSync(path.join(f.clone,'.git/refs/heads/main'),'a'.repeat(40)+'\n');assert.equal(f.browse().state,'error');
 const other=fixture();other.enable();fs.renameSync(other.clone,other.clone+'-moved');assert.equal(other.browse().state,'error');
});

test('replacement refs and inherited Git environment cannot substitute committed blobs',()=>{
 const f=fixture();f.enable();fs.writeFileSync(path.join(f.clone,'safe.md'),'original committed text');const version=f.commit();
 const oid=f.git('rev-parse','HEAD:safe.md');const substitute=execFileSync('git',['-C',f.clone,'hash-object','-w','--stdin'],{input:'substituted text'}).toString().trim();
 f.git('replace',oid,substitute);
 const old=process.env.GIT_DIR;process.env.GIT_DIR=path.join(f.base,'unrelated');
 try{assert.equal(f.browse({relative:'safe.md',read:true,version}).text,'original committed text');}finally{if(old===undefined)delete process.env.GIT_DIR;else process.env.GIT_DIR=old;}
});

test('origin comparison preserves whitespace and rejects duplicate or empty values',()=>{
 const f=fixture();f.enable();f.git('config','remote.origin.url',ORIGIN+' ');assert.equal(f.browse().state,'invalid-origin');
 f.git('config','remote.origin.url',ORIGIN);f.git('config','--add','remote.origin.url','');assert.equal(f.browse().state,'invalid-origin');
 f.git('config','--unset-all','remote.origin.url');f.git('config','--add','remote.origin.url',ORIGIN);f.git('config','--add','remote.origin.url',ORIGIN);assert.equal(f.browse().state,'invalid-origin');
});
