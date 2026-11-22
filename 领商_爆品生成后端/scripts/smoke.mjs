import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const { readXlsx }=require('../src/xlsx');
const base=process.argv[2]||'http://127.0.0.1:8787';
const hotLink=process.argv[3]||'【淘宝】https://e.tb.cn/h.joY6anRFHJUyeov?tk=dSyD6gY2v4Z 「图拉斯适用苹果18ProMax磁吸手机壳新款iPhone17超薄16pro带支架15磨砂14保护套13p全包pm防摔环保无毒系列ip」 点击链接直接打开';
async function json(route,body){const r=await fetch(base+route,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const data=await r.json();assert.equal(data.code,0,data.message);return data.data;}
const health=await json('/api/health');assert.equal(health.agentConfigured,true);
const catalog=await json('/api/products');assert.ok(catalog.list.length);
const product=catalog.list[0];const generated=await json('/api/agent/hot-product/recognize',{productIds:[product.id],hotLink});assert.ok(generated.extractedInfo.keywords.length);
const exported=await fetch(base+'/api/hot-product/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({productIds:[product.id],hotLink,title:generated.title,taskId:generated.taskId})});assert.match(exported.headers.get('content-type'),/spreadsheetml/);
const x=readXlsx(Buffer.from(await exported.arrayBuffer()));assert.equal(x.rows[0].length,69);assert.equal(x.rows.length,2);assert.equal(x.rows[1][0],generated.title+' '+product.name);assert.equal(x.rows[1][11],product.skuCode);
console.log(JSON.stringify({status:'passed',base,title:generated.title,keywords:generated.extractedInfo.keywords,workflowRunId:generated.extractedInfo.workflowRunId,sheet:x.sheetName,columns:69,sku:product.skuCode}));
