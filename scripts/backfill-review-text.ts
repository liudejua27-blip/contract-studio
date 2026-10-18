import {createHash} from 'node:crypto';
import {closeDatabase,query} from '../src/server/db';
import {extractDocxText,storage} from '../src/server/documents';

type Row={id:string;file_key:string;sha256:string|null;created_at:Date};

async function main(){
  const count=Number((await query<{n:string}>("SELECT count(*)::text AS n FROM versions WHERE source='lawyer' AND text_content IS NULL")).rows[0]?.n??0);
  if(!process.argv.includes('--apply')){console.log(JSON.stringify({apply:false,pending:count}));return}
  let updated=0,skipped=0,cursorDate:Date|null=null,cursorId='';
  for(;;){
    const page:{rows:Row[]}=await query<Row>(`SELECT id,file_key,sha256,created_at FROM versions
      WHERE source='lawyer' AND text_content IS NULL
        AND ($1::timestamptz IS NULL OR (created_at,id)>($1::timestamptz,$2))
      ORDER BY created_at,id LIMIT 100`,[cursorDate,cursorId]);
    if(!page.rows.length)break;
    for(const row of page.rows){
      cursorDate=row.created_at;cursorId=row.id;
      try{
        const bytes=await storage.get(row.file_key);
        if(!bytes||!row.sha256||createHash('sha256').update(bytes).digest('hex')!==row.sha256){skipped++;continue}
        const text=extractDocxText(bytes).slice(0,100_000);
        if(!text){skipped++;continue}
        const changed=await query('UPDATE versions SET text_content=$1 WHERE id=$2 AND sha256=$3 AND text_content IS NULL',[text,row.id,row.sha256]);
        updated+=changed.rowCount??0;
      }catch{skipped++}
    }
  }
  console.log(JSON.stringify({apply:true,pending:count,updated,skipped}));
  if(skipped)process.exitCode=2;
}

main().catch(()=>{console.error('Review-text backfill failed; check private database and storage configuration.');process.exitCode=1}).finally(closeDatabase);
