/// CSS Fonts Level 4 relative matching for a named family.
/// CoreText's descriptor match uses its own weight trait and selects
/// Atkinson Bold for requested 500, while its only real faces are 400/700.
/// Every face contributes its OS/2 usWeightClass; the requested CSS weight
/// then follows the standard below/above algorithm. No face is synthesized.
fn css_family_font(family: &str, size: CGFloat, weight: u16) -> Option<CFRetained<CTFont>> {
    let name = CFString::from_str(family);
    // SAFETY: immutable CoreText constants and documented attribute types.
    let query = unsafe {
        let attributes = CFDictionary::<CFString, CFType>::from_slices(
            &[kCTFontFamilyNameAttribute],
            &[name.as_ref()],
        );
        CTFontDescriptor::with_attributes(attributes.as_opaque())
    };
    // SAFETY: matching descriptors are CTFontDescriptors.
    let Some(matches) = (unsafe { query.matching_font_descriptors(None) }) else {
        return None;
    };
    let mut candidates = Vec::new();
    for index in 0..matches.count() {
        // SAFETY: the array owns a valid descriptor at this index.
        let descriptor = unsafe { &*matches.value_at_index(index).cast::<CTFontDescriptor>() };
        let font = unsafe { CTFont::with_font_descriptor(descriptor, size, std::ptr::null()) };
        let resolved = unsafe { font.family_name() }.to_string();
        let Some(face_weight) = os2_weight_class(&font) else {
            continue;
        };
        if resolved.eq_ignore_ascii_case(family) {
            candidates.push((face_weight, font));
        }
    }
    css_weight_match(&candidates, weight).cloned()
}

/// Reads usWeightClass from the actual font's OS/2 table. A face without
/// that field is not eligible for CSS matching.
fn os2_weight_class(font: &CTFont) -> Option<u16> {
    // SAFETY: the font owns the returned table for this call.
    let data = unsafe { font.table(kCTFontTableOS2, CTFontTableOptions::NoOptions) }?;
    if data.length() < 6 {
        return None;
    }
    let mut bytes = [0_u8; 6];
    // SAFETY: the range lies inside the retained table.
    unsafe { data.bytes(CFRange { location: 0, length: 6 }, bytes.as_mut_ptr()) };
    Some(u16::from_be_bytes([bytes[4], bytes[5]]))
}

/// <https://drafts.csswg.org/css-fonts-4/#font-style-matching>.
fn css_weight_match<'a>(
    candidates: &'a [(u16, CFRetained<CTFont>)],
    requested: u16,
) -> Option<&'a CFRetained<CTFont>> {
    if let Some((_, font)) = candidates.iter().find(|(weight, _)| *weight == requested) {
        return Some(font);
    }
    let below = candidates
        .iter()
        .filter(|(weight, _)| *weight < requested)
        .max_by_key(|(weight, _)| *weight);
    let above = candidates
        .iter()
        .filter(|(weight, _)| *weight > requested)
        .min_by_key(|(weight, _)| *weight);
    let chosen = if requested < 400 {
        below.or(above)
    } else if requested > 500 {
        above.or(below)
    } else if let Some(face) = below.filter(|(weight, _)| *weight >= 400).or(above) {
        Some(face)
    } else {
        below
    };
    chosen.map(|(_, font)| font)
}
