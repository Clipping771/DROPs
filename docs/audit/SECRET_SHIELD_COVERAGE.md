# Phase 12 — Secret Shield Coverage & False-Positive Matrix (`SECRET_SHIELD_COVERAGE.md`)

Executed against `shell.redact(text)` at commit `63d7361`:

| Input | Expected | Actual | Verdict |
|---|---|---|---|
| `Basic authentication is required for this endpoint` | `count: 0` (unchanged) | `count: 1` -> `Basic [REDACTED basic-auth] is required...` | **CONFIRMED REGRESSION (False Positive)** |
| `The Basic implementation uses OAuth2` | `count: 0` (unchanged) | `count: 1` -> `The Basic [REDACTED basic-auth] uses OAuth2` | **CONFIRMED REGRESSION (False Positive)** |
| `https://api.example.com/data?api_key=superSecretQueryKey123&token=secretTok987` | Masked | `count: 0` (unmasked) | **CONFIRMED GAP** |
| `{"apiKey": "my_json_secret_value_12345"}` | Masked | `count: 0` (unmasked) | **CONFIRMED GAP** |
| `{"authorization":"Bearer opaque_secret_token_9876543210"}` | Masked | `count: 1` (masked) | **PASS** |
| `x-api-key: secret_header_value_9876543210` | Masked | `count: 1` (masked) | **PASS** |
