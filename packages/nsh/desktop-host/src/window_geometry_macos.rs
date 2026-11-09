//! Actual AppKit frame/style/screen APIs; no JS getter or fabricated normal bounds.
use super::*;
use nsh_platform_macos::{
    objc2::{MainThreadMarker, msg_send, runtime::AnyObject},
    objc2_app_kit::{NSScreen, NSWindow, NSWindowStyleMask},
    objc2_foundation::{NSPoint, NSRect, NSSize},
};

fn rect(value: NSRect) -> Rect {
    Rect {
        x: value.origin.x,
        y: value.origin.y,
        width: value.size.width,
        height: value.size.height,
    }
}
fn native(value: Rect) -> NSRect {
    NSRect::new(
        NSPoint::new(value.x, value.y),
        NSSize::new(value.width, value.height),
    )
}
fn main_thread() -> Result<MainThreadMarker> {
    MainThreadMarker::new().ok_or_else(|| "window_main_thread_required".into())
}

/// Capture once before any user zoom/fullscreen transition; subsequently capture on
/// didMove/didResize/didEndLiveResize/didEnter|ExitFullScreen. Transition callbacks must
/// keep the pre-transition normal/maximized pair until AppKit's completion notification.
pub fn capture(window: &NSWindow, prior: Option<Geometry>) -> Result<Geometry> {
    main_thread()?;
    let fullscreen = window.styleMask().contains(NSWindowStyleMask::FullScreen);
    let maximized = window.isZoomed();
    let special = fullscreen || maximized || window.isMiniaturized();
    let normal = if special {
        prior
            .filter(|p| p.space == Space::AppKitPoints)
            .ok_or("window_normal_bounds_unavailable")?
            .normal
            .validate()?
    } else {
        rect(window.frame()).validate()?
    };
    Ok(Geometry {
        space: Space::AppKitPoints,
        normal,
        maximized: if fullscreen || window.isMiniaturized() {
            prior.ok_or("window_normal_bounds_unavailable")?.maximized
        } else {
            maximized
        },
        fullscreen,
    })
}

/// Hidden, newly-created NSWindow only. Normal frame and zoom are installed BEFORE
/// orderFront. Native fullscreen is asynchronous: call enter_fullscreen_after_show
/// once after showing, and keep persistence frozen until didEnterFullScreen (or failure).
pub fn restore_before_show(window: &NSWindow, geometry: Geometry) -> Result<Geometry> {
    let mtm = main_thread()?;
    if window.isVisible()
        || window.isMiniaturized()
        || geometry.space != Space::AppKitPoints
        || window.styleMask().contains(NSWindowStyleMask::FullScreen)
        || window.isZoomed()
    {
        return Err("window_restore_requires_hidden_normal_window".into());
    }
    let screens = NSScreen::screens(mtm);
    if screens.is_empty() || screens.len() > 64 {
        return Err("window_monitor_unavailable".into());
    }
    // NSScreen.screens[0] is the menu-bar/primary screen, not mainScreen (key window).
    let areas: Vec<Rect> = screens
        .iter()
        .map(|screen| rect(screen.visibleFrame()))
        .collect();
    let normal = clamp(geometry.normal, &areas, 0, (900., 560.))?;
    window.setFrame_display(native(normal), false);
    let actual = rect(window.frame()).validate()?;
    if (actual.x - normal.x).abs() > 1.0
        || (actual.y - normal.y).abs() > 1.0
        || (actual.width - normal.width).abs() > 1.0
        || (actual.height - normal.height).abs() > 1.0
    {
        return Err("window_geometry_restore_rejected".into());
    }
    if geometry.maximized {
        window.zoom(None::<&AnyObject>);
        if !window.isZoomed() {
            return Err("window_maximize_restore_rejected".into());
        }
    }
    Ok(Geometry {
        normal: actual,
        ..geometry
    })
}

pub fn enter_fullscreen_after_show(window: &NSWindow, restored: Geometry) -> Result<()> {
    main_thread()?;
    if restored.space != Space::AppKitPoints || !window.isVisible() {
        return Err("window_fullscreen_requires_visible_window".into());
    }
    if restored.fullscreen && !window.styleMask().contains(NSWindowStyleMask::FullScreen) {
        // Real AppKit transition; completion is NOT implied by this return value.
        unsafe {
            let _: () = msg_send![window, toggleFullScreen: std::ptr::null::<AnyObject>()];
        }
    }
    Ok(())
}
