//! The few strings Rust shows itself (the menu bar menu, native dialogs),
//! from the same locale files the windows use. Messages are ICU: `{name}`
//! arguments and `{count, plural, one {...} other {...}}`. On Windows the
//! `<lang>.windows.json` wording is read before the base file, as in the window.

use serde_json::Value;
use std::collections::HashMap;

const EN: &str = include_str!("../../locales/en.json");
const DA: &str = include_str!("../../locales/da.json");
const EN_WINDOWS: &str = include_str!("../../locales/en.windows.json");
const DA_WINDOWS: &str = include_str!("../../locales/da.windows.json");

/// The platform the strings are for, as the window gets it in the snapshot.
pub const PLATFORM: &str = if cfg!(target_os = "windows") { "windows" } else { "macos" };

pub struct Strings {
    lang: &'static str,
    map: HashMap<String, String>,
    fallback: HashMap<String, String>,
}

fn parse(src: &str) -> HashMap<String, String> {
    serde_json::from_str(src).expect("locale file")
}

impl Strings {
    pub fn new(lang: &str) -> Strings {
        Strings::for_platform(lang, PLATFORM)
    }

    pub fn for_platform(lang: &str, platform: &str) -> Strings {
        let lang = if lang == "da" { "da" } else { "en" };
        let mut map = parse(if lang == "da" { DA } else { EN });
        let mut fallback = parse(EN);
        if platform == "windows" {
            map.extend(parse(if lang == "da" { DA_WINDOWS } else { EN_WINDOWS }));
            fallback.extend(parse(EN_WINDOWS));
        }
        Strings { lang, map, fallback }
    }

    pub fn lang(&self) -> &'static str {
        self.lang
    }

    pub fn get(&self, key: &str, args: &[(&str, Value)]) -> String {
        let msg = self.map.get(key).or_else(|| self.fallback.get(key)).cloned().unwrap_or_else(|| key.to_string());
        format(&msg, args, self.lang)
    }
}

/// The interface language: the operating system's when a translation exists,
/// otherwise the install's default, otherwise English (docs/spec.md).
pub fn choose(system: Option<&str>, install: Option<&str>) -> &'static str {
    let supported = |l: &str| -> Option<&'static str> {
        match l.split(['-', '_']).next()?.to_ascii_lowercase().as_str() {
            "da" => Some("da"),
            "en" => Some("en"),
            _ => None,
        }
    };
    system.and_then(supported).or_else(|| install.and_then(supported)).unwrap_or("en")
}

pub fn format(msg: &str, args: &[(&str, Value)], lang: &str) -> String {
    let arg = |name: &str| args.iter().find(|(k, _)| *k == name).map(|(_, v)| v);
    let mut out = String::new();
    let chars: Vec<char> = msg.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '{' {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        // Find the matching close brace.
        let mut depth = 0;
        let mut j = i;
        while j < chars.len() {
            match chars[j] {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                _ => {}
            }
            j += 1;
        }
        let inner: String = chars[i + 1..j.min(chars.len())].iter().collect();
        i = j + 1;
        let parts: Vec<&str> = inner.splitn(3, ',').map(str::trim).collect();
        match parts.as_slice() {
            [name] => match arg(name) {
                Some(Value::String(s)) => out.push_str(s),
                Some(v) => out.push_str(&v.to_string()),
                None => {
                    out.push('{');
                    out.push_str(name);
                    out.push('}');
                }
            },
            [name, "plural", forms] => {
                let n = arg(name).and_then(Value::as_f64).unwrap_or(0.0);
                let category = if n == 1.0 { "one" } else { "other" };
                let _ = lang; // English and Danish share one/other.
                let pick = plural_form(forms, &format!("={n}")).or_else(|| plural_form(forms, category)).or_else(|| plural_form(forms, "other"));
                if let Some(form) = pick {
                    let n_str = if n.fract() == 0.0 { format!("{}", n as i64) } else { n.to_string() };
                    out.push_str(&format(&form.replace('#', &n_str), args, lang));
                }
            }
            _ => out.push_str(&inner),
        }
    }
    out
}

/// The text of `selector {text}` inside a plural's forms.
fn plural_form(forms: &str, selector: &str) -> Option<String> {
    let chars: Vec<char> = forms.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        let start = i;
        while i < chars.len() && chars[i] != '{' && !chars[i].is_whitespace() {
            i += 1;
        }
        let sel: String = chars[start..i].iter().collect();
        while i < chars.len() && chars[i] != '{' {
            i += 1;
        }
        let mut depth = 0;
        let body_start = i + 1;
        while i < chars.len() {
            match chars[i] {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                _ => {}
            }
            i += 1;
        }
        let body: String = chars[body_start.min(chars.len())..i.min(chars.len())].iter().collect();
        i += 1;
        if sel == selector {
            return Some(body);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn arguments_and_plurals() {
        assert_eq!(format("Uploading {done}/{total}", &[("done", json!(2)), ("total", json!(5))], "en"), "Uploading 2/5");
        let m = "{count, plural, one {# file} other {# files}}";
        assert_eq!(format(m, &[("count", json!(1))], "en"), "1 file");
        assert_eq!(format(m, &[("count", json!(4))], "en"), "4 files");
        assert_eq!(format("Open {product}", &[("product", json!("Primux Møder"))], "da"), "Open Primux Møder");
        assert_eq!(format("{missing} stays", &[], "en"), "{missing} stays");
    }

    #[test]
    fn both_files_have_the_same_keys_and_every_message_formats() {
        let en = parse(EN);
        let da = parse(DA);
        let mut a: Vec<_> = en.keys().collect();
        let mut b: Vec<_> = da.keys().collect();
        a.sort();
        b.sort();
        assert_eq!(a, b);
        for (k, v) in en.iter().chain(da.iter()) {
            let out = format(v, &[("count", json!(3))], "en");
            assert!(!out.contains("plural"), "{k}: {out}");
        }
    }

    #[test]
    fn language_choice_follows_the_spec() {
        assert_eq!(choose(Some("da-DK"), Some("en")), "da");
        assert_eq!(choose(Some("en-GB"), Some("da")), "en");
        assert_eq!(choose(Some("de-DE"), Some("da")), "da");
        assert_eq!(choose(Some("nb-NO"), None), "en");
        assert_eq!(choose(None, None), "en");
        assert_eq!(Strings::new("da").get("menu.stop", &[]), "Stop optagelse");
    }

    #[test]
    fn windows_wording_replaces_the_mac() {
        let mac = Strings::for_platform("da", "macos");
        let win = Strings::for_platform("da", "windows");
        assert_eq!(mac.get("recorder.disconnect.local", &[]), "Afbryd kun på denne Mac");
        assert_eq!(win.get("recorder.disconnect.local", &[]), "Afbryd kun på denne pc");
        // Keys without Windows wording come from the base file.
        assert_eq!(win.get("menu.stop", &[]), "Stop optagelse");
        assert_eq!(Strings::for_platform("en", "windows").get("recorder.permission.openSettings", &[]), "Open Settings");
    }
}
