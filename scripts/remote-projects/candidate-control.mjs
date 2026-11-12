import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const config = JSON.parse(fs.readFileSync(`${process.env.REMOTE_PROJECTS_CANDIDATE_EVIDENCE ?? '.scratch/remote-projects/performance/candidate'}/electron/interactive.json`, 'utf8'));
const action = process.argv[2];
const command = { id: randomUUID(), action };
if (action === 'file') Object.assign(command, JSON.parse(fs.readFileSync(process.argv[3], 'utf8')), { id: command.id });
if (action === 'evaluate') command.expression = process.argv.slice(3).join(' ');
if (action === 'click') { command.selector = process.argv[3]; command.text = process.argv.slice(4).join(' '); }
if (action === 'type') command.text = process.argv.slice(3).join(' ');
if (action === 'key') { command.key = process.argv[3]; command.modifiers = process.argv.slice(4); }
if (action === 'screenshot') command.name = process.argv[3];
fs.writeFileSync(config.controlFile, JSON.stringify(command));
const deadline = Date.now() + 120000;
while (Date.now() < deadline) {
  if (fs.existsSync(config.repliesFile)) {
    const reply = fs.readFileSync(config.repliesFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)).find(r => r.id === command.id);
    if (reply) { console.log(JSON.stringify(reply, null, 2)); if (reply.status === 'failed') process.exitCode = 2; break; }
  }
  await delay(100);
}
if (Date.now() >= deadline) { console.error('No command acknowledgement from the real product window'); process.exitCode = 2; }
