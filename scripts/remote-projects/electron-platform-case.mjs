import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const evidence = path.resolve(process.env.REMOTE_PROJECTS_CANDIDATE_EVIDENCE ?? '.scratch/remote-projects/performance/candidate-ui-native/independent');
const config = JSON.parse(fs.readFileSync(path.join(evidence, 'electron-files/interactive.json')));
const fixture = JSON.parse(fs.readFileSync(path.join(evidence, 'platform-fixture.json')));
const [label, mode = 'snapshot', argument] = process.argv.slice(2);
if (!/^[a-zA-Z0-9-]+$/.test(label ?? '')) throw new Error('Unique safe case label required');
const file = path.join(evidence, `platform-case-${label}.json`);
if (fs.existsSync(file)) throw new Error('Refusing platform case overwrite');
const report = { label, mode, sourceHash: config.sourceHash, firstScopeAcceptance: false, startedAt: Date.now(), steps: [] };
const save = () => fs.writeFileSync(file, JSON.stringify(report, null, 2));
const control = async command => {
  const id = randomUUID(); fs.writeFileSync(config.controlFile, JSON.stringify({ ...command, id }));
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    const replies = fs.existsSync(config.repliesFile) ? fs.readFileSync(config.repliesFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    const r = replies.find(row => row.id === id);
    if (r) { report.steps.push({ ...r, command }); save(); if (r.status !== 'completed') throw new Error(r.error ?? 'Control failed'); await delay(200); return r.value; }
    await delay(100);
  }
  throw new Error('Real Electron command timed out');
};
const evaluate = expression => control({ action: 'evaluate', expression });
const click = (selector, text) => control({ action: 'click', selector, text });
try {
  if (mode === 'prepare-projects') {
    report.fixtureSetupOnly = true;
    report.preparedProjects = await evaluate(`(async()=>{const roots=${JSON.stringify(fixture.hosts.map(host => ({ id: host.id, directory: host.directory })))};const rows=[];for(const host of roots){const r=await fetch(window.__YURI_API_BASE_URL__+'/api/hosts/'+host.id+'/projects',{method:'POST',headers:{Authorization:'Bearer '+window.__YURI_CLIENT_TOKEN__,'content-type':'application/json'},body:JSON.stringify({path:host.directory})});const body=await r.json();if(!r.ok)throw Error('Fixture registry setup '+host.id+' HTTP '+r.status+' '+JSON.stringify(body));rows.push({hostId:host.id,projectId:body.project.id,directory:host.directory,status:r.status});}return rows;})()`);
    fs.writeFileSync(path.join(evidence, 'fixture-prepared-projects.json'), JSON.stringify({ firstScopeAcceptance: false, setup: 'Owning registry API fixture preparation only, not UI add acceptance', projects: report.preparedProjects }, null, 2), { flag: 'wx' });
  } else if (mode === 'navigate-host-files') {
    const host = fixture.hosts.find(host => host.id === argument);
    const prepared = JSON.parse(fs.readFileSync(path.join(evidence, 'fixture-prepared-projects.json'))).projects.find(row => row.hostId === argument);
    if (!host || !prepared) throw new Error('Unknown prepared fixture host');
    const localRows = await evaluate(`[...document.querySelectorAll('[data-session-row]')].filter(n=>n.innerText.includes('Performance baseline session')).map(n=>n.getAttribute('data-session-row'))`);
    if (localRows.length !== 1) throw new Error('Unique actual local fixture session row required');
    await click(`[data-session-row="${localRows[0]}"]`); await delay(700);
    await click(`[data-sidebar-project-header="${prepared.projectId}"] button[aria-label="新建会话"]`); await delay(1200);
    report.navigation = await control({ action: 'snapshot' });
    if (new URL(report.navigation.url).searchParams.get('hostId') !== argument) throw new Error('Normal project new-session action did not navigate to fixture host');
    if (!(await evaluate(`Boolean(document.querySelector('button[aria-label="切换文件树"]'))`))) await click('button', '切换预览侧栏');
    if (!(await evaluate(`document.querySelector('button[aria-label="切换文件树"]')?.getAttribute('aria-pressed')==='true'`))) await click('button', '切换文件树');
    await delay(1000); report.filesTree = await control({ action: 'snapshot' });
  } else if (mode === 'open-html') {
    const host = fixture.hosts.find(host => host.id === argument);
    if (!host) throw new Error('Unknown fixture host');
    const before = await control({ action: 'snapshot' });
    if (new URL(before.url).searchParams.get('hostId') !== argument) throw new Error('Normal fixture navigation required before opening actual file');
    const fileSelector = file => `button:has(span[title=${JSON.stringify(path.join(host.directory, file))}])`;
    if (!(await evaluate(`Boolean(document.querySelector(${JSON.stringify(fileSelector('docs/index.html'))}))`))) {
      await click(fileSelector('docs')); await delay(700);
    }
    await click(fileSelector('docs/index.html'));
    if (!(await evaluate(`Boolean([...document.querySelectorAll('iframe')].find(n=>n.getBoundingClientRect().height>0))`))) {
      if (await evaluate(`Boolean(document.querySelector('button[aria-label="显示编辑器控制项"]'))`)) await click('button', '显示编辑器控制项');
      await click('button', 'Switch to preview mode');
    }
    const end = Date.now() + 20000;
    let observation;
    while (Date.now() < end) {
      try { observation = await control({ action: 'observe-product-preview' }); } catch { await delay(500); continue; }
      if (observation.graph && observation.nested?.value && observation.picture?.loaded && observation.rootPicture?.loaded) break;
      await delay(500);
    }
    report.graphObservation = observation;
    const prefix = host.expectedHeading;
    report.graphPassed = observation?.observedFromActualProductIframe === true && observation.heading === prefix
      && observation.graph?.value === `${prefix}-module` && observation.graph?.dynamic === `${prefix}-dynamic`
      && observation.graph?.data === prefix && observation.graph?.root === prefix && observation.nested?.value === prefix
      && observation.picture?.loaded && observation.rootPicture?.loaded && observation.nested?.picture?.loaded
      && observation.fontSize === '23px' && observation.color === 'rgb(12, 34, 56)' && observation.background?.includes('pixel.svg');
    if (!report.graphPassed) throw new Error('Actual FilesView graph incomplete or cross-host content mismatch');
    report.afterOpen = await control({ action: 'snapshot' });
  } else if (mode === 'attachment') {
    const before = await control({ action: 'snapshot' });
    if (new URL(before.url).searchParams.get('hostId') !== argument) throw new Error('Normal fixture host navigation required');
    report.requestFence = fs.existsSync(path.join(evidence, 'platform-fixture-requests.jsonl')) ? fs.readFileSync(path.join(evidence, 'platform-fixture-requests.jsonl'), 'utf8').trim().split('\n').length : 0;
    await control({ action: 'arm-file-chooser' });
    await click('button', '附加文件');
    await control({ action: 'choose-fixture-file', selector: 'input[type="file"][accept="*/*"]', files: [fixture.attachment.file] });
    await delay(3000);
    report.afterAttach = await control({ action: 'snapshot' });
    report.uploadRequests = fs.readFileSync(path.join(evidence, 'platform-fixture-requests.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).slice(report.requestFence).filter(row => row.route.includes('/prompt-attachments/'));
    report.passed = report.afterAttach.body.includes('fixture-attachment.png') && report.uploadRequests.some(row => row.hostId === argument && row.status >= 200 && row.status < 300);
    if (!report.passed) throw new Error('Actual attachment UI/upload evidence incomplete');
  } else if (mode === 'add-project') {
    const host = fixture.hosts.find(host => host.id === argument);
    if (!host) throw new Error('Unknown fixture host');
    await click('button', '添加项目'); await click('button', '机器'); await delay(600);
    const options = await evaluate(`[...document.querySelectorAll('[role=option]')].filter(n=>n.getBoundingClientRect().height>0).map(n=>n.innerText)`);
    const option = options.find(text => text.startsWith(host.label));
    if (!option) throw new Error('Real machine picker lacks handed-off fixture host');
    await click('[role=option]', option); await delay(800);
    const remoteDialog = `Boolean([...document.querySelectorAll('[role=dialog]')].find(n=>n.innerText.includes('添加远端项目')))`;
    if (!(await evaluate(remoteDialog)) && await evaluate(`[...document.querySelectorAll('[role=option]')].some(n=>n.getBoundingClientRect().height>0&&n.innerText===${JSON.stringify(option)})`)) {
      await click('[role=option]', option); await delay(800);
    }
    if (!(await evaluate(remoteDialog))) throw new Error('Real machine choice did not commit remote directory dialog; refusing local project add');
    await evaluate(`(()=>{const n=document.querySelector('input[aria-label="输入路径或从树中选择..."]');if(!n)throw Error('Actual directory picker input missing');n.focus();n.select();return {selected:n.value.length};})()`);
    await control({ action: 'type', text: host.directory }); await delay(2000);
    report.beforeAdd = await control({ action: 'snapshot' });
    await click('[role=dialog] button', '添加项目'); await delay(3000);
    report.afterAdd = await control({ action: 'snapshot' });
    if (await evaluate(`Boolean([...document.querySelectorAll('[role=dialog]')].find(n=>n.innerText.includes('添加远端项目')))`)) throw new Error('Remote add dialog is still open; click acknowledgement is not a project-add success');
  } else if (mode === 'commands') {
    const commands = JSON.parse(fs.readFileSync(argument));
    if (!Array.isArray(commands)) throw new Error('Command array required');
    for (const command of commands) await control(command);
  } else if (mode === 'snapshot') report.snapshot = await control({ action: 'snapshot' });
  else throw new Error('Unknown platform case');
  await control({ action: 'screenshot', name: `platform-${label}` });
  report.status = 'completed';
} catch (error) { report.status = 'failed'; report.error = error.message; process.exitCode = 2; }
report.completedAt = Date.now(); save(); console.log(JSON.stringify({ label, mode, status: report.status, error: report.error }));
