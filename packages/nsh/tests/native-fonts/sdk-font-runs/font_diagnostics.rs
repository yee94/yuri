//! Opt-in test carrier only. Reads the exact CTLines after TextView drew them;
//! never reshapes text, changes layout, reads content, or inspects runtime classes.
use std::{cell::RefCell, collections::{BTreeMap, BTreeSet}};
use objc2::{Message, rc::Weak};
use objc2_core_foundation::{CFDictionary, CFString, CFType};
use objc2_core_text::{CTFont, CTRun, kCTFontAttributeName, kCTFontVersionNameKey};
use objc2_ui_kit::{UIView, UIAccessibilityIdentification};
use serde_json::{Value, json};
use crate::text::CoreTextLayout;

struct Scope {
    root: Weak<UIView>,
    generation: u64,
    ids: BTreeSet<String>,
    display: u64,
    records: BTreeMap<String, Value>,
}
thread_local! { static SCOPES: RefCell<Vec<Scope>> = const { RefCell::new(Vec::new()) }; }

pub(crate) fn begin(root: &UIView, ids: &str, generation: u64) -> Result<(), String> {
    let ids: Vec<String> = serde_json::from_str(ids).map_err(|_| "invalid diagnostic IDs")?;
    if generation == 0 || ids.is_empty() || ids.len() > 24 || ids.iter().any(|id| {
        !id.starts_with("font-run-") || id.len() > 96 || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
    }) { return Err("invalid diagnostic scope".into()); }
    let ids: BTreeSet<String> = ids.into_iter().collect();
    SCOPES.with(|scopes| -> Result<(), String> {
        let mut scopes = scopes.borrow_mut();
        scopes.retain(|scope| scope.root.load().is_some());
        if let Some(scope) = scopes.iter_mut().find(|scope| scope.root.load().is_some_and(|r| std::ptr::eq(&*r, root))) {
            if generation <= scope.generation { return Err("diagnostic generation must increase".into()); }
            scope.generation = generation; scope.ids = ids.clone(); scope.records.clear();
        } else {
            if scopes.len() >= 4 { return Err("diagnostic scope limit".into()); }
            scopes.push(Scope { root: Weak::from_retained(&root.retain()), generation, ids: ids.clone(), display: 0, records: BTreeMap::new() });
        }
        Ok(())
    })?;
    // Request a normal UIKit redraw of only explicitly named public test IDs.
    // No forced layout, private view discovery, draw call or replacement renderer.
    fn redraw(view: &UIView, ids: &BTreeSet<String>) {
        if view.accessibilityIdentifier().is_some_and(|id| ids.contains(&id.to_string())) { view.setNeedsDisplay(); }
        for child in view.subviews().iter() { redraw(&child, ids); }
    }
    redraw(root, &ids);
    Ok(())
}

pub(crate) fn stop(root: &UIView) {
    SCOPES.with(|scopes| scopes.borrow_mut().retain(|scope| scope.root.load().is_some_and(|r| !std::ptr::eq(&*r, root))));
}

pub(crate) fn snapshot(root: &UIView, generation: u64) -> Result<String, String> {
    SCOPES.with(|scopes| {
        let scopes = scopes.borrow();
        let scope = scopes.iter().find(|scope| scope.root.load().is_some_and(|r| std::ptr::eq(&*r, root)))
            .filter(|scope| scope.generation == generation).ok_or("diagnostic scope retired")?;
        let missing: Vec<&String> = scope.ids.iter().filter(|id| !scope.records.contains_key(*id)).collect();
        Ok(json!({"contract":"nsh-ctrun-after-draw-v1", "captureGeneration":generation,
            "records":scope.records, "missing":missing, "source":"TextView.drawRect/CTLine.draw"}).to_string())
    })
}

pub(crate) fn after_draw(view: &UIView, text: &CoreTextLayout, layout_generation: u64) {
    SCOPES.with(|scopes| {
        let mut scopes = scopes.borrow_mut();
        if scopes.is_empty() { return; }
        let Some(id) = view.accessibilityIdentifier().map(|id| id.to_string()) else { return };
        for scope in scopes.iter_mut().filter(|scope| scope.ids.contains(&id)) {
            let Some(root) = scope.root.load() else { continue };
            if !view.isDescendantOfView(&root) || view.window().is_none() { continue; }
            let mut records = Vec::new();
            // SAFETY: the exact immutable CTLines just passed to CoreText draw.
            // kCTFontAttributeName is a CTFont, as in text_view's decoration path.
            unsafe {
                for (line_index, line) in text.lines.iter().enumerate() {
                    let runs = line.line.glyph_runs();
                    for index in 0..runs.count() {
                        if records.len() >= 128 { break; }
                        let run = &*runs.value_at_index(index).cast::<CTRun>();
                        if run.glyph_count() == 0 { continue; }
                        let attributes = run.attributes();
                        let attributes: &CFDictionary<CFString, CFType> = attributes.cast_unchecked();
                        let Some(font) = attributes.get(kCTFontAttributeName).and_then(|font| font.downcast::<CTFont>().ok()) else { continue };
                        records.push(json!({"line":line_index, "run":index, "glyphCount":run.glyph_count(),
                            "postScriptName":font.post_script_name().to_string(), "familyName":font.family_name().to_string(),
                            "fontVersion":font.name(kCTFontVersionNameKey).map(|version| version.to_string()), "pointSize":font.size()}));
                    }
                }
            }
            scope.display += 1;
            scope.records.insert(id.clone(), json!({"captureGeneration":scope.generation,
                "displayGeneration":scope.display, "layoutGeneration":layout_generation, "runs":records}));
        }
    });
}
