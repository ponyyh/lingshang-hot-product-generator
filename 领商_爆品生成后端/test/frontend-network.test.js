const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../../领商_爆品生成网站/api.js'),'utf8');
function client(fetchImpl){
 const window={crypto:{randomUUID:()=> 'retry_test_request_123456'},localStorage:{getItem:()=> 'mock_token_123'}};
 vm.runInNewContext(source,{window,fetch:fetchImpl,AbortController,URLSearchParams,Blob,setTimeout:(fn,ms)=>setTimeout(fn,ms===500?0:ms),clearTimeout});
 return window.LingShangAPI;
}
test('browser recovers a transport disconnect with the same idempotency key and no prototype auth header',async()=>{
 const calls=[];const api=client(async(url,options)=>{calls.push(options);if(calls.length===1)throw new TypeError('Failed to fetch');return new Response(JSON.stringify({code:0,data:{title:'手机背壳保护套'}}));});
 assert.equal((await api.recognizeHotProduct({productIds:[1,2],hotLink:'https://example.com'})).title,'手机背壳保护套');
 assert.equal(calls.length,2);assert.equal(calls[0].headers['X-Idempotency-Key'],calls[1].headers['X-Idempotency-Key']);assert.equal(calls[0].headers.Authorization,undefined);
});
test('browser never repeats a business rejection and gives readable network failure after bounded retry',async()=>{
 let calls=0;const rejected=client(async()=>{calls++;return new Response(JSON.stringify({message:'当前商品信息不足'}),{status:422});});
 await assert.rejects(rejected.recognizeHotProduct({productIds:[1],hotLink:'https://example.com'}),/当前商品信息不足/);assert.equal(calls,1);
 calls=0;const failed=client(async()=>{calls++;throw new TypeError('Failed to fetch');});
 await assert.rejects(failed.recognizeHotProduct({productIds:[1],hotLink:'https://example.com'}),/网站连接中断/);assert.equal(calls,2);
});
