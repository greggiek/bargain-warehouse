const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const createDrawerLifecycle=require('../manufacturing-v3.js');

class Classes{
  constructor(){this.values=new Set()}
  add(value){this.values.add(value)}
  remove(value){this.values.delete(value)}
  contains(value){return this.values.has(value)}
}

class FakeDrawer{
  constructor(){this.open=false;this.handlers=new Map();this.activeHandlers=0;this.closeCount=0}
  addEventListener(type,handler,{signal}={}){
    if(!this.handlers.has(type))this.handlers.set(type,new Set());
    this.handlers.get(type).add(handler);
    this.activeHandlers++;
    signal?.addEventListener('abort',()=>{
      if(this.handlers.get(type)?.delete(handler))this.activeHandlers--;
    },{once:true});
  }
  emit(type,target=this){
    const event={target,defaultPrevented:false,preventDefault(){this.defaultPrevented=true}};
    for(const handler of [...(this.handlers.get(type)||[])])handler(event);
    return event;
  }
  showModal(){this.open=true}
  close(){this.open=false;this.closeCount++;this.emit('close')}
}

function fixture(){
  const drawer=new FakeDrawer(),content={innerHTML:''},classes=new Classes();
  const opener={isConnected:true,focusCount:0,focus(){this.focusCount++}};
  const document={activeElement:opener,body:{classList:classes}};
  return {drawer,content,classes,opener,lifecycle:createDrawerLifecycle({drawer,body:content,document})};
}

function assertClosed(f,{focus=true}={}){
  assert.equal(f.drawer.open,false);
  assert.equal(f.content.innerHTML,'');
  assert.equal(f.classes.contains('mfg-drawer-open'),false);
  assert.equal(f.drawer.activeHandlers,0);
  assert.equal(f.opener.focusCount,focus?1:0);
}

test('Close button fully closes the drawer and restores focus',()=>{
  const f=fixture();f.lifecycle.open('<button data-close>Close</button>');
  f.drawer.emit('click',{closest:selector=>selector==='[data-close]'?{}:null});
  assertClosed(f);
});

test('Escape fully closes the drawer and restores focus',()=>{
  const f=fixture();f.lifecycle.open('detail');
  const event=f.drawer.emit('cancel');
  assert.equal(event.defaultPrevented,true);
  assertClosed(f);
});

test('backdrop click fully closes the drawer and restores focus',()=>{
  const f=fixture();f.lifecycle.open('detail');
  f.drawer.emit('click',f.drawer);
  assertClosed(f);
});

test('five repeated open and close cycles create no duplicate handlers or backdrops',()=>{
  const f=fixture();
  for(let cycle=1;cycle<=5;cycle++){
    f.lifecycle.open(`detail ${cycle}`);
    assert.equal(f.drawer.open,true);
    assert.equal(f.drawer.activeHandlers,3);
    assert.equal(f.classes.contains('mfg-drawer-open'),true);
    f.lifecycle.close();
    assert.equal(f.drawer.activeHandlers,0);
  }
  assert.equal(f.drawer.closeCount,5);
  assert.equal(f.opener.focusCount,5);
});

test('tab switching closes without restoring focus into the hidden panel',()=>{
  const f=fixture();f.lifecycle.open('detail');
  f.lifecycle.close({restoreFocus:false});
  assertClosed(f,{focus:false});
  const ui=fs.readFileSync(path.join(__dirname,'..','manufacturing-v3.js'),'utf8');
  assert.match(ui,/if\(tab!==state\.tab\)state\.drawer\?\.close\(\{restoreFocus:false\}\)/);
});
