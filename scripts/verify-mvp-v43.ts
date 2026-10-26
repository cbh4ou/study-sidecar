/** Real Chromium, real fake-mode daemon, no model credentials or microphone. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright";

const root = join(import.meta.dir, "..");
const home = await mkdtemp(join(tmpdir(), "sidecar-browser-"));
const artifacts = join(root, ".run/mvp-browser");
await mkdir(artifacts, {recursive:true});
const token = crypto.randomUUID();
const base = "http://127.0.0.1:4321";
const web = "http://127.0.0.1:3137";
const children: ReturnType<typeof Bun.spawn>[] = [];
let logs = "";
async function poll<T>(read:()=>Promise<T>, accept:(value:T)=>boolean, label:string):Promise<T> {
 const deadline=Date.now()+20000;
 while(Date.now()<deadline){
  const value=await read();if(accept(value))return value;
  if(children.some(child=>child.exitCode!==null)) throw new Error(`Child exited while waiting for ${label}: ${logs}`);
  await Bun.sleep(25);
 }
 throw new Error(`Timed out: ${label}\n${logs}`);
}
async function api(path:string, body?:unknown):Promise<any>{
 const response=await fetch(`${base}${path}`,{headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},method:body===undefined?"GET":"POST",...(body===undefined?{}:{body:JSON.stringify(body)})});
 if(!response.ok)throw new Error(`${path}: ${response.status} ${await response.text()}`);return response.json();
}
const spawn = (command:string[],cwd:string)=>{
 const child=Bun.spawn(command,{cwd,env:{...process.env,HOME:home,SIDECAR_HOME:join(home,".study-sidecar"),SIDECAR_TOKEN:token,SIDECAR_FAKE:"1",BUN_RUNTIME_TRANSPILER_CACHE_PATH:"0"},stdout:"pipe",stderr:"pipe"});
 children.push(child);
 for(const stream of [child.stdout,child.stderr]) void new Response(stream).text().then(text=>{logs+=text;});
 return child;
};
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
try{
 for(const port of [4321,3137]){const probe=Bun.listen({hostname:"127.0.0.1",port,socket:{data(){}}});probe.stop(true);}
 spawn([process.execPath,"apps/daemon/src/index.ts","--fake"],root);
 spawn([process.execPath,join(root,"apps/desktop/node_modules/.bin/rsbuild"),"dev","--port","3137"],join(root,"apps/desktop"));
 for(const url of [`${base}/health`,web]) await poll(()=>fetch(url,{headers:{Authorization:`Bearer ${token}`}}).then(r=>r.ok).catch(()=>false),Boolean,url);
 browser=await chromium.launch({headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 const errors:string[]=[];
 const watch=(page:Page)=>page.on("pageerror",error=>errors.push(error.message));
 const page=await context.newPage();watch(page);
 await page.goto(web);await page.getByRole("heading",{name:"Your graph starts with a lesson"}).waitFor();
 await page.getByRole("link",{name:"Classroom",exact:true}).click();
 await page.getByLabel("What do you want to understand?").fill("Channel acknowledgement guarantees");
 await page.getByRole("button",{name:"New lesson",exact:true}).click();await page.waitForURL(/\/classroom\/les_/);
 const id=new URL(page.url()).pathname.split("/").at(-1)!;
 const detail=()=>api(`/api/lessons/${id}`);
 const answerPending=async()=>{
  const lesson=await poll(detail,d=>d.questions.some((q:any)=>!d.answers[q.id]),"pending lesson question");
  const question=lesson.questions.find((q:any)=>!lesson.answers[q.id]);
  await page.getByText(question.prompt,{exact:true}).waitFor();
  const dock=page.getByRole("region",{name:"Question dock"});
  if(question.kind==="quiz"){
   const option=question.options.find((option:any)=>option.id===question.correctId);
   await dock.getByRole("radio",{name:option.label,exact:true}).click();await dock.getByRole("button",{name:"Check answer",exact:true}).click();
  }else{
   await dock.getByPlaceholder("Share your reasoning").fill("After processing the consumer acknowledges; without an acknowledgement the broker can redeliver.");
   await dock.getByRole("button",{name:"Send",exact:true}).click();
  }
  await poll(detail,d=>Boolean(d.answers[question.id]),"persisted answer");
  return question.kind;
 };
 const kinds = new Set<string>();
 for(let probe=0;probe<3;probe++)kinds.add(await answerPending());
 console.log("Measure probes passed");
 await poll(detail,d=>d.phase==="plan","Measure results");await page.screenshot({path:join(artifacts,"measure.png")});
 const ask=async(text:string)=>{
  const dock=page.locator(".classroom-center > .dictation-bar");
  await dock.getByPlaceholder("Ask about one concept").fill(text);await dock.getByRole("button",{name:"Send",exact:true}).click();
 };
 await ask("What should we learn first?");await poll(detail,d=>Boolean(d.planMermaid),"authored prerequisite plan");
 await ask("Explain the first step");
 for(let node=0;node<3;node++)kinds.add(await answerPending());
 kinds.add(await answerPending());assert(kinds.has("ask")&&kinds.has("quiz")&&kinds.has("explain_back"));
 await page.screenshot({path:join(artifacts,"classroom.png")});
 console.log("Plan, Teach and explain-back passed");
 const source=page.getByLabel("URL",{exact:true});await source.fill("https://example.com/acknowledgements");await page.getByRole("button",{name:"Add source",exact:true}).click();
 await page.getByRole("link",{name:"https://example.com/acknowledgements",exact:true}).waitFor();
 await page.goto(`${web}/sessions`);await page.getByRole("heading",{name:"Sessions",exact:true}).waitFor();
 await page.getByLabel("Local only",{exact:true}).click();await poll(()=>api("/api/sources"),d=>Object.values(d.sources).some((v:any)=>v.local_only),"source privacy enabled");
 await poll(()=>page.getByLabel("Local only",{exact:true}).isChecked(),Boolean,"privacy checkbox updated");await page.getByLabel("Local only",{exact:true}).click();await poll(()=>api("/api/sources"),d=>Object.values(d.sources).every((v:any)=>!v.local_only),"source privacy disabled");
 await page.goto(`${web}/review`);await page.getByRole("button",{name:"Good",exact:true}).first().waitFor();
 await page.getByPlaceholder("Recall aloud or say a grade").fill("good");await page.locator(".review-card").getByRole("button",{name:"Send",exact:true}).click();
 await poll(()=>api("/api/cards/due"),d=>d.cards.length>0,"remaining due cards");
 for(let count=0;count<50;count++){
  if(!(await api("/api/cards/due")).cards.length)break;
  const good=page.getByRole("button",{name:"Good",exact:true}).first();await good.waitFor();await good.click();
 }
 await page.getByRole("heading",{name:"You are up to date"}).waitFor();
 await page.goto(web);await page.locator("canvas").waitFor();await page.getByRole("button",{name:/Chains \(/}).click();await page.getByRole("dialog",{name:"Reasoning chains"}).waitFor();await page.getByLabel("Search chains").fill("ack");await page.getByRole("button",{name:"Close",exact:true}).click();await page.screenshot({path:join(artifacts,"graph.png")});
 await page.goto(`${web}/settings`);await page.getByRole("heading",{name:"Settings",exact:true}).waitFor();await page.screenshot({path:join(artifacts,"settings.png")});
 const pill=await context.newPage();watch(pill);await pill.setViewportSize({width:420,height:700});await pill.goto(`${web}/pill`);await pill.getByRole("button",{name:"Hold to talk",exact:true}).waitFor();
 await pill.keyboard.down("Alt");await pill.keyboard.down("Space");await pill.getByText(/Listening|what is a channel/).first().waitFor();await pill.keyboard.up("Space");await pill.keyboard.up("Alt");
 await pill.getByText(/Fake answer to:/).first().waitFor();await pill.screenshot({path:join(artifacts,"pill.png")});
 await pill.keyboard.press("Alt+p");await pill.getByRole("heading",{name:"Pin this anchor?"}).waitFor();await pill.getByRole("button",{name:"Dismiss",exact:true}).click();await pill.keyboard.press("Alt+d");assert(!(await pill.getByRole("main",{name:"Study pill"}).isVisible()));await pill.keyboard.press("Alt+d");
 await pill.keyboard.press("Alt+s");await pill.getByRole("button",{name:"Collapse",exact:true}).waitFor();
 assert.deepEqual(errors,[]);console.log(`MVP fake browser acceptance passed. Screenshots: ${artifacts}`);
}catch(error){
 const page = browser?.contexts()[0]?.pages()[0];
 if(page){await page.screenshot({path:join(artifacts,"failure.png")}).catch(()=>undefined);console.error((await page.locator("body").innerText()).slice(-5000));}
 throw error;
}finally{
 await browser?.close();
 for(const child of children) child.kill();
 await Promise.allSettled(children.map(child=>child.exited));
 await rm(home,{recursive:true,force:true});
}
