import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const evidence = path.resolve(process.env.REMOTE_PROJECTS_IOS_EVIDENCE ?? '.scratch/remote-projects/performance/ios-first-input');
const state = JSON.parse(fs.readFileSync(path.join(evidence, 'workspace.json')));
const label = process.argv[2];
if (!/^[a-zA-Z0-9-]+$/.test(label ?? '')) throw new Error('A unique safe observation label is required');
const output = path.join(evidence, `probe-${label}.json`);
if (fs.existsSync(output)) throw new Error('Refusing observation overwrite');
const env = { ...process.env, DEVELOPER_DIR: state.developerDir };
const containerResult = spawnSync('xcrun', ['simctl', 'get_app_container', state.udid, state.bundleId, 'data'], { env, encoding: 'utf8' });
if (containerResult.status !== 0) throw new Error('Cannot resolve this task App sandbox');
const container = containerResult.stdout.trim();
if (!container.includes(state.udid)) throw new Error('Sandbox belongs to another device');
const temporary = path.join(container, 'tmp');
const nativeFile = path.join(temporary, `input-native-${label}.json`);
const webFile = path.join(temporary, `input-web-${label}.json`);
const eventsFile = path.join(temporary, 'input-native-events-v2.jsonl');
const pid = Number(state.lastLaunch?.stdout?.split(': ').at(-1));
const ps = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
if (!pid || !ps.stdout.includes(state.udid) || !ps.stdout.includes('/App.app/App')) throw new Error('Task App PID ownership mismatch');
const objc = value => '@' + JSON.stringify(value);
const script = `(()=>{
  const describe=n=>{if(!n)return null;const r=n.getBoundingClientRect?.();return {tag:n.tagName,id:n.id,role:n.getAttribute?.('role'),placeholder:n.getAttribute?.('placeholder'),aria:n.getAttribute?.('aria-label'),disabled:n.disabled,readOnly:n.readOnly,editable:n.isContentEditable,valueLength:n.type==='password'?null:typeof n.value==='string'?n.value.length:null,start:n.selectionStart,end:n.selectionEnd,rect:r?{x:r.x,y:r.y,width:r.width,height:r.height}:null};};
  if(!window.__iosInputDiagnostic){
    const events=[];window.__iosInputDiagnostic={events};
    for(const type of ['touchstart','touchend','pointerdown','pointerup','click','focus','focusin','focusout','blur','beforeinput','input','change','keydown','keyup','compositionstart','compositionend'])document.addEventListener(type,e=>{events.push({epochMs:Date.now(),type,target:describe(e.target),active:describe(document.activeElement),trusted:e.isTrusted,inputType:e.inputType,dataLength:typeof e.data==='string'?e.data.length:null,key:e.key&&e.key.length===1?'character':e.key,path:e.composedPath().slice(0,5).map(n=>n.tagName??n.nodeName??'window')});if(events.length>1000)events.shift();}, {capture:true,passive:true});
    const cap=window.Capacitor;if(typeof cap?.nativePromise==='function'){const original=cap.nativePromise;cap.nativePromise=function(plugin,method,...args){if(plugin==='YuriComposer')events.push({epochMs:Date.now(),type:'native-composer-call',method,suppressed:args[0]?.suppressed});return original.call(this,plugin,method,...args);};}
  }
  if(!window.__iosInputDiagnostic.blurTraced){window.__iosInputDiagnostic.blurTraced=true;const original=HTMLElement.prototype.blur;HTMLElement.prototype.blur=function(...args){window.__iosInputDiagnostic.events.push({epochMs:Date.now(),type:'script-blur-call',target:describe(this),stack:new Error().stack});return original.apply(this,args);};}
  if(!window.__iosInputDiagnostic.imeTraced){window.__iosInputDiagnostic.imeTraced=true;for(const type of ['yuri:ime-state','yuri:keyboard-intent','yuri:keyboard-anim','yuri:keyboard-settled'])window.addEventListener(type,e=>{const d=e.detail??e;window.__iosInputDiagnostic.events.push({epochMs:Date.now(),type,open:d.open,height:d.height,phase:d.phase,durationMs:d.durationMs,active:describe(document.activeElement)});},{capture:true,passive:true});}
  const runtimeAssetPaths=[...new Set([...document.scripts].map(n=>n.src).concat(performance.getEntriesByType('resource').map(n=>n.name)).flatMap(src=>{try{const u=new URL(src,location.href);return u.protocol===location.protocol&&u.host===location.host&&u.pathname.startsWith('/assets/')&&/[.](?:js|css)$/.test(u.pathname)?[u.pathname]:[];}catch{return [];}}))];
  return {epochMs:Date.now(),runtimeAssetPaths,active:describe(document.activeElement),selection:{textLength:getSelection()?.toString().length??0,anchorOffset:getSelection()?.anchorOffset,focusOffset:getSelection()?.focusOffset},viewport:{width:innerWidth,height:innerHeight,visualHeight:visualViewport?.height,offsetTop:visualViewport?.offsetTop},inputs:[...document.querySelectorAll('input,textarea,[contenteditable=true]')].map(n=>{const r=n.getBoundingClientRect();return {...describe(n),centerHit:describe(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};}),events:window.__iosInputDiagnostic.events};
})()`;
const point = process.argv[3] ? JSON.parse(process.argv[3]) : null;
if (point && (!Number.isFinite(point.x) || !Number.isFinite(point.y))) throw new Error('Invalid observed AX point');
const nativeExpression = `({ NSMutableArray *rows=[NSMutableArray array]; NSMutableArray *queue=[NSMutableArray array]; for(UIWindow *w in [[UIApplication sharedApplication] windows]) [queue addObject:w]; while([queue count]){ UIView *v=[queue firstObject]; [queue removeObjectAtIndex:0]; [queue addObjectsFromArray:[v subviews]]; NSString *cls=NSStringFromClass([v class]); if([v isFirstResponder] || [v isKindOfClass:[UITextField class]] || [v isKindOfClass:[UITextView class]] || [v isKindOfClass:[WKWebView class]] || [cls containsString:@"Composer"] || [v isKindOfClass:[UIWindow class]]){ NSMutableDictionary *row=[@{@"class":cls,@"pointer":[NSString stringWithFormat:@"%p",v],@"firstResponder":@([v isFirstResponder]),@"frame":NSStringFromCGRect([v convertRect:[v bounds] toView:nil]),@"hidden":@([v isHidden]),@"alpha":@([v alpha]),@"interactive":@([v isUserInteractionEnabled])} mutableCopy]; if([v isKindOfClass:[UITextView class]] || [v isKindOfClass:[UITextField class]]) row[@"textLength"]=@([(id)v text].length); [rows addObject:row]; }} NSMutableDictionary *data=[@{@"epochMs":@([[NSDate date] timeIntervalSince1970]*1000),@"views":rows} mutableCopy]; ${point ? `NSMutableArray *hits=[NSMutableArray array]; for(UIWindow *w in [[UIApplication sharedApplication] windows]){UIView *hit=[w hitTest:CGPointMake(${point.x},${point.y}) withEvent:nil]; if(hit)[hits addObject:@{@"window":NSStringFromClass([w class]),@"hit":NSStringFromClass([hit class]),@"pointer":[NSString stringWithFormat:@"%p",hit]}];} data[@"hitTest"]=hits;` : ''} [[NSJSONSerialization dataWithJSONObject:data options:0 error:nil] writeToFile:${objc(nativeFile)} atomically:YES]; @"native-observation-written"; })`;
const monitorExpression = `({ static BOOL installed=NO; if(!installed){installed=YES; for(NSString *name in @[UITextFieldTextDidBeginEditingNotification,UITextFieldTextDidEndEditingNotification,UITextFieldTextDidChangeNotification,UITextViewTextDidBeginEditingNotification,UITextViewTextDidEndEditingNotification,UITextViewTextDidChangeNotification,UIKeyboardWillShowNotification,UIKeyboardDidShowNotification,UIKeyboardWillHideNotification,UIKeyboardDidHideNotification]){[[NSNotificationCenter defaultCenter] addObserverForName:name object:nil queue:[NSOperationQueue mainQueue] usingBlock:^(NSNotification *n){NSMutableDictionary *row=[@{@"epochMs":@([[NSDate date] timeIntervalSince1970]*1000),@"name":n.name,@"class":n.object?NSStringFromClass([n.object class]):@"none"} mutableCopy]; if([n.object respondsToSelector:@selector(isFirstResponder)])row[@"firstResponder"]=@([n.object isFirstResponder]); NSFileHandle *h=[NSFileHandle fileHandleForWritingAtPath:${objc(eventsFile)}]; if(!h){[[NSData data] writeToFile:${objc(eventsFile)} atomically:YES];h=[NSFileHandle fileHandleForWritingAtPath:${objc(eventsFile)}];}[h seekToEndOfFile];[h writeData:[NSJSONSerialization dataWithJSONObject:row options:0 error:nil]];[h writeData:[@"\\n" dataUsingEncoding:NSUTF8StringEncoding]];[h closeFile];}];}} @"native-notification-monitor-installed"; })`;
const webExpression = `({ dispatch_async(dispatch_get_main_queue(), ^{ NSMutableArray *queue=[NSMutableArray array]; for(UIWindow *w in [[UIApplication sharedApplication] windows])[queue addObject:w]; while([queue count]){UIView *v=[queue firstObject];[queue removeObjectAtIndex:0];[queue addObjectsFromArray:[v subviews]];if([v isKindOfClass:[WKWebView class]]){[(WKWebView*)v evaluateJavaScript:${objc(script)} completionHandler:^(id value,NSError *error){id result=error?@{@"error":[error localizedDescription]}:value;if(result&&[NSJSONSerialization isValidJSONObject:result])[[NSJSONSerialization dataWithJSONObject:result options:0 error:nil] writeToFile:${objc(webFile)} atomically:YES];}];break;}} }); @"web-observation-scheduled"; })`;
const commands = ['process attach --pid ' + pid, 'expression -l objc++ -- @import UIKit; @import WebKit;',
  'expression -l objc++ -O -- ' + nativeExpression.replace('[(id)v text].length', '[[(UITextView *)v text] length]')
    .replace('@"views":rows', '@"views":rows,@"applicationState":@([[UIApplication sharedApplication] applicationState])')
    .replace('[rows addObject:row];', 'if([v isKindOfClass:[UITextView class]]){NSRange range=[(UITextView *)v selectedRange];row[@"selectionStart"]=@(range.location);row[@"selectionEnd"]=@(range.location+range.length);} [rows addObject:row];')
    .replace('[[NSJSONSerialization dataWithJSONObject:data', 'NSObject *klass=(NSObject *)NSClassFromString(@"UIKeyboardImpl");SEL active=NSSelectorFromString(@"activeInstance");NSObject *keyboard=[klass respondsToSelector:active]?[klass performSelector:active]:nil;NSMutableDictionary *mode=[NSMutableDictionary dictionary];for(NSString *name in @[@"isInHardwareKeyboardMode",@"isMinimized"]){SEL method=NSSelectorFromString(name);if([keyboard respondsToSelector:method])mode[name]=@(((BOOL(*)(id,SEL))[keyboard methodForSelector:method])(keyboard,method));}data[@"keyboardRuntimeReadOnly"]=mode; [[NSJSONSerialization dataWithJSONObject:data'),
  'expression -l objc++ -O -- ' + monitorExpression.replaceAll('n.object', '((UIView *)[n object])')
    .replace('UIKeyboardDidHideNotification]', 'UIKeyboardDidHideNotification,UIApplicationWillResignActiveNotification,UIApplicationDidEnterBackgroundNotification,UIApplicationWillEnterForegroundNotification,UIApplicationDidBecomeActiveNotification]')
    .replace('NSFileHandle *h=', 'if([((UIView *)[n object]) isKindOfClass:[UITextView class]]){UITextView *field=(UITextView *)[n object];NSRange range=[field selectedRange];row[@"pointer"]=[NSString stringWithFormat:@"%p",field];row[@"textLength"]=@([[field text] length]);row[@"selectionStart"]=@(range.location);row[@"selectionEnd"]=@(range.location+range.length);} NSFileHandle *h=')
    .replace('NSFileHandle *h=', 'if([[n userInfo] objectForKey:UIKeyboardFrameEndUserInfoKey])row[@"endFrame"]=NSStringFromCGRect([(NSValue *)[[n userInfo] objectForKey:UIKeyboardFrameEndUserInfoKey] CGRectValue]); NSFileHandle *h=')
    .replace('static BOOL installed=NO;', `BOOL installed=[[NSFileManager defaultManager] fileExistsAtPath:${objc(path.join(temporary, `input-monitor-v2-${pid}`))}];`)
    .replace('installed=YES;', `installed=YES;[[NSData data] writeToFile:${objc(path.join(temporary, `input-monitor-v2-${pid}`))} atomically:YES];`),
  'expression -l objc++ -O -- ' + webExpression
    .replace('dispatch_async(dispatch_get_main_queue(), ^{', '[[NSOperationQueue mainQueue] addOperationWithBlock:^{')
    .replace(' }); @"web-observation-scheduled";', ' }]; @"web-observation-scheduled";'), 'process detach'];
const args = ['lldb', '--batch', ...commands.flatMap(command => ['-o', command])];
const result = spawnSync('xcrun', args, { env, encoding: 'utf8', timeout: 45000, maxBuffer: 5000000 });
await delay(600);
const report = { label, pid, status: result.status, error: result.error?.message, stdout: result.stdout, stderr: result.stderr,
  native: fs.existsSync(nativeFile) ? JSON.parse(fs.readFileSync(nativeFile)) : null,
  web: fs.existsSync(webFile) ? JSON.parse(fs.readFileSync(webFile)) : null,
  nativeEvents: fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [] };
fs.writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ label, debuggerExit: report.status, native: Boolean(report.native), web: Boolean(report.web), firstResponders: report.native?.views.filter(v=>v.firstResponder).map(v=>v.class), active: report.web?.active, nativeEvents: report.nativeEvents.length }));
if (!report.native || !report.web) process.exitCode = 2;
