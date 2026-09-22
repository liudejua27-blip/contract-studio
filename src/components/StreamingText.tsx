'use client';
import {memo} from 'react';
/** Completed paragraphs retain their DOM while the last paragraph grows. Text remains escaped. */
const Paragraph=memo(function Paragraph({text}:{text:string}){
 const parts=text.split(/(\*\*[^*]+\*\*)/g).map((s,i)=>s.startsWith('**')&&s.endsWith('**')?<strong key={i}>{s.slice(2,-2)}</strong>:s);
 if(/^#{1,3} /.test(text))return <h3>{text.replace(/^#{1,3} /,'')}</h3>;
 return <p>{parts}</p>;
});
export const StreamingText=memo(function StreamingText({text}:{text:string}){
 return <div className="streaming-text">{text.split(/\n\s*\n/).map((block,i)=><Paragraph key={i} text={block}/>)}</div>;
});
