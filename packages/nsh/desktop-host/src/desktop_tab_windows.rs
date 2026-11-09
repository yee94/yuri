//! No child HWND, drawing, keymap or subclass. The existing window_proc calls
//! observe_window_message and always continues its original DefSubclassProc path.
use super::*;
use nsh_platform_windows as platform;
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    ffi::c_void,
    rc::Rc,
};
type Hwnd = *mut c_void;
thread_local! { static WINDOWS: RefCell<HashMap<usize, Registration>> = RefCell::new(HashMap::new()); }
#[link(name = "user32")]
unsafe extern "system" {
    fn GetDpiForWindow(hwnd: Hwnd) -> u32;
    fn GetForegroundWindow() -> Hwnd;
    fn IsWindowEnabled(hwnd: Hwnd) -> i32;
}
struct Component {
    context: platform::ComponentContext,
    registration: Registration,
    id: u64,
    epoch: u64,
}
impl platform::NativeComponent for Component {
    // Deliberately no window(): NSH's default returns None.
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
    let registration = Registration::default();
    let shared = registration.clone();
    components.register(
        COMPONENT,
        Rc::new(move |context| {
            context.set_size(0., 0.);
            Box::new(Component {
                context,
                registration: shared.clone(),
                id: NEXT.fetch_add(1, Ordering::Relaxed),
                epoch: shared.epoch(),
            })
        }),
    );
    Ok(registration)
}
pub struct Observer {
    registration: Registration,
    hwnd: Hwnd,
    alive: Cell<bool>,
}
pub fn install_observer(registration: &Registration, hwnd: Hwnd) -> Result<Observer> {
    if WINDOWS.with(|windows| windows.borrow().contains_key(&(hwnd as usize))) {
        return Err("desktop_tab_window_already_installed".into());
    }
    registration.attach_window(hwnd as usize)?;
    WINDOWS.with(|windows| {
        windows
            .borrow_mut()
            .insert(hwnd as usize, registration.clone())
    });
    Ok(Observer {
        registration: registration.clone(),
        hwnd,
        alive: Cell::new(true),
    })
}
impl Observer {
    pub fn poll(&self, actual_foreground: bool, native_modal_blocked: bool) {
        if !self.alive.get() {
            return;
        }
        self.registration.gate(
            actual_foreground && unsafe { GetForegroundWindow() == self.hwnd },
            native_modal_blocked || unsafe { IsWindowEnabled(self.hwnd) == 0 },
        );
    }
    pub fn retire(&self) {
        if !self.alive.replace(false) {
            return;
        }
        WINDOWS.with(|windows| windows.borrow_mut().remove(&(self.hwnd as usize)));
        self.registration.retire_window();
    }
}
impl Drop for Observer {
    fn drop(&mut self) {
        self.retire();
    }
}
pub fn observe_window_message(hwnd: Hwnd, message: u32, wparam: usize, lparam: isize) {
    let registration = WINDOWS.with(|windows| windows.borrow().get(&(hwnd as usize)).cloned());
    let Some(registration) = registration else {
        return;
    };
    // Clone above releases the RefCell before any event can re-enter the UI.
    if unsafe { GetForegroundWindow() != hwnd || IsWindowEnabled(hwnd) == 0 } {
        registration.gate(false, true);
        return;
    }
    let input = match message {
        0x0207 | 0x0208 | 0x0201 => {
            let Some(p) = windows_client_point(lparam, unsafe { GetDpiForWindow(hwnd) }) else {
                registration.observe(NativeInput::Cancel, true);
                return;
            };
            match message {
                0x0207 => NativeInput::MiddleDown(p),
                0x0208 => NativeInput::MiddleUp(p),
                _ => NativeInput::LeftDown(p),
            }
        }
        0x0008 | 0x0082 => NativeInput::Blur,
        0x001c if wparam == 0 => NativeInput::Blur,
        0x0215 | 0x001f | 0x0204 | 0x0209 | 0x020a | 0x020e | 0x0005 | 0x02e0 => {
            NativeInput::Cancel
        }
        _ => return,
    };
    registration.observe(input, true);
}
