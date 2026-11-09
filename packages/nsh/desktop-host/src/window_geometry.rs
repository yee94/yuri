//! Native outer-window geometry only. Coordinates never cross OS coordinate spaces.
use crate::policy::Result;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
impl Rect {
    pub fn validate(self) -> Result<Self> {
        if ![self.x, self.y, self.width, self.height]
            .iter()
            .all(|v| v.is_finite())
            || self.x.abs() > 1_000_000.0
            || self.y.abs() > 1_000_000.0
            || !(1.0..=65_536.0).contains(&self.width)
            || !(1.0..=65_536.0).contains(&self.height)
        {
            return Err("window_geometry_invalid".into());
        }
        Ok(self)
    }
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Space {
    AppKitPoints,
    Win32Physical,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Geometry {
    pub space: Space,
    pub normal: Rect,
    pub maximized: bool,
    pub fullscreen: bool,
}

/// Largest actual intersection; a removed/off-screen display falls back to primary.
/// A work area smaller than the nominal minimum wins: no inaccessible window edges.
pub fn clamp(
    bounds: Rect,
    workareas: &[Rect],
    primary: usize,
    minimum: (f64, f64),
) -> Result<Rect> {
    bounds.validate()?;
    if workareas.is_empty()
        || workareas.len() > 64
        || primary >= workareas.len()
        || !minimum.0.is_finite()
        || !minimum.1.is_finite()
        || minimum.0 <= 0.0
        || minimum.1 <= 0.0
    {
        return Err("window_monitor_unavailable".into());
    }
    let mut selected = primary;
    let mut intersection = 0.0;
    for (index, area) in workareas.iter().enumerate() {
        area.validate()?;
        let width =
            ((bounds.x + bounds.width).min(area.x + area.width) - bounds.x.max(area.x)).max(0.0);
        let height =
            ((bounds.y + bounds.height).min(area.y + area.height) - bounds.y.max(area.y)).max(0.0);
        if width * height > intersection {
            intersection = width * height;
            selected = index;
        }
    }
    let area = workareas[selected];
    let width = bounds.width.max(minimum.0).min(area.width);
    let height = bounds.height.max(minimum.1).min(area.height);
    Ok(Rect {
        x: bounds.x.clamp(area.x, area.x + area.width - width),
        y: bounds.y.clamp(area.y, area.y + area.height - height),
        width,
        height,
    })
}

#[cfg(target_os = "macos")]
#[path = "window_geometry_macos.rs"]
pub mod macos;
#[cfg(target_os = "windows")]
#[path = "window_geometry_windows.rs"]
pub mod windows;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn removed_display_negative_origin_small_monitor_and_invalid_data() {
        let primary = Rect {
            x: 0.,
            y: 24.,
            width: 800.,
            height: 500.,
        };
        let secondary = Rect {
            x: -1800.,
            y: 0.,
            width: 1800.,
            height: 1000.,
        };
        let normal = Rect {
            x: -1700.,
            y: 100.,
            width: 1200.,
            height: 700.,
        };
        assert_eq!(
            clamp(normal, &[primary, secondary], 0, (900., 560.)).unwrap(),
            normal
        );
        assert_eq!(clamp(normal, &[primary], 0, (900., 560.)).unwrap(), primary);
        assert!(clamp(normal, &[], 0, (900., 560.)).is_err());
        assert!(
            Rect {
                width: f64::NAN,
                ..normal
            }
            .validate()
            .is_err()
        );
    }
}
