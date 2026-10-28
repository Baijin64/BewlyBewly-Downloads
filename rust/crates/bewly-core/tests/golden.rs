// Differential test: every case was produced by the Node implementation
// (`rust/tools/make-golden.mjs`). Any byte difference is a porting regression.

use std::path::PathBuf;

use bewly_core::formats::{
    select_streams, srt_text, to_ass, to_nfo, to_srt, validate_options, DownloadOptions,
};
use bewly_core::naming::{plan_location, Streams, TaskView};
use serde::Deserialize;
use serde_json::Value;

/// The corpus was recorded in a fixed timezone; pin it so date tokens do not
/// depend on where the test runs.
fn pin_offset() {
    let minutes = fixture()["offsetMinutes"].as_i64().unwrap_or(-240) as i32;
    bewly_core::naming::set_local_offset_override(Some(minutes));
}

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/golden.json");
    let text = std::fs::read_to_string(path).expect("golden fixture");
    serde_json::from_str(&text).expect("valid json")
}

#[derive(Deserialize)]
struct NamingCase {
    task: TaskView,
    parts: Vec<String>,
    basename: String,
}

#[derive(Deserialize)]
struct OptionCase {
    input: Value,
    #[serde(default)]
    expected: Option<DownloadOptions>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Deserialize)]
struct SrtCase {
    cues: Value,
    #[serde(default)]
    expected: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SrtTextCase {
    text: String,
    breaks: bool,
    expected: String,
}

#[derive(Deserialize)]
struct AssCase {
    xml: String,
    expected: String,
}

#[derive(Deserialize)]
struct NfoCase {
    task: TaskView,
    expected: String,
}

fn describe_difference(expected: &str, actual: &str) -> String {
    let position = expected
        .chars()
        .zip(actual.chars())
        .position(|(left, right)| left != right)
        .unwrap_or_else(|| expected.chars().count().min(actual.chars().count()));
    format!(
        "first difference at char {position}\n  expected: {:?}\n  actual:   {:?}",
        expected
            .chars()
            .skip(position.saturating_sub(20))
            .take(60)
            .collect::<String>(),
        actual
            .chars()
            .skip(position.saturating_sub(20))
            .take(60)
            .collect::<String>()
    )
}

#[test]
fn naming_matches_the_node_implementation() {
    pin_offset();
    let golden = fixture();
    let cases: Vec<NamingCase> = serde_json::from_value(golden["cases"]["naming"].clone()).unwrap();
    assert_eq!(cases.len(), 120);
    for (index, case) in cases.iter().enumerate() {
        let plan = plan_location(&case.task, &Streams::default());
        assert_eq!(
            plan.parts, case.parts,
            "case {index}: folder parts differ for {:?}",
            case.task.options.folder_template
        );
        assert_eq!(
            plan.basename, case.basename,
            "case {index}: basename differs for {:?}",
            case.task.title
        );
    }
}

#[test]
fn option_validation_matches_the_node_implementation() {
    let golden = fixture();
    let cases: Vec<OptionCase> =
        serde_json::from_value(golden["cases"]["options"].clone()).unwrap();
    for (index, case) in cases.iter().enumerate() {
        let actual = validate_options(&case.input);
        match (&case.expected, &case.error) {
            (Some(expected), _) => {
                let parsed = actual.unwrap_or_else(|error| {
                    panic!(
                        "case {index} unexpectedly failed: {error} ({:?})",
                        case.input
                    )
                });
                assert_eq!(&parsed, expected, "case {index}: options differ");
            }
            (None, Some(error)) => {
                let failure = actual.expect_err(&format!("case {index} unexpectedly passed"));
                assert_eq!(
                    &failure, error,
                    "case {index}: error text differs for {:?}",
                    case.input
                );
            }
            (None, None) => panic!("case {index} has neither result nor error"),
        }
    }
}

#[test]
fn srt_conversion_matches_the_node_implementation() {
    let golden = fixture();
    let cases: Vec<SrtCase> = serde_json::from_value(golden["cases"]["srt"].clone()).unwrap();
    for (index, case) in cases.iter().enumerate() {
        let actual = to_srt(&case.cues);
        match (&case.expected, &case.error) {
            (Some(expected), _) => {
                let text = actual.unwrap_or_else(|error| panic!("case {index}: {error}"));
                assert_eq!(
                    text,
                    *expected,
                    "case {index}: {}",
                    describe_difference(expected, &text)
                );
            }
            (None, Some(error)) => {
                assert_eq!(
                    &actual.unwrap_err(),
                    error,
                    "case {index}: error text differs"
                );
            }
            (None, None) => panic!("case {index} has neither result nor error"),
        }
    }
}

#[test]
fn srt_text_matches_the_node_implementation() {
    let golden = fixture();
    let cases: Vec<SrtTextCase> =
        serde_json::from_value(golden["cases"]["srtText"].clone()).unwrap();
    for (index, case) in cases.iter().enumerate() {
        let actual = srt_text(&case.text, case.breaks).expect("valid srt");
        assert_eq!(
            actual,
            case.expected,
            "case {index}: {}",
            describe_difference(&case.expected, &actual)
        );
    }
}

#[test]
fn ass_conversion_matches_the_node_implementation() {
    let golden = fixture();
    let cases: Vec<AssCase> = serde_json::from_value(golden["cases"]["ass"].clone()).unwrap();
    for (index, case) in cases.iter().enumerate() {
        let actual = to_ass(&case.xml);
        assert_eq!(
            actual,
            case.expected,
            "case {index}: {}",
            describe_difference(&case.expected, &actual)
        );
    }
}

#[test]
fn nfo_matches_the_node_implementation() {
    pin_offset();
    let golden = fixture();
    let cases: Vec<NfoCase> = serde_json::from_value(golden["cases"]["nfo"].clone()).unwrap();
    for (index, case) in cases.iter().enumerate() {
        let actual = to_nfo(&case.task);
        assert_eq!(
            actual,
            case.expected,
            "case {index}: {}",
            describe_difference(&case.expected, &actual)
        );
    }
}

#[derive(Deserialize)]
struct SelectCase {
    data: Value,
    options: Value,
    #[serde(default)]
    expected: Option<Streams>,
    #[serde(default)]
    error: Option<String>,
}

#[test]
fn stream_selection_matches_the_node_implementation() {
    let golden = fixture();
    let cases: Vec<SelectCase> = serde_json::from_value(golden["cases"]["select"].clone()).unwrap();
    assert_eq!(cases.len(), 120);
    for (index, case) in cases.iter().enumerate() {
        let options = validate_options(&case.options)
            .unwrap_or_else(|error| panic!("case {index}: options rejected: {error}"));
        let actual = select_streams(&case.data, &options);
        match (&case.expected, &case.error) {
            (Some(expected), _) => {
                let streams = actual.unwrap_or_else(|error| panic!("case {index}: {error}"));
                assert_eq!(&streams, expected, "case {index}: selected streams differ");
            }
            (None, Some(error)) => {
                assert_eq!(
                    &actual.unwrap_err(),
                    error,
                    "case {index}: error text differs"
                );
            }
            (None, None) => panic!("case {index} has neither result nor error"),
        }
    }
}
