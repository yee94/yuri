//! Fixed offline Ghostty document. Reuse the production iOS bootstrap verbatim
//! except for the bounded desktop command adapter; never accept HTML/JS/URLs from JS.
use serde_json::{Value, json};
use std::sync::OnceLock;

type Result<T> = std::result::Result<T, String>;
const SWIFT: &str = include_str!("../../ios/NativeTerminalPreview.swift");
const PACKAGE: &str = include_str!("../../../../node_modules/ghostty-web/package.json");
const JAVASCRIPT: &str =
    include_str!("../../../../node_modules/ghostty-web/dist/ghostty-web.umd.cjs");
const WASM: &[u8] = include_bytes!("../../../../node_modules/ghostty-web/ghostty-vt.wasm");
pub const POLICY: &str = "default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; connect-src 'none'; img-src data:; font-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
static BOOTSTRAP: OnceLock<Result<String>> = OnceLock::new();

fn replace_once(source: String, before: &str, after: &str) -> Result<String> {
    if source.matches(before).count() != 1 {
        return Err("terminal_bootstrap_contract_changed".into());
    }
    Ok(source.replacen(before, after, 1))
}
pub fn bootstrap() -> Result<&'static str> {
    BOOTSTRAP.get_or_init(|| {
        let package: Value = serde_json::from_str(PACKAGE).map_err(|_| "terminal_package_invalid")?;
        if package["version"] != "0.4.0" || package["name"] != "ghostty-web" || JAVASCRIPT.len() > 4_000_000 || WASM.len() > 1_500_000 || !WASM.starts_with(&[0,97,115,109]) { return Err("terminal_offline_assets_invalid".into()); }
        let raw = SWIFT.split_once("static let bootstrap = #\"\"\"").and_then(|(_, tail)| tail.split_once("\"\"\"#")).map(|(body, _)| body).ok_or("terminal_bootstrap_missing")?.to_owned();
        let raw = replace_once(raw, "window.webkit.messageHandlers.terminal.postMessage(value)", "window.chrome?.webview ? window.chrome.webview.postMessage(value) : window.webkit.messageHandlers.terminal.postMessage(JSON.stringify(value))")?;
        let raw = replace_once(raw, "let key = '', cursor = 0, live = false, composing = false;", "let key = '', cursor = 0, live = false, composing = false; let viewportActive=false;")?;
        let raw = replace_once(raw, "const terminal = new GhosttyWeb.Terminal", r#"
          // Pinned 0.4.0 ignores lineHeight in Terminal options. Its real
          // measurement seam must feed paint, selection and FitAddon together.
          const measure=GhosttyWeb.CanvasRenderer.prototype.measureFont;
          if(typeof measure!=='function')throw new Error('terminal_metrics_contract_changed');
          GhosttyWeb.CanvasRenderer.prototype.measureFont=function(){
            const natural=measure.call(this),height=Math.max(natural.height,Math.ceil(config.size*config.lineHeight));
            return {...natural,height,baseline:natural.baseline+Math.floor((height-natural.height)/2)};
          };
          const terminal = new GhosttyWeb.Terminal"#)?;
        let raw = replace_once(raw, "const drafts = new Map(), rejectedKeys = new Set();", "const drafts = new Map(), rejectedKeys = new Set(); let blockedOwner='', focusRequested=false;")?;
        let raw = replace_once(raw, "terminal.onData(send);", r#"
          // Preserve Ghostty's OSC8/regex detection and Ctrl/Command-click, but
          // route activation to the owning workspace instead of window.open.
          const clicks=new WeakMap(),detector=terminal.linkDetector;
          if(!detector||typeof detector.getLinkAt!=='function')throw new Error('terminal_link_contract_changed');
          document.addEventListener('click',event=>{
            if(event.isTrusted&&viewportActive&&!composing&&(event.ctrlKey||event.metaKey))clicks.set(event,{key});
          },true);
          const detect=detector.getLinkAt.bind(detector);
          detector.getLinkAt=async(...args)=>{
            const link=await detect(...args);
            if(!link)return link;
            return {...link,activate:event=>{
              const captured=clicks.get(event);clicks.delete(event);
              if(!captured||captured.key!==key||!viewportActive||composing||!key)return;
              const url=link.text;
              if(typeof url!=='string'||url.length>8192||!/^https?:\/\//i.test(url)||/[\x00-\x20\x7f\\]/.test(url))return;
              const local=/^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\])(?::\d+)?(?:[/?#]|$)/i.test(url);
              post({type:'openPreview',key:captured.key,url,mode:local?'preview':'external'});
            }};
          };
          terminal.onData(send);"#)?;
        let raw = replace_once(raw, "blocked=true;retain", "blocked=true;blockedOwner=item.key;retain")?;
        let raw = replace_once(raw, "if(value.focus&&live)input.focus();", "if((value.focus||focusRequested)&&live){input.focus();focusRequested=false;}")?;
        let raw = replace_once(raw, "const now = () => Date.now(), lineHeight = () => Math.max(12,Math.round(terminal.options.fontSize*1.35));", "const now = () => Date.now(), lineHeight = () => terminal.renderer.getMetrics().height;")?;
        let raw = replace_once(raw, "document.getElementById('terminal').addEventListener('click',()=>{if(live&&!moved)input.focus();});", "document.getElementById('terminal').addEventListener('click',()=>{if(live&&!moved&&!terminal.hasSelection())input.focus();});")?;
        let raw = replace_once(raw, "if(event.metaKey&&!keys[event.key])return;", "if((event.ctrlKey||event.metaKey)&&event.code==='KeyV')return;if(event.metaKey&&!keys[event.key])return;if(event.altKey&&!event.ctrlKey&&!event.metaKey&&event.key.length===1){event.preventDefault();send('\\x1b'+event.key);return;}")?;
        let raw = replace_once(raw, "const handler=e=>{e.preventDefault();e.clipboardData?.setData('text/plain',text);};\n            document.addEventListener('copy',handler);document.execCommand('copy');document.removeEventListener('copy',handler);return;", "copySelection();return;")?;
        let raw = replace_once(raw, "const keys={Escape:", r#"
          const copySelection=()=>{
            if(!viewportActive||!terminal.hasSelection())return;
            const text=terminal.getSelection();if(!text)return;
            const handler=event=>{event.preventDefault();event.clipboardData?.setData('text/plain',text);};
            document.addEventListener('copy',handler);
            try{document.execCommand('copy');}finally{document.removeEventListener('copy',handler);}
          };
          document.getElementById('terminal').addEventListener('mouseup',copySelection);
          document.addEventListener('copy',event=>{
            if(viewportActive&&terminal.hasSelection()){event.preventDefault();event.clipboardData?.setData('text/plain',terminal.getSelection());}
          });
          const keys={Escape:"#)?;
        // Use the same addon's real measured cells without its 50ms resize lock:
        // native dock layout must not lose a resize while a hidden page's timers
        // are throttled. No JS estimate or synthetic default cell dimensions.
        let raw = replace_once(raw, "const resize=()=>{fit.fit();if", "const resize=()=>{const measured=fit.proposeDimensions();if(!measured)return;terminal.resize(measured.cols,measured.rows);if")?;
        // Ghostty 0.4 writes to WASM synchronously; its optional callback waits
        // for requestAnimationFrame, which WKWebView suspends while occluded.
        // ACK the actual VT commit, not an unobservable promise of pixel paint.
        let raw = replace_once(raw,
          "pending.forEach((chunk,index)=>{cursor=chunk.id;terminal.write(chunk.data,index===pending.length-1?()=>post({type:'ack',key:value.key,cursor:chunk.id,serial:value.serial}):undefined);});",
          "pending.forEach(chunk=>{terminal.write(chunk.data);cursor=chunk.id;});if(pending.length)post({type:'ack',key:value.key,cursor,serial:value.serial});")?;
        replace_once(raw, "post({type:'ready'});resize();", r#"
          window.terminalDesktopFocus=()=>{focusRequested=true;if(live){input.focus();focusRequested=false;}};
          window.terminalDesktopResize=resize;
          window.terminalDesktopActive=active=>{viewportActive=active===true;if(!active)window.terminalRender({type:'render',key,live:false,chunks:[],serial:0});};
          window.terminalDesktopConfigure=value=>{config.size=value.size;config.lineHeight=value.lineHeight;terminal.options.theme=value.palette;terminal.options.fontFamily=value.family;terminal.options.fontSize=value.size;input.setAttribute('aria-label',value.label);resize();};
          window.terminalDesktopInputResult=value=>{
            if(value.status==='suspended'){
              const item=queue[0];if(item&&item.sent&&item.key===value.key&&item.receipt===value.receipt){retain(removeQueued(pending=>pending.key===value.key));pump();}return;
            }
            if(value.status==='closed'){
              removeQueued(item=>item.key===value.key);drafts.delete(value.key);rejectedKeys.delete(value.key);
              if(key===value.key)input.value='';
              if(blockedOwner===value.key){blocked=false;blockedOwner='';}return;
            }
            if(value.status==='retry'){if(!blocked)rejectedKeys.delete(value.key);return;}
            window.terminalInputResult(value);
          };
          input.addEventListener('focus',()=>post({type:'focus',focused:true}));
          input.addEventListener('blur',()=>post({type:'focus',focused:false}));
          input.addEventListener('compositionstart',()=>post({type:'composition',composing:true}));
          input.addEventListener('compositionend',()=>post({type:'composition',composing:false}));
          let shortcuts=[];
          window.terminalDesktopShortcuts=value=>{shortcuts=Array.isArray(value)?value:[];};
          document.addEventListener('keydown',event=>{
            if(!live||composing||event.isComposing||event.keyCode===229)return;
            const punctuation={Backquote:'`',BracketLeft:'[',BracketRight:']',Equal:'=',Minus:'-',Backslash:'\\',Semicolon:';',Quote:"'",Comma:',',Period:'.',Slash:'/'};
            const keys={ArrowUp:'up',ArrowDown:'down',ArrowLeft:'left',ArrowRight:'right',' ':'space',Escape:'escape',PageUp:'pageup',PageDown:'pagedown'};
            const stroke=[event.metaKey?'cmd':'',event.ctrlKey?'ctrl':'',event.shiftKey?'shift':'',event.altKey?'alt':'',punctuation[event.code]||keys[event.key]||String(event.key).toLowerCase()].filter(Boolean).join('+');
            const action=shortcuts.find(value=>value.keystroke===stroke);
            if(action){event.preventDefault();event.stopImmediatePropagation();post({type:'shortcut',actionId:action.actionId,keystroke:stroke});}
          },true);
          const receive=message=>{
            if(!message||JSON.stringify(message.bridge)!==JSON.stringify(config.bridge))return;
            switch(message.command){
              case 'render':window.terminalRender(message.value);break;
              case 'focus':window.terminalDesktopFocus();break;
              case 'active':window.terminalDesktopActive(message.value);break;
              case 'configure':window.terminalDesktopConfigure(message.value);break;
              case 'layout':resize();break;
              case 'inputResult':window.terminalDesktopInputResult(message.value);break;
              case 'shortcuts':window.terminalDesktopShortcuts(message.value);break;
            }
          };
          if(window.chrome?.webview)window.chrome.webview.addEventListener('message',event=>{
            try{receive(event.data);}catch{post({type:'error',code:'renderer_command_failed'});}
          });
          post({type:'ready',version:1});resize();
        "#)
    }).as_ref().map(String::as_str).map_err(Clone::clone)
}
fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for group in bytes.chunks(3) {
        let n = (u32::from(group[0]) << 16)
            | (u32::from(*group.get(1).unwrap_or(&0)) << 8)
            | u32::from(*group.get(2).unwrap_or(&0));
        result.push(TABLE[((n >> 18) & 63) as usize] as char);
        result.push(TABLE[((n >> 12) & 63) as usize] as char);
        result.push(if group.len() > 1 {
            TABLE[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        result.push(if group.len() > 2 {
            TABLE[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    result
}
pub fn configuration(value: &Value) -> Result<()> {
    let palette = value["palette"]
        .as_object()
        .ok_or("terminal_palette_missing")?;
    let allowed = [
        "background",
        "foreground",
        "cursor",
        "selectionBackground",
        "cursorAccent",
        "selectionForeground",
        "selectionInactiveBackground",
        "black",
        "red",
        "green",
        "yellow",
        "blue",
        "magenta",
        "cyan",
        "white",
        "brightBlack",
        "brightRed",
        "brightGreen",
        "brightYellow",
        "brightBlue",
        "brightMagenta",
        "brightCyan",
        "brightWhite",
    ];
    if !["background", "foreground", "cursor", "selectionBackground"]
        .iter()
        .all(|k| palette.contains_key(*k))
        || palette.iter().any(|(key, value)| {
            !allowed.contains(&key.as_str())
                || value.as_str().is_none_or(|s| {
                    !matches!(s.len(), 7 | 9)
                        || !s.starts_with('#')
                        || !s.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
                })
        })
        || value["family"]
            .as_str()
            .is_none_or(|s| s.is_empty() || s.len() > 1024 || s.chars().any(char::is_control))
        || value["label"].as_str().is_none_or(|s| s.len() > 1024)
        || value["size"]
            .as_f64()
            .is_none_or(|n| !(6.0..=72.0).contains(&n))
        || value["lineHeight"]
            .as_f64()
            .is_none_or(|n| !(1.0..=3.0).contains(&n))
    {
        return Err("terminal_configuration_invalid".into());
    }
    Ok(())
}
pub fn render(value: &Value) -> Result<String> {
    configuration(value)?;
    let mut config = value.clone();
    config["wasm"] = json!(base64(WASM));
    let config = config.to_string().replace('<', "\\u003c");
    let source = JAVASCRIPT.replace("</script", "<\\/script");
    Ok(format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="{POLICY}"><style>html,body,#terminal{{width:100%;height:100%;margin:0;overflow:hidden;background:{background}}}#input{{position:absolute;left:0;bottom:0;width:1px;height:1px;opacity:.01;font-size:16px}}</style></head><body><div id="terminal"></div><textarea id="input" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></textarea><script>{source}</script><script>{bootstrap}
startNativeTerminal({config});</script></body></html>"#,
        background = value["palette"]["background"].as_str().unwrap_or(""),
        bootstrap = bootstrap()?
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn uses_pinned_real_offline_assets_and_production_bootstrap() {
        let value = json!({"palette":{"background":"#ffffff","foreground":"#212121","cursor":"#212121","selectionBackground":"#cccccc"},"family":"monospace","size":13,"lineHeight":1.625,"label":"</script>"});
        let html = render(&value).unwrap();
        assert!(html.contains("WebAssembly.instantiate"));
        assert!(html.contains("new GhosttyWeb.Terminal"));
        assert!(html.contains("terminalDesktopInputResult"));
        assert!(!html.contains("src=\"http"));
        assert!(html.contains("\\u003c/script>"));
        assert!(html.contains("connect-src 'none'"));
        assert_eq!(base64(b"abcde"), "YWJjZGU=");
        let mut invalid = value;
        invalid["palette"]["background"] = json!("red; background:url(https://invalid)");
        assert!(render(&invalid).is_err());
    }
}
