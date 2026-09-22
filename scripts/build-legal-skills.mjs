import {readdir,readFile,writeFile} from 'node:fs/promises';
import {join,relative} from 'node:path';
const base='vendor/legal-skills/skills/legal',files={};
async function walk(dir){for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const path=join(dir,entry.name);if(entry.isDirectory())await walk(path);else if(entry.name.endsWith('.md'))files[relative(base,path)]=await readFile(path,'utf8');}}
await walk(base);
for(const name of ['transaction-contract','contract-word'])files['platform/'+name+'/SKILL.md']=await readFile('skills/'+name+'/SKILL.md','utf8');
await writeFile('src/server/agent/legal-skills.generated.json',JSON.stringify(files,null,2)+'\n');
console.log(`Bundled ${Object.keys(files).length} pinned legal skill documents`);
