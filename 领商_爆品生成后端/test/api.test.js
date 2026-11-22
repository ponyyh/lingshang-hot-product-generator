const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createHandler } = require('../src/app');
const { loadConfig } = require('../src/config');
const { readXlsx } = require('../src/xlsx');
const { parseShareInput } = require('../src/shareInput');
const { validatePrefix } = require('../src/dify');
const { getProductsByIds } = require('../src/products');
const SHARE='【淘宝】https://e.tb.cn/h.joY6anRFHJUyeov?tk=dSyD6gY2v4Z 「图拉斯磁吸手机壳带支架磨砂保护套」 点击链接直接打开';
const TITLE='手机背壳保护套';
async function fixture(t, opts={}) {
 const calls=[]; const config=loadConfig({AUTH_REQUIRED:'false',DIFY_API_KEY:'secret-test',...opts.env});
 const handler=createHandler({config,log:()=>{},fetchImpl:async(url,options)=>{
  calls.push({url,body:JSON.parse(options.body),headers:options.headers});
  if(opts.throwError)throw opts.throwError;
  return new Response(JSON.stringify(opts.payload||{workflow_run_id:'wf-1',data:{status:'succeeded',outputs:{title:TITLE,keywords:['手机壳','磁吸','支架']}}}),{status:opts.status||200});
 }});
 const server=http.createServer(handler); await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>server.close(r)));
 const base=`http://127.0.0.1:${server.address().port}`;
 const request=async(route,body)=>fetch(base+route,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const json=async(route,body)=>(await request(route,body)).json();
 return {base,request,json,calls};
}
test('share text extracts exact URL and title; URL-only never invents title',()=>{
 assert.equal(parseShareInput(SHARE).title,'图拉斯磁吸手机壳带支架磨砂保护套');
 assert.equal(parseShareInput('https://example.com/item').title,'');
 assert.throws(()=>parseShareInput('javascript:alert(1)'));
});
test('catalog picker fields match exact template rows and search handles pagination',async t=>{
 const x=readXlsx(fs.readFileSync(path.join(__dirname,'../templates/product_list.xlsx')));
 const f=await fixture(t);const result=await f.json('/api/products');
 assert.equal(result.data.total,x.rows.length-1);
 for(let i=0;i<result.data.list.length;i++){
  const p=result.data.list[i],row=x.rows[i+1],cell=name=>row[x.rows[0].indexOf(name)];
  assert.equal(p.name,cell('产品标题'));assert.equal(p.color,cell('变种属性值一'));
  assert.equal(p.weight,cell('重量'));assert.equal(p.price,cell('申报价格'));assert.equal(p.packaging,cell('外包装形状'));
 }
 assert.equal((await f.json('/api/products?keyword=NO-MATCH')).data.total,0);
 assert.equal((await f.json('/api/products?pageSize=0')).code,40001);
});
test('recognize invokes Dify Workflow with secret only server-side and correct SKU attributes',async t=>{
 const f=await fixture(t);const r=await f.json('/api/agent/hot-product/recognize',{productIds:[1],hotLink:SHARE});
 assert.equal(r.code,0);assert.equal(r.data.title,TITLE);assert.deepEqual(r.data.extractedInfo.keywords,['手机壳','磁吸','支架']);
 assert.equal(f.calls[0].url,'https://api.dify.ai/v1/workflows/run');
 assert.equal(f.calls[0].body.inputs.hot_title,'图拉斯磁吸手机壳带支架磨砂保护套');
 assert.match(f.calls[0].body.inputs.product_info,/TPU/);assert.match(f.calls[0].body.inputs.product_info,/UV打印/);
 assert.equal(f.calls[0].headers.Authorization,'Bearer secret-test');assert.ok(!JSON.stringify(r).includes('secret-test'));
});
test('regeneration preserves task id and passes previous title',async t=>{
 const f=await fixture(t);const r=await f.json('/api/agent/hot-product/regenerate-title',{taskId:'task_keep',productIds:[1],hotLink:SHARE,previousTitle:'旧标题'});
 assert.equal(r.code,0);assert.equal(r.data.taskId,'task_keep');assert.equal(f.calls[0].body.inputs.previous_title,'旧标题');
});
test('empty keywords and upstream errors stop generation without exposing secrets',async t=>{
 for(const payload of [{data:{status:'succeeded',outputs:{title:TITLE,keywords:[]}}},{data:{status:'failed',error:'secret-test upstream'}}]){
  const f=await fixture(t,{payload});const r=await f.json('/api/agent/hot-product/recognize',{productIds:[1],hotLink:SHARE});
  assert.notEqual(r.code,0);assert.ok(!JSON.stringify(r).includes('secret-test'));
 }
});
test('rewritten branch outputs accepted',async t=>{
 const f=await fixture(t,{payload:{data:{status:'succeeded',outputs:{rewritten_title:TITLE,rewritten_keywords:['手机壳']}}}});
 assert.equal((await f.json('/api/agent/hot-product/recognize',{productIds:[1],hotLink:SHARE})).code,0);
});
test('unconfigured Dify and timeout fail clearly',async t=>{
 const f=await fixture(t,{env:{DIFY_API_KEY:''}});assert.equal((await f.json('/api/agent/hot-product/recognize',{productIds:[1],hotLink:SHARE})).code,50301);
 const g=await fixture(t,{throwError:new DOMException('timeout','TimeoutError')});assert.equal((await g.json('/api/agent/hot-product/recognize',{productIds:[1],hotLink:SHARE})).code,50401);
});
test('unsupported features and brand/model prefixes are blocked even on manual export',async t=>{
 const products=getProductsByIds([1,2]).products;
 for(const title of ['磁吸支架TPU手机壳','图拉斯糖果色手机壳','苹果透明防摔手机壳'])assert.throws(()=>validatePrefix(title,products));
 const f=await fixture(t);assert.notEqual((await f.json('/api/hot-product/export',{productIds:[1],hotLink:SHARE,title:'磁吸支架TPU手机壳'})).code,0);
});
test('export retains 69 columns, sheet name, selected row order, suffixes and all untouched cells',async t=>{
 const f=await fixture(t);const response=await f.request('/api/hot-product/export',{productIds:[2,1],hotLink:SHARE,title:TITLE});
 assert.match(response.headers.get('content-type'),/spreadsheetml/);
 const out=readXlsx(Buffer.from(await response.arrayBuffer()));const src=readXlsx(fs.readFileSync(path.join(__dirname,'../templates/product_list.xlsx')));
 assert.equal(out.sheetName,src.sheetName);assert.equal(out.rows[0].length,69);assert.deepEqual(out.rows[0],src.rows[0]);
 for(const [i,id]of [2,1].entries())for(let col=0;col<69;col++){
  const name=src.rows[0][col],original=src.rows[id][col]||'',actual=out.rows[i+1][col]||'';
  if(name==='产品标题')assert.equal(actual,TITLE+' '+original);
  else if(name==='来源URL')assert.equal(actual,parseShareInput(SHARE).url);
  else if(name==='更新时间')assert.match(actual,/^\d{4}-\d{2}-\d{2}/);
  else assert.equal(actual,original,`row ${id} ${name}`);
 }
});
test('bad products, invalid links and malformed JSON rejected before Dify',async t=>{
 const f=await fixture(t);for(const body of [{productIds:[],hotLink:SHARE},{productIds:[9999],hotLink:SHARE},{productIds:[1],hotLink:'bad'}])assert.equal((await f.json('/api/agent/hot-product/recognize',body)).code,40001);
 assert.equal(f.calls.length,0);
 const r=await fetch(f.base+'/api/agent/hot-product/recognize',{method:'POST',body:'{'});assert.equal((await r.json()).code,40001);
});
test('public demo bounds paid generation requests per minute',async t=>{
 const f=await fixture(t);for(let i=0;i<10;i++)assert.equal((await f.json('/api/agent/hot-product/recognize',{productIds:[1],hotLink:SHARE})).code,0);
 assert.equal((await f.json('/api/agent/hot-product/recognize',{productIds:[1],hotLink:SHARE})).code,42901);assert.equal(f.calls.length,10);
});
test('health and routing remain available',async t=>{
 const f=await fixture(t);const h=await f.json('/api/health');assert.equal(h.data.agentConfigured,true);assert.equal(h.data.authRequired,false);
 assert.equal((await f.request('/api/unknown')).status,404);assert.equal((await f.request('/api/products',{})).status,405);
 assert.equal((await fetch(f.base+'/api/products',{method:'OPTIONS'})).status,204);
});


test('documented silicone molding is a process, while unsupported silicone material remains blocked',()=>{
 const single=getProductsByIds([1]).products;
 assert.equal(validatePrefix('TPU糖果色手机壳UV打印注塑硅胶成型',single),'TPU糖果色手机壳UV打印注塑硅胶成型');
 assert.throws(()=>validatePrefix('液态硅胶手机壳保护套',single));
 assert.throws(()=>validatePrefix('硅胶成型液态硅胶手机壳',single));
 assert.throws(()=>validatePrefix('硅胶成型手机壳保护套',getProductsByIds([2]).products));
});
