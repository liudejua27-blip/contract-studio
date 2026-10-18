import test from 'node:test';
import assert from 'node:assert/strict';
import {safePreviewImage} from '../src/lib/document-preview';
test('preview retains ZIP raster images with generic MIME while refusing active and remote sources',()=>{
 const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]).toString('base64');
 assert.equal(safePreviewImage('data:application/octet-stream;base64,'+png),'data:image/png;base64,'+png);
 const svg=Buffer.from('<svg onload="alert(1)"></svg>').toString('base64');
 for(const source of ['javascript:alert(1)','https://example.test/tracker.png','data:image/png;base64,'+svg,'data:application/octet-stream;base64,'+svg])assert.equal(safePreviewImage(source),undefined);
});
