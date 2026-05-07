# Event payload schemas

Each file `<event>.v1.json` validates the `data` object of an event whose
`event` field equals `<event>`. The envelope (`../events.v1.json`) governs
the surrounding fields (`seq`, `ts`, `actor`, `prev_hash`, `event_hash`,
etc.) — these schemas govern only the payload.

The kernel evidence module is responsible for selecting the right payload
schema based on `event` value before validation.

## Naming convention

- File: `<event>.v1.json`
- `$id`: `https://caws.paths.design/schemas/events/<event>.v1.json`
- `$comment` declares the spec-id class: `REQUIRES_SPEC_ID`, `OPTIONAL_SPEC_ID`, `NO_SPEC_ID`

## Empty payloads

Events with no meaningful payload (e.g. `session_ended` carrying only the
envelope's session_id and ts) define an empty-object schema with
`additionalProperties: false`. This makes "no extra fields" an enforced
contract, not an unstated assumption.
