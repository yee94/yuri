//! A real zero-size NSView carries only ComponentContext. All mouse events are
//! observed at the existing NSWindow, never by an overlay or first responder.
use super::*;
use foundation::{NSObjectProtocol, NSRect, NSSize};
use kit::{NSApplication, NSEvent, NSView, NSWindow};
use nsh_platform_macos::{
    self as platform, objc2, objc2_app_kit as kit, objc2_foundation as foundation,
};
use objc2::{
    MainThreadMarker, MainThreadOnly, Message, define_class, msg_send,
    rc::Retained,
    runtime::{AnyClass, AnyObject},
};
use std::{cell::Cell, ffi::c_void, rc::Rc};

define_class!(
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[name = "YuriDesktopTabZeroView"]
    struct ZeroView;
    unsafe impl NSObjectProtocol for ZeroView {}
    impl ZeroView {
        #[unsafe(method(setFrame:))]
        fn zero_frame(&self, mut frame: NSRect) {
            frame.size = NSSize::new(0., 0.);
            unsafe { let _: () = msg_send![super(self), setFrame: frame]; }
        }
        #[unsafe(method(setFrameSize:))]
        fn zero_size(&self, _: NSSize) {
            unsafe { let _: () = msg_send![super(self), setFrameSize: NSSize::new(0., 0.)]; }
        }
    }
);
struct Component {
    view: Retained<NSView>,
    context: platform::ComponentContext,
    registration: Registration,
    id: u64,
    epoch: u64,
}
impl platform::NativeComponent for Component {
    fn view(&self) -> Retained<NSView> {
        self.view.clone()
    }
    fn set_prop(&mut self, name: &str, value: Option<&Value>) {
        if name == "binding" {
            let context = self.context.clone();
            self.registration.bind_epoch(
                self.id,
                self.epoch,
                value,
                Arc::new(move |name, data| context.emit(name, data)),
            );
        }
    }
}
impl Drop for Component {
    fn drop(&mut self) {
        self.registration.detach(self.id);
    }
}
pub fn register(components: &platform::Components) -> Result<Registration> {
    let mtm = MainThreadMarker::new().ok_or("desktop_tab_main_thread_required")?;
    let registration = Registration::default();
    let shared = registration.clone();
    components.register(
        COMPONENT,
        Rc::new(move |context| {
            let view: Retained<ZeroView> =
                unsafe { msg_send![ZeroView::alloc(mtm), initWithFrame: NSRect::ZERO] };
            context.set_size(0., 0.);
            Box::new(Component {
                view: view.into_super(),
                context,
                registration: shared.clone(),
                id: NEXT.fetch_add(1, Ordering::Relaxed),
                epoch: shared.epoch(),
            })
        }),
    );
    Ok(registration)
}
struct Monitor {
    registration: Registration,
    window: Retained<NSWindow>,
    root: Retained<NSView>,
    alive: Cell<bool>,
    active: Cell<bool>,
    blocked: Cell<bool>,
}
impl Monitor {
    fn gate(&self) {
        let mtm = MainThreadMarker::new().expect("AppKit monitor is main-thread only");
        let modal = NSApplication::sharedApplication(mtm)
            .modalWindow()
            .is_some()
            || self.window.attachedSheet().is_some();
        self.registration.gate(
            self.alive.get() && self.active.get() && self.window.isKeyWindow(),
            self.blocked.get() || modal,
        );
    }
}
// Clang copied Blocks ABI, matching browser_view_macos's existing no-dependency
// implementation. The event is observed only; the original NSEvent is returned.
#[repr(C)]
struct Header {
    isa: *const c_void,
    flags: i32,
    reserved: i32,
    invoke: *const c_void,
    descriptor: *const c_void,
}
#[repr(C)]
struct Block {
    header: Header,
    state: *const Monitor,
}
unsafe impl objc2::encode::RefEncode for Block {
    const ENCODING_REF: objc2::encode::Encoding = objc2::encode::Encoding::Block;
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
unsafe extern "C" fn copy(dst: *mut Block, src: *const Block) {
    unsafe {
        (*dst).state = (*src).state;
        Rc::increment_strong_count((*src).state);
    }
}
unsafe extern "C" fn dispose(block: *mut Block) {
    unsafe {
        Rc::decrement_strong_count((*block).state);
    }
}
unsafe extern "C" fn observe(block: *mut Block, event: *mut NSEvent) -> *mut NSEvent {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let state = unsafe { &*(*block).state };
        if !state.alive.get() || event.is_null() {
            return;
        }
        let event = unsafe { &*event };
        state.gate();
        if event.windowNumber() != state.window.windowNumber() {
            state.registration.observe(NativeInput::Blur, false);
            return;
        }
        let point = state
            .root
            .convertPoint_fromView(event.locationInWindow(), None);
        let point = Point {
            x: point.x,
            y: if state.root.isFlipped() {
                point.y
            } else {
                state.root.bounds().size.height - point.y
            },
        };
        let kind = event.r#type().0;
        let input = match kind {
            1 => NativeInput::LeftDown(point),
            25 if event.buttonNumber() == 2 => NativeInput::MiddleDown(point),
            26 if event.buttonNumber() == 2 => NativeInput::MiddleUp(point),
            _ => NativeInput::Cancel,
        };
        state.registration.observe(input, false);
    }));
    event
}
static DESCRIPTOR: Descriptor = Descriptor {
    reserved: 0,
    size: std::mem::size_of::<Block>(),
    copy,
    dispose,
    signature: c"@@?@".as_ptr().cast(),
};
unsafe extern "C" {
    static _NSConcreteStackBlock: c_void;
}
pub struct Observer {
    token: Option<Retained<AnyObject>>,
    state: Rc<Monitor>,
}
pub fn install_observer(
    registration: &Registration,
    window: &NSWindow,
    root: &NSView,
    _: MainThreadMarker,
) -> Result<Observer> {
    let event_class = AnyClass::get(c"NSEvent").ok_or("desktop_tab_event_class_missing")?;
    registration.attach_window(window as *const _ as usize)?;
    let state = Rc::new(Monitor {
        registration: registration.clone(),
        window: window.retain(),
        root: root.retain(),
        alive: Cell::new(true),
        active: Cell::new(false),
        blocked: Cell::new(true),
    });
    let block = Block {
        header: Header {
            isa: &raw const _NSConcreteStackBlock,
            flags: (1 << 25) | (1 << 30),
            reserved: 0,
            invoke: observe as *const c_void,
            descriptor: &DESCRIPTOR as *const _ as *const c_void,
        },
        state: Rc::as_ptr(&state),
    };
    let token: Option<Retained<AnyObject>> = unsafe {
        msg_send![event_class, addLocalMonitorForEventsMatchingMask: (1usize << 25) | (1usize << 26) | (1usize << 27) | (1usize << 1) | (1usize << 3) | (1usize << 22), handler: &block as *const Block]
    };
    if token.is_none() {
        registration.retire_window();
        return Err("desktop_tab_monitor_failed".into());
    }
    Ok(Observer { token, state })
}
impl Observer {
    pub fn poll(&self, actual_foreground: bool, native_modal_blocked: bool) {
        if !self.state.alive.get() {
            return;
        }
        self.state.active.set(actual_foreground);
        self.state.blocked.set(native_modal_blocked);
        self.state.gate();
    }
    pub fn retire(&self) {
        if self.state.alive.replace(false) {
            self.state.registration.retire_window();
        }
    }
}
impl Drop for Observer {
    fn drop(&mut self) {
        self.retire();
        if let Some(token) = self.token.take() {
            unsafe {
                let _: () =
                    msg_send![AnyClass::get(c"NSEvent").expect("NSEvent"), removeMonitor: &*token];
            }
        }
    }
}
