const test=require('node:test'),assert=require('node:assert/strict');
const {createMfgProductionPacketPrinter}=require('../manufacturing-v3.js');

test('production packet opens, renders work-order facts and prints',async()=>{
 let html='',printed=0,focused=0,closed=0;
 const popup={document:{write:value=>{html+=value},close:()=>{closed++}},focus:()=>{focused++},print:()=>{printed++}};
 const print=createMfgProductionPacketPrinter({window:{open:()=>popup}});
 assert.equal(print({number:'MWO-20260903-000021',destination:'Amityville Main',machine:'NIGHTHAWK',lifecycleStatus:'Completed',lines:[{sku:'CD2680PHLHSN80',product:'Door',planned:1,good:1,remaining:0}]}),true);
 await new Promise(resolve=>setTimeout(resolve,180));
 assert.match(html,/MWO-20260903-000021/);assert.match(html,/Amityville Main/);assert.match(html,/NIGHTHAWK/);assert.match(html,/CD2680PHLHSN80/);assert.match(html,/NOT A PICK TICKET/);
 assert.equal(closed,1);assert.equal(focused,1);assert.equal(printed,1);
});

test('production packet reports a blocked popup',()=>{
 const print=createMfgProductionPacketPrinter({window:{open:()=>null}});
 assert.equal(print({number:'WO-0021',lines:[]}),false);
});
