//! Win32 ABI adapter, including WINDOWPLACEMENT workspace-to-screen conversion.
//! The same source is frontend-checkable on Darwin; that is NOT Windows target/SDK evidence.
use crate::{
    policy::Result,
    window_geometry::{Geometry, Rect, Space, clamp},
};
use std::{ffi::c_void, marker::PhantomData, mem::size_of, ptr};
type Handle = *mut c_void;
#[repr(C)]
#[derive(Clone, Copy, Default, Debug, PartialEq)]
struct Point {
    x: i32,
    y: i32,
}
#[repr(C)]
#[derive(Clone, Copy, Default, Debug, PartialEq)]
struct NativeRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}
#[repr(C)]
#[derive(Default)]
struct Placement {
    length: u32,
    flags: u32,
    show: u32,
    minimum: Point,
    maximum: Point,
    normal: NativeRect,
}
#[repr(C)]
#[derive(Default)]
struct Monitor {
    size: u32,
    monitor: NativeRect,
    work: NativeRect,
    flags: u32,
}
const _: () = assert!(
    size_of::<Point>() == 8
        && size_of::<NativeRect>() == 16
        && size_of::<Placement>() == 44
        && size_of::<Monitor>() == 40
);
const FRAME: isize = 0x00cf0000; // WS_OVERLAPPEDWINDOW, exactly NSH 0.4's fullscreen mask.
#[cfg_attr(target_os = "windows", link(name = "user32"))]
unsafe extern "system" {
    fn IsWindow(hwnd: Handle) -> i32;
    fn IsWindowVisible(hwnd: Handle) -> i32;
    fn GetWindowThreadProcessId(hwnd: Handle, process: *mut u32) -> u32;
    fn GetWindowPlacement(hwnd: Handle, placement: *mut Placement) -> i32;
    fn GetWindowRect(hwnd: Handle, rect: *mut NativeRect) -> i32;
    fn GetWindowLongPtrW(hwnd: Handle, index: i32) -> isize;
    fn MonitorFromWindow(hwnd: Handle, flags: u32) -> Handle;
    fn GetMonitorInfoW(monitor: Handle, info: *mut Monitor) -> i32;
    fn EnumDisplayMonitors(
        dc: Handle,
        clip: *const NativeRect,
        callback: Option<unsafe extern "system" fn(Handle, Handle, *mut NativeRect, isize) -> i32>,
        data: isize,
    ) -> i32;
    fn SetWindowPos(
        hwnd: Handle,
        after: Handle,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        flags: u32,
    ) -> i32;
    fn ShowWindow(hwnd: Handle, command: i32) -> i32;
    fn GetDpiForWindow(hwnd: Handle) -> u32;
}
#[cfg_attr(target_os = "windows", link(name = "kernel32"))]
unsafe extern "system" {
    fn GetCurrentThreadId() -> u32;
    fn GetCurrentProcessId() -> u32;
    fn GetLastError() -> u32;
    fn SetLastError(error: u32);
}

/// Borrowed live top-level window on its owning UI thread, never a persisted ID.
pub struct Window<'a> {
    raw: Handle,
    _borrow: PhantomData<&'a c_void>,
    _ui: PhantomData<std::rc::Rc<()>>,
}
impl<'a> Window<'a> {
    /// SAFETY: the real NSH AppView/HWND owner outlives this borrow; no destruction or
    /// cross-thread access during a method. We additionally verify OS process/thread.
    #[cfg(target_os = "windows")]
    pub unsafe fn borrow(
        hwnd: &'a nsh_platform_windows::windows::Win32::Foundation::HWND,
    ) -> Result<Self> {
        let window = Self {
            raw: hwnd.0,
            _borrow: PhantomData,
            _ui: PhantomData,
        };
        window.check()?;
        Ok(window)
    }
    fn check(&self) -> Result<()> {
        let mut process = 0;
        unsafe {
            if self.raw.is_null()
                || IsWindow(self.raw) == 0
                || GetWindowThreadProcessId(self.raw, &mut process) != GetCurrentThreadId()
                || process != GetCurrentProcessId()
                || self.style(-16)? & 0x40000000 != 0
            {
                // WS_CHILD
                return Err("window_native_handle_invalid".into());
            }
        }
        Ok(())
    }
    fn style(&self, index: i32) -> Result<isize> {
        unsafe {
            SetLastError(0);
        }
        let value = unsafe { GetWindowLongPtrW(self.raw, index) };
        if value == 0 && unsafe { GetLastError() } != 0 {
            return Err("window_geometry_read_failed".into());
        }
        Ok(value)
    }
    pub fn capture(&self, prior: Option<Geometry>) -> Result<Geometry> {
        self.check()?;
        let mut placement = Placement {
            length: size_of::<Placement>() as u32,
            ..Default::default()
        };
        let mut current = NativeRect::default();
        let monitor = monitor_for(self.raw)?;
        unsafe {
            if GetWindowPlacement(self.raw, &mut placement) == 0
                || GetWindowRect(self.raw, &mut current) == 0
            {
                return Err("window_geometry_read_failed".into());
            }
        }
        let fullscreen = self.style(-16)? & FRAME == 0 && current == monitor.monitor;
        let maximized = placement.show == 3
            || (matches!(placement.show, 2 | 6 | 7) && placement.flags & 2 != 0);
        let normal = if fullscreen {
            prior
                .filter(|p| p.space == Space::Win32Physical)
                .ok_or("window_normal_bounds_unavailable")?
                .normal
                .validate()?
        } else {
            let mut r = rect(placement.normal);
            // TOOLWINDOW placements already use screen coordinates. Main windows normally
            // aren't tool windows, but checking the OS bit avoids double translation.
            if self.style(-20)? & 0x80 == 0 {
                r.x += monitor.work.left as f64 - monitor.monitor.left as f64;
                r.y += monitor.work.top as f64 - monitor.monitor.top as f64;
            }
            r.validate()?
        };
        Ok(Geometry {
            space: Space::Win32Physical,
            normal,
            maximized: if fullscreen {
                prior.ok_or("window_normal_bounds_unavailable")?.maximized
            } else {
                maximized
            },
            fullscreen,
        })
    }
    /// Installs real normal outer bounds before any show; never mutates NSH's private
    /// fullscreen bookkeeping. DPI awareness must be initialized by the existing UI runner.
    pub fn restore_before_show(&self, geometry: Geometry) -> Result<Geometry> {
        self.check()?;
        if geometry.space != Space::Win32Physical || unsafe { IsWindowVisible(self.raw) } != 0 {
            return Err("window_restore_requires_hidden_normal_window".into());
        }
        let current = self.capture(None)?;
        if current.maximized || current.fullscreen {
            return Err("window_restore_requires_hidden_normal_window".into());
        }
        let monitors = monitors()?;
        let areas: Vec<_> = monitors.iter().map(|m| rect(m.work)).collect();
        let primary = monitors
            .iter()
            .position(|m| m.flags & 1 != 0)
            .ok_or("window_monitor_unavailable")?;
        // Move the hidden normal window onto the selected target FIRST. The creation
        // monitor's DPI is not the destination monitor's DPI on mixed-scale desktops.
        let provisional = clamp(geometry.normal, &areas, primary, (900., 560.))?;
        self.set_bounds(provisional)?;
        let dpi = unsafe { GetDpiForWindow(self.raw) };
        if dpi == 0 {
            return Err("window_dpi_unavailable".into());
        }
        let normal = clamp(
            geometry.normal,
            &areas,
            primary,
            (900. * dpi as f64 / 96., 560. * dpi as f64 / 96.),
        )?;
        let normal = self.set_bounds(normal)?;
        Ok(Geometry { normal, ..geometry })
    }
    fn set_bounds(&self, normal: Rect) -> Result<Rect> {
        if unsafe {
            SetWindowPos(
                self.raw,
                ptr::null_mut(),
                normal.x.round() as i32,
                normal.y.round() as i32,
                normal.width.round() as i32,
                normal.height.round() as i32,
                0x4 | 0x10 | 0x200,
            )
        } == 0
        {
            return Err("window_geometry_restore_failed".into());
        }
        let mut actual = NativeRect::default();
        if unsafe { GetWindowRect(self.raw, &mut actual) } == 0 {
            return Err("window_geometry_read_failed".into());
        }
        let actual = rect(actual).validate()?;
        if (actual.x - normal.x).abs() > 1.
            || (actual.y - normal.y).abs() > 1.
            || (actual.width - normal.width).abs() > 1.
            || (actual.height - normal.height).abs() > 1.
        {
            return Err("window_geometry_restore_rejected".into());
        }
        Ok(actual)
    }
    /// Use INSTEAD OF AppView.show(): NSH's unconditional SW_SHOW does not restore
    /// requested maximize. For fullscreen, first issue the PUBLIC NSH Window command
    /// once while hidden and pump until the real OS state verifies; otherwise fail closed.
    pub fn show_restored(&self, restored: Geometry) -> Result<()> {
        self.check()?;
        if restored.space != Space::Win32Physical {
            return Err("window_geometry_invalid".into());
        }
        let command = if restored.fullscreen {
            if !self.capture(Some(restored))?.fullscreen {
                return Err("window_fullscreen_requires_nsh_command".into());
            }
            5 // SW_SHOW preserves the verified fullscreen presentation.
        } else if restored.maximized {
            3
        } else {
            1
        };
        // ShowWindow returns PREVIOUS visibility, not success. Verify real visibility.
        unsafe {
            ShowWindow(self.raw, command);
        }
        if unsafe { IsWindowVisible(self.raw) } == 0 {
            return Err("window_show_failed".into());
        }
        let actual = self.capture(Some(restored))?;
        if actual.fullscreen != restored.fullscreen
            || (!restored.fullscreen && actual.maximized != restored.maximized)
        {
            return Err("window_show_state_rejected".into());
        }
        Ok(())
    }
}
fn rect(r: NativeRect) -> Rect {
    Rect {
        x: r.left as f64,
        y: r.top as f64,
        width: r.right as f64 - r.left as f64,
        height: r.bottom as f64 - r.top as f64,
    }
}
fn monitor_for(hwnd: Handle) -> Result<Monitor> {
    let mut m = Monitor {
        size: size_of::<Monitor>() as u32,
        ..Default::default()
    };
    if unsafe { GetMonitorInfoW(MonitorFromWindow(hwnd, 2), &mut m) } == 0 {
        return Err("window_monitor_unavailable".into());
    }
    Ok(m)
}
fn monitors() -> Result<Vec<Monitor>> {
    struct Collected {
        monitors: Vec<Monitor>,
        failed: bool,
    }
    unsafe extern "system" fn collect(
        handle: Handle,
        _: Handle,
        _: *mut NativeRect,
        data: isize,
    ) -> i32 {
        let all = unsafe { &mut *(data as *mut Collected) };
        let mut m = Monitor {
            size: size_of::<Monitor>() as u32,
            ..Default::default()
        };
        if all.monitors.len() >= 64 || unsafe { GetMonitorInfoW(handle, &mut m) } == 0 {
            all.failed = true;
            return 0;
        }
        all.monitors.push(m);
        1
    }
    let mut all = Collected {
        monitors: vec![],
        failed: false,
    };
    let ok = unsafe {
        EnumDisplayMonitors(
            ptr::null_mut(),
            ptr::null(),
            Some(collect),
            &mut all as *mut _ as isize,
        )
    };
    if ok == 0 || all.failed || all.monitors.is_empty() {
        return Err("window_monitor_unavailable".into());
    }
    Ok(all.monitors)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_sdk_abi_layout() {
        assert_eq!(std::mem::offset_of!(Placement, normal), 28);
        assert_eq!(std::mem::offset_of!(Monitor, work), 20);
        assert_eq!(std::mem::offset_of!(Monitor, flags), 36);
    }
}
