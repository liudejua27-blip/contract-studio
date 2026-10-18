export function pdfFixture(text:string){
 const stream=text?`BT /F1 12 Tf 20 100 Td (${text}) Tj ET`:'';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
 let body='%PDF-1.4\n',offsets=[0];for(let n=0;n<objects.length;n++){offsets.push(body.length);body+=`${n+1} 0 obj\n${objects[n]}\nendobj\n`;}
 const xref=body.length;body+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('');body+=`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;return Buffer.from(body);
}
