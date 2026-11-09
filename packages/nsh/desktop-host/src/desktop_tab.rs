//! Zero-area component event registration. No tab state, Host methods, credentials,
//! windows, network, editor or close decision is owned here.
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, Ordering},
};

pub const COMPONENT: &str = "yuri.desktop.tab-events";
pub type Result<T> = std::result::Result<T, String>;
type Emit = Arc<dyn Fn(&str, Value) + Send + Sync>;
static NEXT: AtomicU64 = AtomicU64::new(1);
const MAX_HANDLES: usize = 256;
const MAX_SAFE: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}
/// Win32 signed client pixels -> NSH page points. Kept platform-independent so
/// the exact coordinate math is tested without claiming a Windows target build.
#[cfg(any(target_os = "windows", test))]
pub fn windows_client_point(lparam: isize, dpi: u32) -> Option<Point> {
    if dpi == 0 {
        return None;
    }
    let x = (lparam as u16 as i16) as f64;
    let y = ((lparam >> 16) as u16 as i16) as f64;
    Some(Point {
        x: x * 96. / dpi as f64,
        y: y * 96. / dpi as f64,
    })
}
#[derive(Clone, Copy, Debug, PartialEq)]
struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}
impl Rect {
    fn contains(self, p: Point) -> bool {
        p.x >= self.x && p.y >= self.y && p.x < self.x + self.width && p.y < self.y + self.height
    }
}
#[derive(Clone, Debug, PartialEq)]
struct Binding {
    owner: String,
    generation: u64,
    revision: u64,
    expected: Value,
    rect: Rect,
    active: bool,
}
fn binding(value: &Value) -> Option<Binding> {
    let obj = value.as_object()?;
    if obj.len() != 6
        || ![
            "owner",
            "generation",
            "revision",
            "expectedHost",
            "rect",
            "active",
        ]
        .iter()
        .all(|k| obj.contains_key(*k))
    {
        return None;
    }
    let owner = value["owner"].as_str()?;
    if owner.is_empty()
        || owner.len() > 128
        || !owner
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_:".contains(&c))
    {
        return None;
    }
    let generation = value["generation"].as_u64()?;
    let revision = value["revision"].as_u64()?;
    if generation == 0 || generation > MAX_SAFE || revision == 0 || revision > MAX_SAFE {
        return None;
    }
    let expected = crate::policy::scope(&value["expectedHost"]).ok()?;
    if expected != value["expectedHost"] {
        return None;
    }
    let r = value["rect"].as_object()?;
    if r.len() != 4 {
        return None;
    }
    let rect = Rect {
        x: r.get("x")?.as_f64()?,
        y: r.get("y")?.as_f64()?,
        width: r.get("width")?.as_f64()?,
        height: r.get("height")?.as_f64()?,
    };
    if ![rect.x, rect.y, rect.width, rect.height]
        .iter()
        .all(|v| v.is_finite() && v.abs() <= 100_000.)
        || rect.width <= 0.
        || rect.height <= 0.
    {
        return None;
    }
    Some(Binding {
        owner: owner.into(),
        generation,
        revision,
        expected,
        rect,
        active: value["active"].as_bool()?,
    })
}
#[derive(Clone)]
struct Entry {
    binding: Binding,
    emit: Emit,
}
#[derive(Default)]
struct Book {
    scope: Option<Value>,
    epoch: u64,
    entries: BTreeMap<u64, Entry>,
    pressed: Option<(u64, Binding)>,
    focused: Option<u64>,
    enabled: bool,
    window: Option<usize>,
    sequence: u64,
}
#[derive(Clone, Default)]
pub struct Registration {
    book: Arc<Mutex<Book>>,
}
#[derive(Clone, Copy, Debug)]
pub enum NativeInput {
    MiddleDown(Point),
    MiddleUp(Point),
    LeftDown(Point),
    Cancel,
    Blur,
}
struct Delivery {
    id: u64,
    epoch: u64,
    emit: Emit,
    name: &'static str,
    data: Value,
}
impl Delivery {
    fn send(self, registration: &Registration) {
        let current = registration.book.lock().is_ok_and(|b| {
            b.epoch == self.epoch
                && b.entries.get(&self.id).is_some_and(|e| {
                    e.binding.owner == self.data["owner"]
                        && e.binding.generation == self.data["generation"]
                        && e.binding.revision == self.data["revision"]
                        && b.scope.as_ref() == Some(&e.binding.expected)
                        && (self.name == "tabBlur" || (b.enabled && e.binding.active))
                })
        });
        if current {
            (self.emit)(self.name, self.data);
        }
    }
}
impl Book {
    fn current(&self, b: &Binding) -> bool {
        b.active && self.scope.as_ref() == Some(&b.expected)
    }
    fn hit(&self, p: Point) -> Option<u64> {
        if !self.enabled {
            return None;
        }
        let mut hits = self
            .entries
            .iter()
            .filter(|(_, e)| self.current(&e.binding) && e.binding.rect.contains(p));
        let id = *hits.next()?.0;
        if hits.next().is_some() {
            None
        } else {
            Some(id)
        }
    }
    fn delivery(&mut self, id: u64, name: &'static str) -> Option<Delivery> {
        let e = self.entries.get(&id)?;
        if self.scope.as_ref() != Some(&e.binding.expected) {
            return None;
        }
        self.sequence = self.sequence.checked_add(1).filter(|n| *n <= MAX_SAFE)?;
        Some(Delivery {
            id,
            epoch: self.epoch,
            emit: e.emit.clone(),
            name,
            data: json!({
                "owner": e.binding.owner, "generation": e.binding.generation, "revision": e.binding.revision,
                "expectedHost": e.binding.expected, "sequence": self.sequence,
            }),
        })
    }
    fn blur(&mut self, out: &mut Vec<Delivery>) {
        if let Some(id) = self.focused.take()
            && let Some(event) = self.delivery(id, "tabBlur")
        {
            out.push(event);
        }
    }
}
impl Registration {
    /// Called only by the existing native committed-authority publisher. Same
    /// scope is a no-op; any retirement fences all contexts before returning.
    pub fn set_scope(&self, value: Option<&Value>) -> Result<()> {
        if value.is_some_and(|v| crate::policy::scope(v).map_or(true, |s| s != *v)) {
            return Err("desktop_tab_scope_invalid".into());
        }
        let mut b = self.book.lock().map_err(|_| "desktop_tab_unavailable")?;
        if b.scope.as_ref() == value {
            return Ok(());
        }
        b.scope = value.cloned();
        b.epoch += 1;
        b.entries.clear();
        b.pressed = None;
        b.focused = None;
        Ok(())
    }
    /// Test-only observation of the existing native publication; never a JS API.
    #[cfg(test)]
    pub(crate) fn current_scope(&self) -> Option<Value> {
        self.book
            .lock()
            .expect("desktop tab test scope lock poisoned")
            .scope
            .clone()
    }
    fn epoch(&self) -> u64 {
        self.book.lock().map(|b| b.epoch).unwrap_or(u64::MAX)
    }
    fn bind(&self, id: u64, value: Option<&Value>, emit: Emit) {
        self.bind_epoch(id, self.epoch(), value, emit);
    }
    fn bind_epoch(&self, id: u64, epoch: u64, value: Option<&Value>, emit: Emit) {
        let Ok(mut b) = self.book.lock() else {
            return;
        };
        if b.epoch != epoch {
            return;
        }
        let next = value.and_then(binding).filter(|v| {
            b.scope.as_ref() == Some(&v.expected) && (v.active || b.focused == Some(id))
        });
        if b.entries.get(&id).map(|e| &e.binding) == next.as_ref() {
            return;
        }
        if b.pressed.as_ref().is_some_and(|(key, _)| *key == id) {
            b.pressed = None;
        }
        let mut out = Vec::new();
        if b.focused == Some(id)
            && next.as_ref().is_none_or(|v| {
                b.entries.get(&id).is_none_or(|old| {
                    old.binding.owner != v.owner || old.binding.generation != v.generation
                })
            })
        {
            b.blur(&mut out);
        }
        match next {
            Some(binding) if b.entries.contains_key(&id) || b.entries.len() < MAX_HANDLES => {
                b.entries.insert(id, Entry { binding, emit });
            }
            _ => {
                b.entries.remove(&id);
            }
        }
        drop(b);
        for event in out {
            event.send(self);
        }
    }
    fn detach(&self, id: u64) {
        self.bind(id, None, Arc::new(|_, _| {}));
    }
    /// Pure native input seam, also used by the independent synthetic fixture.
    /// This is Rust-only, NOT a JS command or HostChannel method.
    pub fn observe(&self, input: NativeInput, windows_focus: bool) {
        let Ok(mut b) = self.book.lock() else {
            return;
        };
        let mut out = Vec::new();
        match input {
            NativeInput::Cancel => {
                b.pressed = None;
            }
            NativeInput::Blur => {
                b.pressed = None;
                b.blur(&mut out);
            }
            NativeInput::MiddleDown(p) => {
                if b.pressed.take().is_none() {
                    b.pressed = b
                        .hit(p)
                        .and_then(|id| b.entries.get(&id).map(|e| (id, e.binding.clone())));
                }
            }
            NativeInput::MiddleUp(p) => {
                if let Some((id, captured)) = b.pressed.take()
                    && b.hit(p) == Some(id)
                    && b.entries.get(&id).is_some_and(|e| e.binding == captured)
                    && let Some(event) = b.delivery(id, "middleClose")
                {
                    out.push(event);
                }
            }
            NativeInput::LeftDown(p) => {
                b.pressed = None;
                if windows_focus {
                    let hit = b.hit(p);
                    if hit != b.focused {
                        b.blur(&mut out);
                        b.focused = hit;
                    }
                    if let Some(id) = hit
                        && let Some(event) = b.delivery(id, "tabFocus")
                    {
                        out.push(event);
                    }
                }
            }
        }
        // emit may synchronously re-enter component/lifecycle code. No lock or
        // platform RefCell borrow is held across it.
        drop(b);
        for event in out {
            event.send(self);
        }
    }
    pub(crate) fn gate(&self, active: bool, blocked: bool) {
        let Ok(mut b) = self.book.lock() else {
            return;
        };
        b.enabled = active && !blocked;
        let mut out = Vec::new();
        if !b.enabled {
            b.pressed = None;
            b.blur(&mut out);
        }
        drop(b);
        for event in out {
            event.send(self);
        }
    }
    fn attach_window(&self, window: usize) -> Result<()> {
        let mut b = self.book.lock().map_err(|_| "desktop_tab_unavailable")?;
        if window == 0 || b.window.is_some() {
            return Err("desktop_tab_window_already_installed".into());
        }
        b.window = Some(window);
        b.enabled = false;
        Ok(())
    }
    fn retire_window(&self) {
        self.gate(false, true);
        if let Ok(mut b) = self.book.lock() {
            b.epoch += 1;
            b.window = None;
            b.entries.clear();
            b.pressed = None;
            b.focused = None;
        }
    }
}

#[cfg(target_os = "macos")]
#[path = "desktop_tab_macos.rs"]
mod native;
#[cfg(target_os = "windows")]
#[path = "desktop_tab_windows.rs"]
mod native;
#[cfg(target_os = "windows")]
pub use native::observe_window_message;
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub use native::{Observer, install_observer, register};

#[cfg(test)]
#[path = "desktop_tab_tests.rs"]
mod tests;
