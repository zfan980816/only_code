use light_reader_lib::models::*;

#[test]
fn test_search_options_default() {
    let opts = SearchOptions::default();
    assert!(!opts.case_sensitive);
    assert!(!opts.regex);
    assert!(!opts.whole_word);
    assert_eq!(opts.max_results, Some(500));
}

#[test]
fn test_symbol_serialization() {
    let symbol = Symbol {
        path: "src/main.ts".to_string(),
        name: "getUser".to_string(),
        kind: "function".to_string(),
        start: 100,
        end: 140,
        start_line: 5,
        start_column: 0,
        end_line: 7,
        end_column: 1,
    };
    let json = serde_json::to_string(&symbol).unwrap();
    assert!(json.contains("\"path\":\"src/main.ts\""));
    assert!(json.contains("\"startLine\":5"));
    let parsed: Symbol = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.name, "getUser");
}

#[test]
fn test_highlight_span_order() {
    let spans = vec![
        HighlightSpan { start: 10, end: 20, kind: "keyword".to_string() },
        HighlightSpan { start: 30, end: 40, kind: "string".to_string() },
        HighlightSpan { start: 0, end: 5, kind: "comment".to_string() },
    ];
    let mut sorted = spans.clone();
    sorted.sort_by(|a, b| a.start.cmp(&b.start));
    assert_eq!(sorted[0].start, 0);
    assert_eq!(sorted[1].start, 10);
    assert_eq!(sorted[2].start, 30);
}

#[test]
fn test_navigation_target_fields() {
    let target = NavigationTarget {
        path: "src/utils.py".to_string(),
        name: "calculate".to_string(),
        kind: "function".to_string(),
        start: 50,
        end: 90,
        start_line: 4,
        start_column: 1,
    };
    assert_eq!(target.start_line, 4);
    assert_eq!(target.kind, "function");
}
