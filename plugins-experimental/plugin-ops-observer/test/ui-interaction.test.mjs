import test from "node:test";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import React, {act} from "react";
import {createRoot} from "react-dom/client";
import {OpsWorkView} from "../dist-test/ui/test-export.js";
import {buildViewModel, applyFilters, resolveSelection} from "../dist-test/ui/model.js";

const require = createRequire(import.meta.url);
let jsdomPath;
try { jsdomPath = require.resolve("jsdom", {paths:["../../server"]}); } catch { /* Optional workspace dependency. */ }
const mountedTest = jsdomPath ? test : test.skip;
const now = Date.parse("2026-10-03T12:01:00Z");
const filters = {query:"",scope:"all",recency:"any",project:""};
const items = [
  {ops_task_id:"first",project:"ops",issue_title:"First issue",execution_state:"running",updated_at:"2026-10-03T12:00:00Z"},
  {ops_task_id:"second",project:"ops",issue_title:"Second issue",execution_state:"running",updated_at:"2026-10-03T11:59:00Z"}
];
const envelope = {fetchedAt:now,snapshot:{schema:"ops_work_snapshot_v1",items}};
const state = {kind:"ready",envelope,stale:false,fetchedAtIso:new Date(now).toISOString(),malformedItemCount:0};

async function withMounted(check) {
  const {JSDOM} = require(jsdomPath);
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {url:"https://example.test/"});
  const previous = Object.fromEntries(["window","document","HTMLElement","Element","IS_REACT_ACT_ENVIRONMENT"].map(key=>[key, {had:Object.hasOwn(globalThis,key),value:globalThis[key]}]));
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Element = dom.window.Element;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const scrolls = [];
  dom.window.Element.prototype.scrollIntoView = function(options) { scrolls.push({element:this,options}); };
  const root = createRoot(dom.window.document.getElementById("root"));
  let rows = buildViewModel(items,{now});
  let selectedId = null;
  const render = () => root.render(React.createElement(OpsWorkView, {
    state,rows,filters,onFilters:()=>{},selectedId,onSelect:id=>{selectedId=id;render();},
    onRefresh:()=>{},loading:false,now,items,refreshFailed:false
  }));
  const click = async element => { await act(async()=>{element.click();}); };
  const button = (id) => [...dom.window.document.querySelectorAll('button[aria-label^="View details"]')]
    .find(element=>element.getAttribute("aria-label").includes(id === "first" ? "First issue" : "Second issue"));
  try {
    await act(async()=>{render();});
    await check({document:dom.window.document,window:dom.window,scrolls,click,button,
      rerender:async(nextRows,nextSelectedId)=>{rows=nextRows;selectedId=nextSelectedId;await act(async()=>{render();});},
      selected:()=>selectedId});
  } finally {
    await act(async()=>{root.unmount();});
    dom.window.close();
    for (const [key,{had,value}] of Object.entries(previous)) {
      if (had) globalThis[key]=value; else delete globalThis[key];
    }
  }
}

mountedTest("clicking View details opens the exact item and focuses its region",async()=>{
  await withMounted(async({document,button,click,scrolls})=>{
    await click(button("second"));
    const aside=document.querySelector('aside[role="region"]');
    assert.ok(aside);
    assert.match(aside.textContent,/Second issue/);
    assert.doesNotMatch(aside.textContent,/First issue/);
    assert.ok(document.activeElement===aside,"details region must receive focus");
    assert.ok(scrolls.at(-1)?.element===aside,"details region must scroll");
    assert.deepEqual(scrolls.at(-1)?.options,{block:"nearest"});
  });
});

mountedTest("Close unmounts details and restores focus to the invoking button",async()=>{
  await withMounted(async({document,button,click})=>{
    const opener=button("first");
    await click(opener);
    await click(document.querySelector("aside button"));
    assert.equal(document.querySelector("aside"),null);
    assert.ok(document.activeElement===opener,"focus must return to the invoking button");
  });
});

mountedTest("Escape from inside details closes and restores focus to the invoking button",async()=>{
  await withMounted(async({document,window,button,click})=>{
    const opener=button("second");
    await click(opener);
    await act(async()=>{document.querySelector("aside button").dispatchEvent(new window.KeyboardEvent("keydown",{key:"Escape",bubbles:true}));});
    assert.equal(document.querySelector("aside"),null);
    assert.ok(document.activeElement===opener,"focus must return to the invoking button");
  });
});

mountedTest("re-clicking the selected row focuses and re-scrolls the details region",async()=>{
  await withMounted(async({document,button,click,scrolls})=>{
    const opener=button("first");
    await click(opener);
    const aside=document.querySelector("aside");
    const count=scrolls.length;
    document.querySelector('button:not([aria-label])').focus();
    assert.notEqual(document.activeElement,aside);
    await click(opener);
    assert.ok(document.activeElement===aside,"details region must receive focus");
    assert.equal(scrolls.length,count+1);
    assert.ok(scrolls.at(-1)?.element===aside,"details region must scroll");
    assert.deepEqual(scrolls.at(-1)?.options,{block:"nearest"});
  });
});

mountedTest("View details exposes the native keyboard-activation button contract",async()=>{
  await withMounted(async({document,button,click,selected})=>{
    const opener=button("first");
    assert.equal(opener.tagName,"BUTTON");
    assert.equal(opener.getAttribute("type"),"button");
    assert.equal(opener.disabled,false);
    assert.match(opener.getAttribute("aria-label")??"",/^View details for First issue · ops$/);
    opener.focus();
    assert.ok(document.activeElement===opener,"button must be focusable");
    // jsdom cannot synthesize keydown→click; Enter/Space activation is browser-native for buttons.
    await click(opener);
    assert.equal(selected(),"first");
    assert.match(document.querySelector("aside").textContent,/First issue/);
  });
});

mountedTest("detail region unmounts when the selected item is no longer in rows",async()=>{
  await withMounted(async({document,button,click,rerender})=>{
    await click(button("second"));
    assert.ok(document.querySelector("aside"));
    const vm=buildViewModel(items,{now});
    const byFirst={...filters,query:"First issue"};
    const filtered=Object.fromEntries(Object.entries(vm).map(([key,value])=>[key,applyFilters(value,byFirst,now)]));
    const visible=resolveSelection(filtered,"second");
    assert.equal(visible,null);
    await rerender(filtered,visible);
    assert.equal(document.querySelector("aside"),null);
    assert.equal(button("second"),undefined);
  });
});
