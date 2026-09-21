// Browser plugin is not available in this session; use local Playwright against isolated fixture service.
import {chromium,expect} from '@playwright/test';
import {intakeFixture} from '../tests/fixtures';
import {mkdir} from 'node:fs/promises';
async function main(){
const browser=await chromium.launch({headless:true,channel:'chrome'});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:3217');await page.getByLabel('邮箱',{exact:true}).fill('stream@example.test');await page.getByLabel('密码',{exact:true}).fill('Local-QA-only-2026!');await page.getByRole('button',{name:'登录',exact:true}).click();
 const text=Object.values(intakeFixture('purchase').facts).map(f=>f.quote).join('；');
 await page.locator('.start-composer textarea').fill('我要采购商品，'+text);await page.locator('.start-composer button').click();
 const progress=page.getByRole('region',{name:'合同助手实时进度'});
 await expect(progress).toBeVisible();await expect(progress.getByText('整理需求',{exact:true})).toBeVisible();
 const timer=progress.locator('.agent-elapsed');const before=await timer.textContent();await expect(timer).not.toHaveText(before!);
 await expect(page.getByRole('button',{name:'按这些约定起草',exact:true})).toBeVisible({timeout:30000});await page.getByRole('button',{name:'按这些约定起草',exact:true}).click();
 await expect(progress.locator('.agent-live-preview')).toBeVisible({timeout:15000});const initial=await progress.locator('.agent-preview-meta').textContent();await expect(progress.locator('.agent-preview-meta')).not.toHaveText(initial!);
 await mkdir('.data/qa',{recursive:true});await page.screenshot({path:'.data/qa/progress-desktop.png'});
 await page.setViewportSize({width:390,height:844});await expect(page.locator('.sidebar')).not.toBeInViewport();await page.screenshot({path:'.data/qa/progress-mobile.png'});
 const box=await progress.boundingBox();if(!box||box.x<0||box.x+box.width>391)throw new Error('Progress overflows mobile viewport');
 await page.getByRole('button',{name:'收起生成详情'}).click();await expect(progress.locator('.agent-live-preview')).toHaveCount(0);await page.getByRole('button',{name:'展开生成详情'}).click();
 await expect(progress.locator('.agent-steps .current')).toHaveText('核对约定',{timeout:30000});await expect(progress.locator('.agent-live-preview')).toBeVisible();
 await expect(progress).toHaveCount(0,{timeout:30000});await expect(page.getByRole('button',{name:'提交律师审核',exact:true})).toBeVisible();
 if(errors.length)throw new Error(errors.join('\n'));console.log('PASS: timer, streamed text, mobile fit, collapse, verification preview and completed handoff; no page errors');
}finally{await browser.close()}

}
main().catch(e=>{console.error(e);process.exitCode=1});
