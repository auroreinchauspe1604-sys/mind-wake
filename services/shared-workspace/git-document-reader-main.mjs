import { browseGitDocuments } from './git-document-reader.mjs';
let input='';
try {
  for await (const chunk of process.stdin) {input+=chunk;if(Buffer.byteLength(input)>8192)throw Error('input');}
  process.stdout.write(JSON.stringify(browseGitDocuments(process.env.MIND_WAKE_DATA_DIR, JSON.parse(input))));
} catch {process.stdout.write(JSON.stringify({state:'error'}));}
