import { mkdtemp, writeFile, mkdir, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
const data = await mkdtemp(join(tmpdir(), "delta-e2e-"));
const cwd = join(data, "project");
await mkdir(cwd);
await writeFile(join(data, "owner-token"), "e2e-owner", { mode: 0o600 });
const fixture = join(data, "fixture-pi");
await writeFile(
  fixture,
  `#!/usr/bin/env python3
import sys,json
for line in sys.stdin:
 c=json.loads(line)
 if c['type']=='get_state':
  print(json.dumps({'type':'response','id':c.get('id'),'command':'get_state','success':True,'data':{'model':{'id':'fixture-model','provider':'fixture'}}}),flush=True)
  print(json.dumps({'type':'extension_ui_request','id':'status','method':'setStatus','statusKey':'fixture','statusText':'Ready'}),flush=True)
  print(json.dumps({'type':'extension_ui_request','id':'widget','method':'setWidget','widgetKey':'fixture','widgetLines':['Protocol fixture']}),flush=True)
 elif c['type']=='prompt':
  if 'Interaction fixture' in c['message']:
   print(json.dumps({'type':'extension_ui_request','id':'fixture-confirm','method':'confirm','title':'Fixture confirmation','message':'A controller decision is required'}),flush=True)
   continue
  answer = '## Formula result\\n\\nInline $E=mc^2$.\\n\\n$$\\n\\\\frac{a}{b}\\n$$' if 'Math fixture' in c['message'] else 'Fixture response, not model inference.'
  records=[
   {'type':'response','command':'prompt','success':True,'data':{'disposition':'started'}},
   {'type':'tool_execution_start','toolCallId':'fixture-call','toolName':'read','args':{'path':'fixture.txt'}},
   {'type':'tool_execution_update','toolCallId':'fixture-call','toolName':'read','args':{'path':'fixture.txt'},'partialResult':{'content':[{'type':'text','text':'partial fixture result'}]}},
   {'type':'tool_execution_end','toolCallId':'fixture-call','toolName':'read','result':{'content':[{'type':'text','text':'authoritative fixture result'}]},'isError':False},
   {'type':'message_start','message':{'role':'assistant','content':[]}},
   {'type':'message_update','assistantMessageEvent':{'type':'text_delta','contentIndex':0,'delta':'Fixture response'}},
   {'type':'message_end','message':{'role':'assistant','content':[{'type':'text','text':answer}],'stopReason':'stop'}},
   {'type':'agent_end','willRetry':False,'messages':[]},
   {'type':'agent_settled','aborted':False}
  ]
  for r in records: print(json.dumps(r),flush=True)
 elif c['type']=='extension_ui_response': print(json.dumps({'type':'agent_settled','aborted':False}),flush=True)
 elif c['type']=='abort': print(json.dumps({'type':'agent_settled','aborted':True}),flush=True)
`,
);
await chmod(fixture, 0o700);
const child = spawn(resolve("target/debug/delta-host"), {
  env: {
    ...process.env,
    DELTA_DATA: data,
    DELTA_CWD: cwd,
    DELTA_PI: fixture,
    DELTA_DEFAULT_REPLY_MODE: "mentions_only",
    DELTA_LISTEN: "127.0.0.1:47832",
  },
  stdio: "inherit",
});
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  child.kill("SIGINT");
  setTimeout(() => child.kill("SIGKILL"), 2000).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.on("exit", async (code) => {
  await rm(data, { recursive: true, force: true });
  process.exit(code ?? 0);
});
