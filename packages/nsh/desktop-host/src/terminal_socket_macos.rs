//! NSURLSessionWebSocketTask with an ephemeral, cookie-free session and denied redirects.
//! Selectors and block signatures follow Foundation's public NSURLSession headers.
use super::*;
use nsh_platform_macos::{
    objc2,
    objc2_foundation::{NSData, NSObject, NSObjectProtocol, NSString, NSURL},
};
use objc2::{
    AnyThread, DefinedClass, define_class, msg_send,
    rc::{Allocated, Retained},
    runtime::{AnyClass, AnyObject, Sel},
    sel,
};
use std::ffi::c_void;

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind=AnyThread]
    #[ivars=Arc<Signals>]
    #[name="YuriTerminalSocketDelegate"]
    struct Delegate;
    unsafe impl NSObjectProtocol for Delegate {}
    impl Delegate {
        #[unsafe(method(URLSession:webSocketTask:didOpenWithProtocol:))]
        fn opened(&self,_session:&AnyObject,_task:&AnyObject,_protocol:Option<&NSString>) {self.ivars().emit(Event::Open);}
        #[unsafe(method(URLSession:webSocketTask:didCloseWithCloseCode:reason:))]
        fn closed(&self,_session:&AnyObject,_task:&AnyObject,_code:isize,_reason:Option<&NSData>) {self.ivars().emit(Event::Failed);}
        #[unsafe(method(URLSession:task:didCompleteWithError:))]
        fn completed(&self,_session:&AnyObject,_task:&AnyObject,_error:Option<&AnyObject>) {self.ivars().emit(Event::Failed);}
        #[unsafe(method(URLSession:task:willPerformHTTPRedirection:newRequest:completionHandler:))]
        unsafe fn redirect(&self,_session:&AnyObject,_task:&AnyObject,_response:&AnyObject,_request:&AnyObject,completion:*mut c_void) {
            let header=unsafe{&*completion.cast::<Header>()};
            let invoke:unsafe extern "C" fn(*mut c_void,*mut AnyObject)=unsafe{std::mem::transmute(header.invoke)};
            unsafe{invoke(completion,std::ptr::null_mut());}
            self.ivars().emit(Event::Failed);
        }
    }
);

#[repr(C)]
struct Header {
    isa: *const c_void,
    flags: i32,
    reserved: i32,
    invoke: *const c_void,
    descriptor: *const Descriptor,
}
#[repr(C)]
struct Block {
    header: Header,
    signals: *const Signals,
}
#[repr(C)]
struct Descriptor {
    reserved: usize,
    size: usize,
    copy: unsafe extern "C" fn(*mut Block, *const Block),
    dispose: unsafe extern "C" fn(*mut Block),
    signature: *const u8,
}
unsafe impl Sync for Descriptor {}
unsafe extern "C" {
    static _NSConcreteStackBlock: c_void;
}
#[link(name = "objc")]
unsafe extern "C" {
    fn objc_msgSend();
}
unsafe extern "C" fn copy(dst: *mut Block, src: *const Block) {
    unsafe {
        (*dst).signals = (*src).signals;
        Arc::increment_strong_count((*src).signals);
    }
}
unsafe extern "C" fn dispose(block: *mut Block) {
    unsafe {
        Arc::decrement_strong_count((*block).signals);
    }
}
static RECEIVE: Descriptor = Descriptor {
    reserved: 0,
    size: std::mem::size_of::<Block>(),
    copy,
    dispose,
    signature: c"v@?@@".as_ptr().cast(),
};
static SEND: Descriptor = Descriptor {
    reserved: 0,
    size: std::mem::size_of::<Block>(),
    copy,
    dispose,
    signature: c"v@?@".as_ptr().cast(),
};
unsafe extern "C" fn received(block: *mut Block, message: *mut AnyObject, error: *mut AnyObject) {
    let signals = unsafe { &*(*block).signals };
    let value = (|| unsafe {
        if !error.is_null() || message.is_null() {
            return None;
        }
        let kind: isize = msg_send![message, type];
        if kind == 0 {
            let data: *mut AnyObject = msg_send![message, data];
            if data.is_null() {
                return None;
            }
            let length: usize = msg_send![data, length];
            if length > LIMIT {
                return None;
            }
            // NSData's OS_dispatch_data subclass encodes `bytes` as char* rather than
            // void*. Both are the documented byte pointer ABI; no C-string decoding.
            let bytes: unsafe extern "C" fn(*mut AnyObject, Sel) -> *const u8 =
                std::mem::transmute(objc_msgSend as *const c_void);
            let ptr = bytes(data, sel!(bytes));
            if length == 0 {
                Some(Message::Binary(Vec::new()))
            } else if ptr.is_null() {
                None
            } else {
                Some(Message::Binary(
                    std::slice::from_raw_parts(ptr, length).to_vec(),
                ))
            }
        } else if kind == 1 {
            let text: *mut NSString = msg_send![message, string];
            if text.is_null() {
                return None;
            }
            let length: usize = msg_send![text,lengthOfBytesUsingEncoding:4usize];
            (length <= LIMIT).then(|| Message::Text((&*text).to_string()))
        } else {
            None
        }
    })();
    signals.emit(value.map(Event::Message).unwrap_or(Event::Failed));
}
unsafe extern "C" fn sent(block: *mut Block, error: *mut AnyObject) {
    unsafe { &*(*block).signals }.emit(Event::Sent(error.is_null()));
}
fn block(signals: Arc<Signals>, descriptor: &'static Descriptor, invoke: *const c_void) -> Block {
    Block {
        header: Header {
            isa: std::ptr::addr_of!(_NSConcreteStackBlock),
            flags: (1 << 25) | (1 << 30),
            reserved: 0,
            invoke,
            descriptor,
        },
        signals: Arc::into_raw(signals),
    }
}
impl Drop for Block {
    fn drop(&mut self) {
        unsafe {
            drop(Arc::from_raw(self.signals));
        }
    }
}
pub struct Socket {
    session: Retained<AnyObject>,
    task: Retained<AnyObject>,
    signals: Arc<Signals>,
    rx: mpsc::Receiver<Event>,
    pending: bool,
}
impl Drop for Socket {
    fn drop(&mut self) {
        unsafe {
            let _: () = msg_send![&*self.task,cancelWithCloseCode:1001isize, reason:std::ptr::null::<AnyObject>()];
            let _: () = msg_send![&*self.session, invalidateAndCancel];
        }
    }
}
impl Socket {
    pub fn open(origin: &str, token: &str, current: &dyn Fn() -> bool) -> Result<Self> {
        objc2::rc::autoreleasepool(|_| unsafe {
            if !current() {
                return Err("terminal_scope_stale".into());
            }
            let (tx, rx) = mpsc::sync_channel(8);
            let signals = Arc::new(Signals {
                tx,
                overflow: Arc::new(AtomicBool::new(false)),
            });
            let delegate: Retained<Delegate> =
                msg_send![super(Delegate::alloc().set_ivars(signals.clone())), init];
            let config =
                AnyClass::get(c"NSURLSessionConfiguration").ok_or("terminal_ws_unavailable")?;
            let config: Retained<AnyObject> = msg_send![config, ephemeralSessionConfiguration];
            let _: () = msg_send![&*config,setHTTPCookieStorage:std::ptr::null::<AnyObject>()];
            let _: () = msg_send![&*config,setURLCache:std::ptr::null::<AnyObject>()];
            let _: () = msg_send![&*config,setURLCredentialStorage:std::ptr::null::<AnyObject>()];
            let _: () = msg_send![&*config,setHTTPShouldSetCookies:false];
            let _: () = msg_send![&*config,setTimeoutIntervalForRequest:15f64];
            let _: () = msg_send![&*config,setTimeoutIntervalForResource:604800f64];
            let url = format!(
                "{}://{}/api/terminal/ws",
                if origin.starts_with("https:") {
                    "wss"
                } else {
                    "ws"
                },
                origin
                    .split_once("://")
                    .ok_or("terminal_request_invalid")?
                    .1
            );
            let url = NSURL::URLWithString(&NSString::from_str(&url))
                .ok_or("terminal_request_invalid")?;
            let request = AnyClass::get(c"NSMutableURLRequest").ok_or("terminal_ws_unavailable")?;
            let request: Retained<AnyObject> = msg_send![request,requestWithURL:&*url];
            let _: () = msg_send![&*request,setValue:&*NSString::from_str(&format!("Bearer {token}")), forHTTPHeaderField:&*NSString::from_str("Authorization")];
            let _: () = msg_send![&*request,setValue:&*NSString::from_str(origin), forHTTPHeaderField:&*NSString::from_str("Origin")];
            let _: () = msg_send![&*request,setHTTPShouldHandleCookies:false];
            let class = AnyClass::get(c"NSURLSession").ok_or("terminal_ws_unavailable")?;
            let session: Retained<AnyObject> = msg_send![class,sessionWithConfiguration:&*config, delegate:&*delegate, delegateQueue:std::ptr::null::<AnyObject>()];
            let task: Retained<AnyObject> = msg_send![&*session,webSocketTaskWithRequest:&*request];
            let _: () = msg_send![&*task,setMaximumMessageSize:LIMIT as isize];
            let socket = Self {
                session,
                task,
                signals,
                rx,
                pending: false,
            };
            let _: () = msg_send![&*socket.task, resume];
            let deadline = Instant::now() + Duration::from_secs(15);
            loop {
                match wait(&socket.rx, &socket.signals.overflow, deadline, current)? {
                    Some(Event::Open) => return Ok(socket),
                    None => {}
                    _ => return Err("terminal_ws_upgrade_failed".into()),
                }
            }
        })
    }
    pub fn poll(&mut self, current: &dyn Fn() -> bool) -> Result<Option<Message>> {
        if !self.pending {
            if !current() {
                return Err("terminal_scope_stale".into());
            }
            let mut completion = block(self.signals.clone(), &RECEIVE, received as *const c_void);
            unsafe {
                let invoke: unsafe extern "C" fn(*const AnyObject, Sel, *mut Block) =
                    std::mem::transmute(objc_msgSend as *const c_void);
                invoke(
                    Retained::as_ptr(&self.task),
                    sel!(receiveMessageWithCompletionHandler:),
                    &mut completion,
                );
            }
            self.pending = true;
        }
        match wait(
            &self.rx,
            &self.signals.overflow,
            Instant::now() + Duration::from_secs(1),
            current,
        )? {
            Some(Event::Message(message)) => {
                self.pending = false;
                Ok(Some(message))
            }
            None => Ok(None),
            _ => Err("terminal_ws_disconnected".into()),
        }
    }
    pub fn send(&mut self, message: Message, current: &dyn Fn() -> bool) -> Result<()> {
        objc2::rc::autoreleasepool(|_| unsafe {
            if !current() {
                return Err("terminal_scope_stale".into());
            }
            let class =
                AnyClass::get(c"NSURLSessionWebSocketMessage").ok_or("terminal_ws_unavailable")?;
            let message: Retained<AnyObject> = match message {
                Message::Text(text) => {
                    if text.len() > 65_536 {
                        return Err("terminal_input_limit".into());
                    }
                    let object: Allocated<AnyObject> = msg_send![class, alloc];
                    msg_send![object,initWithString:&*NSString::from_str(&text)]
                }
                Message::Binary(bytes) => {
                    if bytes.len() > 65_536 {
                        return Err("terminal_input_limit".into());
                    }
                    let object: Allocated<AnyObject> = msg_send![class, alloc];
                    msg_send![object,initWithData:&*NSData::with_bytes(&bytes)]
                }
            };
            let (tx, rx) = mpsc::sync_channel(1);
            let full = Arc::new(AtomicBool::new(false));
            let mut completion = block(
                Arc::new(Signals {
                    tx,
                    overflow: full.clone(),
                }),
                &SEND,
                sent as *const c_void,
            );
            let invoke: unsafe extern "C" fn(*const AnyObject, Sel, *const AnyObject, *mut Block) =
                std::mem::transmute(objc_msgSend as *const c_void);
            invoke(
                Retained::as_ptr(&self.task),
                sel!(sendMessage:completionHandler:),
                Retained::as_ptr(&message),
                &mut completion,
            );
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                match wait(&rx, &full, deadline, current)? {
                    Some(Event::Sent(true)) => return Ok(()),
                    None => {}
                    _ => return Err("terminal_ws_send_unknown".into()),
                }
            }
        })
    }
}
