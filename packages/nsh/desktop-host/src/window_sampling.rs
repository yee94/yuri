//! Shared sampler admission. A failed real getter cannot be healed by returning cached geometry.
use crate::{policy::Result, window_geometry::Geometry};

pub fn sample(
    geometry: &mut Geometry,
    failed: &mut bool,
    dirty: bool,
    force: bool,
    read: impl FnOnce(Geometry) -> Result<Geometry>,
) -> Result<()> {
    if dirty || force {
        match read(*geometry) {
            Ok(actual) => {
                *geometry = actual;
                *failed = false;
            }
            Err(error) => {
                *failed = true;
                return Err(error);
            }
        }
    }
    if *failed {
        return Err("window_geometry_read_failed".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failed_read_preserves_normal_bounds_and_cached_turns_never_clear_failure_or_call_os() {
        let prior = crate::window_persistence::tests::record("primary").geometry;
        let mut geometry = prior;
        let mut failed = false;
        assert!(
            sample(&mut geometry, &mut failed, true, false, |_| Err(
                "fixture_getter_failed".into()
            ))
            .is_err()
        );
        assert_eq!(geometry, prior);
        for _ in 0..10_000 {
            assert!(
                sample(&mut geometry, &mut failed, false, false, |_| panic!(
                    "cached turn cannot read OS"
                ))
                .is_err()
            );
        }
        sample(&mut geometry, &mut failed, false, true, |old| {
            Ok(Geometry {
                maximized: true,
                ..old
            })
        })
        .unwrap();
        assert!(!failed);
        assert_eq!(geometry.normal, prior.normal);
        assert!(geometry.maximized);
        sample(&mut geometry, &mut failed, false, false, |_| {
            panic!("unchanged frame cannot read OS")
        })
        .unwrap();
    }
}
