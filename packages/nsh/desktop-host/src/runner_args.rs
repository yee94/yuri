//! Cold COM mode never consumes a bundle/Host/receipt path from activation arguments.
use std::{ffi::OsString, path::PathBuf};
pub struct Arguments {
    pub bundle: Option<PathBuf>,
}
pub fn parse(args: &[OsString], windows: bool) -> Result<Arguments, String> {
    let cold = args
        .first()
        .is_some_and(|arg| arg == "--notification-activation");
    if windows
        && cold
        && args[1..]
            .iter()
            .all(|arg| arg == "-Embedding" || arg == "/Embedding")
        && args.len() <= 2
    {
        return Ok(Arguments { bundle: None });
    }
    if args.is_empty() {
        return Ok(Arguments { bundle: None });
    }
    if !cold && args.len() == 2 && args[0] == "--bundle" {
        return Ok(Arguments {
            bundle: Some(PathBuf::from(&args[1])),
        });
    }
    Err("native_runner_arguments_invalid".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cold_mode_accepts_only_exact_installer_and_embedding_arguments_without_paths() {
        for args in [
            vec!["--notification-activation"],
            vec!["--notification-activation", "-Embedding"],
            vec!["--notification-activation", "/Embedding"],
        ] {
            assert!(
                parse(&args.iter().map(OsString::from).collect::<Vec<_>>(), true)
                    .unwrap()
                    .bundle
                    .is_none()
            );
        }
        for args in [
            vec!["-Embedding"],
            vec!["--notification-activation", "--bundle", "evil"],
            vec!["--notification-activation=evil"],
            vec!["--notification-activation", "evil"],
            vec!["--notification-activation", "-Embedding", "-Embedding"],
        ] {
            assert!(parse(&args.iter().map(OsString::from).collect::<Vec<_>>(), true).is_err());
        }
        assert!(parse(&["--notification-activation".into()], false).is_err());
    }
}
