//! Get Current Date and Time Tool
//!
//! Returns the current date and time in ISO 8601 format.

use chrono::{DateTime, Datelike, Local, Timelike, Utc};
use serde::{Deserialize, Serialize};

/// Result of the get_current_datetime tool execution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetCurrentDateTimeResult {
    /// Whether the operation was successful
    pub success: bool,
    /// Current UTC time in ISO 8601 format
    pub utc: String,
    /// Current local time in ISO 8601 format
    pub local: String,
    /// ISO 8601 date (YYYY-MM-DD)
    pub date: String,
    /// ISO 8601 time (HH:MM:SS)
    pub time: String,
    /// Unix timestamp (seconds since epoch)
    pub timestamp: i64,
    /// Timezone offset (e.g., "+08:00")
    pub timezone_offset: String,
    /// Human-readable timezone name
    pub timezone_name: String,
    /// Day of week (Monday, Tuesday, etc.)
    pub day_of_week: String,
    /// Week number in the year
    pub week_number: u32,
    /// Year
    pub year: i32,
    /// Month (1-12)
    pub month: u32,
    /// Day (1-31)
    pub day: u32,
    /// Hour (0-23)
    pub hour: u32,
    /// Minute (0-59)
    pub minute: u32,
    /// Second (0-59)
    pub second: u32,
    /// Error message if operation failed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Execute the get_current_datetime tool
///
/// Returns current date and time information in multiple formats.
pub async fn execute() -> GetCurrentDateTimeResult {
    // Get current UTC time
    let utc_now: DateTime<Utc> = Utc::now();

    // Get current local time
    let local_now: DateTime<Local> = Local::now();

    // Extract timezone information
    let timezone_offset = local_now.format("%:z").to_string();
    let timezone_name = local_now.format("%Z").to_string();

    // Build result
    GetCurrentDateTimeResult {
        success: true,
        utc: utc_now.to_rfc3339(),
        local: local_now.to_rfc3339(),
        date: utc_now.format("%Y-%m-%d").to_string(),
        time: utc_now.format("%H:%M:%S").to_string(),
        timestamp: utc_now.timestamp(),
        timezone_offset,
        timezone_name,
        day_of_week: utc_now.format("%A").to_string(),
        week_number: utc_now.iso_week().week(),
        year: utc_now.year(),
        month: utc_now.month(),
        day: utc_now.day(),
        hour: utc_now.hour(),
        minute: utc_now.minute(),
        second: utc_now.second(),
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_get_current_datetime() {
        let result = execute().await;

        assert!(result.success);
        assert!(!result.utc.is_empty());
        assert!(!result.local.is_empty());
        assert!(!result.date.is_empty());
        assert!(!result.time.is_empty());
        assert!(result.timestamp > 0);
        assert!(result.year >= 2024);
        assert!(result.month >= 1 && result.month <= 12);
        assert!(result.day >= 1 && result.day <= 31);
        assert!(result.hour >= 0 && result.hour <= 23);
        assert!(result.minute >= 0 && result.minute <= 59);
        assert!(result.second >= 0 && result.second <= 59);
        assert!(result.error.is_none());
    }

    #[tokio::test]
    async fn test_iso_format() {
        let result = execute().await;

        // Verify ISO 8601 format
        assert!(result.utc.contains('T'));
        assert!(result.utc.contains('+') || result.utc.contains('-') || result.utc.contains('Z'));
        assert!(result.local.contains('T'));

        // Verify date format YYYY-MM-DD
        assert_eq!(result.date.len(), 10);
        assert!(result.date.chars().nth(4) == Some('-'));
        assert!(result.date.chars().nth(7) == Some('-'));

        // Verify time format HH:MM:SS
        assert_eq!(result.time.len(), 8);
        assert!(result.time.chars().nth(2) == Some(':'));
        assert!(result.time.chars().nth(5) == Some(':'));
    }
}
