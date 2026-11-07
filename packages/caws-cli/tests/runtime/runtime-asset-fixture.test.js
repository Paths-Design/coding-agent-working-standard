const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fixture = require('./runtime-asset-fixture')();
const control = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-child-proof-'));
const pause = (ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms));
let held;

test('retains fixture and fails cleanup while its process group has a child', async () => {
  held = fixture.temporaryRoot();
  const child = `const fs=require('node:fs'),p=require('node:path');
    const [root,dir]=process.argv.slice(1);
    fs.writeFileSync(p.join(dir,'ready'),String(process.pid));
    const end=Date.now()+5000;
    const timer=setInterval(()=>{
      if(fs.existsSync(p.join(dir,'release'))||Date.now()>=end){
        fs.writeFileSync(p.join(dir,'observed'),JSON.stringify({rootPresent:fs.existsSync(root)}));
        clearInterval(timer);
      }
    },20);`;
  const parent = `const fs=require('node:fs'),p=require('node:path'),{spawn}=require('node:child_process');
    const [source,root,dir]=process.argv.slice(1);
    spawn(process.execPath,['-e',source,root,dir],{stdio:'ignore'}).unref();
    const end=Date.now()+3000;
    while(!fs.existsSync(p.join(dir,'ready'))&&Date.now()<end)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
    if(!fs.existsSync(p.join(dir,'ready')))process.exit(9);`;
  fixture.succeeds(fixture.invoke(held, process.execPath, ['-e', parent, child, held, control]));
  expect(fs.existsSync(path.join(control, 'ready'))).toBe(true);
  expect(() => fixture.cleanup()).toThrow('Fixture process group still has members');
  expect(fs.existsSync(held)).toBe(true);
  const observed = JSON.parse(fs.readFileSync(path.join(held, 'postcase-processes.json'), 'utf8'));
  const childPid = Number(fs.readFileSync(path.join(control, 'ready'), 'utf8'));
  expect(observed.matches.map((row) => row.pid)).toContain(childPid);
  fs.writeFileSync(path.join(control, 'release'), '');
  const end = Date.now() + 4000;
  while (!fs.existsSync(path.join(control, 'observed')) && Date.now() < end) await pause(20);
  expect(JSON.parse(fs.readFileSync(path.join(control, 'observed'), 'utf8'))).toEqual({
    rootPresent: true,
  });
});

afterAll(async () => {
  if (!fs.existsSync(path.join(control, 'ready'))) return;
  const pid = Number(fs.readFileSync(path.join(control, 'ready'), 'utf8'));
  const end = Date.now() + 6500;
  while (Date.now() < end) {
    const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'pid='], {
      encoding: 'utf8',
      timeout: 1000,
    });
    if (!result.error && result.signal === null && result.status === 1 && !result.stdout.trim()) {
      fs.rmSync(held, { recursive: true, force: true });
      fs.rmSync(control, { recursive: true, force: true });
      return;
    }
    await pause(25);
  }
  throw new Error('Controlled child settlement was not observed; fixtures retained');
}, 8000);
